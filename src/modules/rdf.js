/**
 * @fileoverview RDF generation from YAMAML documents.
 *
 * Implements the core YAMAML-to-RDF mapping pipeline:
 *   1. Parse the YAMAML document and resolve its base directory.
 *   2. For each description with an `id` mapping, load its data source.
 *   3. Extract subject IDs, then process each statement to build RDF quads.
 *   4. Apply value transformations (strip, replace, separator, prepend, append).
 *   5. Serialize accumulated quads to the requested format via N3.Writer.
 *
 * @module rdf
 */

import { parse as parseCsv } from "@std/csv";
import { parse as parseYaml } from "@std/yaml";
import { dirname, resolve } from "@std/path";
import jsonata from "jsonata";
import N3 from "n3";
import * as XLSX from "xlsx";
import { serializeRdf, SUPPORTED_FORMATS } from "./serialize.js";
import { datatypes, readInput, readInputBytes } from "./io.js";
import {
  collectUsedStandardPrefixes,
  expandPrefixed,
  STANDARD_PREFIXES,
} from "./prefixes.js";

export { SUPPORTED_FORMATS };

const { DataFactory } = N3;
const { namedNode, literal, blankNode, quad } = DataFactory;

/**
 * @typedef {NamedNode} NamedNode
 * @typedef {BlankNode} BlankNode
 * @typedef {Literal} Literal
 * @typedef {Quad} Quad
 */

/** Full IRI for rdf:type. */
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates RDF from a YAMAML file.
 *
 * @param {string} file           - Path to the YAMAML input file.
 * @param {Object} [options]      - Output options.
 * @param {string} [options.output=""]  - Output file path; stdout if empty.
 * @param {string} [options.format="turtle"] - Serialization format.
 * @returns {Promise<void>}
 */
export async function generateRDF(file, { output = "", format = "turtle" } = {}) {
  const doc = parseYaml(await readInput(file));
  const basePath = /^https?:\/\//i.test(file) ? file.replace(/\/[^/]*$/, "") : dirname(resolve(file));

  // CURIEs resolve through the standard prefix table with user
  // declarations taking precedence (YAMAML §2.2).
  const userNamespaces = doc.namespaces || {};
  const ctx = {
    doc,
    basePath,
    namespaces: { ...STANDARD_PREFIXES, ...userNamespaces },
    base: doc.base || "",
    defaults: doc.defaults || {},
    dataCache: new Map(),
  };

  const quads = await buildQuads(ctx);
  const outputNamespaces = {
    ...userNamespaces,
    ...collectUsedStandardPrefixes(quads, userNamespaces),
  };
  await serializeRdf(quads, outputNamespaces, ctx.base, output, format);
}

// ---------------------------------------------------------------------------
// Data source loading
// ---------------------------------------------------------------------------

/**
 * Loads a data source, using a per-run cache to avoid redundant reads.
 *
 * Supports CSV, JSON, and YAML files, plus the special `"data"` keyword
 * that references inline data from the YAMAML document's `data` section.
 * The type is inferred from the file extension when not declared.
 *
 * @param {string}              source    - File path or `"data"`.
 * @param {string|undefined}    type      - Declared type (csv, json, yaml).
 * @param {Object}              ctx       - Pipeline context.
 * @returns {Promise<Object[]>} Parsed records as an array of objects.
 * @throws {Error} On unsupported source type.
 */
