/**
 * @fileoverview ShEx (Shape Expressions) generation from YAMA files.
 *
 * Builds a ShExC (ShEx Compact Syntax) schema programmatically from a
 * YAMA application profile. Replaces the previous Nunjucks template
 * approach with a proper builder that handles the full ShEx grammar.
 *
 * YAMA-to-ShEx mapping:
 *
 * | YAMA element              | ShExC output                          |
 * |---------------------------|---------------------------------------|
 * | description               | Shape (`<name> { ... }`)              |
 * | description.a             | `EXTRA a` + `a [class]` constraint    |
 * | statement                 | TripleConstraint                      |
 * | statement.property        | Predicate                             |
 * | statement.type (IRI)      | `IRI` node constraint                 |
 * | statement.type (literal)  | `LITERAL` node constraint             |
 * | statement.type (BNODE)    | `BNODE` node constraint               |
 * | statement.datatype        | Datatype constraint (e.g. `xsd:string`)|
 * | statement.min / max       | Cardinality (`*`, `+`, `?`, `{m,n}`) |
 * | statement.description     | Shape reference (`@<shape>`)          |
 * | statement.facets          | Numeric facets (`MinInclusive`, etc.) |
 * | statement.pattern         | String facet (`/pattern/`)            |
 * | statement.values          | Value set (`["a" "b"]`)               |
 *
 * @module shex
 * @see https://shex.io
 * @see https://shexspec.github.io/primer/
 */

import { parse as parseYaml } from "@std/yaml";
import { descRefs, readInput } from "./io.js";

// ---------------------------------------------------------------------------
// ShExC serialization helpers
// ---------------------------------------------------------------------------

/**
 * Formats a cardinality constraint as ShExC shorthand or `{m,n}` syntax.
 *
 * ShEx cardinality rules:
 *   - `*`   = {0,∞}
 *   - `+`   = {1,∞}
 *   - `?`   = {0,1}
 *   - `{n}` = exactly n
 *   - `{m,n}` = between m and n
 *   - (omitted) = {1,1} (exactly once)
 *
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 * @returns {string} ShExC cardinality string (may be empty).
 */
function formatCardinality(min, max) {
  const hasMin = min != null;
  const hasMax = max != null;

  if (!hasMin && !hasMax) return "";

  const m = hasMin ? min : 1;
  const n = hasMax ? max : -1; // -1 = unbounded

  // Shorthands
  if (m === 0 && n === -1) return " *";
  if (m === 1 && n === -1) return " +";
  if (m === 0 && n === 1) return " ?";

  // Exact
  if (hasMin && !hasMax) return ` {${m},}`;
  if (m === n) return ` {${m}}`;

  return ` {${m},${n}}`;
}

/**
 * Formats the node constraint part of a triple constraint.
 *
 * Handles the mutual exclusivity between datatype, shape reference,
 * value set, and bare node kind constraints per ShEx grammar:
 *   - Datatype: `xsd:string`
 *   - Shape ref: `@<shapeName>`
 *   - Value set: `["val1" "val2"]`
 *   - Node kind: `IRI`, `LITERAL`, `BNODE`, `NONLITERAL`
 *
 * @param {Object} stmt      - Statement definition.
 * @param {Object} namespaces - For compacting IRIs (unused but future-proof).
 * @returns {string}
 */
