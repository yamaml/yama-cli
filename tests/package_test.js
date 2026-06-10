/**
 * @fileoverview Regression tests for the package generator.
 *
 * Audit findings covered: non-zero exit (throw) when an artifact
 * fails, single-sourced version stamp in the generated README,
 * multi-shape references drawn in the inline overview diagram.
 */

import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { generatePackage } from "../src/modules/package.js";
import { VERSION } from "../src/version.js";
import { captureWarnings, fixture, quietly, withTempDir } from "./helpers.js";

Deno.test("package: README stamps the single-sourced version", async () => {
  await withTempDir(async (dir) => {
    const out = `${dir}/pkg`;
    await captureWarnings(() =>
      quietly(() => generatePackage(fixture("kitchen-sink.yaml"), out))
    );
    const readme = await Deno.readTextFile(`${out}/README.md`);
    assertStringIncludes(readme, `YAMA v${VERSION}`);
    assert(!readme.includes("v1.0.1"), "no stale hardcoded version");
  });
});

Deno.test("package: inline overview draws multi-shape edges", async () => {
  await withTempDir(async (dir) => {
    const out = `${dir}/pkg`;
    await captureWarnings(() =>
      quietly(() => generatePackage(fixture("kitchen-sink.yaml"), out))
    );
    const html = await Deno.readTextFile(`${out}/index.html`);
    // the list-form description: [person, org] must produce two edges
    const edges = html.match(/class="edge"/g) || [];
    assert(edges.length >= 2, `expected >=2 edges, got ${edges.length}`);
  });
});

Deno.test("package: throws when an artifact fails", async () => {
  await withTempDir(async (dir) => {
    const out = `${dir}/pkg`;
    // sabotage one artifact: a directory where shacl.ttl should go
    await Deno.mkdir(`${out}/shacl.ttl`, { recursive: true });
    await assertRejects(
      () =>
        captureWarnings(() =>
          quietly(() => generatePackage(fixture("kitchen-sink.yaml"), out))
        ),
      Error,
      "package incomplete",
    );
  });
});
