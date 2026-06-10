/**
 * @fileoverview Shared helpers for the yama-cli test suite.
 *
 * @module tests/helpers
 */

import N3 from "n3";

/** Absolute path to a file under tests/fixtures/. */
export function fixture(name) {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}

/**
 * Runs `fn(dir)` with a fresh temp directory, removing it afterwards.
 *
 * @param {(dir: string) => Promise<*>} fn
 */
export async function withTempDir(fn) {
  const dir = await Deno.makeTempDir({ prefix: "yama-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Parses Turtle text into an N3 store for triple-level assertions.
 *
 * @param {string} text
 * @returns {N3.Store}
 */
export function parseTurtle(text) {
  const parser = new N3.Parser();
  return new N3.Store(parser.parse(text));
}

/**
 * Collects the members of an RDF list starting at `head`.
 *
 * @param {N3.Store} store
 * @param {*} head - List head term.
 * @returns {Array} List item terms in order.
 */
export function rdfList(store, head) {
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const items = [];
  let node = head;
  while (node && node.value !== `${RDF}nil`) {
    const first = store.getObjects(node, `${RDF}first`, null);
    if (first.length === 0) break;
    items.push(first[0]);
    const rest = store.getObjects(node, `${RDF}rest`, null);
    node = rest[0];
  }
  return items;
}

/**
 * Captures console.warn output while running `fn`.
 *
 * @param {() => Promise<*>} fn
 * @returns {Promise<{result: *, warnings: string[]}>}
 */
export async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

/**
 * Silences console.error (generator "Written to ..." chatter) while
 * running `fn`.
 *
 * @param {() => Promise<*>} fn
 */
export async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}
