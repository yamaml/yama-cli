/**
 * @fileoverview Shared input reading utilities.
 *
 * Provides URL-aware wrappers around Deno's file reading APIs.
 * When a path starts with `http://` or `https://`, the content is
 * fetched over the network; otherwise it is read from the local
 * filesystem.
 *
 * @module io
 */

// ── Quiet mode ──

let quietMode = false;

/**
 * Enables or disables quiet mode for status messages.
 *
 * Wired to the CLI's `-q/--quiet` flag. Only affects
 * {@link statusLog}; warnings and errors keep printing.
 *
 * @param {boolean} value
 * @returns {void}
 */
export function setQuiet(value) {
  quietMode = Boolean(value);
}

/**
 * Prints a status message to stderr unless quiet mode is on.
 *
 * Used for non-error chatter like "Written to out.ttl" so that
 * `-q/--quiet` can suppress it without touching warnings/errors.
 *
 * @param {...*} args - Arguments forwarded to console.error.
 * @returns {void}
 */
export function statusLog(...args) {
  if (!quietMode) console.error(...args);
}

/**
 * Reads text content from a local file or URL.
 *
 * @param {string} path - Local file path or HTTP(S) URL.
 * @returns {Promise<string>}
 */
export async function readInput(path) {
  if (/^https?:\/\//i.test(path)) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }
  return Deno.readTextFile(path);
}

/**
 * Writes bytes to stdout, looping until every byte is written.
 *
 * `Deno.stdout.writeSync` may perform a short write (especially when
 * stdout is a pipe), silently truncating large outputs. This helper
 * retries until the whole buffer is flushed.
 *
 * @param {Uint8Array} bytes - Encoded output to write.
 * @returns {void}
 */
export function writeStdoutSync(bytes) {
  let written = 0;
  while (written < bytes.length) {
    written += Deno.stdout.writeSync(bytes.subarray(written));
  }
}

/**
 * Reads binary content from a local file or URL.
 *
 * @param {string} path - Local file path or HTTP(S) URL.
 * @returns {Promise<Uint8Array>}
 */
export async function readInputBytes(path) {
  if (/^https?:\/\//i.test(path)) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  return Deno.readFile(path);
}

/**
 * Normalises a YAMAML statement's `description` field into an array of
 * shape-reference names.
 *
 * YAMAML accepts `description:` as a scalar (single ref) or an array
 * (multi-shape disjunction). Internally the CLI treats the array form
 * as canonical; this helper hides the scalar-or-list detail from call
 * sites that just want "the shape refs, if any".
 *
 * @param {{ description?: string | string[] | null | undefined }} stmtDef
 * @returns {string[]} Non-empty array of ref names, or empty when none.
 */
export function descRefs(stmtDef) {
  const d = stmtDef?.description;
  if (!d) return [];
  if (Array.isArray(d)) return d.filter((r) => typeof r === "string" && r.length > 0);
  return typeof d === "string" && d.length > 0 ? [d] : [];
}

/**
 * Normalises a YAMAML statement's `datatype` field into an array of
 * datatype CURIEs.
 *
 * Multi-datatype is endorsed by the SimpleDSP spec (§4.6 Table 16: a
 * space-separated list expresses a union of `owl:onDataRange` values)
 * and used in practice by DCMI's SRAP profile for DCTAP. YAMAML
 * accepts the field as:
 *   - a scalar string (legacy single-datatype YAML),
 *   - a space-separated string (DCTAP/SimpleDSP idiom imported verbatim),
 *   - a sequence of strings (the canonical multi-datatype YAML shape).
 *
 * This helper turns any of those into a flat array of trimmed,
 * non-empty datatype tokens — empty when none.
 *
 * @param {{ datatype?: string | string[] | null | undefined }} stmtDef
 * @returns {string[]}
 */
export function datatypes(stmtDef) {
  const d = stmtDef?.datatype;
  if (!d) return [];
  if (Array.isArray(d)) {
    return d
      .filter((x) => typeof x === "string")
      .flatMap((x) => x.split(/\s+/))
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (typeof d === "string") {
    return d.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Normalises a YAMAML statement's `type` (value node kind) field into an
 * array of canonical YAMA tokens (`IRI`, `literal`, `BNODE`).
 *
 * DCTAP and the DCMI SRAP profile allow multiple node kinds in one cell
 * (e.g. `IRI BNODE`, `IRI literal`), and Tapir emits the field as a YAML
 * sequence for such statements. YAMAML therefore accepts `type` as:
 *   - a scalar string (legacy single-kind YAML),
 *   - a space-separated string (DCTAP idiom imported verbatim),
 *   - a sequence of strings (the canonical multi-kind YAML shape).
 *
 * Each token is canonicalised case-insensitively (`URI`→`IRI`); unknown
 * tokens are dropped and duplicates removed, preserving first-seen
 * order. Empty when none recognised.
 *
 * @param {{ type?: string | string[] | null | undefined }} stmtDef
 * @returns {string[]} Canonical YAMA type tokens.
 */
export function nodeTypes(stmtDef) {
  const t = stmtDef?.type;
  if (!t) return [];
  const raw = Array.isArray(t)
    ? t.filter((x) => typeof x === "string").flatMap((x) => x.split(/\s+/))
    : typeof t === "string"
    ? t.split(/\s+/)
    : [];
  const out = [];
  for (const tok of raw) {
    const upper = tok.trim().toUpperCase();
    let canonical;
    if (upper === "IRI" || upper === "URI") canonical = "IRI";
    else if (upper === "LITERAL") canonical = "literal";
    else if (upper === "BNODE") canonical = "BNODE";
    else continue;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Returns the single representative node type for formats that cannot
 * express alternatives (Frictionless, diagram labels, SimpleDSP). Picks
 * IRI over literal over BNODE; empty string when none.
 *
 * @param {{ type?: string | string[] | null | undefined }} stmtDef
 * @returns {string}
 */
export function primaryNodeType(stmtDef) {
  const types = nodeTypes(stmtDef);
  for (const pref of ["IRI", "literal", "BNODE"]) {
    if (types.includes(pref)) return pref;
  }
  return "";
}
