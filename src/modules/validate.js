// src/modules/validate.js
/**
 * Validation engine for YAMA documents.
 *
 * Two-phase validation:
 *   Phase 1: Format-specific structural checks (raw input)
 *   Phase 2: Semantic checks (normalized YAMA model)
 *
 * @module modules/validate
 */

import { parse as parseYaml } from "@std/yaml";
import { descRefs, readInput } from "./io.js";

// ── Standard prefixes (Table 19 from spec + schema: extension) ──

const STANDARD_PREFIXES = {
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xl: "http://www.w3.org/2008/05/skos-xl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  schema: "https://schema.org/",
};

/** Valid SimpleDSP value types (Japanese + English). */
const SIMPLEDSP_VALUE_TYPES = new Set([
  "id", "literal", "structured", "iri", "",
  "文字列", "構造化", "参照値", "制約なし",
]);

/** Valid YAMA YAML type values. */
const YAMA_TYPES = new Set(["literal", "iri", "uri", "bnode", ""]);

/** Valid DCTAP valueNodeType values (case-insensitive). */
const DCTAP_NODE_TYPES = new Set(["iri", "literal", "bnode"]);

/** Standard DCTAP valueConstraintType values. */
const DCTAP_CONSTRAINT_TYPES = new Set([
  "picklist", "iristent", "pattern", "languagetag",
  "minlength", "maxlength", "mininclusive", "maxinclusive",
]);

/** Valid DCTAP boolean values (case-insensitive). */
const DCTAP_BOOLEANS = new Set(["true", "false", "yes", "no", "1", "0"]);

// ── Helpers ───────────────────────────────────────────────────

function extractPrefix(term) {
  if (!term) return null;
  if (/^(https?|urn):/.test(term)) return null;
  const colon = term.indexOf(":");
  if (colon > 0) return term.substring(0, colon);
  return null;
}

function isPrefixKnown(prefix, namespaces) {
  return prefix in namespaces || prefix in STANDARD_PREFIXES;
}

/**
 * Checks if a prefixed term uses a known prefix.
 *
 * For DCTAP format, unknown prefixes are downgraded to info (pushed to
 * the `infoArr` array) because DCTAP has no namespace declaration mechanism.
 * For other formats, they are errors (pushed to `errorArr`).
 */
function checkPrefix(term, namespaces, location, fieldName, errorArr, format = "yaml", infoArr = null) {
  const prefix = extractPrefix(term);
  if (prefix && !isPrefixKnown(prefix, namespaces)) {
    if (format === "dctap" && infoArr) {
      infoArr.push({
        location,
        severity: "info",
        message: `Prefix "${prefix}" in ${fieldName} "${term}" is not a standard prefix`,
        fix: `DCTAP has no namespace declaration mechanism — prefix resolution depends on external context. Standard prefixes: ${Object.keys(STANDARD_PREFIXES).join(", ")}`,
      });
    } else {
      errorArr.push({
        location,
        severity: "error",
        message: `Unknown prefix "${prefix}" in ${fieldName} "${term}"`,
        fix: `Declare "${prefix}" in namespaces or [@NS], or use a standard prefix (${Object.keys(STANDARD_PREFIXES).join(", ")})`,
      });
    }
  }
}

function msg(severity, message, fix, location = {}) {
  return { location, severity, message, fix };
}

// ── Phase 2: Semantic validation (YAMA model) ────────────────

/**
 * Validates a parsed YAMA document (post-normalization).
 *
 * @param {Object} doc - Parsed YAMA YAML document.
 * @param {string} filePath - Source file path for reporting.
 * @param {string} [sourceFormat="yaml"] - Original format (affects prefix checking severity).
 * @returns {Object} ValidationReport
 */
