/**
 * Generate app icons from favicon hub.svg
 *
 * Run this once: npm run generate-icons
 *
 * Requires: npm install --save-dev sharp png-to-ico
 */
const sharp = require('sharp');
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'assets', 'favicon hub.svg');
const pngPath = path.join(__dirname, '..', 'assets', 'icons', 'icon.png');
const icoPath = path.join(__dirname, '..', 'assets', 'icons', 'icon.ico');

async function generate() {
  console.log('Generating icons from favicon hub.svg...');

  // Ensure icons directory exists
  const iconsDir = path.dirname(pngPath);
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  // Generate 256x256 PNG from SVG
  await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toFile(pngPath);
  console.log('Created icon.png (256x256)');

  // Generate ICO from PNG
  const pngBuffer = fs.readFileSync(pngPath);
  const icoBuffer = await pngToIco(pngBuffer);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Created icon.ico');

  // Also generate a 16x16 and 32x32 for tray
  const trayPath16 = path.join(iconsDir, 'tray-icon-16.png');
  const trayPath32 = path.join(iconsDir, 'tray-icon-32.png');

  await sharp(svgPath).resize(16, 16).png().toFile(trayPath16);
  console.log('Created tray-icon-16.png');

  await sharp(svgPath).resize(32, 32).png().toFile(trayPath32);
  console.log('Created tray-icon-32.png');

  console.log('Done! All icons generated.');
}

generate().catch(console.error);
