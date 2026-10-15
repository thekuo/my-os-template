import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

// Create PNG files with a simple canvas-like approach
// This generates minimal PNG files with a teal circle and white check

function writePNG(filename, size) {
  const canvas = {
    width: size,
    height: size,
  };

  // Create pixel data (RGBA)
  const pixelData = new Uint8ClampedArray(canvas.width * canvas.height * 4);

  // Fill background with dark color (#1f1f1f)
  const bgR = 31, bgG = 31, bgB = 31, bgA = 255;
  for (let i = 0; i < pixelData.length; i += 4) {
    pixelData[i] = bgR;
    pixelData[i + 1] = bgG;
    pixelData[i + 2] = bgB;
    pixelData[i + 3] = bgA;
  }

  // Draw teal circle (#5fd3c6) in the middle
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const radius = (canvas.width * 0.35);
  const circleR = 95, circleG = 211, circleB = 198, circleA = 255;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < radius) {
        const idx = (y * canvas.width + x) * 4;
        pixelData[idx] = circleR;
        pixelData[idx + 1] = circleG;
        pixelData[idx + 2] = circleB;
        pixelData[idx + 3] = circleA;
      }
    }
  }

  // Draw white check mark
  const checkColor = { r: 255, g: 255, b: 255, a: 255 };
  const checkWidth = Math.max(2, Math.floor(canvas.width / 16));

  // Simple check mark: L shape from (30%, 60%) to (45%, 75%) to (70%, 35%)
  const checkStart = { x: centerX - radius * 0.25, y: centerY + radius * 0.1 };
  const checkMid = { x: centerX - radius * 0.05, y: centerY + radius * 0.25 };
  const checkEnd = { x: centerX + radius * 0.25, y: centerY - radius * 0.2 };

  // Draw line from checkStart to checkMid
  drawLine(pixelData, canvas.width, checkStart, checkMid, checkWidth, checkColor);
  // Draw line from checkMid to checkEnd
  drawLine(pixelData, canvas.width, checkMid, checkEnd, checkWidth, checkColor);

  // Convert pixel data to PNG
  const pngBuffer = pixelsToPNG(canvas.width, canvas.height, pixelData);
  fs.writeFileSync(filename, pngBuffer);
  console.log(`Generated ${filename}`);
}

function drawLine(pixelData, width, from, to, thickness, color) {
  const steps = Math.max(
    Math.abs(Math.round(to.x - from.x)),
    Math.abs(Math.round(to.y - from.y))
  );

  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);

    // Draw circle at this point
    for (let dx = -thickness; dx <= thickness; dx++) {
      for (let dy = -thickness; dy <= thickness; dy++) {
        if (dx * dx + dy * dy <= thickness * thickness) {
          const px = x + dx;
          const py = y + dy;
          if (px >= 0 && px < width && py >= 0 && py < width) {
            const idx = (py * width + px) * 4;
            pixelData[idx] = color.r;
            pixelData[idx + 1] = color.g;
            pixelData[idx + 2] = color.b;
            pixelData[idx + 3] = color.a;
          }
        }
      }
    }
  }
}

function pixelsToPNG(width, height, pixelData) {
  // Minimal PNG encoder
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = createIHDR(width, height);

  // IDAT chunk (image data)
  const idat = createIDAT(width, height, pixelData);

  // IEND chunk
  const iend = createIEND();

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createIHDR(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 6; // color type (RGBA)
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return createChunk('IHDR', data);
}

function createIDAT(width, height, pixelData) {
  // Filter: prepend 0 (none) to each scanline
  const filtered = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (width * 4 + 1)] = 0;
    const srcStart = y * width * 4;
    const srcEnd = (y + 1) * width * 4;
    const dstStart = y * (width * 4 + 1) + 1;
    for (let i = srcStart; i < srcEnd; i++) {
      filtered[dstStart + (i - srcStart)] = pixelData[i];
    }
  }

  const compressed = zlib.deflateSync(filtered);
  return createChunk('IDAT', compressed);
}

function createIEND() {
  return createChunk('IEND', Buffer.alloc(0));
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const chunkData = Buffer.concat([typeBuffer, data]);

  const crc = calculateCRC(chunkData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, chunkData, crcBuffer]);
}

function calculateCRC(data) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Generate icons
const iconsDir = path.join(path.dirname(import.meta.url.replace('file://', '')), '../public/icons');
writePNG(path.join(iconsDir, 'icon-192.png'), 192);
writePNG(path.join(iconsDir, 'icon-512.png'), 512);
console.log('Icons generated successfully');
