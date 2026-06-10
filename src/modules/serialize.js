/**
 * @fileoverview Shared RDF serialization for YAMAML outputs.
 *
 * Provides multi-format RDF serialization used by both the RDF generator
 * and the SHACL generator. Supports Turtle, N-Triples, N-Quads, TriG,
 * N3, and JSON-LD.
 *
 * @module serialize
 */

import N3 from "n3";
import { writeStdoutSync } from "./io.js";

/**
 * @typedef {Quad} Quad
 */

/** Full IRI for xsd:string (used by JSON-LD serializer). */
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

/** Full IRI for rdf:type. */
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * Maps user-facing format names and aliases to N3.Writer format strings.
 *
 * The special value `"jsonld"` is handled by a custom serializer since
 * N3.Writer does not support JSON-LD natively.
 *
 * @type {Object<string, string>}
 */
export const FORMAT_MAP = {
  turtle: "Turtle",
  ttl: "Turtle",
  ntriples: "N-Triples",
  nt: "N-Triples",
  nquads: "N-Quads",
  nq: "N-Quads",
  trig: "TriG",
  n3: "N3",
  jsonld: "jsonld",
};

/** Format names for display in CLI help text. */
export const SUPPORTED_FORMATS = Object.keys(FORMAT_MAP);

/**
 * Converts quads to a JSON-LD document.
 *
 * Builds a flat JSON-LD structure grouped by subject, with a `@context`
 * derived from the document namespaces.
 *
 * @param {Quad[]} quads
 * @param {Object}              namespaces
 * @param {string}              base
 * @returns {string} Pretty-printed JSON-LD string.
 */
function quadsToJsonLd(quads, namespaces, base) {
  const context = { ...namespaces };
  if (base) context["@base"] = base;

  const subjects = new Map();

  for (const q of quads) {
    // Blank-node subjects need the `_:` prefix in JSON-LD — a bare
    // N3 label like "n3-0" would be read as a relative IRI and
    // disconnect the graph from objects that reference "_:n3-0".
    const sid = q.subject.termType === "BlankNode"
      ? `_:${q.subject.value}`
      : q.subject.value;
    if (!subjects.has(sid)) {
      subjects.set(sid, { "@id": sid });
    }
    const node = subjects.get(sid);
    const pred = q.predicate.value;

    let value;
    if (q.object.termType === "NamedNode") {
      value = { "@id": q.object.value };
    } else if (q.object.termType === "BlankNode") {
      value = { "@id": `_:${q.object.value}` };
    } else {
      if (q.object.language) {
        value = { "@value": q.object.value, "@language": q.object.language };
      } else if (q.object.datatype && q.object.datatype.value !== XSD_STRING) {
        value = { "@value": q.object.value, "@type": q.object.datatype.value };
      } else {
        value = q.object.value;
      }
    }

    if (pred === RDF_TYPE) {
      const existing = node["@type"];
      if (existing) {
        node["@type"] = [].concat(existing, q.object.value);
      } else {
        node["@type"] = q.object.value;
      }
    } else {
      if (node[pred]) {
        node[pred] = [].concat(node[pred], value);
      } else {
        node[pred] = value;
      }
    }
  }

  const doc = {
    "@context": context,
    "@graph": [...subjects.values()],
  };

  return JSON.stringify(doc, null, 2);
}

/**
 * Serializes quads to the requested RDF format and writes the result.
 *
 * For JSON-LD, builds the document directly via {@link quadsToJsonLd}.
 * For all other formats, delegates to N3.Writer.
 *
 * @param {Quad[]} quads      - RDF quads to serialize.
 * @param {Object}              namespaces - Prefix-to-IRI map for output.
 * @param {string}              base       - Base IRI for the document.
 * @param {string}              output     - File path, or empty for stdout.
 * @param {string}              format     - User-facing format name.
 * @returns {Promise<void>}
 * @throws {Error} If the format is not recognized.
 */
export function serializeRdf(quads, namespaces, base, output, format) {
  const key = format.toLowerCase();

  if (!FORMAT_MAP[key]) {
    throw new Error(
      `Unknown format "${format}". Supported: ${SUPPORTED_FORMATS.join(", ")}`,
    );
  }

  if (FORMAT_MAP[key] === "jsonld") {
    const result = quadsToJsonLd(quads, namespaces, base);
    if (output) {
      Deno.writeTextFileSync(output, result);
      console.error(`Written to ${output}`);
    } else {
      writeStdoutSync(new TextEncoder().encode(result));
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const n3Format = FORMAT_MAP[key];
    // Omit baseIRI to prevent ugly relative URIs in Turtle output.
    // Prefixes handle abbreviation correctly without it.
    const writer = new N3.Writer({
      format: n3Format,
      prefixes: namespaces,
    });

    for (const q of quads) {
      writer.addQuad(q);
    }

    writer.end((error, result) => {
      if (error) return reject(error);

      // Exceptions thrown inside this callback are swallowed by the
      // N3 writer, leaving the promise unsettled — reject explicitly.
      try {
        if (output) {
          Deno.writeTextFileSync(output, result);
          console.error(`Written to ${output}`);
        } else {
          writeStdoutSync(new TextEncoder().encode(result));
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}
