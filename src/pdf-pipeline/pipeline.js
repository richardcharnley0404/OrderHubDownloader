'use strict';

const {
  applyInterleaveBlanks,
  applyInsertBlanks,
  applyInsertPages,
  applyOrderIdentifier,
  applyAddBannerSheet,
} = require('./steps');
const logger = require('../main/services/logger');

/**
 * Apply all configured pipeline steps in sequence to a PDF.
 *
 * @param {Uint8Array} inputBytes       - Raw bytes of the source PDF
 * @param {object}     pipelineConfig   - { steps: PdfTransformStep[] }
 * @param {object}     job              - JobContext: { jobNumber, orderId, qty, customerName }
 * @returns {Promise<Uint8Array>}       - Transformed PDF bytes
 */
async function applyPdfPipeline(inputBytes, pipelineConfig, job) {
  let current = inputBytes;
  for (const step of (pipelineConfig.steps || [])) {
    try {
      current = await applyStep(current, step, job);
    } catch (err) {
      logger.logError(`PDF pipeline step "${step.type}" failed — skipping`, err, { jobNumber: job.jobNumber });
    }
  }
  return current;
}

async function applyStep(pdfBytes, step, job) {
  switch (step.type) {
    case 'interleaveBlanks':
      return applyInterleaveBlanks(pdfBytes, step.every);
    case 'insertBlanks':
      return applyInsertBlanks(pdfBytes, step.count, step.beforePage);
    case 'insertPages':
      return applyInsertPages(pdfBytes, step.assetPath, step.beforePage);
    case 'addOrderIdentifier':
      return applyOrderIdentifier(pdfBytes, step, job);
    case 'addBannerSheet':
      return applyAddBannerSheet(pdfBytes, job);
    default:
      logger.logWarning(`PDF pipeline: unknown step type "${step.type}" — skipping`, { jobNumber: job.jobNumber });
      return pdfBytes;
  }
}

module.exports = { applyPdfPipeline };
