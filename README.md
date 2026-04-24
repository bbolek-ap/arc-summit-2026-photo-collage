# Arc Summit Photo Collage — MCP Server

An MCP (Model Context Protocol) server that downloads photos from URLs, arranges them into a collage, stamps an **AP Arc Summit 2026** watermark, uploads the result to Azure Blob Storage, and returns the public URL.

## Live endpoint

```
https://ca-arc-summit-photo.blackforest-36c37925.eastus.azurecontainerapps.io/mcp
```

The server scales to zero after **1 hour of inactivity** and wakes up automatically on the next request (~30 s cold start).

---

## Tool

### `create_collage`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `photo_urls` | `string[]` | Yes | 2–20 image URLs to include |
| `layout` | `enum` | No | `random` (default), `grid`, `horizontal`, `vertical` |
| `filename` | `string` | No | Output blob name without extension (defaults to UUID) |

Returns the public Azure Blob URL of the generated JPEG.

#### Layouts

| Layout | Description |
|--------|-------------|
| `random` | Magazine-style — rows of 1–3 columns chosen randomly |
| `grid` | Uniform N×M grid, closest to square |
| `horizontal` | Single row strip |
| `vertical` | Single full-width column |

---

## Local development

### Prerequisites

- Node.js 22+
- An Azure Storage account (connection string + container)

### Setup

```bash
cp .env.example .env
# fill in AZURE_STORAGE_CONNECTION_STRING and optionally AZURE_STORAGE_CONTAINER
npm install
npm run dev        # tsx watch on port 3000
```

### Quick collage (no Azure)

```bash
node collage-local.mjs   # writes collage.jpg to project root
```

---

## Build & deploy

Images are built via Azure Container Registry and deployed to Azure Container Apps.

```bash
# Build & push
az acr build --registry acarcsummit91fc --image arc-summit-photo:latest --file Dockerfile .

# Deploy
az containerapp update \
  --name ca-arc-summit-photo \
  --resource-group rg-arc-summit-photo \
  --image acarcsummit91fc.azurecr.io/arc-summit-photo:latest
```

---

## Stack

- **Runtime** — Node.js 22, TypeScript
- **MCP transport** — Streamable HTTP (`@modelcontextprotocol/sdk`)
- **Image processing** — `sharp`
- **HTTP client** — `axios`
- **Storage** — Azure Blob Storage (`@azure/storage-blob`)
- **Schema validation** — `zod`
- **Infrastructure** — Azure Container Apps (min replicas: 0), Azure Container Registry
