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
 * | sh:nodeKind sh:BlankNode | statement.type = BNODE     |
 * | sh:nodeKind sh:BlankNodeOrIRI | statement.type = BNODE |
 * | sh:node                 | statement.description       |
 * | sh:class                | statement.a                 |
 * | sh:pattern              | statement.pattern           |
 * | sh:in                   | statement.values (IRI members as CURIEs) |
 * | sh:hasValue             | statement.values (single entry) |
 * | sh:languageIn           | statement.languageTag       |
 * | sh:minInclusive         | statement.facets.MinInclusive|
 * | sh:maxInclusive         | statement.facets.MaxInclusive|
 * | sh:minExclusive         | statement.facets.MinExclusive|
 * | sh:maxExclusive         | statement.facets.MaxExclusive|
 * | sh:minLength            | statement.facets.MinLength  |
 * | sh:maxLength            | statement.facets.MaxLength  |
 *
 * Shapes whose IRIs share the same local name (e.g. `ex1:Book` and
 * `ex2:Book`) are de-duplicated with a numeric suffix (`Book`,
 * `Book_2`, …) and a warning, instead of silently overwriting each
 * other. References resolve through the de-duplicated names.
 *
 * Constructs YAMA cannot express are reported on stderr instead of
 * vanishing: sh:uniqueLang, sh:qualifiedValueShape, sh:severity,
 * sh:message, sh:targetNode/targetSubjectsOf/targetObjectsOf,
 * shape-level sh:or/and/not, and non-IRI sh:path (sequence/inverse
 * paths).
 *
 * @module from-shacl
 * @see https://www.w3.org/TR/shacl/
 */

import { stringify as stringifyYaml } from "@std/yaml";
import N3 from "n3";
import { readInput, statusLog } from "./io.js";

/**
 * @typedef {Quad} Quad
 * @typedef {Term} Term
 */

// ---------------------------------------------------------------------------
// SHACL / RDF namespace constants
// ---------------------------------------------------------------------------

const SH = "http://www.w3.org/ns/shacl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

// ---------------------------------------------------------------------------
// Quad-walking helpers
// ---------------------------------------------------------------------------

/**
 * Builds a lookup index from an array of quads.
 * Returns a Map: subject value → predicate value → [object terms].
 *
 * Object *terms* (not just their string values) are stored so callers
 * can distinguish IRIs from literals — needed for sh:in members and
 * for rejecting blank-node sh:path values.
 *
 * @param {Quad[]} quads
 * @returns {Map<string, Map<string, Term[]>>}
 */
function buildIndex(quads) {
  const index = new Map();

  for (const q of quads) {
    const s = q.subject.value;
    const p = q.predicate.value;

    if (!index.has(s)) index.set(s, new Map());
    const pMap = index.get(s);
    if (!pMap.has(p)) pMap.set(p, []);
    pMap.get(p).push(q.object);
  }

  return index;
}

/**
 * Gets the first object term for a subject-predicate pair, or null.
 *
 * @param {Map} index
 * @param {string} subject
 * @param {string} predicate
 * @returns {Term|null}
 */
function getOneTerm(index, subject, predicate) {
  const pMap = index.get(subject);
  if (!pMap) return null;
  const vals = pMap.get(predicate);
  return vals && vals.length > 0 ? vals[0] : null;
}

/**
 * Gets the first object value for a subject-predicate pair, or null.
 *
 * @param {Map} index
 * @param {string} subject
 * @param {string} predicate
 * @returns {string|null}
 */
function getOne(index, subject, predicate) {
  const term = getOneTerm(index, subject, predicate);
  return term ? term.value : null;
}

/**
 * Gets all object values for a subject-predicate pair.
 *
 * @param {Map} index
 * @param {string} subject
 * @param {string} predicate
 * @returns {string[]}
 */
function getAll(index, subject, predicate) {
  const pMap = index.get(subject);
  if (!pMap) return [];
  return (pMap.get(predicate) || []).map((t) => t.value);
}

