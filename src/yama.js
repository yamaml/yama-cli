/// <reference types="./yama.d.ts" />
/**
 * @fileoverview YAMA CLI entry point.
 *
 * Parses command-line arguments and dispatches to the appropriate
 * generator module.
 *
 * @example
 *   yama rdf -i input.yaml
 *   yama rdf -i input.yaml -f jsonld -o out.jsonld
 *   yama shacl -i input.yaml
 *   yama shex -i input.yaml -o out.shex
 *   yama dctap -i input.yaml -o profile.csv
 *   yama from-dctap -i profile.csv -o output.yaml
 *   yama from-shacl -i shapes.ttl -o profile.yaml
 *   yama from-shex -i shapes.shex -o profile.yaml
 *   yama dsp -i input.yaml -f jsonld -o out.jsonld
 *   yama simpledsp -i input.yaml -o profile.tsv
 *   yama from-simpledsp -i profile.tsv -o output.yaml
 *   yama vocab -i input.yaml -o vocab.ttl
 *   yama diagram -i input.yaml -o diagram.svg
 *   yama diagram -i input.yaml -o diagram.png -f overview
 *   yama report -i input.yaml -o profile.html
 *   yama report -i input.yaml -o profile.md
 *   yama json -i input.yaml -o out.json
 *   yama datapackage -i input.yaml -o datapackage.json
 *
 * @module yama-cli
 * @see https://www.yamaml.org
 */

import { parseArgs } from "@std/cli/parse-args";
import { generateRDF } from "./modules/rdf.js";
import { generateSHACL } from "./modules/shacl.js";
import { generateShEx } from "./modules/shex.js";
import { generateJSON } from "./modules/json.js";
import { generateDataPackage } from "./modules/datapackage.js";
import { exportDCTAP, importDCTAP } from "./modules/dctap.js";
import { generateDSP, exportSimpleDSP, importSimpleDSP } from "./modules/dsp.js";
import { generateDiagram, renderDot } from "./modules/diagram.js";
import { SUPPORTED_FORMATS } from "./modules/serialize.js";
import { validateFile } from "./modules/validate.js";
import { formatHuman, formatJson } from "./modules/format-report.js";
import { scaffoldProject } from "./modules/init.js";
import { generateHtmlReport, generateMarkdownReport } from "./modules/report.js";
import { generatePackage } from "./modules/package.js";
import { importSHACL } from "./modules/from-shacl.js";
import { importShEx } from "./modules/from-shex.js";
import { generateVocab } from "./modules/vocab.js";

const VERSION = "1.0.1";

// ---------------------------------------------------------------------------
// Argument parsing — short flags with long aliases
// Note: -f (RDF format) and --format (validate output) are intentionally
// separate to avoid conflicts.
// ---------------------------------------------------------------------------

const args = parseArgs(Deno.args, {
  string: ["i", "o", "f", "l", "format", "input-format", "name", "ns", "base"],
  boolean: ["help", "h", "version", "v", "quiet", "q"],
  alias: {
    i: "input",
    o: "output",
    l: "lang",
    h: "help",
    v: "version",
    q: "quiet",
  },
});

// ---------------------------------------------------------------------------
// Per-subcommand help text
// ---------------------------------------------------------------------------

