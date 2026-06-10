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
 * | description               | Shape (`<base+name> { ... }`)         |
 * | description.a             | `EXTRA a` + `a [class]` constraint    |
 * | description.closed        | `CLOSED` shape qualifier              |
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
 * | statement.values          | Value set (`["a" "b"]` / `[<iri>]`)   |
 * | statement.inScheme        | IRI stem value set (`[prefix:~]`)     |
 * | statement.languageTag     | Language value set (`[@en @ja]`)      |
 *
 * @module shex
 * @see https://shex.io
 * @see https://shexspec.github.io/primer/
 */

import { parse as parseYaml } from "@std/yaml";
import { datatypes, descRefs, readInput } from "./io.js";
import { STANDARD_PREFIXES } from "./prefixes.js";

// ---------------------------------------------------------------------------
// ShExC serialization helpers
// ---------------------------------------------------------------------------

/**
 * Escapes a YAMAML pattern for embedding in a ShExC `/regex/` facet.
 *
 * ShExC's REGEXP token is delimited by single slashes, so any
 * unescaped `/` inside the pattern body must become `\/`. Existing
 * backslash escapes (e.g. `\d`, an already-escaped `\/`) pass through
 * untouched.
 *
 * @param {string} pattern
 * @returns {string}
 */
function escapeShExPattern(pattern) {
  let out = "";
  let escaped = false;
  for (const ch of String(pattern)) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    out += ch === "/" ? "\\/" : ch;
  }
  return out;
}

/**
 * Escapes a string literal for a ShExC value set.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeShExString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Normalises an `inScheme` entry to a string.
 *
 * YAML parses the unquoted list form `- ndlsh:` as `{ ndlsh: null }`
 * rather than the string `"ndlsh:"`; this restores the intended
 * scheme reference.
 *
 * @param {string|Object} s
 * @returns {string}
 */
function normalizeScheme(s) {
  if (typeof s === "string") return s;
  if (s && typeof s === "object") return Object.keys(s)[0] + ":";
  return String(s);
}

/**
 * Formats a term as a ShExC IRI token.
 *
 * Full IRIs are wrapped in angle brackets. CURIEs whose prefix
 * resolves (through the user's namespaces or the standard prefix
 * table) stay in prefixed form and the prefix is recorded so a
 * matching PREFIX line is emitted. Anything else falls back to
 * base concatenation, matching the other generators.
 *
 * @param {string} term - Prefixed name or full IRI.
 * @param {Object} ctx  - Builder context with namespaces/base/usedPrefixes.
 * @returns {string}
 */
function formatIriToken(term, ctx) {
  const t = String(term);
  if (/^(https?|urn):/.test(t)) return `<${t}>`;

  const colon = t.indexOf(":");
  if (colon >= 0) {
    const prefix = t.substring(0, colon);
    if (ctx.namespaces[prefix] !== undefined) {
      ctx.usedPrefixes.add(prefix);
      return t;
    }
  }

  if (ctx.base) return `<${ctx.base}${t}>`;
  console.warn(
    `Warning: term "${t}" uses an undeclared prefix and no base is set — emitted as a relative IRI.`,
  );
  return `<${t}>`;
}

/**
 * Formats a cardinality constraint as ShExC shorthand or `{m,n}` syntax.
 *
 * YAMAML semantics (§4.3): an absent `min` means 0, an absent `max`
 * means unbounded, and a statement with neither is unconstrained.
 * ShEx's default (no marker) is exactly-one, so the unconstrained
 * case must emit `*` explicitly.
 *
 *   - `*`     = {0,∞}
 *   - `+`     = {1,∞}
 *   - `?`     = {0,1}
 *   - (none)  = {1,1}
 *   - `{m,n}` / `{m,}` / `{m}` otherwise
 *
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 * @returns {string} ShExC cardinality string (may be empty).
 */
