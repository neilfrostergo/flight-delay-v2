'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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

  // Flight numbers: 2–3 letter IATA carrier code followed by 2–4 digits.
  // Minimum 2 digits eliminates single-digit postcode areas (CM1, BN2 etc.).
  // (?![A-Z]) rejects matches immediately followed by a letter, which kills
  // postcode variants like SW1A or EC2A where a digit precedes the sector letter.
  // Allow up to 3 whitespace/dash chars to handle PDFs with extra spaces.
  const flightNums = new Set();
  const reF = /\b([A-Z]{2,3})[\s\-]{0,3}(\d{2,4})(?![A-Z])/g;
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

  // DD-MMM-YYYY (e.g. 10-APR-2026 or 10-Apr-2026)
  const re5 = /\b(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-(\d{4})\b/gi;
  while ((m = re5.exec(text)) !== null) {
    addDate(parseInt(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], parseInt(m[1]));
  }

  return { flightNumbers: [...flightNums], dates: [...dates] };
}

/**
 * Render the first page of a PDF as a PNG using pdftoppm (from poppler-utils).
 * Returns base64-encoded PNG string, or throws if unavailable.
 */
async function convertPdfFirstPageToImage(filePath) {
  const prefix = path.join(os.tmpdir(), `pdfimg_${Date.now()}_${process.pid}`);
  try {
    // -r 150: 150 DPI — readable for AI vision without being too large
    // -png: PNG output
    // -l 1: only render first page
    await execFileAsync('pdftoppm', ['-r', '150', '-png', '-l', '1', filePath, prefix]);
    // Output filename varies by total page count; scan tmpdir for our prefix
    const generated = fs.readdirSync(os.tmpdir())
      .filter(f => f.startsWith(path.basename(prefix)) && f.endsWith('.png'));
    if (generated.length === 0) throw new Error('pdftoppm produced no output');
    const outPath = path.join(os.tmpdir(), generated[0]);
    const buf = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    return buf.toString('base64');
  } catch (err) {
    // Clean up any partial output
    try {
      fs.readdirSync(os.tmpdir())
        .filter(f => f.startsWith(path.basename(prefix)) && f.endsWith('.png'))
        .forEach(f => { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} });
    } catch {}
    throw err;
  }
}

/**
 * Parse a document file and extract flight/date hints.
 * Returns { parseMethod, flightNumbers, dates }.
 *
 * For PDFs, attempts to render the first page as an image (pdf_image) so the
 * AI can use vision rather than relying on pdf-parse text extraction, which
 * produces false positives from postcodes, insurance policy numbers, etc.
 * Text extraction is still run in parallel as a regex fallback for the
 * scan-document pre-fill flow (which has no AI).
 */
async function parseDocument(filePath, mimeType) {
  if (mimeType === 'application/pdf') {
    // Attempt image rendering and text extraction in parallel
    const [imgResult, txtResult] = await Promise.allSettled([
      convertPdfFirstPageToImage(filePath),
      (async () => {
        const pdfParse = require('pdf-parse');
        const buf  = fs.readFileSync(filePath);
        const data = await pdfParse(new Uint8Array(buf));
        return data.text || '';
      })(),
    ]);

    const base64Image = imgResult.status === 'fulfilled' ? imgResult.value : null;
    const rawText     = txtResult.status === 'fulfilled' ? txtResult.value : null;

    if (imgResult.status === 'rejected') {
      console.warn('[documentParser] PDF-to-image failed:', imgResult.reason?.message);
    }
    if (txtResult.status === 'rejected') {
      console.warn('[documentParser] PDF text extraction failed:', txtResult.reason?.message);
    }

    if (!base64Image && !rawText) {
      return { parseMethod: 'pdf_error', flightNumbers: [], dates: [] };
    }

    // Regex extraction on text (used by scan-document pre-fill; overridden by AI in upload flow)
    const info = rawText ? extractInfo(rawText) : { flightNumbers: [], dates: [] };
    console.log('[documentParser] PDF regex flights:', info.flightNumbers, 'dates:', info.dates);

    if (base64Image) {
      // pdf_image: AI vision is primary source; regex results included as fallback
      return { parseMethod: 'pdf_image', base64Image, imageMime: 'image/png', rawText: rawText || '', ...info };
    }
    // Fallback: no image but we have text
    return { parseMethod: 'pdf', rawText, ...info };
  }

  // JPEG/PNG — return image data for vision-based analysis in documentVerifier
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    try {
      const buf         = fs.readFileSync(filePath);
      const base64Image = buf.toString('base64');
      return {
        parseMethod:  'image',
        rawText:      null,
        base64Image,
        imageMime:    mimeType,
        flightNumbers: [],
        dates:        [],
      };
    } catch (err) {
      console.warn('[documentParser] Image read error:', err.message);
      return { parseMethod: 'image_error', flightNumbers: [], dates: [] };
    }
  }

  return { parseMethod: 'unsupported', flightNumbers: [], dates: [] };
}

/**
 * Try to match parsed document info against the registered flights.
 * registeredFlights: [{ id, flight_number, carrier_code, dep_date }]
 *
 * Returns { flightId, confidence: 'high'|'medium', reason } or null.
 * 'high'   = flight number AND date both found in the document.
 * 'medium' = flight number found but date could not be confirmed.
 */
// Normalise a flight number for matching: strip spaces and leading zeros from
// the numeric suffix so "BA0177", "BA177", and "BA 177" all compare equal.
function normaliseFlight(raw) {
  return String(raw).replace(/\s/g, '').toUpperCase()
    .replace(/^([A-Z]{2,3})0+(\d)/, '$1$2'); // BA0177 → BA177
}

function matchFlights(parsed, registeredFlights) {
  const normParsed = parsed.flightNumbers.map(normaliseFlight);

  for (const flight of registeredFlights) {
    const num  = normaliseFlight(flight.flight_number);
    const date = String(flight.dep_date).slice(0, 10); // YYYY-MM-DD

    const hasNum  = normParsed.includes(num);
    const hasDate = parsed.dates.includes(date);

    if (hasNum && hasDate) return { flightId: flight.id, confidence: 'high',   reason: 'flight_and_date' };
    if (hasNum)            return { flightId: flight.id, confidence: 'medium', reason: 'flight_only' };
  }
  return null;
}

module.exports = { parseDocument, matchFlights, normaliseFlight };
