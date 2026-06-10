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
import { readInput, readInputBytes, writeStdoutSync } from "./io.js";

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
    writeStdoutSync(new TextEncoder().encode(result));
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
 * Joins multi-value constraint entries with commas.
 *
 * Comma is the deliberate, documented picklist separator for this
 * tool pair (yama-cli and tapir) — DCTAP itself leaves the choice to
 * implementations, and dctap-python defaults to whitespace. Commas
 * inside a value cannot be escaped in-cell, so those values trigger
 * a warning instead of silently corrupting the list.
 *
 * @param {Array<*>} entries  - Values to join.
 * @param {string}   stmtName - Statement name for warning messages.
 * @returns {string}
 */
function joinConstraintValues(entries, stmtName) {
  for (const e of entries) {
    if (String(e).includes(",")) {
      console.warn(
        `Warning: statement "${stmtName}": value "${e}" contains a comma, which is also the DCTAP list separator — re-import will split it.`,
      );
    }
  }
  return entries.join(",");
}

/**
 * Resolves DCTAP valueConstraint and valueConstraintType from YAMA fields.
 *
 * DCTAP rows carry a single valueConstraint, so when a statement
 * declares several constraint kinds the highest-priority one wins
 * and the shadowed ones are reported on stderr.
 *
 * @param {Object} stmtDef  - Statement definition.
 * @param {string} stmtName - Statement name for warning messages.
 * @returns {{valueConstraint: string, valueConstraintType: string}}
 */
function toValueConstraint(stmtDef, stmtName) {
  const candidates = [];

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
    candidates.push({
      valueConstraint: joinConstraintValues(schemes, stmtName),
      valueConstraintType: "IRIstem",
    });
  }

  if (Array.isArray(stmtDef.languageTag) && stmtDef.languageTag.length > 0) {
    candidates.push({
      valueConstraint: joinConstraintValues(stmtDef.languageTag, stmtName),
      valueConstraintType: "languageTag",
    });
  }

  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    candidates.push({
      valueConstraint: joinConstraintValues(stmtDef.values, stmtName),
      valueConstraintType: "picklist",
    });
  }

  if (stmtDef.pattern) {
    candidates.push({
      valueConstraint: stmtDef.pattern,
      valueConstraintType: "pattern",
    });
  }

  if (stmtDef.facets) {
    const facetMap = {
      MinInclusive: "minInclusive",
      MaxInclusive: "maxInclusive",
      MinExclusive: "minExclusive",
      MaxExclusive: "maxExclusive",
      MinLength: "minLength",
      MaxLength: "maxLength",
    };
    for (const [yamaKey, dctapType] of Object.entries(facetMap)) {
      if (stmtDef.facets[yamaKey] != null) {
        candidates.push({
          valueConstraint: String(stmtDef.facets[yamaKey]),
          valueConstraintType: dctapType,
        });
      }
    }
    for (const key of Object.keys(stmtDef.facets)) {
      if (!(key in facetMap)) {
        console.warn(
          `Warning: statement "${stmtName}": facet ${key} has no DCTAP valueConstraintType — dropped.`,
        );
      }
    }
  }

  if (candidates.length === 0) {
    return { valueConstraint: "", valueConstraintType: "" };
  }
  if (candidates.length > 1) {
    const dropped = candidates.slice(1).map((c) => c.valueConstraintType);
    console.warn(
      `Warning: statement "${stmtName}": DCTAP rows hold one valueConstraint — kept ${
        candidates[0].valueConstraintType
      }, dropped ${dropped.join(", ")}.`,
    );
  }
  return candidates[0];
}

/**
 * Builds an empty DCTAP row with every canonical column blank.
 *
 * @returns {Object} Row object keyed by DCTAP column names.
 */
function emptyRow() {
  const row = {};
  for (const col of DCTAP_COLUMNS) row[col] = "";
  return row;
}

/**
 * Converts a YAMA document to DCTAP rows.
 *
 * The shapeID is emitted on the first *emitted* row of each shape —
 * property-less statements are skipped, so anchoring it to statement
 * index 0 could orphan the whole shape and silently merge its rows
 * into the previous shape on re-import. Shapes whose note would
 * otherwise be lost (a note on a shape that has statements) get a
 * dedicated header row (shapeID + shapeLabel + note, no propertyID)
 * before their statement rows.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @returns {Object[]} Array of row objects with DCTAP column keys.
 */
