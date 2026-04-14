/**
 * @fileoverview Diagram generator for YAMA documents.
 *
 * Two diagram styles:
 *   - Detail (default): ER-style tables showing descriptions as entities
 *     with their properties, and relationships as labeled edges.
 *   - Overview (`-f overview`): simplified graph showing descriptions as
 *     rounded boxes connected by labeled relationship edges.
 *
 * Output format is determined by the output file extension:
 *   .svg (default), .png, .dot/.gv, .ps/.eps, .json
 *
 * Color palette is controlled by the `-f` flag:
 *   color (default), bw, overview, overview-bw
 *
 * @module diagram
 */

import { parse as parseYaml } from "@std/yaml";
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { extname } from "@std/path";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { readInput } from "./io.js";

// ── Color palette ─────────────────────────────────────────────────

const COLOR = {
  headers: [
    "#FFCE9F", // peach
    "#B8D4E3", // soft blue
    "#C8E6C9", // sage green
    "#F8CECC", // rose
    "#D1C4E9", // lavender
    "#FFE0B2", // apricot
    "#B2DFDB", // mint
    "#F0F4C3", // lime
  ],
  headerText: "#000000",
  border: "#666666",
  bodyBg: "#ffffff",
  stripeBg: "#f5f5f5",
  bodyText: "#333333",
  typeText: "#666666",
  refText: "#1565C0",
  selfRefText: "#6A1B9A",
  cardText: "#888888",
  edgeColor: "#555555",
  edgeLabelBg: "#ffffff",
  edgeLabelText: "#333333",
  graphBg: "#ffffff",
};

const BW = {
  headers: ["#d9d9d9"],
  headerText: "#000000",
  border: "#000000",
  bodyBg: "#ffffff",
  stripeBg: "#f0f0f0",
  bodyText: "#000000",
  typeText: "#444444",
  refText: "#000000",
  selfRefText: "#000000",
  cardText: "#666666",
  edgeColor: "#000000",
  edgeLabelBg: "#ffffff",
  edgeLabelText: "#000000",
  graphBg: "#ffffff",
};

// ── Helpers ───────────────────────────────────────────────────────

function compactIRI(iri, namespaces) {
  if (!iri) return "";
  const ns = namespaces || {};
  // Already compact (prefix:localName) — check that prefix is a known namespace
  const colon = iri.indexOf(":");
  if (colon > 0 && !iri.startsWith("http") && !iri.startsWith("urn:")) {
    const prefix = iri.slice(0, colon);
    if (prefix in ns) return iri;
  }
  // Try to compact a full IRI against known namespaces
  for (const [prefix, nsUri] of Object.entries(ns)) {
    if (iri.startsWith(nsUri)) return `${prefix}:${iri.slice(nsUri.length)}`;
  }
  return iri;
}

