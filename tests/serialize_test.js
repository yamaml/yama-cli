/**
 * @fileoverview Regression tests for the shared RDF serializer.
 *
 * Audit finding covered: JSON-LD blank-node subjects must carry the
 * `_:` prefix so the graph stays connected.
 */

import { assert, assertEquals } from "@std/assert";
import N3 from "n3";
import { serializeRdf } from "../src/modules/serialize.js";
import { quietly, withTempDir } from "./helpers.js";

const { namedNode, literal, blankNode, quad } = N3.DataFactory;

Deno.test("serialize: JSON-LD blank-node subjects get _: prefix", async () => {
  await withTempDir(async (dir) => {
    const bn = blankNode("b0");
    const quads = [
      quad(
        namedNode("http://example.org/s"),
        namedNode("http://example.org/p"),
        bn,
      ),
      quad(bn, namedNode("http://example.org/q"), literal("v")),
    ];
    const out = `${dir}/out.jsonld`;
    await quietly(() => serializeRdf(quads, {}, "", out, "jsonld"));
    const doc = JSON.parse(await Deno.readTextFile(out));

    const ids = doc["@graph"].map((n) => n["@id"]);
    assert(ids.includes("_:b0"), `blank subject has _: prefix (got ${ids})`);

    // the object reference and the subject node use the same label
    const root = doc["@graph"].find((n) => n["@id"] === "http://example.org/s");
    assertEquals(root["http://example.org/p"]["@id"], "_:b0");
  });
});
