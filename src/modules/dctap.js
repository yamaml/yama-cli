/**
 * @fileoverview Bidirectional DCTAP (DC Tabular Application Profiles) support.
 *
 * Provides two operations:
 *   - **Export** (`dctap`): Convert a YAMA document to a DCTAP table.
 *   - **Import** (`from-dctap`): Convert a DCTAP table to a YAMA YAML document.
 *
 * Supported tabular formats for both import and export:
 *   - **CSV** (`.csv`) — comma-separated values (default)
 *   - **TSV** (`.tsv`) — tab-separated values
 *   - **Excel** (`.xlsx`, `.xls`) — spreadsheet (first sheet)
 *
 * The format is inferred from the output file extension, or defaults to
 * CSV when writing to stdout.
 *
 * DCTAP is a Dublin Core specification for expressing application profiles
 * as simple tables. Since both YAMA and DCTAP are rooted in Dublin Core
 * Application Profiles (via DSP), the mapping is natural.
 *
 * DCTAP columns:
 *   `shapeID`, `shapeLabel`, `propertyID`, `propertyLabel`,
 *   `mandatory`, `repeatable`, `valueNodeType`, `valueDataType`,
 *   `valueConstraint`, `valueConstraintType`, `valueShape`, `note`
 *
 * YAMA-to-DCTAP mapping:
 *
 * | YAMA                         | DCTAP                              |
 * |------------------------------|-------------------------------------|
 * | description name             | shapeID                             |
 * | description.label            | shapeLabel                          |
 * | statement.property           | propertyID                          |
 * | statement.label              | propertyLabel                       |
 * | min >= 1                     | mandatory = TRUE                    |
 * | max absent or max > 1        | repeatable = TRUE                   |
 * | statement.type               | valueNodeType (IRI, literal, bnode) |
 * | statement.datatype           | valueDataType                       |
 * | statement.description        | valueShape (space-separated if list) |
 * | statement.values             | valueConstraint (picklist)          |
 * | statement.inScheme           | valueConstraint (IRIstem)           |
 * | statement.pattern            | valueConstraint (pattern)           |
 * | statement.languageTag        | valueConstraint (languageTag)       |
 * | statement.facets             | valueConstraint (numeric facets)    |
 * | statement.note               | note                                |
 *
 * @module dctap
 * @see https://dcmi.github.io/dctap/
 */

import { parse as parseCsv, stringify as stringifyCsv } from "@std/csv";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import * as XLSX from "xlsx";
import { readInput, readInputBytes } from "./io.js";

// ---------------------------------------------------------------------------
// DCTAP column headers (canonical order)
// ---------------------------------------------------------------------------

/** Canonical DCTAP column headers in standard order. */
const DCTAP_COLUMNS = [
  "shapeID",
  "shapeLabel",
  "propertyID",
  "propertyLabel",
  "mandatory",
  "repeatable",
  "valueNodeType",
  "valueDataType",
  "valueConstraint",
  "valueConstraintType",
  "valueShape",
  "note",
];

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Infers tabular format from a file extension.
 *
 * @param {string} path - File path.
 * @returns {"csv"|"tsv"|"xlsx"} Detected format.
 */
function inferTabularFormat(path) {
  if (!path) return "csv";
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "tsv") return "tsv";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  return "csv";
}

// ---------------------------------------------------------------------------
// Tabular I/O helpers
// ---------------------------------------------------------------------------

/**
 * Reads a tabular file (CSV, TSV, or Excel) into row objects.
 *
 * @param {string} file - File path.
 * @returns {Promise<Object[]>} Array of row objects keyed by header names.
 */
export async function readTabular(file) {
  const fmt = inferTabularFormat(file);

  if (fmt === "xlsx") {
    const data = await readInputBytes(file);
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  }

  const text = await readInput(file);
  const separator = fmt === "tsv" ? "\t" : ",";
  try {
    return parseCsv(text, { skipFirstRow: true, separator });
  } catch {
    // Lenient fallback for malformed CSV with inconsistent field counts
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(separator);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(separator);
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = (cells[j] || "").trim();
      }
      rows.push(row);
    }
    return rows;
  }
}

/**
 * Writes row objects to a tabular file or stdout.
 *
 * @param {Object[]} rows    - Row objects with DCTAP column keys.
 * @param {string}   [output] - Output path; stdout if empty.
 */
