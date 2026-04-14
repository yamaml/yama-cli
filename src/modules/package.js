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
import { readInput } from "./io.js";
import { readSimpleDsp, simpleDspToYama } from "./dsp.js";
import { readTabular, rowsToYama } from "./dctap.js";
import { generateHtmlReport, generateMarkdownReport } from "./report.js";

// ---------------------------------------------------------------------------
// Input parsing (multi-format, same logic as report command)
// ---------------------------------------------------------------------------

/**
 * Parses an input file into a YAMA document, handling YAML, SimpleDSP,
 * and DCTAP input formats.
 *
 * @param {string} inputFile - Path to the input file.
 * @param {Object} [opts]
 * @param {string} [opts.inputFormat] - Force input format: "yaml", "simpledsp", "dctap".
 * @returns {Promise<Object>} Parsed YAMA document.
 */
async function parseInputFile(inputFile, { inputFormat } = {}) {
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
      return rowsToYama(rows);
    }
    const { blocks, namespaces } = await readSimpleDsp(inputFile);
    return simpleDspToYama(blocks, namespaces);
  }

  if (
    inputFormat === "simpledsp" ||
    ext === "tsv" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    const { blocks, namespaces } = await readSimpleDsp(inputFile);
    return simpleDspToYama(blocks, namespaces);
  }

  // Default: YAML
  const text = await readInput(inputFile);
  return parseYaml(text);
}

// ---------------------------------------------------------------------------
// SVG diagram builder (inline overview, same as report command)
// ---------------------------------------------------------------------------

/**
 * Generates an overview SVG diagram string from a YAMA document.
 *
 * Uses the Graphviz WASM engine. Returns an empty string if diagram
 * generation fails (e.g., no Graphviz available).
 *
 * @param {Object} doc - Parsed YAMA document.
 * @returns {Promise<string>} SVG string, or empty string on failure.
 */
