/**
 * @fileoverview RDF vocabulary/ontology generation from YAMA files.
 *
 * Generates a standalone RDF vocabulary definition from a YAMA profile:
 *
 *   - Each description's `a` (targetClass) becomes an `owl:Class` definition
 *   - Each statement's `property` becomes an `rdf:Property` definition
 *     (or `owl:ObjectProperty` / `owl:DatatypeProperty`)
 *   - Labels from description/statement labels become `rdfs:label`
 *   - Notes become `rdfs:comment`
 *   - Domain from which description uses the property becomes `rdfs:domain`
 *   - Range from datatype/class becomes `rdfs:range`
 *
 * Unlike `yama rdf` (instance data) or `yama dsp` (OWL-DSP meta-descriptions),
 * this outputs the vocabulary terms themselves as an ontology fragment.
 *
 * @module vocab
 */

import { parse as parseYaml } from "@std/yaml";
import N3 from "n3";
import { serializeRdf } from "./serialize.js";
import { descRefs, readInput } from "./io.js";

const { DataFactory } = N3;
const { namedNode, literal, quad } = DataFactory;

/**
 * @typedef {Quad} Quad
 */

// ---------------------------------------------------------------------------
// Namespace constants
// ---------------------------------------------------------------------------

const OWL = "http://www.w3.org/2002/07/owl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const OWL_CLASS = namedNode(`${OWL}Class`);
const OWL_OBJECT_PROPERTY = namedNode(`${OWL}ObjectProperty`);
const OWL_DATATYPE_PROPERTY = namedNode(`${OWL}DatatypeProperty`);

const RDF_TYPE = namedNode(`${RDF}type`);

const RDFS_LABEL = namedNode(`${RDFS}label`);
const RDFS_COMMENT = namedNode(`${RDFS}comment`);
const RDFS_DOMAIN = namedNode(`${RDFS}domain`);
const RDFS_RANGE = namedNode(`${RDFS}range`);

// ---------------------------------------------------------------------------
// Standard prefix table
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

// ---------------------------------------------------------------------------
// Vocabulary quad builder
// ---------------------------------------------------------------------------

/**
 * Determines whether a statement describes a literal or object value.
 *
 * @param {Object} stmtDef - Statement definition.
 * @returns {"datatype"|"object"|"unknown"}
 */
function resolvePropertyType(stmtDef) {
  const type = (stmtDef.type || "").toUpperCase();

  // Explicit IRI/URI type or structured reference → object property
  if (type === "IRI" || type === "URI") return "object";
  if (descRefs(stmtDef).length > 0) return "object";
  if (stmtDef.a) return "object";

  // Explicit literal type or datatype → datatype property
  if (type === "LITERAL") return "datatype";
  if (stmtDef.datatype) return "datatype";

  return "unknown";
}

/**
 * Builds the RDF vocabulary quads from a parsed YAMA document.
 *
 * For each description:
 *   - If desc.a exists: emit targetClass as owl:Class with rdfs:label
 *
 * For each statement:
 *   - Emit property as owl:DatatypeProperty or owl:ObjectProperty
 *   - rdfs:label from statement label
 *   - rdfs:comment from statement note
 *   - rdfs:domain from the description's class
 *   - rdfs:range from datatype or referenced class
 *
 * Properties that appear in multiple descriptions get merged domains
 * (first occurrence wins to keep output clean; additional domains are
 * added only if distinct).
 *
 * @param {Object} doc        - Parsed YAMA document.
 * @param {Object} namespaces - Prefix-to-IRI map.
 * @param {string} base       - Document base IRI.
 * @returns {Quad[]}
 */
