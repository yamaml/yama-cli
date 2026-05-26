/**
 * @fileoverview OWL-DSP and SimpleDSP generation from YAMA files.
 *
 * Implements two output formats based on the Description Set Profile
 * definition language by Masahide Kanzaki:
 *
 *   - **OWL-DSP** (`dsp`): RDF quads using the `dsp:` ontology.
 *     Description templates are OWL classes, statement templates are
 *     OWL restrictions expressed as subclasses of the description template.
 *
 *   - **SimpleDSP** (`simpledsp`): A tab-separated text format with
 *     `[@NS]`, `[MAIN]`, and sub-shape blocks.
 *
 * OWL-DSP ontology: http://purl.org/metainfo/terms/dsp#
 *
 * YAMA-to-DSP mapping:
 *
 * | YAMA element                    | OWL-DSP                                |
 * |---------------------------------|----------------------------------------|
 * | description                     | dsp:DescriptionTemplate (OWL class)    |
 * | description.a                   | dsp:resourceClass                      |
 * | description.label               | rdfs:label                             |
 * | description.note                | rdfs:comment                           |
 * | description.id                  | dsp:valueURIOccurrence "mandatory"     |
 * | statement (property shape)      | dsp:StatementTemplate (OWL restriction)|
 * | statement.property              | owl:onProperty                         |
 * | statement.label                 | rdfs:label                             |
 * | statement.note                  | rdfs:comment                           |
 * | statement.min/max               | owl:minQualifiedCardinality /           |
 * |                                 | owl:maxQualifiedCardinality             |
 * | statement.datatype              | owl:onDataRange                        |
 * | statement.type = IRI            | (value type = reference)               |
 * | statement.type = literal        | (value type = literal)                 |
 * | statement.description (ref)     | owl:onClass (shape reference)          |
 * | statement.values (vocab)        | dsp:inScheme                           |
 *
 * SimpleDSP column mapping (tab-separated):
 *
 * | Column        | YAMA source                      |
 * |---------------|----------------------------------|
 * | Statement name| statement key (label)            |
 * | Property      | statement.property (prefixed)    |
 * | Min           | statement.min                    |
 * | Max           | statement.max (- = unbounded)    |
 * | Value type    | ID / literal / structured / ref  |
 * | Constraint    | datatype, shape ref, vocab, etc. |
 * | Comment       | statement.note                   |
 *
 * @module dsp
 * @see https://www.kanzaki.com/ns/dsp#
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { parse as parseCsv, stringify as stringifyCsv } from "@std/csv";
import * as XLSX from "xlsx";
import N3 from "n3";
import { serializeRdf } from "./serialize.js";
import { datatypes, descRefs, readInput, readInputBytes } from "./io.js";

const { DataFactory } = N3;
const { namedNode, literal, blankNode, quad } = DataFactory;

/**
 * @typedef {NamedNode} NamedNode
 * @typedef {Quad} Quad
 */

// ---------------------------------------------------------------------------
// Namespace constants
// ---------------------------------------------------------------------------

const DSP = "http://purl.org/metainfo/terms/dsp#";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const DSP_DESCRIPTION_TEMPLATE = namedNode(`${DSP}DescriptionTemplate`);
const DSP_STATEMENT_TEMPLATE = namedNode(`${DSP}StatementTemplate`);
const DSP_RESOURCE_CLASS = namedNode(`${DSP}resourceClass`);
const DSP_VALUE_URI_OCCURRENCE = namedNode(`${DSP}valueURIOccurrence`);
const DSP_CARDINALITY_NOTE = namedNode(`${DSP}cardinalityNote`);
const DSP_IN_SCHEME = namedNode(`${DSP}inScheme`);
const DSP_PROPERTY_MAPPING = namedNode(`${DSP}propertyMapping`);
const DSP_LANG_TAG_OCCURRENCE = namedNode(`${DSP}langTagOccurrence`);
const DSP_PER_LANG_MAX_CARD = namedNode(`${DSP}perLangMaxCardinality`);

const OWL_CLASS = namedNode(`${OWL}Class`);
const OWL_RESTRICTION = namedNode(`${OWL}Restriction`);
const OWL_ON_PROPERTY = namedNode(`${OWL}onProperty`);
const OWL_ON_CLASS = namedNode(`${OWL}onClass`);
const OWL_ON_DATA_RANGE = namedNode(`${OWL}onDataRange`);
const OWL_MIN_QUAL_CARD = namedNode(`${OWL}minQualifiedCardinality`);
const OWL_MAX_QUAL_CARD = namedNode(`${OWL}maxQualifiedCardinality`);
const OWL_QUAL_CARD = namedNode(`${OWL}qualifiedCardinality`);
const OWL_UNION_OF = namedNode(`${OWL}unionOf`);

const RDF_TYPE = namedNode(`${RDF}type`);
const RDF_FIRST = namedNode(`${RDF}first`);
const RDF_REST = namedNode(`${RDF}rest`);
const RDF_NIL = namedNode(`${RDF}nil`);

const RDFS_SUBCLASS_OF = namedNode(`${RDFS}subClassOf`);
const RDFS_LABEL = namedNode(`${RDFS}label`);
const RDFS_COMMENT = namedNode(`${RDFS}comment`);
const RDFS_LITERAL = namedNode(`${RDFS}Literal`);

