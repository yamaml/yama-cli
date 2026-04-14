# yama-cli examples

Sample profiles you can explore or run through the CLI.

Each subfolder is self-contained: source files, input data (where relevant),
and pre-generated outputs for reference. You can regenerate the outputs
yourself using the `yama` commands shown below.

## Profiles

### [`tbbt/`](tbbt/) — *The Big Bang Theory* characters

A worked YAMAML profile for cataloging characters from a TV show. Demonstrates:

- A multi-description profile with `[address]` as a structured sub-description
- CSV → RDF data mapping from two spreadsheets (`tbbt_actors.csv`, `tbbt_characters.csv`)
- A linked variant (`tbbt-linked.yaml`) using cross-description IRI references
- Diagram rendering in colour and black-and-white variants

```sh
# Generate a full 14-artefact package from the profile
yama package -i examples/tbbt/tbbt.yaml -o examples/tbbt-out/

# Run individual commands
yama rdf -i examples/tbbt/tbbt.yaml -o tbbt.ttl
yama simpledsp -i examples/tbbt/tbbt.yaml -o tbbt.tsv
yama diagram -i examples/tbbt/tbbt.yaml -o tbbt-diagram.svg
```

### [`mangadesigner/`](mangadesigner/) — Digital Manga Model (DSP)

A reference artefact from the [MetaBridge](https://metabridge.jp/) registry:
the Digital Manga Model (DMM) published as a SimpleDSP schema. Useful for
testing SimpleDSP imports and seeing a real-world multi-block profile.

- `mangadesigner.xlsx` — the SimpleDSP schema as published
- `mangadesigner.rdf`, `mangadesigner.ttl` — SimpleDSP rendered to RDF/Turtle

```sh
# Import into YAMAML and regenerate artefacts
yama from-simpledsp -i examples/mangadesigner/mangadesigner.xlsx -o manga.yaml
```

## Adding new examples

Add a subfolder named for the profile (e.g. `books/`, `people/`) containing:

- The YAMAML source (`<name>.yaml`) or the SimpleDSP source for imports
- Any CSVs or fixtures used by `mapping` blocks
- Optional: pre-generated outputs as reference, clearly named

Prefer the YAMAML source as the canonical input. All other artefacts should be
reproducible by running the CLI.
