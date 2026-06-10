/**
 * @fileoverview Regression tests for the validation engine: crash
 * guards, type coercion, the IRIstem typo, case-insensitive DCTAP
 * headers, SimpleDSP value types and line numbers, and the spec rules
 * for BNODE, cardinality, facets, pattern, and values.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  validateDctapRaw,
  validateFile,
  validateYamaDocument,
} from "../src/modules/validate.js";
import { fixture } from "./helpers.js";

/** Convenience: collects all error messages from a report. */
function errorMessages(report) {
  return report.errors.map((e) => e.message).join("\n");
}

/** Convenience: collects all warning messages from a report. */
function warningMessages(report) {
  return report.warnings.map((w) => w.message).join("\n");
}

// ── Crash guards ──────────────────────────────────────────────────

Deno.test("validate: empty YAML file yields an INVALID report, not a crash", async () => {
  const report = await validateFile(fixture("empty.yaml"));
  assertEquals(report.valid, false);
  assertStringIncludes(errorMessages(report), "empty");
});

Deno.test("validate: YAML syntax error yields a structured report", async () => {
  const path = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(path, "descriptions: [unclosed");
    const report = await validateFile(path);
    assertEquals(report.valid, false);
    assertStringIncludes(errorMessages(report), "YAML syntax error");
    // The report must be JSON-serializable for --format json.
    JSON.parse(JSON.stringify(report));
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("validate: non-string type and string min do not crash", async () => {
  const report = await validateFile(fixture("type-coerce.yaml"));
  assertEquals(report.valid, false);
  const msgs = errorMessages(report);
  assertStringIncludes(msgs, 'Invalid type "true"');
  assertStringIncludes(msgs, "non-negative integer");
});

Deno.test("validate: null statement and description bodies are reported", () => {
  const report = validateYamaDocument(
    { descriptions: { MAIN: { statements: { title: null } }, Stray: null } },
    "inline.yaml",
  );
  assertEquals(report.valid, false);
  const msgs = errorMessages(report);
  assertStringIncludes(msgs, '"title" in "MAIN" is not a mapping');
  assertStringIncludes(msgs, '"Stray" is not a mapping');
});

// ── Spec rules (§4.2–§4.5) ────────────────────────────────────────

Deno.test("validate: BNODE without description is an error (§4.2)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          creator: { property: "dcterms:creator", type: "BNODE" },
        },
      },
    },
  }, "inline.yaml");
  assertEquals(report.valid, false);
  assertStringIncludes(errorMessages(report), "BNODE");
});

Deno.test("validate: BNODE with description passes (§4.2)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          creator: {
            property: "dcterms:creator",
            type: "BNODE",
            description: "Agent",
          },
        },
      },
      Agent: { statements: { name: { property: "foaf:name" } } },
    },
  }, "inline.yaml");
  assertEquals(report.valid, true);
});

Deno.test("validate: negative and fractional cardinality rejected (§4.3)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          a: { property: "dcterms:title", min: -1 },
          b: { property: "dcterms:creator", max: 1.5 },
        },
      },
    },
  }, "inline.yaml");
  const msgs = errorMessages(report);
  assertStringIncludes(msgs, 'Invalid min "-1"');
  assertStringIncludes(msgs, 'Invalid max "1.5"');
});

Deno.test("validate: string min/max rejected instead of lexicographic compare (§4.3)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          a: { property: "dcterms:title", min: "10", max: "9" },
        },
      },
    },
  }, "inline.yaml");
  const msgs = errorMessages(report);
  assertStringIncludes(msgs, "non-negative integer");
  // No bogus min>max error derived from string comparison.
  assert(!msgs.includes("exceeds max"));
});

Deno.test("validate: wrong-case facet key warns with suggestion (§4.4)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          age: {
            property: "foaf:age",
            facets: { minInclusive: 0, MaxInclusive: 150, Bogus: 1 },
          },
        },
      },
    },
  }, "inline.yaml");
  const warns = report.warnings.map((w) => `${w.message} ${w.fix}`).join("\n");
  assertStringIncludes(warns, 'Unknown facet "minInclusive"');
  assertStringIncludes(warns, 'Did you mean "MinInclusive"?');
  assertStringIncludes(warns, 'Unknown facet "Bogus"');
  assert(!warns.includes('Unknown facet "MaxInclusive"'));
});

