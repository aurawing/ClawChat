# ClawChat npm Quick Start

This guide explains how to use the npm-published packages and complete the full setup flow:

- install and configure the OpenClaw plugin `@claw_chat/clawchatfiles`
- install, configure, and start the proxy server `@claw_chat/clawchat-proxy`
- pair and authorize the proxy with OpenClaw Gateway
- connect the ClawChat App and start using it

## 1. Components

ClawChat consists of three parts:

- `@claw_chat/clawchatfiles`
  An OpenClaw plugin that creates per-session file directories and exposes file list / file resolve RPCs.
- `@claw_chat/clawchat-proxy`
  A proxy server that bridges the App's SSE + HTTP requests to OpenClaw Gateway and integrates the plugin-based file features.
- ClawChat App
  The mobile or web client used for chat, attachments, file browsing, and downloads.

## 2. Requirements

- Node.js `>= 18`
- npm `>= 9`
- OpenClaw installed and running
- OpenClaw Gateway usually available at `ws://127.0.0.1:18789`

## 3. Install the OpenClaw plugin

Install the plugin from npm through the OpenClaw CLI:

```bash
openclaw plugins install @claw_chat/clawchatfiles
```

Then verify the installation:

```bash
openclaw plugins list
```

If your OpenClaw environment supports interactive configuration, you can also run:

```bash
openclaw setup
```

## 4. Configure the OpenClaw plugin

Recommended plugin configuration:

```json
{
  "plugins": {
    "entries": {
      "clawchatfiles": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        },
        "config": {
          "sessionKeyFilter": "clawchat-",
          "sessionKeyMatchMode": "includes",
          "sessionFilesRoot": "~/.openclaw/workspace/sessions",
          "dirNameStrategy": "hash",
          "hashLength": 24
        }
      }
    }
  }
}
```

Important fields:

- `sessionKeyFilter`
  Enables the plugin only for sessions containing `clawchat-`, which matches ClawChat-created session keys.
- `sessionFilesRoot`
  Root directory for per-session files. Recommended value: `~/.openclaw/workspace/sessions`.
- `dirNameStrategy: "hash"`
  Recommended to avoid path compatibility issues caused by raw session keys.

If you edit the config manually, you will usually update an OpenClaw runtime config file such as:

```text
~/.openclaw/openclaw.json
```

## 5. Install the proxy server

Two recommended options:

Option A: run directly with `npx`

```bash
npx @claw_chat/clawchat-proxy --setup
```

Option B: install globally

```bash
npm install -g @claw_chat/clawchat-proxy
clawchat-proxy --setup
```

On first setup, the proxy creates:

```text
~/.clawchat-proxy/
├── .clawchat-proxy
├── .device-key.json
├── clawchat.db
└── uploads/
```

Key files:

- `~/.clawchat-proxy/.clawchat-proxy`
  Proxy config file
- `~/.clawchat-proxy/.device-key.json`
  Device identity used to pair with OpenClaw Gateway

## 6. Configure the proxy server

Edit:

```text
~/.clawchat-proxy/.clawchat-proxy
```

Example config:

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

Important fields:

- `PROXY_USERS`
  App login credentials in the format `username:password,username2:password2`
- `OPENCLAW_GATEWAY_TOKEN`
  Gateway token-based authentication
- `OPENCLAW_GATEWAY_PASSWORD`
  Gateway password-based authentication, higher priority than token
- `DOWNLOAD_ROOTS`
  Download whitelist for the App. Recommended value: `~/.openclaw/workspace/sessions`
- `DOWNLOAD_PATH_MAPS`
  Maps OpenClaw-side paths to local proxy-side paths when they are not on the same filesystem

Example:

```env
DOWNLOAD_PATH_MAPS=/home/openclaw/.openclaw/workspace=>../workspace
```

## 7. Start the proxy server

If you use `npx`:

```bash
npx @claw_chat/clawchat-proxy
```

If installed globally:

```bash
clawchat-proxy
```

By default the proxy listens on:

```text
http://0.0.0.0:18888
```

## 8. Pairing and authorization with OpenClaw Gateway

The proxy connects to Gateway with two layers:

- Gateway authentication
  Uses `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`
- Device pairing
  On first connection, the proxy also presents an Ed25519 device identity to Gateway

If Gateway requires pairing, both the proxy and the App enter a waiting-for-approval state. At that point:

1. Open the OpenClaw Console
2. Go to `Nodes -> Devices`
3. Find the device request created by the proxy
4. Match it using the displayed `Pairing Request ID` or `Device ID`
5. Approve the request

After approval:

- the proxy automatically retries the connection
- the paired device credential is saved to `~/.clawchat-proxy/.device-key.json`
- later restarts of the same proxy instance usually do not require pairing again

To force a new pairing flow, delete:

```text
~/.clawchat-proxy/.device-key.json
```

Then restart the proxy.

## 9. Connect the App to the proxy

In the ClawChat App login screen, fill in:

- Server address
  Example: `http://192.168.1.100:18888`
- Username
  One of the users from `PROXY_USERS`
- User password
  The password for that user

Notes:

- Do not use `localhost` when connecting from a phone to a computer-hosted proxy
- Use the computer's LAN IP instead
- The phone and the computer should be on the same local network

After connecting, the App will:

- establish an SSE event stream
- load or restore session history
- enter the chat page

If the proxy is still waiting for pairing approval, the App will show the pairing-pending view and continue automatically after approval in the OpenClaw Console.

## 10. What the App can do

After connecting, the App supports:

- text chat
- image, PDF, DOCX, TXT, and similar attachments
- automatic session title summarization
- session file browsing
- downloading files from the OpenClaw session directory

Notes:

- file browsing and download depend on `@claw_chat/clawchatfiles`
- document attachments are extracted by the proxy and then passed to the model as text context
- download access is restricted to the `DOWNLOAD_ROOTS` whitelist

## 11. Recommended full setup order

Recommended sequence:

```bash
openclaw plugins install @claw_chat/clawchatfiles
openclaw setup

npx @claw_chat/clawchat-proxy --setup
npx @claw_chat/clawchat-proxy
```

Then in the App, use:

- `Server Address`: `http://your-computer-ip:18888`
- `Username`: a username from `PROXY_USERS`
- `User Password`: the matching password

## 12. Troubleshooting

### 1. The App cannot connect to the proxy

- make sure the proxy is running
- make sure you are using a LAN IP instead of `localhost`
- make sure port `18888` is allowed by the firewall

### 2. The proxy cannot connect to Gateway

- check `OPENCLAW_GATEWAY_URL`
- check `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`
- make sure OpenClaw is running

### 3. The App stays stuck on pairing pending

- approve the device in OpenClaw Console under `Nodes -> Devices`
- to restart the pairing flow, delete `~/.clawchat-proxy/.device-key.json` and restart the proxy

### 4. File browser or downloads do not work

- make sure `@claw_chat/clawchatfiles` is installed and enabled
- check whether the plugin's `sessionKeyFilter` matches ClawChat sessions
- check `DOWNLOAD_ROOTS` and `DOWNLOAD_PATH_MAPS` in the proxy config