/** Escape for HTML/XML content inside Graphviz HTML-like labels. */
function esc(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape for DOT double-quoted strings (node IDs, port names). */
function dotEsc(s) {
  if (!s) return "";
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatCard(min, max) {
  const lo = min != null ? String(min) : "0";
  const hi = max != null ? String(max) : "*";
  if (lo === hi) return lo;
  return `${lo}..${hi}`;
}

function typeLabel(stmtDef, ns) {
  if (stmtDef.description) return stmtDef.description;
  if (stmtDef.datatype) return compactIRI(stmtDef.datatype, ns);
  if (stmtDef.type === "IRI" || stmtDef.type === "URI") return "URI";
  if (stmtDef.type === "literal") return "Literal";
  if (stmtDef.type) return stmtDef.type;
  return "\u00A0";
}

// ── DOT generation ────────────────────────────────────────────────

function buildDot(doc, { mode = "color" } = {}) {
  const pal = mode === "bw" ? BW : COLOR;
  const ns = doc.namespaces || {};
  const descriptions = doc.descriptions || {};
  const descNames = Object.keys(descriptions);

  // Pre-scan for cross-references to determine layout
  const hasEdges = descNames.some((name) => {
    const stmts = descriptions[name].statements || {};
    return Object.values(stmts).some(
      (s) => s.description && s.description !== name && descNames.includes(s.description),
    );
  });

  const lines = [];
  lines.push("digraph YAMA {");
  lines.push(`  bgcolor="${pal.graphBg}";`);
  lines.push(`  rankdir=${hasEdges ? "LR" : "TB"};`);
  lines.push('  pad="0.6";');
  lines.push(`  nodesep=${hasEdges ? "1.0" : "0.5"};`);
  lines.push(`  ranksep=${hasEdges ? "3.0" : "0.8"};`);
  lines.push("  splines=curved;");
  lines.push('  fontname="Helvetica";');
  lines.push('  node [shape=plaintext fontname="Helvetica"];');
  lines.push('  edge [fontname="Helvetica" fontsize=9];');
  lines.push("");

  const edges = [];

  for (let di = 0; di < descNames.length; di++) {
    const descName = descNames[di];
    const descDef = descriptions[descName];
    const headerBg = pal.headers[di % pal.headers.length];
    const displayName = descDef.label || descName;
    const rdfClass = descDef.a ? compactIRI(descDef.a, ns) : "";

    const stmts = descDef.statements || {};
    const stmtEntries = Object.entries(stmts);

    let label = "<\n";
    label += `    <TABLE BORDER="2" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" COLOR="${pal.border}" BGCOLOR="${pal.bodyBg}">\n`;

    // Header with PORT for incoming edges
    label += `      <TR><TD COLSPAN="4" BGCOLOR="${headerBg}" CELLPADDING="8" ALIGN="CENTER" PORT="_header">`;
    label += `<FONT POINT-SIZE="14"><B>${esc(displayName)}</B></FONT>`;
    if (rdfClass) {
      label += `<BR/><FONT POINT-SIZE="10" COLOR="${pal.typeText}"><I>${esc(rdfClass)}</I></FONT>`;
    }
    label += "</TD></TR>\n";

    // Separator
    label += "      <HR/>\n";

    // Properties
    if (stmtEntries.length === 0) {
      label += `      <TR><TD COLSPAN="4" CELLPADDING="6"><FONT COLOR="${pal.cardText}" POINT-SIZE="9"><I>no properties</I></FONT></TD></TR>\n`;
    }

    for (let si = 0; si < stmtEntries.length; si++) {
      const [stmtKey, stmtDef] = stmtEntries[si];
      const propName = compactIRI(stmtDef.property, ns) || stmtKey;
      const card = formatCard(stmtDef.min, stmtDef.max);
      const type = typeLabel(stmtDef, ns);
      const rowBg = si % 2 === 1 ? pal.stripeBg : pal.bodyBg;

      const isRef = stmtDef.description && descNames.includes(stmtDef.description);
      const isSelfRef = isRef && stmtDef.description === descName;
      let typeCell;
      if (isSelfRef) {
        typeCell = `<FONT COLOR="${pal.selfRefText}" POINT-SIZE="9"><B>&#x21BA; ${esc(type)}</B></FONT>`;
      } else if (isRef) {
        typeCell = `<FONT COLOR="${pal.refText}" POINT-SIZE="9"><B>&#x2192; ${esc(type)}</B></FONT>`;
      } else {
        typeCell = `<FONT COLOR="${pal.typeText}" POINT-SIZE="9">${esc(type)}</FONT>`;
      }

      label += "      <TR>";
      label += `<TD BGCOLOR="${rowBg}" CELLPADDING="5" ALIGN="LEFT"><FONT COLOR="${pal.bodyText}" POINT-SIZE="10"><B>${esc(propName)}</B></FONT></TD>`;
      label += `<TD BGCOLOR="${rowBg}" CELLPADDING="5" ALIGN="LEFT">${typeCell}</TD>`;
      label += `<TD BGCOLOR="${rowBg}" CELLPADDING="5" ALIGN="RIGHT"><FONT COLOR="${pal.cardText}" POINT-SIZE="9">${esc(card)}</FONT></TD>`;
      label += `<TD BGCOLOR="${rowBg}" CELLPADDING="2" WIDTH="2" PORT="${esc(stmtKey)}"></TD>`;
      label += "</TR>\n";

      if (isRef && !isSelfRef) {
        edges.push({
          from: descName,
          fromPort: stmtKey,
          to: stmtDef.description,
          card,
          prop: propName,
        });
      }
    }

    label += "    </TABLE>\n  >";

    lines.push(`  "${dotEsc(descName)}" [label=${label}];`);
    lines.push("");
  }

  // Relationship edges: source port → target header
  for (const edge of edges) {
    lines.push(
      `  "${dotEsc(edge.from)}":"${dotEsc(edge.fromPort)}":e -> "${dotEsc(edge.to)}":"_header":w [` +
        `color="${pal.edgeColor}" ` +
        `penwidth=1.5 ` +
        `arrowhead=normal ` +
        `arrowsize=0.9 ` +
        `label=<` +
        `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="2">` +
        `<TR><TD BGCOLOR="${pal.edgeLabelBg}"><FONT FACE="Helvetica" POINT-SIZE="9" COLOR="${pal.edgeLabelText}">${esc(edge.prop)}  [${esc(edge.card)}]</FONT></TD></TR>` +
        `</TABLE>` +
        `> ` +
        `];`,
    );
  }

  lines.push("}");
  return lines.join("\n");
}

// ── Overview DOT generation ──────────────────────────────────────

function buildOverviewDot(doc, { mode = "color" } = {}) {
  const pal = mode === "bw" ? BW : COLOR;
  const ns = doc.namespaces || {};
  const descriptions = doc.descriptions || {};
  const descNames = Object.keys(descriptions);

  // Pre-collect self-refs per description
  const selfRefs = {};
  for (const descName of descNames) {
    selfRefs[descName] = [];
    const stmts = descriptions[descName].statements || {};
    for (const [stmtKey, stmtDef] of Object.entries(stmts)) {
      if (stmtDef.description === descName) {
        const propName = compactIRI(stmtDef.property, ns) || stmtKey;
        const card = formatCard(stmtDef.min, stmtDef.max);
        selfRefs[descName].push({ prop: propName, card });
      }
    }
  }

  const lines = [];
  lines.push("digraph YAMA {");
  lines.push(`  bgcolor="${pal.graphBg}";`);
  lines.push("  rankdir=LR;");
  lines.push('  pad="0.6";');
  lines.push("  nodesep=0.8;");
  lines.push("  ranksep=1.5;");
  lines.push("  splines=curved;");
  lines.push('  fontname="Helvetica";');
  lines.push('  node [shape=plaintext fontname="Helvetica"];');
  lines.push(`  edge [fontname="Helvetica" fontsize=10 color="${pal.edgeColor}" penwidth=1.5 arrowsize=0.9];`);
  lines.push("");

  const edges = [];
  const edgeMap = new Map();

  for (let di = 0; di < descNames.length; di++) {
    const descName = descNames[di];
    const descDef = descriptions[descName];
    const headerBg = pal.headers[di % pal.headers.length];
    const displayName = descDef.label || descName;
    const rdfClass = descDef.a ? compactIRI(descDef.a, ns) : "";
    const refs = selfRefs[descName];

    // Build HTML label with optional self-ref annotation
    let label = "<\n";
    label += `    <TABLE BORDER="2" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" COLOR="${pal.border}" BGCOLOR="${headerBg}">\n`;
    label += `      <TR><TD CELLPADDING="10" ALIGN="CENTER">`;
    label += `<FONT POINT-SIZE="13"><B>${esc(displayName)}</B></FONT>`;
    if (rdfClass) {
      label += `<BR/><FONT POINT-SIZE="11" COLOR="${pal.typeText}">${esc(rdfClass)}</FONT>`;
    }
    if (refs.length > 0) {
      for (const ref of refs) {
        label += `<BR/><FONT POINT-SIZE="9" COLOR="${pal.selfRefText}"><I>&#x21BA; ${esc(ref.prop)}  [${esc(ref.card)}]</I></FONT>`;
      }
    }
    label += `</TD></TR>\n`;
    label += `    </TABLE>\n  >`;

    lines.push(`  "${dotEsc(descName)}" [label=${label}];`);
    lines.push("");

    // Collect cross-references, merging duplicates to same target
    const stmts = descDef.statements || {};
    for (const [stmtKey, stmtDef] of Object.entries(stmts)) {
      if (stmtDef.description && stmtDef.description !== descName && descNames.includes(stmtDef.description)) {
        const propName = compactIRI(stmtDef.property, ns) || stmtKey;
        const card = formatCard(stmtDef.min, stmtDef.max);
        const key = `${descName}->${stmtDef.description}`;
        if (edgeMap.has(key)) {
          edgeMap.get(key).labels.push(`${propName}  [${card}]`);
        } else {
          const entry = { from: descName, to: stmtDef.description, labels: [`${propName}  [${card}]`] };
          edgeMap.set(key, entry);
          edges.push(entry);
        }
      }
    }
  }

  lines.push("");

  for (const edge of edges) {
    const labelRows = edge.labels
      .map((l) => `<TR><TD BGCOLOR="${pal.edgeLabelBg}"><FONT FACE="Helvetica" POINT-SIZE="10" COLOR="${pal.edgeLabelText}">${esc(l)}</FONT></TD></TR>`)
      .join("");
    const labelHtml = `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="2">${labelRows}</TABLE>`;
    lines.push(
      `  "${dotEsc(edge.from)}" -> "${dotEsc(edge.to)}" [label=<${labelHtml}>];`,
    );
  }

  lines.push("}");
  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Generate a diagram from a YAMA file.
 *
 * Output format is determined by file extension:
 *   .svg  — rendered SVG (via WASM Graphviz, default)
 *   .png  — rasterised PNG (via resvg WASM)
 *   .dot  — raw Graphviz DOT source
 *   .gv   — raw Graphviz DOT source
 *   .ps   — PostScript (via WASM Graphviz)
 *   .eps  — Encapsulated PostScript (via WASM Graphviz)
 *   .json — Graphviz JSON (via WASM Graphviz)
 *
 * @param {string} file - Input YAMA file path.
 * @param {object} opts
 * @param {string} [opts.output] - Output file path (stdout if omitted).
 * @param {string} [opts.format] - "color" (default), "bw", "overview", or "overview-bw".
 * @returns {Promise<void>}
 */
export async function generateDiagram(file, { output, format } = {}) {
  const text = await readInput(file);
  const doc = parseYaml(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${file}: not a valid YAMA document`);
  }
  const fmt = (format || "color").toLowerCase();
  const isOverview = fmt === "overview" || fmt === "overview-bw";
  const mode = (fmt === "bw" || fmt === "overview-bw") ? "bw" : "color";
  const dot = isOverview
    ? buildOverviewDot(doc, { mode })
    : buildDot(doc, { mode });

  const ext = output ? extname(output).toLowerCase() : ".svg";

  if (ext === ".dot" || ext === ".gv") {
    if (output) {
      await Deno.writeTextFile(output, dot);
      console.error(`Written to ${output}`);
    } else {
      Deno.stdout.writeSync(new TextEncoder().encode(dot));
    }
    return;
  }

  // Render SVG first (needed for PNG too)
  const graphviz = await Graphviz.load();

  if (ext === ".png") {
    const svg = graphviz.dot(dot, "svg");
    const png = await svgToPng(svg);
    if (output) {
      await Deno.writeFile(output, png);
      console.error(`Written to ${output}`);
    } else {
      Deno.stdout.writeSync(png);
    }
    return;
  }

  const formatMap = {
    ".svg": "svg",
    ".ps": "ps",
    ".eps": "eps",
    ".json": "json",
  };

  const gvFormat = formatMap[ext] || "svg";
  const result = graphviz.dot(dot, gvFormat);

  if (output) {
    await Deno.writeTextFile(output, result);
    console.error(`Written to ${output}`);
  } else {
    Deno.stdout.writeSync(new TextEncoder().encode(result));
  }
}

// ── DOT rendering (render pre-existing DOT files) ───────────────

/**
 * Render a DOT file to SVG, PNG, PS, EPS, or JSON using Graphviz WASM.
 *
 * This allows users to export DOT from Tapir (the web editor) and
 * render it to publication-quality output on the CLI without installing
 * Graphviz separately.
 *
 * @param {string} file - Input DOT file path.
 * @param {object} opts
 * @param {string} [opts.output] - Output file path (stdout if omitted).
 *        Format is determined by extension: .svg, .png, .ps, .eps, .json
 * @returns {Promise<void>}
 */
export async function renderDot(file, { output } = {}) {
  const dot = await readInput(file);

  const ext = output ? extname(output).toLowerCase() : ".svg";

  // Load Graphviz WASM
  const graphviz = await Graphviz.load();

  if (ext === ".png") {
    const svg = graphviz.dot(dot, "svg");
    const png = await svgToPng(svg);
    if (output) {
      await Deno.writeFile(output, png);
      console.error(`Written to ${output}`);
    } else {
      Deno.stdout.writeSync(png);
    }
    return;
  }

  const formatMap = {
    ".svg": "svg",
    ".ps": "ps",
    ".eps": "eps",
    ".json": "json",
    ".dot": "dot",
    ".gv": "dot",
  };

  const gvFormat = formatMap[ext] || "svg";
  const result = graphviz.dot(dot, gvFormat);

  if (output) {
    await Deno.writeTextFile(output, result);
    console.error(`Written to ${output}`);
  } else {
    Deno.stdout.writeSync(new TextEncoder().encode(result));
  }
}

// ── PNG conversion ───────────────────────────────────────────────

const FONT_PATHS = {
  darwin: [
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/SFNS.ttf",
  ],
  linux: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  ],
  windows: [
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\arialuni.ttf",
  ],
};

let wasmInitPromise = null;

async function loadFonts() {
  const os = Deno.build.os;
  const candidates = FONT_PATHS[os] || FONT_PATHS.linux;
  const buffers = [];
  for (const path of candidates) {
    try {
      buffers.push(await Deno.readFile(path));
    } catch {
      // font not available, skip
    }
  }
  return buffers;
}

async function svgToPng(svg) {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const wasmUrl = new URL(
        import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm"),
      );
      await initWasm(await Deno.readFile(wasmUrl));
    })();
  }
  await wasmInitPromise;

  const fontBuffers = await loadFonts();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 4800 },
    font: {
      fontBuffers,
      defaultFontFamily: "Helvetica",
    },
  });
  return resvg.render().asPng();
}