const XSD_NON_NEGATIVE_INTEGER = namedNode(`${XSD}nonNegativeInteger`);

// ---------------------------------------------------------------------------
// Standard prefix table (Table 19 from spec + schema: extension)
// ---------------------------------------------------------------------------

const STANDARD_PREFIXES = {
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xl: "http://www.w3.org/2008/05/skos-xl#",
  rdf: RDF,
  rdfs: RDFS,
  owl: OWL,
  xsd: XSD,
  schema: "https://schema.org/",
};

// ---------------------------------------------------------------------------
// IRI helpers
// ---------------------------------------------------------------------------

/**
 * Expands a prefixed term to a full IRI.
 *
 * @param {string} term
 * @param {Object} namespaces
 * @param {string} base
 * @returns {string|null}
 */
function expandPrefixed(term, namespaces, base) {
  if (!term) return null;
  if (/^(https?|urn):/.test(term)) return term;

  const colon = term.indexOf(":");
  if (colon >= 0) {
    const prefix = term.substring(0, colon);
    const local = term.substring(colon + 1);
    if (namespaces[prefix]) return namespaces[prefix] + local;
  }

  return base ? base + term : term;
}

/**
 * Compresses a full IRI to prefixed form if possible.
 *
 * @param {string} iri
 * @param {Object} namespaces
 * @returns {string}
 */
function compressPrefixed(iri, namespaces) {
  for (const [prefix, ns] of Object.entries(namespaces)) {
    if (iri.startsWith(ns)) {
      return `${prefix}:${iri.substring(ns.length)}`;
    }
  }
  return iri;
}

// ---------------------------------------------------------------------------
// RDF list builder
// ---------------------------------------------------------------------------

function buildRdfList(items, quads) {
  if (items.length === 0) return RDF_NIL;
  const head = blankNode();
  let current = head;
  for (let i = 0; i < items.length; i++) {
    quads.push(quad(current, RDF_FIRST, items[i]));
    if (i < items.length - 1) {
      const next = blankNode();
      quads.push(quad(current, RDF_REST, next));
      current = next;
    } else {
      quads.push(quad(current, RDF_REST, RDF_NIL));
    }
  }
  return head;
}

// ---------------------------------------------------------------------------
// SimpleDSP value type resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the SimpleDSP value type for a statement.
 *
 * Table 15 from spec:
 *   ID         — record ID
 *   (none)     — no constraint (any value)
 *   literal    — literal value
 *   structured — nested description (structured value)
 *   reference  — URI reference
 *
 * @param {Object} stmtDef
 * @returns {string}
 */
function resolveSimpleDspValueType(stmtDef) {
  if (descRefs(stmtDef).length > 0) return "structured";
  // Structured with class constraint (e.g. foaf:Agent) — per spec Table 17
  if (stmtDef.a) return "structured";
  const type = (stmtDef.type || "").toUpperCase();
  if (type === "IRI" || type === "URI") return "IRI";
  if (type === "LITERAL" || stmtDef.datatype || Array.isArray(stmtDef.values)) {
    return "literal";
  }
  return "";
}

/**
 * Resolves the SimpleDSP value constraint for a statement.
 *
 * @param {Object} stmtDef
 * @param {Object} namespaces
 * @returns {string}
 */
function resolveSimpleDspConstraint(stmtDef, namespaces) {
  // Structured: shape reference(s). SimpleDSP spec has no disjunction
  // syntax — we emit space-separated `#A #B` as a yama-cli extension so
  // multi-shape profiles at least round-trip through SimpleDSP when
  // consumed by yama-cli itself. Strict consumers read the first ref.
  const refs = descRefs(stmtDef);
  if (refs.length > 0) {
    return refs.map((r) => `#${r}`).join(" ");
  }

  // Structured: class constraint (e.g. foaf:Agent) — per spec Table 17
  if (stmtDef.a) {
    const classes = Array.isArray(stmtDef.a) ? stmtDef.a : [stmtDef.a];
    return classes.join(" ");
  }

  // Datatype constraint — multi-datatype is spec-endorsed (§4.6 Table 16)
  // and serialised as a space-separated list in the Constraint cell.
  if (stmtDef.datatype) {
    if (Array.isArray(stmtDef.datatype)) return stmtDef.datatype.join(" ");
    return stmtDef.datatype;
  }

  // Vocabulary scheme (inScheme) — check before values since both may exist
  if (stmtDef.inScheme) {
    const schemes = Array.isArray(stmtDef.inScheme)
      ? stmtDef.inScheme
      : [stmtDef.inScheme];
    return schemes.map((s) => `${s}`).join(" ");
  }

  // Value set — for literal type, quote values; for reference type, don't
  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    const type = (stmtDef.type || "").toUpperCase();
    if (type === "IRI" || type === "URI") {
      // Reference URIs are unquoted (per spec Table 18)
      return stmtDef.values.join(" ");
    }
    // Literal picklist: quoted strings (per spec Table 16)
    return stmtDef.values.map((v) => `"${v}"`).join(" ");
  }

  return "";
}

// ---------------------------------------------------------------------------
// SimpleDSP language-specific labels
// ---------------------------------------------------------------------------

