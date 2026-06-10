/**
 * @fileoverview YAML-to-JSON conversion for YAMA/YAMAML files.
 *
 * Parses a YAMA or YAMAML document and outputs the resulting object
 * as pretty-printed JSON. Useful for inspection, debugging, or feeding
 * into tools that consume JSON.
 *
 * @module json
 */

import { parse as parseYaml } from "@std/yaml";
import { readInput, statusLog } from "./io.js";

/**
 * Converts a YAMA/YAMAML file to JSON.
 *
 * @param {string} file     - Path to the input file.
 * @param {string} [output] - Output file path; stdout if omitted.
 * @returns {Promise<void>}
 */
export async function generateJSON(file, output) {
  const data = parseYaml(await readInput(file));
  const json = JSON.stringify(data, null, 2);

  if (output) {
    Deno.writeTextFileSync(output, json);
    statusLog(`Written to ${output}`);
  } else {
    console.log(json);
  }
}
