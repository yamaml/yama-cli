/**
 * @fileoverview SHACL-to-YAMA reverse import.
 *
 * Parses a SHACL shapes graph (Turtle) using the N3 library and
 * reconstructs a YAMA application profile document.
 *
 * SHACL-to-YAMA mapping (inverse of {@link module:shacl}):
 *
 * | SHACL property          | YAMA element               |
 * |-------------------------|-----------------------------|
 * | sh:NodeShape            | description                 |
 * | sh:targetClass          | description.a               |
 * | sh:name (on shape)      | description.label           |
 * | sh:description (shape)  | description.note            |
 * | sh:closed               | description.closed          |
 * | sh:property             | statement (via PropertyShape)|
 * | sh:path                 | statement.property          |
 * | sh:name (on property)   | statement.label             |
 * | sh:description (prop)   | statement.note              |
 * | sh:minCount             | statement.min               |
 * | sh:maxCount             | statement.max               |
 * | sh:datatype             | statement.datatype          |
 * | sh:nodeKind sh:IRI      | statement.type = IRI        |
 * | sh:nodeKind sh:Literal  | statement.type = literal    |
 * | sh:nodeKind sh:BlankNodeOrIRI | statement.type = BNODE |
 * | sh:node                 | statement.description       |
 * | sh:class                | statement.a                 |
 * | sh:pattern              | statement.pattern           |
 * | sh:in                   | statement.values            |
 * | sh:minInclusive         | statement.facets.MinInclusive|
 * | sh:maxInclusive         | statement.facets.MaxInclusive|
 * | sh:minLength            | statement.facets.MinLength  |
 * | sh:maxLength            | statement.facets.MaxLength  |
 *
 * @module from-shacl
 * @see https://www.w3.org/TR/shacl/
 */

import { stringify as stringifyYaml } from "@std/yaml";
import N3 from "n3";
import { readInput } from "./io.js";

/**
 * @typedef {Quad} Quad
 */

// ---------------------------------------------------------------------------
// SHACL / RDF namespace constants
// ---------------------------------------------------------------------------

const SH = "http://www.w3.org/ns/shacl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// ---------------------------------------------------------------------------
// Quad-walking helpers
// ---------------------------------------------------------------------------

/**
 * Builds a lookup index from an array of quads.
 * Returns a Map: subject → predicate → [objects].
 *
 * @param {Quad[]} quads
 * @returns {Map<string, Map<string, string[]>>}
 */
function buildIndex(quads) {
  const index = new Map();

  for (const q of quads) {
    const s = q.subject.value;
    const p = q.predicate.value;
    const o = q.object.value;

    if (!index.has(s)) index.set(s, new Map());
    const pMap = index.get(s);
    if (!pMap.has(p)) pMap.set(p, []);
    pMap.get(p).push(o);
  }

  return index;
}

/**
 * Gets the first value for a subject-predicate pair, or null.
 *
 * @param {Map} index
 * @param {string} subject
 * @param {string} predicate
 * @returns {string|null}
 */
function getOne(index, subject, predicate) {
  const pMap = index.get(subject);
  if (!pMap) return null;
  const vals = pMap.get(predicate);
  return vals && vals.length > 0 ? vals[0] : null;
}

/**
 * Gets all values for a subject-predicate pair.
 *
 * @param {Map} index
 * @param {string} subject
 * @param {string} predicate
 * @returns {string[]}
 */
function getAll(index, subject, predicate) {
  const pMap = index.get(subject);
  if (!pMap) return [];
  return pMap.get(predicate) || [];
}

/**
 * Walks an RDF list (rdf:first/rdf:rest chain) and returns the values.
 *
 * @param {Map} index
 * @param {string} head - Blank node or rdf:nil.
 * @returns {string[]}
 */
function walkRdfList(index, head) {
  const items = [];
  let current = head;
  const visited = new Set();

  while (current && current !== `${RDF}nil`) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);

    const first = getOne(index, current, `${RDF}first`);
    if (first != null) items.push(first);

    current = getOne(index, current, `${RDF}rest`);
  }

  return items;
}

// ---------------------------------------------------------------------------
// IRI compacting
// ---------------------------------------------------------------------------

/**
 * Compacts a full IRI to a prefixed term using the namespace map.
 * Falls back to stripping the base IRI, or returns the full IRI.
 *
 * @param {string} iri
 * @param {Object} namespaces - Prefix-to-IRI map.
 * @param {string} base
 * @returns {string}
 */
function compactIRI(iri, namespaces, base) {
  if (!iri) return "";

  // Try namespace prefixes
  for (const [prefix, nsUri] of Object.entries(namespaces)) {
    if (iri.startsWith(nsUri)) {
      return `${prefix}:${iri.slice(nsUri.length)}`;
    }
  }

  // Try stripping base
  if (base && iri.startsWith(base)) {
    return iri.slice(base.length);
  }

  return iri;
}

