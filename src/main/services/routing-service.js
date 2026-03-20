'use strict';

const Store  = require('electron-store');
const store  = new Store();
const logger = require('./logger');

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
  const processMapping = processMap.find(
    m => (m.process || '').trim().replace(/^"|"$/g, '') === processCleaned
  );
  if (!processMapping) {
    return { type: 'unrouted', reason: 'no-controller' };
  }

  const controllers = store.get('orderControllers', []);
  const controller  = controllers.find(c => c.id === processMapping.controllerId);
  if (!controller) {
    return { type: 'unrouted', reason: 'no-controller' };
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
      bannerSheet:    controller.bannerSheet || false,
      pdfPipeline:    controller.pdfPipeline || null,
    };
  }

  // ── Folder-copy and Darkroom Pro controllers skip Layer 3 (no channel mapping needed) ─────
  if (controller.type === 'folder_copy' || controller.type === 'darkroompro') {
    return {
      type:           'controller',
      controllerType: controller.type,
      controllerId:   controller.id,
      controllerName: controller.name,
      outputPath:     controller.outputPath,
      channelNumber:  null,
      printSizeCode:  null,
      bannerSheet:    false,
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
    bannerSheet:    controller.bannerSheet || false,
    skipAutoPrint:  channelMapping.skipAutoPrint || false,
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

// -- Channel Mappings ---------------------------------------------------------

function getChannelMappings() {
  return store.get('channelMappings', []);
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

// ── One-time migration from printControllerStore ──────────────────────────────

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
  // Channel mappings
  getChannelMappings,
  saveChannelMapping,
  deleteChannelMapping,
  // Process folder exceptions
  getExceptions,
  saveException,
  deleteException,
};
