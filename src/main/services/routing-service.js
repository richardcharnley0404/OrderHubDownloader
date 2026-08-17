'use strict';

const Store  = require('electron-store');
const logger = require('./logger');
const { resolveSize, resolveMedia } = require('./darkroom-pro-output');
const { isBareWxH: _sharedIsBareWxH } = require('../../shared/printSizeShapes');

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

// ── Print Size Code resolution ────────────────────────────────────────────────

// Bare WxH shape — e.g. "4x6", "8 x 10", "4.5x6.5", "8×8", "8X8". These
// need to be wrapped as `NML -PSIZE "<W>x<H>"` (with whitespace stripped
// and Unicode × normalised to ASCII x) before Noritsu will accept them.
// Sourced from src/shared/printSizeShapes so the DPOF resolvePrintSizeCode
// read path, the legacy-`size` backfill, and the Fuji `printSize` save-
// time validator all use the SAME detector — the reason the regex lives
// in shared. Re-exported below so existing callers of
// `routing-service.isBareWxH` continue to work.
const isBareWxH = _sharedIsBareWxH;

/**
 * Resolve a channel mapping's print size code into the exact value emitted as
 * `PRT PSL=...` in the DPOF .mrk file.
 *
 * Noritsu controllers accept either a short standard code (`KG`, `2L`, `A4`,
 * `KGW`, `B`, ...) OR a wrapped size in the form `NML -PSIZE "<W>x<H>"`. A
 * bare size like `4x6` is NOT a valid PSL code and is rejected by the
 * controller.
 *
 * Operators may enter any of those forms in the Print Size Code field. This
 * helper centralises the "did the operator type a size or a code?" decision
 * so all callers emit valid PSL values.
 *
 * Resolution rules:
 *   - Blank → return `''` (empty). The caller's dispatch-time gate
 *     (print-service.js sendViaDPOFRouted) surfaces this as an operator-
 *     actionable error. Previously this branch silently fell back to
 *     `NML -PSIZE "<mapping.size>"` or `'KG'`; both defaults were removed
 *     so a mis-/un-configured mapping can't quietly print at the wrong
 *     size. The step-2 backfill migration copied bare-WxH legacy `size`
 *     values into `printSizeCode` so that removal is safe for existing
 *     installs. Save-time validation (see `validateDPOFPrintSizeCode` and
 *     the `ohd:routing:save-channel-mapping` IPC handler) prevents new
 *     blank mappings from being persisted.
 *   - Matches bare WxH (whitespace and Unicode × tolerated) → wrap as
 *     `NML -PSIZE "<W>x<H>"`, normalising Unicode × → ASCII x.
 *   - Anything else (standard codes, pre-formatted NML strings) → pass
 *     through unchanged.
 *
 * @param {object} mapping - Channel mapping with `printSizeCode` and (legacy) `size`.
 * @returns {string} The value to emit after `PRT PSL=`, or `''` if unset.
 */
function resolvePrintSizeCode(mapping) {
  const raw = (mapping.printSizeCode || '').trim();
  if (!raw) return '';
  if (isBareWxH(raw)) {
    const normalised = raw.replace(/\s+/g, '').replace(/×/g, 'x');
    return `NML -PSIZE "${normalised}"`;
  }
  return raw;
}

// ── Route resolution ──────────────────────────────────────────────────────────

// Dedup guard for the fujipicpro orderMergeWaitMinutes read-time
// coercion warn. resolveRoute runs on every auto-print cycle (10-60s
// depending on config) so warning-per-resolve on a single corrupt
// controller would produce ~1440 warns/day; dedup on
// `${controllerId}:${JSON.stringify(value)}` keeps operator-visible
// noise to one line per unique bad value per session. Cleared on
// module reload (app restart) so a subsequent misconfiguration after
// restart still surfaces.
const _picproWaitCoercionWarned = new Set();

/**
 * Read `controller.orderMergeWaitMinutes` at route resolution time,
 * clamping / defaulting per M1 (order-level-submission-picpro-brief).
 *
 * Rules:
 *   - `undefined` / `null` → default 30, silently. Both are the
 *     legitimate "use the default" states, not a misconfiguration.
 *   - integer in [1..1440]   → returned as-is, silently.
 *   - anything else (non-integer, out-of-range, wrong type) → default
 *     30 AND warn once per (controllerId, value). The IPC-boundary
 *     validator rejects these at save time, so a corrupt value at
 *     read time means either an older version wrote it, a direct
 *     JSON edit, or an external caller bypassed the guard — worth
 *     surfacing rather than silently coercing.
 */