async function buildOverviewSvg(doc) {
  const ns = doc.namespaces || {};
  const descriptions = doc.descriptions || {};
  const descNames = Object.keys(descriptions);

  function dotEsc(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function compactIRI(iri) {
    if (!iri) return "";
    const colon = iri.indexOf(":");
    if (colon > 0 && !iri.startsWith("http") && !iri.startsWith("urn:")) {
      const prefix = iri.slice(0, colon);
      if (prefix in ns) return iri;
    }
    for (const [prefix, nsUri] of Object.entries(ns)) {
      if (iri.startsWith(nsUri)) return `${prefix}:${iri.slice(nsUri.length)}`;
    }
    return iri;
  }
  function fmtCard(min, max) {
    const lo = min != null ? String(min) : "0";
    const hi = max != null ? String(max) : "*";
    return lo === hi ? lo : `${lo}..${hi}`;
  }

  const headerColors = [
    "#FFCE9F", "#B8D4E3", "#C8E6C9", "#F8CECC",
    "#D1C4E9", "#FFE0B2", "#B2DFDB", "#F0F4C3",
  ];

  const dotLines = [];
  dotLines.push("digraph YAMA {");
  dotLines.push('  bgcolor="#ffffff";');
  dotLines.push("  rankdir=LR;");
  dotLines.push('  pad="0.6";');
  dotLines.push("  nodesep=0.8;");
  dotLines.push("  ranksep=1.5;");
  dotLines.push("  splines=curved;");
  dotLines.push('  fontname="Helvetica";');
  dotLines.push('  node [shape=plaintext fontname="Helvetica"];');
  dotLines.push('  edge [fontname="Helvetica" fontsize=10 color="#555555" penwidth=1.5 arrowsize=0.9];');
  dotLines.push("");

  const edges = [];
  const edgeMap = new Map();

  // Collect self-refs
  const selfRefs = {};
  for (const name of descNames) {
    selfRefs[name] = [];
    const stmts = descriptions[name].statements || {};
    for (const [sk, sd] of Object.entries(stmts)) {
      if (sd.description === name) {
        const propName = compactIRI(sd.property) || sk;
        selfRefs[name].push({ prop: propName, card: fmtCard(sd.min, sd.max) });
      }
    }
  }

  for (let di = 0; di < descNames.length; di++) {
    const name = descNames[di];
    const def = descriptions[name];
    const bg = headerColors[di % headerColors.length];
    const displayName = def.label || name;
    const rdfClass = def.a ? compactIRI(def.a) : "";
    const refs = selfRefs[name];

    let label = "<\n";
    label += `    <TABLE BORDER="2" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" COLOR="#666666" BGCOLOR="${bg}">\n`;
    label += `      <TR><TD CELLPADDING="10" ALIGN="CENTER">`;
    label += `<FONT POINT-SIZE="13"><B>${esc(displayName)}</B></FONT>`;
    if (rdfClass) {
      label += `<BR/><FONT POINT-SIZE="11" COLOR="#666666">${esc(rdfClass)}</FONT>`;
    }
    if (refs.length > 0) {
      for (const ref of refs) {
        label += `<BR/><FONT POINT-SIZE="9" COLOR="#6A1B9A"><I>&#x21BA; ${esc(ref.prop)}  [${esc(ref.card)}]</I></FONT>`;
      }
    }
    label += `</TD></TR>\n`;
    label += `    </TABLE>\n  >`;
    dotLines.push(`  "${dotEsc(name)}" [label=${label}];`);
    dotLines.push("");

    const stmts = def.statements || {};
    for (const [sk, sd] of Object.entries(stmts)) {
      if (sd.description && sd.description !== name && descNames.includes(sd.description)) {
        const propName = compactIRI(sd.property) || sk;
        const card = fmtCard(sd.min, sd.max);
        const key = `${name}->${sd.description}`;
        if (edgeMap.has(key)) {
          edgeMap.get(key).labels.push(`${propName}  [${card}]`);
        } else {
          const entry = { from: name, to: sd.description, labels: [`${propName}  [${card}]`] };
          edgeMap.set(key, entry);
          edges.push(entry);
        }
      }
    }
  }

  dotLines.push("");
  for (const edge of edges) {
    const labelRows = edge.labels
      .map((l) => `<TR><TD BGCOLOR="#ffffff"><FONT FACE="Helvetica" POINT-SIZE="10" COLOR="#333333">${esc(l)}</FONT></TD></TR>`)
      .join("");
    const labelHtml = `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="2">${labelRows}</TABLE>`;
    dotLines.push(`  "${dotEsc(edge.from)}" -> "${dotEsc(edge.to)}" [label=<${labelHtml}>];`);
  }
  dotLines.push("}");

  const { Graphviz } = await import("@hpcc-js/wasm-graphviz");
  const graphviz = await Graphviz.load();
  return graphviz.dot(dotLines.join("\n"), "svg");
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
| \`datapackage.json\` | Frictionless | Data Package descriptor ([spec](https://datapackage.org/)) |

## Generated

${date} with YAMA v1.0.0
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
  const doc = await parseInputFile(inputFile, opts);
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

  console.error(`Generating package in ${outputDir}/`);

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

  // -- profile.md (Markdown report) ---------------------------------------
  await generate("profile.md", () => {
    const md = generateMarkdownReport(doc, inputFile);
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
    const html = generateHtmlReport(doc, svgDiagram, inputFile);
    Deno.writeTextFileSync(join(outputDir, "index.html"), html);
  });

  // -- README.md -----------------------------------------------------------
  await generate("README.md", () => {
    const readme = buildReadme(profileName);
    Deno.writeTextFileSync(join(outputDir, "README.md"), readme);
  });

  // Summary
  console.error(`\nPackage complete: ${succeeded} artifacts generated`);
  if (failed > 0) {
    console.error(`  ${failed} artifact(s) had warnings (see above)`);
  }
}
