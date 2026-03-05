'use strict';

const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const jobService = require('./job-service');
const { printControllerStore } = require('./print-controller-store');
const { dpofGenerator } = require('./dpof-generator');
const { orderFolderWriter } = require('./order-folder-writer');
const { darkroomProGenerator } = require('./darkroom-pro-generator');
const { darkroomProFileWriter } = require('./darkroom-pro-file-writer');
const { printControllerService } = require('./print-controller-service');
const logger = require('./logger');

// Manifest filename is {orderNumber}.json (e.g. PXDEMO-K9MYDG.json)

class PrintService {
  /**
   * Send a job to print.
   * Routes to: Darkroom Pro pipeline, DPOF pipeline, or file-copy
   * depending on process mapping and controller type.
   */
  async sendToPrint(job) {
    const mapping = configService.getProcessMapping(job.process);

    if (mapping.controllerId) {
      const controller = printControllerStore.getController(mapping.controllerId);
      if (!controller) {
        throw new Error(`Print controller ${mapping.controllerId} not found. Check your process mapping.`);
      }

      if (controller.type === 'darkroompro') {
        return this._sendViaDarkroomPro(job, controller);
      }

      // Default: DPOF pipeline (noritsu, epson, etc.)
      return this._sendViaDPOF(job, mapping.controllerId);
    }

    // Route through file-copy (existing behaviour)
    return this._sendViaCopy(job, mapping.folderPath);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Darkroom Pro pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Darkroom Pro pipeline:
   * Generates a flat key=value .TXT order file and writes it to the hot folder.
   * Images are referenced by absolute path — they are NOT copied.
   */
  async _sendViaDarkroomPro(job, controller) {
    if (!controller.isActive) {
      throw new Error(`Print controller "${controller.name}" is not active.`);
    }

    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    // Read order manifest
    const manifest = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    // Resolve the template path (from job options + controller templateMappings)
    const jobOptions = job.options || [];
    const templatePath = darkroomProGenerator.resolveTemplatePath(controller, jobOptions);

    // Resolve product mapping for this job
    const dpOptionsObj = {};
    jobOptions.forEach(opt => { dpOptionsObj[opt.name] = opt.value; });
    const dpMapping = printControllerStore.findChannelForJob(controller.id, job.product_code || '', dpOptionsObj);

    if (!dpMapping) {
      const dpErrMsg = `No product mapping found for product code "${job.product_code || '(none)'}". Add a mapping in Settings > Print Controllers.`;
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: dpErrMsg });
      return { success: false, error: dpErrMsg };
    }

    // Build line items — each image gets an absolute filepath
    const lineItems = [];
    for (const img of jobManifest.images) {
      const absoluteFilepath = path.join(orderFolderPath, img.filename);

      if (!fs.existsSync(absoluteFilepath)) {
        throw new Error(`Image not found: ${absoluteFilepath}`);
      }

      lineItems.push({
        filename: path.basename(img.filename),
        filepath: absoluteFilepath,
        quantity: img.quantity || 1,
        size: img.size,
        templatePath  // same template for all images in the job; null = no border
      });
    }

    // Assemble the job object for the generator
    const dpJob = {
      orderNumber: job.order_number || '',
      customerName: job.customer_name || '',
      customerEmail: job.customer_email || '',
      options: jobOptions,
      lineItems
    };

    // Generate the .TXT content
    const fileContent = darkroomProGenerator.generate(controller, dpJob);

    // Write to hot folder
    const filePath = await darkroomProFileWriter.writeOrderFile(
      controller.hotFolderPath,
      dpJob.orderNumber,
      fileContent
    );

    // Tell the monitor about this submission immediately
    // (avoids a race where fs.watch fires before trackSubmission is called)
    const monitor = printControllerService.getMonitor(controller.id);
    if (monitor && monitor.trackSubmission) {
      monitor.trackSubmission(dpJob.orderNumber);
    }

    // Ensure monitoring is running for this controller
    printControllerService.startMonitoring(controller.id);

    logger.info('Job sent to print via Darkroom Pro', {
      jobId: job.id,
      controller: controller.name,
      hotFolder: filePath,
      images: lineItems.length,
      template: templatePath || 'none'
    });

    // Mark job as in_production
    await this._markInProduction(job.id);

