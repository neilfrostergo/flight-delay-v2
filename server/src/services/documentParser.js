'use strict';

const fs = require('fs');

// Month name → number
const MONTHS = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

/**
 * Extract flight numbers (e.g. BA249, EZY1234) and dates from plain text.
 */
function extractInfo(text) {
  const upper = text.toUpperCase();

  // Flight numbers: 2–3 letter IATA carrier code followed immediately by 1–4 digits.
  // Optionally separated by a single space or dash.
  const flightNums = new Set();
  const reF = /\b([A-Z]{2,3})[\s\-]?(\d{1,4})\b/g;
  let m;
  while ((m = reF.exec(upper)) !== null) {
    flightNums.add(`${m[1]}${m[2]}`);
  }

  const dates = new Set();
  const addDate = (yr, mon, day) => {
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31 && yr >= 2024 && yr <= 2032) {
      dates.add(`${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  };

  // "14 Jun 2026" / "14 June 2026"
  const re1 = /(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})/gi;
  while ((m = re1.exec(text)) !== null) {
    addDate(parseInt(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], parseInt(m[1]));
  }

  // "Jun 14 2026" / "June 14, 2026"
  const re2 = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})[,\s]\s*(\d{4})/gi;
  while ((m = re2.exec(text)) !== null) {
    addDate(parseInt(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], parseInt(m[2]));
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const re3 = /\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/g;
  while ((m = re3.exec(text)) !== null) {
    addDate(parseInt(m[3]), parseInt(m[2]), parseInt(m[1]));
  }

  // YYYY-MM-DD (ISO)
  const re4 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = re4.exec(text)) !== null) {
    addDate(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));
  }

  return { flightNumbers: [...flightNums], dates: [...dates] };
}

/**
 * Parse a document file and extract flight/date hints.
 * Returns { parseMethod, flightNumbers, dates }.
 */
async function parseDocument(filePath, mimeType) {
  if (mimeType !== 'application/pdf') {
    // JPEG/PNG — OCR not available without additional setup
    return { parseMethod: 'image_no_ocr', flightNumbers: [], dates: [] };
  }

  try {
    // pdf-parse is an optional peer dep — fail gracefully if missing.
    // IMPORTANT: pass a fresh Uint8Array, not a Buffer directly.
    // Node.js Buffers can have a non-zero byteOffset into their underlying
    // ArrayBuffer, which causes pdf.js's XRef offset arithmetic to be wrong.
    const pdfParse = require('pdf-parse');
    const buf  = fs.readFileSync(filePath);
    const data = await pdfParse(new Uint8Array(buf));
    const info = extractInfo(data.text || '');
    return { parseMethod: 'pdf', ...info };
  } catch (err) {
    console.warn('[documentParser] PDF parse error:', err.message);
    return { parseMethod: 'pdf_error', flightNumbers: [], dates: [] };
  }
}

/**
 * Try to match parsed document info against the registered flights.
 * registeredFlights: [{ id, flight_number, carrier_code, dep_date }]
 *
 * Returns { flightId, confidence: 'high'|'medium', reason } or null.
 * 'high'   = flight number AND date both found in the document.
 * 'medium' = flight number found but date could not be confirmed.
 */
function matchFlights(parsed, registeredFlights) {
  for (const flight of registeredFlights) {
    const num  = String(flight.flight_number).replace(/\s/g, '').toUpperCase();
    const date = String(flight.dep_date).slice(0, 10); // YYYY-MM-DD

    const hasNum  = parsed.flightNumbers.includes(num);
    const hasDate = parsed.dates.includes(date);

    if (hasNum && hasDate) return { flightId: flight.id, confidence: 'high',   reason: 'flight_and_date' };
    if (hasNum)            return { flightId: flight.id, confidence: 'medium', reason: 'flight_only' };
  }
  return null;
}

module.exports = { parseDocument, matchFlights };