function buildVocabQuads(doc, namespaces, base) {
  const quads = [];
  const descriptions = doc.descriptions || {};

  // Track emitted classes and properties to avoid duplicates
  const emittedClasses = new Set();
  const emittedProperties = new Map();

  // --- Pass 1: Emit classes ---
  for (const [, descDef] of Object.entries(descriptions)) {
    if (!descDef.a) continue;

    const classIri = expandPrefixed(descDef.a, namespaces, base);
    if (!classIri || emittedClasses.has(classIri)) continue;
    emittedClasses.add(classIri);

    const classNode = namedNode(classIri);

    quads.push(quad(classNode, RDF_TYPE, OWL_CLASS));

    if (descDef.label) {
      quads.push(quad(classNode, RDFS_LABEL, literal(descDef.label)));
    }
    if (descDef.note) {
      quads.push(quad(classNode, RDFS_COMMENT, literal(descDef.note)));
    }
  }

  // --- Pass 2: Emit properties ---
  for (const [, descDef] of Object.entries(descriptions)) {
    const domainIri = descDef.a
      ? expandPrefixed(descDef.a, namespaces, base)
      : null;

    const statements = descDef.statements || {};

    for (const [stmtKey, stmtDef] of Object.entries(statements)) {
      const propertyIri = expandPrefixed(stmtDef.property, namespaces, base);
      if (!propertyIri) continue;

      const propNode = namedNode(propertyIri);
      const propType = resolvePropertyType(stmtDef);

      let record = emittedProperties.get(propertyIri);

      if (!record) {
        // First time seeing this property — emit type and metadata
        record = { typed: false, labeled: false, commented: false, domains: new Set() };
        emittedProperties.set(propertyIri, record);

        // rdf:type
        if (propType === "datatype") {
          quads.push(quad(propNode, RDF_TYPE, OWL_DATATYPE_PROPERTY));
        } else if (propType === "object") {
          quads.push(quad(propNode, RDF_TYPE, OWL_OBJECT_PROPERTY));
        } else {
          quads.push(quad(propNode, RDF_TYPE, OWL_DATATYPE_PROPERTY));
        }
        record.typed = true;

        // rdfs:label (from statement label or key)
        const label = stmtDef.label || stmtKey;
        if (label) {
          quads.push(quad(propNode, RDFS_LABEL, literal(label)));
          record.labeled = true;
        }

        // rdfs:comment
        if (stmtDef.note) {
          quads.push(quad(propNode, RDFS_COMMENT, literal(stmtDef.note)));
          record.commented = true;
        }

        // rdfs:range
        if (stmtDef.datatype) {
          // Literal datatype range (take the first if space-separated)
          const datatypes = stmtDef.datatype.split(/\s+/).filter(Boolean);
          const dtIri = expandPrefixed(datatypes[0], namespaces, base);
          if (dtIri) {
            quads.push(quad(propNode, RDFS_RANGE, namedNode(dtIri)));
          }
        } else if (descRefs(stmtDef).length > 0) {
          // Structured reference to another description's class.
          // For multi-shape disjunctions the vocab's rdfs:range
          // collapses to the first ref's class — vocabularies are
          // conjunctive by design, so we don't emit union ranges here.
          const firstRef = descRefs(stmtDef)[0];
          const refDesc = descriptions[firstRef];
          if (refDesc?.a) {
            const refClassIri = expandPrefixed(refDesc.a, namespaces, base);
            if (refClassIri) {
              quads.push(quad(propNode, RDFS_RANGE, namedNode(refClassIri)));
            }
          }
        } else if (stmtDef.a) {
          // Class constraint on statement (e.g. foaf:Agent)
          const classes = Array.isArray(stmtDef.a) ? stmtDef.a : [stmtDef.a];
          const rangeIri = expandPrefixed(classes[0], namespaces, base);
          if (rangeIri) {
            quads.push(quad(propNode, RDFS_RANGE, namedNode(rangeIri)));
          }
        }
      }

      // rdfs:domain (emit for each distinct domain class)
      if (domainIri && !record.domains.has(domainIri)) {
        quads.push(quad(propNode, RDFS_DOMAIN, namedNode(domainIri)));
        record.domains.add(domainIri);
      }
    }
  }

  return quads;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates an RDF vocabulary from a YAMA file.
 *
 * Builds class and property definitions from the profile descriptions
 * and serializes them in the requested format (defaults to Turtle).
 *
 * @param {string} file           - Path to the YAMA input file.
 * @param {Object} [options]      - Output options.
 * @param {string} [options.output=""]  - Output file path; stdout if empty.
 * @param {string} [options.format="turtle"] - Serialization format.
 * @returns {Promise<void>}
 */
export async function generateVocab(file, { output = "", format = "turtle" } = {}) {
  const doc = parseYaml(await readInput(file));

  // Resolution namespaces include standard fallbacks for CURIE expansion,
  // but the output prefix map contains only what the user declared.
  // Standard prefixes are never eagerly added to output — the user's
  // namespaces block is authoritative.
  const userNamespaces = doc.namespaces || {};
  const resolutionNamespaces = { ...STANDARD_PREFIXES, ...userNamespaces };
  const base = doc.base || "";

  const quads = buildVocabQuads(doc, resolutionNamespaces, base);
  await serializeRdf(quads, userNamespaces, base, output, format);
}
