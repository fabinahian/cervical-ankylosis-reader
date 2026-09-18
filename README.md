# Cervical Ankylosis Reader

A zero-install, fully offline DICOM viewer and structured annotation tool for
blinded multi-reader studies.

The reader receives **one HTML file**. They double-click it, point it at a folder
of DICOM images, and start reading. There is no installer, no server, no Node, no
Python, no admin rights, no browser extension and no internet connection involved
at any point.

---

## Why this exists

Multi-reader radiology studies have an awkward practical problem. You need several
radiologists to independently score the same set of studies, but:

- they are usually not on the same network as your data,
- hospital machines often forbid installing software,
- research PACS licences are expensive or unavailable,
- streaming tens of gigabytes of CT to someone on a slow connection does not work,
- and the readers are clinicians, not software users — every extra step costs you compliance.

This tool takes the opposite approach to a hosted viewer: the images are delivered
**once**, and everything after that happens locally in a browser tab.

---

## What the reader actually receives

Three files:

```
Ankylosis-Study.html          the whole application, ~99 KB
How to use this viewer.pdf    illustrated guide
CASES-batch-1.zip ...         the images
```

They unzip the batches into one folder, double-click the HTML, click one button,
and read. That single click — choosing the image folder — is the only setup step,
and it exists because a browser cannot read a local folder without an explicit
user gesture.

---

## Features

**Viewing**

- Reads standard DICOM CT, including **JPEG Lossless** (`1.2.840.10008.1.2.4.70`),
  which browsers cannot decode natively
- **Axial, sagittal and coronal** views — the reformats are computed from the volume
- **On-screen sliders** for image position, brightness, contrast and zoom, plus
  ‹ › step buttons (click for one image, hold to keep scrolling) — nothing
  depends on the reader knowing mouse gestures
- Bone and soft-tissue window presets, plus click-drag window/level like a PACS
- Mouse-wheel stack scrolling, right-drag pan, Ctrl+wheel zoom — all kept in
  sync with the sliders
- Slices ordered by `ImagePositionPatient`, not filename
- Per-study geometry: slice thickness, pixel spacing and slice spacing are read per file

**Study workflow**

- Structured scoring: C1–C7, each **Yes / No / Can't tell**
- Per-case confidence rating
- Cannot advance until every level is answered — no silent missing data
- **Case order randomised per reader**, so order effects don't correlate across readers
- Progress auto-saves; closing and reopening resumes where they stopped
- Periodic backup files, and a restore path if browser storage is lost
- CSV export including per-case reading time

**Blinding and privacy**

- Studies are renamed to anonymous `Case-001…` IDs
- The viewer displays **no DICOM metadata whatsoever** — no name, date, institution
- The ID-to-original mapping is written to a separate folder that never gets shared

---

## Requirements

| Who | Needs |
|---|---|
| You (packaging) | Windows with PowerShell 5.1 — already present on Windows 10/11 |
| You (building)  | Chrome or Edge, only to render the guide to PDF |
| Readers         | Chrome or Edge. Nothing else. |

No Node, no Python, no package manager, no build toolchain.

---

## Repository layout

```
├── build.ps1              builds the viewer + the guide PDF
├── prepare-batches.ps1    anonymises and packages your studies for distribution
├── src/
│   ├── index.html         viewer markup
│   ├── styles.css         viewer styles
│   ├── app.js             all application logic
│   └── guide.html         source of the reader guide
├── lib/
│   ├── dicomParser.min.js       DICOM parsing        (MIT)
│   └── lossless.cjs             JPEG Lossless decode (MIT)
├── assets/                sample renders for the guide (not committed — see below)
└── dist/                  build output
```

`src/` and `lib/` are inlined into one file at build time. Nothing in `dist/`
references anything external.

---

## Quick start

### 1. Build

```powershell
.\build.ps1
```

Produces `dist\Ankylosis-Study.html` and `dist\How-to-use-this-viewer.pdf`.

You only need this if you change the source. The built files are committed, so you
can skip straight to step 2.

### 2. Package your studies

Point it at a folder whose subfolders each contain one study's `.dcm` files:

```powershell
.\prepare-batches.ps1 -Source "E:\dicom\studies" -Out "E:\study-package" -BatchSize 20
```

Expected input layout:

