import {
  parse as yamlParse,
  parseAll as yamlParseAll,
  stringify as yamlStringify,
} from "https://deno.land/std@0.143.0/encoding/yaml.ts";
import nunjucks from "https://deno.land/x/nunjucks@3.2.3/mod.js";
import { Sha1 } from "https://deno.land/std/hash/sha1.ts";

import { writeJson, writeJsonSync } from "https://deno.land/x/jsonfile/mod.ts";

import factory from "https://esm.sh/@graphy/core.data.factory";
import ttl_write from "https://esm.sh/@graphy/content.ttl.write";

import { jsonata, parseCsv } from "./deps.js";
import { writeFile } from "./utils.js";

let dataHolder = {};

export function generateRDF(file, output = "") {
  generateMapperData(file, output);
}

async function generateMapperData(file, output = "") {
  const dataWithMapping = yamlParse(await Deno.readTextFile(file));
  buildMappedTree(dataWithMapping, output);
}

async function buildMappedTreeRaw(ap) {
  // console.log(ap);
  await writeToJsonFile("mapper-output.json", ap);
  let propertyList = [];
  Object.keys(ap.descriptions).forEach((val) => propertyList.push(val));
  propertyList.forEach((description) => {
    console.log(description);
  });
}

async function getCSVData(source) {
  const csv_data = await parseCsv(await Deno.readTextFile(source), {
    skipFirstRow: true,
  });
  return csv_data;
}

async function getData(source) {
  const sourceHash = new Sha1().update(source);
  const sourceKey = sourceHash.toString();
  //  console.log(sourceKey);
  if (dataHolder[sourceKey]) {
    return dataHolder[sourceKey];
  } else {
    // console.log(await getCSVData(source));
    dataHolder[sourceKey] = await getCSVData(source);
    return dataHolder[sourceKey];
  }
}

async function writeToJsonFile(file, data) {
  const jsonDataWriter = await writeJson(file, data, {
    spaces: 2,
  });
}

let rdfHolder = {};

async function buildRdf(ap, data, output = "") {
  let ds_writer = ttl_write({
    prefixes: ap.namespaces,
  });

  // pipe to stdout
  ds_writer.on("data", (s_turtle) => {
    console.log(s_turtle + "");
  });

  /*  if (output) {
    ds_writer.on("data", (s_turtle) => {
      console.log(writeFile(output, s_turtle));
    });
  } else {
    // pipe to stdout
    ds_writer.on("data", (s_turtle) => {
      console.log(s_turtle + "");
    });
  } */

  // write some triples using a concise triples hash
  ds_writer.write({
    type: "c3",
    value: data,
  });
  // end the writable side of the transform
  ds_writer.end();
}

