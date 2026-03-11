# ClawChat

OpenClaw 移动聊天客户端，基于 Capacitor + React + TypeScript 构建，兼容 `qingchencloud/clawapp` 协议。

## 功能特性

- **流式对话** — 打字机效果实时输出，支持思维链（Thinking）和工具调用（Tool Calling）的流式展示
- **文件上传** — 支持相机拍照、相册选择、文件上传作为对话附件（base64 编码）
- **Markdown 渲染** — 支持 GFM 表格、代码高亮、一键复制
- **会话管理** — 多会话切换、删除，支持多智能体
- **离线缓存** — IndexedDB 本地持久化消息，断网可查看历史
- **自动重连** — 指数退避重连 + SSE 断线续传 + 消息去重
- **登录鉴权** — PROXY_TOKEN 密码认证
- **Ed25519 设备签名** — 代理服务端自动生成设备密钥，兼容 OpenClaw 2.13+ 认证
- **深色主题** — 类 ChatGPT 暗色 UI，适配安全区域

## 系统架构

```
┌─────────────────────┐
│  ClawChat App       │  ← Capacitor (iOS/Android/PWA)
│  React + TypeScript │
└─────────┬───────────┘
          │ SSE (事件流) + HTTP POST (RPC)
          ▼
┌─────────────────────┐
│  ClawChat Server    │  ← Node.js 代理服务 (端口 3210)
│  Express + SSE      │
└─────────┬───────────┘
          │ WebSocket + Ed25519 设备签名
          ▼
┌─────────────────────┐
│  OpenClaw Gateway   │  ← 本地 AI 网关 (端口 18789)
└─────────────────────┘
```

**通信协议说明：**

- **App ↔ 代理服务**：SSE (`GET /api/events`) 接收服务端推送事件 + HTTP POST (`/api/send`) 发送 RPC 请求
- **代理服务 ↔ Gateway**：WebSocket 长连接，使用 Ed25519 设备签名进行握手认证

> OpenClaw Gateway 默认仅监听 `127.0.0.1`，手机无法直接连接，因此需要 ClawChat Server 作为中间代理层。

---

## 环境要求

- **Node.js** >= 18
- **npm** >= 9
- **OpenClaw** >= 2.13 已安装并运行（Gateway 端口 18789）
- **Android Studio**（构建 Android APK 时需要）
- **Xcode**（构建 iOS 时需要，仅 macOS）

---

## 快速开始

### 1. 安装依赖

```bash
# 前端依赖
npm install

# 后端代理服务依赖
cd server
npm install
cd ..
```

### 2. 启动后端代理服务

**首次启动会自动生成配置文件 `server/.env`，并输出自动生成的连接密码。**

```bash
cd server
node index.js
```

首次启动时你会看到：

```
[INFO] 首次启动，已自动创建 server/.env 配置文件
[INFO] 自动生成的连接密码: xxxxxxxxxxxx
```

**记住这个密码**，在 App 登录时需要填写。

### 3. 配置（可选）

如需自定义配置，编辑 `server/.env`：

```env
# 代理服务端口
PROXY_PORT=3210

# 客户端连接密码（登录时填写的 Token）
PROXY_TOKEN=你的连接密码

# OpenClaw Gateway 地址
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789

# OpenClaw Gateway 认证 token（从 ~/.openclaw/gateway.yaml 获取）
OPENCLAW_GATEWAY_TOKEN=

# OpenClaw Gateway 认证密码（优先于 token，与 token 二选一）
OPENCLAW_GATEWAY_PASSWORD=
```

**关键配置说明：**

| 变量 | 说明 | 如何获取 |
|------|------|---------|
| `PROXY_TOKEN` | 客户端连接代理服务的密码 | 首次启动自动生成，或自行修改 |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway 认证 Token | 查看 `~/.openclaw/gateway.yaml` 中的 `token` 字段 |
| `OPENCLAW_GATEWAY_PASSWORD` | Gateway 认证密码（优先于 Token） | 在 OpenClaw 中设置的密码 |

> **注意：** 如果 OpenClaw 启用了设备配对机制，首次连接可能需要在 OpenClaw 端手动批准设备。代理服务会自动生成 Ed25519 设备密钥（保存在 `server/.device-key.json`）。

