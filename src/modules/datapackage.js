/**
 * @fileoverview Frictionless Data Package generation from YAMA files.
 *
 * Translates a YAMA application profile into a Frictionless Data Package
 * descriptor (`datapackage.json`). Since YAMA already declares data sources,
 * field mappings, types, and constraints, most of the information needed for
 * a Data Package is already present in the document.
 *
 * YAMA-to-Data Package mapping:
 *
 * | YAMA element                | Data Package                          |
 * |-----------------------------|---------------------------------------|
 * | document                    | Package                               |
 * | `base`                      | `id`                                  |
 * | description's source files  | Resources (grouped by source path)    |
 * | description `label`         | Resource `title`                      |
 * | description `note`          | Resource `description`                |
 * | `mapping.type`              | Resource `format` / `mediatype`       |
 * | `id.mapping.path`           | `schema.primaryKey`                   |
 * | statement `mapping.path`    | Field `name`                          |
 * | statement `label`           | Field `title`                         |
 * | statement `note`            | Field `description`                   |
 * | statement `datatype`        | Field `type` (XSD → Frictionless)     |
 * | statement `type: IRI`       | Field `type: "string"`, `format: "uri"`|
 * | statement `min >= 1`        | Field constraint `required: true`     |
 * | statement `pattern`         | Field constraint `pattern`            |
 * | statement `values`          | Field constraint `enum`               |
 * | statement `facets`          | Field constraints `minimum`/`maximum` |
 *
 * @module datapackage
 * @see https://datapackage.org
 */

import { parse as parseYaml } from "@std/yaml";
import { basename } from "@std/path";
import { datatypes, primaryNodeType, readInput, statusLog } from "./io.js";

// ---------------------------------------------------------------------------
// XSD-to-Frictionless type mapping
// ---------------------------------------------------------------------------

/**
 * Maps XSD datatype local names to Frictionless field type and format.
 *
 * @type {Object<string, {type: string, format?: string}>}
 */
const XSD_TYPE_MAP = {
  string:       { type: "string" },
  integer:      { type: "integer" },
  int:          { type: "integer" },
  long:         { type: "integer" },
  short:        { type: "integer" },
  byte:         { type: "integer" },
  decimal:      { type: "number" },
  float:        { type: "number" },
  double:       { type: "number" },
  boolean:      { type: "boolean" },
  date:         { type: "date" },
  dateTime:     { type: "datetime" },
  time:         { type: "time" },
  gYear:        { type: "year" },
  gYearMonth:   { type: "yearmonth" },
  duration:     { type: "duration" },
  anyURI:       { type: "string", format: "uri" },
  base64Binary: { type: "string", format: "binary" },
};

/**
 * Maps source file type strings to IANA media types.
 *
 * @type {Object<string, string>}
 */
const MEDIATYPE_MAP = {
  csv:  "text/csv",
  json: "application/json",
  yaml: "application/x-yaml",
  yml:  "application/x-yaml",
};

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a YAMA statement's type information to a Frictionless field
 * type descriptor (`type` and optionally `format`).
 *
 * Resolution order:
 *   1. If `datatype` is declared (e.g. `xsd:string`), use the XSD mapping.
 *   2. If `type` is IRI/URI, return `string` with `format: "uri"`.
 *   3. Default to `string`.
 *
 * @param {Object} stmtDef - Statement definition from the YAMA document.
 * @returns {{type: string, format?: string}}
 */
function resolveFieldType(stmtDef, fieldName) {
  // Frictionless allows only one type per field. For multi-datatype
  // statements we emit the first and report the dropped extras.
  const dts = datatypes(stmtDef);
  if (dts.length > 1) {
    console.warn(
      `Warning: field "${fieldName}": Frictionless fields have one type — kept ${
        dts[0]
      }, dropped ${dts.slice(1).join(", ")}.`,
    );
  }
  const first = dts[0];
  if (first) {
    const local = first.includes(":") ? first.split(":").pop() : first;
    const mapped = XSD_TYPE_MAP[local];
    if (mapped) return { ...mapped };
    console.warn(
      `Warning: field "${fieldName}": datatype ${first} has no Frictionless mapping — falling back to string.`,
    );
    return { type: "string" };
  }

  if (primaryNodeType(stmtDef) === "IRI") {
    return { type: "string", format: "uri" };
  }

  return { type: "string" };
}