/**
 * Extracts a local name from an IRI for use as a YAML key.
 *
 * @param {string} iri
 * @param {string} base
 * @returns {string}
 */
function localName(iri, base) {
  if (!iri) return "unknown";

  // Strip base first
  if (base && iri.startsWith(base)) {
    const local = iri.slice(base.length);
    if (local) return local;
  }

  // Extract fragment or last path segment
  const hashIdx = iri.lastIndexOf("#");
  if (hashIdx >= 0) return iri.slice(hashIdx + 1);

  const slashIdx = iri.lastIndexOf("/");
  if (slashIdx >= 0) return iri.slice(slashIdx + 1);

  return iri;
}

/**
 * Generates a statement key from a property IRI.
 * Extracts local name and deduplicates against existing keys.
 *
 * @param {string} propertyIRI
 * @param {Object} namespaces
 * @param {Set<string>} usedKeys
 * @returns {string}
 */
function toStatementKey(propertyIRI, namespaces, usedKeys) {
  let local = "";

  // Extract local name from prefixed or full IRI
  for (const [, nsUri] of Object.entries(namespaces)) {
    if (propertyIRI.startsWith(nsUri)) {
      local = propertyIRI.slice(nsUri.length);
      break;
    }
  }

  if (!local) {
    const hashIdx = propertyIRI.lastIndexOf("#");
    const slashIdx = propertyIRI.lastIndexOf("/");
    const idx = Math.max(hashIdx, slashIdx);
    local = idx >= 0 ? propertyIRI.slice(idx + 1) : propertyIRI;
  }

  // Ensure camelCase start
  let key = local.charAt(0).toLowerCase() + local.slice(1);

  // Deduplicate
  if (usedKeys.has(key)) {
    let suffix = 2;
    while (usedKeys.has(`${key}${suffix}`)) suffix++;
    key = `${key}${suffix}`;
  }

  usedKeys.add(key);
  return key;
}

// ---------------------------------------------------------------------------
// NodeKind mapping
// ---------------------------------------------------------------------------

/**
 * Maps a SHACL sh:nodeKind IRI to a YAMA type string.
 *
 * @param {string} nodeKindIRI
 * @returns {string|undefined}
 */
