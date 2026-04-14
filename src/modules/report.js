/**
 * @fileoverview Profile documentation generator for YAMA.
 *
 * Produces standalone single-page HTML or Markdown reports documenting
 * a YAMA application profile. HTML uses Pico CSS (classless) for
 * styling via CDN link, requiring no build step.
 *
 * Both generators accept an optional `flavor` parameter ("simpledsp"
 * or "dctap") that controls column headers, section titles, cardinality
 * display, and value-type terminology.
 *
 * Two exports:
 *   - `generateHtmlReport(doc, svgDiagram, filePath, flavor)` — HTML string
 *   - `generateMarkdownReport(doc, filePath, flavor)` — Markdown string
 *
 * @module report
 */

// ---------------------------------------------------------------------------
// Standard prefix table (mirrors dsp.js STANDARD_PREFIXES)
// ---------------------------------------------------------------------------

const STANDARD_PREFIXES = {
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  xl: "http://www.w3.org/2008/05/skos-xl#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  schema: "https://schema.org/",
};

// ---------------------------------------------------------------------------
// Flavor label definitions
// ---------------------------------------------------------------------------

const FLAVOR_LABELS = {
  simpledsp: {
    specName: "SimpleDSP",
    descriptionPlural: "Description Templates",
    descriptionSingular: "Description Template",
    columns: ["Name", "Property", "Min", "Max", "Type", "Constraint", "Note"],
    valueTypes: { literal: "literal", iri: "IRI", bnode: "bnode", structured: "structured" },
  },
  dctap: {
    specName: "DCTAP",
    descriptionPlural: "Shapes",
    descriptionSingular: "Shape",
    columns: ["propertyLabel", "propertyID", "mandatory", "repeatable", "valueNodeType", "valueConstraint", "note"],
    valueTypes: { literal: "literal", iri: "IRI", bnode: "bnode" },
  },
};

/**
 * Returns the flavor labels for a given flavor string.
 *
 * @param {string} [flavor] - "simpledsp" or "dctap".
 * @returns {Object} Flavor label object.
 */
function getLabels(flavor) {
  return FLAVOR_LABELS[flavor] || FLAVOR_LABELS.simpledsp;
}

/**
 * Formats cardinality for DCTAP flavor (TRUE/FALSE booleans).
 *
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 * @returns {{ mandatory: string, repeatable: string }}
 */
function formatDctapCard(min, max) {
  const mandatory = (min != null && min >= 1) ? "TRUE" : "FALSE";
  const repeatable = (max == null || max > 1 || max === 0) ? "TRUE" : "FALSE";
  return { mandatory, repeatable };
}

/**
 * Maps internal type strings to flavor-appropriate display strings.
 *
 * @param {string} type - Internal type string.
 * @param {Object} labels - Flavor labels.
 * @returns {string}
 */
function mapValueType(type, labels) {
  if (!type) return "";
  const lower = type.toLowerCase();
  if (lower === "iri" || lower === "uri") return labels.valueTypes.iri || "IRI";
  if (lower === "literal") return labels.valueTypes.literal || "literal";
  if (lower === "bnode") return labels.valueTypes.bnode || "bnode";
  if (lower === "structured" && labels.valueTypes.structured) return labels.valueTypes.structured;
  if (lower === "structured" && !labels.valueTypes.structured) return "";
  return type;
}

// ---------------------------------------------------------------------------
// IRI helpers
// ---------------------------------------------------------------------------

/**
 * Expands a prefixed term to a full IRI using document + standard namespaces.
 *
 * @param {string} term - Prefixed term (e.g. "dcterms:title").
 * @param {Object} namespaces - Document namespace map.
 * @param {string} [base] - Document base IRI.
 * @returns {string|null} Full IRI or null.
 */
function expandPrefixed(term, namespaces, base) {
  if (!term) return null;
  if (/^(https?|urn):/.test(term)) return term;

  const colon = term.indexOf(":");
  if (colon >= 0) {
    const prefix = term.substring(0, colon);
    const local = term.substring(colon + 1);
    const allNs = { ...STANDARD_PREFIXES, ...namespaces };
    if (allNs[prefix]) return allNs[prefix] + local;
  }

  return base ? base + term : term;
}

/**
 * Escapes a string for safe use in HTML content.
 *
 * @param {string} s
 * @returns {string}
 */
function escHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Formats a cardinality pair as a human-readable string.
 *
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 * @returns {string}
 */
function formatCard(min, max) {
  const lo = min != null ? String(min) : "0";
  const hi = max != null ? String(max) : "*";
  if (lo === hi) return lo;
  return `${lo}..${hi}`;
}

/**
 * Resolves the display type for a statement.
 *
 * @param {Object} stmtDef - Statement definition.
 * @param {Object} namespaces - Document namespaces.
 * @returns {string}
 */
