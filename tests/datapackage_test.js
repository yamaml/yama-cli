/**
 * @fileoverview Regression tests for the Frictionless Data Package
 * generator.
 *
 * Audit findings covered: statement sources that differ from the id
 * source get their own resource (decision 17), Frictionless name
 * normalisation, unknown XSD type fallback with warning.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { generateDataPackage } from "../src/modules/datapackage.js";
import { captureWarnings, fixture, quietly, withTempDir } from "./helpers.js";

async function buildPackage(name) {
  return await withTempDir(async (dir) => {
    const out = `${dir}/datapackage.json`;
    const { warnings } = await captureWarnings(() =>
      quietly(() => generateDataPackage(fixture(name), out))
    );
    return { pkg: JSON.parse(await Deno.readTextFile(out)), warnings };
  });
}

Deno.test("datapackage: statement with foreign source gets its own resource", async () => {
  const { pkg } = await buildPackage("multisource.yaml");
  assertEquals(pkg.resources.length, 2);

  const main = pkg.resources.find((r) => r.path === "characters.csv");
  const external = pkg.resources.find((r) => r.path === "External Data.csv");
  assert(main, "main resource exists");
  assert(external, "external-source resource exists");

  const extFields = external.schema.fields.map((f) => f.name);
  assertEquals(extFields, ["wikidata_id"]);
  const mainFields = main.schema.fields.map((f) => f.name);
  assert(!mainFields.includes("wikidata_id"), "field not duplicated in main");
});

Deno.test("datapackage: resource names follow the Frictionless pattern", async () => {
  const { pkg } = await buildPackage("multisource.yaml");
  for (const res of pkg.resources) {
    assertMatch(res.name, /^[a-z0-9._-]+$/, `name "${res.name}" conforms`);
  }
  const external = pkg.resources.find((r) => r.path === "External Data.csv");
  assertEquals(external.name, "external-data");
});

Deno.test("datapackage: unknown XSD datatype falls back to string with warning", async () => {
  const { pkg, warnings } = await buildPackage("multisource.yaml");
  const main = pkg.resources.find((r) => r.path === "characters.csv");
  const strange = main.schema.fields.find((f) => f.name === "strange");
  assertEquals(strange.type, "string");
  assert(
    warnings.some((w) => w.includes("xsd:unknownThing")),
    `expected fallback warning, got: ${warnings.join("; ")}`,
  );
});
