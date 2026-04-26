'use strict';

const Store  = require('electron-store');
const logger = require('./logger');
const { resolveSize, resolveMedia } = require('./darkroom-pro-output');

// Routing data lives in its own named store so that config-service's default
// Store instance (which shares config.json) cannot inadvertently overwrite
// routing keys when the user saves settings.  All routing-specific keys
// (orderControllers, processControllerMappings, channelMappings,
// processFolderExceptions, processFolderPath, _migrated_v1) are written here.
const store = new Store({ name: 'routing' });

/**
 * src/main/services/routing-service.js
 *
 * Resolves the print routing destination for a job using a three-layer
 * decision tree:
 *
 *   1. Process Folder Exception — product code + options match → copy to folder
 *   2. Process → Controller mapping — job's process value must be assigned
 *   3. Channel Mapping — product code + options must have a channel for that controller
 *
 * If no valid route exists, returns { type: 'unrouted', reason } so the caller
 * can show the appropriate UI (Assign button or "Configure in Settings" message).
 *
 * All routing data is stored in the default electron-store under these keys:
 *   orderControllers         Controller[]
 *   processControllerMappings  ProcessMapping[]
 *   channelMappings          ChannelMapping[]
 *   processFolderExceptions  ProcessFolderException[]
 */

// ── Route resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the routing destination for a job.
 *
 * @param {object} job  - Job object from the OH API or job-service cache.
 *   Expected fields: product_code, options (Array<{name,value}>), process
 *
 * @returns {object} One of:
 *   { type: 'process-folder', folderPath }
 *   { type: 'controller', controllerId, controllerName, outputPath, channelNumber }
 *   { type: 'unrouted', reason: 'no-controller' | 'no-channel', controller? }
 */