export function validateYamaDocument(doc, filePath, sourceFormat = "yaml") {
  const errors = [];
  const warnings = [];
  const info = [];
  const namespaces = doc.namespaces || {};
  const descriptions = doc.descriptions || {};
  const descNames = Object.keys(descriptions);

  // Structural: must have descriptions
  if (descNames.length === 0) {
    errors.push(msg("error",
      "No descriptions found",
      "Add at least one description under the 'descriptions' key"));
  }

  // Check base URI
  if (doc.base && !/^(https?|urn):/.test(doc.base)) {
    warnings.push(msg("warning",
      `Base URI "${doc.base}" does not look like a valid URI`,
      "Base should be a valid HTTP(S) or URN URI"));
  }

  // Check each description
  const seenNames = new Set();
  const descSummaries = [];

  for (const [descName, descDef] of Object.entries(descriptions)) {
    const descPath = `descriptions.${descName}`;

    // Duplicate names
    if (seenNames.has(descName)) {
      errors.push(msg("error",
        `Duplicate description name "${descName}"`,
        "Each description must have a unique name",
        { path: descPath }));
    }
    seenNames.add(descName);

    // Target class prefix
    if (descDef.a) {
      checkPrefix(descDef.a, namespaces, { path: `${descPath}.a` }, "targetClass", errors, sourceFormat, info);
    }

    // ID prefix validation
    if (descDef.id?.prefix) {
      const allNs = { ...STANDARD_PREFIXES, ...namespaces };
      if (!allNs[descDef.id.prefix]) {
        errors.push(msg("error",
          `ID prefix "${descDef.id.prefix}" is not declared in namespaces`,
          `Add "${descDef.id.prefix}" to the namespaces section with its URI`,
          { path: `${descPath}.id.prefix` }));
      }
    }

    const statements = descDef.statements || {};
    const stmtKeys = Object.keys(statements);

    // Empty description
    if (stmtKeys.length === 0 && !descDef.statements) {
      warnings.push(msg("warning",
        `Description "${descName}" has no statements key`,
        "Add a 'statements' mapping with at least one statement",
        { path: descPath }));
    } else if (stmtKeys.length === 0) {
      warnings.push(msg("warning",
        `Description "${descName}" has no statements`,
        "Add at least one statement to make this description actionable",
        { path: descPath }));
    }

    // Value type breakdown for summary
    const valueTypes = {};

    for (const [stmtKey, stmtDef] of Object.entries(statements)) {
      const stmtPath = `${descPath}.statements.${stmtKey}`;

      // Property check
      if (!stmtDef.property) {
        warnings.push(msg("warning",
          `Statement "${stmtKey}" in "${descName}" has no property`,
          "Add a 'property' key (e.g. 'dc:title') — without it, no RDF output is generated",
          { path: `${stmtPath}.property` }));
      } else {
        checkPrefix(stmtDef.property, namespaces, { path: `${stmtPath}.property` }, "property", errors, sourceFormat, info);
      }

      // Type validation
      if (stmtDef.type && !YAMA_TYPES.has(stmtDef.type.toLowerCase())) {
        errors.push(msg("error",
          `Invalid type "${stmtDef.type}" in statement "${stmtKey}"`,
          "Type must be one of: literal, IRI, URI, BNODE, or omitted",
          { path: `${stmtPath}.type` }));
      }

      // Cardinality
      if (stmtDef.min != null && stmtDef.max != null && stmtDef.min > stmtDef.max) {
        errors.push(msg("error",
          `Invalid cardinality in "${stmtKey}": min (${stmtDef.min}) exceeds max (${stmtDef.max})`,
          "Set min \u2264 max, or remove max for unbounded",
          { path: stmtPath }));
      }

      // Datatype prefix
      if (stmtDef.datatype) {
        checkPrefix(stmtDef.datatype, namespaces, { path: `${stmtPath}.datatype` }, "datatype", errors, sourceFormat, info);
      }

      // Description reference(s) — each ref in the list must resolve
      const stmtRefs = descRefs(stmtDef);
      for (const ref of stmtRefs) {
        if (!descNames.includes(ref)) {
          errors.push(msg("error",
            `Statement "${stmtKey}" references undefined description "${ref}"`,
            `Available descriptions: ${descNames.join(", ")}`,
            { path: `${stmtPath}.description` }));
        }
      }

      // Track value types for summary
      const vt = stmtRefs.length > 0 ? "structured" :
        (stmtDef.type || "").toUpperCase() === "IRI" || (stmtDef.type || "").toUpperCase() === "URI" ? "iri" :
        stmtDef.datatype || stmtDef.type === "literal" ? "literal" : "unconstrained";
      valueTypes[vt] = (valueTypes[vt] || 0) + 1;
    }

    descSummaries.push({
      name: descName,
      targetClass: descDef.a || "",
      idPrefix: descDef.id?.prefix || "",
      statementCount: stmtKeys.length,
      valueTypes,
    });
  }

  // Build summary
  const declaredNs = Object.keys(namespaces);
  const summary = {
    namespaces: {
      declared: declaredNs.length,
      standard: Object.keys(STANDARD_PREFIXES).length,
      list: declaredNs,
    },
    base: doc.base || "",
    descriptions: descNames.length,
    statements: descSummaries.reduce((sum, d) => sum + d.statementCount, 0),
  };

  return {
    file: filePath,
    format: "yaml",
    valid: errors.filter((e) => e.severity === "error").length === 0,
    summary,
    descriptions: descSummaries,
    errors: errors.filter((e) => e.severity === "error"),
    warnings: [...warnings, ...errors.filter((e) => e.severity === "warning")],
    info,
  };
}