async function loadSource(source, type, ctx) {
  if (source === "data" && ctx.doc.data) {
    const d = ctx.doc.data;
    return Array.isArray(d) ? d : [d];
  }

  const resolved = resolveSourcePath(source, ctx.basePath);

  if (ctx.dataCache.has(resolved)) {
    return ctx.dataCache.get(resolved);
  }

  const effectiveType = (type || inferTypeFromPath(resolved)).toLowerCase();
  let data;

  switch (effectiveType) {
    case "csv": {
      const text = await readInput(resolved);
      data = parseCsv(text, { skipFirstRow: true });
      break;
    }
    case "json": {
      const text = await readInput(resolved);
      data = JSON.parse(text);
      if (!Array.isArray(data)) data = [data];
      break;
    }
    case "yaml":
    case "yml": {
      const text = await readInput(resolved);
      data = parseYaml(text);
      if (!Array.isArray(data)) data = [data];
      break;
    }
    case "xlsx":
    case "xls": {
      const bytes = await readInputBytes(resolved);
      const workbook = XLSX.read(bytes, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
      break;
    }
    default:
      throw new Error(
        `Unsupported data source type "${effectiveType}" for "${source}".`,
      );
  }

  ctx.dataCache.set(resolved, data);
  return data;
}

/**
 * Resolves a source path relative to the YAMAML file's directory.
 * Absolute paths and URLs are returned unchanged.
 *
 * @param {string} source   - Raw path from the mapping.
 * @param {string} basePath - Directory of the YAMAML file.
 * @returns {string}
 */
function resolveSourcePath(source, basePath) {
  if (/^(\/|https?:\/\/)/.test(source)) return source;
  return `${basePath}/${source}`;
}

/**
 * Infers the data source type from a file extension.
 *
 * @param {string} filePath
 * @returns {string} Normalized type string.
 */
function inferTypeFromPath(filePath) {
  const ext = filePath.split(".").pop().toLowerCase();
  return ext === "yml" ? "yaml" : ext;
}

// ---------------------------------------------------------------------------
// JSONata evaluation
// ---------------------------------------------------------------------------

/**
 * Extracts all unique ID values from a dataset.
 *
 * @param {Object[]} data     - Loaded records.
 * @param {string}   idColumn - Name of the ID field.
 * @returns {Promise<string[]>}
 */
async function extractIds(data, idColumn) {
  const result = await jsonata(`$.\`${idColumn}\``).evaluate(data);
  if (result === undefined) return [];
  return Array.isArray(result) ? result : [result];
}

/**
 * Extracts a field value from the record matching a given ID.
 *
 * The ID comparison goes through `$string()` and a JSONata variable
 * binding rather than string interpolation: numeric IDs (e.g. the
 * spec's §2.4 inline `id: 1`) would never match a quoted literal
 * under JSONata's type-strict `=`, and interpolated values could
 * inject expression syntax via `"` or backticks.
 *
 * @param {Object[]} data      - Loaded records.
 * @param {string}   idColumn  - Name of the ID field.
 * @param {string|number} idValue - ID to match.
 * @param {string}   fieldPath - Field to extract.
 * @returns {Promise<*>}
 */
async function extractValue(data, idColumn, idValue, fieldPath) {
  const expr = `$[$string(\`${idColumn}\`) = $idVal].\`${fieldPath}\``;
  return await jsonata(expr).evaluate(data, { idVal: String(idValue) });
}

// ---------------------------------------------------------------------------
// Value transformation pipeline
// ---------------------------------------------------------------------------

/**
 * Merges statement-level mapping with document defaults.
 *
 * @param {Object|undefined} stmtMapping - Statement's own mapping.
 * @param {Object}           defaults    - Document defaults section.
 * @returns {Object|null} Merged mapping, or null if none defined.
 */
function mergeMapping(stmtMapping, defaults) {
  if (!stmtMapping && !defaults?.mapping) return null;
  return { ...(defaults?.mapping || {}), ...(stmtMapping || {}) };
}

/**
 * Applies `strip` and `replace` transformations to a string value.
 *
 * @param {string} value
 * @param {Object} mapping
 * @returns {string}
 */
function applyTransformations(value, mapping) {
  let v = String(value);

  if (Array.isArray(mapping.strip)) {
    for (const ch of mapping.strip) {
      v = v.replaceAll(ch, "");
    }
  }

  if (Array.isArray(mapping.replace)) {
    for (const pair of mapping.replace) {
      if (Array.isArray(pair) && pair.length === 2) {
        v = v.replaceAll(String(pair[0]), String(pair[1]));
      }
    }
  }

  return v;
}

/**
 * Splits, transforms, and decorates a raw value into final output strings.
 *
 * Handles the full pipeline: separator splitting, strip/replace,
 * and prepend/append decoration. Array values from structured
 * sources (JSON/YAML) produce one output value — and thus one
 * triple — per element instead of collapsing into a single
 * comma-joined literal.
 *
 * @param {*}      rawValue - Value extracted from the data source.
 * @param {Object} mapping  - Mapping configuration.
 * @returns {string[]} Final values (empty array if input is empty).
 */
function transformValues(rawValue, mapping) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return [];

  const sep = mapping.separator || "";
  const pre = mapping.prepend || "";
  const suf = mapping.append || "";

  const rawList = Array.isArray(rawValue) ? rawValue : [rawValue];

  const values = [];
  for (const item of rawList) {
    if (item === undefined || item === null || item === "") continue;
    if (sep && typeof item === "string") {
      values.push(...item.split(sep).map((v) => v.trim()).filter(Boolean));
    } else {
      values.push(item);
    }
  }

  return values.map((v) => `${pre}${applyTransformations(v, mapping)}${suf}`);
}