function fromNodeKind(nodeKindIRI) {
  switch (nodeKindIRI) {
    case `${SH}IRI`:
      return "IRI";
    case `${SH}Literal`:
      return "literal";
    case `${SH}BlankNode`:
    case `${SH}BlankNodeOrIRI`:
      return "BNODE";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parses SHACL Turtle input and builds a YAMA document.
 *
 * @param {string} turtleText - SHACL Turtle content.
 * @returns {Object} YAMA document with namespaces, base, and descriptions.
 */
function parseShaclToYama(turtleText) {
  const parser = new N3.Parser();
  const quads = parser.parse(turtleText);
  const index = buildIndex(quads);

  // Extract prefixes from the parser
  const parsedPrefixes = {};
  // N3 Parser stores prefixes internally; re-parse to get them
  const prefixParser = new N3.Parser();
  prefixParser.parse(turtleText, null, (prefix, ns) => {
    if (prefix && ns) {
      parsedPrefixes[prefix] = ns.value || ns;
    }
  });

  // Build namespace map, excluding SHACL and RDF (internal plumbing)
  const namespaces = {};
  for (const [prefix, uri] of Object.entries(parsedPrefixes)) {
    if (uri !== SH && uri !== RDF) {
      namespaces[prefix] = uri;
    }
  }

  // Determine base IRI from shape IRIs (common prefix of all NodeShapes)
  let base = "";
  const nodeShapeIRIs = [];

  for (const [subject, pMap] of index) {
    const types = pMap.get(`${RDF}type`) || [];
    if (types.includes(`${SH}NodeShape`)) {
      nodeShapeIRIs.push(subject);
    }
  }

  // Find common base from shape IRIs (if they share a common prefix path)
  if (nodeShapeIRIs.length > 0) {
    const firstIRI = nodeShapeIRIs[0];
    // Look for the last / or # before the local name
    const lastSep = Math.max(firstIRI.lastIndexOf("/"), firstIRI.lastIndexOf("#"));
    if (lastSep > 0) {
      const candidate = firstIRI.slice(0, lastSep + 1);
      // Only use it if all shapes share this prefix
      if (nodeShapeIRIs.every((iri) => iri.startsWith(candidate))) {
        base = candidate;
      }
    }
  }

  // Build descriptions from NodeShapes
  const descriptions = {};

  for (const shapeIRI of nodeShapeIRIs) {
    const name = localName(shapeIRI, base);
    const desc = {};

    // sh:targetClass → a
    const targetClass = getOne(index, shapeIRI, `${SH}targetClass`);
    if (targetClass) {
      desc.a = compactIRI(targetClass, namespaces, base);
    }

    // sh:name → label
    const shapeName = getOne(index, shapeIRI, `${SH}name`);
    if (shapeName) desc.label = shapeName;

    // sh:description → note
    const shapeDesc = getOne(index, shapeIRI, `${SH}description`);
    if (shapeDesc) desc.note = shapeDesc;

    // sh:closed → closed
    const closed = getOne(index, shapeIRI, `${SH}closed`);
    if (closed === "true") desc.closed = true;

    // Collect property shapes
    const propNodeIRIs = getAll(index, shapeIRI, `${SH}property`);
    if (propNodeIRIs.length > 0) {
      desc.statements = {};
      const usedKeys = new Set();

      for (const propNodeIRI of propNodeIRIs) {
        const path = getOne(index, propNodeIRI, `${SH}path`);
        if (!path) continue;

        const stmt = {};
        stmt.property = compactIRI(path, namespaces, base);

        // sh:name → label
        const propName = getOne(index, propNodeIRI, `${SH}name`);
        if (propName) stmt.label = propName;

        // sh:description → note
        const propDesc = getOne(index, propNodeIRI, `${SH}description`);
        if (propDesc) stmt.note = propDesc;

        // sh:minCount → min
        const minCount = getOne(index, propNodeIRI, `${SH}minCount`);
        if (minCount != null) stmt.min = parseInt(minCount, 10);

        // sh:maxCount → max
        const maxCount = getOne(index, propNodeIRI, `${SH}maxCount`);
        if (maxCount != null) stmt.max = parseInt(maxCount, 10);

        // sh:datatype → datatype
        const datatype = getOne(index, propNodeIRI, `${SH}datatype`);
        if (datatype) {
          stmt.datatype = compactIRI(datatype, namespaces, base);
        }

        // sh:nodeKind → type (only when no datatype)
        if (!datatype) {
          const nodeKind = getOne(index, propNodeIRI, `${SH}nodeKind`);
          if (nodeKind) {
            const yamaType = fromNodeKind(nodeKind);
            if (yamaType) stmt.type = yamaType;
          }
        }

        // sh:node → description (shape reference)
        const nodeRef = getOne(index, propNodeIRI, `${SH}node`);
        if (nodeRef) {
          stmt.description = localName(nodeRef, base);
        }

        // sh:class → a (class constraint on statement)
        const classRef = getOne(index, propNodeIRI, `${SH}class`);
        if (classRef) {
          stmt.a = compactIRI(classRef, namespaces, base);
        }

        // sh:pattern → pattern
        const pattern = getOne(index, propNodeIRI, `${SH}pattern`);
        if (pattern) stmt.pattern = pattern;

        // sh:in → values (RDF list)
        const inHead = getOne(index, propNodeIRI, `${SH}in`);
        if (inHead) {
          const listValues = walkRdfList(index, inHead);
          if (listValues.length > 0) stmt.values = listValues;
        }

        // Facets
        const facets = {};
        const minInc = getOne(index, propNodeIRI, `${SH}minInclusive`);
        if (minInc != null) facets.MinInclusive = Number(minInc);
        const maxInc = getOne(index, propNodeIRI, `${SH}maxInclusive`);
        if (maxInc != null) facets.MaxInclusive = Number(maxInc);
        const minLen = getOne(index, propNodeIRI, `${SH}minLength`);
        if (minLen != null) facets.MinLength = Number(minLen);
        const maxLen = getOne(index, propNodeIRI, `${SH}maxLength`);
        if (maxLen != null) facets.MaxLength = Number(maxLen);

        if (Object.keys(facets).length > 0) stmt.facets = facets;

        const key = toStatementKey(path, namespaces, usedKeys);
        desc.statements[key] = stmt;
      }
    }

    descriptions[name] = desc;
  }

  // Build final document
  const doc = {};
  if (base) doc.base = base;
  if (Object.keys(namespaces).length > 0) doc.namespaces = namespaces;
  doc.descriptions = descriptions;

  return doc;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Imports a SHACL Turtle file and converts it to YAMA YAML.
 *
 * @param {string} file     - Path to the SHACL Turtle input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function importSHACL(file, output) {
  const turtleText = await readInput(file);
  const doc = parseShaclToYama(turtleText);
  const yaml = stringifyYaml(doc, { lineWidth: -1 });

  if (output) {
    Deno.writeTextFileSync(output, yaml);
    console.error(`Written to ${output}`);
  } else {
    console.log(yaml);
  }
}