```
E:\dicom\studies\
├── 1.2.826.0.1.3680043.14\     1.dcm, 2.dcm, ...
├── 1.2.826.0.1.3680043.27\
└── ...
```

You get two folders, deliberately separated so they cannot be confused:

```
E:\study-package\
├── SEND-TO-DOCTORS\            ← upload this whole folder
│   ├── Ankylosis-Study.html
│   ├── How to use this viewer.pdf
│   ├── CASES-batch-1.zip
│   └── CASES-batch-2.zip ...
└── KEEP-PRIVATE\               ← never upload this
    └── PRIVATE-case-mapping.csv
```

`PRIVATE-case-mapping.csv` is the only link between `Case-001` and the original
study identifier. Keep it; you need it to merge the results back.

Notes:

- Zip entries are written **straight from the source files**, so no second copy of
  your images is ever created on disk.
- Entries are stored uncompressed on purpose. DICOM pixel data is already compressed;
  deflating it again gains well under 1% and costs a lot of time.
- Case numbers are assigned in shuffled order, so the case ID carries no information
  about acquisition order. The shuffle is seeded (`-Seed`) and therefore reproducible.
- Re-running skips batches that already exist, so an interrupted run resumes.

### 3. Distribute

Upload `SEND-TO-DOCTORS` somewhere the readers can reach — institutional OneDrive
or Google Workspace is ideal, since those usually include enough free storage and
handle resumed downloads properly.

**Tell readers to download the batch zips individually.** Cloud "Download all"
buttons re-zip everything server-side into one enormous file, which tends to fail
on a slow connection and defeats the point of batching.

All readers can share the same link. They do not need separate copies — the tool
gives each of them a different case order automatically.

### 4. Collect results

Each reader emails back a CSV. Join them to `PRIVATE-case-mapping.csv` on `case_id`.

---

## Output format

One row per case, per reader:

| Column | Meaning |
|---|---|
| `reader_token` | Six-character code generated on the reader's machine; identifies the reader without them typing anything |
| `case_id` | Anonymised case ID (`Case-001`) |
| `presentation_position` | Where this case fell in *that reader's* randomised order — lets you test for order effects |
| `C1` … `C7` | `Yes`, `No`, `Not assessable`, or empty if unanswered |
| `confidence` | `Low`, `Moderate` or `High` |
| `seconds_on_case` | Active reading time, accumulated across visits; pauses when the tab is hidden |
| `first_opened_utc` | ISO timestamp the case was first opened |
| `completed_utc` | ISO timestamp all levels were first answered |

Partially finished work exports fine — unanswered levels are simply blank.

---

## How it works

The interesting constraint is that the page runs from a `file://` URL. That rules
out most of the modern web platform:

- **no Web Workers** — cannot be created from `file://`
- **no ES modules** — blocked by CORS on `file://`
- **no `fetch`/XHR of local files** — also blocked

Which in turn rules out Cornerstone3D, OHIF and essentially every off-the-shelf
DICOM viewer, since they depend on all three. So the viewer is a single file of
classic scripts that reads bytes only through `File` objects handed over by the
folder picker.

**Decoding.** Pixel data arrives JPEG Lossless–compressed inside the DICOM. That is
decoded in pure JavaScript on the main thread. Measured on a 512×512, 12-bit study:
**~7.2 ms per slice** for parse plus decode, so a 436-slice case takes about
**3.1 seconds**. The next case is decoded quietly in the background while the reader
works, so after the first case they rarely see a loading bar.

**Volume model.** Each case is decoded once into a single `Int16Array` of Hounsfield
units (rescale slope/intercept applied per slice, since they can vary). Re-windowing
is then a flat pass over that array — about **1.3 ms per frame**, so scrolling and
window/level dragging are smooth.

Because the whole volume is already in memory, **sagittal and coronal reformats are
almost free** — they are strided reads of the same buffer, with the display aspect
corrected using pixel spacing and the median slice spacing derived from
`ImagePositionPatient`.

**Ordering.** Slices are sorted by `ImagePositionPatient` z, descending, which gives
superior→inferior. Sorting by filename would be wrong: `10.dcm` sorts before `2.dcm`
lexically, silently scrambling the stack. Instance number is used only as a fallback
when position is unavailable.