// ---------------------------------------------------------------------------
// RDF object construction
// ---------------------------------------------------------------------------

/**
 * Creates an N3 RDF term (NamedNode or Literal) for a statement value.
 *
 * - IRI/URI types are expanded and wrapped as NamedNode.
 * - Literals with a declared datatype carry that datatype.
 * - Untyped literals are plain strings.
 *
 * YAMAML has no language element, so no language tag is ever
 * attached — tagging every literal `@en` would mislabel non-English
 * data and silently discard declared `xsd:string` datatypes.
 *
 * @param {string} value
 * @param {string} type       - "literal", "IRI", or "URI".
 * @param {string} datatype   - Prefixed datatype (e.g. "xsd:integer").
 * @param {Object} namespaces
 * @param {string} base
 * @returns {NamedNode|Literal}
 */
function makeRdfObject(value, type, datatype, namespaces, base) {
  const t = (type || "literal").toUpperCase();

  if (t === "IRI" || t === "URI") {
    return namedNode(expandPrefixed(value, namespaces, base));
  }

  if (datatype) {
    const dtIri = expandPrefixed(datatype, namespaces, base);
    return literal(value, namedNode(dtIri));
  }

  return literal(value);
}

// ---------------------------------------------------------------------------
// Statement processing (shared by top-level and blank node builders)
// ---------------------------------------------------------------------------

/**
 * Processes a single statement definition into RDF quads.
 *
 * This is the shared core used by both top-level descriptions and
 * blank node descriptions, eliminating duplication.
 *
 * @param {NamedNode|BlankNode} subject
 * @param {Object}   stmtDef    - Statement definition from the YAMAML doc.
 * @param {string}   idColumn   - ID column name for data filtering.
 * @param {string}   idValue    - Current subject's ID value.
 * @param {Object}   ctx        - Pipeline context.
 * @param {Quad[]} quads - Accumulator for generated quads.
 * @returns {Promise<void>}
 */
async function processStatement(subject, stmtDef, idColumn, idValue, ctx, quads) {
  const property = stmtDef.property;
  if (!property) return;

  const predIri = expandPrefixed(property, ctx.namespaces, ctx.base);
  const stmtType = (stmtDef.type || "literal");
  const mapping = mergeMapping(stmtDef.mapping, ctx.defaults);

  // Blank node: recurse into referenced description. When multiple
  // descriptions are listed (disjunction in the profile), we can only
  // generate one concrete blank node per row; we pick the first ref
  // since instance-data generation is one-shot, not disjunctive.
  const bnodeRef = Array.isArray(stmtDef.description)
    ? stmtDef.description[0]
    : stmtDef.description;
  if (stmtType.toUpperCase() === "BNODE" && bnodeRef) {
    const bnodeResult = await buildBlankNode(
      bnodeRef, idValue, idColumn, ctx,
    );
    if (bnodeResult.quads.length > 0) {
      quads.push(quad(subject, namedNode(predIri), bnodeResult.node));
      quads.push(...bnodeResult.quads);
    }
    return;
  }

  if (!mapping?.path) return;

  const data = await loadSource(mapping.source, mapping.type, ctx);
  const rawValue = await extractValue(data, idColumn, idValue, mapping.path);
  if (rawValue === undefined || rawValue === null || rawValue === "") return;

  const values = transformValues(rawValue, mapping);
  for (const v of values) {
    quads.push(quad(
      subject,
      namedNode(predIri),
      // RDF literals have exactly one datatype per value. For a
      // multi-datatype statement we attach the first — the union is
      // a schema-level constraint, not a per-literal property.
      makeRdfObject(v, stmtType, datatypes(stmtDef)[0], ctx.namespaces, ctx.base),
    ));
  }
}