function formatCardinality(min, max) {
  const m = min ?? 0;
  const unbounded = max == null;

  if (m === 0 && unbounded) return " *";
  if (m === 1 && unbounded) return " +";
  if (m === 0 && max === 1) return " ?";
  if (m === 1 && max === 1) return "";

  if (unbounded) return ` {${m},}`;
  if (m === max) return ` {${m}}`;
  return ` {${m},${max}}`;
}

/**
 * Collects facet tokens (pattern + numeric/string facets) for a
 * statement. Facet tokens attach to a literal node constraint.
 *
 * @param {Object} stmt - Statement definition.
 * @returns {string[]}
 */
function collectFacetTokens(stmt) {
  const tokens = [];

  if (stmt.pattern) {
    tokens.push(`/${escapeShExPattern(stmt.pattern)}/`);
  }

  if (stmt.facets) {
    const facetNames = [
      "MinInclusive",
      "MaxInclusive",
      "MinExclusive",
      "MaxExclusive",
      "TotalDigits",
      "FractionDigits",
      "MinLength",
      "MaxLength",
      "Length",
    ];
    for (const name of facetNames) {
      if (stmt.facets[name] != null) {
        tokens.push(`${name} ${stmt.facets[name]}`);
      }
    }
  }

  return tokens;
}

/**
 * Formats the node constraint part of a triple constraint.
 *
 * Constraint groups (shape references, datatypes, value sets,
 * language sets) are combined with ShEx's `AND` operator so that no
 * declared constraint is dropped. Facet tokens attach to the literal
 * constraint group per the ShExC grammar.
 *
 * @param {Object} stmt - Statement definition.
 * @param {Object} ctx  - Builder context.
 * @returns {string}
 */