// ── Phase 1: SimpleDSP structural validation ─────────────────

/**
 * Validates raw SimpleDSP blocks (before normalization).
 *
 * @param {Array} blocks - Parsed blocks from readSimpleDsp/parseSimpleDspText.
 * @param {Object} parsedNs - Namespace declarations from [@NS] block.
 * @param {string} filePath - Source file path.
 * @returns {Object} ValidationReport (structural issues only)
 */
export function validateSimpleDspRaw(blocks, parsedNs, filePath) {
  const errors = [];
  const warnings = [];
  const info = [];

  // Check first block is MAIN
  if (blocks.length > 0 && blocks[0].id !== "MAIN") {
    errors.push(msg("error",
      `First block is [${blocks[0].id}], expected [MAIN]`,
      "The first Description Template block must have ID 'MAIN'",
      { line: 1 }));
  }

  // Check for duplicate block IDs
  const blockIds = blocks.map((b) => b.id);
  const seenIds = new Set();
  for (const id of blockIds) {
    if (seenIds.has(id)) {
      errors.push(msg("error", `Duplicate block ID [${id}]`,
        "Each block must have a unique ID"));
    }
    seenIds.add(id);
  }

  // Check block ID format
  for (const block of blocks) {
    if (/^\d/.test(block.id)) {
      errors.push(msg("error",
        `Block ID "${block.id}" starts with a digit`,
        "Block IDs must not begin with a digit"));
    }
  }

  // Namespace checks
  const namespaces = {};
  for (const [key, uri] of Object.entries(parsedNs)) {
    if (key === "@base") continue;
    if (STANDARD_PREFIXES[key] === uri) {
      info.push(msg("info",
        `Prefix "${key}" re-declares the standard namespace — redundant`,
        `"${key}" is already a standard prefix with URI ${uri}`));
    }
    namespaces[key] = uri;
  }

  // Check each block's rows
  let globalLine = 1; // approximate line tracking

  for (const block of blocks) {
    let idRowCount = 0;

    for (let i = 0; i < block.rows.length; i++) {
      const row = block.rows[i];
      const line = row._line || (globalLine + i);
      const vt = (row.ValueType || "").toLowerCase();

      // Value type vocabulary check
      if (vt && !SIMPLEDSP_VALUE_TYPES.has(vt)) {
        errors.push(msg("error",
          `Unknown value type "${row.ValueType}" in block [${block.id}]`,
          "Value type must be one of: ID, literal/\u6587\u5b57\u5217, structured/\u69cb\u9020\u5316, IRI/\u53c2\u7167\u5024, or empty/\u5236\u7d04\u306a\u3057",
          { line }));
      }

      // ID row checks
      if (vt === "id" || vt === '"id"') {
        idRowCount++;
        if (idRowCount > 1) {
          errors.push(msg("error",
            `Multiple ID rows in block [${block.id}]`,
            "Each block may have at most one ID statement",
            { line }));
        }
      }

      // Property prefix check
      if (row.Property) {
        checkPrefix(row.Property, { ...STANDARD_PREFIXES, ...namespaces },
          { line }, "property", errors);
      }

      // Constraint: #blockId reference check
      const constraint = row.Constraint || "";
      if (constraint.startsWith("#")) {
        const refId = constraint.slice(1);
        if (!blockIds.includes(refId)) {
          errors.push(msg("error",
            `Constraint "${constraint}" references undefined block "${refId}"`,
            `Available blocks: ${blockIds.join(", ")}`,
            { line }));
        }
      }
    }

    // MAIN should have ID
    if (block.id === "MAIN" && idRowCount === 0) {
      warnings.push(msg("warning",
        "[MAIN] has no ID statement",
        "Per spec, the MAIN block should include an ID row (Name  Class  1  1  ID  prefix:  Comment)"));
    }
  }

  return { errors, warnings, info };
}

