/**
 * @fileoverview End-to-end tests for the CLI surface: version output,
 * the -q/--quiet flag, and invalid format/style rejection.
 *
 * Runs src/yama.js as a subprocess so flag parsing, exit codes, and
 * stderr behaviour are tested exactly as users see them.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fixture, withTempDir } from "./helpers.js";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Runs the CLI with the given arguments and captures its output.
 *
 * @param {string[]} args - CLI arguments after `yama`.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function runCli(args) {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "src/yama.js",
      ...args,
    ],
    cwd: PROJECT_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// ── Version ───────────────────────────────────────────────────────

Deno.test("cli: --version reports the deno.json version", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${PROJECT_ROOT}/deno.json`),
  );
  const { code, stdout } = await runCli(["--version"]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, `yama-cli v${denoJson.version}`);
});

// ── Quiet flag ────────────────────────────────────────────────────

Deno.test("cli: status messages print without -q and vanish with it", async () => {
  await withTempDir(async (dir) => {
    const loud = await runCli([
      "shex",
      "-i",
      fixture("kitchen-sink.yaml"),
      "-o",
      `${dir}/loud.shex`,
    ]);
    assertEquals(loud.code, 0);
    assertStringIncludes(loud.stderr, "Written to");

    const quiet = await runCli([
      "shex",
      "-i",
      fixture("kitchen-sink.yaml"),
      "-o",
      `${dir}/quiet.shex`,
      "-q",
    ]);
    assertEquals(quiet.code, 0);
    assertEquals(quiet.stderr.trim(), "");
    // The output file is still written.
    const text = await Deno.readTextFile(`${dir}/quiet.shex`);
    assert(text.length > 0);
  });
});

// ── Invalid format values ─────────────────────────────────────────

Deno.test("cli: validate rejects unknown --format with exit 1", async () => {
  const { code, stderr } = await runCli([
    "validate",
    "-i",
    fixture("kitchen-sink.yaml"),
    "--format",
    "xml",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "human, json");
});

Deno.test("cli: diagram rejects unknown -f style with exit 1", async () => {
  await withTempDir(async (dir) => {
    const { code, stderr } = await runCli([
      "diagram",
      "-i",
      fixture("kitchen-sink.yaml"),
      "-o",
      `${dir}/d.dot`,
      "-f",
      "sparkle",
    ]);
    assertEquals(code, 1);
    assertStringIncludes(stderr, "color, bw, overview, overview-bw");
  });
});

Deno.test("cli: rdf rejects unknown -f serialization with exit 1", async () => {
  const { code, stderr } = await runCli([
    "shacl",
    "-i",
    fixture("kitchen-sink.yaml"),
    "-f",
    "xml",
  ]);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "turtle");
});

// ── Help text ─────────────────────────────────────────────────────

Deno.test("cli: main help lists .pdf among diagram formats", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, ".pdf");
});