function formatNodeConstraint(stmt, ctx) {
  const groups = [];

  // Shape reference(s) — multi-shape becomes a parenthesised
  // disjunction using ShEx's OR operator. Shape IRIs are absolute
  // (base + name), matching the SHACL and OWL-DSP generators.
  const refs = descRefs(stmt);
  if (refs.length === 1) {
    groups.push(`@<${ctx.base}${refs[0]}>`);
  } else if (refs.length > 1) {
    groups.push(`(${refs.map((r) => `@<${ctx.base}${r}>`).join(" OR ")})`);
  }

  const facetTokens = collectFacetTokens(stmt);
  let facetsAttached = false;

  // Datatype constraint(s) — multi-datatype is a disjunction.
  const dts = datatypes(stmt);
  if (dts.length === 1) {
    const dt = formatIriToken(dts[0], ctx);
    groups.push(facetTokens.length ? `${dt} ${facetTokens.join(" ")}` : dt);
    facetsAttached = true;
  } else if (dts.length > 1) {
    groups.push(`(${dts.map((d) => formatIriToken(d, ctx)).join(" OR ")})`);
    if (facetTokens.length) {
      groups.push(facetTokens.join(" "));
      facetsAttached = true;
    }
  }

  // Value set — IRI-typed statements get IRI terms, literal
  // statements get escaped string literals. inScheme stems join the
  // same value set (`prefix:~`), since a value set matches when any
  // member matches (union semantics).
  const setItems = [];
  if (stmt.inScheme) {
    const schemes = (Array.isArray(stmt.inScheme)
      ? stmt.inScheme
      : [stmt.inScheme]).map(normalizeScheme);
    for (const s of schemes) {
      setItems.push(`${formatIriToken(s, ctx)}~`);
    }
  }
  if (Array.isArray(stmt.values) && stmt.values.length > 0) {
    const isIriType = ["IRI", "URI"].includes((stmt.type || "").toUpperCase());
    for (const v of stmt.values) {
      setItems.push(
        isIriType
          ? formatIriToken(String(v), ctx)
          : `"${escapeShExString(v)}"`,
      );
    }
  }
  if (setItems.length > 0) {
    let set = `[${setItems.join(" ")}]`;
    if (facetTokens.length && !facetsAttached) {
      set += ` ${facetTokens.join(" ")}`;
      facetsAttached = true;
    }
    groups.push(set);
  }

  // Language value set from languageTag (e.g. `[@en @ja]`).
  if (Array.isArray(stmt.languageTag) && stmt.languageTag.length > 0) {
    groups.push(`[${stmt.languageTag.map((t) => `@${t}`).join(" ")}]`);
  }

  // Bare node kind when nothing else constrains the value. An
  // untyped, unconstrained statement is the ShEx wildcard `.` —
  // tightening it to LITERAL would reject IRI values the profile
  // allows.
  if (groups.length === 0) {
    const typeMap = {
      IRI: "IRI",
      URI: "IRI",
      LITERAL: "LITERAL",
      BNODE: "BNODE",
      NONLITERAL: "NONLITERAL",
    };
    const kind = typeMap[(stmt.type || "").toUpperCase()];
    if (kind) {
      groups.push(
        facetTokens.length ? `${kind} ${facetTokens.join(" ")}` : kind,
      );
      facetsAttached = true;
    } else if (facetTokens.length) {
      // Facets alone form a valid literal node constraint.
      groups.push(facetTokens.join(" "));
      facetsAttached = true;
    } else {
      groups.push(".");
    }
  } else if (facetTokens.length && !facetsAttached) {
    // Only shape refs present — facets become their own constraint.
    groups.push(facetTokens.join(" "));
  }

  return groups.join(" AND ");
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
  const userNamespaces = doc.namespaces || {};
  // Resolution map: standard prefixes as fallback, user declarations
  // take precedence (YAMAML §2.2).
  const ctx = {
    namespaces: { ...STANDARD_PREFIXES, ...userNamespaces },
    base: doc.base || "",
    usedPrefixes: new Set(),
  };

  // Shape definitions are built first so prefix usage is known
  // before the PREFIX header is emitted.
  const shapeLines = [];
  const descriptions = doc.descriptions || {};

  for (const [descName, descDef] of Object.entries(descriptions)) {
    shapeLines.push("");

    const statements = descDef.statements || {};
    const hasType = !!descDef.a;

    // Shape qualifiers: EXTRA a allows additional rdf:type values;
    // CLOSED rejects undeclared properties.
    const qualifiers = [];
    if (hasType) qualifiers.push("EXTRA a");
    if (descDef.closed === true) qualifiers.push("CLOSED");
    const qualifierStr = qualifiers.length ? ` ${qualifiers.join(" ")}` : "";

    // Shape IRIs are absolute (base + name), aligned with the SHACL
    // and OWL-DSP generators' string concatenation.
    shapeLines.push(`<${ctx.base}${descName}>${qualifierStr} {`);

    const tripleConstraints = [];

    // rdf:type constraint from "a"
    if (hasType) {
      tripleConstraints.push(`  a [${formatIriToken(descDef.a, ctx)}]`);
    }

    // Statement triple constraints
    for (const stmtDef of Object.values(statements)) {
      if (!stmtDef.property) continue;

      const predicate = formatIriToken(stmtDef.property, ctx);
      const nodeConstraint = formatNodeConstraint(stmtDef, ctx);
      const cardinality = formatCardinality(stmtDef.min, stmtDef.max);

      tripleConstraints.push(`  ${predicate} ${nodeConstraint}${cardinality}`);
    }

    // Join with semicolons (ShEx TripleExpression separator)
    if (tripleConstraints.length > 0) {
      shapeLines.push(tripleConstraints.join(" ;\n"));
    }

    shapeLines.push("}");
  }

  // Header
  const lines = [];
  lines.push("#");
  lines.push("# Generated with YAMA");
  lines.push("# https://www.yamaml.org");
  lines.push("#");
  lines.push("");

  // PREFIX declarations: every user-declared prefix, plus any
  // standard prefix the schema actually references.
  for (const [prefix, uri] of Object.entries(userNamespaces)) {
    lines.push(`PREFIX ${prefix}: <${uri}>`);
  }
  for (const prefix of ctx.usedPrefixes) {
    if (!(prefix in userNamespaces)) {
      lines.push(`PREFIX ${prefix}: <${ctx.namespaces[prefix]}>`);
    }
  }

  lines.push(...shapeLines);
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
