import sharp from "sharp";
import https from "node:https";
import http from "node:http";
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CANVAS_WIDTH = 1200;
const GAP = 8;
const WATERMARK_HEIGHT = 52;
const WATERMARK_TEXT = "AP Arc Summit 2026";
const ROW_HEIGHT = 400;

const urls = [
  "https://media.istockphoto.com/id/814423752/photo/eye-of-model-with-colorful-art-make-up-close-up.jpg?s=612x612&w=0&k=20&c=l15OdMWjgCKycMMShP8UK94ELVlEGvt7GmB_esHWPYE=",
  "https://cdn.pixabay.com/photo/2016/11/21/06/53/beautiful-natural-image-1844362_1280.jpg",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR9SRRmhH4X5N2e4QalcoxVbzYsD44C-sQv-w&s",
];

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const chunks = [];
    const req = client.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function buildWatermarkSvg(width) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${WATERMARK_HEIGHT}">
    <rect width="${width}" height="${WATERMARK_HEIGHT}" fill="rgba(0,0,0,0.72)"/>
    <text x="${width / 2}" y="${WATERMARK_HEIGHT / 2 + 9}"
      font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="bold"
      text-anchor="middle" fill="white" letter-spacing="4">${WATERMARK_TEXT}</text>
  </svg>`);
}

async function main() {
  const count = urls.length;
  // layout: single row of 3 (horizontal strip)
  const cellWidth = Math.floor((CANVAS_WIDTH - (count + 1) * GAP) / count);
  const cellHeight = 500;
  const cells = urls.map((_, i) => ({
    x: GAP + i * (cellWidth + GAP),
    y: GAP,
    width: cellWidth,
    height: cellHeight,
  }));
  const photoAreaHeight = GAP + cellHeight + GAP;
  const totalHeight = photoAreaHeight + WATERMARK_HEIGHT;

  console.log("Downloading images...");
  const composites = await Promise.all(
    urls.map(async (url, i) => {
      console.log(`  [${i + 1}/${count}] ${url.slice(0, 60)}...`);
      const raw = await downloadBuffer(url);
      const cell = cells[i];
      const resized = await sharp(raw)
        .resize(cell.width, cell.height, { fit: "cover", position: "attention" })
        .toBuffer();
      return { input: resized, left: cell.x, top: cell.y };
    })
  );

  composites.push({ input: buildWatermarkSvg(CANVAS_WIDTH), left: 0, top: photoAreaHeight });

  console.log("Building collage...");
  await sharp({
    create: { width: CANVAS_WIDTH, height: totalHeight, channels: 3, background: { r: 18, g: 18, b: 18 } },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile("collage.jpg");

  console.log("Done! Saved to collage.jpg");
}

main().catch((err) => { console.error(err); process.exit(1); });
