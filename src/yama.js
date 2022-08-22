import { parse } from "https://deno.land/std/flags/mod.ts";

import { generateRDF } from "./modules/generateMapperData.js";
import { generateShEx, generateJSON } from "./modules/generateShEx.js";

// console.log(parse(Deno.args));

const args = parse(Deno.args);

let cmd = args._[0] || "help";

if (args.version || args.v) {
  cmd = "version";
}

if (args.help || args.h) {
  cmd = "help";
}

switch (cmd) {
  case "shex":
    generateShEx(args.i, args.o);
    break;

  case "rdf":
    generateRDF(args.i, args.o);
    break;

  case "json":
    generateJSON(args.i, args.o);
    break;

  case "version":
    console.log("v0.0.3");
    break;

  case "help":
    console.log("usage : ");
    console.log("");
    console.log("\tshex");
    console.log("\t\tGenerate ShEx from YAMA");
    console.log(
      "\t\tyama shex -i [path/to/yama/file] -o [path/to/output/shex/file]"
    );

    console.log("\trdf");
    console.log("\t\tGenerate RDF from YAMAML");
    console.log(
      "\t\tyama rdf -i [path/to/yama/file] > [path/to/output/rdf/file]"
    );

    break;

  default:
    console.error(`"${cmd}" is not a valid command!`);
    break;
}

// generateMapperData(dataWithMapping);

// deno run --unstable --allow-all --no-check ./index.js rdf -i examples/tbbt_mapping.yaml
