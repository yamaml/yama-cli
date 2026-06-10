/**
 * @fileoverview Regression tests for the report generator: Markdown
 * anchor consistency, flavor labelling, and standalone HTML (no CDN).
 */

import { assert, assertStringIncludes } from "@std/assert";
import {
  generateHtmlReport,
  generateMarkdownReport,
} from "../src/modules/report.js";

const DOC = {
  namespaces: { ex: "http://example.org/vocab#" },
  descriptions: {
    MAIN: {
      label: "Main Record",
      statements: {
        relation: { property: "dcterms:relation", description: "Work" },
      },
    },
    Work: {
      label: "Creative Work",
      statements: {
        title: { property: "dcterms:title", type: "literal" },
      },
    },
  },
};

// ── Markdown anchors ──────────────────────────────────────────────

Deno.test("report: markdown anchor matches the rendered heading", () => {
  const md = generateMarkdownReport(DOC, "profile.yaml", "yamaml");
  // The heading renders the label, so the link slug must derive from
  // the label ("creative-work"), not the raw key ("work").
  assertStringIncludes(md, "## Creative Work");
  assertStringIncludes(md, "[→ Creative Work](#creative-work)");
  assert(!md.includes("](#work)"), "anchor must not use the raw key slug");
});

Deno.test("report: duplicate heading labels get de-duplicated anchors", () => {
  const doc = {
    descriptions: {
      A: {
        label: "Item",
        statements: { ref: { property: "dcterms:relation", description: "B" } },
      },
      B: { label: "Item", statements: {} },
    },
  };
  const md = generateMarkdownReport(doc, "profile.yaml", "yamaml");
  // B is the second "Item" heading, so its GitHub anchor is #item-1.
  assertStringIncludes(md, "[→ Item](#item-1)");
});

// ── Flavor labels ─────────────────────────────────────────────────

Deno.test("report: yamaml flavor is not labelled SimpleDSP", () => {
  const md = generateMarkdownReport(DOC, "profile.yaml", "yamaml");
  assertStringIncludes(md, "Application Profile (YAMAML)");
  assert(!md.includes("SimpleDSP"), "YAMAML input must not say SimpleDSP");

  const html = generateHtmlReport(DOC, "", "profile.yaml", "yamaml");
  assertStringIncludes(html, "Application Profile (YAMAML)");
});

Deno.test("report: simpledsp and dctap flavors keep their labels", () => {
  assertStringIncludes(
    generateMarkdownReport(DOC, "p.tsv", "simpledsp"),
    "Application Profile (SimpleDSP)",
  );
  assertStringIncludes(
    generateMarkdownReport(DOC, "p.csv", "dctap"),
    "Application Profile (DCTAP)",
  );
});

// ── Standalone HTML ───────────────────────────────────────────────

Deno.test("report: html is standalone with no CDN dependency", () => {
  const html = generateHtmlReport(DOC, "<svg></svg>", "profile.yaml", "yamaml");
  assert(!html.includes("cdn.jsdelivr.net"), "no jsDelivr CDN reference");
  assert(
    !/<link[^>]+rel="stylesheet"[^>]+https?:/.test(html),
    "no external stylesheet link",
  );
  assertStringIncludes(html, "<style>");
  assertStringIncludes(html, "border-collapse");
});
