// Generates build/icon.ico (multi-size) AND build/icon.iconset (the PNG set
// macOS CI converts to build/icon.icns via iconutil).
//
// Runs inside Electron so it can use nativeImage — no image libraries
// needed. Usage:  npm run icon   (or electron scripts/generate-icon.js)
//
// Output:
//   - build/icon.ico       a single .ico containing 16–256px PNG-compressed
//                          entries, which modern Windows (Vista+) reads
//                          natively. Used for the packaged app executable and
//                          the Squirrel setup wizard icon.
//   - build/icon.iconset/  the ten PNGs iconutil requires for a .icns
//                          (16…512px + @2x). macOS CI runs
//                          `iconutil -c icns` on it (see release.yml).
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'wolf.png');
const OUT_DIR = path.join(__dirname, '..', 'build');
const ICO = path.join(OUT_DIR, 'icon.ico');
const ICONSET = path.join(OUT_DIR, 'icon.iconset');
// Windows .ico sizes (16–256px).
const SIZES = [16, 24, 32, 48, 64, 128, 256];
// macOS iconset sizes — iconutil requires this exact file set.
const ICONSET_SIZES = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
};

function fail(msg) {
  console.error('[generate-icon] ERROR: ' + msg);
  process.exit(1);
}

// wolf.png is non-square (511x460), so we letterbox: scale it to fit inside
// s×s preserving the aspect ratio, then center it on a transparent s×s
// canvas. The transparent margins read as empty space, so the icon never
// looks squished (a plain stretch would distort it).
function letterboxedPng(img, s) {
  const src = img.getSize();
  const scale = Math.min(s / src.width, s / src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const scaled = img.resize({ width: w, height: h }).toBitmap(); // BGRA
  // Transparent canvas (BGRA, all zeros), scaled image centered on it.
  const canvas = Buffer.alloc(s * s * 4);
  const x0 = Math.floor((s - w) / 2);
  const y0 = Math.floor((s - h) / 2);
  for (let row = 0; row < h; row++) {
    scaled.copy(canvas, ((y0 + row) * s + x0) * 4, row * w * 4, (row + 1) * w * 4);
  }
  return nativeImage.createFromBitmap(canvas, { width: s, height: s }).toPNG();
}

app.whenReady().then(() => {
  try {
    if (!fs.existsSync(SRC)) fail('source image not found: ' + SRC);
    const img = nativeImage.createFromPath(SRC);
    if (img.isEmpty()) fail('could not decode image: ' + SRC);

    // --- ICO container: ICONDIR header + ICONDIRENTRY per image + PNGs ---
    // Header (6 bytes): reserved(2) type(2)=1 icon count(2)
    // Entry (16 bytes): w(1) h(1) palette(1) reserved(1) planes(2) bpp(2)
    //                   bytesInRes(4) imageOffset(4)
    const pngs = SIZES.map((s) => letterboxedPng(img, s));
    const headerSize = 6 + 16 * SIZES.length;
    const buf = Buffer.alloc(headerSize);
    buf.writeUInt16LE(0, 0); // reserved
    buf.writeUInt16LE(1, 2); // type: icon
    buf.writeUInt16LE(SIZES.length, 4); // count
    let offset = headerSize;
    pngs.forEach((png, i) => {
      const s = SIZES[i];
      const e = 6 + i * 16;
      buf.writeUInt8(s >= 256 ? 0 : s, e); // width (0 means 256)
      buf.writeUInt8(s >= 256 ? 0 : s, e + 1); // height
      buf.writeUInt8(0, e + 2); // color palette count
      buf.writeUInt8(0, e + 3); // reserved
      buf.writeUInt16LE(1, e + 4); // color planes
      buf.writeUInt16LE(32, e + 6); // bits per pixel
      buf.writeUInt32LE(png.length, e + 8); // bytes in resource
      buf.writeUInt32LE(offset, e + 12); // offset of the PNG blob
      offset += png.length;
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(ICO, Buffer.concat([buf, ...pngs]));

    // --- macOS iconset ---
    fs.mkdirSync(ICONSET, { recursive: true });
    for (const [name, size] of Object.entries(ICONSET_SIZES)) {
      fs.writeFileSync(path.join(ICONSET, name), letterboxedPng(img, size));
    }
    console.log('[generate-icon] wrote ' + ICO + ' (' + SIZES.length + ' sizes) and ' + ICONSET + ' (' + Object.keys(ICONSET_SIZES).length + ' pngs)');
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
});
