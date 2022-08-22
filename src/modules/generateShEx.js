import {
  parse as yamlParse,
  parseAll as yamlParseAll,
  stringify as yamlStringify,
} from "https://deno.land/std@0.143.0/encoding/yaml.ts";
import nunjucks from "https://deno.land/x/nunjucks@3.2.3/mod.js";
import { existsSync } from "https://deno.land/std/fs/mod.ts";
import { writeFile, writeJson } from "./utils.js";
import { SHEX_TEMPLATE } from "./defaults.js";

export async function generateShEx(file, output) {
  const data = yamlParse(await Deno.readTextFile(file));
  // console.log(data);

  let shexC = "";

  const shexTemplate = existsSync("templates/shex.njk");
  if (shexTemplate) {
    nunjucks.configure("templates", { autoescape: true });
    shexC = nunjucks.render("shex.njk", data);
  } else {
    nunjucks.configure({ autoescape: true });
    shexC = nunjucks.renderString(SHEX_TEMPLATE, data);
  }
  if (output) {
    console.log(writeFile(output, shexC));
  } else {
    console.log(shexC);
  }
}

export async function generateJSON(file, output) {
  const data = yamlParse(await Deno.readTextFile(file));
  if (output) {
    console.log(writeJson(output, data));
  } else {
    console.log(data);
  }
}