// ---------------------------------------------------------------------------
// Blank node builder
// ---------------------------------------------------------------------------

/**
 * Builds an RDF blank node for a nested description.
 *
 * @param {string} descName - Name of the description to instantiate.
 * @param {string} idValue  - Parent subject's ID for data filtering.
 * @param {string} idColumn - ID column name from the parent description.
 * @param {Object} ctx      - Pipeline context.
 * @returns {Promise<{node: BlankNode, quads: Quad[]}>}
 * @throws {Error} If the referenced description does not exist.
 */
async function buildBlankNode(descName, idValue, idColumn, ctx) {
  const descDef = ctx.doc.descriptions[descName];
  if (!descDef) {
    throw new Error(`Blank node references unknown description: "${descName}"`);
  }

  const bn = blankNode();
  const quads = [];

  if (descDef.a) {
    quads.push(quad(
      bn,
      namedNode(RDF_TYPE),
      namedNode(expandPrefixed(descDef.a, ctx.namespaces, ctx.base)),
    ));
  }

  if (!descDef.statements) return { node: bn, quads };

  const effectiveIdColumn = descDef.id?.mapping?.path || idColumn;

  for (const stmtDef of Object.values(descDef.statements)) {
    await processStatement(bn, stmtDef, effectiveIdColumn, idValue, ctx, quads);
  }

  return { node: bn, quads };
}

// ---------------------------------------------------------------------------
// Main quad builder
// ---------------------------------------------------------------------------

/**
 * Builds the complete set of RDF quads from a parsed YAMAML document.
 *
 * Iterates descriptions that have an `id` mapping (descriptions without
 * one are blank-node targets processed on demand). For each ID found in
 * the data source, creates a subject and processes all its statements.
 *
 * @param {Object} ctx - Pipeline context.
 * @returns {Promise<Quad[]>}
 */
async function buildQuads(ctx) {
  const allQuads = [];

  for (const [descName, descDef] of Object.entries(ctx.doc.descriptions || {})) {
    // Descriptions without id are blank-node targets
    if (!descDef.id) continue;

    const idMapping = mergeMapping(descDef.id.mapping, ctx.defaults);
    if (!idMapping?.source || !idMapping?.path) {
      console.warn(`Warning: description "${descName}" has no id mapping source or path, skipping.`);
      continue;
    }

    const idData = await loadSource(idMapping.source, idMapping.type, ctx);
    const idColumn = idMapping.path;
    const ids = await extractIds(idData, idColumn);

    for (const id of ids) {
      // Use id.prefix namespace if available, otherwise fall back to doc base
      let subjectBase = ctx.base || "";
      if (descDef.id.prefix && ctx.namespaces[descDef.id.prefix]) {
        subjectBase = ctx.namespaces[descDef.id.prefix];
      }
      const subject = namedNode(subjectBase + id);

      if (descDef.a) {
        allQuads.push(quad(
          subject,
          namedNode(RDF_TYPE),
          namedNode(expandPrefixed(descDef.a, ctx.namespaces, ctx.base)),
        ));
      }

      if (!descDef.statements) continue;

      for (const stmtDef of Object.values(descDef.statements)) {
        await processStatement(subject, stmtDef, idColumn, id, ctx, allQuads);
      }
    }
  }

  return allQuads;
}