function writeTabular(rows, output) {
  const fmt = inferTabularFormat(output);

  if (fmt === "xlsx") {
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: DCTAP_COLUMNS });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "DCTAP");
    const buf = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    Deno.writeFileSync(output, new Uint8Array(buf));
    console.error(`Written to ${output}`);
    return;
  }

  const separator = fmt === "tsv" ? "\t" : ",";
  const result = stringifyCsv(rows, { columns: DCTAP_COLUMNS, separator });

  if (output) {
    Deno.writeTextFileSync(output, result);
    console.error(`Written to ${output}`);
  } else {
    Deno.stdout.writeSync(new TextEncoder().encode(result));
  }
}

// ---------------------------------------------------------------------------
// Export: YAMA → DCTAP
// ---------------------------------------------------------------------------

/**
 * Resolves DCTAP mandatory flag from YAMA min cardinality.
 *
 * @param {number|null|undefined} min
 * @returns {string} "TRUE", "FALSE", or empty string.
 */
function toMandatory(min) {
  if (min == null) return "";
  return min >= 1 ? "TRUE" : "FALSE";
}

/**
 * Resolves DCTAP repeatable flag from YAMA max cardinality.
 *
 * @param {number|null|undefined} max
 * @param {number|null|undefined} min
 * @returns {string} "TRUE", "FALSE", or empty string.
 */
function toRepeatable(max, min) {
  if (min == null && max == null) return "";
  if (max == null) return "TRUE";
  return max > 1 ? "TRUE" : "FALSE";
}

/**
 * Resolves DCTAP valueNodeType from YAMA statement type.
 *
 * @param {string|undefined} type
 * @returns {string}
 */
function toValueNodeType(type) {
  if (!type) return "";
  switch (type.toUpperCase()) {
    case "IRI":
    case "URI":
      return "IRI";
    case "LITERAL":
      return "literal";
    case "BNODE":
      return "bnode";
    default:
      return "";
  }
}

/**
 * Resolves DCTAP valueConstraint and valueConstraintType from YAMA fields.
 *
 * @param {Object} stmtDef - Statement definition.
 * @returns {{valueConstraint: string, valueConstraintType: string}}
 */
function toValueConstraint(stmtDef) {
  // inScheme → IRIstem (check before values since both may exist)
  if (stmtDef.inScheme) {
    const raw = Array.isArray(stmtDef.inScheme)
      ? stmtDef.inScheme
      : [stmtDef.inScheme];
    // Normalize: YAML may parse `- ndlsh:` as { ndlsh: null } instead of "ndlsh:"
    const schemes = raw.map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object") return Object.keys(s)[0] + ":";
      return String(s);
    });
    return {
      valueConstraint: schemes.join(","),
      valueConstraintType: "IRIstem",
    };
  }

  // languageTag → languageTag (check before values to preserve semantics)
  if (Array.isArray(stmtDef.languageTag) && stmtDef.languageTag.length > 0) {
    return {
      valueConstraint: stmtDef.languageTag.join(","),
      valueConstraintType: "languageTag",
    };
  }

  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    return {
      valueConstraint: stmtDef.values.join(","),
      valueConstraintType: "picklist",
    };
  }

  if (stmtDef.pattern) {
    return {
      valueConstraint: stmtDef.pattern,
      valueConstraintType: "pattern",
    };
  }

  if (stmtDef.facets) {
    const facetMap = {
      MinInclusive: "minInclusive",
      MaxInclusive: "maxInclusive",
      MinLength: "minLength",
      MaxLength: "maxLength",
    };
    for (const [yamaKey, dctapType] of Object.entries(facetMap)) {
      if (stmtDef.facets[yamaKey] != null) {
        return {
          valueConstraint: String(stmtDef.facets[yamaKey]),
          valueConstraintType: dctapType,
        };
      }
    }
  }

  return { valueConstraint: "", valueConstraintType: "" };
}

/**
 * Converts a YAMA document to DCTAP rows.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @returns {Object[]} Array of row objects with DCTAP column keys.
 */
