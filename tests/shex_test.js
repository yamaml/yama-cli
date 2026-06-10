/**
 * @fileoverview Regression tests for the ShEx generator.
 *
 * Audit findings covered: S1 (PREFIX lines for every referenced
 * prefix), S2 (`/pattern/` with escaped slashes), S3 (cardinality
 * semantics), S4 (IRI value sets / literal escaping), CLOSED gap,
 * inScheme stems, languageTag value sets, full-IRI angle brackets,
 * URI alias → IRI, untyped statements stay unconstrained (`.`),
 * absolute shape IRIs.
 */

import { assert, assertMatch, assertStringIncludes } from "@std/assert";
import { generateShEx } from "../src/modules/shex.js";
import { captureWarnings, fixture, quietly, withTempDir } from "./helpers.js";

/** Generates ShExC text for a fixture file. */
async function shex(name) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/schema.shex`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateShEx(fixture(name), out))
    );
    return { text: await Deno.readTextFile(out), warnings };
  });
}

/** Generates ShExC from inline YAML. */
async function shexFromYaml(yamlText) {
  return await withTempDir(async (dir) => {
    const profile = `${dir}/p.yaml`;
    await Deno.writeTextFile(profile, yamlText);
    const out = `${dir}/schema.shex`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateShEx(profile, out))
    );
    return { text: await Deno.readTextFile(out), warnings };
  });
}

Deno.test("shex: S1 every referenced prefix has a PREFIX line", async () => {
  const { text } = await shex("kitchen-sink.yaml");

  const declared = new Set(
    [...text.matchAll(/^PREFIX ([\w-]+): </gm)].map((m) => m[1]),
  );
  // Collect prefixes referenced in the shape bodies (skip comments,
  // PREFIX lines, IRIs in angle brackets, and string literals).
  const body = text
    .split("\n")
    .filter((l) => !l.startsWith("#") && !l.startsWith("PREFIX"))
    .join("\n")
    .replace(/<[^>]*>/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, "");
  const used = new Set(
    [...body.matchAll(/(?:^|[\s([@])([A-Za-z][\w-]*):/g)].map((m) => m[1]),
  );
  for (const prefix of used) {
    assert(declared.has(prefix), `prefix "${prefix}" used but not declared`);
  }
  // standard prefixes that resolved must be declared
  assert(declared.has("xsd"), "xsd declared");
  assert(declared.has("dcterms"), "dcterms declared");
});

Deno.test("shex: S2 pattern emits /…/ with literal slash escaped", async () => {
  const { text } = await shex("kitchen-sink.yaml");
  assertStringIncludes(text, "/^\\d{4}\\/\\d{3}$/");
  assert(!text.includes("//^"), "no double-slash pattern delimiters");
});

Deno.test("shex: S3 cardinality follows YAMAML semantics", async () => {
  const { text } = await shexFromYaml(`
namespaces:
  ex: http://example.org/vocab#
descriptions:
  MAIN:
    statements:
      none:
        property: ex:none
      maxOnly:
        property: ex:maxOnly
        max: 1
      exactlyOne:
        property: ex:exactlyOne
        min: 1
        max: 1
      range:
        property: ex:range
        min: 2
        max: 5
      atLeastTwo:
        property: ex:atLeastTwo
        min: 2
`);
  // absent min and max = unconstrained, not exactly-one
  assertMatch(text, /ex:none \. \*/);
  // max without min = optional, not mandatory {1}
  assertMatch(text, /ex:maxOnly \. \?/);
  // 1..1 = no marker
  assertMatch(text, /ex:exactlyOne \. ;/);
  assertMatch(text, /ex:range \. \{2,5\}/);
  assertMatch(text, /ex:atLeastTwo \. \{2,\}/);
});

Deno.test("shex: S4 IRI value sets are IRI terms, literals escaped", async () => {
  const { text } = await shex("kitchen-sink.yaml");
  // IRI-typed values: full IRI in angle brackets, CURIE kept prefixed
  assertStringIncludes(
    text,
    "[<http://creativecommons.org/licenses/by/4.0/> ex:custom]",
  );
  // literal values: quotes escaped
  assertStringIncludes(text, '["print" "e\\"book"]');
});

Deno.test("shex: CLOSED shapes and absolute shape IRIs", async () => {
  const { text } = await shex("kitchen-sink.yaml");
  assertStringIncludes(text, "<http://example.org/ap#book> EXTRA a CLOSED {");
  // shape references are absolute too
  assertStringIncludes(
    text,
    "(@<http://example.org/ap#person> OR @<http://example.org/ap#org>)",
  );
  assert(!text.includes("BASE <"), "no BASE+relative resolution");
});

Deno.test("shex: inScheme emits IRI stem in a value set", async () => {
  const { text } = await shex("kitchen-sink.yaml");
  assertStringIncludes(text, "[skos:~]");
});

Deno.test("shex: languageTag emits language value set", async () => {
  const { text } = await shex("kitchen-sink.yaml");
  assertStringIncludes(text, "[@en @ja]");
});

Deno.test("shex: untyped statements emit wildcard, not LITERAL", async () => {
  const { text } = await shex("kitchen-sink.yaml");
  assertMatch(text, /ex:misc \. \*/);
});

Deno.test("shex: full-IRI predicates get angle brackets, URI alias → IRI", async () => {
  const { text } = await shexFromYaml(`
descriptions:
  MAIN:
    a: http://example.org/vocab#Thing
    statements:
      raw:
        property: http://example.org/vocab#raw
        type: URI
`);
  assertStringIncludes(text, "a [<http://example.org/vocab#Thing>]");
  assertStringIncludes(text, "<http://example.org/vocab#raw> IRI");
  assert(!/\sURI\s/.test(text), "no bare URI node kind token");
});

Deno.test("shex: values combine with datatype via AND", async () => {
  const { text } = await shexFromYaml(`
namespaces:
  ex: http://example.org/vocab#
descriptions:
  MAIN:
    statements:
      status:
        property: ex:status
        type: literal
        datatype: xsd:string
        values:
          - draft
          - final
`);
  assertStringIncludes(text, 'xsd:string AND ["draft" "final"]');
});

Deno.test("shex: facets on a datatype disjunction join as a separate AND group", async () => {
  const { text } = await shexFromYaml(`
namespaces:
  ex: http://example.org/vocab#
descriptions:
  MAIN:
    statements:
      num:
        property: ex:num
        type: literal
        datatype:
          - xsd:integer
          - xsd:decimal
        facets:
          MinInclusive: 1
`);
  assertStringIncludes(
    text,
    "ex:num (xsd:integer OR xsd:decimal) AND MinInclusive 1",
  );
});

Deno.test("shex: whitespace in an IRI value warns and is skipped from the value set", async () => {
  const { text, warnings } = await shexFromYaml(`
namespaces:
  bibo: http://purl.org/ontology/bibo/
descriptions:
  MAIN:
    statements:
      class:
        property: rdf:type
        type: IRI
        values:
          - "bibo:Periodical bibo:Journal"
          - bibo:Book
`);
  assert(
    warnings.some((w) => w.includes("rdf:type") && w.includes("whitespace")),
    `expected whitespace warning, got: ${warnings.join("; ")}`,
  );
  assertStringIncludes(text, "[bibo:Book]");
  assert(!text.includes("bibo:Periodical"), "malformed member dropped");
});
