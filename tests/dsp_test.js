/**
 * @fileoverview Regression tests for OWL-DSP and SimpleDSP (dsp.js).
 *
 * Audit findings covered: the §4.5 inScheme list crash, S6 ([MAIN]
 * rename with #ref rewriting), S7 (TSV cell sanitisation), S8 (CSV
 * quoted newlines + padded block markers), quoted "ID" stripping,
 * full-URI ID constraints, a-only id round-trip gain, languageTag →
 * dsp:langTagOccurrence, SimpleDSP export warnings, S1 output
 * prefixes.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import {
  exportSimpleDSP,
  generateDSP,
  importSimpleDSP,
  readSimpleDsp,
  simpleDspToYama,
} from "../src/modules/dsp.js";
import {
  captureWarnings,
  fixture,
  parseTurtle,
  quietly,
  withTempDir,
} from "./helpers.js";

const DSP = "http://purl.org/metainfo/terms/dsp#";

async function dspStore(file) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/dsp.ttl`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateDSP(file, { output: out }))
    );
    const text = await Deno.readTextFile(out);
    return { text, store: parseTurtle(text), warnings };
  });
}

async function simpledspText(file, lang) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/out.tsv`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => exportSimpleDSP(file, out, { lang }))
    );
    return { text: await Deno.readTextFile(out), warnings };
  });
}

Deno.test("dsp: spec §4.5 inScheme list no longer crashes", async () => {
  const { store } = await dspStore(fixture("inscheme-list.yaml"));
  const schemes = store
    .getQuads(null, `${DSP}inScheme`, null, null)
    .map((q) => q.object.value)
    .sort();
  assertEquals(schemes, [
    "http://id.loc.gov/authorities/subjects/",
    "http://id.ndl.go.jp/auth/ndlsh/",
  ]);
});

Deno.test("dsp: languageTag emits dsp:langTagOccurrence with warning", async () => {
  const { store, warnings } = await dspStore(fixture("kitchen-sink.yaml"));
  const occ = store.getQuads(null, `${DSP}langTagOccurrence`, null, null);
  assertEquals(occ.length, 1);
  assertEquals(occ[0].object.value, "mandatory");
  assert(warnings.some((w) => w.includes("language tags")));
});

Deno.test("dsp: S1 used standard prefixes are declared in output", async () => {
  const { text } = await dspStore(fixture("inscheme-list.yaml"));
  assertStringIncludes(text, "@prefix dcterms:");
  assertStringIncludes(text, "@prefix foaf:");
  assert(!text.includes("ap#dcterms:"), "no base-mangled CURIEs");
});

Deno.test("simpledsp: S6 refs to renamed first description become #MAIN", async () => {
  const { text } = await simpledspText(fixture("self-ref.yaml"));
  const lines = text.split("\n");
  assert(lines[0] === "[MAIN]" || text.startsWith("[@NS]"), "starts with a block");
  const parentRow = lines.find((l) => l.startsWith("parent\t"));
  assertStringIncludes(parentRow, "\t#MAIN\t");
  const relRow = lines.find((l) => l.startsWith("rel\t"));
  assertStringIncludes(relRow, "\t#MAIN\t");
  assert(!text.includes("#thing"), "no dangling #thing refs");
});

Deno.test("simpledsp: #MAIN refs survive a round-trip import", async () => {
  await withTempDir(async (dir) => {
    const tsv = `${dir}/p.tsv`;
    await captureWarnings(() =>
      quietly(() => exportSimpleDSP(fixture("self-ref.yaml"), tsv))
    );
    const yamlOut = `${dir}/p.yaml`;
    await quietly(() => importSimpleDSP(tsv, yamlOut));
    const doc = parseYaml(await Deno.readTextFile(yamlOut));
    assertEquals(
      doc.descriptions.MAIN.statements.parent.description,
      "MAIN",
      "self-reference resolves to the first block",
    );
    assertEquals(doc.descriptions.other.statements.rel.description, "MAIN");
  });
});

Deno.test("simpledsp: S7 tabs and newlines in cells sanitised with warning", async () => {
  await withTempDir(async (dir) => {
    const profile = `${dir}/p.yaml`;
    await Deno.writeTextFile(
      profile,
      [
        "descriptions:",
        "  MAIN:",
        "    statements:",
        "      title:",
        "        property: dcterms:title",
        "        note: |-",
        "          line one",
        "          line two",
      ].join("\n"),
    );
    const out = `${dir}/p.tsv`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => exportSimpleDSP(profile, out))
    );
    const text = await Deno.readTextFile(out);
    const row = text.split("\n").find((l) => l.startsWith("title\t"));
    assertEquals(row.split("\t").length, 7, "row keeps 7 columns");
    assertStringIncludes(row, "line one line two");
    assert(warnings.some((w) => w.includes("tab/newline")));
  });
});

Deno.test("simpledsp: S8 CSV quoted newlines and padded markers parse", async () => {
  const { blocks, namespaces } = await readSimpleDsp(
    fixture("simpledsp-padded.csv"),
  );
  assertEquals(namespaces.dmm, "http://example.org/dmm/");
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].id, "MAIN");
  const titleRow = blocks[0].rows.find((r) => r.Name === "Title");
  assertEquals(titleRow.Comment, "multi\nline note");
});

Deno.test("simpledsp: empty first cell does not shift TSV columns", async () => {
  await withTempDir(async (dir) => {
    const tsv = `${dir}/p.tsv`;
    // The Name cell is empty — a line-level trim used to swallow the
    // leading tab and shift every column left by one.
    await Deno.writeTextFile(
      tsv,
      "[MAIN]\n\tdcterms:title\t0\t-\tliteral\txsd:string\tnote\n",
    );
    const { blocks } = await readSimpleDsp(tsv);
    const row = blocks[0].rows[0];
    assertEquals(row.Name, "");
    assertEquals(row.Property, "dcterms:title");
    assertEquals(row.ValueType, "literal");
    assertEquals(row.Constraint, "xsd:string");
    assertEquals(row.Comment, "note");
  });
});

Deno.test('simpledsp: quoted "ID" value type is stripped on import', async () => {
  const { blocks, namespaces } = await readSimpleDsp(
    fixture("simpledsp-quoted-id.tsv"),
  );
  const doc = simpleDspToYama(blocks, namespaces);
  assertEquals(doc.descriptions.MAIN.id.mapping.path, "BookID");
  assertEquals(doc.descriptions.MAIN.a, "foaf:Document");
  assertEquals(doc.descriptions.MAIN.id.prefix, "dmm");
});

Deno.test("simpledsp: full-URI ID constraint mints a prefix, base untouched", async () => {
  const { blocks, namespaces } = await readSimpleDsp(
    fixture("simpledsp-full-uri-id.tsv"),
  );
  const doc = simpleDspToYama(blocks, namespaces);
  assertEquals(doc.base, "http://example.org/schema#", "schema base kept");
  const prefix = doc.descriptions.MAIN.id.prefix;
  assert(prefix, "id.prefix set");
  assertEquals(doc.namespaces[prefix], "http://example.org/records/");
});

Deno.test("simpledsp: a-only description does not gain an id on round-trip", async () => {
  await withTempDir(async (dir) => {
    const tsv = `${dir}/p.tsv`;
    await captureWarnings(() =>
      quietly(() => exportSimpleDSP(fixture("a-only.yaml"), tsv))
    );
    const yamlOut = `${dir}/p.yaml`;
    await quietly(() => importSimpleDSP(tsv, yamlOut));
    const doc = parseYaml(await Deno.readTextFile(yamlOut));
    const desc = doc.descriptions.MAIN;
    assertEquals(desc.a, "schema:PostalAddress");
    assertEquals(desc.id, undefined, "no invented id mapping");
  });
});

Deno.test("simpledsp: export warns about inexpressible pattern/facets", async () => {
  const { warnings } = await simpledspText(fixture("kitchen-sink.yaml"));
  assert(warnings.some((w) => w.includes("pattern")));
  assert(warnings.some((w) => w.includes("facets")));
  assert(warnings.some((w) => w.includes("languageTag")));
});

Deno.test("simpledsp: round-trip preserves core structure", async () => {
  await withTempDir(async (dir) => {
    const profile = `${dir}/p.yaml`;
    await Deno.writeTextFile(
      profile,
      [
        "base: http://example.org/ap#",
        "namespaces:",
        "  ex: http://example.org/vocab#",
        "descriptions:",
        "  book:",
        "    a: schema:Book",
        "    statements:",
        "      title:",
        "        label: Title",
        "        property: dcterms:title",
        "        min: 1",
        "        max: 1",
        "        type: literal",
        "        datatype: xsd:string",
        "      subject:",
        "        label: Subject",
        "        property: dcterms:subject",
        "        type: IRI",
        '        inScheme: "skos:"',
        "      author:",
        "        label: Author",
        "        property: dcterms:creator",
        "        description: person",
        "  person:",
        "    a: foaf:Person",
        "    statements:",
        "      name:",
        "        label: Name",
        "        property: foaf:name",
        "        min: 1",
      ].join("\n"),
    );
    const tsv = `${dir}/p.tsv`;
    await captureWarnings(() => quietly(() => exportSimpleDSP(profile, tsv)));
    const back = `${dir}/back.yaml`;
    await quietly(() => importSimpleDSP(tsv, back));
    const doc = parseYaml(await Deno.readTextFile(back));

    const main = doc.descriptions.MAIN;
    assertEquals(main.a, "schema:Book");
    assertEquals(main.statements.title.property, "dcterms:title");
    assertEquals(main.statements.title.min, 1);
    assertEquals(main.statements.title.max, 1);
    assertEquals(main.statements.title.datatype, "xsd:string");
    assertEquals(main.statements.subject.inScheme, "skos:");
    assertEquals(main.statements.author.description, "person");
    assertEquals(doc.descriptions.person.statements.name.property, "foaf:name");
  });
});