async function buildMappedTree(ap, output = "") {
  // console.log(ap);
  // await writeToJsonFile("mapper-output.json", ap);
  // let propertyList = [];
  let descriptions = jsonata("$keys(descriptions)").evaluate(ap);
  // console.log(descriptions);
  for (const description of descriptions) {
    let localDescription = jsonata(`descriptions.${description}`).evaluate(ap);
    // console.log(localDescription);
    if (localDescription.id) {
      let idData = await getData(localDescription.id.mapping.source);
      // console.log(idData);
      // console.log(`${localDescription.id.mapping.path}`);
      let ids = await jsonata(`${localDescription.id.mapping.path}`).evaluate(
        idData
      );
      for (const id of ids) {
        rdfHolder[`>${id}`] = {
          a: localDescription.a,
        };
        const statements = await jsonata(`$keys(statements)`).evaluate(
          localDescription
        );
        for (const statement of statements) {
          const property = jsonata(`statements.${statement}.property`).evaluate(
            localDescription
          );
          let type = jsonata(`statements.${statement}.type`).evaluate(
            localDescription
          );

          // console.log(type);

          type = type ? type : "literal";

          // console.log(type);

          const path = jsonata(`statements.${statement}.mapping.path`).evaluate(
            localDescription
          );
          let seperatorChar = jsonata(
            `statements.${statement}.mapping.seperator`
          ).evaluate(localDescription);
          // console.log(seperatorChar);
          seperatorChar = seperatorChar ? seperatorChar : "";

          let appendString = jsonata(
            `statements.${statement}.mapping.append`
          ).evaluate(localDescription);

          appendString = appendString ? appendString : "";
          let prependString = jsonata(
            `statements.${statement}.mapping.prepend`
          ).evaluate(localDescription);
          prependString = prependString ? prependString : "";

          // [ID="${id}"]
          // console.log(path);
          //$[(ID = "sheldon-cooper")].name;
          // console.log(JSON.stringify(idData));
          const jsonataString = `$[(ID = "${id}")].${path}`;
          // console.log(jsonataString);
          const value = jsonata(jsonataString).evaluate(idData);

          // console.log(value);
          if (
            type.toUpperCase() === "BNODE" ||
            (value !== undefined && value !== null && value !== "")
          ) {
            if (type === "literal") {
              if (seperatorChar) {
                const valueHolder = value.split(seperatorChar);
                for (const valueItem of valueHolder) {
                  rdfHolder[`>${id}`][
                    `${property}`
                  ] = `@en"${prependString}${valueItem}${appendString}`;
                }
              } else {
                rdfHolder[`>${id}`][
                  `${property}`
                ] = `@en"${prependString}${value}${appendString}`;
              }
            }
            if (type.toUpperCase() === "IRI" || type.toUpperCase() === "URI") {
              if (seperatorChar) {
                let valueHolder = value.split(seperatorChar);

                // valueHolder = valueHolder.map((i) => ">" + i);
                // console.log(valueHolder);
                for (const valueItem of valueHolder) {
                  rdfHolder[`>${id}`][
                    `${property}`
                  ] = `>${prependString}${valueItem}${appendString}`;
                }
              } else {
                rdfHolder[`>${id}`][
                  `${property}`
                ] = `>${prependString}${value}${appendString}`;
              }
            }
            if (type === "BNODE") {
              // console.log(type);
              const description = jsonata(
                `statements.${statement}.description`
              ).evaluate(localDescription);
              const bnodeVal = await buildBnode(ap, description, id);
              console.log(bnodeVal);
              rdfHolder[`>${id}`][`${property}`] = bnodeVal;
            }
          }
        }
      }
    }
  }

  async function buildBnode(ap, descriptions, idVal = "") {
    let rdfHolder = [];
    // console.log(ap);
    // await writeToJsonFile("mapper-output.json", ap);
    // let propertyList = [];
    //  let descriptions = jsonata("$keys(descriptions)").evaluate(ap);
    // console.log(descriptions);
    for (const description of [descriptions]) {
      const localDescription = jsonata(`descriptions.${description}`).evaluate(
        ap
      );
      // console.log(localDescription);
      const id = idVal ?? localDescription.id;
      if (id) {
        const idData = await getData(localDescription.id.mapping.source);
        console.log(idData);
        // console.log(`${localDescription.id.mapping.path}`);
        //let ids = await jsonata(`${localDescription.id.mapping.path}`).evaluate(
        // idData
        //);
        const ids = [id];
        for (const id of ids) {
          // rdfHolder[`>${id}`] = {
          //  a: localDescription.a,
          // };
          const statements = await jsonata(`$keys(statements)`).evaluate(
            localDescription
          );
          for (const statement of statements) {
            const property = jsonata(
              `statements.${statement}.property`
            ).evaluate(localDescription);
            let type = jsonata(`statements.${statement}.type`).evaluate(
              localDescription
            );

            type = type ? type : "literal";

            const path = jsonata(
              `statements.${statement}.mapping.path`
            ).evaluate(localDescription);
            let seperatorChar = jsonata(
              `statements.${statement}.mapping.seperator`
            ).evaluate(localDescription);
            let appendString = jsonata(
              `statements.${statement}.mapping.append`
            ).evaluate(localDescription);
            let prependString = jsonata(
              `statements.${statement}.mapping.prepend`
            ).evaluate(localDescription);
            // console.log(seperatorChar);
            seperatorChar = seperatorChar ? seperatorChar : "";
            // [ID="${id}"]
            // console.log(path);
            //$[(ID = "sheldon-cooper")].name;
            // console.log(JSON.stringify(idData));
            const jsonataString = `$[(ID = "${id}")].${path}`;
            console.log(jsonataString);
            const value = jsonata(jsonataString).evaluate(idData);
            console.log(value);
            if (value !== undefined && value !== null && value !== "") {
              if (type === "literal") {
                if (seperatorChar) {
                  const valueHolder = value.split(seperatorChar);
                  for (const valueItem of valueHolder) {
                    rdfHolder[`>${id}`][
                      `${property}`
                    ] = `@en"${appendString}${valueItem}${prependString}`;
                  }
                } else {
                  rdfHolder[`>${id}`][
                    `${property}`
                  ] = `@en"${appendString}${value}${prependString}`;
                }
              }
              if (
                type.toUpperCase() === "IRI" ||
                type.toUpperCase() === "URI"
              ) {
                if (seperatorChar) {
                  let valueHolder = value.split(seperatorChar);
                  // valueHolder = valueHolder.map((i) => ">" + i);
                  // console.log(valueHolder);
                  for (const valueItem of valueHolder) {
                    rdfHolder[`>${id}`][
                      `${property}`
                    ] = `>${appendString}${valueItem}${prependString}`;
                  }
                } else {
                  rdfHolder[`>${id}`][
                    `${property}`
                  ] = `>${appendString}${value}${prependString}`;
                }
              }
              if (
                type.toUpperCase() === "BNODE" ||
                type.toUpperCase() === "BLANKNODE"
              ) {
                if (seperatorChar) {
                  let valueHolder = value.split(seperatorChar);

                  // valueHolder = valueHolder.map((i) => ">" + i);
                  // console.log(valueHolder);
                  for (const valueItem of valueHolder) {
                    rdfHolder[`>${id}`][`${property}`] = `>${valueItem}`;
                  }
                } else {
                  rdfHolder[`>${id}`][`${property}`] = `>${value}`;
                }
              }
            }
          }
        }
      }
    }
    console.log(rdfHolder);
    return rdfHolder;
  }

  buildRdf(ap, rdfHolder, output);
}
