/**
 * @fileoverview SHACL (Shapes Constraint Language) generation from YAMA files.
 *
 * Translates a YAMA application profile into a SHACL shapes graph expressed
 * as RDF quads. Because SHACL is itself RDF, this module builds quads
 * programmatically using N3.js and serializes them through the shared
 * {@link module:serialize} pipeline — giving automatic support for every
 * output format (Turtle, N-Triples, JSON-LD, etc.).
 *
 * YAMA-to-SHACL mapping:
 *
 * | YAMA element            | SHACL property               |
 * |-------------------------|------------------------------|
 * | description             | sh:NodeShape                 |
 * | description.a           | sh:targetClass               |
 * | description.label       | sh:name                      |
 * | description.note        | sh:description               |
 * | statement               | sh:PropertyShape (via sh:property) |
 * | statement.property      | sh:path                      |
 * | statement.label         | sh:name                      |
 * | statement.note          | sh:description               |
 * | statement.min           | sh:minCount                  |
 * | statement.max           | sh:maxCount                  |
 * | statement.datatype      | sh:datatype                  |
 * | statement.type (IRI)    | sh:nodeKind sh:IRI           |
 * | statement.type (literal)| sh:nodeKind sh:Literal       |
 * | statement.type (BNODE)  | sh:nodeKind sh:BlankNode     |
 * | statement.description (single) | sh:node (shape reference)    |
 * | statement.description (many)   | sh:or ([sh:node ... ])       |
 * | statement.a              | sh:class                     |
 * | statement.facets.MinInclusive | sh:minInclusive        |
 * | statement.facets.MaxInclusive | sh:maxInclusive        |
 * | statement.facets.MinExclusive | sh:minExclusive        |
 * | statement.facets.MaxExclusive | sh:maxExclusive        |
 * | statement.facets.MinLength    | sh:minLength           |
 * | statement.facets.MaxLength    | sh:maxLength           |
 * | statement.facets.Length       | sh:minLength + sh:maxLength |
 * | statement.languageTag    | sh:languageIn                |
 * | statement.inScheme       | sh:pattern (anchored stem)   |
 * | statement.pattern        | sh:pattern                   |
 * | statement.values         | sh:in                        |
 *
 * @module shacl
 * @see https://www.w3.org/TR/shacl/
 */

import { parse as parseYaml } from "@std/yaml";
import N3 from "n3";
import { serializeRdf } from "./serialize.js";
import { datatypes, descRefs, nodeTypes, readInput } from "./io.js";
import {
  buildRdfList,
  collectUsedStandardPrefixes,
  expandPrefixed,
  normalizeScheme,
  STANDARD_PREFIXES,
} from "./prefixes.js";

const { DataFactory } = N3;
const { namedNode, literal, blankNode, quad } = DataFactory;

/**
 * @typedef {NamedNode} NamedNode
 * @typedef {BlankNode} BlankNode
 * @typedef {Term} Term
 * @typedef {Quad} Quad
 */

// ---------------------------------------------------------------------------
// SHACL / RDF vocabulary constants
// ---------------------------------------------------------------------------