const SIMPLEDSP_HEADERS = {
  en: "#Name\tProperty\tMin\tMax\tValueType\tConstraint\tComment",
  jp: "#項目規則名\tプロパティ\t最小\t最大\t値タイプ\t値制約\tコメント",
};

/** Maps internal English value types to Japanese for export. */
const VALUE_TYPE_JP = {
  ID: "ID",
  literal: "文字列",
  structured: "構造化",
  IRI: "参照値",
  "": "制約なし",
};

// ---------------------------------------------------------------------------
// SimpleDSP generator
// ---------------------------------------------------------------------------

/**
 * Generates SimpleDSP text output from a parsed YAMA document.
 *
 * File structure:
 *   [@NS]    — namespace declarations (prefix → URI, tab-separated)
 *   [MAIN]   — main description template
 *   [Shape]  — additional description templates
 *
 * @param {Object} doc  - Parsed YAMA document.
 * @param {Object} [opts]
 * @param {string} [opts.lang="en"] - Header/value-type language: "en" or "jp".
 * @returns {string}
 */
function buildSimpleDsp(doc, { lang = "en" } = {}) {
  const namespaces = doc.namespaces || {};
  const base = doc.base || "";
  const descriptions = doc.descriptions || {};
  const lines = [];

  // Determine which prefixes need explicit declarations
  // Standard prefixes (Table 19) can be omitted unless overridden
  const customNs = {};
  for (const [prefix, uri] of Object.entries(namespaces)) {
    if (STANDARD_PREFIXES[prefix] !== uri) {
      customNs[prefix] = uri;
    }
  }
  // Ensure ID prefix namespaces are included in [@NS] if non-standard
  for (const descDef of Object.values(descriptions)) {
    const idPrefix = descDef.id?.prefix;
    if (idPrefix && !STANDARD_PREFIXES[idPrefix] && namespaces[idPrefix]) {
      customNs[idPrefix] = namespaces[idPrefix];
    }
  }
  if (base) {
    customNs["@base"] = base;
  }

  // @NS block (only if custom namespaces exist)
  if (Object.keys(customNs).length > 0) {
    lines.push("[@NS]");
    for (const [prefix, uri] of Object.entries(customNs)) {
      lines.push(`${prefix}\t${uri}`);
    }
    lines.push("");
  }

  // All namespaces for prefix compression (merge standard + custom)
  const allNs = { ...STANDARD_PREFIXES, ...namespaces };

  const descEntries = Object.entries(descriptions);
  const firstDescName = descEntries.length > 0 ? descEntries[0][0] : null;

  for (const [descName, descDef] of descEntries) {
    const blockId = descName === firstDescName ? "MAIN" : descName;
    lines.push(`[${blockId}]`);

    // Header comment line
    const isJp = lang === "jp";
    lines.push(isJp ? SIMPLEDSP_HEADERS.jp : SIMPLEDSP_HEADERS.en);

    const statements = descDef.statements || {};

    // ID statement — per spec 6.2.4, every description block should have one.
    // Emit when the YAML has an id: mapping or a class (a:).
    if (descDef.id || descDef.a) {
      const idPath = descDef.id?.mapping?.path || "ID";
      const idClass = descDef.a || "";
      let idConstraint = "";
      if (descDef.id?.prefix) {
        idConstraint = `${descDef.id.prefix}:`;
      }
      const idComment = descDef.note || "";
      const vtId = "ID";
      lines.push(
        `${idPath}\t${idClass}\t1\t1\t${vtId}\t${idConstraint}\t${idComment}`,
      );
    }

    for (const [stmtKey, stmtDef] of Object.entries(statements)) {
      const stmtName = stmtDef.label || stmtKey;
      const property = stmtDef.property || "";
      // Keyword occurrences (e.g. "推奨") are stored in cardinalityNote;
      // use keyword as min, and preserve max if explicitly set.
      const min = stmtDef.cardinalityNote
        ? stmtDef.cardinalityNote
        : (stmtDef.min != null ? String(stmtDef.min) : "0");
      const max = stmtDef.max != null ? String(stmtDef.max) : "-";
      const valueTypeEn = resolveSimpleDspValueType(stmtDef);
      const valueType = isJp ? (VALUE_TYPE_JP[valueTypeEn] ?? valueTypeEn) : valueTypeEn;
      const constraint = resolveSimpleDspConstraint(stmtDef, allNs);
      const comment = stmtDef.note || "";

      lines.push(
        `${stmtName}\t${property}\t${min}\t${max}\t${valueType}\t${constraint}\t${comment}`,
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SimpleDSP tabular I/O helpers
// ---------------------------------------------------------------------------

/** SimpleDSP column headers for tabular export. */
const SIMPLE_DSP_COLUMNS = [
  "Name",
  "Property",
  "Min",
  "Max",
  "ValueType",
  "Constraint",
  "Comment",
];

/**
 * Infers tabular format from file extension.
 *
 * @param {string} path
 * @returns {"tsv"|"csv"|"xlsx"}
 */
function inferTabularFormat(path) {
  if (!path) return "tsv";
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  return "tsv";
}

/**
 * Converts SimpleDSP text to row objects for tabular export.
 *
 * @param {string} text - SimpleDSP text content.
 * @returns {{blocks: Array<{id: string, rows: Object[]}>, namespaces: Object}}
 */
function parseSimpleDspText(text) {
  const lines = text.split(/\r?\n/);
  const namespaces = {};
  const blocks = [];
  let currentBlock = null;
  let inNsBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Block header
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const blockId = trimmed.slice(1, -1);
      if (blockId === "@NS") {
        inNsBlock = true;
        currentBlock = null;
        continue;
      }
      inNsBlock = false;
      currentBlock = { id: blockId, rows: [] };
      blocks.push(currentBlock);
      continue;
    }

    // Comment line (header row)
    if (trimmed.startsWith("#")) continue;

    if (inNsBlock) {
      const parts = trimmed.split(/\t+/);
      if (parts.length >= 2) {
        namespaces[parts[0].trim()] = parts[1].trim();
      }
      continue;
    }

    if (currentBlock) {
      const cells = trimmed.split("\t");
      currentBlock.rows.push({
        Name: (cells[0] || "").trim(),
        Property: (cells[1] || "").trim(),
        Min: (cells[2] || "").trim(),
        Max: (cells[3] || "").trim(),
        ValueType: (cells[4] || "").trim(),
        Constraint: (cells[5] || "").trim(),
        Comment: (cells[6] || "").trim(),
      });
    }
  }

  return { blocks, namespaces };
}

/**
 * Converts SimpleDSP blocks to a YAMA document.
 *
 * @param {Array<{id: string, rows: Object[]}>} blocks
 * @param {Object} parsedNs - Namespaces from @NS block.
 * @returns {Object} YAMA document.
 */
export function simpleDspToYama(blocks, parsedNs) {
  const doc = {};

  // Build namespaces from @NS block
  const namespaces = {};
  let base = "";
  for (const [key, uri] of Object.entries(parsedNs)) {
    if (key === "@base") {
      base = uri;
    } else {
      namespaces[key] = uri;
    }
  }
  if (base) doc.base = base;
  if (Object.keys(namespaces).length > 0) doc.namespaces = namespaces;

  const descriptions = {};
  let isFirst = true;

  for (const block of blocks) {
    const descName = block.id === "MAIN" && isFirst
      ? "MAIN"
      : block.id;
    isFirst = false;

    const descDef = {};
    const statements = {};
    const usedKeys = new Set();

    for (const row of block.rows) {
      const stmtName = row.Name;
      const property = row.Property;
      const minStr = row.Min;
      const maxStr = row.Max;
      const valueType = (row.ValueType || "").toLowerCase();
      const constraint = row.Constraint || "";
      const comment = row.Comment || "";

      // Normalize Japanese value type names to English.
      // The spec defines 参照値(URI); match with or without the (URI) suffix.
      const jpMap = {
        "文字列": "literal",
        "構造化": "structured",
        "参照値(uri)": "iri",
        "参照値": "iri",
        "制約なし": "",
      };
      const normalizedValueType = jpMap[valueType] || valueType;

      // ID statement — defines the record's identity
      if (normalizedValueType === "id") {
        descDef.id = { mapping: { path: stmtName || "ID" } };
        if (property) descDef.a = property;
        if (constraint) {
          // ID constraint is a namespace prefix reference (e.g. "ndlbooks:")
          // or a full URI. Per SimpleDSP spec, it should be a declared prefix.
          const trimmed = constraint.replace(/:$/, "");
          // Check if it matches a declared namespace prefix
          const allNs = { ...STANDARD_PREFIXES, ...namespaces };
          if (allNs[trimmed]) {
            descDef.id.prefix = trimmed;
          } else if (constraint.startsWith("http://") || constraint.startsWith("https://")) {
            // Full URI — find or create a matching prefix
            let foundPrefix = "";
            for (const [pfx, uri] of Object.entries(allNs)) {
              if (uri === constraint || uri === constraint.replace(/:$/, "")) {
                foundPrefix = pfx;
                break;
              }
            }
            if (foundPrefix) {
              descDef.id.prefix = foundPrefix;
            } else {
              // No matching prefix; store the full URI as a fallback in base
              // (backward compatibility for files that use full URIs)
              if (!doc.base) doc.base = constraint;
            }
          } else if (trimmed) {
            // Prefix-like constraint — store as prefix
            descDef.id.prefix = trimmed;
          }
        }
        if (comment) descDef.note = comment;
        continue;
      }

      // Regular statement
      if (!property && !stmtName) continue;

      // Generate a key from the statement name.
      // Per spec: spaces → underscores, middle dot ・ → underscore,
      // preserve CJK characters (valid per spec).
      let key = stmtName
        ? stmtName
            .replace(/\u30FB/g, "_")      // middle dot ・ → underscore
            .replace(/[^\p{L}\p{N}\s_]/gu, "") // keep letters (incl. CJK), digits, spaces, underscores
            .replace(/\s+(.)/g, (_, c) => c.toUpperCase()) // camelCase from spaces
            .replace(/\s+/g, "")
        : property.split(":").pop() || `stmt${usedKeys.size}`;
      // Lowercase first char, but if the entire key is uppercase keep it lowercase
      if (key === key.toUpperCase() && /^[A-Z]+$/.test(key)) {
        key = key.toLowerCase();
      } else {
        key = key.charAt(0).toLowerCase() + key.slice(1);
      }
      if (usedKeys.has(key)) {
        let suffix = 2;
        while (usedKeys.has(`${key}${suffix}`)) suffix++;
        key = `${key}${suffix}`;
      }
      usedKeys.add(key);

      const stmt = {};
      if (stmtName) stmt.label = stmtName;
      if (property) stmt.property = property;

      // Cardinality — numeric values are stored as min/max;
      // keyword occurrences (e.g. "推奨", "あれば必須") are preserved
      // as cardinalityNote for OWL-DSP output.
      const min = parseCardinality(minStr);
      const max = parseCardinality(maxStr);
      if (min != null) stmt.min = min;
      if (max != null) stmt.max = max;
      if (minStr && min == null && minStr !== "-") {
        stmt.cardinalityNote = minStr;
      }

      // Value type and constraint
      switch (normalizedValueType) {
        case "literal":
          stmt.type = "literal";
          if (constraint) {
            // Could be a datatype (e.g. xsd:date) or quoted picklist.
            // SimpleDSP §4.6 Table 16 endorses space-separated multi-
            // datatype (union semantics); we store an array when more
            // than one token is present.
            if (constraint.startsWith('"')) {
              stmt.values = parseQuotedValues(constraint);
            } else {
              const parts = constraint.split(/\s+/).filter(Boolean);
              stmt.datatype = parts.length === 1 ? parts[0] : parts;
            }
          }
          break;
        case "structured":
          if (constraint.startsWith("#")) {
            // Reference(s) to another block in the same file. Accept the
            // spec's single `#blockId` as well as the yama-cli multi-ref
            // extension `#A #B` so multi-shape profiles survive a
            // SimpleDSP round-trip.
            const refs = constraint
              .split(/\s+/)
              .filter((s) => s.startsWith("#"))
              .map((s) => s.slice(1))
              .filter(Boolean);
            stmt.description = refs.length === 1 ? refs[0] : refs;
          } else if (constraint) {
            // Class name(s) — value is instance of that class (e.g. foaf:Agent).
            // Per spec Table 17, multiple classes may be space-separated.
            const classes = constraint.split(/\s+/);
            if (classes.length === 1) {
              stmt.type = "IRI";
              stmt.a = classes[0];
            } else {
              stmt.type = "IRI";
              stmt.a = classes;
            }
          }
          break;
        case "iri":
          stmt.type = "IRI";
          if (constraint) {
            // Per spec Table 18: vocab schemes end with ":", specific URIs
            // may be qualified names or <URI> in angle brackets.
            // Strip angle brackets from <URI> entries.
            const raw = constraint.replace(/<([^>]+)>/g, "$1");
            const parts = raw.split(/\s+/).filter(Boolean);
            const schemes = parts.filter((p) => p.endsWith(":"));
            const uris = parts.filter((p) => !p.endsWith(":"));
            if (schemes.length > 0) {
              stmt.inScheme = schemes.length === 1 ? schemes[0] : schemes;
            }
            if (uris.length > 0) {
              stmt.values = uris;
            }
          }
          break;
        default:
          // No specific type — leave unconstrained. Accept the spec
          // §4.6 Table 16 multi-datatype shape here too for symmetry.
          if (constraint) {
            const parts = constraint.split(/\s+/).filter(Boolean);
            stmt.datatype = parts.length === 1 ? parts[0] : parts;
          }
          break;
      }

      if (comment) stmt.note = comment;
      statements[key] = stmt;
    }

    if (Object.keys(statements).length > 0) {
      descDef.statements = statements;
    }

    descriptions[descName] = descDef;
  }

  doc.descriptions = descriptions;
  return doc;
}

/**
 * Parses a cardinality value from SimpleDSP.
 *
 * Per spec: `-` means unbounded; keywords like "推奨" (recommended) are
 * treated as optional (null). Any non-numeric string returns null.
 *
 * @param {string} val
 * @returns {number|null}
 */
function parseCardinality(val) {
  if (!val || val === "-") return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Splits a single CSV line into fields, handling quoted fields.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parses quoted values from a SimpleDSP constraint.
 * e.g. '"banana" "apple" "orange"' → ["banana", "apple", "orange"]
 *
 * @param {string} str
 * @returns {string[]}
 */
function parseQuotedValues(str) {
  const matches = str.match(/"([^"]*)"/g);
  if (!matches) return [str];
  return matches.map((m) => m.slice(1, -1));
}

/**
 * Reads a SimpleDSP file in any tabular format (TSV, CSV, Excel).
 *
 * For TSV files: parses as native SimpleDSP text (with [@NS] blocks).
 * For CSV/Excel: reads columnar data where each sheet/section represents
 * a description block. The first column group before a blank row or
 * a row starting with "[" is treated as a block.
 *
 * @param {string} file
 * @returns {Promise<{blocks: Array<{id: string, rows: Object[]}>, namespaces: Object}>}
 */
export async function readSimpleDsp(file) {
  const fmt = inferTabularFormat(file);

  if (fmt === "xlsx") {
    // SimpleDSP Excel: single sheet with block markers as rows
    // Same structure as TSV but laid out in a spreadsheet
    const data = await readInputBytes(file);
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const rawRows = XLSX.utils.sheet_to_json(
      workbook.Sheets[sheetName],
      { header: 1, defval: "" },
    );
    // Reconstruct as tab-separated text and parse with shared logic
    const text = rawRows
      .map((row) => row.map((c) => String(c ?? "")).join("\t"))
      .join("\n");
    return parseSimpleDspText(text);
  }

  const text = await readInput(file);

  if (fmt === "csv") {
    // Convert CSV to tab-separated before parsing with shared logic
    const lines = text.split(/\r?\n/);
    const tsvLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("#")) {
        return trimmed;
      }
      return splitCsvLine(trimmed).join("\t");
    });
    return parseSimpleDspText(tsvLines.join("\n"));
  }

  // Native TSV (tab-separated with block markers)
  return parseSimpleDspText(text);
}

