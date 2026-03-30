'use strict';
// Test PDF with LF-only line endings and space before LF in XRef entries
const pdfParse = require('pdf-parse');

const stream = 'BT /F1 14 Tf 50 760 Td (BA177) Tj 0 -25 TD (30 Mar 2026) Tj 0 -25 TD (LHR to CPT) Tj ET';
const sl     = Buffer.byteLength(stream, 'latin1');

const NL = '\n';

const o1 = `1 0 obj${NL}<</Type /Catalog /Pages 2 0 R>>${NL}endobj${NL}`;
const o2 = `2 0 obj${NL}<</Type /Pages /Kids [3 0 R] /Count 1>>${NL}endobj${NL}`;
const o3 = `3 0 obj${NL}<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources <</Font <</F1 4 0 R>>>>>>${NL}endobj${NL}`;
const o4 = `4 0 obj${NL}<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>${NL}endobj${NL}`;
const o5 = `5 0 obj${NL}<</Length ${sl}>>${NL}stream${NL}${stream}${NL}endstream${NL}endobj${NL}`;

let pdf = `%PDF-1.4${NL}`;
const offs = {};
offs[1] = Buffer.byteLength(pdf, 'latin1'); pdf += o1;
offs[2] = Buffer.byteLength(pdf, 'latin1'); pdf += o2;
offs[3] = Buffer.byteLength(pdf, 'latin1'); pdf += o3;
offs[4] = Buffer.byteLength(pdf, 'latin1'); pdf += o4;
offs[5] = Buffer.byteLength(pdf, 'latin1'); pdf += o5;

const xo = Buffer.byteLength(pdf, 'latin1');
pdf += `xref${NL}0 6${NL}`;
pdf += `0000000000 65535 f ${NL}`;                          // space + LF = 2-byte EOL
for (let i = 1; i <= 5; i++) {
  pdf += `${String(offs[i]).padStart(10, '0')} 00000 n ${NL}`; // space + LF
}
pdf += `trailer${NL}<</Size 6 /Root 1 0 R>>${NL}startxref${NL}${xo}${NL}%%EOF${NL}`;

const buf = Buffer.from(pdf, 'latin1');
console.log('size:', buf.length);
// Check each offset
Object.entries(offs).forEach(([n, o]) => {
  console.log('obj', n, 'at', o, '->', JSON.stringify(buf.slice(o, o + 15).toString()));
});
console.log('xref at', xo, '->', JSON.stringify(buf.slice(xo, xo + 30).toString()));

pdfParse(buf)
  .then(d => console.log('SUCCESS:', d.text))
  .catch(e => console.error('FAIL:', e.message));
