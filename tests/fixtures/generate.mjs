// Dependency-free PDF fixture generator.
//
// Emits a small corpus of valid PDFs into tests/fixtures/pdf/generated/ used by
// the Rust integration tests and (indirectly) the frontend mocks. PDFs are built
// by hand with byte-accurate cross-reference tables so they load in lopdf/mupdf
// without any external library.
//
// The one fixture NOT produced here is encrypted.pdf — it is derived at test
// time by the Rust suite via the app's own protect_pdf command, so the suite
// also exercises real encryption rather than a hand-rolled /Encrypt dict.
//
// Run: npm run fixtures   (or: node tests/fixtures/generate.mjs)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "pdf", "generated");

const enc = (s) => Buffer.from(s, "latin1");

// Serialize a set of objects into a PDF byte buffer with a correct xref table.
// `objects` is a Map<number, Buffer> of object bodies (text between `obj` and
// `endobj`). `trailer` is the trailer dictionary body (without << >>).
function buildPdf(objects, trailerDict) {
  const ids = [...objects.keys()].sort((a, b) => a - b);
  const maxId = ids[ids.length - 1];
  const parts = [];
  let offset = 0;
  const push = (buf) => {
    parts.push(buf);
    offset += buf.length;
  };

  push(enc("%PDF-1.5\n"));
  // Binary marker comment so tools treat the file as binary.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const xrefOffsets = new Array(maxId + 1).fill(0);
  for (const id of ids) {
    xrefOffsets[id] = offset;
    push(enc(`${id} 0 obj\n`));
    push(objects.get(id));
    push(enc("\nendobj\n"));
  }

  const xrefStart = offset;
  const count = maxId + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    const off = String(xrefOffsets[id]).padStart(10, "0");
    xref += `${off} 00000 n \n`;
  }
  push(enc(xref));
  push(enc(`trailer\n<< ${trailerDict} >>\nstartxref\n${xrefStart}\n%%EOF\n`));

  return Buffer.concat(parts);
}

// Build a content stream object body from raw (uncompressed) stream bytes.
function streamObj(dict, dataBuf) {
  const head = enc(`<< ${dict} /Length ${dataBuf.length} >>\nstream\n`);
  const tail = enc("\nendstream");
  return Buffer.concat([head, dataBuf, tail]);
}

const LETTER = "[0 0 612 792]";
const HELV = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

// Text-drawing content stream for a given caption.
const textStream = (caption) =>
  enc(`BT /F1 24 Tf 72 700 Td (${caption}) Tj ET`);

// ── simple.pdf — single blank page ──────────────────────────────────────────
function simple() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(3, enc(`<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} >>`));
  return buildPdf(o, `/Root 1 0 R`);
}

// ── text.pdf — single page with extractable "Hello World Qyra" text ─────────
function text() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(
    3,
    enc(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} ` +
        `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    ),
  );
  o.set(4, streamObj("", textStream("Hello World Qyra")));
  o.set(5, enc(HELV));
  return buildPdf(o, `/Root 1 0 R`);
}