function formatNodeConstraint(stmt) {
  const parts = [];

  // Shape reference(s) take precedence. Multi-shape becomes a
  // parenthesised disjunction using ShEx's OR operator.
  const refs = descRefs(stmt);
  if (refs.length === 1) {
    parts.push(`@<${refs[0]}>`);
  } else if (refs.length > 1) {
    parts.push(`(${refs.map((r) => `@<${r}>`).join(" OR ")})`);
  } else if (stmt.datatype) {
    // Datatype constraint (already prefixed in YAMA, e.g. "xsd:string")
    parts.push(stmt.datatype);
  } else if (Array.isArray(stmt.values) && stmt.values.length > 0) {
    // Value set
    const vals = stmt.values.map((v) => `"${v}"`).join(" ");
    parts.push(`[${vals}]`);
  } else {
    // Bare node kind
    const type = (stmt.type || "LITERAL").toUpperCase();
    parts.push(type);
  }

  // String facet: pattern
  if (stmt.pattern) {
    parts.push(`//${stmt.pattern}//`);
  }

  // Numeric facets
  if (stmt.facets) {
    if (stmt.facets.MinInclusive != null) {
      parts.push(`MinInclusive ${stmt.facets.MinInclusive}`);
    }
    if (stmt.facets.MaxInclusive != null) {
      parts.push(`MaxInclusive ${stmt.facets.MaxInclusive}`);
    }
    if (stmt.facets.MinExclusive != null) {
      parts.push(`MinExclusive ${stmt.facets.MinExclusive}`);
    }
    if (stmt.facets.MaxExclusive != null) {
      parts.push(`MaxExclusive ${stmt.facets.MaxExclusive}`);
    }
    if (stmt.facets.TotalDigits != null) {
      parts.push(`TotalDigits ${stmt.facets.TotalDigits}`);
    }
    if (stmt.facets.FractionDigits != null) {
      parts.push(`FractionDigits ${stmt.facets.FractionDigits}`);
    }
    if (stmt.facets.MinLength != null) {
      parts.push(`MinLength ${stmt.facets.MinLength}`);
    }
    if (stmt.facets.MaxLength != null) {
      parts.push(`MaxLength ${stmt.facets.MaxLength}`);
    }
    if (stmt.facets.Length != null) {
      parts.push(`Length ${stmt.facets.Length}`);
    }
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Schema builder
// ---------------------------------------------------------------------------

/**
 * Builds the complete ShExC schema string from a parsed YAMA document.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @returns {string} ShExC schema.
 */
function buildShExC(doc) {
  const lines = [];
  const namespaces = doc.namespaces || {};
  const base = doc.base || "";

  // Header
  lines.push("#");
  lines.push("# Generated with YAMA");
  lines.push("# https://www.yamaml.org");
  lines.push("#");
  lines.push("");

  // PREFIX declarations
  for (const [prefix, uri] of Object.entries(namespaces)) {
    lines.push(`PREFIX ${prefix}: <${uri}>`);
  }

  // BASE declaration
  if (base) {
    lines.push(`BASE <${base}>`);
  }

  // Shape definitions
  const descriptions = doc.descriptions || {};

  for (const [descName, descDef] of Object.entries(descriptions)) {
    lines.push("");

    const statements = descDef.statements || {};
    const stmtEntries = Object.entries(statements);
    const hasType = !!descDef.a;

    // Shape header with optional EXTRA a (allows additional rdf:type values)
    if (hasType) {
      lines.push(`<${descName}> EXTRA a {`);
    } else {
      lines.push(`<${descName}> {`);
    }

    // rdf:type constraint from "a"
    const tripleConstraints = [];

    if (hasType) {
      tripleConstraints.push(`  a [${descDef.a}]`);
    }

    // Statement triple constraints
    for (const [, stmtDef] of stmtEntries) {
      if (!stmtDef.property) continue;

      const nodeConstraint = formatNodeConstraint(stmtDef);
      const cardinality = formatCardinality(stmtDef.min, stmtDef.max);

      tripleConstraints.push(`  ${stmtDef.property} ${nodeConstraint}${cardinality}`);
    }

    // Join with semicolons (ShEx TripleExpression separator)
    lines.push(tripleConstraints.join(" ;\n"));

    lines.push("}");
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a ShEx schema from a YAMA file.
 *
 * @param {string} file     - Path to the YAMA input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function generateShEx(file, output) {
  const data = parseYaml(await readInput(file));
  const shex = buildShExC(data);

  if (output) {
    Deno.writeTextFileSync(output, shex);
    console.error(`Written to ${output}`);
  } else {
    console.log(shex);
  }
}
