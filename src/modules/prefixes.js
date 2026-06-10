/**
 * @fileoverview Standard namespace prefix table and CURIE helpers.
 *
 * The SimpleDSP spec (§7) and YAMAML spec (§2.2) define a ten-entry
 * standard prefix table that processors consult as a fallback when a
 * prefixed name uses a prefix not declared in the document's
 * `namespaces` section. User declarations take precedence
 * unconditionally.
 *
 * Every RDF-emitting generator resolves CURIEs through
 * `{ ...STANDARD_PREFIXES, ...doc.namespaces }` and emits prefix
 * declarations for the user-declared prefixes plus any standard
 * prefixes that actually resolved into the output.
 *
 * @module prefixes
 */

// ── Standard prefix table (SimpleDSP §7 / YAMAML §2.2) ──

/**
 * The ten standard namespace prefixes. Nine from the original
 * SimpleDSP specification (Table 19) plus `schema:` as a YAMA
 * extension (Schema.org postdates the original spec).
 *
 * @type {Object<string, string>}
 */
export const STANDARD_PREFIXES = {
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

// ── CURIE expansion ──

/**
 * Expands a prefixed term (e.g. `foaf:name`) to a full IRI.
 *
 * Returns the term unchanged if it is already a full IRI.
 * Falls back to the document base for unprefixed local names.
 *
 * Callers are expected to pass a resolution map that already merges
 * the standard table with the user's declarations:
 * `{ ...STANDARD_PREFIXES, ...doc.namespaces }`.
 *
 * @param {string} term       - Prefixed name or full IRI.
 * @param {Object} namespaces - Prefix-to-IRI resolution map.
 * @param {string} base       - Fallback base IRI.
 * @returns {string|null} Full IRI, or null if `term` is falsy.
 */
export function expandPrefixed(term, namespaces, base) {
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

// ── Output prefix collection ──

/**
 * Returns the standard prefixes that actually resolved into a quad
 * array, so generators can declare them in the serialized output.
 *
 * A standard prefix qualifies when (a) the user did not declare the
 * same prefix label themselves, (b) no user declaration binds the
 * same IRI under a different label (the user's label wins), and
 * (c) at least one IRI in the quads — subject, predicate, object,
 * or literal datatype — starts with its namespace IRI.
 *
 * @param {Array} quads          - Generated RDF quads.
 * @param {Object} userNamespaces - The document's declared namespaces.
 * @returns {Object<string, string>} Standard prefixes used by the quads.
 */
export function collectUsedStandardPrefixes(quads, userNamespaces) {
  const userIris = new Set(Object.values(userNamespaces));
  const candidates = Object.entries(STANDARD_PREFIXES).filter(
    ([prefix, iri]) => !(prefix in userNamespaces) && !userIris.has(iri),
  );
  if (candidates.length === 0) return {};

  const iris = new Set();
  for (const q of quads) {
    for (const term of [q.subject, q.predicate, q.object]) {
      if (term.termType === "NamedNode") {
        iris.add(term.value);
      } else if (term.termType === "Literal" && term.datatype) {
        iris.add(term.datatype.value);
      }
    }
  }

  const used = {};
  for (const [prefix, ns] of candidates) {
    for (const iri of iris) {
      if (iri.startsWith(ns)) {
        used[prefix] = ns;
        break;
      }
    }
  }
  return used;
}
