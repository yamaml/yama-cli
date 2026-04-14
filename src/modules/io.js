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