const SUBCOMMAND_HELP = {
  init: `yama init — Scaffold a new YAMA YAML file

Usage: yama init -o <file> [options]

Options:
  --name    Profile name (default: "My Profile")
  --ns      Comma-separated namespace prefixes (e.g. schema,dcterms)
  --base    Base URI for the profile

Examples:
  yama init -o my-profile.yaml
  yama init -o catalog.yaml --name "Library Catalog" --ns schema,dcterms,foaf --base http://example.org/library/`,

  validate: `yama validate — Validate a YAMA, SimpleDSP, or DCTAP file

Usage: yama validate -i <file> [options]

Options:
  --format         Output format: human (default) or json
  --input-format   Force input format: yaml, simpledsp, or dctap
  -o               Write report to file instead of stdout

Examples:
  yama validate -i profile.yaml
  yama validate -i profile.tsv
  yama validate -i data.csv --input-format dctap
  yama validate -i profile.yaml --format json -o report.json

Exit codes: 0 = valid, 1 = errors found`,

  report: `yama report — Generate profile documentation

Usage: yama report -i <file> -o <output.html|output.md>

Accepts any input format (YAML, SimpleDSP, DCTAP). Output format is determined by file extension.

Options:
  --input-format   Force input format: yaml, simpledsp, or dctap

Examples:
  yama report -i profile.yaml -o profile.html
  yama report -i profile.tsv -o profile.html
  yama report -i profile.yaml -o profile.md`,

  package: `yama package — Generate a complete profile package

Usage: yama package -i <file> -o <directory/>

Generates 14 artifacts: HTML report, Markdown, YAML, JSON, SimpleDSP (EN+JP), DCTAP, SHACL, ShEx, OWL-DSP, diagrams (overview+detail), Data Package.

Options:
  --input-format   Force input format: yaml, simpledsp, or dctap

Examples:
  yama package -i profile.yaml -o my-profile/
  yama package -i catalog.tsv -o catalog-package/`,

  rdf: `yama rdf — Generate RDF from a YAMA file with data mappings

Usage: yama rdf -i <file> [-o <output>] [-f <format>]

Options:
  -f   Output format: turtle (default), jsonld, ntriples, nquads, trig

Examples:
  yama rdf -i profile.yaml
  yama rdf -i profile.yaml -f jsonld -o output.jsonld`,

  shacl: `yama shacl — Generate SHACL shapes

Usage: yama shacl -i <file> [-o <output>] [-f <format>]

Examples:
  yama shacl -i profile.yaml -o shapes.ttl
  yama shacl -i profile.yaml -f jsonld`,

  shex: `yama shex — Generate ShEx shapes

Usage: yama shex -i <file> [-o <output>]

Examples:
  yama shex -i profile.yaml -o shapes.shex`,

  simpledsp: `yama simpledsp — Export to SimpleDSP format

Usage: yama simpledsp -i <file> [-o <output>] [-l <lang>]

Options:
  -l   Language: en (default) or jp (Japanese headers and value types)

Examples:
  yama simpledsp -i profile.yaml -o profile.tsv
  yama simpledsp -i profile.yaml -o profile.xlsx
  yama simpledsp -i profile.yaml -o profile.tsv -l jp`,

  "from-simpledsp": `yama from-simpledsp — Import SimpleDSP to YAMA

Usage: yama from-simpledsp -i <file> [-o <output>]

Accepts .tsv, .csv, .xlsx input.

Examples:
  yama from-simpledsp -i profile.tsv -o profile.yaml
  yama from-simpledsp -i profile.xlsx -o profile.yaml`,

  dctap: `yama dctap — Export to DCTAP format

Usage: yama dctap -i <file> [-o <output>]

Examples:
  yama dctap -i profile.yaml -o profile.csv`,

  "from-dctap": `yama from-dctap — Import DCTAP to YAMA

Usage: yama from-dctap -i <file> [-o <output>]

Examples:
  yama from-dctap -i profile.csv -o profile.yaml`,

  "from-shacl": `yama from-shacl — Import SHACL shapes to YAMA

Usage: yama from-shacl -i <shapes.ttl> [-o <output>]

Examples:
  yama from-shacl -i shapes.ttl -o profile.yaml`,

  "from-shex": `yama from-shex — Import ShEx shapes to YAMA

Usage: yama from-shex -i <shapes.shex> [-o <output>]

Examples:
  yama from-shex -i shapes.shex -o profile.yaml`,

  vocab: `yama vocab — Generate RDF vocabulary/ontology

Usage: yama vocab -i <file> [-o <output>] [-f <format>]

Generates classes and properties defined in the profile as an RDF vocabulary.

Examples:
  yama vocab -i profile.yaml
  yama vocab -i profile.yaml -o vocab.ttl
  yama vocab -i profile.yaml -f jsonld`,

  dsp: `yama dsp — Generate OWL-DSP

Usage: yama dsp -i <file> [-o <output>] [-f <format>]

Examples:
  yama dsp -i profile.yaml -o dsp.ttl`,

  diagram: `yama diagram — Generate diagrams

Usage: yama diagram -i <file> [-o <output>] [-f <style>]

Output format determined by extension:
  .svg   vector SVG (default)
  .pdf   vector PDF — selectable text, LaTeX-friendly, archival
  .png   rasterised bitmap
  .dot   raw Graphviz DOT source
  .ps    PostScript
  .eps   Encapsulated PostScript
  .json  Graphviz JSON

Styles: color (default), bw, overview, overview-bw

Examples:
  yama diagram -i profile.yaml -o diagram.svg
  yama diagram -i profile.yaml -o diagram.pdf
  yama diagram -i profile.yaml -o diagram.png -f overview-bw`,

  render: `yama render — Render DOT to SVG/PNG/PDF (no Graphviz needed)

Usage: yama render -i <file.dot> [-o <output>]

Output format determined by extension: .svg, .pdf, .png, .ps, .eps, .json

Examples:
  yama render -i diagram.dot -o diagram.svg
  yama render -i diagram.dot -o diagram.pdf`,

  datapackage: `yama datapackage — Generate Frictionless Data Package

Usage: yama datapackage -i <file> [-o <output>]

Examples:
  yama datapackage -i profile.yaml -o datapackage.json`,

  json: `yama json — Convert to JSON

Usage: yama json -i <file> [-o <output>]

Examples:
  yama json -i profile.yaml -o profile.json`,
};

