/**
 * @fileoverview Scaffold a new YAMA YAML file.
 *
 * Generates a starter profile with namespaces, a base URI, and a
 * single placeholder description shape.  Used by `yama init`.
 *
 * @module init
 */

import { stringify as yamlStringify } from "@std/yaml";
import { statusLog } from "./io.js";

/**
 * Well-known namespace prefix → URI mappings.
 *
 * @type {Record<string, string>}
 */
const KNOWN_PREFIXES = {
  schema: "https://schema.org/",
  dcterms: "http://purl.org/dc/terms/",
  dc: "http://purl.org/dc/elements/1.1/",
  foaf: "http://xmlns.com/foaf/0.1/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dcat: "http://www.w3.org/ns/dcat#",
  prov: "http://www.w3.org/ns/prov#",
  org: "http://www.w3.org/ns/org#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
};

/**
 * Build the default placeholder description that every scaffolded
 * profile starts with.
 *
 * @param {string[]} prefixes - Resolved namespace prefixes.
 * @returns {{ MAIN: object }}
 */
function buildDefaultDescription(prefixes) {
  const hasSchema = prefixes.includes("schema");
  const hasDcterms = prefixes.includes("dcterms");

  const main = {
    a: hasSchema ? "schema:Thing" : "rdfs:Class",
    statements: {
      title: {
        label: "Title",
        property: hasDcterms ? "dcterms:title" : (hasSchema ? "schema:name" : "rdfs:label"),
        min: 1,
        max: 1,
        type: "literal",
        datatype: "xsd:string",
      },
    },
  };

  return { MAIN: main };
}

/**
 * Scaffold a new YAMA YAML file.
 *
 * @param {object}  opts
 * @param {string}  [opts.output]  - Output file path (stdout if omitted).
 * @param {string}  [opts.name]    - Profile name.
 * @param {string}  [opts.ns]      - Comma-separated namespace prefixes.
 * @param {string}  [opts.base]    - Base URI.
 */
export async function scaffoldProject(opts = {}) {
  const name = opts.name || "My Profile";
  const base = opts.base || undefined;

  // Resolve namespace prefixes
  const prefixList = opts.ns
    ? opts.ns.split(",").map((s) => s.trim()).filter(Boolean)
    : ["schema", "dcterms"];

  const namespaces = {};
  for (const prefix of prefixList) {
    const uri = KNOWN_PREFIXES[prefix];
    if (!uri) {
      throw new Error(
        `Unknown namespace prefix "${prefix}". Known: ${Object.keys(KNOWN_PREFIXES).join(", ")}`,
      );
    }
    namespaces[prefix] = uri;
  }

  // Assemble the profile object in key order
  const profile = {};
  profile.name = name;
  if (base) profile.base = base;
  profile.namespaces = namespaces;
  profile.descriptions = buildDefaultDescription(prefixList);

  // Serialize to YAML
  const yaml = yamlStringify(profile, { lineWidth: -1 });

  if (opts.output) {
    await Deno.writeTextFile(opts.output, yaml);
    statusLog(`Created ${opts.output}`);
  } else {
    console.log(yaml);
  }
}