    return {
      success: true,
      method: 'darkroompro',
      sourcePath: jobFolderPath,
      destPath: filePath
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DPOF pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * DPOF pipeline: generate DPOF file and write to controller hot folder
   */
  async _sendViaDPOF(job, controllerId) {
    const controller = printControllerStore.getController(controllerId);
    if (!controller) {
      throw new Error(`Print controller ${controllerId} not found. Check your process mapping.`);
    }
    if (!controller.isActive) {
      throw new Error(`Print controller "${controller.name}" is not active.`);
    }

    // Locate the source folder with downloaded artwork
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    // Read order manifest ({orderNumber}.json)
    const manifest = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest. Manifest has ${manifest.jobs ? manifest.jobs.length : 0} jobs.`);
    }

    // Resolve product mapping by product code + job options
    const optionsObj = {};
    (job.options || []).forEach(opt => { optionsObj[opt.name] = opt.value; });
    const mapping = printControllerStore.findChannelForJob(controller.id, job.product_code || '', optionsObj);

    if (!mapping) {
      const errMsg = `No product mapping found for product code "${job.product_code || '(none)'}". Add a mapping in Settings > Print Controllers.`;
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: errMsg });
      return { success: false, error: errMsg };
    }

    // Build line items from manifest images
    // Manifest filenames are relative to order folder (e.g. "PXDEMO-K9MYDG_38334605/image.jpeg")
    // DPOF references use just the basename (e.g. "image.jpeg")
    const lineItems = jobManifest.images.map((img, idx) => ({
      lineItemNumber: idx + 1,
      quantity: img.quantity || 1,
      filename: path.basename(img.filename)
    }));

    // Build image files list
    // Source paths: manifest filenames are relative to order folder
    // Dest filenames: use basename only for the DPOF IMAGES folder
    const imageFiles = jobManifest.images.map(img => ({
      sourcePath: path.join(orderFolderPath, img.filename),
      filename: path.basename(img.filename)
    }));

    // Verify all images exist
    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // Build the DPOF job object (manifest is minimal — pull details from OH API job)
    const dpofJob = {
      customerName: job.customer_name || '',
      orderNumber: job.order_number || manifest.orderNumber || '',
      orderReference: job.order_number || '',
      productCode: job.product_code || '',
      lineItems,
      imageFiles
    };

    // Generate DPOF content
    const dpofContent = dpofGenerator.generate(controller, mapping, dpofJob);

    // Write to hot folder
    const folderPath = await orderFolderWriter.writeOrderFolder(
      controller.hotFolderPath,
      dpofJob.orderNumber,
      dpofJob.productCode,
      dpofContent,
      imageFiles
    );

    logger.info('Job sent to print via DPOF', {
      jobId: job.id,
      controller: controller.name,
      channel: mapping.channelNumber,
      hotFolder: folderPath,
      images: imageFiles.length
    });

    // Mark job as in_production
    await this._markInProduction(job.id);

    return {
      success: true,
      method: 'dpof',
      sourcePath: jobFolderPath,
      destPath: folderPath
    };
  }

  /**
   * File-copy pipeline (existing behaviour)
   */
  async _sendViaCopy(job, processFolderPath) {
    if (!processFolderPath) {
      throw new Error('Process folder is not configured. Please set a default folder or add a mapping for "' + (job.process || 'unknown') + '" in Settings > Downloads.');
    }

    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderNumber = job.order_number || '';
    const orderId = job.order_id;
    const jobId = job.id;
    const orderFolderName = `${orderNumber}_${orderId}`;
    const jobFolderName = `${orderNumber}_${jobId}`;
    const sourcePath = path.join(downloadDirectory, orderFolderName, jobFolderName);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Job folder not found: ${sourcePath}`);
    }

    const destPath = path.join(processFolderPath, jobFolderName);

    logger.info('Sending job to print via file copy', {
      jobId,
      orderNumber,
      process: job.process || 'none',
      source: sourcePath,
      dest: destPath
    });

    // Copy folder recursively
    try {
      await this._copyFolder(sourcePath, destPath);
      logger.info('Job folder copied to process folder', { jobId, dest: destPath });
    } catch (error) {
      logger.logError('Failed to copy job folder', error, { jobId });
      throw new Error(`Failed to copy job folder: ${error.message}`);
    }

    // Mark job as in_production
    await this._markInProduction(jobId);

    return {
      success: true,
      method: 'copy',
      sourcePath,
      destPath
    };
  }

  /**
   * Read order manifest JSON from the order folder.
   * Manifest filename is {orderNumber}.json (e.g. PXDEMO-K9MYDG.json)
   */
  _readManifest(orderFolderPath, orderNumber) {
    const manifestFilename = `${orderNumber}.json`;
    const manifestPath = path.join(orderFolderPath, manifestFilename);

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Order manifest not found: ${manifestPath}`);
    }

    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to read order manifest: ${error.message}`);
    }
  }

  /**
   * Find the matching job entry in the manifest.
   * The manifest jobId should match job.id (apiJob.job_id) from the OH API.
   */
  _findJobInManifest(manifest, job) {
    if (!manifest.jobs || !Array.isArray(manifest.jobs)) {
      throw new Error('Order manifest has no jobs array.');
    }

    // Match by jobId — compare as strings to handle numeric/string mismatches
    const jobId = String(job.id);
    const internalJobId = job.internal_job_id ? String(job.internal_job_id) : null;

    return manifest.jobs.find(j => {
      const manifestJobId = String(j.jobId);
      return manifestJobId === jobId || (internalJobId && manifestJobId === internalJobId);
    });
  }

  /**
   * Parse a size string like "4x6" into { width, height }
   */
  _parseSize(sizeStr) {
    const parts = String(sizeStr).toLowerCase().split('x');
    if (parts.length !== 2) {
      throw new Error(`Invalid size format: "${sizeStr}". Expected format like "4x6".`);
    }

    const width = parseFloat(parts[0]);
    const height = parseFloat(parts[1]);

    if (isNaN(width) || isNaN(height)) {
      throw new Error(`Invalid size values: "${sizeStr}".`);
    }

    return { width, height };
  }

  /**
   * Mark a job as in_production, with fallback to local-only update
   */
  async _markInProduction(jobId) {
    try {
      await jobService.markInProduction(jobId);
      logger.info('Job marked as in_production', { jobId });
    } catch (error) {
      logger.logWarning('Job sent but API status update failed', {
        jobId,
        error: error.message
      });
      jobService.updateJobLocally(jobId, { _status: 'in_production' });
    }
  }

  /**
   * Recursively copy a folder
   */
  async _copyFolder(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this._copyFolder(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        const stat = fs.statSync(srcPath);
        fs.utimesSync(destPath, stat.atime, stat.mtime);
      }
    }
  }
}

module.exports = new PrintService();
