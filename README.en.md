# ClawChat

Mobile chat client for OpenClaw, built with Capacitor + React + TypeScript and compatible with the `qingchencloud/clawapp` protocol.

## Highlights

- Streaming chat with multi-turn assistant bubbles
- Tool call rendering with interleaved text output
- File upload from camera, gallery, and local files
- Local history cache with session restore
- Auto reconnect with SSE resume and deduplication
- AI-generated session titles after the first completed round
- Download links for generated artifacts in the assistant's final answer
- Token-authenticated proxy server with Ed25519 device signing for OpenClaw Gateway

## Architecture

```text
ClawChat App (Capacitor / Web)
  -> SSE + HTTP POST
ClawChat Server (Express proxy)
  -> WebSocket + Ed25519 device auth
OpenClaw Gateway
```

The mobile app talks to the proxy server, and the proxy keeps a shared upstream connection to OpenClaw Gateway.

## Quick Start

### 1. Install dependencies

```bash
npm install
cd server
npm install
cd ..
```

### 2. Start the proxy server

```bash
cd server
node index.js
```

On first launch, `server/.env` will be created automatically.

### 3. Configure `server/.env`

```env
PROXY_PORT=3210
PROXY_TOKEN=your-token
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_GATEWAY_PASSWORD=
DOWNLOAD_ROOTS=../dist,../android/app/build/outputs,../build,../out,../release
```

`DOWNLOAD_ROOTS` is a comma-separated whitelist of directories that the client is allowed to download files from.

### 4. Run frontend

Development:

```bash
npm run dev:server
npm run dev
```

Production:

```bash
npm run build
cd server
node index.js
```

## Downloading Generated Files

If the assistant's final answer contains a local file path such as:

```text
/root/.openclaw/workspace/report.docx
```

the frontend turns it into a clickable download link.

Rules:

- Downloads go through `POST /api/download-file`
- The client sends `Authorization: Bearer <token>`
- The token is not exposed in the URL
- Only files inside `DOWNLOAD_ROOTS` are allowed
- Download actions are attached to the assistant's final answer, not the tool call panel

## API Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/connect` | POST | Create proxy session |
| `/api/events` | GET | SSE event stream |
| `/api/send` | POST | Forward Gateway RPC |
| `/api/disconnect` | POST | Close proxy session |
| `/api/download-file` | POST | Download generated artifact from allowed roots |
| `/api/session-title` | POST | Persist session title |
| `/api/session-titles` | GET | Fetch persisted session titles |
| `/api/message-meta` | GET/POST | Persist and restore assistant metadata |

## Android Build

```powershell
npx cap sync android
cd android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug
```

APK output:

`android/app/build/outputs/apk/debug/app-debug.apk`

## License

MIT
