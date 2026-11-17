/**
 * Builds the app icons from assets/chat/icon.png with Electron's own canvas (no extra dependency):
 *   build/icon.png   1024, macOS-style margin (the square fills 824 of 1024)
 *   build/icon.icns  macOS, PNG entries 16…1024
 *   build/icon.ico   Windows, PNG entries 16…256, full bleed
 * Run: npx electron scripts/make-icons.cjs   (with ELECTRON_RUN_AS_NODE unset)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// The mark is drawn from the vector logo, so every size is sharp; the tile matches assets/chat/icon.png.
const mark = fs.readFileSync(path.join(root, 'assets', 'chat', 'gisoo.svg'), 'utf8').replace(/currentColor/g, '#FFC501').replace(/width="\d+" height="\d+"/,'width="1024" height="1024"');
const src = 'data:image/svg+xml;base64,' + Buffer.from(mark).toString('base64');

async function render(win, size, inset) {
  const url = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = ${size};
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    const pad = ${size} * ${inset};
    if (${inset} > 0) { g.shadowColor = 'rgba(0,0,0,0.28)'; g.shadowBlur = ${size} * 0.02; g.shadowOffsetY = ${size} * 0.01; }
    const w = ${size} - pad * 2, r = w * 0.225;
    g.beginPath(); g.roundRect(pad, pad, w, w, r); g.fillStyle = '#0b0c10'; g.fill();
    g.shadowColor = 'transparent';
    const m = w * 0.62; g.drawImage(img, pad + (w - m) / 2, pad + (w - m) / 2, m, m);
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(url.split(',')[1], 'base64');
}

function ico(pngs) {
  const head = Buffer.alloc(6 + pngs.length * 16);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, png], i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map(([, p]) => p)]);
}

function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(total, 4);
  return Buffer.concat([h, ...chunks]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html></html>');
  const out = path.join(root, 'build');
  fs.mkdirSync(out, { recursive: true });
  const mac = 0.1; // 824 / 1024
  const big = await render(win, 1024, mac);
  fs.writeFileSync(path.join(out, 'icon.png'), big);
  const m = async (s) => render(win, s, mac);
  fs.writeFileSync(path.join(out, 'icon.icns'), icns([
    ['icp4', await m(16)], ['icp5', await m(32)], ['icp6', await m(64)], ['ic07', await m(128)],
    ['ic08', await m(256)], ['ic09', await m(512)], ['ic10', big],
  ]));
  const w = [];
  for (const s of [16, 24, 32, 48, 64, 128, 256]) w.push([s, await render(win, s, 0)]);
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(w));
  console.log('icons written to', out);
  app.exit(0);
});
