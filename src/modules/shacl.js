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
 * | statement.type (BNODE)  | sh:nodeKind sh:BlankNodeOrIRI|
 * | statement.description   | sh:node (shape reference)    |
 * | statement.facets.MinInclusive | sh:minInclusive        |
 * | statement.facets.MaxInclusive | sh:maxInclusive        |
 * | statement.pattern       | sh:pattern                   |
 * | statement.values        | sh:in                        |
 *
 * @module shacl
 * @see https://www.w3.org/TR/shacl/
 */

import { parse as parseYaml } from "@std/yaml";
import N3 from "n3";
import { serializeRdf } from "./serialize.js";
import { readInput } from "./io.js";

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
const SH_MIN_INCLUSIVE    = namedNode(`${SH}minInclusive`);
const SH_MAX_INCLUSIVE    = namedNode(`${SH}maxInclusive`);
const SH_PATTERN          = namedNode(`${SH}pattern`);
const SH_IN               = namedNode(`${SH}in`);
const SH_IRI              = namedNode(`${SH}IRI`);
const SH_LITERAL          = namedNode(`${SH}Literal`);
const SH_BLANK_NODE_OR_IRI = namedNode(`${SH}BlankNodeOrIRI`);
const SH_CLOSED           = namedNode(`${SH}closed`);
const SH_IGNORED_PROPERTIES = namedNode(`${SH}ignoredProperties`);

const RDF_TYPE             = namedNode(`${RDF}type`);
const RDF_FIRST            = namedNode(`${RDF}first`);
const RDF_REST             = namedNode(`${RDF}rest`);
const RDF_NIL              = namedNode(`${RDF}nil`);

const XSD_INTEGER          = namedNode(`${XSD}integer`);
const XSD_DECIMAL          = namedNode(`${XSD}decimal`);
const XSD_BOOLEAN          = namedNode(`${XSD}boolean`);

// ---------------------------------------------------------------------------
// IRI helpers
// ---------------------------------------------------------------------------

/**
 * Expands a prefixed term (e.g. `foaf:name`) to a full IRI.
 *
 * @param {string} term
 * @param {Object} namespaces - Prefix-to-IRI map.
 * @param {string} base       - Fallback base IRI.
 * @returns {string|null} Full IRI, or null if term is falsy.
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

// ---------------------------------------------------------------------------
// RDF list builder
// ---------------------------------------------------------------------------

/**
 * Builds an RDF list (rdf:first/rdf:rest chain) from an array of RDF terms.
 *
 * @param {Term[]}  items - Terms to include in the list.
 * @param {Quad[]}  quads - Accumulator for generated quads.
 * @returns {BlankNode|NamedNode} Head of the list.
 */
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
      return SH_BLANK_NODE_OR_IRI;
    default:
      return null;
  }
}

/**
 * Builds SHACL quads for a single property shape from a YAMA statement.
 *
 * @param {NamedNode} shapeNode  - Parent NodeShape.
 * @param {Object}   stmtDef    - Statement definition from the YAMA doc.
 * @param {Object}   namespaces - Prefix-to-IRI map.
 * @param {string}   base       - Document base IRI.
 * @param {Quad[]} quads - Accumulator.
 */
function buildPropertyShape(shapeNode, stmtDef, namespaces, base, quads) {
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

  // sh:datatype
  if (stmtDef.datatype) {
    const dtIri = expandPrefixed(stmtDef.datatype, namespaces, base);
    quads.push(quad(propNode, SH_DATATYPE, namedNode(dtIri)));
  }

  // sh:nodeKind (only when no datatype — datatype already implies Literal)
  if (!stmtDef.datatype) {
    const nodeKind = resolveNodeKind(stmtDef.type);
    if (nodeKind) {
      quads.push(quad(propNode, SH_NODE_KIND, nodeKind));
    }
  }

  // sh:node — reference to another shape
  if (stmtDef.description) {
    const refIri = base ? base + stmtDef.description : stmtDef.description;
    quads.push(quad(propNode, SH_NODE, namedNode(refIri)));
  }

  // Facets
  if (stmtDef.facets) {
    if (stmtDef.facets.MinInclusive != null) {
      quads.push(quad(propNode, SH_MIN_INCLUSIVE,
        literal(String(stmtDef.facets.MinInclusive), XSD_DECIMAL)));
    }
    if (stmtDef.facets.MaxInclusive != null) {
      quads.push(quad(propNode, SH_MAX_INCLUSIVE,
        literal(String(stmtDef.facets.MaxInclusive), XSD_DECIMAL)));
    }
  }

  // sh:pattern
  if (stmtDef.pattern) {
    quads.push(quad(propNode, SH_PATTERN, literal(stmtDef.pattern)));
  }

  // sh:in (enumerated values)
  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    const items = stmtDef.values.map((v) => literal(String(v)));
    const listHead = buildRdfList(items, quads);
    quads.push(quad(propNode, SH_IN, listHead));
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

    for (const stmtDef of Object.values(descDef.statements)) {
      buildPropertyShape(shapeNode, stmtDef, namespaces, base, quads);
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

  const namespaces = {
    sh: SH,
    ...(doc.namespaces || {}),
  };
  const base = doc.base || "";

  const quads = buildShaclQuads(doc, namespaces, base);
  await serializeRdf(quads, namespaces, base, output, format);
}
