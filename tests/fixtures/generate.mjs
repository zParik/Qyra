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
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "pdf", "generated");

const enc = (s) => Buffer.from(s, "latin1");

// Serialize a set of objects into a PDF byte buffer with a correct xref table.
// `objects` is a Map<number, Buffer> of object bodies (text between `obj` and
// `endobj`). `trailer` is the trailer dictionary body (without << >>).
function buildPdf(objects, trailerDict) {
  // Builders use arbitrary object ids for readability; renumber them to a
  // contiguous 1..N so the xref table has no gaps (strict readers reject
  // in-use entries that point at offset 0). References (`N 0 R`) only appear in
  // plain dictionary bodies and the trailer — never inside stream data — so a
  // textual remap there is safe.
  const oldIds = [...objects.keys()].sort((a, b) => a - b);
  const map = new Map(oldIds.map((old, i) => [old, i + 1]));
  const remap = (s) => s.replace(/\b(\d+) 0 R\b/g, (m, d) => `${map.get(+d) ?? d} 0 R`);
  const bodies = oldIds.map((old) => {
    const buf = objects.get(old);
    const txt = buf.toString("latin1");
    return txt.includes("\nstream\n") ? buf : enc(remap(txt));
  });

  const n = oldIds.length;
  const parts = [];
  let offset = 0;
  const push = (buf) => {
    parts.push(buf);
    offset += buf.length;
  };

  push(enc("%PDF-1.5\n"));
  // Binary marker comment so tools treat the file as binary.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const xrefOffsets = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const id = i + 1;
    xrefOffsets[id] = offset;
    push(enc(`${id} 0 obj\n`));
    push(bodies[i]);
    push(enc("\nendobj\n"));
  }

  const xrefStart = offset;
  const count = n + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    const off = String(xrefOffsets[id]).padStart(10, "0");
    xref += `${off} 00000 n \n`;
  }
  push(enc(xref));
  // /Size (total xref entries, incl. the free object 0) is required by the spec;
  // lenient readers (mupdf) tolerate its absence but strict ones (lopdf) reject
  // the trailer without it.
  push(enc(`trailer\n<< ${remap(trailerDict)} /Size ${count} >>\nstartxref\n${xrefStart}\n%%EOF\n`));

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

// ── many-objects.pdf — one page with 60 link annotations (object-heavy) ─────
// Exercises object-stream packing: lots of tiny indirect dicts where classic
// xref overhead dominates.
function manyObjects() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  const annotRefs = [];
  let id = 10;
  for (let i = 0; i < 60; i++) {
    const aid = id++;
    annotRefs.push(`${aid} 0 R`);
    o.set(
      aid,
      enc(
        `<< /Type /Annot /Subtype /Link /Rect [10 ${10 + i} 50 ${30 + i}] ` +
          `/Border [0 0 0] /A << /S /URI /URI (https://example.com/${i}) >> >>`,
      ),
    );
  }
  o.set(
    3,
    enc(`<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} /Annots [${annotRefs.join(" ")}] >>`),
  );
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  return buildPdf(o, `/Root 1 0 R`);
}

// ── repeated-objects.pdf — 40 byte-identical link annotations (dedup win) ───
function repeatedObjects() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  const refs = [];
  let id = 10;
  for (let i = 0; i < 40; i++) {
    const aid = id++;
    refs.push(`${aid} 0 R`);
    o.set(
      aid,
      enc(
        `<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Border [0 0 0] ` +
          `/A << /S /URI /URI (https://example.com/same) >> >>`,
      ),
    );
  }
  o.set(
    3,
    enc(`<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} /Annots [${refs.join(" ")}] >>`),
  );
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  return buildPdf(o, `/Root 1 0 R`);
}

// ── orphaned.pdf — a bulky object referenced by nobody (GC should drop it) ──
function orphaned() {
  const o = new Map();
  o.set(1, enc(`<< /Type /Catalog /Pages 2 0 R >>`));
  o.set(2, enc(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  o.set(3, enc(`<< /Type /Page /Parent 2 0 R /MediaBox ${LETTER} >>`));
  o.set(4, enc(`<< /Junk (${"x".repeat(3000)}) >>`)); // unreferenced bulk
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
  "many-objects.pdf": manyObjects,
  "repeated-objects.pdf": repeatedObjects,
  "orphaned.pdf": orphaned,
};

// A valid 1x1 red PNG, built with correct chunk CRCs — input for images_to_pdf.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPng() {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // bytes 10-12: compression, filter, interlace = 0
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]); // filter 0 + one red pixel
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SAMPLE_PNG = buildPng();

function main() {
  mkdirSync(OUT, { recursive: true });
  for (const [name, fn] of Object.entries(FIXTURES)) {
    const buf = fn();
    writeFileSync(join(OUT, name), buf);
    console.log(`  ${name.padEnd(16)} ${buf.length} bytes`);
  }
  writeFileSync(join(OUT, "sample.png"), SAMPLE_PNG);
  console.log(`  ${"sample.png".padEnd(16)} ${SAMPLE_PNG.length} bytes`);
  console.log(`Generated ${Object.keys(FIXTURES).length + 1} fixtures into ${OUT}`);
}

main();
