# yama-cli

[![JSR](https://jsr.io/badges/@nishad/yama)](https://jsr.io/@nishad/yama)
[![JSR Score](https://jsr.io/badges/@nishad/yama/score)](https://jsr.io/@nishad/yama)

A CLI toolkit for working with [YAMAML](https://docs.yamaml.org/specs/yamaml/spec/) application profiles. Converts between YAMA, SimpleDSP, DCTAP, SHACL, ShEx, OWL-DSP, RDF, Frictionless Data Packages, and more — with validation, documentation generation, and diagram rendering.

## Install

Published on [JSR](https://jsr.io/@nishad/yama) as `@nishad/yama`.

### As a global binary (recommended)

```bash
deno install --global --allow-read --allow-write --allow-env --allow-net --name yama jsr:@nishad/yama
```

Then use `yama` anywhere:

```bash
yama validate -i profile.yaml
```

### Run directly without installing

```bash
deno run --allow-read --allow-write --allow-env --allow-net jsr:@nishad/yama <command> [options]
```

### Pin a specific version

```bash
deno run -A jsr:@nishad/yama@1.0.0 validate -i profile.yaml
```

### From source (for development)

```bash
git clone https://github.com/yamaml/yama-cli && cd yama-cli
deno task start <command> [options]
```

**Requirements:** [Deno](https://deno.land) v2.0+

## Quick Start

```bash
# Create a new profile
yama init -o my-profile.yaml --name "Library Catalog" --ns schema,dcterms

# Validate any profile (YAMA, SimpleDSP, or DCTAP)
yama validate -i my-profile.yaml

# Generate publishable HTML documentation
yama report -i my-profile.yaml -o profile.html

# Generate a complete package with all format artifacts
yama package -i my-profile.yaml -o dist/

# Convert between formats
yama simpledsp -i my-profile.yaml -o profile.tsv
yama from-simpledsp -i profile.tsv -o profile.yaml
yama dctap -i my-profile.yaml -o profile.csv
yama from-dctap -i profile.csv -o profile.yaml
```

## Commands

### Create & Validate

| Command | Description |
|---------|-------------|
| `init` | Scaffold a new YAMA profile |
| `validate` | Validate a YAMA, SimpleDSP, or DCTAP file |

### Export (YAMA → other formats)

| Command | Description |
|---------|-------------|
| `report` | Generate profile documentation (HTML or Markdown) |
| `package` | Generate a complete profile package with all artifacts |
| `rdf` | Generate RDF instance data (requires data mappings) |
| `shacl` | Generate SHACL shapes |
| `shex` | Generate ShEx shapes |
| `dsp` | Generate OWL-DSP |
| `simpledsp` | Export to SimpleDSP (TSV, CSV, or Excel) |
| `dctap` | Export to DCTAP (CSV, TSV, or Excel) |
| `vocab` | Generate an RDF vocabulary/ontology definition |
| `diagram` | Generate a visual diagram (SVG, PDF, PNG, DOT, PS, EPS, JSON) |
| `datapackage` | Generate a Frictionless Data Package descriptor |
| `json` | Convert to JSON |

### Import (other formats → YAMA)

| Command | Description |
|---------|-------------|
| `from-simpledsp` | Import SimpleDSP (TSV, CSV, Excel) |
| `from-dctap` | Import DCTAP (CSV, TSV, Excel) |
| `from-shacl` | Import SHACL shapes (Turtle) |
| `from-shex` | Import ShEx shapes |

### Utilities

| Command | Description |
|---------|-------------|
| `render` | Render a DOT file to SVG/PDF/PNG (no Graphviz needed) |

## Options

```
-i, --input          Input file path or URL (required for most commands)
-o, --output         Output file path (stdout if omitted)
-f                   Output format:
                       rdf/shacl/dsp/vocab: turtle, jsonld, ntriples, nquads, trig
                       diagram: color (default), bw, overview, overview-bw
-l, --lang           Language for SimpleDSP: en (default) or jp
-q, --quiet          Suppress status messages
--format             Validate output format: human (default) or json
--input-format       Force input format: yaml, simpledsp, or dctap
--name               Init: profile name
--ns                 Init: comma-separated namespace prefixes
--base               Init: base URI
-h, --help           Show help (also: yama help <command>)
-v, --version        Show version
```

## Detailed Examples

### Scaffolding

```bash
# Interactive-style with options
yama init -o catalog.yaml --name "Library Catalog" --ns schema,dcterms,foaf --base http://example.org/library/

# Minimal (defaults: name="My Profile", ns=schema,dcterms)
yama init -o profile.yaml
```

### Validation

```bash
# Validate any supported format
yama validate -i profile.yaml
yama validate -i profile.tsv                       # SimpleDSP
yama validate -i profile.xlsx                      # SimpleDSP Excel
yama validate -i data.csv --input-format dctap     # DCTAP

# JSON output for CI pipelines
yama validate -i profile.yaml --format json

# Write report to file
yama validate -i profile.yaml --format json -o report.json
```

Exit codes: `0` = valid, `1` = errors found.

### Documentation & Packaging

```bash
# Standalone HTML documentation with embedded diagram and inline styles
# (single file, no CDN or network dependency)
yama report -i profile.yaml -o profile.html

# Markdown documentation
yama report -i profile.yaml -o profile.md

# From any input format
yama report -i profile.tsv -o profile.html
yama report -i dctap.csv -o profile.html --input-format dctap

# Full package (15 artifacts in a folder)
yama package -i profile.yaml -o my-profile/
```

The package command generates: `index.html`, `profile.md`, `README.md`, `profile.yaml`, `profile.json`, `simpledsp.tsv`, `simpledsp-jp.tsv`, `dctap.csv`, `shacl.ttl`, `shex.shex`, `owl-dsp.ttl`, `diagram.svg`, `diagram-detail.svg`, `diagram.pdf`, `datapackage.json`.

### Format Conversion

```bash
# YAMA ↔ SimpleDSP
yama simpledsp -i profile.yaml -o profile.tsv
yama simpledsp -i profile.yaml -o profile.xlsx
yama simpledsp -i profile.yaml -o profile.tsv -l jp    # Japanese headers
yama from-simpledsp -i profile.tsv -o profile.yaml
yama from-simpledsp -i profile.xlsx -o profile.yaml

# YAMA ↔ DCTAP
yama dctap -i profile.yaml -o profile.csv
yama from-dctap -i profile.csv -o profile.yaml

# YAMA ← SHACL / ShEx (import only)
yama from-shacl -i shapes.ttl -o profile.yaml
yama from-shex -i shapes.shex -o profile.yaml
```

### RDF & Constraint Languages

```bash
# Generate SHACL shapes
yama shacl -i profile.yaml -o shapes.ttl
yama shacl -i profile.yaml -f jsonld -o shapes.jsonld

# Generate ShEx shapes
yama shex -i profile.yaml -o shapes.shex

# Generate OWL-DSP
yama dsp -i profile.yaml -o dsp.ttl

# Generate RDF vocabulary (classes + properties)
yama vocab -i profile.yaml -o vocab.ttl
yama vocab -i profile.yaml -f jsonld -o vocab.jsonld

# Generate RDF instance data (requires data mappings in YAMA file)
yama rdf -i profile.yaml -o data.ttl
yama rdf -i profile.yaml -f jsonld -o data.jsonld
```

### Diagrams

```bash
# SVG diagram
yama diagram -i profile.yaml -o diagram.svg

# Vector PDF (selectable text, LaTeX-friendly)
yama diagram -i profile.yaml -o diagram.pdf

# PNG (4800px width)
yama diagram -i profile.yaml -o diagram.png

# Styles
yama diagram -i profile.yaml -o diagram.svg -f bw           # Black & white
yama diagram -i profile.yaml -o diagram.svg -f overview      # Simplified
yama diagram -i profile.yaml -o diagram.svg -f overview-bw   # Simplified B&W

# DOT source (for custom Graphviz rendering)
yama diagram -i profile.yaml -o diagram.dot

# Render DOT to SVG/PNG without Graphviz installed
yama render -i diagram.dot -o diagram.svg
```

### Other Outputs

```bash
# JSON representation
yama json -i profile.yaml -o profile.json

# Frictionless Data Package descriptor
yama datapackage -i profile.yaml -o datapackage.json
```

### URL Input

Any command that takes `-i` can accept an HTTP(S) URL:

```bash
yama validate -i https://example.com/profile.yaml
yama shacl -i https://example.com/profile.yaml -o shapes.ttl
yama report -i https://example.com/profile.yaml -o report.html
```

### Per-command Help

```bash
yama help validate         # Detailed help for a specific command
yama report --help         # Also works
yama --help                # Main help with examples
```

## Development

Run the regression test suite (validators, importers, generators, and
end-to-end CLI behaviour):

```bash
deno task test
```

## Compile to a Standalone Binary

For air-gapped environments or distribution without a Deno runtime:

```bash
git clone https://github.com/yamaml/yama-cli && cd yama-cli
deno task compile
# Produces ./yama — a self-contained executable
```

## Supported Formats

### Input Formats

| Format | Extensions | Auto-detected |
|--------|-----------|---------------|
| YAMAML | `.yaml`, `.yml` | Yes |
| SimpleDSP | `.tsv`, `.xlsx` | Yes |
| SimpleDSP/DCTAP | `.csv` | By content (use `--input-format` if ambiguous) |
| DCTAP | `.csv` | By headers (`shapeID`, `propertyID`) |
| SHACL | `.ttl` | Via `from-shacl` command |
| ShEx | `.shex` | Via `from-shex` command |

### Output Formats

| Format | Command | Extensions |
|--------|---------|-----------|
| YAMAML | `from-*` commands | `.yaml` |
| SimpleDSP | `simpledsp` | `.tsv`, `.csv`, `.xlsx` |
| DCTAP | `dctap` | `.csv`, `.tsv`, `.xlsx` |
| SHACL | `shacl` | `.ttl`, `.jsonld` |
| ShEx | `shex` | `.shex` |
| OWL-DSP | `dsp` | `.ttl`, `.jsonld` |
| RDF Vocabulary | `vocab` | `.ttl`, `.jsonld` |
| RDF Data | `rdf` | `.ttl`, `.jsonld`, `.nt`, `.nq` |
| HTML Report | `report` | `.html` |
| Markdown Report | `report` | `.md` |
| Diagram | `diagram` | `.svg`, `.pdf`, `.png`, `.dot`, `.ps`, `.eps`, `.json` |
| Data Package | `datapackage` | `.json` |
| JSON | `json` | `.json` |
| Full Package | `package` | directory with 15 files |

## SimpleDSP

SimpleDSP is a tab-separated text format for defining metadata description rules (Description Set Profiles), originally specified circa 2011 under the *Metadata Information Infrastructure Construction Project* (メタデータ情報基盤構築事業) and subsequently carried on by the [Metadata Information Infrastructure Initiative (MI3)](https://web.archive.org/web/20200209202846/http://mi3.or.jp/) (メタデータ基盤協議会, Japan) as part of the [MetaBridge](https://metabridge.jp/) registry.

YAMA CLI supports full bidirectional conversion between YAMA and SimpleDSP in TSV, CSV, and Excel formats. Both English and Japanese column headers and value type names are supported.

See the [SimpleDSP specification](https://docs.yamaml.org/specs/simpledsp/spec/) for the full format reference.

## DCTAP

[DC Tabular Application Profiles](https://dcmi.github.io/dctap/) (DCTAP) is a CSV format for expressing application profiles. YAMA CLI supports bidirectional conversion with full constraint type roundtrip: picklist, IRIstem, pattern, languageTag, minLength, maxLength, minInclusive, maxInclusive.

## Diagrams

The `diagram` command generates visual representations using a built-in layout engine (no Graphviz installation needed). Four styles are available:

| Style | Description |
|-------|-------------|
| `color` | Full detail with color (default) |
| `bw` | Full detail in black and white |
| `overview` | Simplified connection graph |
| `overview-bw` | Simplified connection graph in black and white |

Output formats: SVG, PDF (vector, selectable text), PNG (4800px width), DOT, PostScript, EPS, JSON.

## Data Mapping

YAMA supports a data mapping layer for generating RDF from tabular or structured data sources:

| Source Type | Description |
|-------------|-------------|
| CSV | Comma-separated values |
| Excel | Microsoft Excel workbooks (`.xlsx`, `.xls`) |
| JSON | JSON files or arrays |
| YAML | YAML files |
| Inline data | Data embedded in the YAMA document's `data` section |
| URLs | Remote files via HTTP(S) |

The mapping configuration supports transformations: `strip`, `replace`, `separator`, `prepend`, `append`.

## Documentation

Full documentation, including the YAMAML language specification, SimpleDSP and
OWL-DSP format references, the PKL authoring guide, and worked examples, is
available at **<https://docs.yamaml.org>**.

- [YAMAML Specification](https://docs.yamaml.org/specs/yamaml/spec/)
- [SimpleDSP Specification](https://docs.yamaml.org/specs/simpledsp/spec/) · [original Japanese](https://docs.yamaml.org/specs/simpledsp/spec-original-ja/)
- [OWL-DSP Specification](https://docs.yamaml.org/specs/owl-dsp/spec/) · [original Japanese](https://docs.yamaml.org/specs/owl-dsp/spec-original-ja/)
- [PKL Authoring Guide](https://docs.yamaml.org/specs/yamaml/pkl/)

CLI-specific documentation lives in [`docs/`](docs/).

## Links

- Website: [yamaml.org](https://www.yamaml.org)
- Documentation: [docs.yamaml.org](https://docs.yamaml.org)
- JSR package: [@nishad/yama](https://jsr.io/@nishad/yama)
- Tapir editor (browser-based): [yamaml.github.io/tapir](https://yamaml.github.io/tapir/)

## License

MIT