**Memory.** Roughly `cols × rows × slices × 2` bytes per case — about 230 MB for 436
slices at 512×512. The previous case is released before the next is allocated, and at
most one case is prefetched ahead.

---

## Adapting it to a different study

Nearly everything study-specific lives in a few constants at the top of `src/app.js`:

```js
var LEVELS = ['C1','C2','C3','C4','C5','C6','C7'];

var ANSWERS = [
  { key: 'Yes',            label: 'Yes',        cls: 'sel-yes' },
  { key: 'No',             label: 'No',         cls: 'sel-no'  },
  { key: 'Not assessable', label: "Can't tell", cls: 'sel-na'  }
];

var WINDOWS = { bone: { wc: 400, ww: 1800 }, soft: { wc: 40, ww: 350 } };
```

Change the levels, the answer options or the window presets, adjust the wording in
`src/index.html`, then re-run `build.ps1`. The CSV columns follow `LEVELS`
automatically. The confidence scale lives in `index.html` next to `data-conf`.

---

## Design decisions worth knowing

These were deliberate and affect how you analyse the results.

**Case order is randomised per reader.** Prevents fatigue and learning effects from
lining up across readers and inflating apparent agreement. The cost is that
"look at case 47" means a different case for each reader — use the case ID shown on
screen when supporting them.

**There is a third answer option.** Forcing a binary choice on a level that is
genuinely unevaluable — outside the field of view, obscured by artefact — manufactures
disagreement that looks like reader variability but is really missing data. You can
collapse `Not assessable` to binary at analysis time; you cannot recover it if it
was never captured.

**Reading time is recorded.** Free to collect, and a common secondary endpoint.

**The viewer shows no metadata at all.** Even if an identifying tag survives
anonymisation, there is no surface in the UI for it to appear on. Folder renaming
plus a metadata-free display is the blinding mechanism; the DICOM files themselves
are not rewritten.

**Batching is about failure recovery, not compression.** DICOM CT that is already
JPEG-compressed will not shrink — expect roughly 0% from zipping. Batches exist so a
dropped download costs minutes instead of hours, and so reading can begin before
everything has arrived.

---

## Data safety

`.gitignore` is configured to keep patient data out of the repository: `*.dcm`,
`CASES/`, `Case-*/`, `*.zip`, the `SEND-TO-DOCTORS/` and `KEEP-PRIVATE/` output
folders, any `*case-mapping.csv`, and returned reader CSVs.

Check it still matches your setup before your first commit. Anonymised is not the
same as unidentifiable, and a public repository is a bad place to discover otherwise.

If a reader's machine blocks browser storage — some managed hospital machines do —
the viewer detects this at startup, tells the reader plainly that progress will not
survive closing the page, and writes a backup file after every case instead of every
fifth.

---

## Sample images in the guide

`assets/axial.jpg` and `assets/sagittal.jpg` are two rendered slices used as
illustrations in the reader guide. They are **not committed**, because sample data
usually carries redistribution terms of its own.

To supply your own: open the viewer with your data, screenshot an axial and a
sagittal view, and save them to `assets/` under those two names. Roughly 300 px wide
is plenty. If they are missing, `build.ps1` still succeeds and the guide renders
labelled placeholders in their place.

---

## Limitations

- **Windows-only tooling.** The two packaging scripts are PowerShell. The viewer
  itself is plain HTML and runs anywhere.
- **CT-oriented.** Window presets and the Hounsfield model assume CT. MR would work
  but the presets would need changing.
- **One series per case.** Each case folder is treated as a single stack. Studies
  with multiple series need a series picker, which does not exist.
- **Uncompressed and JPEG Lossless only.** JPEG 2000 and JPEG-LS transfer syntaxes
  are not handled; they would need another decoder inlined.
- **Large cases need memory.** Around 230 MB per 436-slice case, plus one prefetched
  ahead. Comfortable on 8 GB; tight on 4 GB.
- **Browser storage is per-browser.** A reader who switches browsers or profiles
  starts fresh — the backup file is the recovery path.

---

## License

MIT — see [LICENSE](LICENSE).

Bundled third-party components, both MIT:
[dicom-parser](https://github.com/cornerstonejs/dicomParser) (Chris Hafey) and
[jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEGLosslessDecoderJS)
(RII-UTHSCSA).
