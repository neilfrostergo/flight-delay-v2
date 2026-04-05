'use strict';

/**
 * Renders the first page of a PDF to a PNG buffer using pdftoppm (poppler-utils).
 * Returns null if pdftoppm is not installed — caller should fall back to serving raw PDF.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { randomBytes } = require('crypto');

const execFileAsync = promisify(execFile);

async function renderFirstPage(pdfBuffer) {
  const id     = randomBytes(8).toString('hex');
  const tmpPdf = path.join(os.tmpdir(), `${id}.pdf`);
  const tmpOut = path.join(os.tmpdir(), id);  // prefix — pdftoppm appends .png

  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);

    // -singlefile: output is <prefix>.png (no page-number suffix)
    // -r 150: 150 dpi — readable but not huge
    // -f 1 -l 1: only first page
    await execFileAsync('pdftoppm', [
      '-png', '-singlefile', '-r', '150', '-f', '1', '-l', '1',
      tmpPdf, tmpOut,
    ], { timeout: 15000 });

    return fs.readFileSync(`${tmpOut}.png`);
  } catch (err) {
    if (err.code === 'ENOENT') return null;  // pdftoppm not installed
    console.error('[pdfRenderer] pdftoppm error:', err.message);
    return null;
  } finally {
    fs.unlink(tmpPdf, () => {});
    fs.unlink(`${tmpOut}.png`, () => {});
  }
}

module.exports = { renderFirstPage };
