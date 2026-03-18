'use strict';

const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const QRCode = require('qrcode');
const logger = require('../main/services/logger');

// ── Unit conversion ──────────────────────────────────────────────────────────
// pdf-lib works in points (1 point = 1/72 inch)
const MM_TO_PT = 72 / 25.4;
const IN_TO_PT = 72;

function toPoints(value, unit) {
  return unit === 'mm' ? value * MM_TO_PT : value * IN_TO_PT;
}

// ── interleaveBlanks ─────────────────────────────────────────────────────────
/**
 * Insert `every` blank pages after each original page.
 * Works backwards to avoid index shifting.
 */
async function applyInterleaveBlanks(pdfBytes, every) {
  const doc = await PDFDocument.load(pdfBytes);
  const originalPageCount = doc.getPageCount();

  for (let i = originalPageCount - 1; i >= 0; i--) {
    const sourcePage = doc.getPage(i);
    const { width, height } = sourcePage.getSize();
    for (let b = 0; b < every; b++) {
      const blank = doc.insertPage(i + 1);
      blank.setSize(width, height);
    }
  }

  return doc.save();
}

// ── insertBlanks ─────────────────────────────────────────────────────────────
/**
 * Insert `count` blank pages before the given 1-indexed page.
 * Blank page dimensions are inherited from the adjacent page.
 */
async function applyInsertBlanks(pdfBytes, count, beforePage) {
  const doc = await PDFDocument.load(pdfBytes);
  const pageCount = doc.getPageCount();
  const insertIndex = beforePage - 1; // convert to 0-indexed

  if (insertIndex > pageCount) {
    logger.logWarning('insertBlanks: beforePage out of bounds — skipping', { beforePage, pageCount });
    return pdfBytes;
  }

  const adjacentPage = doc.getPage(Math.min(insertIndex, pageCount - 1));
  const { width, height } = adjacentPage.getSize();

  for (let i = 0; i < count; i++) {
    const blank = doc.insertPage(insertIndex + i);
    blank.setSize(width, height);
  }

  return doc.save();
}

// ── insertPages ──────────────────────────────────────────────────────────────
/**
 * Insert all pages from a static PDF asset before the given 1-indexed page.
 */
async function applyInsertPages(pdfBytes, assetPath, beforePage) {
  if (!fs.existsSync(assetPath)) {
    logger.logError(`insertPages: asset file not found — skipping step`, new Error(`File not found: ${assetPath}`), { assetPath });
    return pdfBytes;
  }

  const doc = await PDFDocument.load(pdfBytes);
  const pageCount = doc.getPageCount();
  const insertIndex = beforePage - 1; // 0-indexed

  if (insertIndex > pageCount) {
    logger.logWarning('insertPages: beforePage out of bounds — skipping', { beforePage, pageCount });
    return pdfBytes;
  }

  const assetBytes = fs.readFileSync(assetPath);
  const assetDoc = await PDFDocument.load(assetBytes);
  const assetPageCount = assetDoc.getPageCount();

  const copiedPages = await doc.copyPages(assetDoc, [...Array(assetPageCount).keys()]);
  for (let i = 0; i < copiedPages.length; i++) {
    doc.insertPage(insertIndex + i, copiedPages[i]);
  }

  return doc.save();
}

// ── addOrderIdentifier ───────────────────────────────────────────────────────
/**
 * Draw a positioned block containing QR code and/or text onto one or all pages.
 */