// ── Phase 1: DCTAP structural validation ─────────────────────

/**
 * Validates raw DCTAP rows (before normalization).
 *
 * @param {Array} rows - Parsed DCTAP rows (objects with column keys).
 * @param {string} filePath - Source file path.
 * @returns {Object} Partial validation report (structural issues only)
 */
export function validateDctapRaw(rows, filePath) {
  const errors = [];
  const warnings = [];
  const info = [];

  if (rows.length === 0) {
    warnings.push(msg("warning", "No data rows found in DCTAP file",
      "Add at least one row with a propertyID"));
    return { errors, warnings, info };
  }

  // Check for shapeID presence
  const hasShapeId = rows.some((r) => r.shapeID);
  if (!hasShapeId) {
    warnings.push(msg("warning",
      "No shapeID defined — all rows treated as a single unnamed shape",
      "Add a shapeID column to group properties into shapes"));
  }

  // Collect shape IDs for valueShape validation
  const shapeIds = new Set();
  for (const row of rows) {
    if (row.shapeID) shapeIds.add(row.shapeID);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 2; // +1 for header, +1 for 1-based

    // propertyID is required
    if (!row.propertyID) {
      errors.push(msg("error",
        `Row ${line}: missing propertyID (required)`,
        "Every DCTAP row must have a propertyID — it is the only required element",
        { line }));
      continue;
    }

    // valueNodeType check
    if (row.valueNodeType) {
      if (!DCTAP_NODE_TYPES.has(row.valueNodeType.toLowerCase())) {
        errors.push(msg("error",
          `Row ${line}: invalid valueNodeType "${row.valueNodeType}"`,
          "valueNodeType must be one of: IRI, literal, bnode (case-insensitive)",
          { line }));
      }
    }

    // valueConstraintType check
    if (row.valueConstraintType) {
      if (!DCTAP_CONSTRAINT_TYPES.has(row.valueConstraintType.toLowerCase())) {
        warnings.push(msg("warning",
          `Row ${line}: non-standard valueConstraintType "${row.valueConstraintType}"`,
          "Standard types: picklist, IRIstem, pattern, languageTag, minLength, maxLength, minInclusive, maxInclusive",
          { line }));
      }
    }

    // valueConstraint without valueConstraintType
    if (row.valueConstraint && !row.valueConstraintType) {
      warnings.push(msg("warning",
        `Row ${line}: valueConstraint present without valueConstraintType`,
        "The constraint may not be actionable without a type — add valueConstraintType",
        { line }));
    }

    // valueShape reference check. DCTAP spec says "zero or one"; DCMI
    // SRAP uses space-separated multi-shape — we validate each entry.
    if (row.valueShape) {
      const refs = String(row.valueShape).trim().split(/\s+/).filter(Boolean);
      for (const ref of refs) {
        if (!shapeIds.has(ref)) {
          errors.push(msg("error",
            `Row ${line}: valueShape "${ref}" does not match any shapeID`,
            `Available shapes: ${[...shapeIds].join(", ") || "(none)"}`,
            { line }));
        }
      }
      // valueShape with literal nodeType
      if (row.valueNodeType && row.valueNodeType.toLowerCase() === "literal") {
        warnings.push(msg("warning",
          `Row ${line}: valueShape used with valueNodeType "literal"`,
          "valueShape is typically used with IRI or bnode, not literal",
          { line }));
      }
    }

    // mandatory/repeatable boolean check
    for (const boolField of ["mandatory", "repeatable"]) {
      if (row[boolField] && !DCTAP_BOOLEANS.has(row[boolField].toLowerCase())) {
        warnings.push(msg("warning",
          `Row ${line}: "${boolField}" value "${row[boolField]}" is not a recognized boolean`,
          "Expected: true/false, yes/no, or 1/0 (case-insensitive)",
          { line }));
      }
    }
  }

  return { errors, warnings, info };
}

