'use strict';

const { printControllerStore } = require('./print-controller-store');
const { jobStore } = require('./job-store');
const { dpofGenerator } = require('./dpof-generator');
const { orderFolderWriter } = require('./order-folder-writer');
const { FolderMonitor } = require('./folder-monitor');
const { DarkroomProMonitor } = require('./darkroom-pro-monitor');
const { FujiJobMakerMonitor } = require('./fuji-jobmaker-monitor');
const routingService = require('./routing-service');
const { resolvePrintSizeCode } = routingService;
const logger = require('./logger');

class PrintControllerService {
  constructor() {
    // controllerId → FolderMonitor | DarkroomProMonitor | FujiJobMakerMonitor
    this.monitors = new Map();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Job submission (DPOF only — Darkroom Pro submission is handled by PrintService)
  // ─────────────────────────────────────────────────────────────────────────

  async submitJobToController(jobId) {
    const job = jobStore.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const controller = printControllerStore.getController(job.controllerId);
    if (!controller) throw new Error(`Controller ${job.controllerId} not found`);

    const mapping = printControllerStore.getProductMapping(job.mappingId);
    if (!mapping) throw new Error(`Product mapping ${job.mappingId} not found`);

    // Generate DPOF content. See routing-service.resolvePrintSizeCode for
    // the wrap/passthrough rules.
    const printSizeCode = resolvePrintSizeCode(mapping);
    const dpofContent = dpofGenerator.generate({
      orderNumber:   job.orderNumber  || '',
      customerName:  job.customerName || '',
      channelNumber: mapping.channelNumber,
      printSizeCode,
      images: (job.lineItems || []).map(li => ({ filename: li.filename, quantity: li.quantity })),
    });

    // Write order folder. Default the customer-surname flag on for back-compat
    // with controllers that pre-date this field.
    const folderPath = await orderFolderWriter.writeOrderFolder(
      controller.hotFolderPath,
      job.orderNumber,
      job.productCode,
      dpofContent,
      job.imageFiles,
      null,
      {
        includeCustomerName: controller.includeCustomerInFolder !== false,
        customerName:        job.customerName || '',
      }
    );

    // Update job status
    jobStore.updateJob(jobId, {
      dpofStatus: 'submitted',
      dpofSubmittedAt: new Date().toISOString(),
      dpofFolderPath: folderPath
    });

    return folderPath;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Monitoring — creates the right monitor type based on controller.type
  // ─────────────────────────────────────────────────────────────────────────

  startMonitoring(controllerId) {
    // v1.7.10: routing-service is the modern source of truth for controllers.
    // We look there first, then fall back to the legacy printControllerStore
    // so any pre-routing-service controllers (currently just a historical
    // Darkroom Pro entry on Richard's machine) keep working. Pre-v1.7.10
    // this path only consulted printControllerStore, which Fuji JobMaker
    // controllers were never written to — Process click crashed with
    // "Controller <id> not found". Same precedence pattern polling-service's
    // _startFolderMonitors already uses (polling-service.js:540-560).
    const controller =
      routingService.getControllers().find(c => c.id === controllerId)
      || printControllerStore.getController(controllerId);
    if (!controller) throw new Error(`Controller ${controllerId} not found`);

    if (this.monitors.has(controllerId)) {
      return; // Already monitoring
    }

    // routing-service entries carry `outputPath`; the legacy store carries
    // `hotFolderPath`. The Fuji controller currently carries both (same
    // value), but defending against either-only shapes keeps both call
    // paths above honest.
    const hotFolderPath = controller.hotFolderPath || controller.outputPath;

    // Darkroom Pro and Fuji JobMaker both emit { orderNumber, status, … }
    // (Fuji via the onFujiStatus wrapper below). DPOF FolderMonitor emits a
    // different shape { jobId, … } since the jobId folder-name change, so it
    // has its own wrapper (onDpofStatusChange) further down.
    const onStatusChange = (status) => {
      jobStore.updateJobStatus(status.orderNumber, status.status);
      logger.info(`Print job status changed`, {
        orderNumber: status.orderNumber,
        status: status.status,
        controller: controller.name
      });
    };

    const onDpofStatusChange = (status) => {
      logger.info(`Print job status changed`, {
        jobId: status.jobId,
        status: status.status,
        controller: controller.name
      });
    };

    if (controller.type === 'darkroompro') {
      // Darkroom Pro: watches for .TXT disappearance (accepted) or .err appearance (failed)
      const monitor = new DarkroomProMonitor();
      const processedFolderName = controller.processedFolderName || 'processed';
      monitor.startMonitoring(hotFolderPath, processedFolderName, onStatusChange);
      this.monitors.set(controllerId, monitor);

      logger.info('Started Darkroom Pro monitoring', {
        controller: controller.name,
        hotFolder: hotFolderPath,
        processedFolder: processedFolderName
      });
    } else if (controller.type === 'fujijobmaker') {
      // Fuji JobMaker: watches for .txt disappearance (accepted, Frontier
      // consumes the file) and runs a timeout sweep for stuck files. There is
      // no in-band failure signal — see docs/print-controllers/FUJI-JOBMAKER-FORMAT.md.
      const monitor = new FujiJobMakerMonitor();

      // Wrap onStatusChange to translate the Fuji event shape to the JobStore's
      // expected shape. Fuji emits per-file status (one event per .txt) with
      // 'accepted' or 'timed_out'. We map:
      //   'accepted'   → JobStore status 'accepted'
      //   'timed_out'  → JobStore status 'failed'   + warning log entry
      const onFujiStatus = (event) => {
        if (event.status === 'timed_out') {
          logger.warn('Fuji JobMaker submission stuck — file not consumed within failure timeout', {
            controller: controller.name,
            orderRef:  event.orderRef,
            surface:   event.surface,
            filename:  event.filename,
          });
        }
        onStatusChange({
          // The legacy callback signature uses `orderNumber`; preserve that.
          orderNumber: event.orderRef,
          status:      event.status === 'accepted' ? 'accepted' : 'failed',
          timestamp:   event.timestamp,
        });
      };

      monitor.startMonitoring(
        hotFolderPath,
        {
          failureTimeoutMs: controller.failureTimeoutMs,
          // sweepIntervalMs uses the monitor's default (60 s).
        },
        onFujiStatus
      );
      this.monitors.set(controllerId, monitor);

      logger.info('Started Fuji JobMaker monitoring', {
        controller: controller.name,
        hotFolder:  hotFolderPath,
        failureTimeoutMs: controller.failureTimeoutMs || 30 * 60 * 1000,
      });
    } else {
      // DPOF controllers (Noritsu, Epson): watches for folder prefix renames (o→e, o→q)
      const monitor = new FolderMonitor();
      monitor.startMonitoring(hotFolderPath, onDpofStatusChange);
      this.monitors.set(controllerId, monitor);

      logger.info('Started DPOF folder monitoring', {
        controller: controller.name,
        hotFolder: hotFolderPath
      });
    }
  }

  stopMonitoring(controllerId) {
    const monitor = this.monitors.get(controllerId);
    if (monitor) {
      monitor.stopMonitoring();
      this.monitors.delete(controllerId);
    }
  }

  stopAllMonitoring() {
    for (const monitor of this.monitors.values()) {
      monitor.stopMonitoring();
    }
    this.monitors.clear();
  }

  getMonitoringStatus(controllerId) {
    return this.monitors.has(controllerId);
  }

  getAllMonitoredControllers() {
    return Array.from(this.monitors.keys());
  }

  /**
   * Return the live monitor instance for a controller.
   * Used by PrintService to call trackSubmission() immediately after writing a file.
   */
  getMonitor(controllerId) {
    return this.monitors.get(controllerId) || null;
  }
}

const printControllerService = new PrintControllerService();
module.exports = { printControllerService, PrintControllerService };