### 4. 启动服务

**方式 A：开发模式（推荐用于调试）**

打开两个终端：

```bash
# 终端 1 - 启动后端代理服务
npm run dev:server

# 终端 2 - 启动前端开发服务器
npm run dev
```

前端开发服务器运行在 `http://localhost:5173`。

**方式 B：生产模式**

```bash
# 构建前端
npm run build

# 启动代理服务（同时托管前端静态文件）
cd server
node index.js
```

访问 `http://你的服务器IP:3210` 即可使用。

### 5. App 中登录

1. 打开 App（浏览器或 Capacitor 原生应用）
2. 在登录页填写：
   - **服务器地址**：`192.168.1.100:3210`（IP 地址自动使用 http，域名自动使用 https）
   - **连接密码**：`server/.env` 中的 `PROXY_TOKEN`
3. 点击「连接」

连接成功后自动进入聊天界面。

---

## 使用指南

### 发送消息

在底部输入框输入文本，按回车或点击发送按钮。支持 Shift+Enter 换行。

### 上传文件

点击输入框左侧的 **+** 按钮，选择：

- **拍照** — 调用系统相机拍照后作为附件发送
- **相册** — 从手机相册选择图片
- **文件** — 选择 PDF、文档、文本等文件（支持 `.pdf .doc .docx .txt .csv .json .md`）

选择后会在输入框上方显示预览缩略图，可点击 × 移除。附件以 base64 编码随消息一同发送。

### 流式输出

AI 的回复会以流式方式逐字展示：

- **普通文本** — 打字机效果 + 闪烁光标
- **思维链（Thinking）** — 显示为紫色折叠区块，点击可展开/收起查看 AI 推理过程
- **工具调用（Tool Calling）** — 显示工具名称和状态（调用中/已完成/失败）

### 停止生成

AI 回复过程中，发送按钮会变为红色停止按钮，点击即可中断生成。

### 会话管理

- **切换对话** — 点击左上角菜单图标打开侧边栏，选择对话
- **删除对话** — 在侧边栏中，鼠标悬停到对话条目上，点击垃圾桶图标
- **刷新列表** — 点击侧边栏顶部刷新按钮同步服务端会话

### 断开连接

点击右上角退出图标即可断开连接，返回登录页面。

---

## 构建移动 App

### Android

```bash
# 首次：添加 Android 平台
npm run cap:add:android

# 构建前端 + 同步到 Android 项目
npm run cap:sync

# 打开 Android Studio
npm run cap:open:android
```

**命令行编译 APK（无需打开 Android Studio）：**

```powershell
# 设置 JDK（使用 Android Studio 内置 JDK）
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"

# 编译 debug APK
cd android
.\gradlew.bat assembleDebug
```

APK 输出路径：`android/app/build/outputs/apk/debug/app-debug.apk`

**注意：** Android 真机调试时需要允许明文 HTTP（如果代理服务未配置 HTTPS）。`android/app/src/main/AndroidManifest.xml` 中已默认包含 `android:usesCleartextTraffic="true"`。

### iOS（仅 macOS）

```bash
# 首次：添加 iOS 平台
npm run cap:add:ios

# 构建前端 + 同步到 iOS 项目
npm run cap:sync

# 打开 Xcode
npm run cap:open:ios
```

在 Xcode 中配置签名后即可构建到模拟器或真机。

---

## 外网访问

如果需要在外网使用（不在同一局域网），有以下方案：

### 方案 A：反向代理（推荐）

使用 Nginx/Caddy 反向代理 `localhost:3210`，并配置 HTTPS 证书：

```nginx
server {
    listen 443 ssl;
    server_name chat.your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;           # SSE 需要关闭缓冲
        proxy_cache off;
        proxy_read_timeout 86400;
    }
}
```

App 中服务器地址填写：`chat.your-domain.com`（域名自动使用 https）

### 方案 B：Tailscale

通过 Tailscale 组网直接访问局域网地址，无需暴露公网端口。

### 方案 C：SSH 隧道

```bash
ssh -R 3210:localhost:3210 your-server
```