function _readOrderMergeWaitMinutes(controller) {
  const raw = controller.orderMergeWaitMinutes;
  if (raw === undefined || raw === null) return 30;
  if (Number.isInteger(raw) && raw >= 1 && raw <= 1440) return raw;
  const key = `${controller.id}:${JSON.stringify(raw)}`;
  if (!_picproWaitCoercionWarned.has(key)) {
    _picproWaitCoercionWarned.add(key);
    logger.logWarning('[routing] fujipicpro orderMergeWaitMinutes coerced to default 30 — stored value is out of range or non-integer', {
      controllerId:          controller.id,
      name:                  controller.name,
      orderMergeWaitMinutes: raw,
      appliedDefault:        30,
    });
  }
  return 30;
}

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
        if (overrideCtrl.type === 'fujijobmaker') {
          if (!overrideMapping.surface || !overrideMapping.printCode) {
            // Mapping doesn't carry Fuji fields — fall through to normal routing.
            logger.logWarning('Fuji JobMaker channel mapping override is missing surface/printCode', {
              jobId:            job.id,
              channelMappingId: overrideMapping.id,
            });
          } else {
            const overrideSurfaceCode = overrideMapping.surfaceCode
              || (overrideMapping.surface ? overrideMapping.surface.charAt(0).toUpperCase() : '');

            return {
              type:              'controller',
              controllerType:    'fujijobmaker',
              controllerId:      overrideCtrl.id,
              controllerName:    overrideCtrl.name,
              outputPath:        overrideCtrl.outputPath,
              imageStagingRoot:  overrideCtrl.imageStagingRoot  || '',
              printerName:       overrideCtrl.printerName       || '',
              autoCorrect:       overrideCtrl.autoCorrect === undefined ? null : overrideCtrl.autoCorrect,
              backprintMode:     overrideCtrl.backprintMode     || 'none',
              backprintTemplate: overrideCtrl.backprintTemplate || '',
              surface:           overrideMapping.surface,
              surfaceCode:       overrideSurfaceCode,
              printCode:         overrideMapping.printCode,
              // M0: carry the mapping id + printSize so resolveTargetSize
              // can look up the crop aspect for Fuji routes. Blank on
              // legacy mappings — the amber routing-list badge flags them.
              channelMappingId:  overrideMapping.id,
              printSize:         overrideMapping.printSize || '',
              channelNumber:     null,
              printSizeCode:     null,
              bannerSheet:       false,
              checkOrderStatus:  overrideCtrl.checkOrderStatus !== false,
            };
          }
        }
        if (overrideCtrl.type === 'fujipicpro') {
          if (!overrideMapping.surface || !overrideMapping.printCode) {
            logger.logWarning('Fuji PIC Pro channel mapping override is missing surface/printCode', {
              jobId:            job.id,
              channelMappingId: overrideMapping.id,
            });
          } else {
            const overrideSurfaceCode = overrideMapping.surfaceCode
              || (overrideMapping.surface ? overrideMapping.surface.charAt(0).toUpperCase() : '');

            return {
              type:                'controller',
              controllerType:      'fujipicpro',
              controllerId:        overrideCtrl.id,
              controllerName:      overrideCtrl.name,
              orderDataPath:       overrideCtrl.orderDataPath    || '',
              diginPath:           overrideCtrl.diginPath        || '',
              mergeDataPath:       overrideCtrl.mergeDataPath    || '',
              imageStagingRoot:    overrideCtrl.imageStagingRoot || '',
              outputPath:          '',
              gatewayTimeoutMs:    Number.isFinite(overrideCtrl.gatewayTimeoutMs) ? overrideCtrl.gatewayTimeoutMs : 120000,
              buildTimeoutMs:      Number.isFinite(overrideCtrl.buildTimeoutMs)   ? overrideCtrl.buildTimeoutMs   : 1800000,
              sendReleaseCommand:  overrideCtrl.sendReleaseCommand === true,
              backprintMode:       overrideCtrl.backprintMode      || 'none',
              backprintTemplate:   overrideCtrl.backprintTemplate  || '',
              backprintTemplate2:  overrideCtrl.backprintTemplate2 || '',
              includeCustomerName: overrideCtrl.includeCustomerName === true,
              // M1 (order-level-submission-picpro-brief): kept in exact
              // parity with the main fujipicpro literal below. Coercion
              // helper handles the default and the warn-once-per-corrupt-
              // value log. Drift here silently breaks reassigned jobs on
              // this controller.
              mergeOrderJobs:        overrideCtrl.mergeOrderJobs === true,
              orderMergeWaitMinutes: _readOrderMergeWaitMinutes(overrideCtrl),
              // v1.13.0 — per-controller Strip Order Number Prefix.
              // String or ''; the stripping helper handles blank as
              // "no strip" so passing '' here is equivalent to absent.
              stripOrderNumberPrefix: typeof overrideCtrl.stripOrderNumberPrefix === 'string'
                ? overrideCtrl.stripOrderNumberPrefix : '',
              surface:             overrideMapping.surface,
              surfaceCode:         overrideSurfaceCode,
              printCode:           overrideMapping.printCode,
              color:               overrideMapping.color || 'C',
              channelMappingId:    overrideMapping.id,
              printSize:           overrideMapping.printSize || '',
              channelNumber:       null,
              printSizeCode:       null,
              bannerSheet:         false,
              checkOrderStatus:    overrideCtrl.checkOrderStatus !== false,
            };
          }
        }
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
        if (overrideCtrl.type === 'darkroompro') {
          // Mirror the shape returned by the darkroompro branch of the main
          // resolveRoute path below. Without this, a reassigned darkroompro
          // job fell into the DPOF fallthrough, silently losing
          // artworkRootPath and orderLastNameFormat on the route.
          // _sendViaDarkroomProRouted reads both directly off the route
          // (print-service.js:1983-1984), so their absence produced broken
          // artwork paths and default order-name formatting on the reassign
          // path. Every field carried here must stay in sync with the
          // main darkroompro literal — the override section has no shared
          // builder; see BACKLOG.
          return {
            type:                'controller',
            controllerType:      'darkroompro',
            controllerId:        overrideCtrl.id,
            controllerName:      overrideCtrl.name,
            outputPath:          overrideCtrl.outputPath,
            artworkRootPath:     overrideCtrl.artworkRootPath     || '',
            orderLastNameFormat: overrideCtrl.orderLastNameFormat || 'orderRef_lastName',
            channelMappingId:    overrideMapping.id,
            channelNumber:       null,
            printSizeCode:       null,
            bannerSheet:         false,
            checkOrderStatus:    overrideCtrl.checkOrderStatus !== false,
            maxPrintsPerJob:
              Number.isFinite(overrideCtrl.maxPrintsPerJob) && overrideCtrl.maxPrintsPerJob > 0
                ? overrideCtrl.maxPrintsPerJob
                : null,
            // M2 (2026-08-15): parity with the main darkroompro literal
            // below. Strict boolean coercion — anything not === true is
            // false. Feature only bites when a cap is also set.
            autoSendBatches: overrideCtrl.autoSendBatches === true,
          };
        }

        // DPOF and other controller types
        const printSizeCode = resolvePrintSizeCode(overrideMapping);

        const overrideRoute = {
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
          // DPOF folder-name option — default on for back-compat with controllers
          // that pre-date this field.
          includeCustomerInFolder: overrideCtrl.includeCustomerInFolder !== false,
        };
        // M5 of docs/epson-batch-splitting-brief.md — epson (and ONLY
        // epson) controllers carry the batch-splitting cap and the
        // auto-send tick, mirroring the darkroompro literal above.
        // Kept OFF noritsu and untyped-dpof deliberately: the release
        // is scoped to Epson OrderController, per the brief. Read-time
        // defaults match the DP literal (absent / non-numeric / ≤0 → null;
        // non-boolean → false).
        if (overrideCtrl.type === 'epson') {
          overrideRoute.maxPrintsPerJob =
            Number.isFinite(overrideCtrl.maxPrintsPerJob) && overrideCtrl.maxPrintsPerJob > 0
              ? overrideCtrl.maxPrintsPerJob
              : null;
          overrideRoute.autoSendBatches = overrideCtrl.autoSendBatches === true;
        }
        return overrideRoute;
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
  //
  // NOTE: This literal is DUPLICATED in resolveRouteForController below.
  // Both must produce the same shape for the same controller — the parity
  // test at __tests__/routing-service-folder-copy-parity.test.js locks
  // that (tripwire #2 of §11 of docs/folder-copy-filename-templates-
  // brief.md). When adding a field to one, add it to the other in the
  // same commit.
  if (controller.type === 'folder_copy') {
    return {
      type:                   'controller',
      controllerType:         'folder_copy',
      controllerId:           controller.id,
      controllerName:         controller.name,
      outputPath:             controller.outputPath,
      channelNumber:          null,
      printSizeCode:          null,
      bannerSheet:            false,
      checkOrderStatus:       controller.checkOrderStatus !== false,
      // M3 fields — read-time defaults ('' / 'job' / '') so a controller
      // record that predates M3 behaves exactly like today's Folder Copy.
      filenameTemplate:       (typeof controller.filenameTemplate === 'string') ? controller.filenameTemplate : '',
      destinationLayout:      controller.destinationLayout === 'root' ? 'root' : 'job',
      stripOrderNumberPrefix: (typeof controller.stripOrderNumberPrefix === 'string') ? controller.stripOrderNumberPrefix : '',
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
        optionsMatchWithIgnore(m.options, options, controller)
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
        // Media translation is only required when the controller has
        // mediaOptionKey configured. For fixed-size products without media
        // variation (e.g., cut prints where the product code IS the size),
        // size-alone routing is sufficient. Note: the dispatch-time writer
        // in darkroom-pro-output.js gates its own media validation on the
        // same mediaOptionKey signal — see generateDarkroomProFile.
        const mediaConfigured = !!controller.mediaOptionKey;
        if (!resolvedSize || (mediaConfigured && !resolvedMedia)) {
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
      // v1.10 batch-splitting cap (Darkroom Pro only for M1). Read-time default:
      // absent, non-numeric, zero or negative → null = feature off. No migration.
      maxPrintsPerJob:
        Number.isFinite(controller.maxPrintsPerJob) && controller.maxPrintsPerJob > 0
          ? controller.maxPrintsPerJob
          : null,
      // M2 (2026-08-15) auto-send-batches: when true AND a cap is set,
      // holdForReview suppresses the over-batch-threshold reason so
      // auto-print dispatches unattended and the existing splitter
      // writes {job_name}_1.txt, _2.txt… Strict === true coercion so
      // anything malformed defaults to false (feature off).
      autoSendBatches: controller.autoSendBatches === true,
    };
  }

  // ── Fuji JobMaker: look up channel mapping for printCode + surface ──────
  if (controller.type === 'fujijobmaker') {
    const channelMappings = store.get('channelMappings', []);
    const channelMapping  = channelMappings.find(m =>
      m.controllerId === controller.id &&
      m.productCode  === productCode   &&
      optionsMatchWithIgnore(m.options, options, controller)
    );
    if (!channelMapping) {
      return { type: 'unrouted', reason: 'no-channel', controller };
    }
    if (!channelMapping.surface || !channelMapping.printCode) {
      return { type: 'unrouted', reason: 'no-channel', controller };
    }

    const surfaceCode = channelMapping.surfaceCode
      || (channelMapping.surface ? channelMapping.surface.charAt(0).toUpperCase() : '');

    return {
      type:              'controller',
      controllerType:    'fujijobmaker',
      controllerId:      controller.id,
      controllerName:    controller.name,
      // hot folder where the .txt files are written; the controller field is
      // named `outputPath` for parity with every other controller type.
      outputPath:        controller.outputPath,
      imageStagingRoot:  controller.imageStagingRoot  || '',
      printerName:       controller.printerName       || '',
      autoCorrect:       controller.autoCorrect === undefined ? null : controller.autoCorrect,
      backprintMode:     controller.backprintMode     || 'none',
      backprintTemplate: controller.backprintTemplate || '',
      // Channel-resolved Fuji-specific fields — surfaced on the route so the
      // dispatch method doesn't need to re-query the channel store.
      surface:           channelMapping.surface,
      surfaceCode,
      printCode:         channelMapping.printCode,
      // M0: carry the mapping id + printSize so resolveTargetSize can
      // look up the crop aspect for Fuji routes without re-walking the
      // channel-mappings store. Blank printSize is left as-is; the
      // amber routing-list badge flags any legacy mapping that
      // couldn't be backfilled.
      channelMappingId:  channelMapping.id,
      printSize:         channelMapping.printSize || '',
      // Legacy DPOF route fields — not used by Fuji but kept null for shape parity.
      channelNumber:     null,
      printSizeCode:     null,
      bannerSheet:       false,
      checkOrderStatus:  controller.checkOrderStatus !== false,
    };
  }

  // ── Fuji PIC Pro: look up channel mapping for printCode + surface ─────
  //
  // Mirrors the JobMaker branch — same mapping shape (printCode +
  // printSize + surface + color) plus the three PIC Pro-specific paths
  // (orderData / digin / mergeData / staging) and the two timeouts. The
  // dispatch method (M5's _sendViaFujiPicProRouted) consumes this route
  // shape without re-querying the channel store.
  if (controller.type === 'fujipicpro') {
    const channelMappings = store.get('channelMappings', []);
    const channelMapping  = channelMappings.find(m =>
      m.controllerId === controller.id &&
      m.productCode  === productCode   &&
      optionsMatchWithIgnore(m.options, options, controller)
    );
    if (!channelMapping) {
      return { type: 'unrouted', reason: 'no-channel', controller };
    }
    if (!channelMapping.surface || !channelMapping.printCode) {
      return { type: 'unrouted', reason: 'no-channel', controller };
    }

    const surfaceCode = channelMapping.surfaceCode
      || (channelMapping.surface ? channelMapping.surface.charAt(0).toUpperCase() : '');

    return {
      type:                'controller',
      controllerType:      'fujipicpro',
      controllerId:        controller.id,
      controllerName:      controller.name,
      // PIC Pro's three explicit paths — each may live on a different
      // server, so we don't collapse them into a single root.
      orderDataPath:       controller.orderDataPath    || '',
      diginPath:           controller.diginPath        || '',
      mergeDataPath:       controller.mergeDataPath    || '',
      imageStagingRoot:    controller.imageStagingRoot || '',
      // outputPath kept for parity with the folder-copy shape callers
      // that read `route.outputPath` for logging. Empty for PIC Pro —
      // the three paths above are what the writer uses.
      outputPath:          '',
      // Timeouts + release-command toggle. Defaults live in fuji-pic-pro-
      // config; falling through to the same values here means a route
      // built from a stale controller (missing fields) still resolves
      // to sensible bounds instead of NaN.
      gatewayTimeoutMs:    Number.isFinite(controller.gatewayTimeoutMs) ? controller.gatewayTimeoutMs : 120000,
      buildTimeoutMs:      Number.isFinite(controller.buildTimeoutMs)   ? controller.buildTimeoutMs   : 1800000,
      sendReleaseCommand:  controller.sendReleaseCommand === true,
      // Back-print
      backprintMode:       controller.backprintMode      || 'none',
      backprintTemplate:   controller.backprintTemplate  || '',
      backprintTemplate2:  controller.backprintTemplate2 || '',
      includeCustomerName: controller.includeCustomerName === true,
      // M1 (order-level-submission-picpro-brief): read-time defaults.
      // `mergeOrderJobs` is strict-boolean so a truthy string/number in
      // the store can't silently enable merging. `orderMergeWaitMinutes`
      // resolution + warn-on-coercion sit in _readOrderMergeWaitMinutes;
      // null and undefined both mean "use the 30-minute default",
      // deliberately not treated as "wait forever" per the brief. Kept
      // identical to the _channelMappingOverride branch above; any
      // drift silently breaks reassigned jobs on this controller.
      mergeOrderJobs:        controller.mergeOrderJobs === true,
      orderMergeWaitMinutes: _readOrderMergeWaitMinutes(controller),
      // v1.13.0 — per-controller Strip Order Number Prefix. Kept in
      // exact parity with the override branch above. String or '';
      // stripOrderNumberPrefix in src/shared/printUtils treats blank
      // as "no strip".
      stripOrderNumberPrefix: typeof controller.stripOrderNumberPrefix === 'string'
        ? controller.stripOrderNumberPrefix : '',
      // Channel-resolved fields
      surface:             channelMapping.surface,
      surfaceCode,
      printCode:           channelMapping.printCode,
      color:               channelMapping.color || 'C',
      // M0: crop aspect
      channelMappingId:    channelMapping.id,
      printSize:           channelMapping.printSize || '',
      // Shape-parity nulls
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
      optionsMatchWithIgnore(m.options, options, controller)
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
    optionsMatchWithIgnore(m.options, options, controller)
  );
  if (!channelMapping) {
    return { type: 'unrouted', reason: 'no-channel', controller };
  }

  // Derive printSizeCode from the channel mapping. Wrapping/fallback logic
  // lives in resolvePrintSizeCode — see its docstring for the rules.
  const printSizeCode = resolvePrintSizeCode(channelMapping);

  const dpofRoute = {
    type:             'controller',
    controllerType:   controller.type || 'dpof',
    controllerId:     controller.id,
    controllerName:   controller.name,
    outputPath:       controller.outputPath,
    // M7 (missing-print-size-recovery): carried through so the Jobs
    // grid can open the specific mapping via "Fix mapping" when an
    // errored DPOF-family job is routed to a blank-print-size
    // mapping. Also mirrors what the darkroompro literal already sets
    // at :410. Only added to DPOF here + the DPOF branch of
    // resolveRouteForController — not the 19 other route literals.
    channelMappingId: channelMapping.id,
    channelNumber:    channelMapping.channelNumber,
    printSizeCode,
    bannerSheet:      controller.bannerSheet || false,
    skipAutoPrint:    channelMapping.skipAutoPrint || false,
    checkOrderStatus: controller.checkOrderStatus !== false,
    // DPOF folder-name option — default on for back-compat with controllers
    // that pre-date this field.
    includeCustomerInFolder: controller.includeCustomerInFolder !== false,
  };
  // M5 of docs/epson-batch-splitting-brief.md — epson controllers
  // now surface the batch-splitting cap and the auto-send tick, the
  // route fields M3's split dispatcher consults. Kept OFF the noritsu
  // and untyped-dpof paths deliberately — the brief scopes this
  // release to Epson OrderController. Symmetrical with the darkroompro
  // literal at Layer-3 above; same read-time defaults.
  if (controller.type === 'epson') {
    dpofRoute.maxPrintsPerJob =
      Number.isFinite(controller.maxPrintsPerJob) && controller.maxPrintsPerJob > 0
        ? controller.maxPrintsPerJob
        : null;
    dpofRoute.autoSendBatches = controller.autoSendBatches === true;
  }
  return dpofRoute;
}

// ── Routing-hold helpers (v1.7.8) ─────────────────────────────────────────────

/**
 * Return the set of process names currently flagged "Hold for manual release"
 * in Settings → Routing → Process Routing. Empty set when nothing is held.
 *
 * Caller threads this into computeHoldForReview() via ctx.routingHeldProcesses
 * — shared/holdForReview stays electron-store-free that way.
 *
 * Process names are normalised the same way saveProcessMapping normalises
 * (trim + strip surrounding quotes) so the lookup matches resolveRoute's
 * canonical key.
 */
function getRoutingHeldProcesses() {
  const mappings = store.get('processControllerMappings', []);
  return new Set(
    mappings
      .filter(m => m && m.hold === true)
      .map(m => (m.process || '').trim().replace(/^"|"$/g, ''))
      .filter(Boolean),
  );
}

/**
 * Resolve the route for a job AS IF it were routed to the supplied controller
 * id — used by the routing:releaseHold IPC handler when the operator reassigns
 * a held job to a different controller than the process→controller mapping
 * would normally pick.
 *
 * Returns the same shape resolveRoute() produces (controller / unrouted /
 * folder_copy / pdf_copy / no-channel). On `no-channel` the caller surfaces
 * the existing Assign-channel modal pre-filled for the new controller.
 *
 * Bypasses Layer 1 (process folder exception) and Layer 2 (process →
 * controller) entirely — the operator's controller choice is authoritative.
 *
 * @param {object} job
 * @param {string} controllerId
 */
function resolveRouteForController(job, controllerId) {
  const productCode = job.product_code;
  const options     = job.options || [];

  const controllers = store.get('orderControllers', []);
  const controller  = controllers.find(c => c.id === controllerId);
  if (!controller) {
    return { type: 'unrouted', reason: 'no-controller' };
  }

  // Folder-style controllers don't carry channel mappings.
  if (controller.type === 'pdf_copy') {
    return {
      type:             'controller',
      controllerType:   controller.type,
      controllerId:     controller.id,
      controllerName:   controller.name,
      outputPath:       controller.outputPath,
      channelNumber:    null,
      printSizeCode:    null,
      bannerSheet:      controller.bannerSheet || false,
      pdfPipeline:      controller.pdfPipeline || null,
      checkOrderStatus: controller.checkOrderStatus !== false,
    };
  }
  if (controller.type === 'folder_copy') {
    // NOTE: mirror of the folder_copy literal in resolveRoute above. Same
    // shape, same defaults, same order — parity test locks it. When adding
    // a field to one, add it to the other in the same commit.
    return {
      type:                   'controller',
      controllerType:         'folder_copy',
      controllerId:           controller.id,
      controllerName:         controller.name,
      outputPath:             controller.outputPath,
      channelNumber:          null,
      printSizeCode:          null,
      bannerSheet:            false,
      checkOrderStatus:       controller.checkOrderStatus !== false,
      filenameTemplate:       (typeof controller.filenameTemplate === 'string') ? controller.filenameTemplate : '',
      destinationLayout:      controller.destinationLayout === 'root' ? 'root' : 'job',
      stripOrderNumberPrefix: (typeof controller.stripOrderNumberPrefix === 'string') ? controller.stripOrderNumberPrefix : '',
    };
  }

  // DPOF + Darkroom Pro + Fuji + Frontline all need a channel mapping for
  // {productCode, options}. Missing → surface no-channel so the renderer
  // can chain into the existing Assign Channel modal.
  const channelMappings = store.get('channelMappings', []);
  const channelMapping  = channelMappings.find(m =>
    m.controllerId === controllerId &&
    m.productCode  === productCode   &&
    optionsMatch(m.options, options),
  );
  if (!channelMapping) {
    return { type: 'unrouted', reason: 'no-channel', controller };
  }

  // Mirror the Layer 3 return shape from resolveRoute (DPOF / Darkroom Pro
  // both consume this same shape downstream). Frontline / Fuji reassignment
  // can be added later if the use case emerges — v1.7.8 ships with the
  // generic DPOF/Darkroom shape since that's the Lab use case.
  const shape = {
    type:             'controller',
    controllerType:   controller.type || 'dpof',
    controllerId:     controller.id,
    controllerName:   controller.name,
    outputPath:       controller.outputPath,
    // M7 (missing-print-size-recovery): see the matching field on the
    // main resolveRoute Layer-3 DPOF literal for rationale. Kept
    // symmetric so a reassignment route resolved here carries the
    // same identifier as one resolved through the normal path.
    channelMappingId: channelMapping.id,
    channelNumber:    channelMapping.channelNumber,
    printSizeCode:    resolvePrintSizeCode(channelMapping),
    bannerSheet:      controller.bannerSheet || false,
    skipAutoPrint:    channelMapping.skipAutoPrint || false,
    checkOrderStatus: controller.checkOrderStatus !== false,
    includeCustomerInFolder: controller.includeCustomerInFolder !== false,
  };
  // Batch-splitting cap — Darkroom Pro (v1.10) and Epson (M5 of
  // docs/epson-batch-splitting-brief.md). Kept off noritsu and
  // untyped-dpof deliberately — no splitter behaviour for those types
  // yet, and advertising the field would let holdForReview raise a
  // reason a downstream dispatcher can't act on.
  if (controller.type === 'darkroompro' || controller.type === 'epson') {
    shape.maxPrintsPerJob =
      Number.isFinite(controller.maxPrintsPerJob) && controller.maxPrintsPerJob > 0
        ? controller.maxPrintsPerJob
        : null;
    // M2 (2026-08-15) DP + M5 epson: mirror the two resolveRoute
    // literals so a reassignment-time route carries the same shape
    // as one resolved through the normal path. Drift on any branch
    // would silently split-and-hold jobs the operator opted OUT of
    // reviewing.
    shape.autoSendBatches = controller.autoSendBatches === true;
  }
  return shape;
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
  const cleanedMapping = {
    ...mapping,
    process: cleanProcess,
    // v1.7.8: "Hold for manual release" flag. Sanitise to a strict boolean
    // so absent / undefined / "false"-as-string can't silently leak in as
    // truthy. Default is false (no hold) on fresh mappings.
    hold: mapping.hold === true,
  };
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
 *   3. Fuji-family mappings   (channelMappings store, `printSize` field —
 *                              M0 field; drives Manual Crop aspect only)
 *
 * Each entry: { id, source, w, h, label, channelMappingId?, channelNumber?,
 *               darkroomSize?, darkroomControllerId?, controllerId? }
 */
function getAllSizeOptions() {
  const SIZE_RE = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i;

  function parseSize(str) {
    if (!str) return null;
    const m = String(str).match(SIZE_RE);
    if (!m) return null;
    return { w: parseFloat(m[1]), h: parseFloat(m[2]), label: `${m[1]}\u00d7${m[2]}"` };
  }

  const options            = [];
  const mappings           = store.get('channelMappings',  []);
  const controllers        = store.get('orderControllers', []);
  const controllerTypeById = new Map(
    controllers.map(c => [c.id, c && c.type ? String(c.type) : ''])
  );

  // Source 1: DPOF channel mappings. Fuji-family mappings are excluded
  // here because their crop aspect lives in the dedicated `printSize`
  // field (Source 3 below) \u2014 reading it out of `size` / `printSizeCode`
  // / `batchCode` would silently paper over a missing printSize with
  // whatever else happens to parse.
  for (const m of mappings) {
    const type = controllerTypeById.get(m.controllerId) || '';
    if (FUJI_FAMILY_CONTROLLER_TYPES.has(type)) continue;
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
  for (const ctrl of controllers) {
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

  // Source 3: Fuji-family channel mappings (M0). Blank or unparseable
  // printSize is skipped here \u2014 those surface via the amber "No print
  // size" badge on the routing list instead of contributing a silently-
  // wrong crop aspect.
  for (const m of mappings) {
    const type = controllerTypeById.get(m.controllerId) || '';
    if (!FUJI_FAMILY_CONTROLLER_TYPES.has(type)) continue;
    const sz = parseSize(m.printSize || '');
    if (!sz) continue;
    options.push({
      id:               `cm_${m.id}`,
      source:           'fuji',
      w:                sz.w,
      h:                sz.h,
      label:            sz.label,
      channelMappingId: m.id,
      controllerId:     m.controllerId,
    });
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

/**
 * Per-controller "ignore these option names when matching" support.
 *
 * Some products are sent every variant/option (finish, layout, border, image
 * enhancement, foam-core mounting, shopify_* ids, …) but only one or two of
 * those actually distinguish the print route. For a cut-print controller, for
 * example, only `finish-options` matters; `layout-options` is noise that
 * varies per job and would otherwise force a channel mapping to match an exact
 * combination (or send the job to manual Assign).
 *
 * A controller may declare `ignoredOptionNames: string[]`. Any option whose
 * `name` (case-insensitive, trimmed) is on that list is stripped from BOTH the
 * mapping and the job before `optionsMatch` runs, so a mapping that still
 * carries the ignored option as documentation no longer *requires* it, and a
 * job with a differing value for it still matches.
 *
 * Default is an empty/absent list → byte-identical to the previous matcher, so
 * existing controllers and channel mappings behave exactly as before. The
 * filter is scoped to the resolved controller, so enabling it on one controller
 * cannot affect any other controller, process, or site.
 */
function controllerIgnoreSet(controller) {
  const list = controller && Array.isArray(controller.ignoredOptionNames)
    ? controller.ignoredOptionNames
    : [];
  return new Set(
    list.map(n => String(n == null ? '' : n).trim().toLowerCase()).filter(Boolean)
  );
}

function optionsMatchWithIgnore(mappingOptions, jobOptions, controller) {
  const ignore = controllerIgnoreSet(controller);
  if (ignore.size === 0) return optionsMatch(mappingOptions, jobOptions);
  const strip = opts =>
    (Array.isArray(opts) ? opts : []).filter(
      o => o && !ignore.has(String(o.name == null ? '' : o.name).trim().toLowerCase())
    );
  return optionsMatch(strip(mappingOptions), strip(jobOptions));
}

// ── Migrations ───────────────────────────────────────────────────────────────

// Routing keys that originally lived in config.json but now live exclusively
// in routing.json. Defined once so the migrate-in (`migrateRoutingStoreFile`)
// and the strip-out (`stripDeprecatedConfigJsonKeys`) functions agree on the
// list — adding a key in only one place would either skip migration or skip
// cleanup, both subtle bugs.
const LEGACY_ROUTING_KEYS = [
  'orderControllers',
  'processControllerMappings',
  'channelMappings',
  'processFolderExceptions',
  'processFolderPath',
  '_migrated_v1',
];

/**
 * One-time migration: copy routing keys from the shared default config store
 * (config.json) into the dedicated routing store (routing.json) so they can no
 * longer be clobbered by config-service writes.
 *
 * The guard flag '_store_migrated_v1' is written to the routing store once the
 * copy is complete. The original keys in config.json are subsequently
 * stripped by `stripDeprecatedConfigJsonKeys` (separate one-time pass) — they
 * were previously left in place "as harmless leftovers" but they actively
 * misled debugging, so they're now removed and the file gets a deprecation
 * marker pointing at routing.json.
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

    let copied = 0;
    for (const key of LEGACY_ROUTING_KEYS) {
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

/**
 * One-time cleanup: strip the (now-deprecated) routing keys out of
 * config.json and stamp a deprecation marker so future debuggers don't get
 * misled by stale duplicates.
 *
 * Background: when routing data was extracted into its own electron-store
 * file (`routing.json`) via `migrateRoutingStoreFile`, the original keys
 * were left in `config.json` as a precaution. They turned out to be a
 * debugging hazard — operators (and humans assisting them) would open
 * config.json, find an `orderControllers` array with stale entries, and
 * spend hours chasing a discrepancy with the live routing.json before
 * realising config.json hadn't been read at runtime since the migration.
 *
 * This pass is gated on its own flag (`_config_routing_keys_stripped_v1`,
 * stored in routing.json) so it runs at most once even on installations
 * that already completed the original migration. Safe to run multiple
 * times in principle — `delete` on a non-existent key is a no-op — but
 * the flag avoids the file write on every startup once it's done.
 */
function stripDeprecatedConfigJsonKeys() {
  if (store.get('_config_routing_keys_stripped_v1', false)) return;

  try {
    const oldStore = new Store(); // name defaults to 'config'

    let stripped = 0;
    for (const key of LEGACY_ROUTING_KEYS) {
      if (oldStore.has(key)) {
        oldStore.delete(key);
        stripped++;
      }
    }

    // Stamp a marker so anyone who opens config.json sees immediately that
    // routing data lives elsewhere now. Cheap insurance against future
    // confusion. The exact value isn't read by anything — its presence is
    // the signal.
    oldStore.set('_DEPRECATED_ROUTING_KEYS_SEE_ROUTING_JSON', true);

    store.set('_config_routing_keys_stripped_v1', true);
    logger.info('routing-service: stripped deprecated routing keys from config.json', {
      keysStripped:   stripped,
      configPath:     oldStore.path,
      routingPath:    store.path,
    });
  } catch (err) {
    logger.logError('routing-service: stripping deprecated config.json keys failed', err);
    // Do not set the flag so it retries on next startup
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

// ── Legacy `size` → `printSizeCode` backfill ─────────────────────────────────

// Controller types that do NOT consult `size` / `printSizeCode` at all.
// The backfill below is DPOF/Noritsu-only; every other type derives its
// print size from its own dedicated fields. Sourced from src/shared so
// the save-time validator (`validateDPOFPrintSizeCode`), both backfills,
// and configHealth.findUnroutableMappings all see the same list.
const { NON_DPOF_CONTROLLER_TYPES } = require('../../shared/controllerTypes');

/**
 * Save-time validation for `printSizeCode` on DPOF/Noritsu channel
 * mappings. For a DPOF-family controller, `printSizeCode` must be
 * non-blank — otherwise the dispatch gate in print-service will reject
 * every job routed through this mapping and the operator will only see
 * it at print time. Fail here so it can be fixed before the mapping is
 * persisted.
 *
 * The legacy `mapping.size` field is NOT accepted as a substitute (M3
 * of missing-print-size-recovery — the pre-M3 `|| size` fallback let a
 * mapping with `size='KG'` and blank `printSizeCode` save cleanly, then
 * fail loudly at dispatch because `resolvePrintSizeCode` reads only
 * `printSizeCode`. Badge + validator + resolver now all agree). The
 * bare-WxH backfill (`backfillLegacyPrintSizeCode`) still copies safe
 * legacy `size` values into `printSizeCode` at startup so existing
 * DPOF-family mappings whose legacy `size` was a bare WxH shape keep
 * passing this validator after the tightening.
 *
 * Scope: mappings whose controller type is NOT one of the non-DPOF
 * types (darkroompro / fujijobmaker / fujipicpro / frontline /
 * folder_copy / pdf_copy). Non-DPOF types get their size from their
 * own dedicated fields and are validated elsewhere (or don't need a
 * print size at all).
 *
 * Covers both the modal save path AND the CSV import path — both go
 * through `ohd:routing:save-channel-mapping`, so this is the single
 * server-side chokepoint.
 *
 * Called from `ipc-handlers.js` alongside the Fuji-specific validator.
 *
 * @param {object}  mapping        - The channel mapping being saved.
 * @param {string=} controllerType - Type of the parent controller (from
 *                                   routingService.getControllers()), or
 *                                   '' if the controller is unknown.
 * @returns {{ valid: true }
 *          | { valid: false, error: string }}
 */
function validateDPOFPrintSizeCode(mapping, controllerType) {
  if (NON_DPOF_CONTROLLER_TYPES.has(String(controllerType || ''))) {
    return { valid: true };
  }
  const raw = mapping
    ? String(mapping.printSizeCode != null ? mapping.printSizeCode : '').trim()
    : '';
  if (!raw) {
    return {
      valid: false,
      error: 'Print Size Code is required — it sets the print size for this product code.',
    };
  }
  return { valid: true };
}

/**
 * One-time backfill: copy legacy `mapping.size` into `mapping.printSizeCode`
 * for DPOF/Noritsu channel mappings whose `printSizeCode` is blank AND
 * whose legacy `size` is a bare WxH shape (e.g. "4x6", "8 x 10", "8×8").
 *
 * Historically Noritsu mappings carried a bare `size` which
 * `resolvePrintSizeCode` wrapped as `NML -PSIZE "<W>x<H>"` at read time via a
 * legacy-`size` fallback. The modern schema treats `printSizeCode` as the
 * single source of truth and a follow-up commit will drop that fallback
 * (along with the `'KG'` default). This backfill copies bare-WxH legacy
 * values into `printSizeCode` verbatim so existing mappings keep resolving
 * to the same PSL string after the fallback goes away — `resolvePrintSizeCode`
 * already wraps bare WxH values, so no pre-wrapping is needed here.
 *
 * Why bare-WxH only: `resolvePrintSizeCode` guarantees byte-identical output
 * before-and-after backfill ONLY when the legacy `size` matches the shape
 * `isBareWxH` recognises. For any other legacy value (e.g. a short code like
 * "KG" that was mis-stored in the `size` field), the two paths would diverge:
 *   legacy fallback →  `NML -PSIZE "KG"`   (wraps whatever's in `size`)
 *   backfilled path →  `KG`                (pass-through for non-WxH input)
 * Backfilling a non-WxH legacy value would therefore silently change what the
 * printer receives — the exact regression this commit is meant to prevent.
 * Such mappings are left blank instead so the step-1 dispatch gate fires with
 * a clear message; a per-mapping warning is logged so operators (and the
 * step-4 routing-list badge) can flag them for manual fixing.
 *
 * Scope: mappings whose controller type is NOT one of
 *   darkroompro / fujijobmaker / frontline / folder_copy / pdf_copy
 * — those types don't consult either field. Mappings pointing at an unknown
 * controllerId are treated as DPOF-shaped (type defaults to ''), which
 * matches what `resolvePrintSizeCode` does at runtime.
 *
 * Mappings that already have a `printSizeCode` are left untouched. Mappings
 * with neither `printSizeCode` nor legacy `size` are left blank — the
 * step-1 dispatch gate covers those the same way as the skipped non-WxH ones.
 *
 * Idempotent: guarded by `_backfill_print_size_v1` in the routing store.
 * A second run also finds nothing to backfill even if the flag is cleared,
 * because the eligibility condition (blank `printSizeCode` + bare-WxH
 * `size`) is false for every mapping after the first pass.
 *
 * Called once at application start from ipc-handlers.js after
 * `migrateFromPrintControllerStore` so the backfill sees any freshly-
 * migrated mappings.
 */
function backfillLegacyPrintSizeCode() {
  if (store.get('_backfill_print_size_v1', false)) return;

  try {
    const controllers = store.get('orderControllers', []);
    const mappings    = store.get('channelMappings',  []);

    const controllerTypeById = new Map(
      controllers.map(c => [c.id, c && c.type ? String(c.type) : ''])
    );

    let backfilled    = 0;
    let skippedNonWxH = 0;
    let unfixable     = 0;
    const nextMappings = mappings.map(m => {
      const type = controllerTypeById.get(m.controllerId) || '';
      if (NON_DPOF_CONTROLLER_TYPES.has(type)) return m;

      const existing = String(m.printSizeCode || '').trim();
      if (existing) return m;

      const legacy = String(m.size || '').trim();
      if (!legacy) {
        // M4 (missing-print-size-recovery): DPOF-family mapping with
        // BOTH `printSizeCode` and legacy `size` blank. Pre-M4 this
        // returned silently and 40 unfixable mappings on a real install
        // looked identical to a healthy one in the completion summary —
        // the operator only found out at dispatch when every routed
        // job failed the print-size gate. Count them so the summary
        // can name the problem and the follow-up warn log can flag it.
        // Eligibility is unchanged (still returns the mapping as-is,
        // still no backfill) — this is observability only.
        unfixable++;
        return m;
      }

      if (!isBareWxH(legacy)) {
        // Non-WxH legacy value — see docblock. Warn per mapping so the
        // operator can find and fix it (the entry also lands in error.log
        // via winston's error-level split... actually logWarning is warn-
        // level, which stays in app.log). Keep the log key names stable —
        // the step-4 routing-list badge will grep for these.
        skippedNonWxH++;
        logger.logWarning('routing-service: legacy channel-mapping size is not WxH — not backfilled', {
          channelMappingId: m.id,
          controllerId:     m.controllerId,
          productCode:      m.productCode || '',
          legacySize:       legacy,
        });
        return m;
      }

      backfilled++;
      return { ...m, printSizeCode: legacy };
    });

    if (backfilled > 0) {
      store.set('channelMappings', nextMappings);
    }
    store.set('_backfill_print_size_v1', true);

    logger.info('routing-service: printSizeCode backfill complete', {
      backfilled,
      skippedNonWxH,
      unfixable,
      totalMappings: mappings.length,
    });

    // M4: warn-level summary when any DPOF-family mapping is unfixable.
    // The info-level completion line above is easy to miss in a healthy
    // install; a warn-level line with `unfixable` in the fields is what
    // grep in support triage catches. The routing-list amber badge,
    // Settings roll-up (M6), and startup banner (M6) surface the same
    // information to the operator in the UI.
    if (unfixable > 0) {
      logger.logWarning('routing-service: DPOF-family mappings need a Print Size Code — they will fail at dispatch', {
        unfixable,
        totalMappings: mappings.length,
      });
    }
  } catch (err) {
    logger.logError('routing-service: printSizeCode backfill failed', err);
    // Do NOT set the flag so it retries next startup
  }
}

// ── Fuji printSize backfill ──────────────────────────────────────────────────

// Controller types whose channel mappings gained the new `printSize` field
// in the M0 migration. `fujipicpro` is included so that when M1 registers
// the new type, any mapping already in the store (from a fresh install run
// under a dev build, say) is picked up by the same backfill pass.
const FUJI_FAMILY_CONTROLLER_TYPES = new Set(['fujijobmaker', 'fujipicpro']);

/**
 * One-time backfill: copy a bare-WxH `mapping.printCode` into `mapping.printSize`
 * for Fuji-family channel mappings whose `printSize` is blank.
 *
 * Background: pre-M0 Fuji mappings only carried `printCode` (a Frontier
 * Quick Print code like `4x6` or `3.5x5` for JobMaker; a lab-defined
 * package code for PIC Pro). That value was never used to drive the
 * Manual Crop aspect ratio — `resolveTargetSize` had no Fuji branch and
 * silently fell back to a 1:1 square. The new `printSize` field feeds
 * `resolveTargetSize` (and `getAllSizeOptions`) so Fuji jobs crop at the
 * right aspect.
 *
 * The vast majority of existing JobMaker `printCode` values happen to
 * already be bare WxH, so copying them across is safe and preserves the
 * operator's intent. Anything that isn't bare WxH (a code the lab
 * assigned, e.g. `KG`) is left blank and logged so operators (and the
 * M0.6 amber badge) surface it for manual fixing.
 *
 * Scope: mappings whose controller type is in `FUJI_FAMILY_CONTROLLER_TYPES`.
 * Non-Fuji types get their crop aspect from other sources and must be
 * skipped so the backfill can't clobber their data.
 *
 * Mappings that already have a non-blank `printSize` are left untouched.
 * Mappings with neither `printSize` nor a bare-WxH `printCode` are left
 * blank — the M0.6 badge covers them.
 *
 * Idempotent: guarded by `_backfill_fuji_print_size_v1` in the routing
 * store. Even without the flag the eligibility condition (blank
 * `printSize` + bare-WxH `printCode`) is false for every mapping after
 * the first pass — same shape as `backfillLegacyPrintSizeCode`.
 *
 * Called once at application start from ipc-handlers.js, alongside the
 * DPOF backfill.
 */
function backfillFujiPrintSize() {
  if (store.get('_backfill_fuji_print_size_v1', false)) return;

  try {
    const controllers = store.get('orderControllers', []);
    const mappings    = store.get('channelMappings',  []);

    const controllerTypeById = new Map(
      controllers.map(c => [c.id, c && c.type ? String(c.type) : ''])
    );

    let backfilled       = 0;
    let skippedNonWxH    = 0;
    let unfixable        = 0;
    const nextMappings = mappings.map(m => {
      const type = controllerTypeById.get(m.controllerId) || '';
      if (!FUJI_FAMILY_CONTROLLER_TYPES.has(type)) return m;

      const existing = String(m.printSize || '').trim();
      if (existing) return m;

      const printCode = String(m.printCode || '').trim();
      if (!printCode) {
        // M4 (missing-print-size-recovery): Fuji-family mapping with
        // BOTH `printSize` and `printCode` blank — no source at all
        // to derive the crop aspect from. Pre-M4 this returned silently
        // and the operator only found out later when Manual Crop
        // silently fell back to a 1:1 square. Count so the summary
        // exposes the problem. Eligibility unchanged — observability
        // only.
        unfixable++;
        return m;
      }

      if (!isBareWxH(printCode)) {
        skippedNonWxH++;
        logger.logWarning('routing-service: Fuji channel-mapping printCode is not WxH — printSize not backfilled', {
          channelMappingId: m.id,
          controllerId:     m.controllerId,
          controllerType:   type,
          productCode:      m.productCode || '',
          printCode,
        });
        return m;
      }

      backfilled++;
      return { ...m, printSize: printCode };
    });

    if (backfilled > 0) {
      store.set('channelMappings', nextMappings);
    }
    store.set('_backfill_fuji_print_size_v1', true);

    logger.info('routing-service: Fuji printSize backfill complete', {
      backfilled,
      skippedNonWxH,
      unfixable,
      totalMappings: mappings.length,
    });

    // M4: warn-level summary when any Fuji-family mapping is unfixable.
    // Same rationale as backfillLegacyPrintSizeCode's warn — the
    // info-level completion line disappears in a healthy install; a
    // warn-level line with `unfixable` in the fields is what grep in
    // support triage catches.
    if (unfixable > 0) {
      logger.logWarning('routing-service: Fuji-family mappings need a Print Size or Print Code — Manual Crop will fall back to a square', {
        unfixable,
        totalMappings: mappings.length,
      });
    }
  } catch (err) {
    logger.logError('routing-service: Fuji printSize backfill failed', err);
    // Do NOT set the flag so it retries next startup
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  resolveRoute,
  resolveRouteForController,
  resolvePrintSizeCode,
  isBareWxH,
  optionsMatchWithIgnore,
  getRoutingHeldProcesses,
  migrateFromPrintControllerStore,
  backfillLegacyPrintSizeCode,
  backfillFujiPrintSize,
  validateDPOFPrintSizeCode,
  stripDeprecatedConfigJsonKeys,
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
