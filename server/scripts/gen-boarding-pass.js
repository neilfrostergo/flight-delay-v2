'use strict';
/**
 * Generates a boarding pass PDF for testing document matching.
 *
 * The PDF is a hand-crafted minimal structure using only LF line endings and
 * standard Helvetica font (no embedding). Text is plain ASCII so pdf-parse
 * extracts it reliably.
 *
 * Usage (from server/ directory):
 *   node scripts/gen-boarding-pass.js
 *
 * Output: ../test-docs/BA177_LHR-CPT_30Mar2026_boarding_pass.pdf
 */

const fs   = require('fs');
const path = require('path');

function pad10(n) { return String(n).padStart(10, '0'); }

function pdfStr(s) {
  // Escape (, ) and \ inside PDF literal strings
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ── Content stream ─────────────────────────────────────────────────────────────
// All text is on separate lines using 0 -N TD to move down.
// Multiple date formats are included so the parser can find YYYY-MM-DD, DD Mon YYYY
// and DD/MM/YYYY patterns.

const textLines = [
  { size: 9,  text: 'BOARDING PASS' },
  { size: 14, text: 'British Airways' },
  { size: 9,  text: '' },
  { size: 9,  text: 'FLIGHT' },
  { size: 40, text: 'BA177' },
  { size: 9,  text: '' },
  { size: 9,  text: 'DATE OF TRAVEL' },
  { size: 18, text: '30 Mar 2026' },
  { size: 11, text: '30/03/2026' },
  { size: 9,  text: '' },
  { size: 9,  text: 'FROM' },
  { size: 14, text: 'London Heathrow LHR' },
  { size: 9,  text: '' },
  { size: 9,  text: 'TO' },
  { size: 14, text: 'Cape Town International CPT' },
  { size: 9,  text: '' },
  { size: 11, text: 'Departure: 20:35   Gate: B42   Seat: 24A' },
  { size: 9,  text: '' },
  { size: 9,  text: 'PASSENGER' },
  { size: 14, text: 'Test Passenger' },
  { size: 9,  text: '' },
  { size: 9,  text: 'BOOKING REFERENCE' },
  { size: 14, text: 'TBQ7X4' },
  { size: 9,  text: '' },
  // Machine-readable line with multiple date/flight formats for robust matching
  { size: 8, text: 'Flight BA177  LHR-CPT  30 March 2026  30/03/2026  Economy' },
];

const streamOps = [];
let y = 800;
let currentSize = 0;

for (const { size, text } of textLines) {
  const drop = text === '' ? 14 : (size < 12 ? 16 : size + 6);
  if (size !== currentSize) {
    if (streamOps.length) streamOps.push(`ET\nBT /F1 ${size} Tf 50 ${y} Td`);
    else                  streamOps.push(`BT /F1 ${size} Tf 50 ${y} Td`);
    currentSize = size;
  } else {
    streamOps.push(`0 -${drop} TD`);
  }
  if (text) streamOps.push(`(${pdfStr(text)}) Tj`);
  y -= drop;
}
streamOps.push('ET');

const streamContent = streamOps.join('\n');
const streamLen     = Buffer.byteLength(streamContent, 'latin1');

// ── PDF objects ────────────────────────────────────────────────────────────────
const NL = '\n';

const obj1 = `1 0 obj${NL}<</Type /Catalog /Pages 2 0 R>>${NL}endobj${NL}`;
const obj2 = `2 0 obj${NL}<</Type /Pages /Kids [3 0 R] /Count 1>>${NL}endobj${NL}`;
const obj3 = `3 0 obj${NL}<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources <</Font <</F1 4 0 R>>>>>>${NL}endobj${NL}`;
const obj4 = `4 0 obj${NL}<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>${NL}endobj${NL}`;
const obj5 = `5 0 obj${NL}<</Length ${streamLen}>>${NL}stream${NL}${streamContent}${NL}endstream${NL}endobj${NL}`;

// ── Assemble with correct byte offsets ────────────────────────────────────────
let pdf = `%PDF-1.4${NL}`;
const offs = {};

offs[1] = Buffer.byteLength(pdf, 'latin1'); pdf += obj1;
offs[2] = Buffer.byteLength(pdf, 'latin1'); pdf += obj2;
offs[3] = Buffer.byteLength(pdf, 'latin1'); pdf += obj3;
offs[4] = Buffer.byteLength(pdf, 'latin1'); pdf += obj4;
offs[5] = Buffer.byteLength(pdf, 'latin1'); pdf += obj5;

const xrefOff = Buffer.byteLength(pdf, 'latin1');
pdf += `xref${NL}0 6${NL}`;
pdf += `0000000000 65535 f ${NL}`;
for (let i = 1; i <= 5; i++) {
  pdf += `${pad10(offs[i])} 00000 n ${NL}`;
}
pdf += `trailer${NL}<</Size 6 /Root 1 0 R>>${NL}startxref${NL}${xrefOff}${NL}%%EOF${NL}`;

// ── Write & verify ─────────────────────────────────────────────────────────────
const outDir  = path.join(__dirname, '..', '..', 'test-docs');
const outFile = path.join(outDir, 'BA177_LHR-CPT_30Mar2026_boarding_pass.pdf');
fs.mkdirSync(outDir, { recursive: true });

const buf = Buffer.from(pdf, 'latin1');
fs.writeFileSync(outFile, buf);

console.log('Created:', outFile, '(' + buf.length + ' bytes)');

// Verify it's parseable
const pdfParse = require('pdf-parse');
pdfParse(new Uint8Array(buf)).then(d => {
  console.log('');
  console.log('Extracted text (first 400 chars):');
  console.log(d.text.slice(0, 400));

  // Run same logic as documentParser
  const upper = d.text.toUpperCase();
  const flightRe = /\b([A-Z]{2,3})[\s\-]?(\d{1,4})\b/g;
  const flights  = new Set();
  let m;
  while ((m = flightRe.exec(upper)) !== null) flights.add(m[1] + m[2]);

  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const dates  = new Set();
  const re1 = /(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})/gi;
  while ((m = re1.exec(d.text)) !== null) {
    const mon = MONTHS[m[2].slice(0,3).toLowerCase()];
    dates.add(`${m[3]}-${String(mon).padStart(2,'0')}-${String(parseInt(m[1])).padStart(2,'0')}`);
  }
  const re2 = /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/g;
  while ((m = re2.exec(d.text)) !== null) dates.add(`${m[3]}-${m[2]}-${m[1]}`);

  console.log('');
  console.log('Flight numbers found:', [...flights].filter(f => /^[A-Z]{2,3}\d/.test(f)));
  console.log('Dates found:', [...dates]);
  console.log('');
  if (flights.has('BA177') && dates.has('2026-03-30')) {
    console.log('Result: HIGH CONFIDENCE MATCH expected when uploaded against a BA177 30-Mar-2026 flight.');
  } else {
    console.warn('WARNING: BA177 or 2026-03-30 not found — matching may fail.');
  }
}).catch(e => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
