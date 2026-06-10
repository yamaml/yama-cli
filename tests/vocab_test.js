/**
 * @fileoverview Regression tests for the vocabulary generator.
 *
 * Audit finding covered: rdfs:domain accumulation — multiple domains
 * are intersected under RDFS semantics, so the generator emits the
 * first domain only, matching the range behaviour.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateVocab } from "../src/modules/vocab.js";
import { fixture, parseTurtle, quietly, withTempDir } from "./helpers.js";

const RDFS = "http://www.w3.org/2000/01/rdf-schema#";

Deno.test("vocab: shared property gets a single rdfs:domain (first wins)", async () => {
  await withTempDir(async (dir) => {
    const out = `${dir}/vocab.ttl`;
    await quietly(() => generateVocab(fixture("shared-property.yaml"), { output: out }));
    const text = await Deno.readTextFile(out);
    const store = parseTurtle(text);

    const domains = store.getQuads(
      "https://schema.org/name",
      `${RDFS}domain`,
      null,
      null,
    );
    assertEquals(domains.length, 1, "exactly one rdfs:domain");
    assertEquals(domains[0].object.value, "https://schema.org/Book");

    // standard prefixes used by the quads are declared
    assertStringIncludes(text, "@prefix schema:");
    assert(!text.includes("ap#schema:"), "no base-mangled CURIEs");
  });
});
