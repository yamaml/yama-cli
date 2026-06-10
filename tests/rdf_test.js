/**
 * @fileoverview Regression tests for the RDF instance-data generator.
 *
 * Audit findings covered: numeric record IDs matched via JSONata
 * variable bindings, no forced `@en` language tag, declared datatypes
 * kept, array source values fan out to one triple per element, S1
 * standard prefix fallback.
 */

import { assert, assertEquals } from "@std/assert";
import { generateRDF } from "../src/modules/rdf.js";
import { fixture, parseTurtle, quietly, withTempDir } from "./helpers.js";

const FOAF = "http://xmlns.com/foaf/0.1/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

async function rdfStore(name) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/out.ttl`;
    await quietly(() => generateRDF(fixture(name), { output: out }));
    const text = await Deno.readTextFile(out);
    return { text, store: parseTurtle(text) };
  });
}

Deno.test("rdf: numeric record IDs produce property triples", async () => {
  const { store } = await rdfStore("numeric-id.yaml");
  const names = store.getQuads(null, `${FOAF}name`, null, null);
  assertEquals(names.length, 2, "one foaf:name per record");
  const subjects = names.map((q) => q.subject.value).sort();
  assertEquals(subjects, [
    "http://example.org/data/1",
    "http://example.org/data/2",
  ]);
});

Deno.test("rdf: no forced @en, declared datatype kept", async () => {
  const { store } = await rdfStore("numeric-id.yaml");

  for (const q of store.getQuads(null, `${FOAF}name`, null, null)) {
    assertEquals(q.object.language, "", "no language tag");
    assertEquals(q.object.datatype.value, `${XSD}string`);
  }

  // undeclared datatype → plain literal (xsd:string in the RDF model,
  // no language tag)
  const plain = store.getQuads(null, "https://schema.org/description", null, null);
  assert(plain.length > 0);
  for (const q of plain) {
    assertEquals(q.object.language, "");
  }
});

Deno.test("rdf: array source values produce one triple per element", async () => {
  const { store } = await rdfStore("numeric-id.yaml");
  const tags = store.getQuads(
    "http://example.org/data/1",
    "http://purl.org/dc/terms/subject",
    null,
    null,
  );
  const values = tags.map((q) => q.object.value).sort();
  assertEquals(values, ["classic", "fiction"]);
});

Deno.test("rdf: S1 standard prefixes resolve (foaf undeclared)", async () => {
  const { text, store } = await rdfStore("numeric-id.yaml");
  const types = store.getQuads(
    null,
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    `${FOAF}Person`,
    null,
  );
  assertEquals(types.length, 2);
  assert(!text.includes("data/foaf:"), "no base-mangled CURIEs");
});

Deno.test("rdf: ID values with quotes cannot inject JSONata", async () => {
  await withTempDir(async (dir) => {
    const profile = `${dir}/p.yaml`;
    await Deno.writeTextFile(
      profile,
      [
        "base: http://example.org/data/",
        "data:",
        '  - id: \'x" or 1=1\'',
        "    name: Mallory",
        "descriptions:",
        "  person:",
        "    id:",
        "      mapping: { source: data, path: id }",
        "    statements:",
        "      name:",
        "        property: foaf:name",
        "        mapping: { source: data, path: name }",
      ].join("\n"),
    );
    const out = `${dir}/out.ttl`;
    // The old string-interpolated filter threw a JSONata syntax error
    // on the embedded quote; the bound variable matches it literally.
    await quietly(() => generateRDF(profile, { output: out }));
    const text = await Deno.readTextFile(out);
    // (The subject IRI itself is not valid Turtle here — IRI character
    // validation is a separate concern — so assert on the text.)
    assertEquals(text.match(/"Mallory"/g)?.length, 1);
  });
});
