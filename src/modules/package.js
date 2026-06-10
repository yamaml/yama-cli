/**
 * @fileoverview Full profile package generator for YAMA.
 *
 * Generates a complete folder of profile artifacts from a single input
 * file (YAMA YAML, SimpleDSP, or DCTAP). Each artifact is produced by
 * calling the existing module functions, so the package is always
 * consistent with individual `yama <format>` commands.
 *
 * Output folder structure:
 *   index.html        — HTML documentation with embedded diagram
 *   profile.md        — Markdown documentation
 *   README.md         — Format descriptions with spec links
 *   diagram.svg       — Overview diagram
 *   diagram-detail.svg — Detailed diagram with all properties
 *   diagram.pdf       — Overview diagram as vector PDF (LaTeX-ready, archival)
 *   profile.yaml      — YAMA source (canonical YAML)
 *   profile.json      — JSON representation
 *   simpledsp.tsv     — SimpleDSP (English)
 *   simpledsp-jp.tsv  — SimpleDSP (Japanese)
 *   dctap.csv         — DCTAP
 *   shacl.ttl         — SHACL shapes
 *   shex.shex         — ShEx
 *   owl-dsp.ttl       — OWL-DSP
 *   datapackage.json  — Frictionless Data Package
 *
 * @module package
 */

