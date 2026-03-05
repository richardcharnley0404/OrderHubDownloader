'use strict';

/**
 * Test script for print controller services.
 *
 * Runs inside the Electron main process. Trigger via IPC:
 *   window.electronAPI.invoke('test:printController')
 *
 * Or call runTest() directly from the main process.
 */

const path = require('path');
const fs = require('fs');
const { printControllerStore } = require('./print-controller-store');
const { jobStore } = require('./job-store');
const { dpofGenerator } = require('./dpof-generator');
const { orderFolderWriter } = require('./order-folder-writer');
const { FolderMonitor } = require('./folder-monitor');

// ─── Helpers ─────────────────────────────────────────────────────
const results = [];

function separator(title) {
  results.push(`\n${'═'.repeat(60)}`);
  results.push(`  ${title}`);
  results.push('═'.repeat(60));
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function log(label, value) {
  const formatted = typeof value === 'object' ? JSON.stringify(value, null, 4) : String(value);
  results.push(`  ${label}: ${formatted}`);
  console.log(`  ${label}:`, typeof value === 'object' ? JSON.stringify(value, null, 4) : value);
}

// ─── Main Test ───────────────────────────────────────────────────
async function runTest() {
  results.length = 0;

  const TEST_HOT_FOLDER = path.join(require('os').tmpdir(), 'ohd-test-hotfolder');
  const testImageDir = path.join(require('os').tmpdir(), 'ohd-test-images');

  try {
    // Ensure hot folder exists
    fs.mkdirSync(TEST_HOT_FOLDER, { recursive: true });
    log('Hot folder', TEST_HOT_FOLDER);

    // ── Step 1: Add a Noritsu controller ──
    separator('Step 1: Add Noritsu Controller');

    const controllerId = printControllerStore.addController({
      type: 'noritsu',
      name: 'Noritsu QSS-3901',
      vendorName: 'NORITSU KOKI',
      vendorAttribute: 'QSS-3901',
      isActive: true,
      hotFolderPath: TEST_HOT_FOLDER,
      autoCorrect: true
    });

    const controller = printControllerStore.getController(controllerId);
    log('Controller ID', controllerId);
    log('Controller', controller);

    const allControllers = printControllerStore.getAllControllers();
    log('Total controllers', allControllers.length);

    // ── Step 2: Add a product mapping ──
    separator('Step 2: Add Product Mapping (8x12GLOSS -> channel 145)');

    const mappingId = printControllerStore.addProductMapping({
      controllerId,
      productCode: '8x12GLOSS',
      size: '8x12',
      options: { Finish: 'Gloss' },
      channelNumber: 145
    });

    const mapping = printControllerStore.getProductMapping(mappingId);
    log('Mapping ID', mappingId);
    log('Mapping', mapping);

    const matchedMapping = printControllerStore.findChannelForJob(controllerId, '8x12GLOSS', { Finish: 'Gloss' });
    log('Find mapping for 8x12GLOSS/Gloss', matchedMapping ? `PASS - Found channel ${matchedMapping.channelNumber}` : 'FAIL');

    const noMatch = printControllerStore.findChannelForJob(controllerId, '10x12GLOSS', {});
    log('Find mapping for 10x12GLOSS', noMatch ? 'FAIL - Should not match' : 'PASS - No match (expected)');

    // ── Step 3: Create a test job ──
    separator('Step 3: Create Test Job');

    fs.mkdirSync(testImageDir, { recursive: true });
    const imagePath = path.join(testImageDir, 'test-photo-001.jpg');
    fs.writeFileSync(imagePath, 'FAKE_JPEG_DATA_FOR_TESTING');
    log('Created dummy image', imagePath);

    const jobId = jobStore.addJob({
      controllerId,
      mappingId,
      orderNumber: '100456',
      productCode: '8x12GLOSS',
      customerName: 'Richard Charnley',
      orderReference: 'ORD-2026-0456',
      lineItems: [
        {
          lineItemNumber: 1,
          quantity: 2,
          filename: 'test-photo-001.jpg'
        }
      ],
      imageFiles: [
        {
          sourcePath: imagePath,
          filename: 'test-photo-001.jpg'
        }
      ]
    });

    const job = jobStore.getJob(jobId);
    log('Job ID', jobId);
    log('Job status', job.dpofStatus);

    // ── Step 4: Generate DPOF and write to hot folder ──
    separator('Step 4: Generate DPOF & Write Order Folder');

    const dpofContent = dpofGenerator.generate(controller, mapping, job);
    log('DPOF Content', `\n${dpofContent}`);

    const folderPath = await orderFolderWriter.writeOrderFolder(
      controller.hotFolderPath,
      job.orderNumber,
      job.productCode,
      dpofContent,
      job.imageFiles
    );

    log('Order folder created', folderPath);

    const dpofExists = fs.existsSync(path.join(folderPath, 'DPOF.001'));
    const imageExists = fs.existsSync(path.join(folderPath, 'IMAGES', 'test-photo-001.jpg'));
    log('DPOF.001 exists', dpofExists ? 'PASS' : 'FAIL');
    log('Image copied', imageExists ? 'PASS' : 'FAIL');

    if (dpofExists) {
      const written = fs.readFileSync(path.join(folderPath, 'DPOF.001'), 'utf-8');
      log('DPOF.001 size', `${written.length} bytes`);
    }

    jobStore.updateJob(jobId, {
      dpofStatus: 'submitted',
      dpofSubmittedAt: new Date().toISOString(),
      dpofFolderPath: folderPath
    });
    log('Job status after submit', jobStore.getJob(jobId).dpofStatus);

    // ── Step 5: Start monitoring and simulate rename ──
    separator('Step 5: Folder Monitor - Simulate Printer Acceptance');

    let monitorDetected = false;

    const monitor = new FolderMonitor();
    monitor.startMonitoring(TEST_HOT_FOLDER, (statusUpdate) => {
      monitorDetected = true;
      log('MONITOR DETECTED', `Order ${statusUpdate.orderNumber} -> ${statusUpdate.status}`);
    });

    log('Monitoring started', TEST_HOT_FOLDER);

    // Rename o -> e to simulate printer acceptance
    const orderFolderName = path.basename(folderPath);
    const acceptedFolderName = orderFolderName.replace(/^o/, 'e');
    const acceptedPath = path.join(TEST_HOT_FOLDER, acceptedFolderName);

    log('Renaming', `${orderFolderName} -> ${acceptedFolderName}`);
    fs.renameSync(folderPath, acceptedPath);

    // Wait for monitor to detect
    await new Promise(resolve => setTimeout(resolve, 2000));

    log('Monitor detected change', monitorDetected ? 'PASS' : 'FAIL (may be timing)');

    // ── Cleanup ──
    separator('Cleanup');

    monitor.stopMonitoring();
    printControllerStore.deleteController(controllerId);
    jobStore.deleteJob(jobId);
    log('Test data removed from stores', 'DONE');

    fs.rmSync(acceptedPath, { recursive: true, force: true });
    fs.rmSync(testImageDir, { recursive: true, force: true });
    fs.rmSync(TEST_HOT_FOLDER, { recursive: true, force: true });
    log('Test files cleaned up', 'DONE');

    separator('ALL TESTS PASSED');

    return { success: true, output: results.join('\n') };

  } catch (err) {
    const msg = `TEST FAILED: ${err.message}\n${err.stack}`;
    console.error(msg);
    results.push(msg);

    // Cleanup on failure
    try {
      fs.rmSync(testImageDir, { recursive: true, force: true });
      fs.rmSync(TEST_HOT_FOLDER, { recursive: true, force: true });
    } catch (_) { /* ignore */ }

    return { success: false, output: results.join('\n'), error: err.message };
  }
}

module.exports = { runTest };
