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
const { splitIntoBatches, batchPrintCount } = require('../../shared/batchSplit');
const { frontlineGenerator } = require('./frontline-generator');
const { frontlineFileWriter } = require('./frontline-file-writer');
const { generateFujiJobMakerFiles } = require('./fuji-jobmaker-generator');
const { fujiJobMakerFileWriter } = require('./fuji-jobmaker-file-writer');
const { generateFujiPicProOrderFile } = require('./fuji-pic-pro-generator');
const fujiPicProFileWriter = require('./fuji-pic-pro-file-writer');
const { printControllerService } = require('./print-controller-service');
const { resolvePrintSizeCode } = require('./routing-service');
const { isDpofType } = require('./controller-types');
const { ManifestNotFoundError } = require('./awaiting-manifest');
const { resolveManifestPath } = require('./manifest-path');
const { resolveDispatchImageSource } = require('./dispatch-image-source');
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
    const manifest = await this._readManifest(orderFolderPath, job.order_number);
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
      const absoluteFilepath = resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath });

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
    if (route.controllerType === 'fujipicpro') {
      return this._sendViaFujiPicProRouted(job, route);
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

    const manifest = await this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest. Manifest has ${manifest.jobs ? manifest.jobs.length : 0} jobs.`);
    }

    if (!route.printSizeCode || String(route.printSizeCode).trim() === '') {
      throw new Error(
        `No print size configured for product "${job.product_code || '(none)'}". ` +
        `Set the Print Size Code on this product's channel mapping in Settings → Routing.`
      );
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
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
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
      jobId:          job.id,
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
    const manifest = await this._readManifest(orderFolderPath, job.order_number);
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
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
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

    // Derive printSizeCode — wraps bare W×H sizes as NML -PSIZE, passes
    // standard codes through. See routing-service.resolvePrintSizeCode.
    const printSizeCode = resolvePrintSizeCode(mapping);

    // Generate DPOF content
    const dpofContent = dpofGenerator.generate({
      orderNumber:    job.order_number || manifest.orderNumber || '',
      jobId:          job.id,
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
   *   o38461218_PXDEMO-DR2PE0-1_r1_4x6 Photo Print_lustre_full-bleed
   *
   * @param {object}   parentJob       - Parent API job object (job_name, product, options, …)
   * @param {string}   reprintJobPath  - Absolute path to the reprint job folder
   * @param {string}   reprintSuffix   - e.g. 'r1', 'r2'
   * @param {Array}    reprintImages   - Array from reprint sidecar.images ({ filename, qtyCurrent })
   * @returns {Promise<{ success: boolean, folderName?: string, error?: string }>}
   */
  async _sendReprintViaDPOF(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    // Defensive assertion — sendReprint already routes Darkroom Pro to its
    // own pipeline, but if a future caller wires this method up directly
    // we want loud failure rather than wrong-pipeline dispatch.
    if (route && route.controllerType === 'darkroompro') {
      return {
        success: false,
        error: 'Darkroom Pro reprints must go through sendReprint() — _sendReprintViaDPOF received a Darkroom Pro route.'
      };
    }

    // Route validation — the legacy `controller.isActive` / "controller not
    // found" / "no product mapping" guards collapse into one check now,
    // because resolveRoute only returns type:'controller' with all four
    // dispatch fields when the controller AND its channel mapping resolved
    // cleanly. A missing outputPath or channelNumber here means routing-
    // service handed us a malformed route — surface it instead of crashing
    // deep in orderFolderWriter / dpofGenerator.
    if (!route || !route.outputPath || route.channelNumber == null) {
      return {
        success: false,
        error: `Reprint route missing required fields (outputPath: ${route && route.outputPath ? 'ok' : 'missing'}, channelNumber: ${route && route.channelNumber != null ? 'ok' : 'missing'}). Check Settings → Routing for the parent job's process and product.`
      };
    }

    // Print-size guard — mirrors the first-send guard at :253-258. Pre-M1
    // (missing-print-size-recovery-brief.md) this method went straight to
    // dpofGenerator.generate with whatever route.printSizeCode was; a blank
    // wrote a literal `PRT PSL=` line into the AUTPRINT.MRK and OHD
    // reported success. Same operator-facing message shape as first send
    // so the fix (Settings → Routing) is unambiguous whether the failure
    // hit on first dispatch or on reprint. Returns the {success:false}
    // reprint contract; ohd:reprint:create wraps this into a
    // "folder created but dispatch failed" surface for the renderer.
    if (!route.printSizeCode || String(route.printSizeCode).trim() === '') {
      return {
        success: false,
        error:
          `No print size configured for product "${parentJob.product_code || '(none)'}". ` +
          `Set the Print Size Code on this product's channel mapping in Settings → Routing.`
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

    // Generate DPOF content. All controller/channel inputs come from the
    // resolved route — channelNumber and printSizeCode were derived by
    // routing-service.resolveRoute via the same Layer-3 channelMappings
    // lookup the normal sendViaDPOFRouted relies on (see
    // routing-service.js:413-427 for the route shape).
    const dpofContent = dpofGenerator.generate({
      orderNumber:    parentJob.order_number  || '',
      jobId:          parentJob.id,
      customerName:   parentJob.customer_name || '',
      channelNumber:  route.channelNumber,
      printSizeCode:  route.printSizeCode,
      images:         lineItems.map(li => ({ filename: li.filename, quantity: li.quantity })),
      controllerType: route.controllerType || 'noritsu',
    });

    // Folder-name options sourced from the route. Default on for back-compat
    // — route.includeCustomerInFolder is `controller.includeCustomerInFolder
    // !== false` per routing-service, so an undefined here also means "on".
    const nameOpts = {
      includeCustomerName: route.includeCustomerInFolder !== false,
      customerName:        parentJob.customer_name || '',
    };

    // Write to hot folder using prefix-swap pattern (p → o on success)
    let writeResult;
    try {
      writeResult = await orderFolderWriter.writeOrderFolder(
        route.outputPath,
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
      controller:   route.controllerName,
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
    if (route.controllerType === 'fujijobmaker') {
      return this._sendReprintViaFujiJobMaker(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
    }
    if (route.controllerType === 'fujipicpro') {
      return this._sendReprintViaFujiPicPro(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
    }
    if (route.controllerType === 'pdf_copy') {
      return this._sendReprintViaPdfCopy(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
    }
    if (route.controllerType === 'frontline') {
      return this._sendReprintViaFrontline(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
    }
    // DPOF path covers noritsu / epson / legacy 'dpof' / unspecified —
    // see services/controller-types.js for the canonical set. The narrow
    // `=== 'dpof'` check that lived here previously was the v1.7.11
    // Noritsu reprint bug. _sendReprintViaDPOF takes the route directly
    // (no internal re-resolution via legacy stores) so routing-service-
    // only process mappings + routing-hold release on the parent are
    // honoured automatically.
    if (isDpofType(route.controllerType)) {
      return this._sendReprintViaDPOF(parentJob, route, reprintJobPath, reprintSuffix, reprintImages);
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
        // From the reprint sidecar entry — stable across reprints/re-crops, so
        // {originalFilename} shows the customer's true original even though the
        // dispatched file comes from /originals/ or /working/.
        originalFilename: img.originalFilename || null,
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

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint — Fuji JobMaker pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a built reprint job to a Fuji JobMaker controller.
   *
   * Mirrors `_sendViaFujiJobMakerRouted` with the standard reprint-family
   * adaptations:
   *
   *   1. Images come from `{reprintJobPath}/originals/` (the clean copies
   *      reprintManager produced). No manifest — the reprint sidecar's
   *      `images` array is the source of truth for which files print and
   *      at what qty. CMY corrections from the reprint sidecar are
   *      re-applied to `{reprintJobPath}/working/` via
   *      `_applyCorrectionsToImageFiles` (Fuji is JPEG-based; corrections
   *      matter — same as DPOF / Darkroom Pro).
   *   2. The orderRef passed to the file writer is
   *      `${parentJob.order_number}-${reprintSuffix}` so the writer
   *      derives reprint-suffixed surface filenames
   *      (`{orderRef}-r1_Lustre.txt`) AND a reprint-suffixed staging
   *      folder (`{imageStagingRoot}\{orderRef}-r1\`) — neither collides
   *      with the parent's outputs in the same hot folder.
   *   3. Parent OH lifecycle is left untouched — no `_markInProduction` /
   *      `_markCompleted`. Reprint is a sibling job.
   *   4. The Fuji monitor is NOT registered for the reprint surface files.
   *      The monitor's accept/timed-out callback feeds into the parent's
   *      `jobStore.updateJobStatus` (via print-controller-service's
   *      `onFujiStatus` wrapper). If the reprint were tracked, its
   *      acceptance would mutate the parent's status — incorrect. The
   *      reprint folder/files are still on disk for the operator to
   *      inspect; status feedback for the reprint specifically is out of
   *      scope (parity with the DPOF + Darkroom Pro reprint methods,
   *      which also bypass monitoring).
   *   5. No AI Quality scoring / Hold-for-review / auto-print gates — the
   *      operator reviewed before triggering the reprint.
   *
   * Route validation: outputPath, imageStagingRoot, surface, and printCode
   * must all be present. Routing-service's Layer-3 channel-mapping lookup
   * populates surface/surfaceCode/printCode from the parent's
   * productCode+options on the target controller, so a missing field here
   * means the route was hand-constructed or the parent's product has no
   * mapping on this controller. Surface a clean error instead of crashing
   * inside `generateFujiJobMakerFiles`.
   *
   * @param {object} parentJob       - Parent API job (from job-service cache)
   * @param {object} route           - Pre-resolved route ({ controllerId, outputPath, imageStagingRoot, surface, surfaceCode, printCode, printerName, autoCorrect, backprintMode, backprintTemplate, controllerName, … })
   * @param {string} reprintJobPath  - Absolute path to the reprint job folder
   * @param {string} reprintSuffix   - 'r1', 'r2', …
   * @param {Array}  reprintImages   - Array from reprint sidecar.images ({ filename, qtyCurrent, corrections })
   * @returns {Promise<{success:boolean, method?:string, destPaths?:string[], stagedFolder?:string, error?:string}>}
   */
  async _sendReprintViaFujiJobMaker(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    if (!Array.isArray(reprintImages) || reprintImages.length === 0) {
      return { success: false, error: 'Reprint has no images to send.' };
    }

    // Route validation — collapses the legacy "controller not found" /
    // "controller not active" / "no channel mapping" branches into one
    // shape-check on the route. routing-service.resolveRoute only returns
    // a fully-populated fujijobmaker route when the controller exists
    // AND the channel mapping for productCode+options resolved cleanly.
    if (!route || !route.outputPath || !route.imageStagingRoot || !route.surface || !route.printCode) {
      const missing = [
        !route || !route.outputPath        ? 'outputPath'        : null,
        !route || !route.imageStagingRoot  ? 'imageStagingRoot'  : null,
        !route || !route.surface           ? 'surface'           : null,
        !route || !route.printCode         ? 'printCode'         : null,
      ].filter(Boolean).join(', ');
      return {
        success: false,
        error: `Fuji JobMaker reprint route missing required fields (${missing}). Add a channel mapping for the parent's product on this controller in Settings → Routing.`,
      };
    }

    const originalsPath = path.join(reprintJobPath, 'originals');
    const workingPath   = path.join(reprintJobPath, 'working');

    // Source = /originals/. No manifest, no enhanced-path lookup —
    // matches the DPOF + Darkroom Pro reprint methods.
    let imageFiles = reprintImages.map(img => ({
      sourcePath: path.join(originalsPath, img.filename),
      filename:   img.filename,
    }));

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        return {
          success: false,
          error: `Reprint image not found on disk: ${img.sourcePath}`,
        };
      }
    }

    // Re-apply CMY corrections from the reprint sidecar to /working/.
    const correctionsMap = new Map(
      reprintImages.map(img => [img.filename, img.corrections || {}])
    );
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      workingPath,
      correctionsMap,
    );

    // Reprint-suffixed orderRef drives the writer's filenames + staging
    // folder. Parent: orderRef='PXDEMO-XYZ' → file 'PXDEMO-XYZ_Lustre.txt'
    // + staging 'imageStagingRoot\PXDEMO-XYZ-1\'. Reprint: orderRef
    // 'PXDEMO-XYZ-1-r1' → 'PXDEMO-XYZ-1-r1_Lustre.txt' +
    // 'imageStagingRoot\PXDEMO-XYZ-1-r1\'. No collision.
    // Base on the Job No (job_name, e.g. ORD-O4YK5Z-1), matching the normal send.
    const reprintOrderRef = `${parentJob.job_name || parentJob.order_number || ''}-${reprintSuffix}`;

    const fullName = (parentJob.customer_name || '').trim();
    const surface     = route.surface;
    const surfaceCode = route.surfaceCode || (surface ? surface.charAt(0).toUpperCase() : '');

    const fujiJob = {
      orderRef: reprintOrderRef,
      id:       parentJob.id,
      jobName:  parentJob.job_name || parentJob.order_number || '',
      dueAt:    parentJob.due_at || null,
      customer: {
        fullName,
        email: parentJob.customer_email || '',
        phone: parentJob.customer_phone || '',
      },
      surfaceGroups: [{
        surface,
        surfaceCode,
        images: reprintImages.map((img, i) => ({
          filename:  imageFiles[i].filename,
          printCode: route.printCode,
          quantity:  img.qtyCurrent || 1,
          // From the reprint sidecar entry — stable across reprints/re-crops,
          // so {originalFilename} shows the customer's true original.
          originalFilename: img.originalFilename || null,
          // backPrint deliberately undefined — 'image' mode is deferred
          // in v0, matching the normal-send path.
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

    let surfaceFiles;
    try {
      surfaceFiles = generateFujiJobMakerFiles(fujiJob, controllerCfg);
    } catch (genErr) {
      logger.logError('Fuji JobMaker reprint generation failed', genErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
      });
      return { success: false, error: genErr.message };
    }

    let writeResult;
    try {
      writeResult = await fujiJobMakerFileWriter.writeOrderFiles({
        hotFolderPath:    route.outputPath,
        imageStagingRoot: route.imageStagingRoot,
        orderRef:         reprintOrderRef,
        imageFiles,
        surfaceFiles,
      });
    } catch (writeErr) {
      logger.logError('Fuji JobMaker reprint write failed — staged images may remain', writeErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
      });
      return { success: false, error: writeErr.message };
    }

    // Intentionally NO printControllerService.startMonitoring + NO
    // monitor.trackSubmission — see method docstring point 4.
    // Intentionally NO _markInProduction / _markCompleted — parent
    // lifecycle untouched.

    logger.info('Reprint sent via Fuji JobMaker', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      controller:   route.controllerName,
      orderRef:     reprintOrderRef,
      surface,
      printCode:    route.printCode,
      files:        writeResult.writtenFiles.map(p => path.basename(p)),
      stagedImages: writeResult.copiedImages.length,
    });

    return {
      success:      true,
      method:       'fujijobmaker-reprint',
      destPaths:    writeResult.writtenFiles,
      stagedFolder: writeResult.imageStagingFolder,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint — Fuji PIC Pro pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fuji PIC Pro reprint.
   *
   * Follows the same posture as the other reprint methods:
   *   1. Source images from {reprintJobPath}/originals/ — CLAUDE.md
   *      landmine "Reprints must source from `{job}/originals/`, never
   *      /working/". No manifest, no enhanced-path lookup, no
   *      resolveDispatchImageSource.
   *   2. CMY corrections from the reprint sidecar are re-applied to
   *      /working/ before staging.
   *   3. orderId = `{parentJobName}-{reprintSuffix}` — creates a
   *      fresh PIC Pro order. We do NOT use PIC Pro's native
   *      `[restart]` command because that reprints the ORIGINAL
   *      order untouched, and OHD reprints are typically a subset of
   *      images with possibly re-cropped versions.
   *   4. Enqueue with the monitor so the DIGIN move + optional
   *      release still happen — BUT do not mark completed / in
   *      production. Parent job's lifecycle stays untouched; the
   *      reprint is a sibling concept, matching every other reprint
   *      method.
   */
  async _sendReprintViaFujiPicPro(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    if (!Array.isArray(reprintImages) || reprintImages.length === 0) {
      return { success: false, error: 'Reprint has no images to send.' };
    }

    if (!route || !route.orderDataPath || !route.diginPath || !route.imageStagingRoot || !route.printCode) {
      const missing = [
        !route || !route.orderDataPath     ? 'orderDataPath'    : null,
        !route || !route.diginPath         ? 'diginPath'        : null,
        !route || !route.imageStagingRoot  ? 'imageStagingRoot' : null,
        !route || !route.printCode         ? 'printCode'        : null,
      ].filter(Boolean).join(', ');
      return {
        success: false,
        error: `Fuji PIC Pro reprint route missing required fields (${missing}). Add a channel mapping for the parent's product on this controller in Settings → Routing.`,
      };
    }

    const originalsPath = path.join(reprintJobPath, 'originals');
    const workingPath   = path.join(reprintJobPath, 'working');

    let imageFiles = reprintImages.map(img => ({
      sourcePath: path.join(originalsPath, img.filename),
      filename:   img.filename,
      // NOTE: `_applyCorrectionsToImageFiles` drops every non-
      // {sourcePath,filename} field whenever a CMY correction fires.
      // originalFilename + qtyCurrent are therefore read straight
      // from reprintImages[i] downstream — same fix as the send path.
    }));

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        return {
          success: false,
          error: `Reprint image not found on disk: ${img.sourcePath}`,
        };
      }
    }

    const correctionsMap = new Map(
      reprintImages.map(img => [img.filename, img.corrections || {}])
    );
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      workingPath,
      correctionsMap,
    );

    // Reprint-suffixed orderId — the parent's job_name plus -r{n},
    // matching the JobMaker reprint's shape so both Fuji types
    // produce recognisably-siblings filenames in Order Data.
    const reprintOrderId = `${parentJob.job_name || parentJob.order_number || ''}-${reprintSuffix}`;

    let stageResult;
    try {
      stageResult = await fujiPicProFileWriter.stageImages({
        imageStagingRoot: route.imageStagingRoot,
        orderId:          reprintOrderId,
        imageFiles: imageFiles.map((img, i) => ({
          sourcePath:       img.sourcePath,
          originalFilename: reprintImages[i].originalFilename || null,
        })),
      });
    } catch (stageErr) {
      logger.logError('Fuji PIC Pro reprint staging failed', stageErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
      });
      return { success: false, error: stageErr.message };
    }

    const fullName = (parentJob.customer_name || '').trim();
    const picProJob = {
      orderId: reprintOrderId,
      id:      parentJob.id,
      jobName: reprintOrderId,
      customer: {
        fullName,
        email: parentJob.customer_email || '',
        phone: parentJob.customer_phone || '',
      },
      images: stageResult.negNumberMap.map((staged, i) => ({
        negNumber:        staged.negNumber,
        printCode:        route.printCode,
        // Read from reprintImages, not imageFiles — see the send-path
        // note about `_applyCorrectionsToImageFiles` stripping fields
        // whenever a CMY correction runs.
        quantity:         reprintImages[i].qtyCurrent || 1,
        color:            route.color || 'C',
        originalFilename: reprintImages[i].originalFilename || staged.originalFilename || '',
        filename:         staged.stagedName,
      })),
    };

    const controllerCfg = {
      backprintMode:       route.backprintMode      || 'none',
      backprintTemplate:   route.backprintTemplate  || '',
      backprintTemplate2:  route.backprintTemplate2 || '',
      includeCustomerName: route.includeCustomerName === true,
    };

    let orderFile;
    try {
      orderFile = generateFujiPicProOrderFile(picProJob, controllerCfg);
    } catch (genErr) {
      logger.logError('Fuji PIC Pro reprint generation failed', genErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
      });
      return { success: false, error: genErr.message };
    }

    // Reprints DO need the monitor — the DIGIN move + optional
    // [release] don't happen without it. But we do NOT
    // _markCompleted / _markInProduction; parent lifecycle untouched,
    // same posture as the JobMaker reprint.
    //
    // Fix 11 pattern applies here too: enqueue → write → markCommitted
    // so a crash in the window doesn't orphan a .txt that PIC Pro
    // consumed with no DIGIN follow-through.
    printControllerService.startMonitoring(route.controllerId);
    const monitor = printControllerService.getMonitor(route.controllerId);
    if (!monitor || typeof monitor.enqueueSubmission !== 'function') {
      const msg = `Fuji PIC Pro monitor unavailable for controller ${route.controllerId} — refusing to dispatch reprint.`;
      logger.logError(msg, new Error('no-monitor'), {
        parentJobId: parentJob.id, reprintSuffix, orderId: reprintOrderId,
      });
      return { success: false, error: msg };
    }

    try {
      monitor.enqueueSubmission({
        orderRef:            reprintOrderId,
        orderId:             reprintOrderId,
        stagingFolder:       stageResult.stagingFolder,
        controllerId:        route.controllerId,
        orderDataPath:       route.orderDataPath,
        diginPath:           route.diginPath,
        mergeDataPath:       route.mergeDataPath || '',
        gatewayTimeoutMs:    route.gatewayTimeoutMs,
        buildTimeoutMs:      route.buildTimeoutMs,
        sendReleaseCommand:  route.sendReleaseCommand === true,
      });
    } catch (enqueueErr) {
      logger.logError('Fuji PIC Pro reprint enqueue failed — refusing to write .txt', enqueueErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
        orderId:      reprintOrderId,
        code:         enqueueErr && enqueueErr.code,
      });
      return { success: false, error: enqueueErr.message };
    }

    let writtenPath;
    try {
      ({ writtenPath } = await fujiPicProFileWriter.writeOrderFile({
        orderDataPath: route.orderDataPath,
        filename:      orderFile.filename,
        contents:      orderFile.contents,
      }));
    } catch (writeErr) {
      try { monitor.dequeue(reprintOrderId); } catch (_) { /* best-effort */ }
      logger.logError('Fuji PIC Pro reprint write failed — staged images may remain', writeErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
      });
      return { success: false, error: writeErr.message };
    }

    monitor.markCommitted(reprintOrderId);

    logger.info('Reprint sent via Fuji PIC Pro — enqueued for OrderGateway handshake', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      controller:   route.controllerName,
      orderId:      reprintOrderId,
      printCode:    route.printCode,
      orderFile:    writtenPath,
      stagedImages: stageResult.negNumberMap.length,
    });

    return {
      success:       true,
      method:        'fujipicpro-reprint',
      orderFilePath: writtenPath,
      stagedFolder:  stageResult.stagingFolder,
      negNumberMap:  stageResult.negNumberMap.map(e => ({
        negNumber:        e.negNumber,
        stagedName:       e.stagedName,
        originalFilename: e.originalFilename,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint — PDF-copy pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a built reprint job to a "pdf_copy" controller.
   *
   * Mirrors `_sendViaPdfCopyRouted` with the standard reprint-family
   * adaptations:
   *
   *   1. PDFs come from `{reprintJobPath}/originals/`, listing the .pdf
   *      files referenced in the reprint sidecar's `images` array. No
   *      manifest is consulted. PDFs are NOT subject to CMY corrections
   *      (they're document/vector-based, not pixel-graded), so the
   *      `_applyCorrectionsToImageFiles` helper is intentionally skipped
   *      — distinct from the DPOF / Darkroom Pro / Fuji reprints.
   *   2. Destination folder = the reprint folder's own name
   *      (`{path.basename(reprintJobPath)}` → `…_{id}-r{n}`), matching
   *      `_sendReprintViaFolderCopy`'s naming so the reprint output
   *      can't collide with the parent's `…_{id}` folder in the
   *      controller output.
   *   3. PDF pipeline + banner-sheet fallback branches mirror the normal
   *      path verbatim, with `jobContext` derived from `parentJob` so
   *      QR / job-number overlays render against the parent's identity
   *      (the reprint inherits the parent's order context — the
   *      operator-visible label on a re-printed PDF should still read
   *      as the original job).
   *   4. No `_markCompleted` / monitor / AI-quality / hold gates —
   *      parent OH lifecycle untouched; operator already reviewed.
   *
   * Route validation: outputPath must be present. (The legacy "no
   * controller" / "controller inactive" / "no channel mapping" failure
   * modes don't apply to pdf_copy — routing-service skips Layer 3 for
   * pdf_copy controllers at routing-service.js:228-241.)
   *
   * @param {object} parentJob       - Parent API job (from job-service cache)
   * @param {object} route           - Pre-resolved route ({ controllerType:'pdf_copy', controllerName, outputPath, pdfPipeline, bannerSheet, … })
   * @param {string} reprintJobPath  - Absolute path to the reprint job folder
   * @param {string} reprintSuffix   - 'r1', 'r2', …
   * @param {Array}  reprintImages   - Array from reprint sidecar.images ({ filename, qtyCurrent, corrections })
   * @returns {Promise<{success:boolean, method?:string, destPath?:string, error?:string}>}
   */
  async _sendReprintViaPdfCopy(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    if (!Array.isArray(reprintImages) || reprintImages.length === 0) {
      return { success: false, error: 'Reprint has no images to send.' };
    }

    if (!route || !route.outputPath) {
      return {
        success: false,
        error: 'PDF-copy reprint route missing required field (outputPath). Check Settings → Routing for the parent job\'s process.',
      };
    }

    // Filter sidecar entries down to PDFs. Reprint folders for pdf_copy
    // controllers should only ever contain PDFs, but the sidecar shape is
    // shared with image jobs — guard explicitly so a mixed sidecar (which
    // shouldn't happen but isn't impossible) doesn't silently include
    // non-PDF entries.
    const originalsPath = path.join(reprintJobPath, 'originals');
    const pdfFiles = reprintImages
      .filter(img => path.extname(img.filename).toLowerCase() === '.pdf')
      .map(img => ({
        sourcePath: path.join(originalsPath, img.filename),
        filename:   path.basename(img.filename),
      }));

    if (pdfFiles.length === 0) {
      return { success: false, error: 'Reprint has no PDF files to send (reprint sidecar contains no .pdf entries).' };
    }

    // Destination folder name = reprint folder's own basename so it can't
    // collide with the parent's …_{id} folder in the controller output.
    const reprintFolderName = path.basename(reprintJobPath);
    const destFolder        = path.join(route.outputPath, reprintFolderName);

    // jobContext drives PDF-pipeline overlays (QR, job-number stamp,
    // etc.). Sourced from parentJob — the reprint inherits parent
    // identity so the printed overlay reads as the original job.
    // Matches _sendViaPdfCopyRouted's shape verbatim.
    const jobContext = {
      jobNumber:    parentJob.job_name || parentJob.order_number || String(parentJob.id),
      orderId:      String(parentJob.order_id || parentJob.id),
      qty:          parentJob.qty || 1,
      customerName: parentJob.customer_name || '',
    };

    try {
      fs.mkdirSync(destFolder, { recursive: true });
      for (const pdfFile of pdfFiles) {
        if (!fs.existsSync(pdfFile.sourcePath)) {
          throw new Error(`Reprint PDF not found on disk: ${pdfFile.sourcePath}`);
        }

        const pipelineConfig = route.pdfPipeline;
        if (pipelineConfig && pipelineConfig.steps && pipelineConfig.steps.length > 0) {
          // Configured pipeline takes precedence over the legacy banner
          // fallback — same precedence as the normal-send path.
          const { applyPdfPipeline } = require('../../pdf-pipeline/pipeline');
          let pdfBytes = await fs.promises.readFile(pdfFile.sourcePath);
          pdfBytes = await applyPdfPipeline(new Uint8Array(pdfBytes), pipelineConfig, jobContext);
          await fs.promises.writeFile(path.join(destFolder, pdfFile.filename), Buffer.from(pdfBytes));
        } else if (route.bannerSheet) {
          // Legacy banner-prepend fallback when no pipeline configured.
          let finalBuffer = null;
          try {
            finalBuffer = await this._prependBannerPageToPdf(pdfFile.sourcePath, parentJob);
          } catch (bannerErr) {
            logger.logError('PDF reprint banner page generation failed — copying original PDF', bannerErr, {
              parentJobId: parentJob.id,
              reprintSuffix,
            });
          }
          if (finalBuffer) {
            await fs.promises.writeFile(path.join(destFolder, pdfFile.filename), finalBuffer);
          } else {
            fs.copyFileSync(pdfFile.sourcePath, path.join(destFolder, pdfFile.filename));
          }
        } else {
          // Plain copy — no pipeline, no banner.
          fs.copyFileSync(pdfFile.sourcePath, path.join(destFolder, pdfFile.filename));
        }
      }
    } catch (writeErr) {
      logger.logError('PDF reprint copy write failed', writeErr, {
        parentJobId: parentJob.id,
        reprintSuffix,
        destFolder,
      });
      return { success: false, error: writeErr.message };
    }

    // Intentionally NO _markCompleted — parent lifecycle untouched.

    logger.info('Reprint sent via PDF copy', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      controller:   route.controllerName,
      destFolder,
      files:        pdfFiles.length,
    });

    return {
      success:  true,
      method:   'pdf_copy-reprint',
      destPath: destFolder,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reprint — Frontline pipeline
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a built reprint job to a Frontline controller.
   *
   * Mirrors `_sendViaFrontlineRouted` with the standard reprint-family
   * adaptations:
   *
   *   1. Images come from `{reprintJobPath}/originals/` (the clean copies
   *      reprintManager produced). No manifest is consulted — the reprint
   *      sidecar's `images` array is the source of truth for which files
   *      print and at what quantity. CMY corrections from the reprint
   *      sidecar are re-applied to `{reprintJobPath}/working/` via
   *      `_applyCorrectionsToImageFiles` (Frontline is JPEG-based; same
   *      pattern as DPOF / Darkroom Pro / Fuji).
   *   2. The `id` passed to the generator (and written into the XML's
   *      `<customerID>` per frontline-generator's docstring) AND to the
   *      file writer (which drives the folder name + XML filename) is
   *      `${parentJob.id}-${reprintSuffix}` — e.g. `38461218-r1`. This
   *      gives a reprint-suffixed `{outputPath}\{jobId}-r1\` folder and
   *      `{jobId}-r1.xml` file, neither colliding with the parent's
   *      `{outputPath}\{jobId}\` + `{jobId}.xml`. Frontline's print queue
   *      dedupes on customerID, so the suffixed id also stops the queue
   *      from rejecting the reprint as a duplicate of the parent.
   *   3. job_name carries the reprint suffix too so operator-facing
   *      log lines + backPrint placeholders ({jobName}) read as a
   *      distinct reprint rather than the parent.
   *   4. Parent OH lifecycle untouched — no `_markCompleted`. Reprint is
   *      a sibling job.
   *   5. No monitor registration (Frontline has no status-feedback
   *      mechanism — normal-send is fire-and-forget too).
   *   6. No AI Quality / Hold-for-review / auto-print gates.
   *
   * Route validation: outputPath, batchCode, and sortString must all be
   * present. The latter two come from routing-service's Layer-3 channel-
   * mapping lookup against the parent's productCode+options on the
   * target controller; a missing field means the channel mapping isn't
   * configured. Surface a clean error instead of generating a malformed
   * XML.
   *
   * @param {object} parentJob       - Parent API job (from job-service cache)
   * @param {object} route           - Pre-resolved route ({ controllerId, outputPath, device, backPrint1, backPrint2, batchCode, sortString, controllerName, … })
   * @param {string} reprintJobPath  - Absolute path to the reprint job folder
   * @param {string} reprintSuffix   - 'r1', 'r2', …
   * @param {Array}  reprintImages   - Array from reprint sidecar.images ({ filename, qtyCurrent, corrections })
   * @returns {Promise<{success:boolean, method?:string, destPath?:string, error?:string}>}
   */
  async _sendReprintViaFrontline(parentJob, route, reprintJobPath, reprintSuffix, reprintImages) {
    if (!Array.isArray(reprintImages) || reprintImages.length === 0) {
      return { success: false, error: 'Reprint has no images to send.' };
    }

    if (!route || !route.outputPath || !route.batchCode || !route.sortString) {
      const missing = [
        !route || !route.outputPath  ? 'outputPath'  : null,
        !route || !route.batchCode   ? 'batchCode'   : null,
        !route || !route.sortString  ? 'sortString'  : null,
      ].filter(Boolean).join(', ');
      return {
        success: false,
        error: `Frontline reprint route missing required fields (${missing}). Add a channel mapping for the parent's product on this controller in Settings → Routing.`,
      };
    }

    const originalsPath = path.join(reprintJobPath, 'originals');
    const workingPath   = path.join(reprintJobPath, 'working');

    // Source = /originals/. No manifest, no enhanced-path lookup —
    // matches the DPOF + Darkroom Pro + Fuji reprint methods.
    let imageFiles = reprintImages.map(img => ({
      sourcePath: path.join(originalsPath, img.filename),
      filename:   img.filename,
    }));

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        return {
          success: false,
          error: `Reprint image not found on disk: ${img.sourcePath}`,
        };
      }
    }

    // Re-apply CMY corrections from the reprint sidecar to /working/.
    const correctionsMap = new Map(
      reprintImages.map(img => [img.filename, img.corrections || {}])
    );
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      workingPath,
      correctionsMap,
    );

    // Reprint-suffixed jobId drives BOTH the XML's <customerID> AND the
    // writer's folder name + XML filename. Parent: `{outputPath}\{id}\` +
    // `{id}.xml` + <customerID>{id}</customerID>. Reprint: same shape with
    // `{id}-r1` everywhere. No collision in any of the three.
    const reprintJobId   = `${parentJob.id}-${reprintSuffix}`;
    const reprintJobName = `${parentJob.job_name || ''}-${reprintSuffix}`;

    // Build the generator input. Images come from the reprint sidecar
    // (filename + qtyCurrent), parallel to imageFiles after corrections
    // so basenames line up.
    const frontlineJob = {
      id:            reprintJobId,
      order_number:  parentJob.order_number  || '',
      job_name:      reprintJobName,
      customer_name: parentJob.customer_name || '',
      images: reprintImages.map((img, i) => ({
        filename:      imageFiles[i].filename,
        quantity:      img.qtyCurrent || 1,
        rotationAngle: 0,
      })),
    };

    const controllerConfig = {
      device:     route.device     || 'Pixfizz',
      backPrint1: route.backPrint1 || '{jobName}  {customerName}',
      backPrint2: route.backPrint2 || '{jobId}  {filename}',
    };

    const channelConfig = {
      batchCode:  route.batchCode,
      sortString: route.sortString,
    };

    const xmlContent = frontlineGenerator.generate(controllerConfig, channelConfig, frontlineJob);

    let writeResult;
    try {
      writeResult = await frontlineFileWriter.writeJobFolder(
        route.outputPath,
        reprintJobId,
        xmlContent,
        imageFiles,
      );
    } catch (writeErr) {
      logger.logError('Frontline reprint write failed', writeErr, {
        parentJobId:  parentJob.id,
        reprintSuffix,
        controller:   route.controllerName,
      });
      return { success: false, error: writeErr.message };
    }

    // Intentionally NO _markCompleted — parent lifecycle untouched.
    // Intentionally NO monitor registration — Frontline has no status
    // feedback; normal-send is fire-and-forget too.

    logger.info('Reprint sent via Frontline', {
      parentJobId:  parentJob.id,
      reprintSuffix,
      controller:   route.controllerName,
      reprintJobId,
      destFolder:   writeResult.jobFolderPath,
      xmlFile:      writeResult.xmlPath,
      images:       imageFiles.length,
    });

    return {
      success:  true,
      method:   'frontline-reprint',
      destPath: writeResult.jobFolderPath,
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

    const manifest    = await this._readManifest(orderFolderPath, job.order_number);
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
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
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

    // ── Per-job preparation — HOISTED above the batch loop ──────────────────
    // Everything below is deterministic in `job` and MUST run exactly once
    // even when the job splits into N batches. In particular,
    // _applyCorrectionsToImageFiles WRITES corrected JPEGs to /working/;
    // running it per-batch would do N× the disk churn for identical output.
    // See docs/batch-splitting-darkroom-pro-brief.md M4 for the invariant.

    const manifest    = await this._readManifest(orderFolderPath, job.order_number);
    // _findJobInManifest applies the operator-discarded filter (see
    // print-service.js:2978-2987) so `jobManifest.images` already reflects
    // what will actually print. Splitting must happen AFTER this to keep
    // batch boundaries aligned with the printed image list.
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
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
        filename:   basename,
      };
    });

    // Apply CMY corrections — replaces sourcePath with the corrected JPEG where needed
    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap
    );

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

    // ── Build per-image dispatch records carrying quantity ──────────────────
    // The splitter needs `.quantity` on each element (it counts prints, not
    // images — see docs/batch-splitting-feasibility.md §2). Bundle everything
    // the per-batch grouping will need so the loop below never has to
    // re-index against manifestImages.
    const dispatchRecords = manifestImages.map((manifestImg, i) => ({
      filename:         imageFiles[i].filename,
      sourcePath:       imageFiles[i].sourcePath,
      // Customer original upload path (manifest-relative). Carried through so
      // the {originalFilename} photo-line token resolves per image. null when
      // the manifest didn't ship one — token then resolves blank.
      originalFilename: manifestImg.originalFilename || null,
      quantity:         manifestImg.quantity || 1,
    }));

    // ── Split ───────────────────────────────────────────────────────────────
    // cap null / 0 / negative → single batch containing everything, and this
    // whole method behaves byte-for-byte identically to v1.9.0. Regression
    // guarantee for every existing Darkroom Pro lab that hasn't set the cap.
    const cap     = route.maxPrintsPerJob;
    const batches = splitIntoBatches(dispatchRecords, cap);
    const isSplit = batches.length > 1;
    const baseStem = job.job_name || `${job.order_number || ''}_${job.id}`;

    // ── Per-batch emitter seam ──────────────────────────────────────────────
    // Overridable on the singleton for tests (this._emitDarkroomProFile). In
    // production it's the top-level import. Matches the reprint tests'
    // monkey-patch pattern (see print-service-reprint-dispatch.test.js).
    const emit = this._emitDarkroomProFile || generateDarkroomProFile;

    // ── Persisted per-batch ledger ──────────────────────────────────────────
    // Nothing today records that a job dispatched as N parts, so a mid-loop
    // failure would leave files on the printer with no trace. Persist via
    // jobService.updateJobLocally (writes to jobs-cache; survives restart).
    // Only stamped on split jobs — single-batch dispatches keep the pre-M4
    // shape byte-for-byte (regression guarantee).
    const ledger = isSplit
      ? {
          cap,
          totalBatches: batches.length,
          totalPrints:  batchPrintCount(dispatchRecords),
          startedAt:    new Date().toISOString(),
          completedAt:  null,
          batches:      [],
        }
      : null;
    if (ledger) {
      jobService.updateJobLocally(job.id, { _darkroomProBatchLedger: ledger });
    }

    // ── Dispatch loop ───────────────────────────────────────────────────────
    const destPaths = [];
    for (let i = 0; i < batches.length; i++) {
      const batchImages   = batches[i];
      const batchIndex1   = i + 1;
      const totalBatches  = batches.length;
      // Quantity-group inside the batch — same grouping logic as pre-M4,
      // scoped to this batch's images only.
      const imagesByQty = new Map();
      for (const rec of batchImages) {
        const qty = rec.quantity;
        if (!imagesByQty.has(qty)) imagesByQty.set(qty, []);
        imagesByQty.get(qty).push({
          filename:         rec.filename,
          sourcePath:       rec.sourcePath,
          originalFilename: rec.originalFilename,
        });
      }
      const lineItems = [];
      for (const [qty, images] of imagesByQty) {
        lineItems.push({ qty, options: jobOptions, images });
      }

      // Filename stem: single batch keeps the pre-M4 stem (no `_1`); split
      // jobs get `_1..._N`. Changing the stem changes ExtOrderNum / Orderid
      // inside the file too (darkroom-pro-output.js:238,284,307), so each
      // split batch lands as a separate order in Darkroom Pro — that's the
      // whole point: the operator schedules them in the DP queue.
      const outputFilenameStem = isSplit ? `${baseStem}_${batchIndex1}` : baseStem;

      const dpJob = {
        // Job id is exposed so the {jobId} token resolves in configurable
        // photo lines. Templates that don't reference {jobId} are unaffected.
        id:                 job.id,
        orderRef:           job.order_number || '',
        outputFilenameStem,
        productCode:        job.product_code || '',
        customer:           { firstName, lastName, email: job.customer_email || '' },
        labCode:            job.website || '',
        orderDate:          job.created_at ? new Date(job.created_at) : new Date(),
        lineItems,
        // Per-job manual overrides from the Assign modal (take priority over
        // translation tables inside resolveSize / resolveMedia).
        _sizeOverride:  job._darkroomProSize  || null,
        _mediaOverride: job._darkroomProMedia || null,
      };

      let destPath;
      try {
        destPath = await emit(dpJob, controller);
      } catch (err) {
        // Partial failure. Batches [1..i] already landed and are being
        // printed — do NOT roll them back and do NOT pretend success.
        // Stamp the ledger, mark the job errored with a message naming
        // which batches went and which didn't, return {success:false}.
        // Neither _markCompleted nor _markInProduction fires (M5 lifecycle
        // rule: completion only when every batch succeeds).
        logger.logError(`[dp-batch] batch ${batchIndex1}/${totalBatches} failed`, err, {
          jobId:              job.id,
          controller:         route.controllerName,
          outputFilenameStem,
        });
        if (ledger) {
          ledger.batches.push({
            index:         batchIndex1,
            total:         totalBatches,
            filename:      `${outputFilenameStem}.txt`,
            destPath:      null,
            dispatchedAt:  new Date().toISOString(),
            outcome:       'error',
            error:         err.message,
          });
          jobService.updateJobLocally(job.id, { _darkroomProBatchLedger: ledger });
        }
        const succeeded = destPaths.length; // number that landed OK
        const errorMessage = isSplit
          ? `Darkroom Pro batch ${batchIndex1}/${totalBatches} failed: ${err.message}. ` +
            `Batches 1..${succeeded} were written to the hot folder and are being printed; ` +
            `batches ${batchIndex1}..${totalBatches} did NOT. Cancel the printed ones in Darkroom Pro if needed.`
          : err.message;
        jobService.updateJobLocally(job.id, {
          _status:       'error',
          _errorMessage: errorMessage,
        });
        return {
          success:      false,
          method:       'darkroompro-routed',
          sourcePath:   jobFolderPath,
          error:        errorMessage,
          batchesSucceeded: succeeded,
          batchesTotal:     totalBatches,
          ledger:       ledger,
        };
      }

      destPaths.push(destPath);
      if (ledger) {
        ledger.batches.push({
          index:         batchIndex1,
          total:         totalBatches,
          filename:      `${outputFilenameStem}.txt`,
          destPath,
          dispatchedAt:  new Date().toISOString(),
          outcome:       'success',
        });
        // Persist after every batch so a mid-loop process crash still
        // leaves a record of what went out. Fuji PIC Pro monitor uses
        // the same persist-on-every-mutation posture for the same reason.
        jobService.updateJobLocally(job.id, { _darkroomProBatchLedger: ledger });
        logger.info(`[dp-batch] batch ${batchIndex1}/${totalBatches} sent`, {
          jobId:      job.id,
          controller: route.controllerName,
          destPath,
          images:     batchImages.length,
          prints:     batchPrintCount(batchImages),
        });
      }
    }

    // ── All batches landed ──────────────────────────────────────────────────
    if (ledger) {
      ledger.completedAt = new Date().toISOString();
      jobService.updateJobLocally(job.id, { _darkroomProBatchLedger: ledger });
    }

    logger.info('Job sent via Darkroom Pro (routed)', {
      jobId:      job.id,
      controller: route.controllerName,
      destPath:   destPaths[destPaths.length - 1],
      lineItems:  batches.reduce((acc, b) => acc + b.length, 0),
      batches:    batches.length,
    });

    // Lifecycle. Only fires when every batch has been written successfully —
    // the partial-failure early return above prevents this on error, keeping
    // the job visible and recoverable. Single-batch and split paths converge
    // here (single-batch behaves byte-for-byte as v1.9.0).
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
      destPath:   destPaths[destPaths.length - 1],
      // Extra fields on split dispatches so callers can observe what happened
      // without re-reading the ledger. Absent on single-batch (byte-identical
      // return shape for the regression guarantee).
      ...(isSplit ? { batches: batches.length, destPaths, ledger } : {}),
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

    const manifest    = await this._readManifest(orderFolderPath, job.order_number);
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
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
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
      // Use the Job No (job_name, e.g. ORD-O4YK5Z-1) as the orderRef so the
      // surface filename, Order_ID, ImagePath and staging folder are all
      // job-level — multiple Fuji jobs within one order no longer collide.
      orderRef: job.job_name || job.order_number || '',
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
          // Customer original upload path — feeds the {originalFilename}
          // back-print token. null when the manifest didn't ship one.
          originalFilename: manifestImg.originalFilename || null,
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
        // Job No (job_name) — must match fujiJob.orderRef so the staging
        // folder and the .txt's ImagePath line up.
        orderRef:         job.job_name || job.order_number || '',
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
   * Fuji PIC Pro dispatch — one file per order, three explicit paths
   * (Order Data / DIGIN / Merge Data), OrderGateway handshake handled
   * asynchronously by FujiPicProMonitor.
   *
   * Mirrors _sendViaFujiJobMakerRouted for steps 1–4 exactly, because
   * that shape is what makes the CROPPED file the one that ships: the
   * enhanced/corrected/raw resolution via resolveDispatchImageSource
   * → _applyCorrectionsToImageFiles honours the sidecar's
   * `cropApplied` + `croppedPath` first, then falls back to enhanced,
   * root, /working/, /originals/. See dispatch-image-source.js for
   * the full precedence.
   *
   * Steps 5–8 diverge:
   *   5. Stage images with sequence rename (0001.<ext>, 0002.<ext>, …).
   *      The negNumberMap becomes the source for `NegNumber=` in the
   *      order.txt AND lands on the dispatch record so a later "which
   *      file is 0007?" question is answerable.
   *   6. Build the generator job from the negNumberMap + manifest
   *      quantities + route.printCode / route.color.
   *   7. writeOrderFile → Order Data. This is the trigger for
   *      OrderGateway; MUST land AFTER staging so a fast Gateway
   *      can't consume it before images are in place. (In practice
   *      the images aren't in DIGIN yet — they're in staging — but
   *      the writer's atomic rename guarantees the .txt is either
   *      absent or complete, never partial.)
   *   8. Enqueue the pending submission and start the monitor. Return
   *      immediately — the monitor does the DIGIN move + optional
   *      [release] later. Blocking here would stall runAutoPrint for
   *      up to the full build timeout every time OrderGateway is
   *      stopped.
   *
   * The route's `checkOrderStatus` toggle drives the same
   * _markCompleted / _markInProduction split JobMaker uses. For PIC
   * Pro the monitor's `accepted` / `failed` / `timed_out` callback
   * (wired via print-controller-service's onPicProStatus adapter)
   * is what eventually transitions JobStore state.
   */
  async _sendViaFujiPicProRouted(job, route) {
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

    const manifest    = await this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    // ── Route validation ────────────────────────────────────────────────────
    // Only `printCode` is required to dispatch — it's written as
    // `Code=` in the order.txt (PIC Pro spec p. 351). Missing =>
    // fail loudly with an actionable message.
    if (!route.printCode) {
      const errMsg =
        `Fuji PIC Pro route is missing printCode for product "${job.product_code || '(none)'}". ` +
        `Add a channel mapping for this product in Settings → Routing.`;
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: errMsg });
      return { success: false, error: errMsg };
    }
    // Review fix 12 (2026-08-03): `printSize` is a CROP-aspect
    // indicator only — it's never written into the order.txt (spec
    // pp. 339-370 has no size-bearing field this maps to) and the
    // writer doesn't consume it. JobMaker's dispatch (`:2079`)
    // correctly doesn't gate on it either.
    //
    // Blocking auto-print on blank `printSize` breaks the Pixfizz
    // artwork-source flow: those jobs never enter Manual Crop
    // (artwork_source gate excludes them) so the field is legitimately
    // unset for them. Manual-source jobs that DO enter Manual Crop
    // surface a ⚠ pill via `resolveTargetSize` when printSize is
    // blank, and fix 2 gates Approve behind that pill — the incorrect-
    // crop failure mode is already covered upstream.
    //
    // Downgrade to a warning so the log still surfaces "operator
    // should probably set this" without failing an otherwise-valid
    // order.
    if (!route.printSize) {
      logger.logWarning('[fuji-pic-pro] route.printSize is blank — Manual Crop for this product will fall back to a 1:1 square, but dispatch is proceeding (printSize is a crop-aspect indicator only, not written to order.txt)', {
        jobId:      job.id,
        controller: route.controllerName,
        productCode: job.product_code,
      });
    }

    // ── Resolve image paths — enhanced → cropped → corrected → raw ─────────
    // Exact same shape as the DPOF + JobMaker pipelines so the cropped
    // file in /working/ wins over the raw at the flat root. This is
    // what makes pre-cropped dispatch work: skipping any of these
    // steps loses either the enhancement or the crop.
    const enhancedMap    = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);
    const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

    let imageFiles = jobManifest.images.map(img => {
      const basename     = path.basename(img.filename);
      const enhancedPath = enhancedMap.get(basename);
      if (enhancedPath) {
        logger.info('Using enhanced image for Fuji PIC Pro print', { filename: basename, enhancedPath });
      }
      return {
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
        filename:   basename,
        // NOTE: `_applyCorrectionsToImageFiles` returns only
        // { sourcePath, filename } for corrected rows (see
        // print-service.js `_applyCorrectionsToImageFiles`), so any
        // per-image field we stash here is silently dropped the
        // moment a CMY slider is non-zero. Everything the generator
        // needs (quantity, originalFilename) is therefore read
        // straight from `jobManifest.images[i]` below — same posture
        // JobMaker uses at `_sendViaFujiJobMakerRouted`.
      };
    });

    imageFiles = await this._applyCorrectionsToImageFiles(
      imageFiles,
      path.join(jobFolderPath, 'working'),
      correctionsMap,
    );

    for (const img of imageFiles) {
      if (!fs.existsSync(img.sourcePath)) {
        throw new Error(`Image not found: ${img.sourcePath}`);
      }
    }

    // ── Stage images with sequence rename (0001.<ext>, 0002.<ext>, …) ──────
    // orderId is per-job (job_name, e.g. ORD-O4YK5Z-1) — matches
    // JobMaker's convention so two jobs from one order can't collide
    // in PIC Pro's staging or Order Data folders.
    const orderId = job.job_name || job.order_number || '';

    let stageResult;
    try {
      stageResult = await fujiPicProFileWriter.stageImages({
        imageStagingRoot: route.imageStagingRoot,
        orderId,
        imageFiles: imageFiles.map((img, i) => ({
          sourcePath:       img.sourcePath,
          // Read originalFilename from the manifest — imageFiles
          // may have been stripped by `_applyCorrectionsToImageFiles`.
          originalFilename: jobManifest.images[i].originalFilename || null,
        })),
      });
    } catch (stageErr) {
      logger.logError('Fuji PIC Pro image staging failed', stageErr, {
        jobId:      job.id,
        controller: route.controllerName,
      });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: stageErr.message });
      return { success: false, error: stageErr.message };
    }

    // ── Build generator input from the sequenced files + route fields ──────
    const fullName = (job.customer_name || '').trim();
    const picProJob = {
      orderId,
      id:       job.id,
      jobName:  orderId,
      customer: {
        fullName,
        email: job.customer_email || '',
        phone: job.customer_phone || '',
      },
      images: stageResult.negNumberMap.map((staged, i) => ({
        negNumber:        staged.negNumber,
        printCode:        route.printCode,
        // Manifest-sourced — never trust imageFiles[i].quantity, that
        // key is dropped whenever CMY corrections run. `|| 1` matches
        // JobMaker's default.
        quantity:         jobManifest.images[i].quantity || 1,
        color:            route.color || 'C',
        // {originalFilename} back-print reads from the manifest, not
        // the sequence-renamed 0001.jpg — so the customer's real
        // filename still lands on the back of the print. Also
        // manifest-sourced for the same reason as quantity.
        originalFilename: jobManifest.images[i].originalFilename || staged.originalFilename || '',
        filename:         staged.stagedName,
      })),
    };

    const controllerCfg = {
      backprintMode:       route.backprintMode      || 'none',
      backprintTemplate:   route.backprintTemplate  || '',
      backprintTemplate2:  route.backprintTemplate2 || '',
      includeCustomerName: route.includeCustomerName === true,
    };

    let orderFile;
    try {
      orderFile = generateFujiPicProOrderFile(picProJob, controllerCfg);
    } catch (genErr) {
      logger.logError('Fuji PIC Pro generation failed', genErr, { jobId: job.id });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: genErr.message });
      return { success: false, error: genErr.message };
    }

    // ── Enqueue for the monitor and START it (idempotent) ──────────────────
    // Fuji PIC Pro review fix 11. Reordered: enqueue BEFORE writing
    // the .txt. Pre-fix a crash between write and enqueue (or a
    // blank diginPath that failed enqueue) left OrderGateway with a
    // .txt it consumed while OHD had no monitor entry to drive the
    // DIGIN handshake — orphaned image-less order at PIC Pro. The
    // reordered flow persists the pending entry first (with
    // txtCommitted=false so the monitor won't advance yet), then
    // writes the .txt, then flips txtCommitted via `markCommitted`.
    // Kill in the enqueue↔write gap now leaves a recoverable entry
    // (times out via gatewayTimeoutMs) rather than an orphaned .txt.
    //
    // startMonitoring first so the monitor exists to enqueue into.
    // printControllerService.startMonitoring is a no-op when the
    // monitor is already up.
    printControllerService.startMonitoring(route.controllerId);
    const monitor = printControllerService.getMonitor(route.controllerId);
    if (!monitor || typeof monitor.enqueueSubmission !== 'function') {
      // Monitor wasn't wired for this controller type — shouldn't
      // happen in production (print-controller-service.startMonitoring
      // handles fujipicpro). Fail loudly rather than silently
      // dropping the handshake.
      const msg = `Fuji PIC Pro monitor unavailable for controller ${route.controllerId} — refusing to dispatch. DIGIN delivery + release would not happen.`;
      logger.logError(msg, new Error('no-monitor'), { controllerId: route.controllerId, orderId });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: msg });
      return { success: false, error: msg };
    }

    try {
      monitor.enqueueSubmission({
        orderRef:            orderId,
        orderId,
        stagingFolder:       stageResult.stagingFolder,
        controllerId:        route.controllerId,
        orderDataPath:       route.orderDataPath,
        diginPath:           route.diginPath,
        mergeDataPath:       route.mergeDataPath || '',
        gatewayTimeoutMs:    route.gatewayTimeoutMs,
        buildTimeoutMs:      route.buildTimeoutMs,
        sendReleaseCommand:  route.sendReleaseCommand === true,
      });
    } catch (enqueueErr) {
      // Fix 9: duplicate orderId (in-flight submission not yet
      // resolved). Never write the .txt in this state — OrderGateway
      // would then have two writes for the same order.
      logger.logError('Fuji PIC Pro enqueue failed — refusing to write .txt', enqueueErr, {
        jobId:      job.id,
        controller: route.controllerName,
        orderId,
        code:       enqueueErr && enqueueErr.code,
      });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: enqueueErr.message });
      return { success: false, error: enqueueErr.message };
    }

    // ── Write the order.txt into Order Data (atomic .tmp + rename) ─────────
    let writtenPath;
    try {
      ({ writtenPath } = await fujiPicProFileWriter.writeOrderFile({
        orderDataPath: route.orderDataPath,
        filename:      orderFile.filename,
        contents:      orderFile.contents,
      }));
    } catch (writeErr) {
      // Fix 11: enqueue already ran, so we must dequeue the entry
      // ourselves rather than let it sit in awaiting-gateway
      // waiting for a .txt that never landed. dequeue is silent
      // (no callback) since the caller stamps the job's error
      // status here directly.
      try { monitor.dequeue(orderId); } catch (_) { /* best-effort */ }
      logger.logError('Fuji PIC Pro order file write failed — staged images may remain', writeErr, {
        jobId:      job.id,
        controller: route.controllerName,
      });
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: writeErr.message });
      return { success: false, error: writeErr.message };
    }

    // Fix 11: signal the monitor that the .txt is now on disk.
    // Only from this call onward does `_stepAwaitingGateway` start
    // observing for OrderGateway consumption.
    monitor.markCommitted(orderId);

    logger.info('Job sent via Fuji PIC Pro (routed) — enqueued for OrderGateway handshake', {
      jobId:        job.id,
      controller:   route.controllerName,
      orderId,
      printCode:    route.printCode,
      color:        route.color || 'C',
      orderFile:    writtenPath,
      stagedImages: stageResult.negNumberMap.length,
    });

    if (route.checkOrderStatus === false) {
      logger.info('[Fuji PIC Pro] checkOrderStatus disabled — marking job completed immediately', { jobId: job.id });
      await this._markCompleted(job.id);
    } else {
      await this._markInProduction(job.id);
    }

    return {
      success:       true,
      method:        'fujipicpro-routed',
      sourcePath:    jobFolderPath,
      orderFilePath: writtenPath,
      stagedFolder:  stageResult.stagingFolder,
      // Handy for a later "which physical file went out as NegNumber X"
      // debug session — the dispatch record persists this alongside
      // the audit log entry.
      negNumberMap:  stageResult.negNumberMap.map(e => ({
        negNumber:        e.negNumber,
        stagedName:       e.stagedName,
        originalFilename: e.originalFilename,
      })),
    };
  }

  /**
   * Fuji PIC Pro — order-level dispatch. M4 of the order-level
   * submission brief (docs/order-level-submission-picpro-brief.md).
   *
   * Sits alongside `_sendViaFujiPicProRouted` deliberately parallel to
   * it. The single-job method must remain byte-identical when the
   * `mergeOrderJobs` setting is off; this method is only reached when
   * it is on. Sharing helpers between the two would risk regressing
   * the byte-identical guarantee (the whole point of an opt-in
   * feature), so this is a lift-not-refactor.
   *
   * The group's jobs share:
   *   - one order manifest (read once, not per-job)
   *   - one staging folder ({imageStagingRoot}/{orderId})
   *   - one order.txt (with per-image `Code=` and `NegNumber=`)
   *   - one enqueue → write → markCommitted transaction
   *   - controller-level fields (paths, backprint config,
   *     includeCustomerName) — asserted to agree
   *
   * The group's jobs differ in:
   *   - route.printCode (per-image `Code=` — the entire point of the
   *     feature)
   *   - route.color   (per-image `Color=`)
   *   - manifest quantity + originalFilename (per-image)
   *
   * `orderId` is allocated from the persistent submission-sequence
   * store (M3) — first submission for this order number is the
   * unsuffixed order number, subsequent ones (late-arriver batches
   * after cap-expiry, retries after a failed dispatch) get `-2`,
   * `-3`, … The store persists on every allocation, so a failed
   * dispatch consumes an id and the next attempt is `-N+1`. That is
   * intentional: reusing an id would let stageImages `rm -rf` the
   * previous submission's staging folder (see M3 module doc).
   *
   * Failure posture: mark EVERY member errored with a single
   * message that names the order and the member jobs, so the
   * operator sees the blast radius. Never mark some completed and
   * some errored — that would misrepresent what happened.
   *
   * @param {Array<{ job: object, route: object }>} items
   * @returns {Promise<{success:true, method:string, orderId:string, memberJobIds:Array,
   *                   orderFilePath:string, stagedFolder:string, negNumberMap:Array}
   *                 | {success:false, error:string}>}
   */
  async _sendViaFujiPicProOrderRouted(items) {
    const downloadDirectory = configService.get('downloadDirectory');
    if (!downloadDirectory) {
      throw new Error('Download directory is not configured.');
    }

    // ── Guard: non-empty, well-shaped group ────────────────────────────────
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('_sendViaFujiPicProOrderRouted: empty group — the caller must never dispatch an empty submission');
    }
    for (const it of items) {
      if (!it || !it.job || !it.route) {
        throw new Error('_sendViaFujiPicProOrderRouted: malformed group item — expected {job, route}');
      }
    }

    const memberJobIds = items.map(it => it.job.id);
    const sharedRoute  = items[0].route;

    // ── Assert group agreement on controller-level fields ──────────────────
    // Backprint config and includeCustomerName ride on the controller too,
    // but the load-bearing ones are the paths and controllerId: a group
    // whose members target different DIGIN or Order Data folders would
    // mis-deliver silently. Fail loudly BEFORE any staging.
    for (const field of ['controllerId', 'controllerType', 'orderDataPath', 'diginPath', 'imageStagingRoot']) {
      for (const it of items) {
        if (it.route[field] !== sharedRoute[field]) {
          const msg =
            `Fuji PIC Pro order-level dispatch: group members disagree on controller field "${field}" ` +
            `(job ${it.job.id}: ${JSON.stringify(it.route[field])} vs group: ${JSON.stringify(sharedRoute[field])}). ` +
            `Refusing to merge. Member jobs: ${memberJobIds.join(', ')}.`;
          logger.logError(msg, new Error('order-group-controller-disagreement'), {
            field, memberJobIds,
          });
          this._markGroupErrored(items, msg);
          return { success: false, error: msg };
        }
      }
    }

    // All jobs must share order_number too — this is the merge key.
    const orderNumber = items[0].job.order_number;
    for (const it of items) {
      if (it.job.order_number !== orderNumber) {
        const msg =
          `Fuji PIC Pro order-level dispatch: group members disagree on order_number ` +
          `(job ${it.job.id}: ${JSON.stringify(it.job.order_number)} vs group: ${JSON.stringify(orderNumber)}). ` +
          `Refusing to merge. Member jobs: ${memberJobIds.join(', ')}.`;
        logger.logError(msg, new Error('order-group-order-number-disagreement'), { memberJobIds });
        this._markGroupErrored(items, msg);
        return { success: false, error: msg };
      }
    }

    // ── Allocate the order-level id from the persistent store ──────────────
    // Persisted on allocation. If we crash or fail below, the next
    // attempt gets -N+1 and stageImages does NOT rm -rf a folder from
    // a previous attempt — the whole reason M3 exists.
    //
    // Lazy-required (same pattern as server-capabilities in
    // job-service) so require-ing print-service.js doesn't force the
    // electron-store singleton at module load — needed for the
    // node:test harness which stubs orderSubmissionSeq in require.cache.
    let orderId;
    try {
      const { orderSubmissionSeq } = require('./order-submission-seq');
      orderId = orderSubmissionSeq.nextSubmissionId(orderNumber);
    } catch (seqErr) {
      const msg = `Fuji PIC Pro order-level dispatch: failed to allocate submission id for order ${orderNumber}: ${seqErr.message}`;
      logger.logError(msg, seqErr, { memberJobIds });
      this._markGroupErrored(items, msg);
      return { success: false, error: msg };
    }

    // ── Read the manifest ONCE per order ───────────────────────────────────
    const orderFolderName = `${orderNumber}_${items[0].job.order_id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);

    let manifest;
    try {
      manifest = await this._readManifest(orderFolderPath, orderNumber);
    } catch (readErr) {
      const msg = `Fuji PIC Pro order-level dispatch: manifest read failed for order ${orderId}: ${readErr.message}. Member jobs: ${memberJobIds.join(', ')}.`;
      logger.logError(msg, readErr, { orderId, memberJobIds });
      this._markGroupErrored(items, msg);
      return { success: false, error: msg };
    }

    // ── Per-job image resolution + parallel metadata capture ───────────────
    // Concatenate every member's images into one array, with a parallel
    // metadata array carrying the originating jobId + per-image
    // printCode/color/quantity/originalFilename. The single-job method
    // zips stageResult.negNumberMap[i] with jobManifest.images[i]; here
    // we zip against this concatenated metadata array.
    const concatenated = [];   // [{ sourcePath, filename, jobId, printCode, color, quantity, originalFilename }]
    // Members whose images were ALL removed by the operator-discard
    // filter (job._excludedFilenames, applied inside _findJobInManifest).
    // These get dropped from the dispatch, their status is deliberately
    // NOT touched, and their printCode never reaches the .txt — the
    // operator has already said "don't print this one". See the
    // per-member handling below for the reasoning.
    const droppedByExclusion = [];

    for (const item of items) {
      const { job, route } = item;

      // Folder existence + manifest lookup happen FIRST so the exclusion
      // decision (below) has real manifest data to inspect. These are
      // hard errors, not exclusion candidates — a missing folder or an
      // absent manifest entry is a data issue we fail the whole group on
      // regardless of what the operator excluded.
      const jobFolderName = `${job.order_number}_${job.id}`;
      const jobFolderPath = path.join(orderFolderPath, jobFolderName);
      if (!fs.existsSync(jobFolderPath)) {
        const msg = `Fuji PIC Pro order-level dispatch: member job folder not found: ${jobFolderPath}. Order ${orderId}, member jobs: ${memberJobIds.join(', ')}.`;
        this._markGroupErrored(items, msg);
        return { success: false, error: msg };
      }

      const jobManifest = this._findJobInManifest(manifest, job);
      if (!jobManifest) {
        const msg = `Fuji PIC Pro order-level dispatch: member job ${job.id} not found in order manifest. Order ${orderId}, member jobs: ${memberJobIds.join(', ')}.`;
        this._markGroupErrored(items, msg);
        return { success: false, error: msg };
      }

      // Operator-discard drop: _findJobInManifest has already applied
      // `job._excludedFilenames`. If that filter emptied the images
      // array, the operator has explicitly said "don't print any of
      // this member's images" — drop the whole member from this
      // dispatch, log at warn, and leave its status untouched so the
      // existing per-job path or the operator handles it. This is
      // distinct from a legitimately-empty manifest (no exclusion
      // applied) — that stays a hard error via the collective empty
      // check further down.
      const excluded      = job && job._excludedFilenames;
      const excludedCount = (excluded && typeof excluded.size === 'number') ? excluded.size : 0;
      if (jobManifest.images.length === 0 && excludedCount > 0) {
        logger.logWarning('[fuji-pic-pro] order-level member dropped — all images excluded by operator', {
          jobId:       job.id,
          orderId,
          orderNumber,
          excludedCount,
          controller:  route.controllerName,
        });
        droppedByExclusion.push(item);
        // Deliberately no _markInProduction / _markCompleted call, no
        // errored stamp — the member's status is left untouched.
        continue;
      }

      // From here the member IS active in the dispatch. Route
      // validation applies only to active members — a would-be-dropped
      // member with a broken printCode is a config issue the operator
      // will see on the next per-job attempt, not something to fail
      // the whole group's Save & Assign for.
      if (!route.printCode) {
        const msg =
          `Fuji PIC Pro order-level dispatch: member job ${job.id} (product "${job.product_code || '(none)'}") ` +
          `is missing route.printCode. Add a channel mapping in Settings → Routing. ` +
          `The whole order-level group failed. Member jobs: ${memberJobIds.join(', ')}.`;
        this._markGroupErrored(items, msg);
        return { success: false, error: msg };
      }
      // Blank printSize is a warning, not a failure — same rationale as
      // the single-job method (crop-aspect indicator only; not written
      // to order.txt).
      if (!route.printSize) {
        logger.logWarning('[fuji-pic-pro] route.printSize blank on order-level member — dispatch proceeding (crop-aspect only)', {
          jobId:       job.id,
          controller:  route.controllerName,
          productCode: job.product_code,
          orderId,
        });
      }

      // Image resolution — enhanced → cropped → corrected → raw. Same
      // shape as the single-job method so the cropped file in /working/
      // wins over the raw at the flat root.
      const enhancedMap    = await this._getEnhancedPathMap(jobFolderName, jobFolderPath);
      const correctionsMap = await this._getCorrectionsMap(jobFolderName, jobFolderPath);

      let imageFiles = jobManifest.images.map(img => {
        const basename     = path.basename(img.filename);
        const enhancedPath = enhancedMap.get(basename);
        if (enhancedPath) {
          logger.info('Using enhanced image for Fuji PIC Pro order-level member', {
            jobId: job.id, filename: basename, enhancedPath, orderId,
          });
        }
        return {
          sourcePath: resolveDispatchImageSource({
            rootPath:     path.join(orderFolderPath, img.filename),
            jobFolderPath, basename, enhancedPath,
          }),
          filename:   basename,
        };
      });

      imageFiles = await this._applyCorrectionsToImageFiles(
        imageFiles,
        path.join(jobFolderPath, 'working'),
        correctionsMap,
      );

      for (const img of imageFiles) {
        if (!fs.existsSync(img.sourcePath)) {
          const msg = `Fuji PIC Pro order-level dispatch: image not found: ${img.sourcePath} (member job ${job.id}). Order ${orderId}, member jobs: ${memberJobIds.join(', ')}.`;
          this._markGroupErrored(items, msg);
          return { success: false, error: msg };
        }
      }

      // Concatenate, capturing per-image identity + per-job route
      // fields. Read quantity + originalFilename from the MANIFEST,
      // not from imageFiles — `_applyCorrectionsToImageFiles` strips
      // those keys whenever a CMY correction is applied (same rationale
      // as the single-job method at :2508-2515).
      for (let i = 0; i < imageFiles.length; i++) {
        concatenated.push({
          sourcePath:       imageFiles[i].sourcePath,
          filename:         imageFiles[i].filename,
          jobId:            job.id,
          printCode:        route.printCode,
          color:            route.color || 'C',
          quantity:         jobManifest.images[i].quantity || 1,
          originalFilename: jobManifest.images[i].originalFilename || null,
        });
      }
    }

    // Active items = every member NOT dropped by the exclusion filter.
    // Downstream failure paths (staging fail, write fail, enqueue fail,
    // etc.) must error only the active members — the dropped ones have
    // their status deliberately untouched.
    const activeItems  = items.filter(it => !droppedByExclusion.includes(it));
    const activeJobIds = activeItems.map(it => it.job.id);
    const droppedIds   = droppedByExclusion.map(it => it.job.id);

    // Never-empty invariant. Two flavours:
    //   (a) every member was dropped by the operator's exclusion filter —
    //       not a failure, just nothing to do. Leave every status
    //       untouched and log at warn.
    //   (b) at least one active member yielded zero images without
    //       exclusion (bad manifest, empty images[] in the source
    //       data) — that IS a data error, so mark the active members
    //       errored (the dropped ones still stay untouched).
    if (concatenated.length === 0) {
      if (activeItems.length === 0) {
        const msg = `Fuji PIC Pro order-level dispatch: every member of order ${orderId} had all images excluded by the operator — not dispatching. Statuses untouched. Dropped jobs: ${droppedIds.join(', ')}.`;
        logger.logWarning(msg, { orderId, droppedByExclusion: droppedIds });
        return { success: false, error: msg, reason: 'all-members-excluded' };
      }
      const msg = `Fuji PIC Pro order-level dispatch: no images across ${activeItems.length} active member jobs (${droppedByExclusion.length} dropped by exclusion). Refusing to dispatch. Order ${orderId}, active jobs: ${activeJobIds.join(', ')}.`;
      logger.logError(msg, new Error('empty-order-group'), { orderId, activeJobIds, droppedByExclusion: droppedIds });
      this._markGroupErrored(items, msg);
      return { success: false, error: msg };
    }

    // ── ONE stageImages call for the whole group ───────────────────────────
    // NegNumber sequences across the concatenated array so 0001…000N
    // spans every member job.
    let stageResult;
    try {
      stageResult = await fujiPicProFileWriter.stageImages({
        imageStagingRoot: sharedRoute.imageStagingRoot,
        orderId,
        imageFiles: concatenated.map(m => ({
          sourcePath:       m.sourcePath,
          originalFilename: m.originalFilename,
        })),
      });
    } catch (stageErr) {
      logger.logError('Fuji PIC Pro order-level image staging failed', stageErr, {
        orderId, activeJobIds, droppedByExclusion: droppedIds, controller: sharedRoute.controllerName,
      });
      // Post-drop failure: error only the active members. Members that
      // were dropped by the operator's exclusion filter had their
      // status left untouched above and stay untouched here.
      this._markGroupErrored(activeItems, stageErr.message);
      return { success: false, error: stageErr.message };
    }

    // ── Build the generator input ──────────────────────────────────────────
    // Each image carries its OWN job's printCode + color from the
    // parallel metadata array. Customer info is taken from the first
    // ACTIVE member — with the setting on, the .txt is per-order and
    // the customer is shared across the order anyway. (Using
    // activeItems[0] rather than items[0] keeps the customer info
    // consistent even if the first item was dropped by exclusion.)
    const firstJob = activeItems[0].job;
    const fullName = (firstJob.customer_name || '').trim();
    const picProJob = {
      orderId,
      // `id` isn't consumed by the generator (it inspects orderId
      // for the filename + [order]) but the shape is kept for parity
      // with the single-job builder. Nominally the first member's id.
      id:       firstJob.id,
      jobName:  orderId,
      customer: {
        fullName,
        email: firstJob.customer_email || '',
        phone: firstJob.customer_phone || '',
      },
      images: stageResult.negNumberMap.map((staged, i) => ({
        negNumber:        staged.negNumber,
        printCode:        concatenated[i].printCode,
        quantity:         concatenated[i].quantity,
        color:            concatenated[i].color,
        originalFilename: concatenated[i].originalFilename || staged.originalFilename || '',
        filename:         staged.stagedName,
      })),
    };

    // Controller-level config — the group already agreed on it.
    const controllerCfg = {
      backprintMode:       sharedRoute.backprintMode      || 'none',
      backprintTemplate:   sharedRoute.backprintTemplate  || '',
      backprintTemplate2:  sharedRoute.backprintTemplate2 || '',
      includeCustomerName: sharedRoute.includeCustomerName === true,
    };

    let orderFile;
    try {
      orderFile = generateFujiPicProOrderFile(picProJob, controllerCfg);
    } catch (genErr) {
      logger.logError('Fuji PIC Pro order-level generation failed', genErr, {
        orderId, activeJobIds, droppedByExclusion: droppedIds,
      });
      this._markGroupErrored(activeItems, genErr.message);
      return { success: false, error: genErr.message };
    }

    // ── Enqueue → write → markCommitted (rollback on write failure) ────────
    // Same order and same rationale as the single-job method (review
    // fix 11). Reordering these breaks the recovery guarantee against
    // OrderGateway consuming a .txt with no monitor entry to drive
    // the DIGIN handshake.
    printControllerService.startMonitoring(sharedRoute.controllerId);
    const monitor = printControllerService.getMonitor(sharedRoute.controllerId);
    if (!monitor || typeof monitor.enqueueSubmission !== 'function') {
      const msg = `Fuji PIC Pro monitor unavailable for controller ${sharedRoute.controllerId} — refusing to dispatch order-level group. DIGIN delivery + release would not happen. Order ${orderId}, active jobs: ${activeJobIds.join(', ')}.`;
      logger.logError(msg, new Error('no-monitor'), { controllerId: sharedRoute.controllerId, orderId, activeJobIds });
      this._markGroupErrored(activeItems, msg);
      return { success: false, error: msg };
    }

    try {
      monitor.enqueueSubmission({
        orderRef:            orderId,
        orderId,
        stagingFolder:       stageResult.stagingFolder,
        controllerId:        sharedRoute.controllerId,
        orderDataPath:       sharedRoute.orderDataPath,
        diginPath:           sharedRoute.diginPath,
        mergeDataPath:       sharedRoute.mergeDataPath || '',
        gatewayTimeoutMs:    sharedRoute.gatewayTimeoutMs,
        buildTimeoutMs:      sharedRoute.buildTimeoutMs,
        sendReleaseCommand:  sharedRoute.sendReleaseCommand === true,
      });
    } catch (enqueueErr) {
      logger.logError('Fuji PIC Pro order-level enqueue failed — refusing to write .txt', enqueueErr, {
        orderId, activeJobIds, droppedByExclusion: droppedIds, controller: sharedRoute.controllerName,
        code: enqueueErr && enqueueErr.code,
      });
      this._markGroupErrored(activeItems, enqueueErr.message);
      return { success: false, error: enqueueErr.message };
    }

    let writtenPath;
    try {
      ({ writtenPath } = await fujiPicProFileWriter.writeOrderFile({
        orderDataPath: sharedRoute.orderDataPath,
        filename:      orderFile.filename,
        contents:      orderFile.contents,
      }));
    } catch (writeErr) {
      // Fix 11 rollback — dequeue the entry so the monitor doesn't sit
      // in awaiting-gateway waiting for a .txt that never lands.
      try { monitor.dequeue(orderId); } catch (_) { /* best-effort */ }
      logger.logError('Fuji PIC Pro order-level file write failed — staged images may remain', writeErr, {
        orderId, activeJobIds, droppedByExclusion: droppedIds, controller: sharedRoute.controllerName,
      });
      this._markGroupErrored(activeItems, writeErr.message);
      return { success: false, error: writeErr.message };
    }

    // Signal the monitor that the .txt is on disk.
    monitor.markCommitted(orderId);

    logger.info('Order-level Fuji PIC Pro dispatch — enqueued for OrderGateway handshake', {
      orderId,
      activeJobIds,
      droppedByExclusion: droppedIds,
      controller:   sharedRoute.controllerName,
      orderFile:    writtenPath,
      stagedImages: stageResult.negNumberMap.length,
      // Per-image printCode breakdown, for the operator's audit log.
      printCodes:   Array.from(new Set(concatenated.map(m => m.printCode))).sort(),
    });

    // ── Per-member lifecycle — same rule as the single-job method ──────────
    // checkOrderStatus is a controller-level field, so every member's
    // route reports the same value; we still resolve it per-member to
    // make the intent unambiguous and to survive a future per-route
    // override without silent behaviour change. Iterates activeItems
    // only — members dropped by the operator's exclusion filter
    // deliberately do NOT get a lifecycle transition here (their
    // status is left untouched for the next per-job path or the
    // operator to handle).
    for (const { job, route } of activeItems) {
      if (route.checkOrderStatus === false) {
        logger.info('[Fuji PIC Pro] checkOrderStatus disabled — marking order-level member completed immediately', { jobId: job.id, orderId });
        await this._markCompleted(job.id);
      } else {
        await this._markInProduction(job.id);
      }
    }

    return {
      success:       true,
      method:        'fujipicpro-order-routed',
      orderId,
      // memberJobIds is the ORIGINAL group; activeJobIds is what
      // actually dispatched. Kept separate so a caller comparing
      // dispatch record to input can see which members were dropped.
      memberJobIds,
      activeJobIds,
      droppedByExclusion: droppedIds,
      orderFilePath: writtenPath,
      stagedFolder:  stageResult.stagingFolder,
      // Handy for a later "which physical file went out as NegNumber X"
      // debug session — includes the member jobId per row so the
      // dispatch record shows which job contributed which frame.
      negNumberMap:  stageResult.negNumberMap.map((e, i) => ({
        negNumber:        e.negNumber,
        stagedName:       e.stagedName,
        originalFilename: e.originalFilename,
        jobId:            concatenated[i].jobId,
        printCode:        concatenated[i].printCode,
      })),
    };
  }

  /**
   * Mark every member job in an order-level group errored with the
   * same message, so the operator can see the blast radius rather
   * than seeing some jobs succeed and some fail. Only used by
   * `_sendViaFujiPicProOrderRouted`.
   *
   * @param {Array<{ job: object }>} items
   * @param {string} message
   */
  _markGroupErrored(items, message) {
    for (const { job } of items) {
      jobService.updateJobLocally(job.id, { _status: 'error', _errorMessage: message });
    }
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

    const manifest    = await this._readManifest(orderFolderPath, job.order_number);
    const jobManifest = this._findJobInManifest(manifest, job);

    if (!jobManifest) {
      throw new Error(`Job ${job.id} not found in order manifest.`);
    }

    const pdfFiles = jobManifest.images
      .filter(img => path.extname(img.filename).toLowerCase() === '.pdf')
      .map(img => {
        const basename = path.basename(img.filename);
        return {
          sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename }),
          filename:   basename,
        };
      });

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

    const manifest    = await this._readManifest(orderFolderPath, job.order_number);
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
        sourcePath: resolveDispatchImageSource({ rootPath: path.join(orderFolderPath, img.filename), jobFolderPath, basename, enhancedPath }),
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
   *
   * Retries a few times before failing. FTP delivery to the watched share is
   * NOT atomic (basic-ftp's downloadTo writes the manifest in place), and
   * OrderHub re-pushes an order folder when later jobs are added to the same
   * order — so the manifest can momentarily vanish, be zero-byte, or be
   * half-written exactly when a dispatch happens to read it (a TOCTOU race on
   * the SMB share). polling-service's awaiting-manifest gate only covers the
   * FIRST arrival of the manifest; once a job has been markReceived it is no
   * longer gated, so a re-push blip lands straight in this read and previously
   * threw "Order manifest not found", entering the sticky-error path even
   * though the file reappeared a moment later. The retry absorbs that blip.
   *
   * Budget: 4 attempts, 250ms apart → at most 3 * 250ms = 750ms of added
   * latency before giving up. This runs synchronously inside the per-job
   * auto-print loop (it blocks the jobs queued behind it), so the window is
   * deliberately kept small; the genuine "manifest never arrived" case is
   * already handled upstream by the awaiting-manifest gate.
   */
  async _readManifest(orderFolderPath, orderNumber) {
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 250;
    // Seed with the primary name so a never-found error references
    // {orderNumber}.json; re-resolved each attempt below.
    let manifestPath = path.join(orderFolderPath, `${orderNumber}.json`);

    let lastParseError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Re-resolve each attempt so a late-arriving manifest under either the
      // {orderNumber}.json primary name or the order.json fallback is picked up.
      manifestPath = resolveManifestPath(orderFolderPath, orderNumber);
      let present = false;
      try {
        present = fs.existsSync(manifestPath) && fs.statSync(manifestPath).size > 0;
      } catch (_) {
        // stat can throw transiently on SMB during an overwrite — treat as absent
        present = false;
      }

      if (present) {
        try {
          const raw = fs.readFileSync(manifestPath, 'utf-8');
          return JSON.parse(raw);
        } catch (error) {
          // A half-written manifest mid-overwrite parses as invalid JSON.
          // Treat as transient and retry; only surface if it never settles.
          lastParseError = error;
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    if (lastParseError) {
      // A manifest that exists but never parses across the whole retry budget
      // is treated as a genuine (terminal) corruption, NOT a delivery blip —
      // stays a plain Error so the auto-print re-arm path leaves it alone.
      throw new Error(`Failed to read order manifest: ${lastParseError.message}`);
    }
    // Typed so the auto-print catch can re-arm the awaiting-manifest wait
    // instead of going to sticky error. Message preserved verbatim.
    throw new ManifestNotFoundError(manifestPath);
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
// (manifest retry + typed-error re-arm wired 2026-06-24)