/**
 * Writes SimpleDSP as a tabular file (TSV, CSV, or Excel).
 *
 * @param {string} simpleDspText - The SimpleDSP text content.
 * @param {string} [output]      - Output path; stdout if empty.
 */
function writeSimpleDspTabular(simpleDspText, output) {
  const fmt = inferTabularFormat(output);

  if (fmt === "xlsx") {
    // SimpleDSP Excel: single sheet with the TSV content as rows
    const lines = simpleDspText.split(/\r?\n/);
    const aoa = lines.map((line) => line.split("\t"));
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet 1");
    const buf = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    Deno.writeFileSync(output, new Uint8Array(buf));
    console.error(`Written to ${output}`);
    return;
  }

  let text = simpleDspText;
  if (fmt === "csv") {
    // Convert tab-separated internal format to comma-separated CSV.
    // Fields that contain commas, quotes, or newlines are quoted.
    text = simpleDspText
      .split(/\r?\n/)
      .map((line) => {
        return line
          .split("\t")
          .map((cell) => {
            if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
              return `"${cell.replace(/"/g, '""')}"`;
            }
            return cell;
          })
          .join(",");
      })
      .join("\n");
  }

  if (output) {
    Deno.writeTextFileSync(output, text);
    console.error(`Written to ${output}`);
  } else {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  }
}

