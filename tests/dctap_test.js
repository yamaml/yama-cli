/**
 * @fileoverview Regression tests for DCTAP export/import (dctap.js).
 *
 * Audit findings covered: S5 (shape row lost when the first statement
 * has no property), description note loss, bare/unknown
 * valueConstraint import (decision 9), comma-in-value warning
 * (decision 8), stmt.a warning, round-trip fidelity.
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseCsv } from "@std/csv";
import { parse as parseYaml } from "@std/yaml";
import { exportDCTAP, importDCTAP, rowsToYama } from "../src/modules/dctap.js";
import { captureWarnings, fixture, quietly, withTempDir } from "./helpers.js";

async function exportRows(profilePath) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/out.csv`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => exportDCTAP(profilePath, out))
    );
    const rows = parseCsv(await Deno.readTextFile(out), { skipFirstRow: true });
    return { rows, warnings };
  });
}

async function writeProfile(dir, lines) {
  const profile = `${dir}/p.yaml`;
  await Deno.writeTextFile(profile, lines.join("\n"));
  return profile;
}

Deno.test("dctap: S5 shapeID lands on the first emitted row", async () => {
  await withTempDir(async (dir) => {
    const profile = await writeProfile(dir, [
      "descriptions:",
      "  book:",
      "    label: Book",
      "    statements:",
      "      placeholder:",
      "        label: No property yet",
      "      title:",
      "        property: dcterms:title",
    ]);
    const { rows } = await exportRows(profile);
    // the property-less statement is skipped; the shape header must
    // ride on the first emitted row
    assertEquals(rows[0].shapeID, "book");
    assertEquals(rows[0].propertyID, "dcterms:title");
  });
});

Deno.test("dctap: shape note gets a dedicated header row and survives re-import", async () => {
  await withTempDir(async (dir) => {
    const profile = await writeProfile(dir, [
      "descriptions:",
      "  book:",
      "    label: Book",
      "    note: Shape-level documentation",
      "    statements:",
      "      title:",
      "        property: dcterms:title",
    ]);
    const out = `${dir}/out.csv`;
    await captureWarnings(() => quietly(() => exportDCTAP(profile, out)));
    const rows = parseCsv(await Deno.readTextFile(out), { skipFirstRow: true });

    assertEquals(rows[0].shapeID, "book");
    assertEquals(rows[0].propertyID, "", "header row has no property");
    assertEquals(rows[0].note, "Shape-level documentation");
    assertEquals(rows[1].shapeID, "", "statement row carries no duplicate shapeID");
    assertEquals(rows[1].propertyID, "dcterms:title");

    const back = `${dir}/back.yaml`;
    await quietly(() => importDCTAP(out, back));
    const doc = parseYaml(await Deno.readTextFile(back));
    assertEquals(doc.descriptions.book.note, "Shape-level documentation");
    assertEquals(
      doc.descriptions.book.statements.title.property,
      "dcterms:title",
    );
  });
});

Deno.test("dctap: decision 9 bare and unknown valueConstraints import as values", async () => {
  const { result, warnings } = await captureWarnings(async () => {
    return await withTempDir(async (dir) => {
      const out = `${dir}/out.yaml`;
      await quietly(() => importDCTAP(fixture("dctap-bare.csv"), out));
      return parseYaml(await Deno.readTextFile(out));
    });
  });
  const stmts = result.descriptions.book.statements;
  assertEquals(stmts.title.values, ["Exact Title"], "bare constraint kept");
  assertEquals(stmts.format.values, ["whatever"], "unknown type kept as values");
  assert(
    warnings.some((w) => w.includes("unknownType")),
    "unknown constraint type warns",
  );
});

Deno.test("dctap: decision 8 comma inside a picklist value warns", async () => {
  await withTempDir(async (dir) => {
    const profile = await writeProfile(dir, [
      "descriptions:",
      "  MAIN:",
      "    statements:",
      "      fmt:",
      "        property: dcterms:format",
      "        values:",
      '          - "print, bound"',
      "          - ebook",
    ]);
    const { rows, warnings } = await exportRows(profile);
    assert(warnings.some((w) => w.includes("comma")));
    assertEquals(rows[0].valueConstraint, "print, bound,ebook");
  });
});

Deno.test("dctap: statement-level class constraint warns (no DCTAP column)", async () => {
  await withTempDir(async (dir) => {
    const profile = await writeProfile(dir, [
      "descriptions:",
      "  MAIN:",
      "    statements:",
      "      agent:",
      "        property: dcterms:creator",
      "        type: IRI",
      "        a: foaf:Agent",
    ]);
    const { rows, warnings } = await exportRows(profile);
    assert(warnings.some((w) => w.includes("class constraint")));
    assertEquals(rows[0].propertyID, "dcterms:creator");
  });
});

Deno.test("dctap: multiple constraint kinds keep priority and warn", async () => {
  await withTempDir(async (dir) => {
    const profile = await writeProfile(dir, [
      "descriptions:",
      "  MAIN:",
      "    statements:",
      "      s:",
      "        property: dcterms:subject",
      "        type: IRI",
      '        inScheme: "skos:"',
      "        pattern: ^x",
    ]);
    const { rows, warnings } = await exportRows(profile);
    assertEquals(rows[0].valueConstraintType, "IRIstem");
    assert(warnings.some((w) => w.includes("dropped pattern")));
  });
});

Deno.test("dctap: round-trip preserves constraints", async () => {
  await withTempDir(async (dir) => {
    const profile = await writeProfile(dir, [
      "descriptions:",
      "  book:",
      "    label: Book",
      "    statements:",
      "      title:",
      "        property: dcterms:title",
      "        label: Title",
      "        min: 1",
      "        max: 1",
      "        type: literal",
      "        datatype: xsd:string",
      "      lang:",
      "        property: dcterms:language",
      "        languageTag:",
      "          - en",
      "          - ja",
      "      age:",
      "        property: foaf:age",
      "        facets:",
      "          MinExclusive: 0",
      "      subject:",
      "        property: dcterms:subject",
      "        type: IRI",
      '        inScheme: "skos:"',
      "      author:",
      "        property: dcterms:creator",
      "        description:",
      "          - person",
      "          - org",
      "  person:",
      "    statements:",
      "      name:",
      "        property: foaf:name",
      "  org:",
      "    statements:",
      "      name:",
      "        property: foaf:name",
    ]);
    const csv = `${dir}/p.csv`;
    await captureWarnings(() => quietly(() => exportDCTAP(profile, csv)));
    const back = `${dir}/back.yaml`;
    await quietly(() => importDCTAP(csv, back));
    const doc = parseYaml(await Deno.readTextFile(back));

    const stmts = doc.descriptions.book.statements;
    assertEquals(stmts.title.min, 1);
    assertEquals(stmts.title.max, 1);
    assertEquals(stmts.title.datatype, "xsd:string");
    assertEquals(stmts.title.type, "literal");
    // key is derived from propertyID local name on re-import, not preserved from the original YAML
    assertEquals(stmts.language.languageTag, ["en", "ja"]);
    assertEquals(stmts.age.facets.MinExclusive, 0);
    assertEquals(stmts.subject.inScheme, "skos:");
    assertEquals(stmts.creator.description, ["person", "org"]);
  });
});

Deno.test("dctap: empty shapes keep the existing header-row behaviour", () => {
  const doc = rowsToYama([
    { shapeID: "empty", shapeLabel: "Empty", note: "n", propertyID: "" },
  ]);
  assertEquals(doc.descriptions.empty.label, "Empty");
  assertEquals(doc.descriptions.empty.note, "n");
});
