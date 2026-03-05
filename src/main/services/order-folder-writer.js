'use strict';

const fs = require('fs');
const path = require('path');

class OrderFolderWriter {
  async writeOrderFolder(hotFolderPath, orderNumber, productCode, dpofContent, imageFiles) {
    const folderName = `o${orderNumber}_${productCode}`;
    const folderPath = path.join(hotFolderPath, folderName);

    // 1. Create folder structure
    await fs.promises.mkdir(path.join(folderPath, 'IMAGES'), { recursive: true });

    // 2. Write DPOF.001 file
    await fs.promises.writeFile(path.join(folderPath, 'DPOF.001'), dpofContent, 'utf-8');

    // 3. Copy image files to IMAGES folder
    for (const img of imageFiles) {
      await fs.promises.copyFile(
        img.sourcePath,
        path.join(folderPath, 'IMAGES', img.filename)
      );
    }

    return folderPath;
  }
}

const orderFolderWriter = new OrderFolderWriter();
module.exports = { orderFolderWriter, OrderFolderWriter };