// ---------------------------------------------------------------------------
// Constraint builder
// ---------------------------------------------------------------------------

/**
 * Builds a Frictionless constraints object from a YAMA statement.
 *
 * @param {Object} stmtDef - Statement definition.
 * @returns {Object|null} Constraints object, or null if none apply.
 */
function buildConstraints(stmtDef) {
  const constraints = {};

  // required: min >= 1 means the field cannot be empty
  if (stmtDef.min != null && stmtDef.min >= 1) {
    constraints.required = true;
  }

  // enum from values list
  if (Array.isArray(stmtDef.values) && stmtDef.values.length > 0) {
    constraints.enum = stmtDef.values;
  }

  // pattern
  if (stmtDef.pattern) {
    constraints.pattern = stmtDef.pattern;
  }

  // Numeric facets
  if (stmtDef.facets) {
    if (stmtDef.facets.MinInclusive != null) {
      constraints.minimum = stmtDef.facets.MinInclusive;
    }
    if (stmtDef.facets.MaxInclusive != null) {
      constraints.maximum = stmtDef.facets.MaxInclusive;
    }
    if (stmtDef.facets.MinLength != null) {
      constraints.minLength = stmtDef.facets.MinLength;
    }
    if (stmtDef.facets.MaxLength != null) {
      constraints.maxLength = stmtDef.facets.MaxLength;
    }
  }

  return Object.keys(constraints).length > 0 ? constraints : null;
}

// ---------------------------------------------------------------------------
// Resource builder
// ---------------------------------------------------------------------------

/**
 * Collects all unique data sources referenced in the YAMA document,
 * grouped by source path. Each source becomes one Data Package resource.
 *
 * Multiple descriptions may reference the same source file — their fields
 * are merged into a single resource schema.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @returns {Map<string, Object>} Map of source path → resource-in-progress.
 */
function collectResources(doc) {
  const defaults = doc.defaults || {};
  const descriptions = doc.descriptions || {};

  /** @type {Map<string, {source: string, type: string, title?: string, description?: string, primaryKey?: string, fields: Map<string, Object>}>} */
  const resources = new Map();

  for (const [, descDef] of Object.entries(descriptions)) {
    // Determine the source for this description's ID mapping
    const idMapping = descDef.id?.mapping;
    const effectiveIdMapping = idMapping
      ? { ...(defaults.mapping || {}), ...idMapping }
      : defaults.mapping;

    if (!effectiveIdMapping?.source) continue;

    const source = effectiveIdMapping.source;
    const sourceType = (effectiveIdMapping.type || inferType(source)).toLowerCase();

    // Get or create the resource entry
    if (!resources.has(source)) {
      resources.set(source, {
        source,
        type: sourceType,
        title: descDef.label || undefined,
        description: descDef.note || undefined,
        primaryKey: undefined,
        fields: new Map(),
      });
    }

    const resource = resources.get(source);

    // Primary key from id mapping path
    if (effectiveIdMapping.path && !resource.primaryKey) {
      resource.primaryKey = effectiveIdMapping.path;

      // Add the ID field itself
      if (!resource.fields.has(effectiveIdMapping.path)) {
        resource.fields.set(effectiveIdMapping.path, {
          name: effectiveIdMapping.path,
          type: "string",
        });
      }
    }

    // Process statements to discover fields
    if (!descDef.statements) continue;

    for (const [, stmtDef] of Object.entries(descDef.statements)) {
      const stmtMapping = stmtDef.mapping
        ? { ...(defaults.mapping || {}), ...stmtDef.mapping }
        : null;

      if (!stmtMapping?.path) continue;

      // Statements may read from a different source than the
      // description's id mapping (spec §5.4) — those fields go into
      // their own resource for that source instead of being dropped.
      const stmtSource = stmtMapping.source || defaults.mapping?.source;
      let targetResource = resource;
      if (stmtSource !== source) {
        if (!resources.has(stmtSource)) {
          resources.set(stmtSource, {
            source: stmtSource,
            type: (stmtMapping.type || inferType(stmtSource)).toLowerCase(),
            title: undefined,
            description: undefined,
            primaryKey: undefined,
            fields: new Map(),
          });
        }
        targetResource = resources.get(stmtSource);
      }

      const fieldName = stmtMapping.path;

      // Don't overwrite an existing field with richer metadata
      if (targetResource.fields.has(fieldName)) continue;

      const fieldType = resolveFieldType(stmtDef, fieldName);
      const field = {
        name: fieldName,
        type: fieldType.type,
      };

      if (fieldType.format) {
        field.format = fieldType.format;
      }

      if (stmtDef.label) {
        field.title = stmtDef.label;
      }

      if (stmtDef.note) {
        field.description = stmtDef.note;
      }

      const constraints = buildConstraints(stmtDef);
      if (constraints) {
        field.constraints = constraints;
      }

      targetResource.fields.set(fieldName, field);
    }
  }

  return resources;
}

