// src/modules/format-report.js
/**
 * Formats ValidationReport as human-readable text or JSON.
 *
 * @module modules/format-report
 */

/**
 * Formats a validation report as human-readable text.
 *
 * @param {Object} report - ValidationReport from validate.js
 * @returns {string}
 */
export function formatHuman(report) {
  const lines = [];

  lines.push(`Validating: ${report.file} (${formatName(report.format)})`);
  lines.push("");

  // Summary
  lines.push("\u2500\u2500 Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  lines.push(`  Format:        ${formatName(report.format)}`);
  const ns = report.summary.namespaces;
  const nsList = ns.list.length > 0 ? ` (${ns.list.join(", ")})` : "";
  lines.push(`  Namespaces:    ${ns.declared} declared${nsList} + ${ns.standard} standard`);
  if (report.summary.base) {
    lines.push(`  Base:          ${report.summary.base}`);
  }
  const descNames = report.descriptions.map((d) => d.name).join(", ");
  lines.push(`  Descriptions:  ${report.summary.descriptions} (${descNames})`);
  lines.push(`  Statements:    ${report.summary.statements} total`);
  lines.push("");

  // Per-description breakdown
  for (const desc of report.descriptions) {
    lines.push(`\u2500\u2500 Description: ${desc.name} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (desc.targetClass) lines.push(`  Target class:  ${desc.targetClass}`);
    lines.push(`  ID prefix:     ${desc.idPrefix || "(none)"}`);
    lines.push(`  Statements:    ${desc.statementCount}`);
    if (Object.keys(desc.valueTypes).length > 0) {
      const vtParts = Object.entries(desc.valueTypes)
        .map(([k, v]) => `${k}: ${v}`)
        .join("  ");
      lines.push(`    ${vtParts}`);
    }
    lines.push("");
  }

  // Errors
  if (report.errors.length > 0) {
    lines.push(`\u2500\u2500 Errors (${report.errors.length}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    for (const e of report.errors) {
      const loc = formatLocation(e.location);
      lines.push(`  \u2717 ${loc}${e.message}`);
      if (e.fix) lines.push(`    \u2192 ${e.fix}`);
    }
    lines.push("");
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push(`\u2500\u2500 Warnings (${report.warnings.length}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    for (const w of report.warnings) {
      const loc = formatLocation(w.location);
      lines.push(`  \u26a0 ${loc}${w.message}`);
      if (w.fix) lines.push(`    \u2192 ${w.fix}`);
    }
    lines.push("");
  }

  // Info
  if (report.info.length > 0) {
    lines.push(`\u2500\u2500 Info (${report.info.length}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    for (const i of report.info) {
      const loc = formatLocation(i.location);
      lines.push(`  \u2139 ${loc}${i.message}`);
    }
    lines.push("");
  }

  // Result
  lines.push("\u2500\u2500 Result \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  if (report.valid) {
    lines.push(`  VALID (${report.warnings.length} warning${report.warnings.length !== 1 ? "s" : ""})`);
  } else {
    lines.push(`  INVALID (${report.errors.length} error${report.errors.length !== 1 ? "s" : ""}, ${report.warnings.length} warning${report.warnings.length !== 1 ? "s" : ""})`);
  }

  return lines.join("\n");
}

/**
 * Formats a validation report as JSON.
 *
 * @param {Object} report - ValidationReport
 * @returns {string}
 */
export function formatJson(report) {
  return JSON.stringify(report, null, 2);
}

function formatName(format) {
  const names = { yaml: "YAMA YAML", simpledsp: "SimpleDSP", dctap: "DCTAP" };
  return names[format] || format;
}

function formatLocation(loc) {
  if (!loc) return "";
  if (loc.line) return `line ${loc.line}: `;
  if (loc.path) return `${loc.path}: `;
  return "";
}
