'use strict';

/**
 * 插件图标生成脚本（纯 Node，无任何依赖）
 *
 * 用途：重新生成 chrome-extension/icons/ 下的 16/48/128 三种尺寸 PNG 图标。
 * 图案：透明背景 + 三根自左向右升高的用量条（绿/黄/红），呼应"额度用量"主题。
 *
 * 运行：node scripts/make-icons.js
 *
 * @author 黄杰
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** PNG CRC32 校验算法 */
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 把 RGBA 像素矩阵编码为 PNG 文件内容 */
function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  // 扫描线：每行前置 1 字节过滤类型（0 = 不过滤）
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 三根用量条的图案定义：底部对齐、自左向右升高，绿/黄/红 */
const BARS = [
  { heightRatio: 0.45, color: [0x81, 0xc9, 0x95, 0xff] },
  { heightRatio: 0.72, color: [0xfd, 0xd6, 0x63, 0xff] },
  { heightRatio: 1.0, color: [0xf2, 0x8b, 0x82, 0xff] },
];

/** 生成 size x size 的图标像素矩阵 */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const barWidth = Math.max(2, Math.round(size * 0.18));
  const gap = Math.max(1, Math.round(size * 0.1));
  const totalWidth = BARS.length * barWidth + (BARS.length - 1) * gap;
  const startX = Math.floor((size - totalWidth) / 2);
  const bottomMargin = Math.round(size * 0.16);
  const topMargin = Math.round(size * 0.16);
  const maxBarHeight = size - topMargin - bottomMargin;

  BARS.forEach((bar, index) => {
    const x0 = startX + index * (barWidth + gap);
    const barHeight = Math.max(1, Math.round(maxBarHeight * bar.heightRatio));
    const y0 = size - bottomMargin - barHeight;
    for (let y = y0; y < y0 + barHeight; y++) {
      for (let x = x0; x < x0 + barWidth; x++) {
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const offset = (y * size + x) * 4;
        pixels[offset] = bar.color[0];
        pixels[offset + 1] = bar.color[1];
        pixels[offset + 2] = bar.color[2];
        pixels[offset + 3] = bar.color[3];
      }
    }
  });
  return pixels;
}

const iconsDir = path.join(__dirname, '..', 'chrome-extension', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, size, drawIcon(size)));
  console.log(`已生成 ${file}`);
}