async function applyOrderIdentifier(pdfBytes, step, job) {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageCount = doc.getPageCount();

  let targetPages;
  if (step.page === 'all') {
    targetPages = [...Array(pageCount).keys()];
  } else {
    const pageIndex = step.page - 1;
    if (pageIndex < 0 || pageIndex >= pageCount) {
      logger.logWarning('addOrderIdentifier: page out of bounds — skipping', { page: step.page, pageCount });
      return pdfBytes;
    }
    targetPages = [pageIndex];
  }

  for (const pageIndex of targetPages) {
    const page = doc.getPage(pageIndex);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const blockWidthPt  = toPoints(step.size.width,  step.position.unit);
    const blockHeightPt = toPoints(step.size.height, step.position.unit);

    // Resolve X
    let x;
    if (step.position.horizontal === 'center') {
      x = (pageWidth - blockWidthPt) / 2;
    } else if (step.position.horizontal === 'left') {
      x = toPoints(step.position.offsetX || 0, step.position.unit);
    } else { // right
      x = pageWidth - blockWidthPt - toPoints(step.position.offsetX || 0, step.position.unit);
    }

    // Resolve Y — pdf-lib origin is bottom-left; Y increases upward
    let y;
    if (step.position.vertical === 'middle') {
      y = (pageHeight - blockHeightPt) / 2;
    } else if (step.position.vertical === 'bottom') {
      y = toPoints(step.position.offsetY || 0, step.position.unit);
    } else { // top
      y = pageHeight - blockHeightPt - toPoints(step.position.offsetY || 0, step.position.unit);
    }

    // Render content items top-to-bottom within the block
    let cursor = y + blockHeightPt; // start at top of block

    for (const item of (step.content || [])) {
      if (item.type === 'qrCode') {
        const qrData = job.jobNumber || 'NO-JOB';
        const qrPngDataUrl = await QRCode.toDataURL(qrData, {
          width: Math.round(blockWidthPt),
          margin: 0,
          color: { dark: '#000000', light: '#ffffff' }
        });
        const qrBase64 = qrPngDataUrl.split(',')[1];
        const qrImageBytes = Buffer.from(qrBase64, 'base64');
        const qrImage = await doc.embedPng(qrImageBytes);

        const qrSize = Math.min(blockWidthPt, blockHeightPt * 0.7);
        cursor -= qrSize;
        page.drawImage(qrImage, { x, y: cursor, width: qrSize, height: qrSize });
        cursor -= 4; // small gap

      } else if (item.type === 'text') {
        const resolved = resolveTemplate(item.template || '', job);
        const fontSize = 8;
        cursor -= fontSize + 2;
        page.drawText(resolved, {
          x,
          y: cursor,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          maxWidth: blockWidthPt,
        });
      }
    }
  }

  return doc.save();
}

// ── addBannerSheet ───────────────────────────────────────────────────────────
/**
 * Prepend a QR-code banner page (same dimensions as first page of the PDF).
 */
async function applyAddBannerSheet(pdfBytes, job) {
  const existingPdf = await PDFDocument.load(pdfBytes);
  const firstPage = existingPdf.getPages()[0];
  const { width, height } = firstPage.getSize();

  const bannerPdf  = await PDFDocument.create();
  const bannerPage = bannerPdf.addPage([width, height]);

  const orderCode = job.jobNumber || 'NO-JOB';
  const qrBuffer  = await QRCode.toBuffer(orderCode, { type: 'png', margin: 1 });
  const qrImage   = await bannerPdf.embedPng(qrBuffer);

  const qrSize = 85;
  const qrX    = (width  - qrSize) / 2;
  const qrY    = (height - qrSize) / 2 + 20;
  bannerPage.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  const font      = await bannerPdf.embedFont(StandardFonts.Helvetica);
  const fontSize  = 12;
  const textWidth = font.widthOfTextAtSize(orderCode, fontSize);
  bannerPage.drawText(orderCode, {
    x:    (width - textWidth) / 2,
    y:    qrY - 20,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  const copiedPages = await bannerPdf.copyPages(existingPdf, existingPdf.getPageIndices());
  for (const page of copiedPages) {
    bannerPdf.addPage(page);
  }

  return new Uint8Array(await bannerPdf.save());
}

// ── Template resolver ────────────────────────────────────────────────────────
function resolveTemplate(template, job) {
  return template
    .replace(/\{\{jobNumber\}\}/g,    job.jobNumber    || '')
    .replace(/\{\{orderId\}\}/g,      job.orderId      || '')
    .replace(/\{\{qty\}\}/g,          String(job.qty   || ''))
    .replace(/\{\{customerName\}\}/g, job.customerName || '');
}

module.exports = {
  applyInterleaveBlanks,
  applyInsertBlanks,
  applyInsertPages,
  applyOrderIdentifier,
  applyAddBannerSheet,
};
