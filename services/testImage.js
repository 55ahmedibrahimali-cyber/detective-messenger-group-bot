const jpeg = require("jpeg-js");

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(
    0,
    Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function createTestImage() {
  const width = 320;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const border = x < 12 || y < 12 || x >= width - 12 || y >= height - 12;
      const check =
        distanceToSegment(x, y, 80, 120, 132, 174) < 12 ||
        distanceToSegment(x, y, 132, 174, 245, 66) < 12;
      const color = border || check ? [255, 255, 255] : [35, 71, 103];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }

  return jpeg.encode({ data: pixels, width, height }, 90).data;
}

module.exports = { createTestImage };