function yamaToRows(doc) {
  const descriptions = doc.descriptions || {};
  const rows = [];

  for (const [descName, descDef] of Object.entries(descriptions)) {
    const statements = descDef.statements || {};
    const stmtEntries = Object.entries(statements);

    if (stmtEntries.length === 0) {
      rows.push({
        shapeID: descName,
        shapeLabel: descDef.label || "",
        propertyID: "",
        propertyLabel: "",
        mandatory: "",
        repeatable: "",
        valueNodeType: "",
        valueDataType: "",
        valueConstraint: "",
        valueConstraintType: "",
        valueShape: "",
        note: descDef.note || "",
      });
      continue;
    }

    for (let i = 0; i < stmtEntries.length; i++) {
      const [, stmtDef] = stmtEntries[i];
      if (!stmtDef.property) continue;

      const { valueConstraint, valueConstraintType } = toValueConstraint(stmtDef);

      rows.push({
        shapeID: i === 0 ? descName : "",
        shapeLabel: i === 0 ? (descDef.label || "") : "",
        propertyID: stmtDef.property,
        propertyLabel: stmtDef.label || "",
        mandatory: toMandatory(stmtDef.min),
        repeatable: toRepeatable(stmtDef.max, stmtDef.min),
        valueNodeType: toValueNodeType(stmtDef.type),
        valueDataType: stmtDef.datatype || "",
        valueConstraint,
        valueConstraintType,
        // DCTAP valueShape: single or space-separated multi-shape (SRAP convention).
        // stmtDef.description may be a scalar or an array in YAMAML.
        valueShape: Array.isArray(stmtDef.description)
          ? stmtDef.description.join(" ")
          : (stmtDef.description || ""),
        note: stmtDef.note || "",
      });
    }
  }

  return rows;
}

/**
 * Exports a YAMA file as a DCTAP table (CSV, TSV, or Excel).
 *
 * The format is inferred from the output file extension.
 * Defaults to CSV when writing to stdout.
 *
 * @param {string} file     - Path to the YAMA input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function exportDCTAP(file, output) {
  const doc = parseYaml(await readInput(file));
  const rows = yamaToRows(doc);
  writeTabular(rows, output);
}

// ---------------------------------------------------------------------------
// Import: DCTAP → YAMA
// ---------------------------------------------------------------------------

/**
 * Parses a boolean DCTAP field value.
 *
 * @param {string} val
 * @returns {boolean|null} True, false, or null if empty/unset.
 */
function parseBool(val) {
  if (val == null || String(val).trim() === "") return null;
  const v = String(val).trim().toUpperCase();
  return v === "TRUE" || v === "1" || v === "YES";
}

/**
 * Resolves YAMA type from DCTAP valueNodeType.
 *
 * @param {string} nodeType
 * @returns {string|undefined}
 */
function fromValueNodeType(nodeType) {
  if (!nodeType) return undefined;
  const parts = String(nodeType).trim().split(/\s+/);
  switch (parts[0].toUpperCase()) {
    case "IRI":
    case "URI":
      return "IRI";
    case "LITERAL":
      return "literal";
    case "BNODE":
      return "BNODE";
    default:
      return undefined;
  }
}

/**
 * Resolves YAMA constraint fields from DCTAP valueConstraint/Type.
 *
 * @param {string} constraint
 * @param {string} constraintType
 * @returns {Object} Partial statement definition with values/pattern/facets.
 */
function fromValueConstraint(constraint, constraintType) {
  if (!constraint || !constraintType) return {};

  const type = String(constraintType).trim().toLowerCase();
  const val = String(constraint).trim();

  switch (type) {
    case "picklist":
      return { values: val.split(",").map((v) => v.trim()) };
    case "pattern":
      return { pattern: val };
    case "iristem": {
      const stems = val.split(",").map((v) => v.trim());
      return { inScheme: stems.length === 1 ? stems[0] : stems };
    }
    case "languagetag":
      return { languageTag: val.split(",").map((v) => v.trim()) };
    case "mininclusive": {
      const n = Number(val);
      return Number.isNaN(n) ? {} : { facets: { MinInclusive: n } };
    }
    case "maxinclusive": {
      const n = Number(val);
      return Number.isNaN(n) ? {} : { facets: { MaxInclusive: n } };
    }
    case "minlength": {
      const n = Number(val);
      return Number.isNaN(n) ? {} : { facets: { MinLength: n } };
    }
    case "maxlength": {
      const n = Number(val);
      return Number.isNaN(n) ? {} : { facets: { MaxLength: n } };
    }
    default:
      return {};
  }
}

/**
 * Generates a YAMA statement key from a propertyID.
 *
 * Extracts the local name from a prefixed term or IRI and converts
 * it to a camelCase identifier suitable as a YAML key.
 *
 * @param {string}              propertyID
 * @param {Set<string>}  existingKeys - Track used keys for deduplication.
 * @returns {string}
 */