function resolveType(stmtDef, namespaces) {
  if (stmtDef.datatype) return stmtDef.datatype;
  if (stmtDef.type === "IRI" || stmtDef.type === "URI") return "IRI";
  if (stmtDef.type === "literal") return "Literal";
  if (stmtDef.type) return stmtDef.type;
  return "";
}

/**
 * Resolves the constraint display string for a statement.
 *
 * @param {Object} stmtDef
 * @param {Object} namespaces
 * @returns {string}
 */
function resolveConstraint(stmtDef, namespaces) {
  if (stmtDef.description) return stmtDef.description;
  if (stmtDef.a) {
    const classes = Array.isArray(stmtDef.a) ? stmtDef.a : [stmtDef.a];
    return classes.join(", ");
  }
  if (stmtDef.inScheme) {
    const schemes = Array.isArray(stmtDef.inScheme)
      ? stmtDef.inScheme
      : [stmtDef.inScheme];
    return schemes.join(", ");
  }
  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    return stmtDef.values.map((v) => `"${v}"`).join(", ");
  }
  if (stmtDef.pattern) return `/${stmtDef.pattern}/`;
  return "";
}

/**
 * Creates a slug suitable for HTML IDs from a description name.
 *
 * @param {string} name
 * @returns {string}
 */
function descSlug(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

/**
 * Returns the current date as ISO date string (YYYY-MM-DD).
 *
 * @returns {string}
 */
function today() {
  return new Date().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

/**
 * Generates a standalone HTML report for a YAMA application profile.
 *
 * Uses Pico CSS classless variant via CDN for zero-config styling.
 * The SVG diagram is embedded inline in a `<figure>` element.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @param {string} svgDiagram - SVG string for the overview diagram.
 * @param {string} filePath - Source file path (for display).
 * @param {string} [flavor] - "simpledsp" or "dctap".
 * @returns {string} Complete HTML document.
 */
export function generateHtmlReport(doc, svgDiagram, filePath, flavor) {
  const labels = getLabels(flavor);
  const isDctap = flavor === "dctap";
  const namespaces = doc.namespaces || {};
  const allNs = { ...STANDARD_PREFIXES, ...namespaces };
  const base = doc.base || "";
  const descriptions = doc.descriptions || {};
  const descNames = Object.keys(descriptions);
  const profileName = filePath
    ? filePath.split("/").pop().replace(/\.\w+$/, "")
    : "Profile";
  const date = today();

  const lines = [];

  // ── Head ──

  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="en">');
  lines.push("<head>");
  lines.push('  <meta charset="utf-8">');
  lines.push('  <meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push(`  <title>${escHtml(profileName)} — Application Profile (${labels.specName})</title>`);
  lines.push('  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css">');
  lines.push("  <style>");
  lines.push("    figure svg { max-width: 100%; height: auto; }");
  lines.push("    table { font-size: 0.9em; }");
  lines.push("    code { font-size: 0.85em; }");
  lines.push("  </style>");
  lines.push("</head>");
  lines.push("<body>");

  // ── Header ──

  lines.push("<header>");
  lines.push(`  <h1>${escHtml(profileName)}</h1>`);
  lines.push(`  <p>Application Profile (${labels.specName}) · Generated ${date}</p>`);
  if (base) {
    lines.push(`  <p>Base: <a href="${escHtml(base)}"><code>${escHtml(base)}</code></a></p>`);
  }
  lines.push("</header>");

  // ── Main ──

  lines.push("<main>");

  // ── Table of Contents ──

  lines.push("<nav>");
  lines.push("  <h2>Contents</h2>");
  lines.push("  <ul>");
  if (svgDiagram) {
    lines.push('    <li><a href="#overview">Overview Diagram</a></li>');
  }
  lines.push('    <li><a href="#namespaces">Namespaces</a></li>');
  for (const descName of descNames) {
    const descDef = descriptions[descName];
    const displayName = descDef.label || descName;
    const slug = descSlug(descName);
    lines.push(`    <li><a href="#desc-${slug}">${escHtml(displayName)}</a></li>`);
  }
  lines.push("  </ul>");
  lines.push("</nav>");

  // ── Overview Diagram ──

  if (svgDiagram) {
    lines.push('<section id="overview">');
    lines.push("  <h2>Overview Diagram</h2>");
    lines.push("  <figure>");
    lines.push(`    ${svgDiagram}`);
    lines.push("  </figure>");
    lines.push("</section>");
  }

  // ── Namespaces ──

  lines.push('<section id="namespaces">');
  lines.push("  <h2>Namespaces</h2>");
  lines.push("  <table>");
  lines.push("    <thead><tr><th>Prefix</th><th>Namespace URI</th></tr></thead>");
  lines.push("    <tbody>");
  for (const [prefix, uri] of Object.entries(namespaces)) {
    lines.push(
      `      <tr><td><a id="ns-${escHtml(prefix)}"><code>${escHtml(prefix)}</code></a></td>` +
      `<td><a href="${escHtml(uri)}"><code>${escHtml(uri)}</code></a></td></tr>`,
    );
  }
  lines.push("    </tbody>");
  lines.push("  </table>");
  lines.push("</section>");

  // ── Description sections ──

  for (const descName of descNames) {
    const descDef = descriptions[descName];
    const displayName = descDef.label || descName;
    const slug = descSlug(descName);
    const statements = descDef.statements || {};

    lines.push(`<section id="desc-${slug}">`);
    lines.push(`  <h2>${escHtml(displayName)}</h2>`);

    // Target class
    if (descDef.a) {
      const classIri = expandPrefixed(descDef.a, namespaces, base);
      lines.push(
        `  <p>Target class: <a href="${escHtml(classIri || "")}"><code>${escHtml(descDef.a)}</code></a></p>`,
      );
    }

    // Description note
    if (descDef.note) {
      lines.push(`  <p>${escHtml(descDef.note)}</p>`);
    }

    // Statements table
    const stmtEntries = Object.entries(statements);
    if (stmtEntries.length > 0) {
      const cols = labels.columns;
      lines.push("  <table>");
      lines.push("    <thead><tr>");
      lines.push(`      ${cols.map((c) => `<th>${escHtml(c)}</th>`).join("")}`);
      lines.push("    </tr></thead>");
      lines.push("    <tbody>");

      for (const [stmtKey, stmtDef] of stmtEntries) {
        const stmtName = stmtDef.label || stmtKey;
        const property = stmtDef.property || "";
        const propertyIri = expandPrefixed(property, namespaces, base);
        const rawType = resolveType(stmtDef, namespaces);
        const type = rawType.includes(":") ? rawType : mapValueType(rawType, labels);
        const constraint = resolveConstraint(stmtDef, namespaces);
        const note = stmtDef.note || "";

        // Property cell: linked to external URI
        const propertyCell = propertyIri
          ? `<a href="${escHtml(propertyIri)}"><code>${escHtml(property)}</code></a>`
          : `<code>${escHtml(property)}</code>`;

        // Constraint cell: shape references link internally, others are plain
        let constraintCell;
        if (stmtDef.description && descNames.includes(stmtDef.description)) {
          const refDef = descriptions[stmtDef.description];
          const refLabel = refDef.label || stmtDef.description;
          const refSlug = descSlug(stmtDef.description);
          constraintCell = `<a href="#desc-${refSlug}">&rarr; ${escHtml(refLabel)}</a>`;
        } else if (constraint) {
          constraintCell = `<code>${escHtml(constraint)}</code>`;
        } else {
          constraintCell = "";
        }

        // Type cell: if it's a prefixed datatype, link externally
        let typeCell;
        if (type && type.includes(":")) {
          const typeIri = expandPrefixed(type, namespaces, base);
          typeCell = typeIri
            ? `<a href="${escHtml(typeIri)}"><code>${escHtml(type)}</code></a>`
            : `<code>${escHtml(type)}</code>`;
        } else {
          typeCell = escHtml(type);
        }

        lines.push("      <tr>");
        lines.push(`        <td>${escHtml(stmtName)}</td>`);
        lines.push(`        <td>${propertyCell}</td>`);
        if (isDctap) {
          const card = formatDctapCard(stmtDef.min, stmtDef.max);
          lines.push(`        <td>${escHtml(card.mandatory)}</td>`);
          lines.push(`        <td>${escHtml(card.repeatable)}</td>`);
        } else {
          const min = stmtDef.min != null ? String(stmtDef.min) : "0";
          const max = stmtDef.max != null ? String(stmtDef.max) : "*";
          lines.push(`        <td>${escHtml(min)}</td>`);
          lines.push(`        <td>${escHtml(max)}</td>`);
        }
        lines.push(`        <td>${typeCell}</td>`);
        lines.push(`        <td>${constraintCell}</td>`);
        lines.push(`        <td>${escHtml(note)}</td>`);
        lines.push("      </tr>");
      }

      lines.push("    </tbody>");
      lines.push("  </table>");
    } else {
      lines.push("  <p><em>No statements defined.</em></p>");
    }

    lines.push("</section>");
  }

  lines.push("</main>");

  // ── Footer ──

  lines.push("<footer>");
  lines.push(`  <p>Generated with <a href="https://www.yamaml.org">YAMA</a> · ${date}</p>`);
  lines.push("</footer>");

  lines.push("</body>");
  lines.push("</html>");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

/**
 * Generates a GitHub-flavored Markdown report for a YAMA application profile.
 *
 * Shape references use internal anchors; property URIs are external links.
 * No diagram is included — a note directs the reader to the HTML report.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @param {string} filePath - Source file path (for display).
 * @param {string} [flavor] - "simpledsp" or "dctap".
 * @returns {string} Markdown string.
 */
export function generateMarkdownReport(doc, filePath, flavor) {
  const labels = getLabels(flavor);
  const isDctap = flavor === "dctap";
  const namespaces = doc.namespaces || {};
  const allNs = { ...STANDARD_PREFIXES, ...namespaces };
  const base = doc.base || "";
  const descriptions = doc.descriptions || {};
  const descNames = Object.keys(descriptions);
  const profileName = filePath
    ? filePath.split("/").pop().replace(/\.\w+$/, "")
    : "Profile";
  const date = today();

  const lines = [];

  // ── Header ──

  lines.push(`# ${profileName}`);
  lines.push("");
  lines.push(`Application Profile (${labels.specName}) · Generated ${date}`);
  lines.push("");
  if (base) {
    lines.push(`Base: \`${base}\``);
    lines.push("");
  }

  // ── Diagram note ──

  lines.push("> **Note:** See the HTML report for the overview diagram.");
  lines.push("");

  // ── Namespaces ──

  lines.push("## Namespaces");
  lines.push("");
  lines.push("| Prefix | Namespace URI |");
  lines.push("|--------|---------------|");
  for (const [prefix, uri] of Object.entries(namespaces)) {
    lines.push(`| \`${prefix}\` | \`${uri}\` |`);
  }
  lines.push("");

  // ── Description sections ──

  for (const descName of descNames) {
    const descDef = descriptions[descName];
    const displayName = descDef.label || descName;
    const slug = descSlug(descName);
    const statements = descDef.statements || {};

    lines.push(`## ${displayName}`);
    lines.push("");

    // Target class
    if (descDef.a) {
      const classIri = expandPrefixed(descDef.a, namespaces, base);
      if (classIri) {
        lines.push(`Target class: [\`${descDef.a}\`](${classIri})`);
      } else {
        lines.push(`Target class: \`${descDef.a}\``);
      }
      lines.push("");
    }

    // Description note
    if (descDef.note) {
      lines.push(descDef.note);
      lines.push("");
    }

    // Statements table
    const stmtEntries = Object.entries(statements);
    if (stmtEntries.length > 0) {
      const cols = labels.columns;
      lines.push(`| ${cols.join(" | ")} |`);
      lines.push(`|${cols.map(() => "------").join("|")}|`);

      for (const [stmtKey, stmtDef] of stmtEntries) {
        const stmtName = stmtDef.label || stmtKey;
        const property = stmtDef.property || "";
        const propertyIri = expandPrefixed(property, namespaces, base);
        const rawType = resolveType(stmtDef, namespaces);
        const type = rawType.includes(":") ? rawType : mapValueType(rawType, labels);
        const constraint = resolveConstraint(stmtDef, namespaces);
        const note = stmtDef.note || "";

        // Property: linked to external IRI
        const propertyMd = propertyIri
          ? `[\`${property}\`](${propertyIri})`
          : `\`${property}\``;

        // Constraint: shape references link internally
        let constraintMd;
        if (stmtDef.description && descNames.includes(stmtDef.description)) {
          const refDef = descriptions[stmtDef.description];
          const refLabel = refDef.label || stmtDef.description;
          const refSlug = descSlug(stmtDef.description);
          constraintMd = `[→ ${refLabel}](#${refSlug})`;
        } else if (constraint) {
          constraintMd = `\`${constraint}\``;
        } else {
          constraintMd = "";
        }

        // Type: link prefixed datatypes externally
        let typeMd;
        if (type && type.includes(":")) {
          const typeIri = expandPrefixed(type, namespaces, base);
          typeMd = typeIri ? `[\`${type}\`](${typeIri})` : `\`${type}\``;
        } else {
          typeMd = type;
        }

        // Escape pipe characters in note for Markdown table
        const noteMd = note.replace(/\|/g, "\\|");

        // Cardinality cells
        let cardCells;
        if (isDctap) {
          const card = formatDctapCard(stmtDef.min, stmtDef.max);
          cardCells = `${card.mandatory} | ${card.repeatable}`;
        } else {
          const min = stmtDef.min != null ? String(stmtDef.min) : "0";
          const max = stmtDef.max != null ? String(stmtDef.max) : "*";
          cardCells = `${min} | ${max}`;
        }

        lines.push(
          `| ${stmtName} | ${propertyMd} | ${cardCells} | ${typeMd} | ${constraintMd} | ${noteMd} |`,
        );
      }
      lines.push("");
    } else {
      lines.push("*No statements defined.*");
      lines.push("");
    }
  }

  // ── Footer ──

  lines.push("---");
  lines.push("");
  lines.push(`*Generated with [YAMA](https://www.yamaml.org) · ${date}*`);
  lines.push("");

  return lines.join("\n");
}
