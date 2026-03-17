# ClawChat

OpenClaw 移动聊天客户端，基于 Capacitor + React + TypeScript 构建。

## 功能特性

- **流式对话** — 打字机效果实时输出，支持多轮 assistant 气泡展示与工具调用交错渲染
- **文件上传** — 支持相机拍照、相册选择、文件上传作为对话附件（base64 编码）
- **Markdown 渲染** — 支持 GFM 表格、代码高亮、一键复制
- **结果下载** — 当助手最终结论中出现本地构建产物路径时，可直接点击下载
- **会话管理** — 多会话切换、删除，支持多智能体
- **离线缓存** — IndexedDB 本地持久化消息，断网可查看历史
- **自动重连** — 指数退避重连 + SSE 断线续传 + 消息去重
- **登录鉴权** — `PROXY_USERS` 多用户账号密码认证
- **Ed25519 设备签名** — 代理服务端自动生成设备密钥，兼容 OpenClaw 2.13+ 认证
- **AI 自动标题** — 第一轮对话结束后由 AI 总结主题并替换默认标题
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
│  ClawChat Server    │  ← Node.js 代理服务 (端口 18888)
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

如果你希望直接使用已经发布到 npm 的插件和代理服务，可先阅读：

- `QUICKSTART.md`

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

**首次启动会进入引导，并在用户目录下生成配置目录 `~/.clawchat-proxy/`，其中配置文件位于 `~/.clawchat-proxy/.clawchat-proxy`。**

```bash
npx @claw_chat/clawchat-proxy
```

首次启动时你会看到：

```
欢迎使用 ClawChat Proxy 初始化向导
配置文件将写入: ~/.clawchat-proxy/.clawchat-proxy
配置已写入: ~/.clawchat-proxy/.clawchat-proxy
```

填写好 `PROXY_USERS` 后，在 App 登录时输入对应的用户名和密码即可。后续直接运行 `npx @claw_chat/clawchat-proxy` 即可启动。

### 2.1 本地验证 `npm link`

如果你还没发布到 npm，可以先本地验证 CLI：

```bash
cd server
npm link
clawchat-proxy --setup
clawchat-proxy
```

如果想取消全局链接：

```bash
cd server
npm unlink -g @claw_chat/clawchat-proxy
```

### 3. 配置（可选）

如需自定义配置，编辑 `~/.clawchat-proxy/.clawchat-proxy`：

```env
# 代理服务端口
PROXY_PORT=18888

# 客户端账号（格式：用户名:密码,用户名2:密码2）
PROXY_USERS=alice:password1,bob:password2

# OpenClaw Gateway 地址
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789

# OpenClaw Gateway 认证 token（从 ~/.openclaw/gateway.yaml 获取）
OPENCLAW_GATEWAY_TOKEN=

# OpenClaw Gateway 认证密码（优先于 token，与 token 二选一）
OPENCLAW_GATEWAY_PASSWORD=

# 允许下载的目录白名单（默认仅开放 OpenClaw 会话文件目录）
DOWNLOAD_ROOTS=~/.openclaw/workspace/sessions

# 可选：将智能体输出中的虚拟路径映射到本机真实路径
DOWNLOAD_PATH_MAPS=

# 日志级别
LOG_LEVEL=info

# 允许的跨域来源（留空表示允许全部）
ALLOWED_ORIGINS=
```

**关键配置说明：**

| 变量 | 说明 | 如何获取 |
|------|------|---------|
| `PROXY_USERS` | 客户端可登录的多用户账号 | 格式为 `用户名:密码,用户名2:密码2` |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway 认证 Token | 首次引导会优先尝试从 `~/.openclaw/openclaw.json` 自动读取 |
| `OPENCLAW_GATEWAY_PASSWORD` | Gateway 认证密码（优先于 Token） | 在 OpenClaw 中设置的密码 |
| `DOWNLOAD_ROOTS` | 允许被客户端下载的目录白名单 | 逗号分隔路径，支持相对配置文件目录的路径和 `~/` |
| `DOWNLOAD_PATH_MAPS` | 虚拟路径到本机真实路径的映射 | 例如 `/root/.openclaw/workspace=>~/workspace` |
| `ALLOWED_ORIGINS` | 允许的跨域来源 | 留空表示允许全部 |

> **注意：** 如果 OpenClaw 启用了设备配对机制，首次连接可能需要在 OpenClaw 端手动批准设备。代理服务会自动生成 Ed25519 设备密钥，配置和运行数据默认都保存在 `~/.clawchat-proxy/` 中。

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
npx @claw_chat/clawchat-proxy
```

访问 `http://你的服务器IP:18888` 即可使用。

### 5. App 中登录

1. 打开 App（浏览器或 Capacitor 原生应用）
2. 在登录页填写：
   - **服务器地址**：`http://192.168.1.100:18888`
   - **用户名 / 密码**：`~/.clawchat-proxy/.clawchat-proxy` 中 `PROXY_USERS` 里对应的一组账号
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
- **工具调用（Tool Calling）** — 显示工具名称和状态（调用中/已完成/失败）
- **多轮拆分** — 工具调用前后会自动拆分为多条 assistant 气泡，和历史恢复效果保持一致

