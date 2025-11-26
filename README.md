# Tophhie Cloud Accessibility Score Worker

## Overview
This project is a **Cloudflare Worker** that automates the process of fetching accessibility scores for repositories hosted on **Tophhie Social** and storing them in **Cloudflare Workers KV** for fast, globally distributed access.

It also provides an **HTTP API** for retrieving scores on demand, making it easy to integrate with dashboards, static sites, or other services.

---

## Features
- **Scheduled Task**  
  Runs daily via Cloudflare Cron Triggers to:
  - Fetch all repos from `https://api.tophhie.cloud/pds/repos`.
  - For each repo, call `https://api.tophhie.cloud/pds/accessibilityScore/{did}`.
  - Store each score in Workers KV using the DID as the key.

- **KV Storage**  
  - Stores individual scores keyed by DID.
  - Stores metadata:
    - `lastUpdated` → ISO UTC timestamp.
    - `pdsAccessibilityScore` → Average score across all repos.

- **HTTP API Endpoints**
  - `GET /accessibilityScore` → Returns the overall score for the entire PDS.
  - `GET /accessibilityScore?did=<DID>` → Returns the score for a specific DID.
  - `GET /accessibilityScore/all` → Returns all data, including; individual scores, last updated timestamp, and the PDS score.
  - Includes **CORS headers** for cross-origin requests.
  - Supports **cache headers** for performance.

---

## Tech Stack
- **Cloudflare Workers** for serverless execution.
- **Workers KV** for globally distributed key-value storage.
- **Wrangler** for deployment and configuration.

---

## Configuration
Add the following to `wrangler.toml`:

```toml
name = "accessibility-worker"
main = "src/index.ts"
compatibility_date = "2025-11-26"

[triggers]
crons = ["0 0 * * *"] # Runs daily at midnight UTC

[[kv_namespaces]]
binding = "ACCESSIBILITY_KV"
id = "<your-kv-id>"

[vars]
API_TOKEN = "<your-api-token>"

[[routes]]
pattern = "https://tophhie.social/accessibilityScore*"
zone_id = "<your-zone-id>"
```

---

## Deployment
```bash
npm install
npm run build
wrangler deploy
```

---

## Usage
### Fetch a Score
```bash
curl "https://tophhie.social/accessibilityScore?did=did:plc:example123"
```
Response:
```json
{
  "did": "did:plc:example123",
  "score": 95
}
```
---

## Future Enhancements
- Add `/scores` endpoint for full dataset.