function toStatementKey(propertyID, existingKeys) {
  let local;

  if (propertyID.includes(":")) {
    const parts = propertyID.split(/[:#/]/);
    local = parts[parts.length - 1];
  } else {
    local = propertyID;
  }

  let key = local.charAt(0).toLowerCase() + local.slice(1);

  if (existingKeys.has(key)) {
    let suffix = 2;
    while (existingKeys.has(`${key}${suffix}`)) suffix++;
    key = `${key}${suffix}`;
  }

  existingKeys.add(key);
  return key;
}

/**
 * Converts DCTAP rows to a YAMA document structure.
 *
 * Handles the DCTAP convention where `shapeID` on a row introduces
 * a new shape, and subsequent rows with empty `shapeID` belong to
 * the same shape.
 *
 * @param {Object[]} rows - Parsed tabular rows.
 * @returns {Object} YAMA document (without namespaces/base/mapping).
 */
export function rowsToYama(rows) {
  const descriptions = {};
  let currentShapeID = null;

  for (const row of rows) {
    const shapeID = String(row.shapeID || "").trim();
    const propertyID = String(row.propertyID || "").trim();

    if (shapeID) {
      currentShapeID = shapeID;
      if (!descriptions[currentShapeID]) {
        descriptions[currentShapeID] = {};
        const label = String(row.shapeLabel || "").trim();
        if (label) descriptions[currentShapeID].label = label;
        if (!propertyID) {
          const note = String(row.note || "").trim();
          if (note) descriptions[currentShapeID].note = note;
        }
        descriptions[currentShapeID].statements = {};
      }
    }

    // If no shapeID has been seen yet, assign a default shape
    if (!currentShapeID && propertyID) {
      currentShapeID = "default";
      if (!descriptions[currentShapeID]) {
        descriptions[currentShapeID] = { statements: {} };
      }
    }

    if (!currentShapeID || !propertyID) continue;

    if (!descriptions[currentShapeID]) {
      descriptions[currentShapeID] = { statements: {} };
    }
    if (!descriptions[currentShapeID].statements) {
      descriptions[currentShapeID].statements = {};
    }
    if (!descriptions[currentShapeID]._usedKeys) {
      descriptions[currentShapeID]._usedKeys = new Set(
        Object.keys(descriptions[currentShapeID].statements),
      );
    }

    const stmtKey = toStatementKey(propertyID, descriptions[currentShapeID]._usedKeys);
    const stmt = {};

    stmt.property = propertyID;

    const propertyLabel = String(row.propertyLabel || "").trim();
    if (propertyLabel) stmt.label = propertyLabel;

    const yamaType = fromValueNodeType(row.valueNodeType);
    if (yamaType) stmt.type = yamaType;

    const dataType = String(row.valueDataType || "").trim();
    if (dataType) stmt.datatype = dataType;

    const mandatory = parseBool(row.mandatory);
    const repeatable = parseBool(row.repeatable);

    if (mandatory != null) stmt.min = mandatory ? 1 : 0;
    if (repeatable != null) stmt.max = repeatable ? -1 : 1;
    if (stmt.max === -1) delete stmt.max;

    // DCTAP valueShape: spec cardinality is "zero or one", but DCMI SRAP
    // uses space-separated multi-shape in practice. We preserve both.
    const valueShape = String(row.valueShape || "").trim();
    if (valueShape) {
      const refs = valueShape.split(/\s+/).filter(Boolean);
      stmt.description = refs.length === 1 ? refs[0] : refs;
    }

    const constraints = fromValueConstraint(
      row.valueConstraint || "",
      row.valueConstraintType || "",
    );
    Object.assign(stmt, constraints);

    const note = String(row.note || "").trim();
    if (note) stmt.note = note;

    descriptions[currentShapeID].statements[stmtKey] = stmt;
  }

  for (const desc of Object.values(descriptions)) {
    delete desc._usedKeys;
  }

  return { descriptions };
}

/**
 * Imports a DCTAP file (CSV, TSV, or Excel) and converts it to YAMA YAML.
 *
 * The input format is inferred from the file extension.
 *
 * @param {string} file     - Path to the DCTAP input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function importDCTAP(file, output) {
  const rows = await readTabular(file);
  const doc = rowsToYama(rows);
  const yaml = stringifyYaml(doc, { lineWidth: -1 });

  if (output) {
    Deno.writeTextFileSync(output, yaml);
    console.error(`Written to ${output}`);
  } else {
    console.log(yaml);
  }
}