// ── Main entry point ─────────────────────────────────────────

/**
 * Validates a file in any supported format.
 *
 * Auto-detects format from extension and content.
 * Runs two-phase validation: structural (raw) then semantic (normalized).
 *
 * @param {string} filePath - Path to input file.
 * @param {Object} [opts]
 * @param {string} [opts.inputFormat] - Force format: "yaml", "simpledsp", "dctap"
 * @returns {Promise<Object>} ValidationReport
 */
export async function validateFile(filePath, { inputFormat } = {}) {
  const format = inputFormat || detectFormat(filePath);

  if (format === "yaml") {
    const text = await readInput(filePath);
    const doc = parseYaml(text);
    return validateYamaDocument(doc, filePath);
  }

  if (format === "simpledsp") {
    // Use readSimpleDsp and simpleDspToYama from dsp.js
    const { readSimpleDsp, simpleDspToYama } = await import("./dsp.js");
    const { blocks, namespaces } = await readSimpleDsp(filePath);

    // Phase 1: structural
    const structural = validateSimpleDspRaw(blocks, namespaces, filePath);

    // Phase 2: semantic (convert to YAMA then validate)
    const doc = simpleDspToYama(blocks, namespaces);
    const semantic = validateYamaDocument(doc, filePath);

    // Merge results
    return {
      ...semantic,
      format: "simpledsp",
      errors: [...structural.errors, ...semantic.errors],
      warnings: [...structural.warnings, ...semantic.warnings],
      info: [...structural.info, ...semantic.info],
      valid: structural.errors.length === 0 && semantic.errors.length === 0,
    };
  }

  if (format === "dctap") {
    // Use readTabular and rowsToYama from dctap.js
    const { readTabular, rowsToYama } = await import("./dctap.js");
    const rows = await readTabular(filePath);

    // Phase 1: structural
    const structural = validateDctapRaw(rows, filePath);

    // Phase 2: semantic
    const doc = rowsToYama(rows);
    const semantic = validateYamaDocument(doc, filePath, "dctap");

    return {
      ...semantic,
      format: "dctap",
      errors: [...structural.errors, ...semantic.errors],
      warnings: [...structural.warnings, ...semantic.warnings],
      info: [...structural.info, ...semantic.info],
      valid: structural.errors.length === 0 && semantic.errors.length === 0,
    };
  }

  throw new Error(`Unsupported format: ${format}. Use --input-format to specify.`);
}

/**
 * Detects file format from extension and content heuristics.
 */
function detectFormat(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "tsv") return "simpledsp";
  if (ext === "xlsx" || ext === "xls") return "simpledsp";
  if (ext === "csv") {
    // Disambiguate: read first few lines
    try {
      const text = Deno.readTextFileSync(filePath);
      const firstLine = text.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
      if (firstLine?.trim().startsWith("[")) return "simpledsp";
      const lower = firstLine?.toLowerCase() || "";
      if (lower.includes("propertyid") || lower.includes("shapeid")) return "dctap";
    } catch { /* fall through */ }
    return "dctap"; // default for CSV
  }
  return "yaml"; // fallback
}