function resolveRoute(job) {
  const productCode = job.product_code;
  const options     = job.options || [];
  const process     = job.process;

  // ── Channel Mapping Override (crop-to-size feature) ───────────────────────
  // If the user cropped an image and selected a target channel mapping,
  // _channelMappingOverride is stored on the job-service cache entry.
  // Override takes precedence over all three routing layers below so the
  // cropped image goes to the right controller/channel without further config.
  if (job._channelMappingOverride) {
    const allChannelMappings = store.get('channelMappings', []);
    const overrideMapping    = allChannelMappings.find(m => m.id === job._channelMappingOverride);

    if (overrideMapping) {
      const controllers  = store.get('orderControllers', []);
      const overrideCtrl = controllers.find(c => c.id === overrideMapping.controllerId);

      if (overrideCtrl) {
        if (overrideCtrl.type === 'frontline') {
          return {
            type:             'controller',
            controllerType:   'frontline',
            controllerId:     overrideCtrl.id,
            controllerName:   overrideCtrl.name,
            outputPath:       overrideCtrl.outputPath,
            device:           overrideCtrl.device     || 'Pixfizz',
            backPrint1:       overrideCtrl.backPrint1 || '{jobName}  {customerName}',
            backPrint2:       overrideCtrl.backPrint2 || '{jobId}  {filename}',
            batchCode:        overrideMapping.batchCode  || '',
            sortString:       overrideMapping.sortString || '',
            channelNumber:    null,
            printSizeCode:    null,
            bannerSheet:      false,
            checkOrderStatus: false,
          };
        }

        // DPOF and other controller types
        const printSizeCode = overrideMapping.printSizeCode ||
          (overrideMapping.size ? `NML -PSIZE "${overrideMapping.size}"` : 'KG');

        return {
          type:             'controller',
          controllerType:   overrideCtrl.type || 'dpof',
          controllerId:     overrideCtrl.id,
          controllerName:   overrideCtrl.name,
          outputPath:       overrideCtrl.outputPath,
          channelNumber:    overrideMapping.channelNumber,
          printSizeCode,
          bannerSheet:      overrideCtrl.bannerSheet      || false,
          skipAutoPrint:    overrideMapping.skipAutoPrint || false,
          checkOrderStatus: overrideCtrl.checkOrderStatus !== false,
        };
      }
    }
    // Override references a deleted mapping — log and fall through to normal routing.
    logger.logWarning('_channelMappingOverride references unknown mapping — falling through', {
      jobId:            job.id,
      channelMappingId: job._channelMappingOverride,
    });
  }

  // ── Layer 1: Process Folder Exception ────────────────────────────────────
  const exceptions = store.get('processFolderExceptions', []);
  const exception  = exceptions.find(e =>
    e.productCode === productCode && optionsMatch(e.options, options)
  );
  if (exception) {
    return { type: 'process-folder', folderPath: exception.folderPath };
  }

  // ── Layer 2: Process → Controller ────────────────────────────────────────
  const processMap     = store.get('processControllerMappings', []);
  // Trim whitespace AND strip any surrounding quote characters that the API
  // may embed in the process field value (e.g. "\"Lab\"" → "Lab").
  const processCleaned = (process || '').trim().replace(/^"|"$/g, '');

  console.log('[resolveRoute] job process raw:', JSON.stringify(job.process));
  console.log('[resolveRoute] job process cleaned:', JSON.stringify(processCleaned));
  console.log('[resolveRoute] stored mapping processes:', processMap.map(m => JSON.stringify((m.process || '').trim().replace(/^"|"$/g, ''))));

  const processMapping = processMap.find(
    m => (m.process || '').trim().replace(/^"|"$/g, '').toLowerCase() === processCleaned.toLowerCase()
  );

  console.log('[resolveRoute] processMapping found:', processMapping ? 'YES' : 'NO');

  // Helper: resolve to the default folder if one is configured, or mark truly unrouted.
  const defaultFolderFallback = () => {
    const defaultFolder = (store.get('processFolderPath') || '').trim();
    if (defaultFolder) return { type: 'default-folder', folderPath: defaultFolder };
    return { type: 'unrouted', reason: 'no-default-folder' };
  };

  if (!processMapping) {
    return defaultFolderFallback();
  }

  const controllers = store.get('orderControllers', []);
  const controller  = controllers.find(c => c.id === processMapping.controllerId);

  console.log('[resolveRoute] controllerId from mapping:', processMapping?.controllerId);
  console.log('[resolveRoute] controller found:', controller ? 'YES' : 'NO');

  if (!controller) {
    return defaultFolderFallback();
  }

  // ── PDF-copy controllers skip Layer 3 (no channel mapping needed) ────────
  if (controller.type === 'pdf_copy') {
    return {
      type:           'controller',
      controllerType: controller.type,
      controllerId:   controller.id,
      controllerName: controller.name,
      outputPath:     controller.outputPath,
      channelNumber:  null,
      printSizeCode:  null,
      bannerSheet:      controller.bannerSheet || false,
      pdfPipeline:      controller.pdfPipeline || null,
      checkOrderStatus: controller.checkOrderStatus !== false,
    };
  }

  // ── Folder-copy controllers skip Layer 3 (no channel mapping needed) ────────
  if (controller.type === 'folder_copy') {
    return {
      type:             'controller',
      controllerType:   'folder_copy',
      controllerId:     controller.id,
      controllerName:   controller.name,
      outputPath:       controller.outputPath,
      channelNumber:    null,
      printSizeCode:    null,
      bannerSheet:      false,
      checkOrderStatus: controller.checkOrderStatus !== false,
    };
  }

  // ── Darkroom Pro: look up channel mapping (Size/Media) — same Layer 3 logic as DPOF ──
  if (controller.type === 'darkroompro') {
    const channelMappings = store.get('channelMappings', []);

    // Per-job manual assignment takes priority over options-based lookup.
    // The renderer stores job._darkroomProChannelMappingId after the user picks
    // a mapping in the Assign modal.
    let channelMapping = job._darkroomProChannelMappingId
      ? channelMappings.find(m => m.id === job._darkroomProChannelMappingId && m.controllerId === controller.id)
      : null;

    // Fall back to options-based lookup (matches by productCode + jobOptions)
    if (!channelMapping) {
      channelMapping = channelMappings.find(m =>
        m.controllerId === controller.id &&
        m.productCode  === productCode   &&
        optionsMatch(m.options, options)
      );
    }

    // If no channel mapping was found, check whether the controller has translation
    // tables configured. If it does, Size and Media can be resolved automatically
    // at dispatch time — no manual assignment needed.
    if (!channelMapping) {
      // Per-job manual overrides stored by the Assign modal take priority —
      // if both are present the job is already assigned and ready to dispatch.
      if (job._darkroomProSize && job._darkroomProMedia) {
        // fall through to return a valid controller route
      } else {
        // No manual assignment — check whether translations can resolve Size and Media
        // for THIS specific job before declaring it auto-dispatchable.
        const resolvedSize  = resolveSize(job.product_code, controller.sizeTranslations);
        const resolvedMedia = resolveMedia(
          job.options || [],
          controller.mediaOptionKey,
          controller.mediaTranslations
        );
        if (!resolvedSize || !resolvedMedia) {
          // Cannot resolve one or both fields — surface the "Assign" button in the UI
          return { type: 'unrouted', reason: 'no-channel', controller };
        }
      }
    }

    return {
      type:                'controller',
      controllerType:      'darkroompro',
      controllerId:        controller.id,
      controllerName:      controller.name,
      outputPath:          controller.outputPath,
      artworkRootPath:     controller.artworkRootPath     || '',
      orderLastNameFormat: controller.orderLastNameFormat || 'orderRef_lastName',
      channelMappingId:    channelMapping ? channelMapping.id : null,
      channelNumber:       null,
      printSizeCode:       null,
      bannerSheet:         false,
      checkOrderStatus:    controller.checkOrderStatus !== false,
    };
  }

  // ── Frontline: look up channel mapping for batchCode + sortString ────────
  if (controller.type === 'frontline') {
    const channelMappings = store.get('channelMappings', []);
    const channelMapping  = channelMappings.find(m =>
      m.controllerId === controller.id &&
      m.productCode  === productCode   &&
      optionsMatch(m.options, options)
    );
    if (!channelMapping) {
      return { type: 'unrouted', reason: 'no-channel', controller };
    }
    return {
      type:             'controller',
      controllerType:   'frontline',
      controllerId:     controller.id,
      controllerName:   controller.name,
      outputPath:       controller.outputPath,
      device:           controller.device     || 'Pixfizz',
      backPrint1:       controller.backPrint1 || '{jobName}  {customerName}',
      backPrint2:       controller.backPrint2 || '{jobId}  {filename}',
      batchCode:        channelMapping.batchCode  || '',
      sortString:       channelMapping.sortString || '',
      channelNumber:    null,
      printSizeCode:    null,
      bannerSheet:      false,
      checkOrderStatus: false,  // Frontline is fire-and-forget
    };
  }

  // ── Layer 3: Channel Mapping ──────────────────────────────────────────────
  const channelMappings = store.get('channelMappings', []);
  const channelMapping  = channelMappings.find(m =>
    m.controllerId === controller.id &&
    m.productCode  === productCode   &&
    optionsMatch(m.options, options)
  );
  if (!channelMapping) {
    return { type: 'unrouted', reason: 'no-channel', controller };
  }

  // Derive printSizeCode from the channel mapping; fall back to NML or KG default
  const printSizeCode = channelMapping.printSizeCode ||
    (channelMapping.size ? `NML -PSIZE "${channelMapping.size}"` : 'KG');

  return {
    type:           'controller',
    controllerType: controller.type || 'dpof',
    controllerId:   controller.id,
    controllerName: controller.name,
    outputPath:     controller.outputPath,
    channelNumber:  channelMapping.channelNumber,
    printSizeCode,
    bannerSheet:      controller.bannerSheet || false,
    skipAutoPrint:    channelMapping.skipAutoPrint || false,
    checkOrderStatus: controller.checkOrderStatus !== false,
  };
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────
// These are thin wrappers used by the IPC handlers. All validation is the
// caller's responsibility (IPC handlers receive user input from the renderer).

// -- Order Controllers --------------------------------------------------------

function getControllers() {
  return store.get('orderControllers', []);
}

function saveController(controller) {
  const controllers = store.get('orderControllers', []);
  const idx = controllers.findIndex(c => c.id === controller.id);
  if (idx >= 0) {
    controllers[idx] = controller;          // update existing
  } else {
    controllers.push(controller);           // add new
  }
  store.set('orderControllers', controllers);

  // Read-back verification: confirm the write actually landed on disk.
  const saved = store.get('orderControllers', []);
  const savedCtrl = saved.find(c => c.id === controller.id);
  logger.info('[routing-service] saveController write-back verified', {
    id:             controller.id,
    name:           controller.name,
    storePath:      store.path,
    sizeTranslations:  savedCtrl ? (savedCtrl.sizeTranslations  || []).length : 'NOT FOUND',
    mediaTranslations: savedCtrl ? (savedCtrl.mediaTranslations || []).length : 'NOT FOUND',
  });
}

function deleteController(id) {
  const controllers = store.get('orderControllers', []);
  store.set('orderControllers', controllers.filter(c => c.id !== id));

  // Cascade: remove process mappings that pointed at this controller
  const processMappings = store.get('processControllerMappings', []);
  store.set('processControllerMappings', processMappings.filter(m => m.controllerId !== id));

  // Cascade: remove channel mappings that belonged to this controller
  const channelMappings = store.get('channelMappings', []);
  store.set('channelMappings', channelMappings.filter(m => m.controllerId !== id));
}

// -- Process → Controller Mappings -------------------------------------------

function getProcessMappings() {
  return store.get('processControllerMappings', []);
}

/**
 * Upsert a process → controller mapping.
 * Keyed by process name — one entry per process value.
 */
function saveProcessMapping(mapping) {
  // Strip surrounding quotes from the process key so stored keys are always
  // clean (e.g. "\"Wide Format\"" is saved as "Wide Format").
  const cleanProcess = (mapping.process || '').trim().replace(/^"|"$/g, '');
  const cleanedMapping = { ...mapping, process: cleanProcess };
  const mappings = store.get('processControllerMappings', []);
  const idx = mappings.findIndex(m => m.process === cleanProcess);
  if (idx >= 0) {
    mappings[idx] = cleanedMapping;
  } else {
    mappings.push(cleanedMapping);
  }
  store.set('processControllerMappings', mappings);
}

function deleteProcessMapping(process) {
  const mappings = store.get('processControllerMappings', []);
  store.set('processControllerMappings', mappings.filter(m => m.process !== process));
}

// -- Channel Mappings ---------------------------------------------------------

function getChannelMappings() {
  return store.get('channelMappings', []);
}

/**
 * Returns a unified list of configured print sizes from ALL controller types,
 * suitable for driving the Crop-to-Size dropdown in the Job Review panel.
 *
 * Sources:
 *   1. DPOF channel mappings  (channelMappings store, `size` field)
 *   2. Darkroom Pro           (controller.sizeTranslations[].darkroomSize)
 *
 * Each entry: { id, source, w, h, label, channelMappingId?, channelNumber?,
 *               darkroomSize?, darkroomControllerId? }
 */
function getAllSizeOptions() {
  const SIZE_RE = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i;

  function parseSize(str) {
    if (!str) return null;
    const m = String(str).match(SIZE_RE);
    if (!m) return null;
    return { w: parseFloat(m[1]), h: parseFloat(m[2]), label: `${m[1]}\u00d7${m[2]}"` };
  }

  const options = [];

  // Source 1: DPOF channel mappings
  for (const m of store.get('channelMappings', [])) {
    const sz = parseSize(m.size || m.printSizeCode || m.batchCode || '');
    if (!sz) continue;
    options.push({
      id:              `cm_${m.id}`,
      source:          'dpof',
      w:               sz.w,
      h:               sz.h,
      label:           sz.label,
      channelMappingId: m.id,
      channelNumber:   m.channelNumber,
    });
  }

  // Source 2: Darkroom Pro sizeTranslations
  for (const ctrl of store.get('orderControllers', [])) {
    if (ctrl.type !== 'darkroompro') continue;
    for (const t of (ctrl.sizeTranslations || [])) {
      const sz = parseSize(t.darkroomSize || '');
      if (!sz) continue;
      options.push({
        id:                  `dt_${ctrl.id}_${t.productCodePrefix}`,
        source:              'darkroom',
        w:                   sz.w,
        h:                   sz.h,
        label:               sz.label,
        darkroomSize:        t.darkroomSize,
        darkroomControllerId: ctrl.id,
        productCodePrefix:   t.productCodePrefix,
      });
    }
  }

  return options;
}

function saveChannelMapping(mapping) {
  const mappings = store.get('channelMappings', []);
  const idx = mappings.findIndex(m => m.id === mapping.id);
  if (idx >= 0) {
    mappings[idx] = mapping;
  } else {
    mappings.push(mapping);
  }
  store.set('channelMappings', mappings);
}

function deleteChannelMapping(id) {
  const mappings = store.get('channelMappings', []);
  store.set('channelMappings', mappings.filter(m => m.id !== id));
}

// -- Process Folder Exceptions ------------------------------------------------

function getExceptions() {
  return store.get('processFolderExceptions', []);
}

function saveException(exception) {
  const exceptions = store.get('processFolderExceptions', []);
  const idx = exceptions.findIndex(e => e.id === exception.id);
  if (idx >= 0) {
    exceptions[idx] = exception;
  } else {
    exceptions.push(exception);
  }
  store.set('processFolderExceptions', exceptions);
}

function deleteException(id) {
  const exceptions = store.get('processFolderExceptions', []);
  store.set('processFolderExceptions', exceptions.filter(e => e.id !== id));
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Returns true if every option in mappingOptions is present (by name + value)
 * in jobOptions. The job may carry additional options — partial match is fine.
 *
 * An empty mappingOptions array matches any job (no restrictions).
 *
 * @param {Array<{name:string, value:string}>} mappingOptions
 * @param {Array<{name:string, value:string}>} jobOptions
 * @returns {boolean}
 */
function optionsMatch(mappingOptions, jobOptions) {
  if (!Array.isArray(mappingOptions) || mappingOptions.length === 0) return true;
  return mappingOptions.every(mo =>
    jobOptions.some(jo => jo.name === mo.name && jo.value === mo.value)
  );
}

// ── Migrations ───────────────────────────────────────────────────────────────

/**
 * One-time migration: copy routing keys from the shared default config store
 * (config.json) into the dedicated routing store (routing.json) so they can no
 * longer be clobbered by config-service writes.
 *
 * The guard flag '_store_migrated_v1' is written to the routing store once the
 * copy is complete. The original keys are left in config.json (harmless — they
 * are simply ignored by routing-service going forward).
 *
 * Called before migrateFromPrintControllerStore so routing data is in place.
 */
function migrateRoutingStoreFile() {
  // Always log what's in the routing store on startup so we can verify persistence.
  const startupControllers = store.get('orderControllers', []);
  logger.info('[routing-service] startup: routing store loaded', {
    storePath:   store.path,
    controllers: startupControllers.map(c => ({
      id:               c.id,
      name:             c.name,
      sizeTranslations:  (c.sizeTranslations  || []).length,
      mediaTranslations: (c.mediaTranslations || []).length,
    })),
  });

  if (store.get('_store_migrated_v1', false)) return;

  try {
    // Read from the OLD default store (config.json).  This is a one-shot read;
    // we do NOT keep this instance alive.
    const oldStore = new Store(); // name defaults to 'config'

    const ROUTING_KEYS = [
      'orderControllers',
      'processControllerMappings',
      'channelMappings',
      'processFolderExceptions',
      'processFolderPath',
      '_migrated_v1',
    ];

    let copied = 0;
    for (const key of ROUTING_KEYS) {
      const value = oldStore.get(key);
      if (value !== undefined && !store.has(key)) {
        store.set(key, value);
        copied++;
      }
    }

    store.set('_store_migrated_v1', true);
    logger.info('routing-service: routing store file migrated from config.json', { keysCopied: copied });
  } catch (err) {
    logger.logError('routing-service: routing store file migration failed', err);
    // Do not set _store_migrated_v1 so it retries on next startup
  }
}

// ── Print-controller-store migration ─────────────────────────────────────────

/**
 * Auto-migrate existing DPOF print controllers and product mappings from the
 * old printControllerStore into the new routing-service data structures.
 *
 * Rules:
 *   - Darkroom Pro controllers are NOT migrated (they stay in printControllerStore).
 *   - Controller IDs are preserved so that existing dpof-state store entries
 *     (e.g. printed flags) and any printControllerStore lookups still resolve.
 *   - Flat options { key: val } are converted to [{ name, value }] arrays.
 *   - A guard flag '_migrated_v1' prevents the migration from running twice.
 *
 * Called once at application start from ipc-handlers.js.
 */
function migrateFromPrintControllerStore() {
  if (store.get('_migrated_v1', false)) return;

  let migrated = 0;

  try {
    // Lazy-require to avoid circular dependency at module load time
    const { printControllerStore } = require('./print-controller-store');
    const oldControllers = printControllerStore.getAllControllers();

    const orderControllers  = store.get('orderControllers',  []);
    const channelMappings   = store.get('channelMappings',   []);

    for (const old of oldControllers) {
      if (old.type === 'darkroompro') continue; // keep Darkroom Pro in old store only

      // Skip if already present (idempotent)
      if (!orderControllers.some(c => c.id === old.id)) {
        orderControllers.push({
          id:         old.id,
          name:       old.name,
          type:       old.type || 'dpof',
          outputPath: old.hotFolderPath || '',
        });
        migrated++;
      }

      // Migrate associated product mappings → channel mappings
      const productMappings = printControllerStore.getProductMappingsByController(old.id);
      for (const pm of productMappings) {
        if (channelMappings.some(m => m.id === pm.id)) continue;

        // Convert flat { key: val } options to [{ name, value }]
        const options = Object.entries(pm.options || {})
          .filter(([, v]) => v !== '' && v !== null && v !== undefined)
          .map(([name, value]) => ({ name, value }));

        channelMappings.push({
          id:            pm.id,
          controllerId:  pm.controllerId,
          productCode:   pm.productCode  || '',
          options,
          channelNumber: pm.channelNumber,
          size:          pm.size || '',   // preserved for DPOF generation
        });
      }
    }

    store.set('orderControllers', orderControllers);
    store.set('channelMappings',  channelMappings);
    store.set('_migrated_v1', true);

    if (migrated > 0) {
      logger.info('routing-service: migrated controllers from printControllerStore', {
        controllersAdded: migrated,
        channelMappings:  channelMappings.length,
      });
    } else {
      logger.info('routing-service: migration ran — no new controllers to migrate');
    }
  } catch (err) {
    logger.logError('routing-service: migration failed', err);
    // Do NOT set _migrated_v1 so it retries next startup
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  resolveRoute,
  migrateFromPrintControllerStore,
  // Controllers
  getControllers,
  saveController,
  deleteController,
  // Process mappings
  getProcessMappings,
  saveProcessMapping,
  deleteProcessMapping,
  // Channel mappings
  getChannelMappings,
  getAllSizeOptions,
  saveChannelMapping,
  deleteChannelMapping,
  // Process folder exceptions
  getExceptions,
  saveException,
  deleteException,
};
