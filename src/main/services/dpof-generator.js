'use strict';

class DPOFGenerator {
  generate(controller, mapping, job) {
    const header = this.generateHeader(controller, mapping, job);
    const jobSections = job.lineItems.map((item, idx) =>
      this.generateJob(item, idx, controller, job)
    ).join('\n');

    return `${header}\n${jobSections}`;
  }

  formatTimestamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');

    return `${year}:${month}:${day}:${hour}:${minute}:${second}`;
  }

  generateHeader(controller, mapping, job) {
    return `[HDR]
GEN REV = 01.00
GEN CRT = "OHD" 1.00
GEN DTM = ${this.formatTimestamp()}
USR NAM = "${job.customerName}"
USR CID = "${job.orderNumber}"
AUTO CORRECT = ${controller.autoCorrect ? 1 : 0}
VUQ RGN = BGN
VUQ VNM = "${controller.vendorName}" -ATR "${controller.vendorAttribute}"
VUQ VER = 01.00
PRT PSL = -PSIZE "${mapping.size}"
PRT PCH = ${mapping.channelNumber}
VUQ RGN = END`;
  }

  generateJob(lineItem, index, controller, job) {
    return `[JOB]
PRT PID = ${String(lineItem.lineItemNumber).padStart(3, '0')}
PRT TYP = STD
PRT QTY = ${lineItem.quantity}
IMG FMT = EXIF2 -J
<IMG SRC = "../IMAGES/${lineItem.filename}">
VUQ RGN = BGN
VUQ VNM = "${controller.vendorName}" -ATR "${controller.vendorAttribute}"
VUQ VER = 01.00
PRT CVP1 = 1 -STR ""
PRT CVP2 = 1 -STR "${job.orderReference}"
IMG ORG = "o${job.orderNumber}_${job.productCode}/IMAGES/${lineItem.filename}"
VUQ RGN = END`;
  }
}

const dpofGenerator = new DPOFGenerator();
module.exports = { dpofGenerator, DPOFGenerator };
