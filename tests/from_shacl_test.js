/**
 * @fileoverview Regression tests for the SHACL importer.
 *
 * Audit findings covered: same-local-name shape overwrite, dropped
 * sh:minExclusive/maxExclusive/languageIn/hasValue, sh:in IRI members,
 * sh:BlankNode round-trip, and silent loss of inexpressible constructs
 * (sh:uniqueLang, targets, shape-level sh:or, qualifiedValueShape,
 * severity/message, non-IRI paths).
 */

import { assert, assertEquals } from "@std/assert";
import { parseShaclToYama } from "../src/modules/from-shacl.js";
import { generateSHACL } from "../src/modules/shacl.js";
import { captureWarnings, fixture, quietly, withTempDir } from "./helpers.js";

const PREAMBLE = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix ex1: <http://example.org/one#> .
@prefix ex2: <http://example.org/two#> .
`;

// ── Same-local-name shapes ────────────────────────────────────────

Deno.test("from-shacl: same-local-name shapes are de-duplicated, not overwritten", async () => {
  const ttl = `${PREAMBLE}
ex1:Book a sh:NodeShape ;
  sh:targetClass ex1:Monograph ;
  sh:property [ sh:path dcterms:title ; sh:minCount 1 ] .
ex2:Book a sh:NodeShape ;
  sh:targetClass ex2:Volume ;
  sh:property [ sh:path dcterms:creator ] .
`;
  const { result: doc, warnings } = await captureWarnings(
    () => parseShaclToYama(ttl),
  );
  const names = Object.keys(doc.descriptions);
  assertEquals(names.length, 2, "both shapes survive the import");
  assert(names.includes("Book"));
  assert(names.includes("Book_2"));
  assertEquals(doc.descriptions.Book.a, "ex1:Monograph");
  assertEquals(doc.descriptions.Book_2.a, "ex2:Volume");
  assert(
    warnings.some((w) => w.includes('local name "Book"')),
    "rename is reported on stderr",
  );
});

Deno.test("from-shacl: references follow de-duplicated shape names", async () => {
  const ttl = `${PREAMBLE}
ex1:Book a sh:NodeShape ;
  sh:property [ sh:path dcterms:title ] .
ex2:Book a sh:NodeShape ;
  sh:property [ sh:path dcterms:creator ] .
ex1:Library a sh:NodeShape ;
  sh:property [ sh:path dcterms:hasPart ; sh:node ex2:Book ] .
`;
  const { result: doc } = await captureWarnings(() => parseShaclToYama(ttl));
  const stmt = Object.values(doc.descriptions.Library.statements)[0];
  assertEquals(stmt.description, "Book_2");
});

// ── Constraint imports ────────────────────────────────────────────

Deno.test("from-shacl: exclusive facets, lengths, languageIn, hasValue import", async () => {
  const ttl = `${PREAMBLE}
ex1:Item a sh:NodeShape ;
  sh:property [
    sh:path dcterms:extent ;
    sh:minExclusive 0 ;
    sh:maxExclusive 100 ;
    sh:minLength 1 ;
    sh:maxLength 10
  ] ;
  sh:property [
    sh:path dcterms:language ;
    sh:languageIn ( "en" "ja" )
  ] ;
  sh:property [
    sh:path dcterms:rights ;
    sh:hasValue "All rights reserved"
  ] .
`;
  const doc = await parseShaclToYama(ttl);
  const stmts = doc.descriptions.Item.statements;
  const extent = Object.values(stmts).find((s) => s.property === "dcterms:extent");
  assertEquals(extent.facets, {
    MinExclusive: 0,
    MaxExclusive: 100,
    MinLength: 1,
    MaxLength: 10,
  });
  const lang = Object.values(stmts).find((s) => s.property === "dcterms:language");
  assertEquals(lang.languageTag, ["en", "ja"]);
  const rights = Object.values(stmts).find((s) => s.property === "dcterms:rights");
  assertEquals(rights.values, ["All rights reserved"]);
});

Deno.test("from-shacl: sh:in IRI members import as CURIEs", async () => {
  const ttl = `${PREAMBLE}
