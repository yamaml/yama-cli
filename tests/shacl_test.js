/**
 * @fileoverview Regression tests for the SHACL generator.
 *
 * Audit findings covered: S1 (standard prefix fallback), S4 (IRI
 * value sets), sh:class gap, additional facets gap, languageTag →
 * sh:languageIn, inScheme → anchored sh:pattern.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateSHACL } from "../src/modules/shacl.js";
import {
  captureWarnings,
  fixture,
  parseTurtle,
  quietly,
  rdfList,
  withTempDir,
} from "./helpers.js";

const SH = "http://www.w3.org/ns/shacl#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const DCT = "http://purl.org/dc/terms/";

/** Generates SHACL Turtle for a fixture and parses it into a store. */
async function shaclStore(name) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/shacl.ttl`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateSHACL(fixture(name), { output: out }))
    );
    const text = await Deno.readTextFile(out);
    return { text, store: parseTurtle(text), warnings };
  });
}

/** Finds the property shape node for a given sh:path IRI. */
function propShape(store, pathIri) {
  for (const q of store.getQuads(null, `${SH}path`, null, null)) {
    if (q.object.value === pathIri) return q.subject;
  }
  return null;
}

Deno.test("shacl: S1 standard prefixes resolve and are declared", async () => {
  const { text, store } = await shaclStore("kitchen-sink.yaml");

  // xsd:string expanded through the standard table, not base-mangled
  const title = propShape(store, `${DCT}title`);
  assert(title, "title property shape exists");
  const dt = store.getObjects(title, `${SH}datatype`, null);
  assertEquals(dt[0].value, `${XSD}string`);
  assert(
    !text.includes("http://example.org/ap#xsd:string"),
    "no garbage base-concatenated IRIs",
  );

  // used standard prefixes are declared in the output
  assertStringIncludes(text, "@prefix xsd:");
  assertStringIncludes(text, "@prefix dcterms:");
});

Deno.test("shacl: S4 IRI value sets are IRI terms, literal sets are literals", async () => {
  const { store } = await shaclStore("kitchen-sink.yaml");

  const license = propShape(store, `${DCT}license`);
  const inHead = store.getObjects(license, `${SH}in`, null)[0];
  const items = rdfList(store, inHead);
  assertEquals(items.length, 2);
  assertEquals(items[0].termType, "NamedNode");
  assertEquals(items[0].value, "http://creativecommons.org/licenses/by/4.0/");
  // CURIE expanded through the user's namespaces
  assertEquals(items[1].value, "http://example.org/vocab#custom");

  const format = propShape(store, `${DCT}format`);
  const fmtItems = rdfList(store, store.getObjects(format, `${SH}in`, null)[0]);
  assertEquals(fmtItems[0].termType, "Literal");
  assertEquals(fmtItems[0].value, "print");
  assertEquals(fmtItems[1].value, 'e"book');
});

Deno.test("shacl: statement-level class constraint emits sh:class", async () => {
  const { store } = await shaclStore("kitchen-sink.yaml");
  const agent = propShape(store, `${DCT}creator`);
  const cls = store.getObjects(agent, `${SH}class`, null);
  assertEquals(cls.length, 1);
  assertEquals(cls[0].value, "http://xmlns.com/foaf/0.1/Agent");
});

Deno.test("shacl: exclusive and length facets are emitted", async () => {
  const { store } = await shaclStore("kitchen-sink.yaml");

  const age = propShape(store, "http://xmlns.com/foaf/0.1/age");
  assertEquals(store.getObjects(age, `${SH}minExclusive`, null)[0].value, "0");
  assertEquals(store.getObjects(age, `${SH}maxExclusive`, null)[0].value, "150");

  const size = propShape(store, "http://example.org/vocab#size");
  assertEquals(store.getObjects(size, `${SH}minLength`, null)[0].value, "1");
  assertEquals(store.getObjects(size, `${SH}maxLength`, null)[0].value, "3");

  // Length → minLength + maxLength pair
  const isbn = propShape(store, "https://schema.org/isbn");
  assertEquals(store.getObjects(isbn, `${SH}minLength`, null)[0].value, "13");
  assertEquals(store.getObjects(isbn, `${SH}maxLength`, null)[0].value, "13");
});

Deno.test("shacl: languageTag emits sh:languageIn list", async () => {
  const { store } = await shaclStore("kitchen-sink.yaml");
  const lang = propShape(store, `${DCT}language`);
  const head = store.getObjects(lang, `${SH}languageIn`, null)[0];
  const tags = rdfList(store, head).map((t) => t.value);
  assertEquals(tags, ["en", "ja"]);
});

Deno.test("shacl: inScheme approximated as anchored sh:pattern", async () => {
  const { store } = await shaclStore("kitchen-sink.yaml");
  const subject = propShape(store, `${DCT}subject`);
  const patterns = store.getObjects(subject, `${SH}pattern`, null);
  assertEquals(patterns.length, 1);
  // skos: resolves through the standard table; regex-escaped + anchored
  assertEquals(
    patterns[0].value,
    "^http://www\\.w3\\.org/2004/02/skos/core#",
  );
});

Deno.test("shacl: multiple inScheme entries emit sh:or of anchored patterns", async () => {
  const { store } = await shaclStore("inscheme-list.yaml");
  const subject = propShape(store, `${DCT}subject`);
  assert(subject, "subject property shape exists");

  const orHeads = store.getObjects(subject, `${SH}or`, null);
  assertEquals(orHeads.length, 1, "sh:or present");

  const members = rdfList(store, orHeads[0]);
  assertEquals(members.length, 2);
  const patterns = members.map(
    (m) => store.getObjects(m, `${SH}pattern`, null)[0].value,
  );
  assertEquals(patterns, [
    "^http://id\\.ndl\\.go\\.jp/auth/ndlsh/",
    "^http://id\\.loc\\.gov/authorities/subjects/",
  ]);
});

Deno.test("shacl: inScheme on non-IRI statement warns instead of emitting", async () => {
  await withTempDir(async (dir) => {
    const profile = `${dir}/p.yaml`;
    await Deno.writeTextFile(
      profile,
      [
        "descriptions:",
        "  MAIN:",
        "    statements:",
        "      s:",
        "        property: dcterms:subject",
        "        type: literal",
        '        inScheme: "skos:"',
      ].join("\n"),
    );
    const out = `${dir}/out.ttl`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateSHACL(profile, { output: out }))
    );
    assert(
      warnings.some((w) => w.includes("inScheme")),
      `expected inScheme warning, got: ${warnings.join("; ")}`,
    );
    const store = parseTurtle(await Deno.readTextFile(out));
    assertEquals(store.getQuads(null, `${SH}pattern`, null, null).length, 0);
  });
});

Deno.test("shacl: TotalDigits/FractionDigits warn (not expressible)", async () => {
  await withTempDir(async (dir) => {
    const profile = `${dir}/p.yaml`;
    await Deno.writeTextFile(
      profile,
      [
        "descriptions:",
        "  MAIN:",
        "    statements:",
        "      n:",
        "        property: ex:num",
        "        datatype: xsd:decimal",
        "        facets:",
        "          TotalDigits: 5",
      ].join("\n"),
    );
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateSHACL(profile, { output: `${dir}/out.ttl` }))
    );
    assert(warnings.some((w) => w.includes("TotalDigits")));
  });
});