### 下载构建结果

如果助手在最终结论正文中输出了可下载的本地文件路径，例如：

```text
/root/.openclaw/workspace/日本经济分析报告.docx
```

前端会自动将其渲染为可点击下载链接。

说明：

- 下载通过代理服务的 `/api/download-file` 接口完成
- 请求使用登录时的用户密码放在 `Authorization` 请求头中，并额外带上 `X-Proxy-User`
- 只有 `DOWNLOAD_ROOTS` 白名单目录内的文件允许下载
- 工具调用面板中的原始输出不会自动出现下载按钮，下载入口只出现在助手最终正文中

### 停止生成

AI 回复过程中，发送按钮会变为红色停止按钮，点击即可中断生成。

### 会话管理

- **切换对话** — 点击左上角菜单图标打开侧边栏，选择对话
- **删除对话** — 在侧边栏中，鼠标悬停到对话条目上，点击垃圾桶图标
- **刷新列表** — 点击侧边栏顶部刷新按钮同步服务端会话

### 断开连接

点击会话列表底部的断开按钮即可返回登录页面。

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

**手动签名 release APK（推荐将 keystore 放在 `android/signing/`）：**

```powershell
# 1. 构建 release（得到 unsigned APK）
npm run cap:sync
cd android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleRelease

# 2. 使用 Android SDK Build Tools 中的 apksigner 进行手动签名
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\<build-tools-version>\apksigner.bat" sign `
  --ks ".\signing\clawchat-release.jks" `
  --ks-key-alias "clawchat" `
  --out ".\app\build\outputs\apk\release\app-release.apk" `
  ".\app\build\outputs\apk\release\app-release-unsigned.apk"

# 3. 校验签名
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\<build-tools-version>\apksigner.bat" verify --verbose `
  ".\app\build\outputs\apk\release\app-release.apk"
```

release 输出路径：

- 未签名：`android/app/build/outputs/apk/release/app-release-unsigned.apk`
- 已签名：`android/app/build/outputs/apk/release/app-release.apk`

> **注意：** `android/signing/` 已加入 `.gitignore`，适合存放本地 keystore，但不要把 keystore 和密码提交到仓库。

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

使用 Nginx/Caddy 反向代理 `localhost:18888`，并配置 HTTPS 证书：

```nginx
server {
    listen 443 ssl;
    server_name chat.your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:18888;
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
ssh -R 18888:localhost:18888 your-server
```

---

## API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/connect` | POST | 建立代理会话，验证用户名和密码，连接 Gateway |
| `/api/events?sid=xxx` | GET | SSE 事件流，接收 Gateway 推送 |
| `/api/send` | POST | 发送 RPC 请求（转发到 Gateway） |
| `/api/disconnect` | POST | 断开代理会话 |
| `/api/download-file` | POST | 下载白名单目录中的文件（`Authorization` + `X-Proxy-User` 鉴权） |
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
├── android/                       # Capacitor Android 项目
├── capacitor.config.ts            # Capacitor 配置
├── vite.config.ts                 # Vite 构建配置
└── package.json                   # 前端依赖 + 脚本
```

运行时文件默认写入：

```text
~/.clawchat-proxy/
├── .clawchat-proxy
├── .device-key.json
├── clawchat.db
└── uploads/
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
| 认证 | Ed25519 设备签名（Gateway） / 用户名密码（客户端） |

## 常见问题

### Q: 连接失败怎么办？

1. 确认 OpenClaw Gateway 已启动（默认端口 18789）
2. 确认代理服务已启动（`npx @claw_chat/clawchat-proxy`）
3. 查看代理服务控制台的错误日志
4. 检查 `~/.clawchat-proxy/.clawchat-proxy` 中的 Gateway 地址和认证信息是否正确
5. 检查 App 中填写的服务器地址、用户名和密码是否与 `~/.clawchat-proxy/.clawchat-proxy` 中的 `PROXY_USERS` 一致
6. 如果跨网络访问，确认防火墙已放行 18888 端口

### Q: 手机连不上本地服务？

手机和电脑必须在同一局域网。服务器地址使用电脑的局域网 IP（如 `http://192.168.1.x:18888`），不能用 `localhost`。

### Q: Gateway 认证失败？

- 检查 `~/.clawchat-proxy/.clawchat-proxy` 中的 `OPENCLAW_GATEWAY_TOKEN` 或 `OPENCLAW_GATEWAY_PASSWORD` 是否正确
- 如果 OpenClaw 启用了设备配对，需在 OpenClaw 端批准新设备
- 设备密钥保存在 `~/.clawchat-proxy/.device-key.json`，如需重新配对可删除此文件重启服务

### Q: 如何获取 OpenClaw Gateway Token？

首次引导会优先读取：

```bash
cat ~/.openclaw/openclaw.json
```

如果未自动识别成功，再手动查看其中 `gateway.auth` 下的配置并填入 `~/.clawchat-proxy/.clawchat-proxy`。

### Q: 文件上传大小限制？

文件以 base64 编码在消息中发送，服务端 JSON body 限制为 50MB。建议单个文件不超过 20MB。

## License

MIT