// ---------------------------------------------------------------------------
// Typo suggestion helpers (Levenshtein distance)
// ---------------------------------------------------------------------------

/**
 * Computes the Levenshtein edit distance between two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Finds the closest match to `input` from a list of candidates.
 *
 * @param {string} input
 * @param {string[]} candidates
 * @param {number} [maxDistance=3]
 * @returns {string|null}
 */
function findClosest(input, candidates, maxDistance = 3) {
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase());
    if (d < bestDist && d <= maxDistance) { bestDist = d; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

let cmd = args._[0] || "help";
if (args.version || args.v) cmd = "version";
if (args.help || args.h) cmd = "help";

// Per-subcommand --help: `yama <command> --help` shows that command's help
if ((args.help || args.h) && args._[0] && SUBCOMMAND_HELP[args._[0]]) {
  console.log(SUBCOMMAND_HELP[args._[0]]);
  Deno.exit(0);
}

/**
 * Exits with an error if the required `-i` flag is missing.
 */
function requireInput() {
  if (!args.i) {
    console.error("Error: input file required. Use -i <path>");
    Deno.exit(1);
  }
}

/**
 * Runs an async command with clean error handling.
 *
 * @param {() => Promise<void>} fn
 */
async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(`Error: file not found - ${err.message.split(":").pop().trim()}`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    Deno.exit(1);
  }
}