// ── multipage.pdf — N pages, each captioned "Page K" (extractable) ──────────
function multipage(n = 5) {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  const font = 3; // shared font object id
  o.set(font, enc(HELV));
  const kids = [];
  let id = 10;
  for (let k = 1; k <= n; k++) {
    const pageId = id++;
    const contentId = id++;
    kids.push(`${pageId} 0 R`);
    o.set(
      pageId,
      enc(
        `<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    o.set(contentId, streamObj("", textStream(`Page ${k}`)));
  }
  o.set(2, enc(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`));
  return buildPdf(o, `/Root 1 0 R`);
}

// ── outline.pdf — 3 pages + bookmark tree (for split-by-bookmarks/outline) ──
function outline() {
  const o = new Map();
  const font = 3;
  o.set(font, enc(HELV));
  const pageIds = [11, 12, 13];
  pageIds.forEach((pid, i) => {
    const cid = pid + 100;
    o.set(
      pid,
      enc(
        `<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cid} 0 R >>`,
      ),
    );
    o.set(cid, streamObj("", textStream(`Chapter ${i + 1}`)));
  });
  o.set(2, enc(`<< /Type /Pages /Kids [11 0 R 12 0 R 13 0 R] /Count 3 >>`));
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R /Outlines 20 0 R >>`));
  // Outline root + 3 items
  o.set(20, enc(`<< /Type /Outlines /First 21 0 R /Last 23 0 R /Count 3 >>`));
  o.set(
    21,
    enc(`<< /Title (Chapter 1) /Parent 20 0 R /Next 22 0 R /Dest [11 0 R /Fit] >>`),
  );
  o.set(
    22,
    enc(
      `<< /Title (Chapter 2) /Parent 20 0 R /Prev 21 0 R /Next 23 0 R /Dest [12 0 R /Fit] >>`,
    ),
  );
  o.set(
    23,
    enc(`<< /Title (Chapter 3) /Parent 20 0 R /Prev 22 0 R /Dest [13 0 R /Fit] >>`),
  );
  return buildPdf(o, `/Root 1 0 R`);
}

// ── links.pdf — single page with a URI link annotation ──────────────────────
function links() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(
    3,
    enc(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} /Annots [4 0 R] >>`,
    ),
  );
  o.set(
    4,
    enc(
      `<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] ` +
        `/Border [0 0 1] /A << /S /URI /URI (https://example.com/) >> >>`,
    ),
  );
  return buildPdf(o, `/Root 1 0 R`);
}

// ── acroform.pdf — single text field for get_form_fields/fill_form ──────────
function acroform() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(
    3,
    enc(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} ` +
        `/Resources << /Font << /Helv 5 0 R >> >> /Annots [4 0 R] >>`,
    ),
  );
  o.set(
    4,
    enc(
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T (full_name) /V () ` +
        `/Rect [72 650 372 680] /P 3 0 R /DA (/Helv 12 Tf 0 g) >>`,
    ),
  );
  o.set(5, enc(HELV));
  o.set(
    6,
    enc(
      `<< /Fields [4 0 R] /NeedAppearances true ` +
        `/DR << /Font << /Helv 5 0 R >> >> /DA (/Helv 12 Tf 0 g) >>`,
    ),
  );
  return buildPdf(o, `/Root 1 0 R`);
}

// ── annotated.pdf — page with an existing Text + Square annotation ──────────
function annotated() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(
    3,
    enc(`<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} /Annots [4 0 R 5 0 R] >>`),
  );
  o.set(
    4,
    enc(
      `<< /Type /Annot /Subtype /Text /Rect [72 740 92 760] ` +
        `/Contents (Existing note) /C [1 1 0] >>`,
    ),
  );
  o.set(
    5,
    enc(
      `<< /Type /Annot /Subtype /Square /Rect [100 600 300 700] ` +
        `/C [1 0 0] /IC [1 1 1] >>`,
    ),
  );
  return buildPdf(o, `/Root 1 0 R`);
}

// ── scanned.pdf — image-only page (no text) for OCR / text-layer baking ─────
function scanned() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(
    3,
    enc(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} ` +
        `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    ),
  );
  // Draw the image scaled to fill the page.
  o.set(4, streamObj("", enc("q 612 0 0 792 0 0 cm /Im0 Do Q")));
  // 2x2 grayscale checkerboard, 8 bits/component, uncompressed.
  const img = Buffer.from([0x00, 0xff, 0xff, 0x00]);
  o.set(
    5,
    streamObj(
      `/Type /XObject /Subtype /Image /Width 2 /Height 2 ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8`,
      img,
    ),
  );
  return buildPdf(o, `/Root 1 0 R`);
}

const FIXTURES = {
  "simple.pdf": simple,
  "text.pdf": text,
  "multipage.pdf": () => multipage(5),
  "outline.pdf": outline,
  "links.pdf": links,
  "acroform.pdf": acroform,
  "annotated.pdf": annotated,
  "scanned.pdf": scanned,
};

function main() {
  mkdirSync(OUT, { recursive: true });
  for (const [name, fn] of Object.entries(FIXTURES)) {
    const buf = fn();
    writeFileSync(join(OUT, name), buf);
    console.log(`  ${name.padEnd(16)} ${buf.length} bytes`);
  }
  console.log(`Generated ${Object.keys(FIXTURES).length} fixtures into ${OUT}`);
}

main();
