// src/modules/validate.js
/**
 * Validation engine for YAMA documents.
 *
 * Two-phase validation:
 *   Phase 1: Format-specific structural checks (raw input)
 *   Phase 2: Semantic checks (normalized YAMA model)
 *
 * A validator must never throw on parseable input: malformed YAML,
 * empty files, and wrongly-typed fields all produce a structured
 * INVALID report so `--format json` consumers always receive JSON.
 *
 * @module modules/validate
 */

import { parse as parseYaml } from "@std/yaml";
import { datatypes, descRefs, readInput } from "./io.js";
import { STANDARD_PREFIXES } from "./prefixes.js";

// ── Valid value vocabularies ──────────────────────────────────

/**
 * Valid SimpleDSP value types (Japanese + English), lower-cased.
 * Includes the spec's parenthesised `参照値(URI)` variant, matching
 * what the dsp.js importer accepts.
 */
const SIMPLEDSP_VALUE_TYPES = new Set([
  "id", "literal", "structured", "iri", "",
  "文字列", "構造化", "参照値", "参照値(uri)", "制約なし",
]);

/** Valid YAMA YAML type values. */
const YAMA_TYPES = new Set(["literal", "iri", "uri", "bnode", ""]);

/** Valid DCTAP valueNodeType values (case-insensitive). */
const DCTAP_NODE_TYPES = new Set(["iri", "literal", "bnode"]);

/** Standard DCTAP valueConstraintType values (lower-cased). */
const DCTAP_CONSTRAINT_TYPES = new Set([
  "picklist", "iristem", "pattern", "languagetag",
  "minlength", "maxlength", "mininclusive", "maxinclusive",
]);

/** Valid DCTAP boolean values (case-insensitive). */
const DCTAP_BOOLEANS = new Set(["true", "false", "yes", "no", "1", "0"]);

/** Spec §4.4 facet keys (exact casing). */
const YAMA_FACETS = [
  "MinInclusive", "MaxInclusive", "MinExclusive", "MaxExclusive",
  "MinLength", "MaxLength", "Length", "TotalDigits", "FractionDigits",
];

/** Lower-cased facet key → canonical casing, for typo suggestions. */
const FACET_BY_LOWER = new Map(YAMA_FACETS.map((f) => [f.toLowerCase(), f]));

// ── Helpers ───────────────────────────────────────────────────

function extractPrefix(term) {
  if (term == null) return null;
  const s = String(term);
  if (/^(https?|urn):/.test(s)) return null;
  const colon = s.indexOf(":");
  if (colon > 0) return s.substring(0, colon);
  return null;
}

function isPrefixKnown(prefix, namespaces) {
  return prefix in namespaces || prefix in STANDARD_PREFIXES;
}

/**
 * Checks if a prefixed term uses a known prefix.
 *
 * For tabular sources (DCTAP and SimpleDSP), unknown prefixes are
 * downgraded to info (pushed to the `infoArr` array): DCTAP has no
 * namespace declaration mechanism at all, and SimpleDSP property
 * prefixes are already error-checked structurally in phase 1.
 * For other formats, they are errors (pushed to `errorArr`).
 */