function yamaToRows(doc) {
  const descriptions = doc.descriptions || {};
  const rows = [];

  for (const [descName, descDef] of Object.entries(descriptions)) {
    const statements = descDef.statements || {};
    const stmtEntries = Object.entries(statements)
      .filter(([, stmtDef]) => !!stmtDef.property);

    if (stmtEntries.length === 0) {
      rows.push({
        ...emptyRow(),
        shapeID: descName,
        shapeLabel: descDef.label || "",
        note: descDef.note || "",
      });
      continue;
    }

    // Statement rows carry their own note, so a shape-level note
    // needs a dedicated header row to survive the export.
    let shapeEmitted = false;
    if (descDef.note) {
      rows.push({
        ...emptyRow(),
        shapeID: descName,
        shapeLabel: descDef.label || "",
        note: descDef.note,
      });
      shapeEmitted = true;
    }

    for (const [stmtKey, stmtDef] of stmtEntries) {
      const stmtName = stmtDef.label || stmtKey;

      // DCTAP has no column for a statement-level class constraint.
      if (stmtDef.a) {
        console.warn(
          `Warning: statement "${stmtName}": class constraint (a: ${
            Array.isArray(stmtDef.a) ? stmtDef.a.join(", ") : stmtDef.a
          }) has no DCTAP column — dropped.`,
        );
      }

      const { valueConstraint, valueConstraintType } = toValueConstraint(
        stmtDef,
        stmtName,
      );

      rows.push({
        shapeID: shapeEmitted ? "" : descName,
        shapeLabel: shapeEmitted ? "" : (descDef.label || ""),
        propertyID: stmtDef.property,
        propertyLabel: stmtDef.label || "",
        mandatory: toMandatory(stmtDef.min),
        repeatable: toRepeatable(stmtDef.max, stmtDef.min),
        valueNodeType: toValueNodeType(stmtDef.type),
        valueDataType: Array.isArray(stmtDef.datatype)
          ? stmtDef.datatype.join(" ")
          : (stmtDef.datatype || ""),
        valueConstraint,
        valueConstraintType,
        // DCTAP valueShape: single or space-separated multi-shape (SRAP convention).
        // stmtDef.description may be a scalar or an array in YAMAML.
        valueShape: Array.isArray(stmtDef.description)
          ? stmtDef.description.join(" ")
          : (stmtDef.description || ""),
        note: stmtDef.note || "",
      });
      shapeEmitted = true;
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
 * A bare valueConstraint with no valueConstraintType is legal DCTAP
 * (it means the value must match the constraint literally), so it
 * imports as a one-element `values` list. Unknown constraint types
 * import the same way, with a warning.
 *
 * @param {string} constraint
 * @param {string} constraintType
 * @returns {Object} Partial statement definition with values/pattern/facets.
 */
function fromValueConstraint(constraint, constraintType) {
  if (!constraint) return {};

  const type = String(constraintType || "").trim().toLowerCase();
  const val = String(constraint).trim();
  if (!val) return {};

  switch (type) {
    case "":
      return { values: [val] };
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
    case "minexclusive": {
      const n = Number(val);
      return Number.isNaN(n) ? {} : { facets: { MinExclusive: n } };
    }
    case "maxexclusive": {
      const n = Number(val);
      return Number.isNaN(n) ? {} : { facets: { MaxExclusive: n } };
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
      console.warn(
        `Warning: unknown valueConstraintType "${constraintType}" — imported "${val}" as a literal value match.`,
      );
      return { values: [val] };
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
 * Case-insensitive lookup map from lowercased DCTAP header names to
 * their canonical camelCase form. Built once from {@link DCTAP_COLUMNS}.
 *
 * Real-world DCTAP profiles ship with varying header casing — the DCMI
 * SRAP April model, for instance, uses `valueDatatype` (lowercase `t`)
 * rather than the elements list's canonical `valueDataType`. Without
 * normalisation, exact-key access on `row.valueDataType` returns
 * undefined and the data is silently dropped on import.
 *
 * Mirrors the same fix in tapir's `dctap-parser.ts:CANONICAL_BY_LOWER`.
 */
const CANONICAL_BY_LOWER = new Map(
  DCTAP_COLUMNS.map((k) => [k.toLowerCase(), k]),
);

/**
 * Returns a row with canonical DCTAP keys, picking the matching value
 * from `row` regardless of the input header's letter case. Unknown
 * columns are dropped — `rowsToYama` only reads canonical fields, so
 * preserving variant spellings would just leave stale data behind.
 *
 * @param {Record<string, string>} row
 * @returns {Record<string, string>}
 */
function normaliseDctapRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const canonical = CANONICAL_BY_LOWER.get(key.trim().toLowerCase());
    if (canonical) out[canonical] = row[key];
  }
  return out;
}

/**
 * Converts DCTAP rows to a YAMA document structure.
 *
 * Handles the DCTAP convention where `shapeID` on a row introduces
 * a new shape, and subsequent rows with empty `shapeID` belong to
 * the same shape.
 *
 * Headers are matched case-insensitively, so profiles authored with
 * non-canonical casing (e.g. SRAP's `valueDatatype`) import correctly.
 *
 * @param {Object[]} rows - Parsed tabular rows.
 * @returns {Object} YAMA document (without namespaces/base/mapping).
 */
export function rowsToYama(rows) {
  const descriptions = {};
  let currentShapeID = null;

  for (const rawRow of rows) {
    const row = normaliseDctapRow(rawRow);
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

    // Multi-datatype: DCMI SRAP and SimpleDSP §4.6 Table 16 both use
    // a space-separated list of datatypes to express a union. Store as
    // an array so downstream generators can emit format-specific
    // disjunctions (sh:or, ShEx OR, owl:unionOf).
    const dataType = String(row.valueDataType || "").trim();
    if (dataType) {
      const parts = dataType.split(/\s+/).filter(Boolean);
      stmt.datatype = parts.length === 1 ? parts[0] : parts;
    }

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
