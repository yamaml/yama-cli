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
