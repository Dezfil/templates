# Dezfil templates

Finished example maps and workflow examples on open data, which people open
read-only in [Dezfil](https://github.com/Dezfil/Dezfil) and copy into a
project of their own. This repository holds how each one is built: the
scripts that fetch its data from the publisher, the script that authors it
in Dezfil, its facts and its notices. A release publishes what Dezfil reads:
an `index.json`, one archive per template and its two pictures.

## Licences

The scripts and tools are under the Apache License 2.0 ([LICENSE](LICENSE)).
The data is not: every dataset a template carries stays under its source's
own terms, listed with the credit the source asks for in that template's
`NOTICE`, in its facts and in the credit note on its map.

## Layout

```
tools/                the shared helpers, plain Node ESM
  client.mjs          a small client for a scratch Dezfil's API
  source.mjs          fetch a source into a folder of its own; DuckDB with spatial
  facts.mjs           read a template's facts; write its credit note
  workflow.mjs        create a workflow, add its steps, lay out its canvas, run it
  canvas-check.mjs    check a workflow example's canvas, and lay it out again
  pictures.mjs        the light and dark pictures, from the server's image export
  pack.mjs            the project export plus facts, results and pictures, as one archive
  zip.mjs             read and write ZIP archives, deterministically
  index.mjs           a release's index.json
  validate.mjs        install the release into a second scratch Dezfil and check it
templates/<id>/       one folder per template
  build.mjs           fetch each source at a pinned address, prepare it with DuckDB
  author.mjs          author it in a scratch Dezfil through the API
  canvas.mjs          a workflow example's canvas: its sections and where each node sits
  facts.json          its facts: the template.json the archive carries
  NOTICE              every source, its licence and its credit, where and when it was read
work/                 downloads, prepared data, authoring records (ignored)
dist/                 archives, pictures and the index (ignored)
```

## What you need

- Node 24 or later, then `npm install` here (DuckDB is the one dependency;
  its spatial extension installs on first use).
- A production build of Dezfil you can start twice on this machine, each
  on its own empty data folder and its own port: one to author on, one to
  validate with. The tools refuse any address that is not this machine.
  Both need `DEZFIL_EGRESS_ALLOWLIST=127.0.0.1` and `DEZFIL_CHROMIUM_PATH`
  pointing at a headless Chromium (the image export draws the pictures);
  the validating one also needs `DEZFIL_TEMPLATES_CATALOGUE` naming an
  empty folder, which validation fills with the release.

## How to build one template

Take `earthquakes` as the example, with the authoring instance on port 3751
and the validating one on 3752.

1. **Build the data.** `node templates/earthquakes/build.mjs` fetches every
   source from its publisher at the address the script pins, each download
   into a new folder of its own under `work/earthquakes/downloads/`, and
   prepares the datasets as GeoParquet in `work/earthquakes/data/`. It
   writes `work/earthquakes/build-record.json`: every address, when it was
   read, its bytes and SHA-256, the rows that came out. Keep every layer's
   result under Dezfil's default render cap (250,000 features): slice or
   aggregate here, or aggregate in the layer's SQL.
2. **Author it.** `node templates/earthquakes/author.mjs http://127.0.0.1:3751`
   drives the fresh instance through its documented API only: the project,
   the uploads, the map, layers by SQL, their styles, filters, the
   timeline, the widgets and the credit note built from the facts. Layer
   and step SQL names the template's own datasets as plain table names.
   It writes `work/earthquakes/authored.json`. If the API cannot do
   something the template needs, that is a change for Dezfil, not a file
   to write by hand.
3. **Draw the pictures.** `node tools/pictures.mjs http://127.0.0.1:3751 work/earthquakes`
   renders the map light and dark with the server's image export (1280 by
   800, no legend or widgets), each under 2 MB. Look at both.
4. **Pack it.** `node tools/pack.mjs http://127.0.0.1:3751 templates/earthquakes work/earthquakes dist`
   exports the project, adds `template.json` (the facts), any workflow
   results and the pictures, and writes `dist/earthquakes-1.zip` (one
   `earthquakes.dezfil/` folder, at most 150 MB) with its size, SHA-256
   and index entry. It refuses facts whose dataset lines do not name the
   day the build read the data.
5. **Index the release.** `node tools/index.mjs dist earthquakes` writes
   `dist/index.json`, in the order given.
6. **Validate.** Start the second instance with `DEZFIL_TEMPLATES_CATALOGUE`
   naming an empty folder, then
   `node tools/validate.mjs http://127.0.0.1:3752 dist <that folder>`.
   It writes the folder catalogue and, through the API, checks that the
   list shows each template, the read of one answers, the download is
   admitted (Dezfil's own rules: licence, credit note, references, the
   render cap, sizes), its pictures are the release's, the template's map
   opens read-only and every layer draws, a copy lands, and the copy's
   layers draw what the template's do. For a workflow example it also
   checks that every step of the copied workflow shows the template's
   result until its first run, that the whole copy runs on the instance
   with no outside service, and that afterwards no step shows the
   template's result. It prints what it saw and exits non-zero on a
   failure. The instance reads its catalogue at most once in ten minutes:
   validating a second release on the same instance inside that window
   fails with the time to try again.

A new version of a template raises `version` in its facts; a listed
version is never changed.

A workflow example explains itself on its canvas in sections:
tinted notes behind the nodes, left to right as the work flows (About,
Input data, one per step, Result), each a full-height column with its tag
and a short heading and sentence in one band across the top and its nodes
below, so no edge crosses a section's text. `canvas.mjs` names each node
by its dataset at a column and row inside its section (`sectionsCanvas`
in `tools/workflow.mjs` turns that into positions). After authoring,
`node tools/canvas-check.mjs http://127.0.0.1:3751 templates/<id>` lays
the canvas onto the authored workflow again and reports any node outside
a section and any edge that crosses another node or a heading, so a
canvas can be adjusted without authoring again.

A workflow example names its bundled results in `authored.json` as
`{ "results": { "<step id>": "<dataset name>" } }`, one per step; pack
moves each named dataset out of the export's datasets into
`results/<step id>.parquet`. Its facts list no `steps`: pack reads them
from the exported workflow (id, operation, output) and writes them into
`template.json`. What a step reads is its named inputs; a SQL step's
tables are named in `authored.json` as
`{ "reads": { "<step id>": ["<dataset>", ...] } }`, and pack refuses a SQL
step without them.

Two templates can share their fetching: `frankfurt-parking-hardest` reads
its sources through `templates/frankfurt-parking/sources.mjs`. That file
fetches the Mobilithek archive with `curl` (which verifies the server's
certificate) because Node's own fetch does not complete the TLS handshake
with that server; every other source uses `tools/source.mjs`.
