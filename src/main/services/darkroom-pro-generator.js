'use strict';

/**
 * DarkroomProGenerator
 *
 * Generates the plain-text order file (.TXT) consumed by Darkroom Pro's hot folder.
 *
 * File format overview:
 *   - Order-level header fields (OrderFirstName, OrderLastName, OrderEmail, Ext*, Index)
 *   - Per-image line items using STICKY field inheritance:
 *       Qty, Size, Media, Template, Tmp.Name carry forward until they change.
 *       Each new Filepath= line triggers a new image using current accumulated values.
 *
 * See: docs/print-controllers/DARKROOM-PRO-FORMAT.md
 */
class DarkroomProGenerator {
  /**
   * Generate the complete order file content.
   *
   * @param {object} controller - Controller record from PrintControllerStore
   *   {
   *     indexPrint: boolean,
   *     templateMappings: [{ optionName, optionValue, templatePath }],
   *     extFieldMappings: [{ sourceField, extKeyName }]
   *   }
   * @param {object} job - Job data assembled by PrintService
   *   {
   *     orderNumber: string,
   *     customerName: string,
   *     customerEmail: string,
   *     options: [{ name, value }],      // OrderHub job options (for ext fields + template lookup)
   *     lineItems: [{
   *       filename: string,              // basename only
   *       filepath: string,              // absolute path to source image
   *       quantity: number,
   *       size: string,                  // e.g. '8x10'
   *       mediaName: string,             // from matched channel
   *       templatePath: string|null,     // resolved from templateMappings, or null
   *     }]
   *   }
   * @returns {string} Full .TXT file content
   */
  generate(controller, job) {
    const lines = [];

    // ── Order header ──
    this._writeHeader(lines, controller, job);

    // ── Image line items with sticky fields ──
    this._writeLineItems(lines, job);

    return lines.join('\r\n') + '\r\n';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Header
  // ─────────────────────────────────────────────────────────────────────────

  _writeHeader(lines, controller, job) {
    // Split customer name into first / last on first space
    const { firstName, lastName } = this._splitName(job.customerName);

    lines.push(`OrderFirstName=${firstName}`);
    if (lastName) {
      lines.push(`OrderLastName=${lastName}`);
    }
    if (job.customerEmail) {
      lines.push(`OrderEmail=${job.customerEmail}`);
    }

    // Ext* fields — driven by controller.extFieldMappings
    const extMappings = controller.extFieldMappings || [];
    const jobOptions = job.options || [];

    for (const mapping of extMappings) {
      const option = jobOptions.find(
        o => o.name && o.name.toLowerCase() === mapping.sourceField.toLowerCase()
      );
      if (option && option.value !== undefined && option.value !== null && option.value !== '') {
        lines.push(`${mapping.extKeyName}=${option.value}`);
      }
    }

    // Index print flag
    if (controller.indexPrint) {
      lines.push('Index=1');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Line items — sticky field logic
  // ─────────────────────────────────────────────────────────────────────────

  _writeLineItems(lines, job) {
    // Sticky state — tracks last-written value for each sticky field.
    // Fields are only written to the file when they change.
    const sticky = {
      qty: null,
      size: null,
      media: null,
      template: null,
      tmpName: null
    };

    lines.push(''); // blank line between header and line items

    for (const item of job.lineItems) {
      const itemLines = [];

      // Qty
      if (item.quantity !== sticky.qty) {
        itemLines.push(`Qty=${item.quantity}`);
        sticky.qty = item.quantity;
      }

      // Size
      if (item.size !== sticky.size) {
        itemLines.push(`Size=${item.size}`);
        sticky.size = item.size;
      }

      // Media (channel paper type name)
      if (item.mediaName !== sticky.media) {
        itemLines.push(`Media=${item.mediaName}`);
        sticky.media = item.mediaName;
      }

      // Template (optional — only if a .crd path was resolved for this image)
      const templatePath = item.templatePath || null;
      if (templatePath !== sticky.template) {
        if (templatePath) {
          itemLines.push(`Template=${templatePath}`);
        }
        sticky.template = templatePath;
      }

      // Tmp.Name — always accompanies Template when one is active
      const tmpName = templatePath ? job.customerName : null;
      if (tmpName !== sticky.tmpName) {
        if (tmpName) {
          itemLines.push(`Tmp.Name=${tmpName}`);
        }
        sticky.tmpName = tmpName;
      }

      // Filepath — always written; triggers the image
      itemLines.push(`Filepath=${item.filepath}`);

      lines.push(...itemLines);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Split a full customer name into first and last on the first space.
   * If there is no space, the whole value becomes firstName.
   */
  _splitName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };
    const trimmed = fullName.trim();
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      return { firstName: trimmed, lastName: '' };
    }
    return {
      firstName: trimmed.substring(0, spaceIdx),
      lastName: trimmed.substring(spaceIdx + 1).trim()
    };
  }

  /**
   * Resolve a template path from the controller's templateMappings array
   * given the job's options array.
   *
   * Returns the resolved absolute .crd path string, or null if no match.
   *
   * @param {object} controller
   * @param {Array}  jobOptions  - [{ name, value }]
   */
  resolveTemplatePath(controller, jobOptions) {
    const mappings = controller.templateMappings || [];
    const options = jobOptions || [];

    for (const mapping of mappings) {
      const match = options.find(
        o =>
          o.name && o.name.toLowerCase() === mapping.optionName.toLowerCase() &&
          o.value && o.value.toLowerCase() === mapping.optionValue.toLowerCase()
      );
      if (match) {
        return mapping.templatePath;
      }
    }
    return null;
  }

  /**
   * Generate the order file filename.
   * @param {string} orderNumber
   * @returns {string} e.g. 'Order1000.TXT'
   */
  filename(orderNumber) {
    return `Order${orderNumber}.TXT`;
  }
}

const darkroomProGenerator = new DarkroomProGenerator();
module.exports = { darkroomProGenerator, DarkroomProGenerator };
