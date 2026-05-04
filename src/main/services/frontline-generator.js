'use strict';

const { resolveTemplate } = require('./template-tokens');

/**
 * FrontlineGenerator
 *
 * Generates the XML order file (.xml) consumed by Frontline's hot folder.
 *
 * File format:
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <frontline removeAfterProcess="true">
 *     <batch code="{batchCode}">
 *       <device>{device}</device>
 *       <customerID>{jobId}</customerID>
 *       <order sort="{sortString}">
 *         <image quantity="{qty}" rotationAngle="0">
 *           <path><\![CDATA[{filename}]]></path>
 *           <backPrint1 row="1"><\![CDATA[{backPrint1}]]></backPrint1>
 *           <backPrint2 row="2"><\![CDATA[{backPrint2}]]></backPrint2>
 *         </image>
 *       </order>
 *     </batch>
 *   </frontline>
 *
 * - The XML file and all images are placed together in a folder named by jobId.
 * - The XML file is named {jobId}.xml.
 * - Frontline deletes the folder after processing (removeAfterProcess="true").
 * - batchCode and sortString come from the channel mapping (configured per product/size/finish).
 * - backPrint1 and backPrint2 are configurable template strings on the controller:
 *     {customerName}  full customer name
 *     {jobId}         OrderHub job ID
 *     {orderNumber}   order number
 *     {jobName}       job_name field (falls back to orderNumber)
 *     {filename}      image filename including extension (resolved per image)
 *
 * Default backPrint1: "{jobName}  {customerName}"
 * Default backPrint2: "{jobId}  {filename}"
 */
class FrontlineGenerator {
  /**
   * Generate the full XML file content for a job.
   *
   * @param {object} controller  - Controller config
   *   { device, backPrint1, backPrint2 }
   * @param {object} channel     - Resolved channel mapping
   *   { batchCode, sortString }
   * @param {object} job         - Job data
   *   { id, order_number, job_name, customer_name, images: [{ filename, quantity, rotationAngle }] }
   * @returns {string} UTF-8 XML content with CRLF line endings
   */
  generate(controller, channel, job) {
    const device     = (controller.device     || 'Pixfizz').trim();
    const batchCode  = (channel.batchCode  || '').trim();
    const sortString = (channel.sortString || '').trim();
    const jobId      = String(job.id || '');

    const bp1Template = controller.backPrint1 || '{jobName}  {customerName}';
    const bp2Template = controller.backPrint2 || '{jobId}  {filename}';

    const lines = [];

    lines.push('<?xml version="1.0" encoding="utf-8"?>');
    lines.push('<frontline removeAfterProcess="true">');
    lines.push('  <batch code="' + this._escapeAttr(batchCode) + '">');
    lines.push('    <device>' + this._escapeXml(device) + '</device>');
    lines.push('    <customerID>' + this._escapeXml(jobId) + '</customerID>');
    lines.push('    <order sort="' + this._escapeAttr(sortString) + '">');

    for (const image of (job.images || [])) {
      const qty      = image.quantity      != null ? image.quantity      : 1;
      const rotation = image.rotationAngle != null ? image.rotationAngle : 0;
      const filename = image.filename      || '';
      const bp1      = resolveTemplate(bp1Template, job, { filename });
      const bp2      = resolveTemplate(bp2Template, job, { filename });

      lines.push('      <image quantity="' + qty + '" rotationAngle="' + rotation + '">');
      lines.push('        <path><![CDATA[' + filename + ']]></path>');
      lines.push('        <backPrint1 row="1"><![CDATA[' + bp1 + ']]></backPrint1>');
      lines.push('        <backPrint2 row="2"><![CDATA[' + bp2 + ']]></backPrint2>');
      lines.push('      </image>');
    }

    lines.push('    </order>');
    lines.push('  </batch>');
    lines.push('</frontline>');

    // CRLF required — Frontline runs on Windows
    return lines.join('\r\n') + '\r\n';
  }

  /** Escape a string for use in an XML attribute value (double-quoted). */
  _escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Escape a string for use in XML element text content. */
  _escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Return the XML filename for a given job ID.
   * @param {string|number} jobId
   * @returns {string} e.g. "12345.xml"
   */
  filename(jobId) {
    return jobId + '.xml';
  }
}

const frontlineGenerator = new FrontlineGenerator();
module.exports = { frontlineGenerator, FrontlineGenerator };