/**
 * Infers the data source type from file extension.
 *
 * @param {string} path
 * @returns {string}
 */
function inferType(path) {
  const ext = path.split(".").pop().toLowerCase();
  return ext === "yml" ? "yaml" : ext;
}

/**
 * Normalises a string to the Frictionless resource name pattern:
 * lowercase alphanumerics plus `.`, `_`, and `-`. Any other
 * character becomes `-`.
 *
 * @param {string} s
 * @returns {string}
 */
function toResourceName(s) {
  const name = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "resource";
}

// ---------------------------------------------------------------------------
// Package builder
// ---------------------------------------------------------------------------

/**
 * Builds a Frictionless Data Package descriptor from a parsed YAMA document.
 *
 * @param {Object} doc - Parsed YAMA document.
 * @returns {Object} Data Package descriptor (JSON-serializable).
 */
function buildDataPackage(doc) {
  const pkg = {};

  if (doc.base) {
    pkg.id = doc.base;
  }

  const resources = collectResources(doc);
  pkg.resources = [];

  const usedNames = new Set();

  for (const [, res] of resources) {
    // Resource names must match the Frictionless pattern (lowercase
    // alphanumerics plus ._-) and be unique within the package.
    let name = toResourceName(basename(res.source, `.${res.type}`));
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name}-${n}`)) n++;
      name = `${name}-${n}`;
    }
    usedNames.add(name);

    const resource = {
      name,
      path: res.source,
      type: "table",
      format: res.type,
    };

    if (MEDIATYPE_MAP[res.type]) {
      resource.mediatype = MEDIATYPE_MAP[res.type];
    }

    if (res.title) {
      resource.title = res.title;
    }

    if (res.description) {
      resource.description = res.description;
    }

    // Build schema
    const schema = {
      fields: [...res.fields.values()],
    };

    if (res.primaryKey) {
      schema.primaryKey = [res.primaryKey];
    }

    resource.schema = schema;
    pkg.resources.push(resource);
  }

  return pkg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a Frictionless Data Package descriptor from a YAMA file.
 *
 * @param {string} file     - Path to the YAMA input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function generateDataPackage(file, output) {
  const doc = parseYaml(await readInput(file));
  const pkg = buildDataPackage(doc);
  const json = JSON.stringify(pkg, null, 2);

  if (output) {
    Deno.writeTextFileSync(output, json);
    statusLog(`Written to ${output}`);
  } else {
    console.log(json);
  }
}
