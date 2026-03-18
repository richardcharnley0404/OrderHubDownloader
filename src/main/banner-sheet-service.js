'use strict';

const logger = require('./services/logger');

/**
 * src/main/banner-sheet-service.js
 *
 * Generates a banner/separator sheet JPEG for insertion as the first image
 * in a DPOF job packet. The banner lets operators visually separate print
 * jobs on the roll and encodes the order code as a scannable QR code.
 *
 * Dependencies (pure JS, no native binaries):
 *   qrcode  — generates QR code as PNG buffer
 *   jimp    — image creation and compositing (0.22.x API)
 */

/**
 * Generate a banner sheet image matching the job's print dimensions.
 *
 * @param {string} jobCode   - Full job code e.g. "PXDEMO-LZQ3V4-1"
 * @param {number} widthPx   - Output image width  in pixels (match job images)
 * @param {number} heightPx  - Output image height in pixels (match job images)
 * @returns {Promise<Buffer>} JPEG image buffer
 */
async function generateBannerSheet(jobCode, widthPx, heightPx) {
  console.error('[BANNER] generateBannerSheet called', jobCode, widthPx, heightPx);
  logger.info('generateBannerSheet called', { jobCode, widthPx, heightPx });

  // Load dependencies with explicit error reporting so load failures are visible
  let QRCode, Jimp;
  try {
    QRCode = require('qrcode');
  } catch (e) {
    throw new Error(`Failed to load qrcode: ${e.message}`);
  }
  try {
    Jimp = require('jimp');
  } catch (e) {
    throw new Error(`Failed to load jimp: ${e.message}`);
  }

  // Derive order code by stripping trailing job number
  // e.g. "PXDEMO-LZQ3V4-1" → "PXDEMO-LZQ3V4"
  const orderCode = jobCode.replace(/-\d+$/, '');

  // ── QR code ────────────────────────────────────────────────────────────────
  // 354 × 354 px ≈ 30 mm at 300 dpi
  const QR_SIZE  = 354;
  const qrBuffer = await QRCode.toBuffer(orderCode, {
    type:   'png',
    width:  QR_SIZE,
    margin: 1,
  });
  console.error('[BANNER] QR generated');

  // ── White background ────────────────────────────────────────────────────────
  // jimp 0.22.x: constructor is synchronous — new Jimp(w, h, color)
  const image = new Jimp(widthPx, heightPx, 0xFFFFFFFF);
  console.error('[BANNER] jimp instance created');

  // ── Composite QR code ───────────────────────────────────────────────────────
  // Centred horizontally, positioned at ~40% down from the top vertically
  const qrImage = await Jimp.read(qrBuffer);
  const qrX = Math.floor((widthPx  - QR_SIZE) / 2);
  const qrY = Math.max(0, Math.floor(heightPx * 0.4 - QR_SIZE / 2));
  image.composite(qrImage, qrX, qrY);

  // ── Order code label ────────────────────────────────────────────────────────
  // Centred horizontally, ~20 px below the bottom edge of the QR code
  const font  = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const textY = qrY + QR_SIZE + 20;
  image.print(
    font,
    0,
    textY,
    {
      text:       orderCode,
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_TOP,
    },
    widthPx,
    Math.max(1, heightPx - textY)
  );

  const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
  console.error('[BANNER] buffer ready, size:', buffer.length);
  logger.info('Banner sheet generated', { jobCode, orderCode, widthPx, heightPx });
  return buffer;
}

module.exports = { generateBannerSheet };