Deno.test("validate: non-compiling pattern warns (§4.5)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          issn: { property: "schema:issn", pattern: "([unclosed" },
        },
      },
    },
  }, "inline.yaml");
  assertStringIncludes(warningMessages(report), "does not compile");
});

Deno.test("validate: scalar values is an error (§4.5)", () => {
  const report = validateYamaDocument({
    descriptions: {
      MAIN: {
        statements: {
          format: { property: "dcterms:format", values: "print" },
        },
      },
    },
  }, "inline.yaml");
  assertEquals(report.valid, false);
  assertStringIncludes(errorMessages(report), "must be a sequence");
});

// ── DCTAP ─────────────────────────────────────────────────────────

Deno.test("validate: IRIstem is a standard constraint type (typo fix)", async () => {
  const report = await validateFile(fixture("dctap-iristem.csv"));
  assertEquals(report.valid, true);
  assert(
    !warningMessages(report).includes("non-standard valueConstraintType"),
    "IRIstem must not be flagged as non-standard",
  );
});

Deno.test("validate: DCTAP headers match case-insensitively like the importer", async () => {
  // dctap-iristem.csv uses all-lowercase headers (shapeid, propertyid…).
  const report = await validateFile(fixture("dctap-iristem.csv"));
  assertEquals(report.format, "dctap");
  assert(
    !errorMessages(report).includes("missing propertyID"),
    "lowercase propertyid header must be recognised",
  );
});

Deno.test("validate: numeric DCTAP cells do not crash boolean checks", () => {
  // Excel sheets deliver numbers, not strings.
  const rows = [
    { propertyID: "dcterms:title", mandatory: 1, repeatable: 0 },
    { propertyID: "dcterms:creator", mandatory: 2, valueNodeType: 5 },
  ];
  const { errors, warnings } = validateDctapRaw(rows, null);
  // mandatory: 1 / repeatable: 0 are recognised booleans.
  const warnText = warnings.map((w) => w.message).join("\n");
  assert(!warnText.includes('"mandatory" value "1"'));
  // mandatory: 2 is flagged (not crashed on).
  assertStringIncludes(warnText, '"mandatory" value "2"');
  assertStringIncludes(
    errors.map((e) => e.message).join("\n"),
    'invalid valueNodeType "5"',
  );
});

// ── SimpleDSP ─────────────────────────────────────────────────────

Deno.test("validate: undeclared SimpleDSP prefix is info, matching the DCTAP path", async () => {
  // simpledsp-undeclared-prefix.tsv carries "myns:custom" as a literal
  // datatype constraint without declaring "myns" in [@NS].
  const dsp = await validateFile(fixture("simpledsp-undeclared-prefix.tsv"));
  const dspDiag = dsp.info.find((d) => d.message.includes('"myns"'));
  assert(dspDiag, "undeclared prefix surfaces in info");
  assert(
    !errorMessages(dsp).includes('"myns"'),
    "no error-level duplicate for the same prefix",
  );

  // The DCTAP path is the severity reference: same prefix, same class.
  const tap = await validateFile(fixture("dctap-undeclared-prefix.csv"));
  const tapDiag = tap.info.find((d) => d.message.includes('"myns"'));
  assert(tapDiag, "DCTAP control case reports the same prefix");
  assertEquals(dspDiag.severity, tapDiag.severity);
});

Deno.test("validate: 参照値(URI) accepted, real line numbers reported", async () => {
  const report = await validateFile(fixture("simpledsp-jp-types.tsv"));
  const msgs = errorMessages(report);
  assert(
    !msgs.includes("参照値(URI)"),
    "the spec's 参照値(URI) value type must be accepted",
  );
  // The bogus value type sits on physical line 6 of the fixture.
  const vtError = report.errors.find((e) =>
    e.message.includes('Unknown value type "nonsense"')
  );
  assert(vtError, "unknown value type must be flagged");
  assertEquals(vtError.location.line, 6);
});
