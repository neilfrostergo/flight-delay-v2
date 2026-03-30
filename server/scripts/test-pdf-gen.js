'use strict';
const pdfParse = require('pdf-parse');

function pad10(n) { return String(n).padStart(10, '0'); }

const bodyLines = [
  'BOARDING PASS',
  'British Airways',
  'Flight BA177',
  '30 Mar 2026',
  '30/03/2026',
  'London Heathrow LHR to Cape Town International CPT',
  'Departure 20:35   Arrival 09:25   Gate B42   Seat 24A',
  'Passenger Test Passenger',
  'Booking Reference TBQ7X4',
];

// PDF strings only need (, ) and \ escaped
function pdfStr(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Build content stream — one BT/ET block
const ops = bodyLines.map((line, i) => {
  if (i === 0) return `BT /F1 16 Tf 50 760 Td (${pdfStr(line)}) Tj`;
  return `0 -25 TD (${pdfStr(line)}) Tj`;
}).join('\r\n');
const stream = ops + '\r\nET';
const streamLen = Buffer.byteLength(stream, 'latin1');

const CRLF = '\r\n';

const o1 = `1 0 obj${CRLF}<</Type /Catalog /Pages 2 0 R>>${CRLF}endobj${CRLF}`;
const o2 = `2 0 obj${CRLF}<</Type /Pages /Kids [3 0 R] /Count 1>>${CRLF}endobj${CRLF}`;
const o3 = `3 0 obj${CRLF}<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources <</Font <</F1 4 0 R>>>>>>${CRLF}endobj${CRLF}`;
const o4 = `4 0 obj${CRLF}<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>${CRLF}endobj${CRLF}`;
const o5 = `5 0 obj${CRLF}<</Length ${streamLen}>>${CRLF}stream${CRLF}${stream}${CRLF}endstream${CRLF}endobj${CRLF}`;

let pdf = `%PDF-1.4${CRLF}`;
const off = {};
off[1] = Buffer.byteLength(pdf, 'latin1'); pdf += o1;
off[2] = Buffer.byteLength(pdf, 'latin1'); pdf += o2;
off[3] = Buffer.byteLength(pdf, 'latin1'); pdf += o3;
off[4] = Buffer.byteLength(pdf, 'latin1'); pdf += o4;
off[5] = Buffer.byteLength(pdf, 'latin1'); pdf += o5;

const xrefOff = Buffer.byteLength(pdf, 'latin1');
pdf += `xref${CRLF}0 6${CRLF}`;
pdf += `0000000000 65535 f${CRLF}`;
for (let i = 1; i <= 5; i++) {
  pdf += `${pad10(off[i])} 00000 n${CRLF}`;
}
pdf += `trailer${CRLF}<</Size 6 /Root 1 0 R>>${CRLF}`;
pdf += `startxref${CRLF}${xrefOff}${CRLF}%%EOF${CRLF}`;

const buf = Buffer.from(pdf, 'latin1');
console.log('PDF size:', buf.length, 'bytes');
console.log('xref offset:', xrefOff);
console.log('xref section preview:', JSON.stringify(pdf.slice(xrefOff, xrefOff + 80)));

pdfParse(buf)
  .then(d => {
    console.log('\nSUCCESS! Extracted text:');
    console.log(d.text);
  })
  .catch(e => {
    console.error('\nFAIL:', e.message);
  });