const SH = "http://www.w3.org/ns/shacl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const SH_NODE_SHAPE       = namedNode(`${SH}NodeShape`);
const SH_PROPERTY_SHAPE   = namedNode(`${SH}PropertyShape`);
const SH_TARGET_CLASS     = namedNode(`${SH}targetClass`);
const SH_PROPERTY         = namedNode(`${SH}property`);
const SH_PATH             = namedNode(`${SH}path`);
const SH_NAME             = namedNode(`${SH}name`);
const SH_DESCRIPTION      = namedNode(`${SH}description`);
const SH_MIN_COUNT        = namedNode(`${SH}minCount`);
const SH_MAX_COUNT        = namedNode(`${SH}maxCount`);
const SH_DATATYPE         = namedNode(`${SH}datatype`);
const SH_NODE_KIND        = namedNode(`${SH}nodeKind`);
const SH_NODE             = namedNode(`${SH}node`);
const SH_CLASS            = namedNode(`${SH}class`);
const SH_MIN_INCLUSIVE    = namedNode(`${SH}minInclusive`);
const SH_MAX_INCLUSIVE    = namedNode(`${SH}maxInclusive`);
const SH_MIN_EXCLUSIVE    = namedNode(`${SH}minExclusive`);
const SH_MAX_EXCLUSIVE    = namedNode(`${SH}maxExclusive`);
const SH_MIN_LENGTH       = namedNode(`${SH}minLength`);
const SH_MAX_LENGTH       = namedNode(`${SH}maxLength`);
const SH_LANGUAGE_IN      = namedNode(`${SH}languageIn`);
const SH_PATTERN          = namedNode(`${SH}pattern`);
const SH_IN               = namedNode(`${SH}in`);
const SH_IRI              = namedNode(`${SH}IRI`);
const SH_LITERAL          = namedNode(`${SH}Literal`);
const SH_BLANK_NODE       = namedNode(`${SH}BlankNode`);
const SH_CLOSED           = namedNode(`${SH}closed`);
const SH_IGNORED_PROPERTIES = namedNode(`${SH}ignoredProperties`);
const SH_OR               = namedNode(`${SH}or`);

const RDF_TYPE             = namedNode(`${RDF}type`);

const XSD_INTEGER          = namedNode(`${XSD}integer`);
const XSD_DECIMAL          = namedNode(`${XSD}decimal`);
const XSD_BOOLEAN          = namedNode(`${XSD}boolean`);

// ---------------------------------------------------------------------------
// IRI helpers
// ---------------------------------------------------------------------------

/**
 * Escapes regex metacharacters in a string so it can be embedded
 * verbatim in a `sh:pattern` regular expression.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// SHACL quad builder
// ---------------------------------------------------------------------------

/**
 * Maps a YAMA statement type string to a SHACL sh:nodeKind term.
 *
 * @param {string} type - YAMA type value (IRI, URI, literal, BNODE).
 * @returns {NamedNode|null}
 */
function resolveNodeKind(type) {
  if (!type) return null;
  switch (type.toUpperCase()) {
    case "IRI":
    case "URI":
      return SH_IRI;
    case "LITERAL":
      return SH_LITERAL;
    case "BNODE":
      // sh:BlankNode exactly — emitting the looser sh:BlankNodeOrIRI
      // would not round-trip through the from-shacl importer.
      return SH_BLANK_NODE;
    default:
      return null;
  }
}

/**
 * Builds SHACL quads for a single property shape from a YAMA statement.
 *
 * @param {NamedNode} shapeNode  - Parent NodeShape.
 * @param {string}   stmtKey    - Statement key for warning messages.
 * @param {Object}   stmtDef    - Statement definition from the YAMA doc.
 * @param {Object}   namespaces - Prefix-to-IRI map.
 * @param {string}   base       - Document base IRI.
 * @param {Quad[]} quads - Accumulator.
 */