ex1:Item a sh:NodeShape ;
  sh:property [
    sh:path dcterms:license ;
    sh:nodeKind sh:IRI ;
    sh:in ( <http://creativecommons.org/licenses/by/4.0/> ex1:custom )
  ] .
`;
  const doc = await parseShaclToYama(ttl);
  const stmt = Object.values(doc.descriptions.Item.statements)[0];
  assertEquals(stmt.type, "IRI");
  assertEquals(stmt.values, [
    "http://creativecommons.org/licenses/by/4.0/",
    "ex1:custom",
  ]);
});

// ── Round-trips against the project's own generator ───────────────

Deno.test("from-shacl: IRI value set round-trips through generateSHACL", async () => {
  // kitchen-sink's license statement: type IRI with full-IRI + CURIE values.
  await withTempDir(async (dir) => {
    const out = `${dir}/shacl.ttl`;
    await captureWarnings(() =>
      quietly(() => generateSHACL(fixture("kitchen-sink.yaml"), { output: out }))
    );
    const ttl = await Deno.readTextFile(out);
    const doc = await parseShaclToYama(ttl);
    const stmts = doc.descriptions.book.statements;
    const license = Object.values(stmts).find(
      (s) => s.property === "dcterms:license",
    );
    assert(license, "license statement re-imported");
    assertEquals(license.type, "IRI");
    assert(
      license.values.includes("http://creativecommons.org/licenses/by/4.0/"),
      "full IRI member survives the round-trip",
    );
    assert(
      license.values.includes("ex:custom"),
      "CURIE member compacts back to ex:custom",
    );
  });
});

Deno.test("from-shacl: BNODE round-trips as sh:BlankNode", async () => {
  const yaml = `base: http://example.org/ap#
namespaces:
  ex: http://example.org/vocab#
descriptions:
  main:
    statements:
      creator:
        property: dcterms:creator
        type: BNODE
        description: agent
  agent:
    statements:
      name:
        property: foaf:name
`;
  await withTempDir(async (dir) => {
    const input = `${dir}/profile.yaml`;
    const out = `${dir}/shacl.ttl`;
    await Deno.writeTextFile(input, yaml);
    await quietly(() => generateSHACL(input, { output: out }));
    const ttl = await Deno.readTextFile(out);
    assert(ttl.includes("sh:BlankNode"), "generator emits sh:BlankNode");
    assert(
      !ttl.includes("sh:BlankNodeOrIRI"),
      "generator does not loosen BNODE to sh:BlankNodeOrIRI",
    );
    const doc = await parseShaclToYama(ttl);
    const creator = Object.values(doc.descriptions.main.statements).find(
      (s) => s.property === "dcterms:creator",
    );
    assertEquals(creator.type, "BNODE");
    assertEquals(creator.description, "agent");
  });
});

Deno.test("from-shacl: multi-scheme inScheme survives the SHACL round-trip", async () => {
  const yaml = `base: http://example.org/ap#
namespaces:
  loc: http://id.loc.gov/authorities/subjects/
  getty: http://vocab.getty.edu/aat/
descriptions:
  S:
    statements:
      subject:
        property: dcterms:subject
        type: IRI
        inScheme: [loc:, getty:]
`;
  await withTempDir(async (dir) => {
    const input = `${dir}/profile.yaml`;
    const out = `${dir}/shacl.ttl`;
    await Deno.writeTextFile(input, yaml);
    await quietly(() => generateSHACL(input, { output: out }));
    const doc = await parseShaclToYama(await Deno.readTextFile(out));
    const subject = Object.values(doc.descriptions.S.statements).find(
      (s) => s.property === "dcterms:subject",
    );
    assert(subject, "subject statement re-imported");
    assert(Array.isArray(subject.inScheme), "inScheme is a multi-value array");
    assert(
      subject.inScheme.includes("http://id.loc.gov/authorities/subjects/"),
      "first scheme survives",
    );
    assert(
      subject.inScheme.includes("http://vocab.getty.edu/aat/"),
      "second scheme survives",
    );
  });
});

Deno.test("from-shacl: multi-class sh:or imports into statement.a", async () => {
  const yaml = `base: http://example.org/ap#
namespaces:
  foaf: http://xmlns.com/foaf/0.1/
descriptions:
  S:
    statements:
      creator:
        property: dcterms:creator
        type: IRI
        a: [foaf:Person, foaf:Organization]
`;
  await withTempDir(async (dir) => {
    const input = `${dir}/profile.yaml`;
    const out = `${dir}/shacl.ttl`;
    await Deno.writeTextFile(input, yaml);
    await quietly(() => generateSHACL(input, { output: out }));
    const doc = await parseShaclToYama(await Deno.readTextFile(out));
    const creator = Object.values(doc.descriptions.S.statements).find(
      (s) => s.property === "dcterms:creator",
    );
    assert(creator, "creator statement re-imported");
    assert(Array.isArray(creator.a), "class constraint is a multi-value array");
    assert(creator.a.includes("foaf:Person"), "first class survives");
    assert(creator.a.includes("foaf:Organization"), "second class survives");
  });
});

// ── Inexpressible constructs warn instead of vanishing ────────────

Deno.test("from-shacl: inexpressible constructs are reported", async () => {
  const ttl = `${PREAMBLE}
ex1:Item a sh:NodeShape ;
  sh:targetNode ex1:item1 ;
  sh:or ( [ sh:class ex1:A ] [ sh:class ex1:B ] ) ;
  sh:property [
    sh:path dcterms:title ;
    sh:uniqueLang true ;
    sh:severity sh:Warning ;
    sh:message "title needed"
  ] ;
  sh:property [
    sh:path dcterms:subject ;
    sh:qualifiedValueShape [ sh:nodeKind sh:IRI ]
  ] .
`;
  const { warnings } = await captureWarnings(() => parseShaclToYama(ttl));
  const text = warnings.join("\n");
  for (const term of [
    "sh:targetNode",
    "sh:or",
    "sh:uniqueLang",
    "sh:severity",
    "sh:message",
    "sh:qualifiedValueShape",
  ]) {
    assert(text.includes(term), `${term} loss is reported`);
  }
});

Deno.test("from-shacl: blank-node sh:path warns and skips the property", async () => {
  const ttl = `${PREAMBLE}
ex1:Item a sh:NodeShape ;
  sh:property [
    sh:path ( dcterms:creator foaf:name ) ;
    sh:minCount 1
  ] ;
  sh:property [ sh:path dcterms:title ] .
`;
  const { result: doc, warnings } = await captureWarnings(
    () => parseShaclToYama(ttl),
  );
  const stmts = doc.descriptions.Item.statements;
  assertEquals(Object.keys(stmts).length, 1, "sequence path skipped");
  const props = Object.values(stmts).map((s) => s.property);
  assertEquals(props, ["dcterms:title"]);
  assert(
    warnings.some((w) => w.includes("sequence/inverse path")),
    "skip is reported",
  );
  assert(
    !Object.keys(stmts).some((k) => /^n3-/.test(k)),
    "no blank-node labels leak into statement keys",
  );
});
