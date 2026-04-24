import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BlobServiceClient } from "@azure/storage-blob";
import sharp from "sharp";
import axios from "axios";
import { z } from "zod";

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
const AZURE_STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? "collages";
const PORT = parseInt(process.env.PORT ?? "3000");
const WATERMARK_TEXT = "AP Arc Summit 2026";
const CANVAS_WIDTH = 1200;
const GAP = 8;
const WATERMARK_HEIGHT = 52;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

if (!AZURE_STORAGE_CONNECTION_STRING) {
  console.error("AZURE_STORAGE_CONNECTION_STRING is required");
  process.exit(1);
}

const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(AZURE_STORAGE_CONTAINER);

// ── Types ──────────────────────────────────────────────────────────────────────

type Layout = "random" | "grid" | "horizontal" | "vertical";

interface Cell {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Layout generators ──────────────────────────────────────────────────────────

/**
 * random: magazine style — rows of 1–3 cols chosen at random per row.
 */
function layoutRandom(count: number): { cells: Cell[]; photoAreaHeight: number } {
  const ROW_HEIGHT = 400;
  const cells: Cell[] = [];
  let y = GAP;
  let placed = 0;

  while (placed < count) {
    const remaining = count - placed;
    const maxCols = Math.min(3, remaining);
    const cols = maxCols === 1 ? 1 : Math.floor(Math.random() * maxCols) + 1;
    const cellWidth = Math.floor((CANVAS_WIDTH - (cols + 1) * GAP) / cols);

    for (let c = 0; c < cols && placed < count; c++) {
      cells.push({ x: GAP + c * (cellWidth + GAP), y, width: cellWidth, height: ROW_HEIGHT });
      placed++;
    }
    y += ROW_HEIGHT + GAP;
  }

  return { cells, photoAreaHeight: y };
}

/**
 * grid: uniform NxM grid — closest to square arrangement.
 */
function layoutGrid(count: number): { cells: Cell[]; photoAreaHeight: number } {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellWidth = Math.floor((CANVAS_WIDTH - (cols + 1) * GAP) / cols);
  const cellHeight = cellWidth; // square cells
  const cells: Cell[] = [];

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cells.push({
      x: GAP + col * (cellWidth + GAP),
      y: GAP + row * (cellHeight + GAP),
      width: cellWidth,
      height: cellHeight,
    });
  }

  return { cells, photoAreaHeight: GAP + rows * (cellHeight + GAP) };
}

/**
 * horizontal: single row strip — all photos side by side.
 */
function layoutHorizontal(count: number): { cells: Cell[]; photoAreaHeight: number } {
  const cellWidth = Math.floor((CANVAS_WIDTH - (count + 1) * GAP) / count);
  const cellHeight = 500;
  const cells: Cell[] = Array.from({ length: count }, (_, i) => ({
    x: GAP + i * (cellWidth + GAP),
    y: GAP,
    width: cellWidth,
    height: cellHeight,
  }));
  return { cells, photoAreaHeight: GAP + cellHeight + GAP };
}

/**
 * vertical: single column — photos stacked full-width.
 */
function layoutVertical(count: number): { cells: Cell[]; photoAreaHeight: number } {
  const cellWidth = CANVAS_WIDTH - GAP * 2;
  const cellHeight = 350;
  const cells: Cell[] = Array.from({ length: count }, (_, i) => ({
    x: GAP,
    y: GAP + i * (cellHeight + GAP),
    width: cellWidth,
    height: cellHeight,
  }));
  return { cells, photoAreaHeight: GAP + count * (cellHeight + GAP) };
}

const layoutFns: Record<Layout, (n: number) => { cells: Cell[]; photoAreaHeight: number }> = {
  random: layoutRandom,
  grid: layoutGrid,
  horizontal: layoutHorizontal,
  vertical: layoutVertical,
};

// ── Watermark ──────────────────────────────────────────────────────────────────