// ---------------------------------------------------------------------------
// OWL-DSP quad builder
// ---------------------------------------------------------------------------

/**
 * Builds a StatementTemplate as an OWL restriction.
 *
 * In OWL-DSP, each statement template S is an OWL class restriction:
 *   - S a dsp:StatementTemplate
 *   - S rdfs:subClassOf [ owl:Restriction ; owl:onProperty P ; owl:cardinality 1 ]
 *   - S owl:onProperty P
 *   - cardinality via owl:minQualifiedCardinality / owl:maxQualifiedCardinality
 *   - datatype via owl:onDataRange
 *   - shape ref via owl:onClass
 *
 * @param {NamedNode} descNode - Parent DescriptionTemplate IRI.
 * @param {string}   descName   - Description name for building statement IRIs.
 * @param {string}   stmtKey    - Statement key.
 * @param {Object}   stmtDef    - Statement definition.
 * @param {Object}   namespaces - Prefix-to-IRI map.
 * @param {string}   base       - Document base IRI.
 * @param {Quad[]} quads - Accumulator.
 * @returns {NamedNode} The statement template node.
 */
function buildStatementTemplate(
  descNode,
  descName,
  stmtKey,
  stmtDef,
  namespaces,
  base,
  quads,
) {
  const stmtIri = base
    ? `${base}${descName}-${stmtKey}`
    : `${descName}-${stmtKey}`;
  const stmtNode = namedNode(stmtIri);

  // rdf:type dsp:StatementTemplate
  quads.push(quad(stmtNode, RDF_TYPE, DSP_STATEMENT_TEMPLATE));

  // owl:onProperty
  const propertyIri = expandPrefixed(stmtDef.property, namespaces, base);
  if (propertyIri) {
    quads.push(quad(stmtNode, OWL_ON_PROPERTY, namedNode(propertyIri)));
  }

  // rdfs:label
  if (stmtDef.label) {
    quads.push(quad(stmtNode, RDFS_LABEL, literal(stmtDef.label)));
  }

  // rdfs:comment
  if (stmtDef.note) {
    quads.push(quad(stmtNode, RDFS_COMMENT, literal(stmtDef.note)));
  }

  // Cardinality
  const min = stmtDef.min;
  const max = stmtDef.max;

  if (min != null && max != null && min === max) {
    // Exact cardinality
    quads.push(
      quad(
        stmtNode,
        OWL_QUAL_CARD,
        literal(String(min), XSD_NON_NEGATIVE_INTEGER),
      ),
    );
  } else {
    if (min != null) {
      quads.push(
        quad(
          stmtNode,
          OWL_MIN_QUAL_CARD,
          literal(String(min), XSD_NON_NEGATIVE_INTEGER),
        ),
      );
    }
    if (max != null) {
      quads.push(
        quad(
          stmtNode,
          OWL_MAX_QUAL_CARD,
          literal(String(max), XSD_NON_NEGATIVE_INTEGER),
        ),
      );
    }
  }

  // Cardinality note (for "recommended" etc.)
  if (stmtDef.cardinalityNote) {
    quads.push(
      quad(stmtNode, DSP_CARDINALITY_NOTE, literal(stmtDef.cardinalityNote)),
    );
  }

  // Value type: datatype → owl:onDataRange
  // Multi-datatype is normalised via `datatypes()` which accepts both
  // scalar (legacy) and array (post-multi-datatype) YAML shapes.
  const dts = datatypes(stmtDef);
  if (dts.length === 1) {
    const dtIri = expandPrefixed(dts[0], namespaces, base);
    quads.push(quad(stmtNode, OWL_ON_DATA_RANGE, namedNode(dtIri)));
  } else if (dts.length > 1) {
    // Multiple datatypes: owl:onDataRange [owl:unionOf (...)]
    const dtNodes = dts.map((dt) =>
      namedNode(expandPrefixed(dt, namespaces, base)),
    );
    const listHead = buildRdfList(dtNodes, quads);
    const unionAnon = blankNode();
    quads.push(quad(unionAnon, namedNode(`${OWL}unionOf`), listHead));
    quads.push(quad(stmtNode, OWL_ON_DATA_RANGE, unionAnon));
  }

  // Value type: structured → owl:onClass (shape reference(s))
  const shapeRefs = descRefs(stmtDef);
  if (shapeRefs.length === 1) {
    const refIri = base ? base + shapeRefs[0] : shapeRefs[0];
    quads.push(quad(stmtNode, OWL_ON_CLASS, namedNode(refIri)));
  } else if (shapeRefs.length > 1) {
    const refNodes = shapeRefs.map((r) => namedNode(base ? base + r : r));
    const listHead = buildRdfList(refNodes, quads);
    const unionAnon = blankNode();
    quads.push(quad(unionAnon, namedNode(`${OWL}unionOf`), listHead));
    quads.push(quad(stmtNode, OWL_ON_CLASS, unionAnon));
  }

  // Value type: structured → owl:onClass (class constraint, e.g. foaf:Agent)
  if (stmtDef.a && shapeRefs.length === 0) {
    const classes = Array.isArray(stmtDef.a) ? stmtDef.a : [stmtDef.a];
    if (classes.length === 1) {
      const classIri = expandPrefixed(classes[0], namespaces, base);
      quads.push(quad(stmtNode, OWL_ON_CLASS, namedNode(classIri)));
    } else {
      // Multiple classes: owl:onClass [owl:unionOf (...)]
      const classNodes = classes.map((c) =>
        namedNode(expandPrefixed(c, namespaces, base)),
      );
      const listHead = buildRdfList(classNodes, quads);
      const unionAnon = blankNode();
      quads.push(quad(unionAnon, namedNode(`${OWL}unionOf`), listHead));
      quads.push(quad(stmtNode, OWL_ON_CLASS, unionAnon));
    }
  }

  // Value constraint: inScheme (vocabulary constraint)
  if (stmtDef.inScheme) {
    const schemes = Array.isArray(stmtDef.inScheme)
      ? stmtDef.inScheme
      : [stmtDef.inScheme];

    if (schemes.length === 1) {
      const schemeIri = expandPrefixed(schemes[0], namespaces, base);
      const anon = blankNode();
      quads.push(quad(anon, DSP_IN_SCHEME, namedNode(schemeIri)));
      quads.push(quad(stmtNode, OWL_ON_CLASS, anon));
    } else {
      // Multiple schemes: owl:unionOf
      const classNodes = schemes.map((s) => {
        const sIri = expandPrefixed(s, namespaces, base);
        const anon = blankNode();
        quads.push(quad(anon, DSP_IN_SCHEME, namedNode(sIri)));
        return anon;
      });
      const unionAnon = blankNode();
      const listHead = buildRdfList(classNodes, quads);
      quads.push(quad(unionAnon, OWL_UNION_OF, listHead));
      quads.push(quad(stmtNode, OWL_ON_CLASS, unionAnon));
    }
  }

  // Value constraint: values — depends on statement type
  if (
    Array.isArray(stmtDef.values) &&
    stmtDef.values.length > 0 &&
    !stmtDef.inScheme
  ) {
    const type = (stmtDef.type || "").toUpperCase();
    if (type === "IRI" || type === "URI") {
      // Reference specific URIs → owl:onClass [owl:oneOf (expanded URIs)]
      const items = stmtDef.values.map((v) =>
        namedNode(expandPrefixed(String(v), namespaces, base)),
      );
      const listHead = buildRdfList(items, quads);
      const rangeNode = blankNode();
      quads.push(quad(rangeNode, namedNode(`${OWL}oneOf`), listHead));
      quads.push(quad(stmtNode, OWL_ON_CLASS, rangeNode));
    } else {
      // Literal picklist → owl:onDataRange [owl:oneOf (literals)]
      const items = stmtDef.values.map((v) => literal(String(v)));
      const listHead = buildRdfList(items, quads);
      const rangeNode = blankNode();
      quads.push(quad(rangeNode, namedNode(`${OWL}oneOf`), listHead));
      quads.push(quad(stmtNode, OWL_ON_DATA_RANGE, rangeNode));
    }
  }

  // Property mapping (dsp:propertyMapping)
  if (stmtDef.propertyMapping) {
    const mappingIri = expandPrefixed(
      stmtDef.propertyMapping,
      namespaces,
      base,
    );
    if (mappingIri) {
      quads.push(
        quad(stmtNode, DSP_PROPERTY_MAPPING, namedNode(mappingIri)),
      );
    }
  }

  return stmtNode;
}