---

## API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/connect` | POST | 建立代理会话，验证 Token，连接 Gateway |
| `/api/events?sid=xxx` | GET | SSE 事件流，接收 Gateway 推送 |
| `/api/send` | POST | 发送 RPC 请求（转发到 Gateway） |
| `/api/disconnect` | POST | 断开代理会话 |
| `/api/progress?sid=xxx` | GET | 查询会话执行状态 |
| `/health` | GET | 健康检查 |

---

## 项目结构

```
ClawChat/
├── src/
│   ├── main.tsx                  # 应用入口
│   ├── App.tsx                   # 根组件（登录/聊天切换）
│   ├── index.css                 # 全局样式 (Tailwind + Markdown)
│   ├── types/index.ts            # TypeScript 类型定义
│   ├── services/
│   │   ├── api-client.ts         # SSE+POST API 客户端（重连/去重/会话恢复）
│   │   └── db.ts                 # IndexedDB 本地存储 (Dexie)
│   ├── stores/
│   │   └── chatStore.ts          # Zustand 全局状态管理
│   ├── components/
│   │   ├── ChatInput.tsx          # 聊天输入框（附件/发送/停止）
│   │   ├── MessageBubble.tsx      # 消息气泡（用户/AI/系统）
│   │   ├── MarkdownRenderer.tsx   # Markdown 渲染 + 代码高亮
│   │   ├── ThinkingBlock.tsx      # 思维链折叠展示
│   │   ├── ToolCallBlock.tsx      # 工具调用状态展示
│   │   └── SessionList.tsx        # 会话列表侧边栏
│   └── pages/
│       ├── LoginPage.tsx          # 登录页
│       └── ChatPage.tsx           # 聊天主页
├── server/
│   ├── index.js                   # 代理服务（Express + SSE + Ed25519）
│   ├── package.json               # 后端依赖
│   ├── .env                       # 环境变量（首次启动自动生成）
│   └── .device-key.json           # Ed25519 设备密钥（自动生成）
├── android/                       # Capacitor Android 项目
├── capacitor.config.ts            # Capacitor 配置
├── vite.config.ts                 # Vite 构建配置
└── package.json                   # 前端依赖 + 脚本
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 19 + TypeScript |
| 移动框架 | Capacitor 8 |
| 构建工具 | Vite 7 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 |
| 本地存储 | Dexie (IndexedDB) |
| Markdown | react-markdown + rehype-highlight |
| 后端 | Express 4 + ws (上游) |
| 通信协议 | SSE + HTTP POST（客户端） / WebSocket（上游） |
| 认证 | Ed25519 设备签名（Gateway） / Token（客户端） |

## 常见问题

### Q: 连接失败怎么办？

1. 确认 OpenClaw Gateway 已启动（默认端口 18789）
2. 确认代理服务已启动（`cd server && node index.js`）
3. 查看代理服务控制台的错误日志
4. 检查 `server/.env` 中的 Gateway 地址和 Token 是否正确
5. 检查 App 中填写的服务器地址和连接密码是否与 `.env` 中的 `PROXY_TOKEN` 一致
6. 如果跨网络访问，确认防火墙已放行 3210 端口

### Q: 手机连不上本地服务？

手机和电脑必须在同一局域网。服务器地址使用电脑的局域网 IP（如 `192.168.1.x:3210`），不能用 `localhost`。

### Q: Gateway 认证失败？

- 检查 `server/.env` 中的 `OPENCLAW_GATEWAY_TOKEN` 或 `OPENCLAW_GATEWAY_PASSWORD` 是否正确
- 如果 OpenClaw 启用了设备配对，需在 OpenClaw 端批准新设备
- 设备密钥保存在 `server/.device-key.json`，如需重新配对可删除此文件重启服务

### Q: 如何获取 OpenClaw Gateway Token？

查看 OpenClaw 安装目录下的配置文件：

```bash
cat ~/.openclaw/gateway.yaml
```

找到 `token` 字段的值即可。

### Q: 文件上传大小限制？

文件以 base64 编码在消息中发送，服务端 JSON body 限制为 50MB。建议单个文件不超过 20MB。

## License

MIT