function checkPrefix(term, namespaces, location, fieldName, errorArr, format = "yaml", infoArr = null) {
  const prefix = extractPrefix(term);
  if (prefix && !isPrefixKnown(prefix, namespaces)) {
    if ((format === "dctap" || format === "simpledsp") && infoArr) {
      infoArr.push({
        location,
        severity: "info",
        message: `Prefix "${prefix}" in ${fieldName} "${term}" is not a standard prefix`,
        fix: format === "dctap"
          ? `DCTAP has no namespace declaration mechanism — prefix resolution depends on external context. Standard prefixes: ${Object.keys(STANDARD_PREFIXES).join(", ")}`
          : `Declare "${prefix}" in the [@NS] block, or use a standard prefix (${Object.keys(STANDARD_PREFIXES).join(", ")})`,
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

/**
 * Builds an INVALID report for input that could not be validated at
 * all (unparseable YAML, empty file, non-mapping document).
 *
 * @param {string} filePath - Source file path.
 * @param {string} format   - Detected input format.
 * @param {string} message  - What went wrong.
 * @param {string} fix      - How to fix it.
 * @returns {Object} ValidationReport
 */
function invalidInputReport(filePath, format, message, fix) {
  return {
    file: filePath,
    format,
    valid: false,
    summary: {
      namespaces: {
        declared: 0,
        standard: Object.keys(STANDARD_PREFIXES).length,
        list: [],
      },
      base: "",
      descriptions: 0,
      statements: 0,
    },
    descriptions: [],
    errors: [msg("error", message, fix)],
    warnings: [],
    info: [],
  };
}

/**
 * Returns true when a cardinality value is a non-negative integer.
 * Strings (which would compare lexicographically) and fractions fail.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isValidCardinality(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
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
  // Crash guard: empty/null YAML and non-mapping documents produce a
  // structured INVALID report instead of a TypeError.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return invalidInputReport(
      filePath,
      sourceFormat,
      doc == null
        ? "Document is empty"
        : "Document is not a YAML mapping",
      "Provide a YAML mapping with a 'descriptions' key",
    );
  }

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
  const descSummaries = [];

  for (const [descName, descDef] of Object.entries(descriptions)) {
    const descPath = `descriptions.${descName}`;

    // A null/scalar description body would crash every field access.
    if (!descDef || typeof descDef !== "object" || Array.isArray(descDef)) {
      errors.push(msg("error",
        `Description "${descName}" is not a mapping`,
        "Each description must be a YAML mapping (statements, a, label, …)",
        { path: descPath }));
      descSummaries.push({
        name: descName,
        targetClass: "",
        idPrefix: "",
        statementCount: 0,
        valueTypes: {},
      });
      continue;
    }

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

      // A null/scalar statement body would crash every field access.
      if (!stmtDef || typeof stmtDef !== "object" || Array.isArray(stmtDef)) {
        errors.push(msg("error",
          `Statement "${stmtKey}" in "${descName}" is not a mapping`,
          "Each statement must be a YAML mapping (property, type, min, …)",
          { path: stmtPath }));
        continue;
      }

      // Property check
      if (!stmtDef.property) {
        warnings.push(msg("warning",
          `Statement "${stmtKey}" in "${descName}" has no property`,
          "Add a 'property' key (e.g. 'dc:title') — without it, no RDF output is generated",
          { path: `${stmtPath}.property` }));
      } else {
        checkPrefix(stmtDef.property, namespaces, { path: `${stmtPath}.property` }, "property", errors, sourceFormat, info);
      }

      // Type validation — coerce first: YAML happily parses
      // `type: true` as a boolean, and .toLowerCase() on a non-string
      // must not crash the validator.
      const typeStr = stmtDef.type != null ? String(stmtDef.type) : "";
      if (typeStr && !YAMA_TYPES.has(typeStr.toLowerCase())) {
        errors.push(msg("error",
          `Invalid type "${typeStr}" in statement "${stmtKey}"`,
          "Type must be one of: literal, IRI, URI, BNODE, or omitted",
          { path: `${stmtPath}.type` }));
      }

      const stmtRefs = descRefs(stmtDef);

      // §4.2: BNODE must be combined with description — without one
      // there is nothing to define the blank node's structure.
      if (typeStr.toLowerCase() === "bnode" && stmtRefs.length === 0) {
        errors.push(msg("error",
          `Statement "${stmtKey}" has type BNODE but no description reference`,
          "Per spec §4.2, BNODE must be combined with 'description' to define the blank node's structure",
          { path: `${stmtPath}.type` }));
      }

      // §4.3: min/max must be non-negative integers. String values
      // would compare lexicographically ("10" < "9"), so they are
      // rejected rather than coerced.
      for (const bound of ["min", "max"]) {
        const v = stmtDef[bound];
        if (v != null && !isValidCardinality(v)) {
          errors.push(msg("error",
            `Invalid ${bound} "${v}" in statement "${stmtKey}" — must be a non-negative integer`,
            `Use an unquoted non-negative integer for '${bound}' (e.g. ${bound}: 1)`,
            { path: `${stmtPath}.${bound}` }));
        }
      }

      // Cardinality ordering — only meaningful when both are numeric.
      if (isValidCardinality(stmtDef.min) && isValidCardinality(stmtDef.max) &&
        stmtDef.min > stmtDef.max) {
        errors.push(msg("error",
          `Invalid cardinality in "${stmtKey}": min (${stmtDef.min}) exceeds max (${stmtDef.max})`,
          "Set min ≤ max, or remove max for unbounded",
          { path: stmtPath }));
      }

      // §4.4: facet keys must come from the spec's facet list, with
      // exact casing (e.g. `minInclusive` is not `MinInclusive`).
      if (stmtDef.facets != null) {
        if (typeof stmtDef.facets !== "object" || Array.isArray(stmtDef.facets)) {
          errors.push(msg("error",
            `Invalid facets in statement "${stmtKey}" — must be a mapping`,
            `Use a mapping of facet keys: ${YAMA_FACETS.join(", ")}`,
            { path: `${stmtPath}.facets` }));
        } else {
          for (const facetKey of Object.keys(stmtDef.facets)) {
            if (YAMA_FACETS.includes(facetKey)) continue;
            const canonical = FACET_BY_LOWER.get(facetKey.toLowerCase());
            warnings.push(msg("warning",
              `Unknown facet "${facetKey}" in statement "${stmtKey}"`,
              canonical
                ? `Did you mean "${canonical}"? Facet keys are case-sensitive`
                : `Valid facets: ${YAMA_FACETS.join(", ")}`,
              { path: `${stmtPath}.facets.${facetKey}` }));
          }
        }
      }

      // §4.5: pattern must compile as a regular expression.
      if (stmtDef.pattern != null) {
        try {
          new RegExp(String(stmtDef.pattern));
        } catch {
          warnings.push(msg("warning",
            `Pattern "${stmtDef.pattern}" in statement "${stmtKey}" does not compile as a regular expression`,
            "Check the regex syntax — generators emit the pattern verbatim into SHACL/ShEx",
            { path: `${stmtPath}.pattern` }));
        }
      }

      // §4.5: values must be a sequence.
      if (stmtDef.values != null && !Array.isArray(stmtDef.values)) {
        errors.push(msg("error",
          `Invalid values in statement "${stmtKey}" — must be a sequence`,
          "Use a YAML sequence (- item) for 'values'",
          { path: `${stmtPath}.values` }));
      }

      // Datatype prefix(es) — check each one when the field is a
      // multi-datatype array.
      for (const dt of datatypes(stmtDef)) {
        checkPrefix(dt, namespaces, { path: `${stmtPath}.datatype` }, "datatype", errors, sourceFormat, info);
      }

      // Description reference(s) — each ref in the list must resolve
      for (const ref of stmtRefs) {
        if (!descNames.includes(ref)) {
          errors.push(msg("error",
            `Statement "${stmtKey}" references undefined description "${ref}"`,
            `Available descriptions: ${descNames.join(", ")}`,
            { path: `${stmtPath}.description` }));
        }
      }

      // Track value types for summary
      const typeUpper = typeStr.toUpperCase();
      const vt = stmtRefs.length > 0 ? "structured" :
        typeUpper === "IRI" || typeUpper === "URI" ? "iri" :
        stmtDef.datatype || typeStr === "literal" ? "literal" : "unconstrained";
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
 * Row locations come from the `_line` field stamped by the dsp.js
 * parser (the physical input line for TSV sources).
 *
 * @param {Array} blocks - Parsed blocks from readSimpleDsp/parseSimpleDspText.
 * @param {Object} parsedNs - Namespace declarations from [@NS] block.
 * @returns {Object} ValidationReport (structural issues only)
 */
export function validateSimpleDspRaw(blocks, parsedNs) {
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
  for (const block of blocks) {
    let idRowCount = 0;

    for (const row of block.rows) {
      const location = row._line ? { line: row._line } : {};
      // Excel exports may write the value type as `"ID"` with literal
      // quotes — strip them like the dsp.js importer does.
      const vt = String(row.ValueType || "")
        .replace(/^"(.*)"$/, "$1")
        .toLowerCase();

      // Value type vocabulary check
      if (vt && !SIMPLEDSP_VALUE_TYPES.has(vt)) {
        errors.push(msg("error",
          `Unknown value type "${row.ValueType}" in block [${block.id}]`,
          "Value type must be one of: ID, literal/文字列, structured/構造化, IRI/参照値(URI), or empty/制約なし",
          location));
      }

      // ID row checks
      if (vt === "id") {
        idRowCount++;
        if (idRowCount > 1) {
          errors.push(msg("error",
            `Multiple ID rows in block [${block.id}]`,
            "Each block may have at most one ID statement",
            location));
        }
      }

      // Property prefix check
      if (row.Property) {
        checkPrefix(row.Property, { ...STANDARD_PREFIXES, ...namespaces },
          location, "property", errors);
      }

      // Constraint: #blockId reference check
      const constraint = row.Constraint || "";
      if (constraint.startsWith("#")) {
        const refId = constraint.slice(1);
        if (!blockIds.includes(refId)) {
          errors.push(msg("error",
            `Constraint "${constraint}" references undefined block "${refId}"`,
            `Available blocks: ${blockIds.join(", ")}`,
            location));
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
 * Headers are matched case-insensitively via the importer's own
 * normaliser, so `validate` and `from-dctap` agree on what a column
 * means. Cell values are coerced to strings before any string ops —
 * Excel numeric cells (e.g. `1` in `mandatory`) must not crash.
 *
 * @param {Array} rows - Parsed DCTAP rows (objects with column keys).
 * @param {(row: Object) => Object} normaliseRow - Header normaliser from dctap.js.
 * @returns {Object} Partial validation report (structural issues only)
 */
export function validateDctapRaw(rows, normaliseRow) {
  const errors = [];
  const warnings = [];
  const info = [];

  const normalised = rows.map((r) => (normaliseRow ? normaliseRow(r) : r));

  if (normalised.length === 0) {
    warnings.push(msg("warning", "No data rows found in DCTAP file",
      "Add at least one row with a propertyID"));
    return { errors, warnings, info };
  }

  // Check for shapeID presence
  const hasShapeId = normalised.some((r) => r.shapeID);
  if (!hasShapeId) {
    warnings.push(msg("warning",
      "No shapeID defined — all rows treated as a single unnamed shape",
      "Add a shapeID column to group properties into shapes"));
  }

  // Collect shape IDs for valueShape validation
  const shapeIds = new Set();
  for (const row of normalised) {
    if (row.shapeID) shapeIds.add(String(row.shapeID).trim());
  }

  for (let i = 0; i < normalised.length; i++) {
    const row = normalised[i];
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
      if (!DCTAP_NODE_TYPES.has(String(row.valueNodeType).toLowerCase())) {
        errors.push(msg("error",
          `Row ${line}: invalid valueNodeType "${row.valueNodeType}"`,
          "valueNodeType must be one of: IRI, literal, bnode (case-insensitive)",
          { line }));
      }
    }

    // valueConstraintType check
    if (row.valueConstraintType) {
      if (!DCTAP_CONSTRAINT_TYPES.has(String(row.valueConstraintType).toLowerCase())) {
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
      if (row.valueNodeType && String(row.valueNodeType).toLowerCase() === "literal") {
        warnings.push(msg("warning",
          `Row ${line}: valueShape used with valueNodeType "literal"`,
          "valueShape is typically used with IRI or bnode, not literal",
          { line }));
      }
    }

    // mandatory/repeatable boolean check
    for (const boolField of ["mandatory", "repeatable"]) {
      const raw = row[boolField];
      if (raw != null && String(raw).trim() !== "" &&
        !DCTAP_BOOLEANS.has(String(raw).toLowerCase())) {
        warnings.push(msg("warning",
          `Row ${line}: "${boolField}" value "${raw}" is not a recognized boolean`,
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
 * @param {string} [opts.inputFormat] - Force input format: "yaml", "simpledsp", "dctap"
 * @returns {Promise<Object>} ValidationReport
 */
export async function validateFile(filePath, { inputFormat } = {}) {
  const format = inputFormat || await detectFormat(filePath);

  if (format === "yaml") {
    const text = await readInput(filePath);
    let doc;
    try {
      doc = parseYaml(text);
    } catch (err) {
      // YAML syntax errors become a structured INVALID report so that
      // `--format json` consumers always receive JSON.
      return invalidInputReport(
        filePath,
        "yaml",
        `YAML syntax error: ${err.message}`,
        "Fix the YAML syntax before validating profile semantics",
      );
    }
    return validateYamaDocument(doc, filePath);
  }

  if (format === "simpledsp") {
    // Use readSimpleDsp and simpleDspToYama from dsp.js
    const { readSimpleDsp, simpleDspToYama } = await import("./dsp.js");
    const { blocks, namespaces } = await readSimpleDsp(filePath);

    // Phase 1: structural
    const structural = validateSimpleDspRaw(blocks, namespaces);

    // Phase 2: semantic (convert to YAMA then validate)
    const doc = simpleDspToYama(blocks, namespaces);
    const semantic = validateYamaDocument(doc, filePath, "simpledsp");

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
    const { normaliseDctapRow, readTabular, rowsToYama } = await import("./dctap.js");
    const rows = await readTabular(filePath);

    // Phase 1: structural (case-insensitive headers, like the importer)
    const structural = validateDctapRaw(rows, normaliseDctapRow);

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
 *
 * CSV disambiguation reads through {@link readInput}, so URLs are
 * content-sniffed exactly like local files instead of falling through
 * to the DCTAP default.
 *
 * @param {string} filePath - Path or URL of the input.
 * @returns {Promise<string>} "yaml", "simpledsp", or "dctap".
 */
async function detectFormat(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "tsv") return "simpledsp";
  if (ext === "xlsx" || ext === "xls") return "simpledsp";
  if (ext === "csv") {
    // Disambiguate: read first few lines
    try {
      const text = await readInput(filePath);
      const firstLine = text.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
      if (firstLine?.trim().startsWith("[")) return "simpledsp";
      const lower = firstLine?.toLowerCase() || "";
      if (lower.includes("propertyid") || lower.includes("shapeid")) return "dctap";
    } catch { /* fall through */ }
    return "dctap"; // default for CSV
  }
  return "yaml"; // fallback
}