import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { readInput, statusLog } from "./io.js";
import { readSimpleDsp, simpleDspToYama } from "./dsp.js";
import { readTabular, rowsToYama } from "./dctap.js";
import { generateHtmlReport, generateMarkdownReport } from "./report.js";
import { buildOverviewSvg } from "./diagram.js";
import { VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Input parsing (multi-format, same logic as report command)
// ---------------------------------------------------------------------------

/**
 * Parses an input file into a YAMA document, handling YAML, SimpleDSP,
 * and DCTAP input formats.
 *
 * The returned `flavor` labels the source format for report headers:
 * "dctap", "simpledsp", or "yamaml" (plain YAMAML YAML input must not
 * be labelled SimpleDSP).
 *
 * @param {string} inputFile - Path to the input file.
 * @param {Object} [opts]
 * @param {string} [opts.inputFormat] - Force input format: "yaml", "simpledsp", "dctap".
 * @returns {Promise<{doc: Object, flavor: string}>} Parsed YAMA document and source flavor.
 */
export async function parseInputFile(inputFile, { inputFormat } = {}) {
  const ext = inputFile.split(".").pop()?.toLowerCase();

  if (inputFormat === "dctap" || (!inputFormat && ext === "csv")) {
    let isDctap = inputFormat === "dctap";
    if (!inputFormat && ext === "csv") {
      const text = await readInput(inputFile);
      const firstLine = text.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
      if (firstLine?.trim().startsWith("[")) {
        isDctap = false;
      } else {
        const lower = firstLine?.toLowerCase() || "";
        isDctap = lower.includes("propertyid") || lower.includes("shapeid");
      }
    }
    if (isDctap) {
      const rows = await readTabular(inputFile);
      return { doc: rowsToYama(rows), flavor: "dctap" };
    }
    const { blocks, namespaces } = await readSimpleDsp(inputFile);
    return { doc: simpleDspToYama(blocks, namespaces), flavor: "simpledsp" };
  }

  if (
    inputFormat === "simpledsp" ||
    ext === "tsv" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    const { blocks, namespaces } = await readSimpleDsp(inputFile);
    return { doc: simpleDspToYama(blocks, namespaces), flavor: "simpledsp" };
  }

  // Default: YAML
  const text = await readInput(inputFile);
  return { doc: parseYaml(text), flavor: "yamaml" };
}

// ---------------------------------------------------------------------------
// README generator
// ---------------------------------------------------------------------------

/**
 * Generates a README.md describing the package contents.
 *
 * @param {string} profileName - Display name for the profile.
 * @returns {string} Markdown content.
 */
function buildReadme(profileName) {
  const date = new Date().toISOString().split("T")[0];

  return `# ${profileName}

Application profile package generated with [YAMA](https://www.yamaml.org).

## Files

| File | Format | Description |
|------|--------|-------------|
| \`index.html\` | HTML | Interactive profile documentation with diagram |
| \`profile.md\` | Markdown | Profile documentation in Markdown format |
| \`profile.yaml\` | YAMAML | Source profile in YAML format ([spec](https://docs.yamaml.org/specs/yamaml/spec/)) |
| \`profile.json\` | JSON | JSON representation of the profile |
| \`simpledsp.tsv\` | SimpleDSP | Tab-separated metadata schema definition |
| \`simpledsp-jp.tsv\` | SimpleDSP | SimpleDSP with Japanese headers and value types |
| \`dctap.csv\` | DCTAP | DC Tabular Application Profile ([spec](https://dcmi.github.io/dctap/)) |
| \`shacl.ttl\` | SHACL | Shapes Constraint Language ([spec](https://www.w3.org/TR/shacl/)) |
| \`shex.shex\` | ShEx | Shape Expressions ([spec](https://shex.io/)) |
| \`owl-dsp.ttl\` | OWL-DSP | OWL Description Set Profile ([spec](https://www.kanzaki.com/ns/dsp#)) |
| \`diagram.svg\` | SVG | Overview diagram |
| \`diagram-detail.svg\` | SVG | Detailed diagram with all properties |
| \`diagram.pdf\` | PDF | Overview diagram as vector PDF (LaTeX-ready) |
| \`datapackage.json\` | Frictionless | Data Package descriptor ([spec](https://datapackage.org/)) |

## Generated

${date} with YAMA v${VERSION}
`;
}

// ---------------------------------------------------------------------------
// Package generator
// ---------------------------------------------------------------------------

/**
 * Generates a complete profile package folder with all artifacts.
 *
 * Each artifact is generated independently. If one fails, a warning is
 * logged and the remaining artifacts continue.
 *
 * @param {string} inputFile - Path to the input file (YAML, TSV, CSV, etc.).
 * @param {string} outputDir - Path to the output directory.
 * @param {Object} [opts]
 * @param {string} [opts.inputFormat] - Force input format: "yaml", "simpledsp", "dctap".
 * @returns {Promise<void>}
 */
export async function generatePackage(inputFile, outputDir, opts = {}) {
  // 1. Parse input into YAMA doc
  const { doc, flavor } = await parseInputFile(inputFile, opts);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${inputFile}: not a valid profile document`);
  }

  // 2. Create output directory
  Deno.mkdirSync(outputDir, { recursive: true });

  const profileName = inputFile.split("/").pop().replace(/\.\w+$/, "") || "Profile";
  const results = [];
  let succeeded = 0;
  let failed = 0;

  /**
   * Wraps an artifact generation step with error handling.
   * On failure, logs a warning and continues.
   */
  async function generate(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      succeeded++;
    } catch (err) {
      console.error(`  Warning: ${name} failed — ${err.message}`);
      results.push({ name, ok: false, error: err.message });
      failed++;
    }
  }

  statusLog(`Generating package in ${outputDir}/`);

  // -- profile.yaml (canonical YAMA source) --------------------------------
  await generate("profile.yaml", () => {
    const yaml = stringifyYaml(doc, { lineWidth: -1 });
    Deno.writeTextFileSync(join(outputDir, "profile.yaml"), yaml);
  });

  // -- profile.json --------------------------------------------------------
  await generate("profile.json", () => {
    const json = JSON.stringify(doc, null, 2);
    Deno.writeTextFileSync(join(outputDir, "profile.json"), json);
  });

  // -- simpledsp.tsv (English) --------------------------------------------
  await generate("simpledsp.tsv", async () => {
    const { exportSimpleDSP } = await import("./dsp.js");
    // Write a temporary YAML for the export function to read.
    // The export functions expect a file path, so we write the doc
    // as a temp YAML and pass it in. Alternatively, use the canonical
    // profile.yaml we just wrote.
    const yamlPath = join(outputDir, "profile.yaml");
    await exportSimpleDSP(yamlPath, join(outputDir, "simpledsp.tsv"), { lang: "en" });
  });

  // -- simpledsp-jp.tsv (Japanese) ----------------------------------------
  await generate("simpledsp-jp.tsv", async () => {
    const { exportSimpleDSP } = await import("./dsp.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await exportSimpleDSP(yamlPath, join(outputDir, "simpledsp-jp.tsv"), { lang: "jp" });
  });

  // -- dctap.csv -----------------------------------------------------------
  await generate("dctap.csv", async () => {
    const { exportDCTAP } = await import("./dctap.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await exportDCTAP(yamlPath, join(outputDir, "dctap.csv"));
  });

  // -- shacl.ttl -----------------------------------------------------------
  await generate("shacl.ttl", async () => {
    const { generateSHACL } = await import("./shacl.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateSHACL(yamlPath, { output: join(outputDir, "shacl.ttl") });
  });

  // -- shex.shex -----------------------------------------------------------
  await generate("shex.shex", async () => {
    const { generateShEx } = await import("./shex.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateShEx(yamlPath, join(outputDir, "shex.shex"));
  });

  // -- owl-dsp.ttl ---------------------------------------------------------
  await generate("owl-dsp.ttl", async () => {
    const { generateDSP } = await import("./dsp.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateDSP(yamlPath, { output: join(outputDir, "owl-dsp.ttl") });
  });

  // -- datapackage.json ----------------------------------------------------
  await generate("datapackage.json", async () => {
    const { generateDataPackage } = await import("./datapackage.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateDataPackage(yamlPath, join(outputDir, "datapackage.json"));
  });

  // -- diagram.svg (overview) ---------------------------------------------
  await generate("diagram.svg", async () => {
    const { generateDiagram } = await import("./diagram.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateDiagram(yamlPath, {
      output: join(outputDir, "diagram.svg"),
      format: "overview",
    });
  });

  // -- diagram-detail.svg (full detail) -----------------------------------
  await generate("diagram-detail.svg", async () => {
    const { generateDiagram } = await import("./diagram.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateDiagram(yamlPath, {
      output: join(outputDir, "diagram-detail.svg"),
      format: "color",
    });
  });

  // -- diagram.pdf (overview, vector PDF for LaTeX / archival) ------------
  await generate("diagram.pdf", async () => {
    const { generateDiagram } = await import("./diagram.js");
    const yamlPath = join(outputDir, "profile.yaml");
    await generateDiagram(yamlPath, {
      output: join(outputDir, "diagram.pdf"),
      format: "overview",
    });
  });

  // -- profile.md (Markdown report) ---------------------------------------
  await generate("profile.md", () => {
    const md = generateMarkdownReport(doc, inputFile, flavor);
    Deno.writeTextFileSync(join(outputDir, "profile.md"), md);
  });

  // -- index.html (HTML report with embedded SVG) -------------------------
  await generate("index.html", async () => {
    let svgDiagram = "";
    try {
      svgDiagram = await buildOverviewSvg(doc);
    } catch {
      // Diagram is optional for HTML report
    }
    const html = generateHtmlReport(doc, svgDiagram, inputFile, flavor);
    Deno.writeTextFileSync(join(outputDir, "index.html"), html);
  });

  // -- README.md -----------------------------------------------------------
  await generate("README.md", () => {
    const readme = buildReadme(profileName);
    Deno.writeTextFileSync(join(outputDir, "README.md"), readme);
  });

  // Summary — a partial package is a failure: report which artifacts
  // broke and exit non-zero so CI can detect it.
  statusLog(`\nPackage complete: ${succeeded} artifacts generated`);
  if (failed > 0) {
    const failedNames = results
      .filter((r) => !r.ok)
      .map((r) => r.name)
      .join(", ");
    console.error(`  ${failed} artifact(s) failed: ${failedNames}`);
    throw new Error(
      `package incomplete — ${failed} of ${succeeded + failed} artifacts failed`,
    );
  }
}
