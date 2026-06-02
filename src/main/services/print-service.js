'use strict';

const fs = require('fs');
const path = require('path');
const configService = require('./config-service');
const jobService = require('./job-service');
const { loadSidecar } = require('../jobs/sidecarManager');
const { printControllerStore } = require('./print-controller-store');
const { dpofGenerator } = require('./dpof-generator');
const { orderFolderWriter } = require('./order-folder-writer');
const { darkroomProGenerator } = require('./darkroom-pro-generator');
const { darkroomProFileWriter } = require('./darkroom-pro-file-writer');
const { generateDarkroomProFile } = require('./darkroom-pro-output');
const { frontlineGenerator } = require('./frontline-generator');
const { frontlineFileWriter } = require('./frontline-file-writer');
const { generateFujiJobMakerFiles } = require('./fuji-jobmaker-generator');
const { fujiJobMakerFileWriter } = require('./fuji-jobmaker-file-writer');
const { printControllerService } = require('./print-controller-service');
const logger = require('./logger');
const { buildFolderName } = require('../../shared/printUtils');

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

    // Phase 3: Load enhanced-image substitution map.
    // If an image was enhanced via the AI Enhancement pipeline (Pixfizz AI
    // local or Topaz), use the cached enhanced version instead of the
    // original working file.
    //
    // Pre-existing bug fixed alongside Phase C+ jobId convention work: every
    // other _getEnhancedPathMap call site in this file keys the sidecar by
    // `${order_number}_${id}` (the composite form the React drawer also uses),
    // but this Darkroom direct path used to pass `String(job.id)` (numeric).
    // That meant the lookup hit the wrong/missing sidecar and silently
    // returned empty — Darkroom prints would never substitute enhanced files.
    // Aligning with the rest of print-service for consistency.
    const enhancedMap = await this._getEnhancedPathMap(`${job.order_number}_${job.id}`, jobFolderPath);

    // Build line items — each image gets an absolute filepath
    const lineItems = [];
    for (const img of jobManifest.images) {
      const basename = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      const absoluteFilepath = enhancedPath || path.join(orderFolderPath, img.filename);

      if (enhancedPath) {
        logger.info('Using enhanced image for Darkroom Pro print', { basename, enhancedPath });
      }

      if (!fs.existsSync(absoluteFilepath)) {
        throw new Error(`Image not found: ${absoluteFilepath}`);
      }

      lineItems.push({
        filename: basename,
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

    // Mark job as completed — no prefix lifecycle for Darkroom Pro jobs
    await this._markCompleted(job.id);

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
   * Public entry point for the DPOF pipeline — new routing system.
   *
   * Accepts a pre-resolved route from routingService.resolveRoute() so it
   * never touches the legacy printControllerStore. Use this when dispatching
   * from the new Routing tab configuration.
   *
   * @param {object} job   - Job object from the OH API cache
   * @param {object} route - Route from routingService.resolveRoute():
   *   { controllerId, controllerName, outputPath, channelNumber, printSizeCode }
   */
  async sendViaDPOFRouted(job, route) {
    // Delegate to the appropriate pipeline based on controller type.
    if (route.controllerType === 'pdf_copy') {
      return this._sendViaPdfCopyRouted(job, route);
    }
    if (route.controllerType === 'folder_copy') {
      return this._sendViaFolderCopyRouted(job, route);
    }
    if (route.controllerType === 'darkroompro') {
      return this._sendViaDarkroomProRouted(job, route);
    }
    if (route.controllerType === 'frontline') {
      return this._sendViaFrontlineRouted(job, route);
    }
    if (route.controllerType === 'fujijobmaker') {
      return this._sendViaFujiJobMakerRouted(job, route);
    }

    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    const manifest = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest. Manifest has ${manifest.jobs ? manifest.jobs.length : 0} jobs.`);
    }

    if (Array.isArray(jobManifest.images) && jobManifest.images.some(img => !img.size)) {
      throw new Error('Cannot print — size is missing on one or more images. Check product configuration in Pixfizz Core.');
    }

    const enhancedMap    = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);
    const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

    const lineItems = jobManifest.images.map((img, idx) => ({
      lineItemNumber: idx + 1,
      quantity: img.quantity || 1,
      filename: path.basename(img.filename)
    }));

    let imageFiles = jobManifest.images.map(img => {
      const basename = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      if (enhancedPath) {
        logger.info('Using enhanced image for DPOF print', { filename: basename, enhancedPath });
      }
      return {
        sourcePath: enhancedPath || path.join(orderFolderPath, img.filename),
        filename: basename
      };
    });

    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap
    );

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // ── Banner sheet ─────────────────────────────────────────────────────────
    // If enabled on the controller, prepend a separator page as the first image.
    // Failures are swallowed so a banner error never blocks the print job.
    if (route.bannerSheet && imageFiles.length > 0) {
      try {
        const { generateBannerSheet } = require('../banner-sheet-service');
        const Jimp = require('jimp');
        const firstImg = await Jimp.read(imageFiles[0].sourcePath);
        const widthPx  = firstImg.getWidth();
        const heightPx = firstImg.getHeight();
        const jobCode  = job.job_name || job.order_number || '';
        const bannerBuffer = await generateBannerSheet(jobCode, widthPx, heightPx);
        const bannerDir  = path.join(jobFolderPath, 'working');
        const bannerPath = path.join(bannerDir, 'BANNER.JPG');
        await fs.promises.mkdir(bannerDir, { recursive: true });
        await fs.promises.writeFile(bannerPath, bannerBuffer);
        imageFiles.unshift({ sourcePath: bannerPath, filename: 'BANNER.JPG' });
        lineItems.unshift({ quantity: 1, filename: 'BANNER.JPG' });
        console.error('[BANNER] unshift complete, imageFiles count:', imageFiles.length);
        logger.info('Banner sheet prepended to DPOF job', { jobId: job.id, widthPx, heightPx });
      } catch (bannerErr) {
        console.error('[BANNER ERROR]', bannerErr);
        logger.logError('Banner sheet generation failed — continuing without banner', bannerErr, { jobId: job.id });
      }
    }

    const dpofContent = dpofGenerator.generate({
      orderNumber:    job.order_number || manifest.orderNumber || '',
      customerName:   job.customer_name || '',
      channelNumber:  route.channelNumber,
      printSizeCode:  route.printSizeCode,
      images:         lineItems.map(li => ({ filename: li.filename, quantity: li.quantity })),
      controllerType: route.controllerType || 'noritsu',
    });

    // Folder-name options sourced from the controller via routing-service.
    // Default on for back-compat (route.includeCustomerInFolder !== false).
    const nameOpts = {
      includeCustomerName: route.includeCustomerInFolder !== false,
      customerName:        job.customer_name || '',
    };

    let writeResult;
    try {
      writeResult = await orderFolderWriter.writeOrderFolder(
        route.outputPath,
        job,
        dpofContent,
        imageFiles,
        null,
        nameOpts
      );
    } catch (writeErr) {
      const tempFolderName = buildFolderName('p', job, null, nameOpts);
      logger.logError('DPOF write failed — p folder left in hot folder', writeErr, {
        jobId: job.id,
        tempFolder: tempFolderName
      });
      return { success: false, error: writeErr.message, folderName: tempFolderName };
    }

    logger.info('Job sent to print via DPOF (routed)', {
      jobId:      job.id,
      controller: route.controllerName,
      channel:    route.channelNumber,
      hotFolder:  writeResult.folderPath,
      folderName: writeResult.folderName,
      images:     imageFiles.length
    });

    if (route.checkOrderStatus === false) {
      logger.info('[auto-print] checkOrderStatus disabled — marking job as completed immediately', { jobId: job.id });
      await this._markCompleted(job.id);
    } else {
      await this._markInProduction(job.id);
    }

    return {
      success:    true,
      method:     'dpof',
      sourcePath: jobFolderPath,
      destPath:   writeResult.folderPath,
      folderName: writeResult.folderName
    };
  }

  /**
   * Public entry point for the DPOF pipeline — legacy path.
   * Resolves controller and channel from the legacy printControllerStore.
   * Use sendViaDPOFRouted for the new routing system.
   */
  async sendViaDPOF(job, controllerId) {
    return this._sendViaDPOF(job, controllerId);
  }

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

    // Phase 3: Load enhanced-image substitution map.
    // If an image was enhanced via the AI Enhancement pipeline (Pixfizz AI
    // local or Topaz), use the cached enhanced version instead of the
    // original working file.
    // NOTE: The sidecar file is named after jobFolderName (e.g. "PXDEMO-R9F091_38348645.json"),
    // not job.id alone, so we pass jobFolderName as the sidecar ID.
    const enhancedMap = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);

    // Phase 4: Load CMY correction values from sidecar (one entry per image).
    const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

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
    // Phase 3: substitute enhanced path where available
    let imageFiles = jobManifest.images.map(img => {
      const basename = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      if (enhancedPath) {
        logger.info('Using enhanced image for DPOF print', { filename: basename, enhancedPath });
      }
      return {
        sourcePath: enhancedPath || path.join(orderFolderPath, img.filename),
        filename: basename
      };
    });

    // Phase 4: Apply CMY corrections — writes corrected JPEGs to /working/ where needed.
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap
    );

    // Verify all images exist
    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // Derive printSizeCode: use mapping's explicit code, fall back to NML size, then KG
    const printSizeCode = mapping.printSizeCode ||
      (mapping.size ? `NML -PSIZE "${mapping.size}"` : 'KG');

    // Generate DPOF content
    const dpofContent = dpofGenerator.generate({
      orderNumber:    job.order_number || manifest.orderNumber || '',
      customerName:   job.customer_name || '',
      channelNumber:  mapping.channelNumber,
      printSizeCode,
      images:         lineItems.map(li => ({ filename: li.filename, quantity: li.quantity })),
      controllerType: controller.type,
    });

    // Folder-name options sourced from the controller. Default on for back-compat.
    const nameOpts = {
      includeCustomerName: controller.includeCustomerInFolder !== false,
      customerName:        job.customer_name || '',
    };

    // Write to hot folder using prefix-swap pattern (p → o on success)
    let writeResult;
    try {
      writeResult = await orderFolderWriter.writeOrderFolder(
        controller.hotFolderPath,
        job,
        dpofContent,
        imageFiles,
        null,
        nameOpts
      );
    } catch (writeErr) {
      // Leave the "p" folder in place — operator will see "Import Error" status
      const tempFolderName = buildFolderName('p', job, null, nameOpts);
      logger.logError('DPOF write failed — p folder left in hot folder', writeErr, {
        jobId: job.id,
        tempFolder: tempFolderName
      });
      return { success: false, error: writeErr.message, folderName: tempFolderName };
    }

    logger.info('Job sent to print via DPOF', {
      jobId: job.id,
      controller: controller.name,
      channel: mapping.channelNumber,
      hotFolder: writeResult.folderPath,
      folderName: writeResult.folderName,
      images: imageFiles.length
    });

    // Mark job as in_production
    await this._markInProduction(job.id);

    return {
      success: true,
      method: 'dpof',
      sourcePath: jobFolderPath,
      destPath: writeResult.folderPath,
      folderName: writeResult.folderName
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint DPOF pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a reprint job to a DPOF controller.
   *
   * Reprints always copy from /originals/ of the reprint job folder — never
   * from /working/ or /cache/ — to ensure a clean re-run of the untouched
   * source image.
   *
   * Folder naming uses the parent job's product/options with the reprint
   * suffix inserted between the job number and product name:
   *   oPXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed
   *
   * @param {object}   parentJob       - Parent API job object (job_name, product, options, …)
   * @param {string}   reprintJobPath  - Absolute path to the reprint job folder
   * @param {string}   reprintSuffix   - e.g. 'r1', 'r2'
   * @param {Array}    reprintImages   - Array from reprint sidecar.images ({ filename, qtyCurrent })
   * @returns {Promise<{ success: boolean, folderName?: string, error?: string }>}
   */
  async _sendReprintViaDPOF(parentJob, reprintJobPath, reprintSuffix, reprintImages) {
    const mapping = configService.getProcessMapping(parentJob.process);
    if (!mapping.controllerId) {
      return { success: false, error: `Parent job "${parentJob.job_name}" has no controller mapping for process "${parentJob.process}".` };
    }

    const controller = printControllerStore.getController(mapping.controllerId);
    if (!controller) {
      throw new Error(`Print controller ${mapping.controllerId} not found.`);
    }
    if (!controller.isActive) {
      throw new Error(`Print controller "${controller.name}" is not active.`);
    }
    if (controller.type === 'darkroompro') {
      // Darkroom Pro reprints used to short-circuit here. They now have a
      // proper pipeline (_sendReprintViaDarkroomPro) but reaching this
      // method on a Darkroom Pro parent should never happen — the
      // orchestrator (sendReprint) is responsible for dispatching to the
      // correct controller-type method. If we land here it means a caller
      // bypassed the orchestrator and called this DPOF-specific method
      // directly; loud failure beats silent wrong-pipeline dispatch.
      return {
        success: false,
        error: 'Darkroom Pro reprints must go through sendReprint() — _sendReprintViaDPOF received a Darkroom Pro parent.'
      };
    }

    // Resolve product/channel mapping using parent job's product code + options
    const optionsObj = {};
    (parentJob.options || []).forEach(opt => { optionsObj[opt.name] = opt.value; });
    const channelMapping = printControllerStore.findChannelForJob(
      controller.id, parentJob.product_code || '', optionsObj
    );

    if (!channelMapping) {
      return {
        success: false,
        error: `No product mapping found for product code "${parentJob.product_code || '(none)'}". Add a mapping in Settings > Print Controllers.`
      };
    }

    // Images come from the reprint job's /originals/ folder
    const originalsPath = path.join(reprintJobPath, 'originals');

    const lineItems = reprintImages.map((img, idx) => ({
      lineItemNumber: idx + 1,
      quantity: img.qtyCurrent || 1,
      filename: img.filename
    }));

    let imageFiles = reprintImages.map(img => ({
      sourcePath: path.join(originalsPath, img.filename),
      filename: img.filename
    }));

    // Verify all images exist before attempting to write
    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Reprint image not found: ${img.sourcePath}`);
      }
    }

    // Apply CMY corrections stored in the reprint sidecar images.
    const reprintCorrectionsMap = new Map(
      reprintImages.map(img => [img.filename, img.corrections || {}])
    );
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(reprintJobPath, 'working'),
      reprintCorrectionsMap
    );

    // Generate DPOF content using parent job's controller/channel settings
    const reprintPrintSizeCode = channelMapping.printSizeCode ||
      (channelMapping.size ? `NML -PSIZE "${channelMapping.size}"` : 'KG');

    const dpofContent = dpofGenerator.generate({
      orderNumber:    parentJob.order_number  || '',
      customerName:   parentJob.customer_name || '',
      channelNumber:  channelMapping.channelNumber,
      printSizeCode:  reprintPrintSizeCode,
      images:         lineItems.map(li => ({ filename: li.filename, quantity: li.quantity })),
      controllerType: controller.type,
    });

    // Folder-name options sourced from the controller. Default on for back-compat.
    const nameOpts = {
      includeCustomerName: controller.includeCustomerInFolder !== false,
      customerName:        parentJob.customer_name || '',
    };

    // Write to hot folder using prefix-swap pattern (p → o on success)
    let writeResult;
    try {
      writeResult = await orderFolderWriter.writeOrderFolder(
        controller.hotFolderPath,
        parentJob,
        dpofContent,
        imageFiles,
        reprintSuffix,
        nameOpts
      );
    } catch (writeErr) {
      const tempFolderName = buildFolderName('p', parentJob, reprintSuffix, nameOpts);
      logger.logError('Reprint DPOF write failed — p folder left in hot folder', writeErr, {
        parentJobId: parentJob.id,
        reprintSuffix,
        tempFolder: tempFolderName
      });
      return { success: false, error: writeErr.message, folderName: tempFolderName };
    }

    logger.info('Reprint sent to DPOF controller', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      controller:   controller.name,
      hotFolder:    writeResult.folderPath,
      folderName:   writeResult.folderName,
      images:       imageFiles.length
    });

    return {
      success:    true,
      method:     'dpof-reprint',
      destPath:   writeResult.folderPath,
      folderName: writeResult.folderName
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint orchestrator
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Public entry point for sending a freshly-built reprint job to the
   * appropriate printer pipeline. Resolves the parent job's route once
   * via the new routing-service and dispatches to the matching
   * controller-type method.
   *
   * The reprint folder must already exist on disk (i.e. createReprint
   * has run); this method does not build the folder, only the print
   * envelope. Status changes on the parent OH job are not made here —
   * a reprint is a sibling job that lives only in OHD's local files
   * and on the printer's queue.
   *
   * Returns the same shape the per-pipeline methods do:
   *   { success: true, method, destPath, ... }
   *   { success: false, error }
   *
   * Pre-2026-05-12 the IPC handler called _sendReprintViaDPOF directly,
   * which short-circuited with "Darkroom Pro reprints are not yet
   * supported" — silently for the operator, because the IPC handler
   * returned success: true regardless and only logged a warning. See
   * bugfixes.md 2026-05-12 entry on the Darkroom reprint pipeline.
   *
   * @param {object} parentJob       - Parent API job (from job-service cache)
   * @param {string} reprintJobPath  - Absolute path to the reprint job folder
   * @param {string} reprintSuffix   - 'r1', 'r2', …
   * @param {Array}  reprintImages   - Array from the reprint sidecar.images
   *                                   ({ filename, qtyCurrent, corrections })
   * @returns {Promise<{success:boolean, method?:string, destPath?:string, error?:string}>}
   */
  async sendReprint(parentJob, reprintJobPath, reprintSuffix, reprintImages) {
    const { resolveRoute } = require('./routing-service');
    const route = resolveRoute(parentJob);

    if (route.type === 'unrouted') {
      return {
        success: false,
        error: `Parent job has no usable route (reason: ${route.reason}). Configure routing in Settings before sending a reprint.`,
      };
    }
    if (route.type !== 'controller') {
      return {
        success: false,
        error: `Reprints are only supported for controller routes (parent is routed to a ${route.type}). Send a fresh print for that workflow instead.`,
      };
    }

    if (route.controllerType === 'darkroompro') {
      return this._sendReprintViaDarkroomPro(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
    }
    if (route.controllerType === 'folder_copy') {
      return this._sendReprintViaFolderCopy(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
    }
    // DPOF path covers controllerType 'dpof' and legacy / unspecified —
    // existing _sendReprintViaDPOF resolves its own controller config via
    // the legacy printControllerStore so we don't need to pass the route.
    if (!route.controllerType || route.controllerType === 'dpof') {
      return this._sendReprintViaDPOF(parentJob, reprintJobPath, reprintSuffix, reprintImages);
    }

    return {
      success: false,
      error: `Reprints are not yet supported for controller type "${route.controllerType}".`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint — Darkroom Pro pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a built reprint job to a Darkroom Pro controller.
   *
   * Mirrors `_sendViaDarkroomProRouted` but with three key differences:
   *
   *   1. Images come from `{reprintJobPath}/originals/` (the clean copies
   *      that reprintManager produced), not the parent's download folder.
   *      No manifest is consulted — the reprint sidecar's `images` array
   *      is the source of truth for which files print and at what qty.
   *   2. CMY corrections are read from the reprint sidecar (parent
   *      corrections were carried in by reprintManager). They get
   *      re-applied to `{reprintJobPath}/working/` so the on-disk JPEGs
   *      Darkroom Pro reads from carry the operator's adjustments.
   *      Enhanced images are NOT propagated to reprints — the design
   *      intent (see reprintManager.js header) is that reprints always
   *      start from /originals/ for a predictable result.
   *   3. The output .txt is named `{job_name}-r{n}.txt` via
   *      `outputFilenameStem` so it doesn't collide with the parent's
   *      `{job_name}.txt` in the controller's hot folder.
   *
   * Parent job status is left untouched — the reprint is a sibling
   * concept that does not advance the OH-side lifecycle.
   *
   * @param {object} parentJob       - Parent API job
   * @param {object} route           - Pre-resolved route ({ controllerId, artworkRootPath, outputPath, orderLastNameFormat, checkOrderStatus, … })
   * @param {string} reprintJobPath  - Absolute path to the reprint job folder
   * @param {string} reprintSuffix   - 'r1', 'r2', …
   * @param {Array}  reprintImages   - Array from reprint sidecar.images
   * @returns {Promise<{success:boolean, method?:string, destPath?:string, error?:string}>}
   */
  async _sendReprintViaDarkroomPro(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    if (!Array.isArray(reprintImages) || reprintImages.length === 0) {
      return { success: false, error: 'Reprint has no images to send.' };
    }

    const originalsPath = path.join(reprintJobPath, 'originals');
    const workingPath   = path.join(reprintJobPath, 'working');

    // Build per-image entries straight from the reprint sidecar. No
    // manifest, no enhanced-path lookup — reprints intentionally start
    // from /originals/ (see reprintManager.js header for the rationale).
    let imageFiles = reprintImages.map(img => ({
      sourcePath: path.join(originalsPath, img.filename),
      filename:   img.filename,
    }));

    // Verify all source images exist on disk before doing any writes.
    // reprintManager copied them in, so this is a safety net against
    // a manually-mutated reprint folder.
    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        return {
          success: false,
          error: `Reprint image not found on disk: ${img.sourcePath}`,
        };
      }
    }

    // Apply CMY corrections — writes `{filename}_corrected.jpg` into
    // the reprint's /working/ folder where any image with non-zero
    // corrections needs it, and patches imageFiles[i].sourcePath to
    // point at the corrected copy.
    const correctionsMap = new Map(
      reprintImages.map(img => [img.filename, img.corrections || {}])
    );
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      workingPath,
      correctionsMap,
    );

    // Customer name split, identical to the non-reprint path.
    const fullName  = (parentJob.customer_name || '').trim();
    const spaceIdx  = fullName.indexOf(' ');
    const firstName = spaceIdx === -1 ? fullName : fullName.substring(0, spaceIdx);
    const lastName  = spaceIdx === -1 ? ''        : fullName.substring(spaceIdx + 1).trim();

    // Group images by their reprint-time quantity so the generator emits
    // one line-item block per distinct qty (matches the non-reprint shape).
    const imagesByQty = new Map();
    reprintImages.forEach((img, i) => {
      const qty = img.qtyCurrent || 1;
      if (!imagesByQty.has(qty)) imagesByQty.set(qty, []);
      imagesByQty.get(qty).push({
        filename:   imageFiles[i].filename,
        sourcePath: imageFiles[i].sourcePath,
      });
    });

    // Job-level options drive media resolution; reprints use parent's options.
    const jobOptions = parentJob.options || [];
    const lineItems = [];
    for (const [qty, images] of imagesByQty) {
      lineItems.push({ qty, options: jobOptions, images });
    }

    // Derive the .txt filename stem from the parent's job_name with the
    // reprint suffix appended. Falls back to a composite when job_name
    // isn't set (paranoia — production rows always have one).
    const baseStem = parentJob.job_name
      || `${parentJob.order_number || ''}_${parentJob.id}`;
    const reprintStem = `${baseStem}-${reprintSuffix}`;

    const dpJob = {
      id:                 parentJob.id,
      orderRef:           parentJob.order_number || '',
      outputFilenameStem: reprintStem,
      productCode:        parentJob.product_code || '',
      customer:           { firstName, lastName, email: parentJob.customer_email || '' },
      labCode:            parentJob.website || '',
      orderDate:          parentJob.created_at ? new Date(parentJob.created_at) : new Date(),
      lineItems,
      // Carry per-job overrides from the original Assign-modal flow so a
      // manually-assigned size/media on the parent applies to the reprint
      // too. Without this a reprint of an Assigned job would re-trigger
      // translation-table resolution and possibly land on a different
      // size/media than the original print used.
      _sizeOverride:      parentJob._darkroomProSize  || null,
      _mediaOverride:     parentJob._darkroomProMedia || null,
    };

    // Fetch the full controller record so we have the translation tables
    // and configurable photo lines — the route object alone doesn't carry
    // them.
    const { getControllers } = require('./routing-service');
    const fullController = getControllers().find(c => c.id === route.controllerId);

    const controller = {
      artworkRootPath:     route.artworkRootPath,
      orderLastNameFormat: route.orderLastNameFormat,
      outputPath:          route.outputPath,
      sizeTranslations:    fullController?.sizeTranslations  || [],
      mediaOptionKey:      fullController?.mediaOptionKey    || '',
      mediaTranslations:   fullController?.mediaTranslations || [],
      photoLines:          fullController?.photoLines        || [],
    };

    let destPath;
    try {
      destPath = await generateDarkroomProFile(dpJob, controller);
    } catch (writeErr) {
      logger.logError('Darkroom Pro reprint write failed', writeErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
        reprintStem,
      });
      return { success: false, error: writeErr.message };
    }

    logger.info('Reprint sent via Darkroom Pro', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      controller:   route.controllerName,
      destPath,
      lineItems:    lineItems.length,
    });

    return {
      success:  true,
      method:   'darkroompro-reprint',
      destPath,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint — folder-copy pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a built reprint job to a "folder_copy" controller (Wide Format,
   * "Fuji Pic Pro - Folders", POD, …).
   *
   * Mirrors the first-send path `_sendViaFolderCopyRouted` — a plain file
   * copy into `{outputPath}/{folder}/` with no DPOF envelope and no index
   * file — with the reprint-family adaptations the other two reprint
   * methods (`_sendReprintViaDPOF`, `_sendReprintViaDarkroomPro`) use:
   *
   *   1. Images come from `{reprintJobPath}/working/`, enumerated from the
   *      reprint sidecar's `images` array — no manifest is consulted.
   *   2. The destination folder is the reprint folder's own name
   *      (`…_{id}-r{n}`, via `path.basename(reprintJobPath)`) so it does
   *      not collide with the parent job's `…_{id}` folder in the
   *      controller output.
   *   3. No CMY corrections and no enhanced-image substitution — this
   *      deliberately matches `_sendViaFolderCopyRouted` (folder_copy
   *      targets wide-format/POD workflows where neither applies) rather
   *      than the DPOF / Darkroom Pro reprint pipelines.
   *
   * Like `_sendReprintViaDPOF` / `_sendReprintViaDarkroomPro` — and unlike
   * `_sendViaFolderCopyRouted` — this method does NOT call `_markCompleted`:
   * a reprint is a sibling job that does not advance the parent's OH-side
   * lifecycle (see the `sendReprint` docstring). It also does not consult
   * AI quality scoring / auto-print / Hold-Auto-Print — both existing
   * reprint methods bypass them (the operator reviews rows before
   * triggering a reprint); this mirrors that stance.
   *
   * @param {object} parentJob       - Parent API job (from job-service cache)
   * @param {object} route           - Pre-resolved route ({ controllerType:'folder_copy', controllerName, outputPath, … })
   * @param {string} reprintJobPath  - Absolute path to the reprint job folder
   * @param {string} reprintSuffix   - 'r1', 'r2', …
   * @param {Array}  reprintImages   - Array from reprint sidecar.images ({ filename, qtyCurrent, corrections })
   * @returns {Promise<{success:boolean, method?:string, destPath?:string, error?:string}>}
   */
  async _sendReprintViaFolderCopy(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    if (!Array.isArray(reprintImages) || reprintImages.length === 0) {
      return { success: false, error: 'Reprint has no images to send.' };
    }

    // Source is the reprint folder's /working/ directory — the operator-
    // reviewed copies reprintManager produced. No manifest, no enhanced-path
    // lookup, no CMY corrections (see method docstring).
    const workingPath = path.join(reprintJobPath, 'working');

    const imageFiles = reprintImages.map(img => ({
      sourcePath: path.join(workingPath, img.filename),
      filename:   img.filename,
    }));

    // Verify every source image exists before any write. Return (don't
    // throw) so sendReprint keeps its documented { success:false } contract,
    // matching _sendReprintViaDarkroomPro's safety net.
    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        return { success: false, error: `Reprint image not found on disk: ${img.sourcePath}` };
      }
    }

    // Destination folder name = the reprint folder's own name (`…_{id}-r{n}`),
    // keeping it distinct from the parent's `…_{id}` folder in the output.
    const reprintFolderName = path.basename(reprintJobPath);
    const destFolder        = path.join(route.outputPath, reprintFolderName);

    try {
      fs.mkdirSync(destFolder, { recursive: true });
      for (const img of imageFiles) {
        fs.copyFileSync(img.sourcePath, path.join(destFolder, img.filename));
      }
    } catch (writeErr) {
      logger.logError('Folder-copy reprint write failed', writeErr, {
        parentJobId: parentJob.id,
        reprintSuffix,
        destFolder,
      });
      return { success: false, error: writeErr.message };
    }

    logger.info('Reprint sent via folder copy (routed)', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      reprintJobId: reprintFolderName,
      controller:   route.controllerName,
      destFolder,
      images:       imageFiles.length,
    });

    return {
      success:    true,
      method:     'folder_copy-reprint',
      sourcePath: workingPath,
      destPath:   destFolder,
    };
  }

  /**
   * Folder-copy pipeline for "folder_copy" controllers (Wide Format, POD, etc.).
   *
   * Copies the job's image files directly into {outputPath}/{orderNumber}_{jobId}/
   * with no DPOF envelope, no IMAGE/MISC subdirectories, and no index file.
   * Enhanced image substitution is applied if enhanced versions exist; CMY colour
   * corrections are not applied (not relevant for wide-format/POD workflows).
   */
  async _sendViaFolderCopyRouted(job, route) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    const manifest    = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest. Manifest has ${manifest.jobs ? manifest.jobs.length : 0} jobs.`);
    }

    const enhancedMap = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);

    const imageFiles = jobManifest.images.map(img => {
      const basename     = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      if (enhancedPath) {
        logger.info('Using enhanced image for folder-copy print', { filename: basename, enhancedPath });
      }
      return {
        sourcePath: enhancedPath || path.join(orderFolderPath, img.filename),
        filename:   basename,
      };
    });

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // Write directly to {outputPath}/{orderNumber}_{jobId}/
    const destFolder = path.join(route.outputPath, jobFolderName);

    try {
      fs.mkdirSync(destFolder, { recursive: true });
      for (const img of imageFiles) {
        fs.copyFileSync(img.sourcePath, path.join(destFolder, img.filename));
      }
    } catch (writeErr) {
      logger.logError('Folder-copy write failed', writeErr, { jobId: job.id, destFolder });
      return { success: false, error: writeErr.message };
    }

    logger.info('Job sent to print via folder copy (routed)', {
      jobId:      job.id,
      controller: route.controllerName,
      destFolder,
      images:     imageFiles.length,
    });

    await this._markCompleted(job.id);

    return {
      success:    true,
      method:     'folder_copy',
      sourcePath: jobFolderPath,
      destPath:   destFolder,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Darkroom Pro — new routing-system pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Darkroom Pro pipeline for controllers configured via the new routing system.
   *
   * Reads the job manifest, builds a structured job object for the generator,
   * and writes {orderRef}.txt to controller.outputPath.
   *
   * Images are referenced by absolute path (artworkRootPath\{orderRef}\Darkroom\{filename})
   * and are NOT copied. Size and Media come from the matched channel mapping's options.
   */
  async _sendViaDarkroomProRouted(job, route) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    const manifest    = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    // Split customer name into first / last on the first space
    const fullName   = (job.customer_name || '').trim();
    const spaceIdx   = fullName.indexOf(' ');
    const firstName  = spaceIdx === -1 ? fullName : fullName.substring(0, spaceIdx);
    const lastName   = spaceIdx === -1 ? ''        : fullName.substring(spaceIdx + 1).trim();

    // Job-level options (e.g. finish-options: lustre) are used for Media resolution
    const jobOptions     = job.options || [];
    const manifestImages = jobManifest.images || [];

    // ── Resolve final sourcePaths using the same three-step priority chain as DPOF ──
    // Step 1: AI-enhanced image (absolute path from sidecar, if it exists on disk)
    const enhancedMap    = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);
    // Step 2: CMY colour corrections (writes working/{basename}_corrected.jpg on demand)
    const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

    // Build imageFiles in manifest order: prefer enhanced, fall back to raw download path
    let imageFiles = manifestImages.map(img => {
      const basename     = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      return {
        sourcePath: enhancedPath || path.join(orderFolderPath, img.filename),
        filename:   basename,
      };
    });

    // Apply CMY corrections — replaces sourcePath with the corrected JPEG where needed
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap
    );

    // Group by quantity for the Darkroom Pro line-item blocks.
    // imageFiles is parallel to manifestImages so we can read qty by index.
    const imagesByQty = new Map();
    manifestImages.forEach((manifestImg, i) => {
      const qty = manifestImg.quantity || 1;
      if (!imagesByQty.has(qty)) imagesByQty.set(qty, []);
      imagesByQty.get(qty).push({
        filename:   imageFiles[i].filename,
        sourcePath: imageFiles[i].sourcePath,
      });
    });

    const lineItems = [];
    for (const [qty, images] of imagesByQty) {
      lineItems.push({ qty, options: jobOptions, images });
    }

    const dpJob = {
      // Job id is exposed so the {jobId} token resolves in configurable photo
      // lines. Templates that don't reference {jobId} are unaffected.
      id:            job.id,
      orderRef:      job.order_number || '',
      // Filename stem for the Darkroom Pro .txt output. Multi-job orders
      // share order_number, so using order_number alone collides — the
      // second job's file overwrites the first. Prefer job_name (matches
      // the JOB NO column in the Jobs grid, e.g. "PXDEMO-9V0L91-1") so
      // operators can correlate filenames to grid rows. Fall back to a
      // stable composite when job_name isn't set.
      outputFilenameStem: job.job_name || `${job.order_number || ''}_${job.id}`,
      productCode:   job.product_code || '',
      customer:      { firstName, lastName, email: job.customer_email || '' },
      labCode:       job.website || '',
      orderDate:     job.created_at ? new Date(job.created_at) : new Date(),
      lineItems,
      // Per-job manual overrides from the Assign modal (take priority over
      // translation tables inside resolveSize / resolveMedia).
      _sizeOverride:  job._darkroomProSize  || null,
      _mediaOverride: job._darkroomProMedia || null,
    };

    // Fetch the full controller record to get translation tables
    const { getControllers } = require('./routing-service');
    const fullController = getControllers().find(c => c.id === route.controllerId);

    const controller = {
      artworkRootPath:     route.artworkRootPath,
      orderLastNameFormat: route.orderLastNameFormat,
      outputPath:          route.outputPath,
      sizeTranslations:    fullController?.sizeTranslations  || [],
      mediaOptionKey:      fullController?.mediaOptionKey    || '',
      mediaTranslations:   fullController?.mediaTranslations || [],
      // Configurable photo lines — operator-defined key/value pairs inserted
      // between Orderid= and Filepath= in every per-image block. Empty/missing
      // entries are filtered out inside the emitter; passing [] is harmless.
      photoLines:          fullController?.photoLines        || [],
    };

    const destPath = await generateDarkroomProFile(dpJob, controller);

    logger.info('Job sent via Darkroom Pro (routed)', {
      jobId:      job.id,
      controller: route.controllerName,
      destPath,
      lineItems:  lineItems.length,
    });

    if (route.checkOrderStatus === false) {
      logger.info('[DarkroomPro] checkOrderStatus disabled — marking job as completed immediately', { jobId: job.id });
      await this._markCompleted(job.id);
    } else {
      await this._markInProduction(job.id);
    }

    return {
      success:    true,
      method:     'darkroompro-routed',
      sourcePath: jobFolderPath,
      destPath,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fuji JobMaker pipeline (routed)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fuji JobMaker pipeline — routed entry point.
   *
   * Mirrors `_sendViaDarkroomProRouted` but emits Fujifilm Frontier's
   * `[OrderInfo]` / `[ImageInfo]` / `[Print]` format and stages images into a
   * per-order folder under `imageStagingRoot` (Frontier reads them from there
   * via `ImagePath=`).
   *
   * v0 model: one OH job → one product mapping → one Surface → one `.txt`
   * file. Multi-surface within a single OH job is supported by the underlying
   * generator (it accepts `surfaceGroups[]`) but not exposed here yet — that's
   * a future refinement and needs to be paired with a UI for assigning
   * per-image surfaces.
   *
   * Spec: docs/print-controllers/FUJI-JOBMAKER-FORMAT.md
   *
   * @param {object} job   Job record from the OH API cache.
   * @param {object} route Resolved route from routingService:
   *   {
   *     controllerId, controllerName, controllerType: 'fujijobmaker',
   *     outputPath,                  // hot folder
   *     imageStagingRoot,            // where the per-order image folder is created
   *     printerName,                 // optional — emitted as Printer=
   *     autoCorrect,                 // null | true | false
   *     backprintMode,               // 'none' | 'text' (image deferred in v0)
   *     backprintTemplate,           // when backprintMode === 'text'
   *     checkOrderStatus,            // when false, mark completed immediately
   *   }
   */
  async _sendViaFujiJobMakerRouted(job, route) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    const manifest    = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    // ── Pull resolved channel fields off the route ─────────────────────────
    // routingService.resolveRoute() has already done the productCode+options
    // lookup and surfaced printCode / surface / surfaceCode onto the route.
    // Validation here is a belt-and-braces check in case the route was
    // hand-constructed by a caller other than routingService.
    if (!route.surface || !route.printCode) {
      const errMsg =
        `Fuji JobMaker route is missing surface or printCode for product "${job.product_code || '(none)'}". ` +
        `Add a channel mapping for this product in Settings → Routing.`;
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: errMsg });
      return { success: false, error: errMsg };
    }

    // ── Resolve image paths (enhanced → corrected → raw, same as DPOF) ─────
    const enhancedMap    = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);
    const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

    let imageFiles = jobManifest.images.map(img => {
      const basename     = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      if (enhancedPath) {
        logger.info('Using enhanced image for Fuji JobMaker print', { filename: basename, enhancedPath });
      }
      return {
        sourcePath: enhancedPath || path.join(orderFolderPath, img.filename),
        filename:   basename,
      };
    });

    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap
    );

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // ── Assemble the generator input (single surface group, v0) ────────────
    const fullName    = (job.customer_name || '').trim();
    const surface     = route.surface;
    const surfaceCode = route.surfaceCode || (surface ? surface.charAt(0).toUpperCase() : '');

    const fujiJob = {
      orderRef: job.order_number || '',
      id:       job.id,
      jobName:  job.job_name || job.order_number || '',
      dueAt:    job.due_at || null,
      customer: {
        fullName,
        email: job.customer_email || '',
        phone: job.customer_phone || '',
      },
      surfaceGroups: [{
        surface,
        surfaceCode,
        images: jobManifest.images.map((manifestImg, i) => ({
          filename:  imageFiles[i].filename,
          printCode: route.printCode,
          quantity:  manifestImg.quantity || 1,
          // backPrint is left undefined — 'image' mode is deferred in v0.
        })),
      }],
    };

    const controllerCfg = {
      imageStagingRoot:  route.imageStagingRoot,
      printerName:       route.printerName || '',
      autoCorrect:       route.autoCorrect === undefined ? null : route.autoCorrect,
      backprintMode:     route.backprintMode     || 'none',
      backprintTemplate: route.backprintTemplate || '',
    };

    // ── Generate + write ───────────────────────────────────────────────────
    let surfaceFiles;
    try {
      surfaceFiles = generateFujiJobMakerFiles(fujiJob, controllerCfg);
    } catch (genErr) {
      logger.logError('Fuji JobMaker generation failed', genErr, { jobId: job.id });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: genErr.message });
      return { success: false, error: genErr.message };
    }

    let writeResult;
    try {
      writeResult = await fujiJobMakerFileWriter.writeOrderFiles({
        hotFolderPath:    route.outputPath,
        imageStagingRoot: route.imageStagingRoot,
        orderRef:         job.order_number || '',
        imageFiles,
        surfaceFiles,
      });
    } catch (writeErr) {
      logger.logError('Fuji JobMaker write failed — staged images may remain', writeErr, {
        jobId: job.id,
        controller: route.controllerName,
      });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: writeErr.message });
      return { success: false, error: writeErr.message };
    }

    // ── Register submission(s) with the monitor for status tracking ────────
    // Must run BEFORE the operator could see the .txt go through and possibly
    // before fs.watch fires — otherwise the monitor might miss the transition.
    printControllerService.startMonitoring(route.controllerId);
    const monitor = printControllerService.getMonitor(route.controllerId);
    if (monitor && monitor.trackSubmission) {
      for (let i = 0; i < surfaceFiles.length; i++) {
        monitor.trackSubmission({
          orderRef: fujiJob.orderRef,
          surface:  fujiJob.surfaceGroups[i].surface,
          filename: surfaceFiles[i].filename,
        });
      }
    }

    logger.info('Job sent via Fuji JobMaker (routed)', {
      jobId:        job.id,
      controller:   route.controllerName,
      orderRef:     fujiJob.orderRef,
      surface,
      printCode:    route.printCode,
      files:        writeResult.writtenFiles.map(p => path.basename(p)),
      stagedImages: writeResult.copiedImages.length,
    });

    if (route.checkOrderStatus === false) {
      logger.info('[Fuji JobMaker] checkOrderStatus disabled — marking job completed immediately', { jobId: job.id });
      await this._markCompleted(job.id);
    } else {
      await this._markInProduction(job.id);
    }

    return {
      success:    true,
      method:     'fujijobmaker-routed',
      sourcePath: jobFolderPath,
      destPaths:  writeResult.writtenFiles,
      stagedFolder: writeResult.imageStagingFolder,
    };
  }

  /**
   * PDF-copy pipeline for "pdf_copy" controllers.
   *
   * Locates PDF files in the job manifest and copies them to
   * {outputPath}/{orderNumber}_{jobId}/{filename}.
   * If route.bannerSheet is true, prepends a QR-code banner page using pdf-lib.
   * Banner failures are swallowed so a banner error never blocks the job.
   */
  async _sendViaPdfCopyRouted(job, route) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    const manifest    = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    const pdfFiles = jobManifest.images
      .filter(img => path.extname(img.filename).toLowerCase() === '.pdf')
      .map(img => ({
        sourcePath: path.join(orderFolderPath, img.filename),
        filename:   path.basename(img.filename),
      }));

    if (pdfFiles.length === 0) {
      throw new Error(`No PDF files found in job ${job.id} manifest.`);
    }

    const destFolder = path.join(route.outputPath, jobFolderName);
    try {
      fs.mkdirSync(destFolder, { recursive: true });
      for (const pdfFile of pdfFiles) {
        if (!fs.existsSync(pdfFile.sourcePath)) {
          throw new Error(`PDF not found: ${pdfFile.sourcePath}`);
        }

        const pipelineConfig = route.pdfPipeline;
        if (pipelineConfig && pipelineConfig.steps && pipelineConfig.steps.length > 0) {
          // Apply the configured PDF pipeline
          const { applyPdfPipeline } = require('../../pdf-pipeline/pipeline');
          const jobContext = {
            jobNumber:    job.job_name || job.order_number || String(job.id),
            orderId:      String(job.order_id || job.id),
            qty:          job.qty || 1,
            customerName: job.customer_name || '',
          };
          let pdfBytes = await fs.promises.readFile(pdfFile.sourcePath);
          pdfBytes = await applyPdfPipeline(new Uint8Array(pdfBytes), pipelineConfig, jobContext);
          await fs.promises.writeFile(path.join(destFolder, pdfFile.filename), Buffer.from(pdfBytes));
        } else if (route.bannerSheet) {
          // Fallback: legacy banner sheet prepend (no pipeline configured)
          let finalBuffer = null;
          try {
            finalBuffer = await this._prependBannerPageToPdf(pdfFile.sourcePath, job);
          } catch (bannerErr) {
            logger.logError('PDF banner page generation failed — copying original PDF', bannerErr, { jobId: job.id });
          }
          if (finalBuffer) {
            await fs.promises.writeFile(path.join(destFolder, pdfFile.filename), finalBuffer);
          } else {
            fs.copyFileSync(pdfFile.sourcePath, path.join(destFolder, pdfFile.filename));
          }
        } else {
          fs.copyFileSync(pdfFile.sourcePath, path.join(destFolder, pdfFile.filename));
        }
      }
    } catch (writeErr) {
      logger.logError('PDF copy write failed', writeErr, { jobId: job.id, destFolder });
      return { success: false, error: writeErr.message };
    }

    logger.info('Job sent to print via PDF copy (routed)', {
      jobId:      job.id,
      controller: route.controllerName,
      destFolder,
      files:      pdfFiles.length,
    });

    await this._markCompleted(job.id);

    return {
      success:    true,
      method:     'pdf_copy',
      sourcePath: jobFolderPath,
      destPath:   destFolder,
    };
  }

  /**
   * Prepend a QR-code banner page to a PDF using pdf-lib.
   * The banner page is the same dimensions as the first page of the PDF.
   * Returns a Buffer of the merged PDF.
   */
  async _prependBannerPageToPdf(pdfPath, job) {
    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const QRCode = require('qrcode');

    const existingPdfBytes = await fs.promises.readFile(pdfPath);
    const existingPdf      = await PDFDocument.load(existingPdfBytes);
    const firstPage        = existingPdf.getPages()[0];
    const { width, height } = firstPage.getSize();

    const bannerPdf  = await PDFDocument.create();
    const bannerPage = bannerPdf.addPage([width, height]);

    const orderCode = job.job_code
      ? job.job_code.replace(/-\d+$/, '')
      : (job.order_number || '');

    const qrBuffer = await QRCode.toBuffer(orderCode || 'NO-CODE', { type: 'png', margin: 1 });
    const qrImage  = await bannerPdf.embedPng(qrBuffer);

    const qrSize = 85; // ~30mm at 72dpi
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

    return Buffer.from(await bannerPdf.save());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Frontline pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Frontline pipeline:
   * Generates an XML order file and copies all images into a job folder
   * named by job ID, placed inside the controller's hot folder path.
   * Fire-and-forget — no status monitoring required.
   */
  async _sendViaFrontlineRouted(job, route) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const jobFolderPath   = path.join(orderFolderPath, jobFolderName);

    if (!fs.existsSync(jobFolderPath)) {
      throw new Error(`Job folder not found: ${jobFolderPath}`);
    }

    const manifest    = this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    // Resolve enhanced/corrected image paths (same priority chain as DPOF / Darkroom Pro)
    const enhancedMap    = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);
    const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

    let imageFiles = (jobManifest.images || []).map(img => {
      const basename     = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      return {
        sourcePath: enhancedPath || path.join(orderFolderPath, img.filename),
        filename:   basename,
      };
    });

    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap
    );

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // Build the job object for the generator
    const frontlineJob = {
      id:            job.id,
      order_number:  job.order_number  || '',
      job_name:      job.job_name      || job.order_number || '',
      customer_name: job.customer_name || '',
      images: (jobManifest.images || []).map((img, idx) => ({
        filename:      path.basename(img.filename),
        quantity:      img.quantity || 1,
        rotationAngle: 0,
      })),
    };

    // Controller config fields carried through the route object
    const controllerConfig = {
      device:     route.device     || 'Pixfizz',
      backPrint1: route.backPrint1 || '{jobName}  {customerName}',
      backPrint2: route.backPrint2 || '{jobId}  {filename}',
    };

    const channelConfig = {
      batchCode:  route.batchCode  || '',
      sortString: route.sortString || '',
    };

    // Generate XML content
    const xmlContent = frontlineGenerator.generate(controllerConfig, channelConfig, frontlineJob);

    // Write job folder + XML + images to hot folder
    const { jobFolderPath: destFolderPath, xmlPath } = await frontlineFileWriter.writeJobFolder(
      route.outputPath,
      job.id,
      xmlContent,
      imageFiles
    );

    logger.info('Job sent to print via Frontline', {
      jobId:      job.id,
      controller: route.controllerName,
      destFolder: destFolderPath,
      xmlFile:    xmlPath,
      images:     imageFiles.length,
    });

    // Fire-and-forget — mark as completed immediately
    await this._markCompleted(job.id);

    return {
      success:    true,
      method:     'frontline',
      sourcePath: jobFolderPath,
      destPath:   destFolderPath,
    };
  }

  /**
   * File-copy pipeline (existing behaviour)
   */
  /**
   * Manual Crop redesign (2026-06-02) helper. Returns true when the
   * given bare basename matches an operator-discarded image for this
   * dispatch (set stamped on job._excludedFilenames by the IPC handler).
   * Used by file-copy paths that don't go through _findJobInManifest.
   */
  _isExcludedForDispatch(job, basename) {
    const excluded = job && job._excludedFilenames;
    if (!excluded || typeof excluded.size !== 'number' || excluded.size === 0) return false;
    return excluded.has(basename);
  }

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

    // Copy folder recursively. The optional skipBasenames set lets the
    // operator-discarded filter prune files even though this code path
    // doesn't go through _findJobInManifest.
    try {
      const excluded = (job && job._excludedFilenames) || null;
      await this._copyFolder(sourcePath, destPath, excluded);
      logger.info('Job folder copied to process folder', { jobId, dest: destPath, excludedCount: excluded ? excluded.size : 0 });
    } catch (error) {
      logger.logError('Failed to copy job folder', error, { jobId });
      throw new Error(`Failed to copy job folder: ${error.message}`);
    }

    await this._markCompleted(jobId);

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

    const found = manifest.jobs.find(j => {
      const manifestJobId = String(j.jobId);
      return manifestJobId === jobId || (internalJobId && manifestJobId === internalJobId);
    });

    // Manual Crop redesign (2026-06-02). Apply the discarded-image
    // filter exactly once, at the central manifest-lookup point. The
    // IPC handler stamps `job._excludedFilenames` (a Set<string> of bare
    // basenames) as a non-enumerable property before invoking any
    // dispatch pipeline; every subsequent jobManifest.images.map(...)
    // sees the filtered list automatically. Property-stamping keeps the
    // print-service public surface unchanged — no signature edits to
    // ripple through 10+ dispatch variants.
    if (!found) return found;
    const excluded = job && job._excludedFilenames;
    if (!excluded || typeof excluded.size !== 'number' || excluded.size === 0) return found;
    return {
      ...found,
      images: (found.images || []).filter((img) => {
        const base = path.basename(img && img.filename ? img.filename : '');
        return !excluded.has(base);
      }),
    };
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

  async _markCompleted(jobId) {
    try {
      await jobService.markCompleted(jobId);
      logger.info('Job marked as completed', { jobId });
    } catch (error) {
      logger.logWarning('Job sent but API completed status update failed', {
        jobId,
        error: error.message
      });
      jobService.updateJobLocally(jobId, { _status: 'completed' });
    }
  }

  /**
   * Build a Map of { imageBasename → enhancedAbsolutePath } for any images
   * that have been successfully enhanced via the AI Enhancement pipeline
   * (Pixfizz AI local or Topaz).
   *
   * Returns an empty Map if the sidecar cannot be loaded, or if no images
   * have been enhanced.  Callers treat an empty Map as "no substitution".
   *
   * @param {string} jobId        - API job ID (becomes sidecar filename)
   * @param {string} jobFolderPath - Absolute path to the job's root folder
   * @returns {Promise<Map<string, string>>}
   */
  async _getEnhancedPathMap(jobId, jobFolderPath) {
    try {
      const { sidecar } = await loadSidecar(jobId, jobFolderPath);
      const map = new Map();
      for (const img of (sidecar.images || [])) {
        // croppedPath takes highest priority — user explicitly cropped this image.
        if (img.cropApplied && img.croppedPath && fs.existsSync(img.croppedPath)) {
          map.set(img.filename, img.croppedPath);
        } else if (img.enhanced && img.enhancedPath && fs.existsSync(img.enhancedPath)) {
          map.set(img.filename, img.enhancedPath);
        }
      }
      return map;
    } catch (_) {
      // No sidecar or load error — proceed without substitution
      return new Map();
    }
  }

  /**
   * Build a Map of { imageBasename → corrections } from the job sidecar.
   * Returns an empty Map if the sidecar cannot be loaded or has no corrections.
   *
   * @param {string} sidecarId      - Sidecar filename stem (e.g. "PXDEMO-R9F091_38348645")
   * @param {string} jobFolderPath  - Absolute path to the job's root folder
   * @returns {Promise<Map<string, {cyan:number, magenta:number, yellow:number}>>}
   */
  async _getCorrectionsMap(sidecarId, jobFolderPath) {
    try {
      const { sidecar } = await loadSidecar(sidecarId, jobFolderPath);
      const map = new Map();
      for (const img of (sidecar.images || [])) {
        if (img.corrections) {
          map.set(img.filename, img.corrections);
        }
      }
      return map;
    } catch (_) {
      // No sidecar or unreadable — proceed without corrections.
      return new Map();
    }
  }

  /**
   * Apply CMY colour corrections to a set of imageFiles using Sharp.
   *
   * For each image that has non-zero corrections a corrected JPEG is written to
   * workingPath as "{basename}_corrected.jpg" and its sourcePath is substituted.
   * Images with all-zero corrections pass through unchanged.
   *
   * CMY scale: each unit ≈ 2/255 per channel.
   *   Cyan    +N  →  red   channel × (1 − N·2/255)
   *   Magenta +N  →  green channel × (1 − N·2/255)
   *   Yellow  +N  →  blue  channel × (1 − N·2/255)
   *
   * Degrades gracefully if Sharp is not installed (logs a warning, returns originals).
   *
   * @param {Array<{sourcePath:string, filename:string}>} imageFiles
   * @param {string} workingPath  - Folder where corrected files are written
   * @param {Map<string, {cyan?:number, magenta?:number, yellow?:number}>} correctionsMap
   * @returns {Promise<Array<{sourcePath:string, filename:string}>>}
   */
  async _applyCorrectionsToImageFiles(imageFiles, workingPath, correctionsMap) {
    let sharp;
    try {
      sharp = require('sharp');
    } catch (e) {
      logger.logWarning('sharp not installed — CMY corrections skipped. Run: npm install sharp', { error: e.message });
      return imageFiles;
    }

    await fs.promises.mkdir(workingPath, { recursive: true });

    // Diagnostic: log correction map keys vs imageFile filenames so filename
    // mismatches can be spotted in the Winston log.
    logger.info('CMY corrections lookup', {
      imageFilenames:    imageFiles.map(f => f.filename),
      correctionMapKeys: Array.from(correctionsMap.keys()),
    });

    const result = [];
    for (const img of imageFiles) {
      const corrections = correctionsMap.get(img.filename) || {};
      const cyan    = corrections.cyan    || 0;
      const magenta = corrections.magenta || 0;
      const yellow  = corrections.yellow  || 0;

      if (cyan === 0 && magenta === 0 && yellow === 0) {
        result.push(img);
        continue;
      }

      // Positive CMY reduces the complementary RGB channel.
      const redFactor   = Math.max(0, Math.min(2, 1 - (cyan    * 2 / 255)));
      const greenFactor = Math.max(0, Math.min(2, 1 - (magenta * 2 / 255)));
      const blueFactor  = Math.max(0, Math.min(2, 1 - (yellow  * 2 / 255)));

      const ext  = path.extname(img.filename);
      const base = path.basename(img.filename, ext);
      const correctedPath = path.join(workingPath, `${base}_corrected.jpg`);

      await sharp(img.sourcePath)
        .recomb([
          [redFactor,   0,           0          ],
          [0,           greenFactor, 0          ],
          [0,           0,           blueFactor ],
        ])
        .jpeg({ quality: 95 })
        .toFile(correctedPath);

      logger.info('CMY correction applied', {
        filename:    img.filename,
        corrections: { cyan, magenta, yellow },
        factors:     { redFactor, greenFactor, blueFactor },
        output:      correctedPath,
      });

      result.push({ sourcePath: correctedPath, filename: img.filename });
    }

    return result;
  }

  /**
   * Recursively copy a folder
   */
  async _copyFolder(src, dest, excludedBasenames = null) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      // Manual Crop redesign (2026-06-02). Skip files whose basename
      // matches an operator-discarded image. Comparison is at any
      // recursion depth — discarded files in /working/, /originals/,
      // and the flat job root all get filtered. Directories themselves
      // are never matched (they're folder names, not image filenames).
      if (excludedBasenames
          && excludedBasenames.size > 0
          && !entry.isDirectory()
          && excludedBasenames.has(entry.name)) {
        continue;
      }
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this._copyFolder(srcPath, destPath, excludedBasenames);
      } else {
        fs.copyFileSync(srcPath, destPath);
        const stat = fs.statSync(srcPath);
        fs.utimesSync(destPath, stat.atime, stat.mtime);
      }
    }
  }
}

module.exports = new PrintService();
