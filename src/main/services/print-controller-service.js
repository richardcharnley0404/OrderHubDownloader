'use strict';

const { printControllerStore } = require('./print-controller-store');
const { jobStore } = require('./job-store');
const { dpofGenerator } = require('./dpof-generator');
const { orderFolderWriter } = require('./order-folder-writer');
const { FolderMonitor } = require('./folder-monitor');
const { DarkroomProMonitor } = require('./darkroom-pro-monitor');
const logger = require('./logger');

class PrintControllerService {
  constructor() {
    // controllerId → FolderMonitor | DarkroomProMonitor
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

    // Generate DPOF content
    const printSizeCode = mapping.printSizeCode ||
      (mapping.size ? `NML -PSIZE "${mapping.size}"` : 'KG');
    const dpofContent = dpofGenerator.generate({
      orderNumber:   job.orderNumber  || '',
      customerName:  job.customerName || '',
      channelNumber: mapping.channelNumber,
      printSizeCode,
      images: (job.lineItems || []).map(li => ({ filename: li.filename, quantity: li.quantity })),
    });

    // Write order folder
    const folderPath = await orderFolderWriter.writeOrderFolder(
      controller.hotFolderPath,
      job.orderNumber,
      job.productCode,
      dpofContent,
      job.imageFiles
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
    const controller = printControllerStore.getController(controllerId);
    if (!controller) throw new Error(`Controller ${controllerId} not found`);

    if (this.monitors.has(controllerId)) {
      return; // Already monitoring
    }

    const onStatusChange = (status) => {
      jobStore.updateJobStatus(status.orderNumber, status.status);
      logger.info(`Print job status changed`, {
        orderNumber: status.orderNumber,
        status: status.status,
        controller: controller.name
      });
    };

    if (controller.type === 'darkroompro') {
      // Darkroom Pro: watches for .TXT disappearance (accepted) or .err appearance (failed)
      const monitor = new DarkroomProMonitor();
      const processedFolderName = controller.processedFolderName || 'processed';
      monitor.startMonitoring(controller.hotFolderPath, processedFolderName, onStatusChange);
      this.monitors.set(controllerId, monitor);

      logger.info('Started Darkroom Pro monitoring', {
        controller: controller.name,
        hotFolder: controller.hotFolderPath,
        processedFolder: processedFolderName
      });
    } else {
      // DPOF controllers (Noritsu, Epson): watches for folder prefix renames (o→e, o→q)
      const monitor = new FolderMonitor();
      monitor.startMonitoring(controller.hotFolderPath, onStatusChange);
      this.monitors.set(controllerId, monitor);

      logger.info('Started DPOF folder monitoring', {
        controller: controller.name,
        hotFolder: controller.hotFolderPath
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