/**
 * Walks an RDF list (rdf:first/rdf:rest chain) and returns the member
 * terms in order.
 *
 * @param {Map} index
 * @param {string} head - Blank node or rdf:nil.
 * @returns {Term[]}
 */
function walkRdfListTerms(index, head) {
  const items = [];
  let current = head;
  const visited = new Set();

  while (current && current !== `${RDF}nil`) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);

    const first = getOneTerm(index, current, `${RDF}first`);
    if (first != null) items.push(first);

    current = getOne(index, current, `${RDF}rest`);
  }

  return items;
}

/**
 * Walks an RDF list and returns the member values.
 *
 * @param {Map} index
 * @param {string} head - Blank node or rdf:nil.
 * @returns {string[]}
 */
function walkRdfList(index, head) {
  return walkRdfListTerms(index, head).map((t) => t.value);
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
 * The generator emits sh:BlankNode for BNODE; the looser
 * sh:BlankNodeOrIRI from external files also imports as BNODE,
 * the closest YAMA type.
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
// Inexpressible-construct warnings
// ---------------------------------------------------------------------------

/** SHACL terms YAMA cannot express on a property shape. */
const UNSUPPORTED_PROPERTY_TERMS = [
  ["uniqueLang", "sh:uniqueLang"],
  ["qualifiedValueShape", "sh:qualifiedValueShape"],
  ["severity", "sh:severity"],
  ["message", "sh:message"],
];

/** SHACL terms YAMA cannot express on a node shape. */
const UNSUPPORTED_SHAPE_TERMS = [
  ["targetNode", "sh:targetNode"],
  ["targetSubjectsOf", "sh:targetSubjectsOf"],
  ["targetObjectsOf", "sh:targetObjectsOf"],
  ["or", "sh:or"],
  ["and", "sh:and"],
  ["not", "sh:not"],
  ["severity", "sh:severity"],
  ["message", "sh:message"],
];

/**
 * Warns about SHACL constructs on a subject that YAMA cannot express.
 *
 * @param {Map} index
 * @param {string} subject - Shape or property-shape IRI/blank node.
 * @param {Array<[string, string]>} terms - [localName, display] pairs.
 * @param {string} context - Human-readable owner ("shape X" / "property Y").
 */
function warnUnsupported(index, subject, terms, context) {
  for (const [local, display] of terms) {
    if (getOneTerm(index, subject, `${SH}${local}`) != null) {
      console.warn(
        `Warning: ${context}: ${display} cannot be expressed in YAMA — dropped.`,
      );
    }
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
    const types = (pMap.get(`${RDF}type`) || []).map((t) => t.value);
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

  // Assign description names up front, de-duplicating local-name
  // collisions (ex1:Book vs ex2:Book) with a numeric suffix instead
  // of letting the second shape overwrite the first. References
  // resolve through this map so they follow the renamed shapes.
  const nameByShape = new Map();
  const usedNames = new Set();
  for (const shapeIRI of nodeShapeIRIs) {
    let name = localName(shapeIRI, base);
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name}_${n}`)) n++;
      const unique = `${name}_${n}`;
      console.warn(
        `Warning: shape <${shapeIRI}> shares the local name "${name}" with another shape — imported as "${unique}".`,
      );
      name = unique;
    }
    usedNames.add(name);
    nameByShape.set(shapeIRI, name);
  }

  /** Resolves a shape reference IRI to its assigned description name. */
  function refName(iri) {
    return nameByShape.get(iri) ?? localName(iri, base);
  }

  // Build descriptions from NodeShapes
  const descriptions = {};

  for (const shapeIRI of nodeShapeIRIs) {
    const name = nameByShape.get(shapeIRI);
    const desc = {};

    warnUnsupported(index, shapeIRI, UNSUPPORTED_SHAPE_TERMS, `shape "${name}"`);

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
        const pathTerm = getOneTerm(index, propNodeIRI, `${SH}path`);
        if (!pathTerm) continue;

        // Sequence/inverse paths are blank nodes — emitting their N3
        // label as a property name would be garbage, so warn and skip.
        if (pathTerm.termType !== "NamedNode") {
          console.warn(
            `Warning: shape "${name}": sh:path is not an IRI (sequence/inverse path) — property skipped.`,
          );
          continue;
        }
        const path = pathTerm.value;

        const stmt = {};
        stmt.property = compactIRI(path, namespaces, base);

        warnUnsupported(
          index,
          propNodeIRI,
          UNSUPPORTED_PROPERTY_TERMS,
          `shape "${name}", property "${stmt.property}"`,
        );

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

        // sh:node → description (single shape reference)
        const nodeRef = getOne(index, propNodeIRI, `${SH}node`);
        if (nodeRef) {
          stmt.description = refName(nodeRef);
        }

        // sh:or with an RDF list of nested blank nodes can carry
        // either a multi-shape disjunction (sh:node) or a multi-
        // datatype union (sh:datatype) — both shapes are emitted by
        // the shacl.js generator. We import whichever the list
        // happens to contain.
        const orHead = getOne(index, propNodeIRI, `${SH}or`);
        if (orHead) {
          const entries = walkRdfList(index, orHead);
          const refs = [];
          const dts = [];
          for (const entry of entries) {
            const nestedNode = getOne(index, entry, `${SH}node`);
            if (nestedNode) refs.push(refName(nestedNode));
            const nestedDt = getOne(index, entry, `${SH}datatype`);
            if (nestedDt) dts.push(compactIRI(nestedDt, namespaces, base));
          }
          if (refs.length > 0) {
            stmt.description = refs.length === 1 ? refs[0] : refs;
          }
          if (dts.length > 0) {
            stmt.datatype = dts.length === 1 ? dts[0] : dts;
          }
        }

        // sh:class → a (class constraint on statement)
        const classRef = getOne(index, propNodeIRI, `${SH}class`);
        if (classRef) {
          stmt.a = compactIRI(classRef, namespaces, base);
        }

        // sh:pattern → pattern
        const pattern = getOne(index, propNodeIRI, `${SH}pattern`);
        if (pattern) stmt.pattern = pattern;

        // sh:in → values (RDF list). IRI members become CURIEs/IRIs
        // (the generator emits them as IRI terms for IRI-typed
        // statements); literal members import verbatim.
        const inHead = getOne(index, propNodeIRI, `${SH}in`);
        if (inHead) {
          const listTerms = walkRdfListTerms(index, inHead);
          if (listTerms.length > 0) {
            stmt.values = listTerms.map((t) =>
              t.termType === "NamedNode"
                ? compactIRI(t.value, namespaces, base)
                : t.value
            );
          }
        }

        // sh:hasValue → values with a single entry (the closest YAMA
        // equivalent: the value set containing exactly that value).
        const hasValueTerm = getOneTerm(index, propNodeIRI, `${SH}hasValue`);
        if (hasValueTerm) {
          const v = hasValueTerm.termType === "NamedNode"
            ? compactIRI(hasValueTerm.value, namespaces, base)
            : hasValueTerm.value;
          if (Array.isArray(stmt.values)) {
            if (!stmt.values.includes(v)) stmt.values.push(v);
          } else {
            stmt.values = [v];
          }
        }

        // sh:languageIn → languageTag (RDF list of language tags)
        const langHead = getOne(index, propNodeIRI, `${SH}languageIn`);
        if (langHead) {
          const tags = walkRdfList(index, langHead);
          if (tags.length > 0) stmt.languageTag = tags;
        }

        // Facets
        const facets = {};
        const facetMap = [
          ["minInclusive", "MinInclusive"],
          ["maxInclusive", "MaxInclusive"],
          ["minExclusive", "MinExclusive"],
          ["maxExclusive", "MaxExclusive"],
          ["minLength", "MinLength"],
          ["maxLength", "MaxLength"],
        ];
        for (const [shLocal, yamaFacet] of facetMap) {
          const value = getOne(index, propNodeIRI, `${SH}${shLocal}`);
          if (value != null) facets[yamaFacet] = Number(value);
        }

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
    statusLog(`Written to ${output}`);
  } else {
    console.log(yaml);
  }
}

export { parseShaclToYama };
