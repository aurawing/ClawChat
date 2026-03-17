# ClawChat

Mobile chat client for OpenClaw, built with Capacitor + React + TypeScript.

## Highlights

- Streaming chat with multi-turn assistant bubbles
- Tool call rendering with interleaved text output
- File upload from camera, gallery, and local files
- Local history cache with session restore
- Auto reconnect with SSE resume and deduplication
- AI-generated session titles after the first completed round
- Download links for generated artifacts in the assistant's final answer
- Multi-user proxy server with Ed25519 device signing for OpenClaw Gateway

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
npx @claw_chat/clawchat-proxy
```

On first launch, the CLI wizard creates the `~/.clawchat-proxy/` directory, with the config file stored at `~/.clawchat-proxy/.clawchat-proxy`.

### 2.1 Local `npm link` verification

Before publishing to npm, you can test the CLI locally:

```bash
cd server
npm link
clawchat-proxy --setup
clawchat-proxy
```

To remove the global link later:

```bash
cd server
npm unlink -g @claw_chat/clawchat-proxy
```

### 3. Configure `~/.clawchat-proxy/.clawchat-proxy`

```env
PROXY_PORT=18888
PROXY_USERS=alice:password1,bob:password2
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_GATEWAY_PASSWORD=
DOWNLOAD_ROOTS=~/.openclaw/workspace/sessions
DOWNLOAD_PATH_MAPS=
LOG_LEVEL=info
ALLOWED_ORIGINS=
```

`PROXY_USERS` is a comma-separated list of `username:password` pairs for app login.

`DOWNLOAD_ROOTS` is a comma-separated whitelist of directories that the client is allowed to download files from. The default only exposes `~/.openclaw/workspace/sessions`.

### 4. Run frontend

Development:

```bash
npm run dev:server
npm run dev
```

Production:

```bash
npm run build
npx @claw_chat/clawchat-proxy
```

## Downloading Generated Files

If the assistant's final answer contains a local file path such as:

```text
/root/.openclaw/workspace/report.docx
```

the frontend turns it into a clickable download link.

Rules:

- Downloads go through `POST /api/download-file`
- The client sends `Authorization: Bearer <user-password>` and `X-Proxy-User`
- Credentials are not exposed in the URL
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