function buildPropertyShape(shapeNode, stmtKey, stmtDef, namespaces, base, quads) {
  const propertyIri = expandPrefixed(stmtDef.property, namespaces, base);
  if (!propertyIri) return;

  const propNode = blankNode();

  quads.push(quad(propNode, RDF_TYPE, SH_PROPERTY_SHAPE));
  quads.push(quad(shapeNode, SH_PROPERTY, propNode));
  quads.push(quad(propNode, SH_PATH, namedNode(propertyIri)));

  // sh:name from label
  if (stmtDef.label) {
    quads.push(quad(propNode, SH_NAME, literal(stmtDef.label)));
  }

  // sh:description from note
  if (stmtDef.note) {
    quads.push(quad(propNode, SH_DESCRIPTION, literal(stmtDef.note)));
  }

  // sh:minCount
  if (stmtDef.min != null) {
    quads.push(quad(propNode, SH_MIN_COUNT,
      literal(String(stmtDef.min), XSD_INTEGER)));
  }

  // sh:maxCount
  if (stmtDef.max != null) {
    quads.push(quad(propNode, SH_MAX_COUNT,
      literal(String(stmtDef.max), XSD_INTEGER)));
  }

  // sh:datatype is single-valued in SHACL, so multi-datatype becomes
  // sh:or of nested [sh:datatype X] blank nodes — the canonical SHACL
  // idiom for "datatype is one of". Mirrors the multi-shape sh:or
  // block below.
  const dts = datatypes(stmtDef);
  if (dts.length === 1) {
    const dtIri = expandPrefixed(dts[0], namespaces, base);
    quads.push(quad(propNode, SH_DATATYPE, namedNode(dtIri)));
  } else if (dts.length > 1) {
    const dtAnons = dts.map((dt) => {
      const anon = blankNode();
      const dtIri = expandPrefixed(dt, namespaces, base);
      quads.push(quad(anon, SH_DATATYPE, namedNode(dtIri)));
      return anon;
    });
    const listHead = buildRdfList(dtAnons, quads);
    quads.push(quad(propNode, SH_OR, listHead));
  }

  // sh:nodeKind (only when no datatype — datatype already implies
  // Literal). DCTAP/SRAP allow multiple node kinds (e.g. "IRI BNODE");
  // a single kind emits a flat sh:nodeKind, multiple kinds become a
  // sh:or of nested [sh:nodeKind X] blank nodes.
  if (dts.length === 0) {
    const kinds = nodeTypes(stmtDef)
      .map(resolveNodeKind)
      .filter((nk) => nk !== null);
    if (kinds.length === 1) {
      quads.push(quad(propNode, SH_NODE_KIND, kinds[0]));
    } else if (kinds.length > 1) {
      const nkAnons = kinds.map((nk) => {
        const anon = blankNode();
        quads.push(quad(anon, SH_NODE_KIND, nk));
        return anon;
      });
      const listHead = buildRdfList(nkAnons, quads);
      quads.push(quad(propNode, SH_OR, listHead));
    }
  }

  // sh:node — reference to another shape. Multi-shape becomes sh:or
  // with a list of nested sh:node blank nodes, following SHACL's
  // disjunction idiom.
  const refs = descRefs(stmtDef);
  if (refs.length === 1) {
    const refIri = base ? base + refs[0] : refs[0];
    quads.push(quad(propNode, SH_NODE, namedNode(refIri)));
  } else if (refs.length > 1) {
    const nodeAnons = refs.map((r) => {
      const anon = blankNode();
      const refIri = base ? base + r : r;
      quads.push(quad(anon, SH_NODE, namedNode(refIri)));
      return anon;
    });
    const listHead = buildRdfList(nodeAnons, quads);
    quads.push(quad(propNode, SH_OR, listHead));
  }

  // sh:class from statement-level class constraint (a). Multiple
  // classes mean "instance of one of" in YAMAML (SimpleDSP Table 17),
  // so the list form becomes sh:or of nested sh:class blank nodes.
  if (stmtDef.a) {
    const classes = Array.isArray(stmtDef.a) ? stmtDef.a : [stmtDef.a];
    if (classes.length === 1) {
      const classIri = expandPrefixed(classes[0], namespaces, base);
      quads.push(quad(propNode, SH_CLASS, namedNode(classIri)));
    } else if (classes.length > 1) {
      const classAnons = classes.map((c) => {
        const anon = blankNode();
        const classIri = expandPrefixed(c, namespaces, base);
        quads.push(quad(anon, SH_CLASS, namedNode(classIri)));
        return anon;
      });
      const listHead = buildRdfList(classAnons, quads);
      quads.push(quad(propNode, SH_OR, listHead));
    }
  }

  // Facets — numeric facets use xsd:decimal, length facets xsd:integer.
  // Length has no direct SHACL counterpart; sh:minLength + sh:maxLength
  // with the same value expresses it exactly. TotalDigits and
  // FractionDigits cannot be expressed in core SHACL.
  if (stmtDef.facets) {
    const f = stmtDef.facets;
    const numeric = [
      [f.MinInclusive, SH_MIN_INCLUSIVE],
      [f.MaxInclusive, SH_MAX_INCLUSIVE],
      [f.MinExclusive, SH_MIN_EXCLUSIVE],
      [f.MaxExclusive, SH_MAX_EXCLUSIVE],
    ];
    for (const [value, pred] of numeric) {
      if (value != null) {
        quads.push(quad(propNode, pred, literal(String(value), XSD_DECIMAL)));
      }
    }
    if (f.MinLength != null) {
      quads.push(quad(propNode, SH_MIN_LENGTH,
        literal(String(f.MinLength), XSD_INTEGER)));
    }
    if (f.MaxLength != null) {
      quads.push(quad(propNode, SH_MAX_LENGTH,
        literal(String(f.MaxLength), XSD_INTEGER)));
    }
    if (f.Length != null) {
      quads.push(quad(propNode, SH_MIN_LENGTH,
        literal(String(f.Length), XSD_INTEGER)));
      quads.push(quad(propNode, SH_MAX_LENGTH,
        literal(String(f.Length), XSD_INTEGER)));
    }
    if (f.TotalDigits != null || f.FractionDigits != null) {
      console.warn(
        `Warning: statement "${stmtKey}": TotalDigits/FractionDigits facets cannot be expressed in SHACL — dropped.`,
      );
    }
  }

  // sh:languageIn from languageTag (list of language tag strings)
  if (Array.isArray(stmtDef.languageTag) && stmtDef.languageTag.length > 0) {
    const items = stmtDef.languageTag.map((t) => literal(String(t)));
    const listHead = buildRdfList(items, quads);
    quads.push(quad(propNode, SH_LANGUAGE_IN, listHead));
  }

  // sh:pattern
  if (stmtDef.pattern) {
    quads.push(quad(propNode, SH_PATTERN, literal(stmtDef.pattern)));
  }

  // inScheme — SHACL has no vocabulary-scheme constraint, so each
  // scheme stem is approximated as an anchored sh:pattern on the IRI
  // string ("values start with the expanded namespace"). Multiple
  // schemes become sh:or of pattern blank nodes.
  if (stmtDef.inScheme) {
    const schemes = (Array.isArray(stmtDef.inScheme)
      ? stmtDef.inScheme
      : [stmtDef.inScheme]).map(normalizeScheme);
    if (!nodeTypes(stmtDef).includes("IRI")) {
      console.warn(
        `Warning: statement "${stmtKey}": inScheme on a non-IRI statement cannot be expressed in SHACL — dropped.`,
      );
    } else {
      // A scheme like "ndlsh:" expands to the bare namespace IRI
      // (empty local part); full URIs pass through unchanged.
      const stems = schemes.map((s) => expandPrefixed(s, namespaces, base));
      if (stems.length === 1) {
        quads.push(quad(propNode, SH_PATTERN,
          literal(`^${escapeRegex(stems[0])}`)));
      } else {
        const stemAnons = stems.map((stem) => {
          const anon = blankNode();
          quads.push(quad(anon, SH_PATTERN, literal(`^${escapeRegex(stem)}`)));
          return anon;
        });
        const listHead = buildRdfList(stemAnons, quads);
        quads.push(quad(propNode, SH_OR, listHead));
      }
    }
  }

  // sh:in (enumerated values) — IRI-typed statements get IRI terms
  // (CURIEs expanded through the resolution map), literal statements
  // get string literals. An IRI node can never equal a string literal,
  // so emitting literals for IRI values would be unsatisfiable.
  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    const isIriType = nodeTypes(stmtDef).includes("IRI");
    const items = [];
    for (const v of stmtDef.values) {
      if (isIriType) {
        const iri = expandPrefixed(String(v), namespaces, base);
        // Defensive: an IRI term containing whitespace serializes as
        // unparseable Turtle (`<http://… …>`) — warn and skip the
        // member rather than emit a broken shapes graph.
        if (/\s/.test(iri)) {
          console.warn(
            `Warning: statement "${stmtKey}": IRI value "${v}" contains whitespace — skipped from sh:in.`,
          );
          continue;
        }
        items.push(namedNode(iri));
      } else {
        items.push(literal(String(v)));
      }
    }
    if (items.length > 0) {
      const listHead = buildRdfList(items, quads);
      quads.push(quad(propNode, SH_IN, listHead));
    }
  }
}