function buildWatermarkSvg(width: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${WATERMARK_HEIGHT}">
    <rect width="${width}" height="${WATERMARK_HEIGHT}" fill="rgba(0,0,0,0.72)"/>
    <text
      x="${width / 2}"
      y="${WATERMARK_HEIGHT / 2 + 9}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="24"
      font-weight="bold"
      text-anchor="middle"
      fill="white"
      letter-spacing="4">${WATERMARK_TEXT}</text>
  </svg>`;
  return Buffer.from(svg);
}

// ── Image helpers ──────────────────────────────────────────────────────────────

async function downloadImage(url: string): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 15_000,
  });
  return Buffer.from(response.data);
}

async function buildCollage(photoUrls: string[], layout: Layout): Promise<Buffer> {
  const shuffled = [...photoUrls].sort(() => Math.random() - 0.5);
  const { cells, photoAreaHeight } = layoutFns[layout](shuffled.length);
  const totalHeight = photoAreaHeight + WATERMARK_HEIGHT;

  const photoComposites: sharp.OverlayOptions[] = await Promise.all(
    shuffled.map(async (url, i) => {
      const cell = cells[i];
      const raw = await downloadImage(url);
      const resized = await sharp(raw)
        .resize(cell.width, cell.height, { fit: "cover", position: "attention" })
        .toBuffer();
      return { input: resized, left: cell.x, top: cell.y };
    })
  );

  const watermark: sharp.OverlayOptions = {
    input: buildWatermarkSvg(CANVAS_WIDTH),
    left: 0,
    top: photoAreaHeight,
  };

  return sharp({
    create: {
      width: CANVAS_WIDTH,
      height: totalHeight,
      channels: 3,
      background: { r: 18, g: 18, b: 18 },
    },
  })
    .composite([...photoComposites, watermark])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ── Azure upload ───────────────────────────────────────────────────────────────

async function uploadToAzure(buffer: Buffer, blobName: string): Promise<string> {
  await containerClient.createIfNotExists({ access: "blob" });
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: "image/jpeg" },
  });
  return blockBlobClient.url;
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "photo-collage", version: "1.0.0" });

server.tool(
  "create_collage",
  [
    "Download photos from provided URLs, arrange them in the chosen layout, add an 'AP Arc Summit 2026' watermark bar,",
    "upload the result to Azure Blob Storage, and return the public URL.",
    "Layouts: random (magazine rows of 1–3 cols), grid (uniform NxM), horizontal (single row strip), vertical (single column stack).",
  ].join(" "),
  {
    photo_urls: z
      .array(z.string().url())
      .min(2)
      .max(20)
      .describe("Photo URLs to include in the collage (2–20 items)"),
    layout: z
      .enum(["random", "grid", "horizontal", "vertical"])
      .default("random")
      .describe("Collage layout style"),
    filename: z
      .string()
      .optional()
      .describe("Output filename without extension — defaults to a UUID"),
  },
  async ({ photo_urls, layout, filename }) => {
    const blobName = `${filename ?? randomUUID()}.jpg`;

    try {
      const buffer = await buildCollage(photo_urls, layout);
      const url = await uploadToAzure(buffer, blobName);
      return {
        content: [
          { type: "text", text: `Collage ready (layout: ${layout}): ${url}` },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Failed to create collage: ${message}` }],
        isError: true,
      };
    }
  }
);

// ── HTTP server ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

let lastRequestAt = Date.now();
app.use((_req, _res, next) => { lastRequestAt = Date.now(); next(); });
setInterval(() => {
  if (Date.now() - lastRequestAt >= IDLE_TIMEOUT_MS) {
    console.log("Idle for 1 hour — shutting down.");
    process.exit(0);
  }
}, 5 * 60 * 1000).unref();

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => { transports.set(sid, transport); },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: "Invalid request" });
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Session not found" });
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Session not found" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Photo Collage MCP server on port ${PORT}`));
