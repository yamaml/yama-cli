/**
 * @fileoverview Regression tests for the ShEx importer.
 *
 * Audit findings covered: hyphen/dot local names dropped, CLOSED
 * shapes skipped, IRI value sets lost, default prefix (`PREFIX :`)
 * unrecognised, and the pattern syntax (`/pattern/` with `\/`
 * escapes, plus the legacy `//pattern//` form).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseShExToYama } from "../src/modules/from-shex.js";
import { generateShEx } from "../src/modules/shex.js";
import { captureWarnings, fixture, quietly, withTempDir } from "./helpers.js";

// ── CLOSED shapes ─────────────────────────────────────────────────

Deno.test("from-shex: CLOSED shapes parse and set closed: true", () => {
  const shex = `
PREFIX dcterms: <http://purl.org/dc/terms/>

<Book> EXTRA a CLOSED {
  a [schema:Book] ;
  dcterms:title LITERAL
}

<Agent> CLOSED {
  dcterms:description LITERAL ?
}
`;
  const doc = parseShExToYama(shex);
  assertEquals(Object.keys(doc.descriptions).length, 2);
  assertEquals(doc.descriptions.Book.closed, true);
  assertEquals(doc.descriptions.Book.a, "schema:Book");
  assertEquals(doc.descriptions.Agent.closed, true);
  assert(
    doc.descriptions.Book.statements,
    "CLOSED shape bodies still parse statements",
  );
});

// ── IRI value sets ────────────────────────────────────────────────

Deno.test("from-shex: IRI value sets become values with type IRI", () => {
  const shex = `
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX ex: <http://example.org/vocab#>

<Book> {
  dcterms:license [ex:cc-by <http://creativecommons.org/publicdomain/zero/1.0/>]
}
`;
  const doc = parseShExToYama(shex);
  const stmt = Object.values(doc.descriptions.Book.statements)[0];
  assertEquals(stmt.values, [
    "ex:cc-by",
    "http://creativecommons.org/publicdomain/zero/1.0/",
  ]);
  assertEquals(stmt.type, "IRI");
});

Deno.test("from-shex: IRI stems and language sets import", () => {
  const shex = `
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

<Book> {
  dcterms:subject [skos:~] * ;
  dcterms:language [@en @ja]
}
`;
  const doc = parseShExToYama(shex);
  const stmts = Object.values(doc.descriptions.Book.statements);
  const subject = stmts.find((s) => s.property === "dcterms:subject");
  assertEquals(subject.inScheme, "skos:");
  const lang = stmts.find((s) => s.property === "dcterms:language");
  assertEquals(lang.languageTag, ["en", "ja"]);
});

// ── PN_LOCAL coverage ─────────────────────────────────────────────

Deno.test("from-shex: local names with hyphens and dots are kept", () => {
  const shex = `
PREFIX bf: <http://id.loc.gov/ontologies/bibframe/>
PREFIX ex: <http://example.org/vocab#>

<Work> {
  bf:title-proper LITERAL ;
  ex:has.part IRI *
}
`;
  const doc = parseShExToYama(shex);
  const props = Object.values(doc.descriptions.Work.statements)
    .map((s) => s.property);
  assertEquals(props, ["bf:title-proper", "ex:has.part"]);
});

Deno.test("from-shex: empty default prefix is recognised", () => {
  const shex = `
PREFIX : <http://example.org/default#>
PREFIX dcterms: <http://purl.org/dc/terms/>

<Thing> {
  :name LITERAL ;
  dcterms:title LITERAL
}
`;
  const doc = parseShExToYama(shex);
  assertEquals(doc.namespaces[""], "http://example.org/default#");
  const props = Object.values(doc.descriptions.Thing.statements)
    .map((s) => s.property);
  assert(props.includes(":name"), "default-prefix predicate parsed");
});

// ── Pattern syntax ────────────────────────────────────────────────

Deno.test("from-shex: single-slash pattern with escaped slash parses", () => {
  const shex = `
PREFIX ex: <http://example.org/vocab#>

<Item> {
  ex:issn xsd:string /^\\d{4}\\/\\d{3}$/
}
`;
  const doc = parseShExToYama(shex);
  const stmt = Object.values(doc.descriptions.Item.statements)[0];
  assertEquals(stmt.pattern, "^\\d{4}/\\d{3}$");
});

Deno.test("from-shex: legacy //pattern// form still accepted", () => {
  const shex = `
PREFIX ex: <http://example.org/vocab#>

<Item> {
  ex:code xsd:string //^[A-Z]+$//
}
`;
  const doc = parseShExToYama(shex);
  const stmt = Object.values(doc.descriptions.Item.statements)[0];
  assertEquals(stmt.pattern, "^[A-Z]+$");
});

// ── Datatype disjunctions ─────────────────────────────────────────

Deno.test("from-shex: garbage tokens in a datatype disjunction are not imported", async () => {
  const shex = `
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX dcterms: <http://purl.org/dc/terms/>

<Book> {
  dcterms:date (xsd:gYear fakeword OR xsd:date) ;
  dcterms:issued (xsd:gYear OR xsd:date)
}
`;
  const { result: doc } = await captureWarnings(() => parseShExToYama(shex));
  const stmts = Object.values(doc.descriptions.Book.statements);
  assert(
    !stmts.some((s) => JSON.stringify(s.datatype ?? "").includes("fakeword")),
    "garbage token must not be imported as a datatype",
  );
  const issued = stmts.find((s) => s.property === "dcterms:issued");
  assertEquals(
    issued.datatype,
    ["xsd:gYear", "xsd:date"],
    "a valid PNAME disjunction still imports",
  );
});

// ── Unrecognised constraint lines ─────────────────────────────────

Deno.test("from-shex: unrecognised constraint lines warn instead of vanishing", async () => {
  const shex = `
PREFIX dcterms: <http://purl.org/dc/terms/>

<Book> {
  dcterms:title LITERAL ;
  $totally not shex$
}
`;
  const { result: doc, warnings } = await captureWarnings(
    () => parseShExToYama(shex),
  );
  assert(doc.descriptions.Book.statements, "valid statements still import");
  assert(
    warnings.some((w) =>
      w.includes("<Book>") && w.includes("$totally not shex$")
    ),
    "dropped line is reported with its shape",
  );
});

// ── Round-trip with the project's own emitter ─────────────────────

Deno.test("from-shex: kitchen-sink round-trips through generateShEx", async () => {
  await withTempDir(async (dir) => {
    const out = `${dir}/shapes.shex`;
    await quietly(() => generateShEx(fixture("kitchen-sink.yaml"), out));
    const text = await Deno.readTextFile(out);
    assertStringIncludes(text, "CLOSED", "emitter declares the closed shape");

    const doc = parseShExToYama(text);
    const bookName = Object.keys(doc.descriptions).find((n) =>
      n.endsWith("book")
    );
    assert(bookName, "book shape re-imported");
    const book = doc.descriptions[bookName];
    assertEquals(book.closed, true, "CLOSED survives the round-trip");

    const stmts = Object.values(book.statements);
    const issn = stmts.find((s) => s.property === "ex:issn");
    assertEquals(
      issn.pattern,
      "^\\d{4}/\\d{3}$",
      "slash-escaped pattern round-trips",
    );

    const license = stmts.find((s) => s.property === "dcterms:license");
    assert(
      license.values.includes("http://creativecommons.org/licenses/by/4.0/"),
      "full-IRI value-set member survives",
    );
    assert(license.values.includes("ex:custom"), "CURIE member survives");

    const subject = stmts.find((s) => s.property === "dcterms:subject");
    assertEquals(subject.inScheme, "skos:", "IRI stem returns to inScheme");

    const lang = stmts.find((s) => s.property === "dcterms:language");
    assertEquals(lang.languageTag, ["en", "ja"], "language set round-trips");
  });
});