/**
 * Builds the complete SHACL shapes graph from a parsed YAMA document.
 *
 * Each YAMA description becomes a `sh:NodeShape`. Descriptions with an
 * `a` (rdf:type) get a `sh:targetClass`. Each statement becomes a
 * `sh:PropertyShape` linked via `sh:property`.
 *
 * @param {Object} doc        - Parsed YAMA document.
 * @param {Object} namespaces - Prefix-to-IRI map.
 * @param {string} base       - Document base IRI.
 * @returns {Quad[]}
 */
function buildShaclQuads(doc, namespaces, base) {
  const quads = [];
  const descriptions = doc.descriptions || {};

  for (const [descName, descDef] of Object.entries(descriptions)) {
    const shapeIri = base ? base + descName : descName;
    const shapeNode = namedNode(shapeIri);

    // rdf:type sh:NodeShape
    quads.push(quad(shapeNode, RDF_TYPE, SH_NODE_SHAPE));

    // sh:targetClass from "a"
    if (descDef.a) {
      const classIri = expandPrefixed(descDef.a, namespaces, base);
      quads.push(quad(shapeNode, SH_TARGET_CLASS, namedNode(classIri)));
    }

    // sh:name from label
    if (descDef.label) {
      quads.push(quad(shapeNode, SH_NAME, literal(descDef.label)));
    }

    // sh:description from note
    if (descDef.note) {
      quads.push(quad(shapeNode, SH_DESCRIPTION, literal(descDef.note)));
    }

    // sh:closed + sh:ignoredProperties if description declares closed: true
    if (descDef.closed === true) {
      quads.push(quad(shapeNode, SH_CLOSED,
        literal("true", XSD_BOOLEAN)));
      const rdfTypeList = buildRdfList([RDF_TYPE], quads);
      quads.push(quad(shapeNode, SH_IGNORED_PROPERTIES, rdfTypeList));
    }

    // Property shapes from statements
    if (!descDef.statements) continue;

    for (const [stmtKey, stmtDef] of Object.entries(descDef.statements)) {
      buildPropertyShape(shapeNode, stmtKey, stmtDef, namespaces, base, quads);
    }
  }

  return quads;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a SHACL shapes graph from a YAMA file.
 *
 * Parses the YAMA document, builds SHACL quads, and serializes them
 * in the requested format (defaults to Turtle).
 *
 * @param {string} file           - Path to the YAMA input file.
 * @param {Object} [options]      - Output options.
 * @param {string} [options.output=""]  - Output file path; stdout if empty.
 * @param {string} [options.format="turtle"] - Serialization format.
 * @returns {Promise<void>}
 */
export async function generateSHACL(file, { output = "", format = "turtle" } = {}) {
  const doc = parseYaml(await readInput(file));

  // CURIEs resolve through the standard prefix table with user
  // declarations taking precedence (YAMAML §2.2). The output declares
  // the user's prefixes plus any standard ones that actually resolved.
  const userNamespaces = doc.namespaces || {};
  const resolutionNamespaces = { ...STANDARD_PREFIXES, ...userNamespaces };
  const base = doc.base || "";

  const quads = buildShaclQuads(doc, resolutionNamespaces, base);
  const outputNamespaces = {
    sh: SH,
    ...userNamespaces,
    ...collectUsedStandardPrefixes(quads, { sh: SH, ...userNamespaces }),
  };
  await serializeRdf(quads, outputNamespaces, base, output, format);
}