switch (cmd) {
  case "rdf":
    requireInput();
    await run(() => generateRDF(args.i, { output: args.o, format: args.f }));
    break;

  case "shacl":
    requireInput();
    await run(() => generateSHACL(args.i, { output: args.o, format: args.f }));
    break;

  case "shex":
    requireInput();
    await run(() => generateShEx(args.i, args.o));
    break;

  case "json":
    requireInput();
    await run(() => generateJSON(args.i, args.o));
    break;

  case "dctap":
    requireInput();
    await run(() => exportDCTAP(args.i, args.o));
    break;

  case "from-dctap":
    requireInput();
    await run(() => importDCTAP(args.i, args.o));
    break;

  case "from-shacl":
    requireInput();
    await run(() => importSHACL(args.i, args.o));
    break;

  case "from-shex":
    requireInput();
    await run(() => importShEx(args.i, args.o));
    break;

  case "dsp":
    requireInput();
    await run(() => generateDSP(args.i, { output: args.o, format: args.f }));
    break;

  case "simpledsp":
    requireInput();
    await run(() => exportSimpleDSP(args.i, args.o, { lang: args.l }));
    break;

  case "from-simpledsp":
    requireInput();
    await run(() => importSimpleDSP(args.i, args.o));
    break;

  case "diagram":
    requireInput();
    await run(() => generateDiagram(args.i, { output: args.o, format: args.f }));
    break;

  case "datapackage":
    requireInput();
    await run(() => generateDataPackage(args.i, args.o));
    break;

  case "render":
    requireInput();
    await run(() => renderDot(args.i, { output: args.o }));
    break;

  case "report":
    requireInput();
    await run(async () => {
      const { parse: parseYaml } = await import("@std/yaml");
      const { readInput } = await import("./modules/io.js");
      const { readSimpleDsp, simpleDspToYama } = await import("./modules/dsp.js");
      const { readTabular, rowsToYama } = await import("./modules/dctap.js");
      const { Graphviz } = await import("@hpcc-js/wasm-graphviz");

      // Detect input format
      const ext = args.i.split(".").pop()?.toLowerCase();
      const inputFormat = args["input-format"] || null;
      let doc;
      let isDctap = false;

      if (inputFormat === "dctap" || (!inputFormat && ext === "csv")) {
        // Check if it's actually SimpleDSP CSV
        isDctap = inputFormat === "dctap";
        if (!inputFormat && ext === "csv") {
          const text = await readInput(args.i);
          const firstLine = text.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
          if (firstLine?.trim().startsWith("[")) {
            isDctap = false;
          } else {
            const lower = firstLine?.toLowerCase() || "";
            isDctap = lower.includes("propertyid") || lower.includes("shapeid");
          }
        }
        if (isDctap) {
          const rows = await readTabular(args.i);
          doc = rowsToYama(rows);
        } else {
          const { blocks, namespaces } = await readSimpleDsp(args.i);
          doc = simpleDspToYama(blocks, namespaces);
        }
      } else if (
        inputFormat === "simpledsp" ||
        ext === "tsv" ||
        ext === "xlsx" ||
        ext === "xls"
      ) {
        const { blocks, namespaces } = await readSimpleDsp(args.i);
        doc = simpleDspToYama(blocks, namespaces);
      } else {
        // Default: YAML
        const text = await readInput(args.i);
        doc = parseYaml(text);
      }

      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error(`${args.i}: not a valid profile document`);
      }

      // Determine flavor from detected input format
      const flavor = (inputFormat === "dctap" || (!inputFormat && isDctap))
        ? "dctap"
        : "simpledsp";

      // Determine output format from extension
      const outExt = args.o ? args.o.split(".").pop()?.toLowerCase() : "html";
      const isMd = outExt === "md";

      let result;
      if (isMd) {
        result = generateMarkdownReport(doc, args.i, flavor);
      } else {
        // Generate SVG diagram for HTML
        // Use the internal buildDot approach from diagram.js
        const ns = doc.namespaces || {};
        const descriptions = doc.descriptions || {};
        const descNames = Object.keys(descriptions);

        // Build a minimal DOT for the overview diagram
        // Re-implement inline to avoid exporting internals from diagram.js
        let svgDiagram = "";
        try {
          // Dynamically build DOT source (simplified overview)
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

          const headerColors = [
            "#FFCE9F", "#B8D4E3", "#C8E6C9", "#F8CECC",
            "#D1C4E9", "#FFE0B2", "#B2DFDB", "#F0F4C3",
          ];
          const edges = [];
          const edgeMap = new Map();

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

          const graphviz = await Graphviz.load();
          svgDiagram = graphviz.dot(dotLines.join("\n"), "svg");
        } catch {
          // Diagram generation is optional — continue without it
          svgDiagram = "";
        }

        result = generateHtmlReport(doc, svgDiagram, args.i, flavor);
      }

      if (args.o) {
        await Deno.writeTextFile(args.o, result);
        console.error(`Report written to ${args.o}`);
      } else {
        console.log(result);
      }
    });
    break;

  case "package":
    requireInput();
    if (!args.o) {
      console.error("Error: output directory required. Use -o <path>");
      Deno.exit(1);
    }
    await run(() => generatePackage(args.i, args.o, { inputFormat: args["input-format"] }));
    break;

  case "vocab":
    requireInput();
    await run(() => generateVocab(args.i, { output: args.o, format: args.f }));
    break;

  case "validate":
    requireInput();
    await run(async () => {
      const report = await validateFile(args.i, {
        inputFormat: args["input-format"],
      });
      const output = args.format === "json"
        ? formatJson(report)
        : formatHuman(report);
      if (args.o) {
        Deno.writeTextFileSync(args.o, output);
        console.error(`Report written to ${args.o}`);
      } else {
        console.log(output);
      }
      if (!report.valid) Deno.exit(1);
    });
    break;

  case "init":
    await run(() =>
      scaffoldProject({
        output: args.o,
        name: args.name,
        ns: args.ns,
        base: args.base,
      })
    );
    break;

  case "version":
    console.log(`yama-cli v${VERSION}`);
    break;

  case "help": {
    const subcmd = args._[1];
    if (subcmd && SUBCOMMAND_HELP[subcmd]) {
      console.log(SUBCOMMAND_HELP[subcmd]);
    } else {
      console.log(`yama-cli v${VERSION} — YAMAML CLI toolkit

Examples:
  yama validate -i profile.yaml              Validate a profile
  yama report -i profile.yaml -o report.html Generate HTML documentation
  yama package -i profile.yaml -o dist/      Generate all artifacts
  yama simpledsp -i profile.yaml -o out.tsv  Export to SimpleDSP
  yama init -o new-profile.yaml              Create a new profile

Usage: yama <command> -i <input|url> [-o <output>] [-f <format>]

Commands:
  init            Scaffold a new YAMA YAML file
  package         Generate a complete profile package folder
  rdf             Generate RDF from a YAMA file
  shacl           Generate SHACL shapes from a YAMA file
  shex            Generate ShEx from a YAMA file
  dctap           Export YAMA to DCTAP (csv, tsv, xlsx)
  from-dctap      Import DCTAP (csv, tsv, xlsx) to YAMA
  from-shacl      Import SHACL shapes (Turtle) to YAMA
  from-shex       Import ShEx shapes to YAMA
  dsp             Generate OWL-DSP from a YAMA file
  simpledsp       Export YAMA to SimpleDSP (tsv, csv, xlsx)
  from-simpledsp  Import SimpleDSP (tsv, csv, xlsx) to YAMA
  vocab           Generate an RDF vocabulary/ontology from a YAMA file
  diagram         Generate a diagram (svg, pdf, png, dot, ps, eps, json)
  render          Render a DOT file to SVG/PNG (no Graphviz needed)
  report          Generate profile documentation (html, md)
  datapackage     Generate a Frictionless Data Package descriptor
  json            Convert a YAMA file to JSON
  validate        Validate a YAMA, SimpleDSP, or DCTAP file

Options:
  -i, --input    Input YAMA file or URL (required)
  -o, --output   Output file path (optional; stdout if omitted)
                 diagram: output format is determined by extension
                          (.svg, .png, .dot, .gv, .ps, .eps, .json)
  -f             Output format:
                 rdf/shacl/dsp: ${SUPPORTED_FORMATS.join(", ")}
                 diagram: color (default), bw, overview, overview-bw
  -l, --lang     Language for SimpleDSP headers: en (default), jp
  -q, --quiet    Suppress status messages
  --name         init: profile name (default: "My Profile")
  --ns           init: comma-separated namespace prefixes (default: schema,dcterms)
  --base         init: base URI
  --format       validate: output format (human or json)
  --input-format validate/report/package: force input format (yaml, simpledsp, dctap)
  -h, --help     Show this help (or help for a specific command)
  -v, --version  Show version

Run "yama help <command>" for detailed help on any command.

More: https://www.yamaml.org`);
    }
    break;
  }

  default: {
    const commands = [
      "init", "package", "rdf", "shacl", "shex", "dctap", "from-dctap",
      "from-shacl", "from-shex", "dsp", "simpledsp", "from-simpledsp", "vocab",
      "diagram", "render", "report", "datapackage", "json", "validate", "help", "version",
    ];
    const suggestion = findClosest(cmd, commands);
    console.error(`Unknown command: "${cmd}".`);
    if (suggestion) {
      console.error(`Did you mean "${suggestion}"?`);
    }
    console.error(`Run "yama --help" for a list of commands.`);
    Deno.exit(1);
  }
}