/**
 * Builds the complete OWL-DSP graph from a parsed YAMA document.
 *
 * Each YAMA description becomes a dsp:DescriptionTemplate (OWL class).
 * Statement templates become dsp:StatementTemplate instances linked
 * via rdfs:subClassOf to the description template.
 *
 * @param {Object} doc        - Parsed YAMA document.
 * @param {Object} namespaces - Prefix-to-IRI map.
 * @param {string} base       - Document base IRI.
 * @returns {Quad[]}
 */
function buildDspQuads(doc, namespaces, base) {
  const quads = [];
  const descriptions = doc.descriptions || {};

  for (const [descName, descDef] of Object.entries(descriptions)) {
    const descIri = base ? `${base}${descName}` : descName;
    const descNode = namedNode(descIri);

    // rdf:type dsp:DescriptionTemplate
    quads.push(quad(descNode, RDF_TYPE, DSP_DESCRIPTION_TEMPLATE));

    // dsp:resourceClass from "a"
    if (descDef.a) {
      const classIri = expandPrefixed(descDef.a, namespaces, base);
      quads.push(quad(descNode, DSP_RESOURCE_CLASS, namedNode(classIri)));
    }

    // dsp:valueURIOccurrence for descriptions with id
    if (descDef.id) {
      quads.push(
        quad(descNode, DSP_VALUE_URI_OCCURRENCE, literal("mandatory")),
      );
    }

    // rdfs:label
    if (descDef.label) {
      quads.push(quad(descNode, RDFS_LABEL, literal(descDef.label)));
    }

    // rdfs:comment
    if (descDef.note) {
      quads.push(quad(descNode, RDFS_COMMENT, literal(descDef.note)));
    }

    // Build statement templates and link via rdfs:subClassOf
    const statements = descDef.statements || {};
    const stmtNodes = [];

    for (const [stmtKey, stmtDef] of Object.entries(statements)) {
      const stmtNode = buildStatementTemplate(
        descNode,
        descName,
        stmtKey,
        stmtDef,
        namespaces,
        base,
        quads,
      );
      stmtNodes.push(stmtNode);
    }

    // Link description → statement templates via rdfs:subClassOf
    for (const stmtNode of stmtNodes) {
      quads.push(quad(descNode, RDFS_SUBCLASS_OF, stmtNode));
    }
  }

  return quads;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates OWL-DSP from a YAMA file.
 *
 * Builds RDF quads using the dsp: ontology and serializes them in the
 * requested format (defaults to Turtle).
 *
 * @param {string} file           - Path to the YAMA input file.
 * @param {Object} [options]      - Output options.
 * @param {string} [options.output=""]  - Output file path; stdout if empty.
 * @param {string} [options.format="turtle"] - Serialization format.
 * @returns {Promise<void>}
 */
export async function generateDSP(file, { output = "", format = "turtle" } = {}) {
  const doc = parseYaml(await readInput(file));

  // Resolution namespaces include standard fallbacks for CURIE expansion,
  // but the output prefix map contains only what the user declared plus dsp
  // (emitted because this module uses it). Standard prefixes are never
  // eagerly added to output — the user's namespaces block is authoritative.
  const userNamespaces = doc.namespaces || {};
  const resolutionNamespaces = { ...STANDARD_PREFIXES, ...userNamespaces };
  const outputNamespaces = { dsp: DSP, ...userNamespaces };
  const base = doc.base || "";

  const quads = buildDspQuads(doc, resolutionNamespaces, base);
  await serializeRdf(quads, outputNamespaces, base, output, format);
}

/**
 * Exports SimpleDSP from a YAMA file.
 *
 * Output format is inferred from file extension:
 *   - `.tsv` or no extension → native SimpleDSP (tab-separated with blocks)
 *   - `.csv` → CSV with Block column
 *   - `.xlsx` → Excel workbook with one sheet per block
 *
 * @param {string} file     - Path to the YAMA input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @param {Object} [opts]
 * @param {string} [opts.lang] - Header/value-type language: "en" (default) or "jp".
 * @returns {Promise<void>}
 */
export async function exportSimpleDSP(file, output, { lang } = {}) {
  const doc = parseYaml(await readInput(file));
  const result = buildSimpleDsp(doc, { lang: lang || "en" });
  writeSimpleDspTabular(result, output);
}

/**
 * Imports a SimpleDSP file (TSV, CSV, or Excel) and converts to YAMA YAML.
 *
 * @param {string} file     - Path to the SimpleDSP input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function importSimpleDSP(file, output) {
  const { blocks, namespaces } = await readSimpleDsp(file);
  const doc = simpleDspToYama(blocks, namespaces);
  const yaml = stringifyYaml(doc, { lineWidth: -1 });

  if (output) {
    Deno.writeTextFileSync(output, yaml);
    console.error(`Written to ${output}`);
  } else {
    console.log(yaml);
  }
}
