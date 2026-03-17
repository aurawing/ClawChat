# ClawChat npm 安装与使用说明

本文档面向已经通过 npm 发布的组件，说明如何完成以下流程：

- 安装并配置 OpenClaw 插件 `@claw_chat/clawchatfiles`
- 安装、配置并启动代理服务 `@claw_chat/clawchat-proxy`
- 完成代理服务与 OpenClaw Gateway 的配对和授权
- 在 ClawChat App 中连接代理服务并开始使用

## 1. 组件关系

ClawChat 由三部分组成：

- `@claw_chat/clawchatfiles`
  OpenClaw 插件，负责为每个会话建立文件目录，并提供文件列表/文件解析 RPC。
- `@claw_chat/clawchat-proxy`
  代理服务，负责把 App 的 SSE + HTTP 请求转发到 OpenClaw Gateway，并接入插件提供的文件能力。
- ClawChat App
  移动端或 Web 端客户端，连接代理服务后进行聊天、上传附件、浏览和下载会话文件。

## 2. 环境要求

- Node.js `>= 18`
- npm `>= 9`
- OpenClaw 已安装并可正常运行
- OpenClaw Gateway 默认地址通常为 `ws://127.0.0.1:18789`

## 3. 安装 OpenClaw 插件

直接通过 OpenClaw CLI 从 npm 安装：

```bash
openclaw plugins install @claw_chat/clawchatfiles
```

安装完成后建议检查：

```bash
openclaw plugins list
```

如果你的 OpenClaw 支持交互式配置，也可以运行：

```bash
openclaw setup
```

## 4. 配置 OpenClaw 插件

推荐在 OpenClaw 配置中启用如下插件配置：

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

关键配置说明：

- `sessionKeyFilter`
  只对包含 `clawchat-` 的会话启用文件目录策略，和 ClawChat 创建的会话命名保持一致。
- `sessionFilesRoot`
  会话文件根目录，推荐保持为 `~/.openclaw/workspace/sessions`。
- `dirNameStrategy: "hash"`
  推荐使用哈希目录名，避免原始会话 key 带来路径兼容问题。

如果你是手动修改配置，通常需要编辑 OpenClaw 的运行配置文件，例如：

```text
~/.openclaw/openclaw.json
```

## 5. 安装代理服务

有两种推荐方式。

方式 A：直接通过 `npx` 运行

```bash
npx @claw_chat/clawchat-proxy --setup
```

方式 B：全局安装

```bash
npm install -g @claw_chat/clawchat-proxy
clawchat-proxy --setup
```

首次运行 `--setup` 时，代理会在用户目录中创建：

```text
~/.clawchat-proxy/
├── .clawchat-proxy
├── .device-key.json
├── clawchat.db
└── uploads/
```

其中：

- `~/.clawchat-proxy/.clawchat-proxy`
  代理服务配置文件
- `~/.clawchat-proxy/.device-key.json`
  代理用于和 OpenClaw Gateway 配对的设备身份

## 6. 配置代理服务

编辑以下文件：

```text
~/.clawchat-proxy/.clawchat-proxy
```

示例配置：

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

关键配置说明：

- `PROXY_USERS`
  App 登录使用的账号密码，格式为 `用户名:密码,用户名2:密码2`
- `OPENCLAW_GATEWAY_TOKEN`
  Gateway token 认证
- `OPENCLAW_GATEWAY_PASSWORD`
  Gateway password 认证，优先级高于 token
- `DOWNLOAD_ROOTS`
  允许客户端下载的目录白名单，推荐保持为 `~/.openclaw/workspace/sessions`
- `DOWNLOAD_PATH_MAPS`
  如果 OpenClaw 与代理服务不在同一文件系统，用它把 OpenClaw 返回的路径映射到代理本机路径

例如：

```env
DOWNLOAD_PATH_MAPS=/home/openclaw/.openclaw/workspace=>../workspace
```

## 7. 启动代理服务

如果使用 `npx`：

```bash
npx @claw_chat/clawchat-proxy
```

如果已经全局安装：

```bash
clawchat-proxy
```

启动后代理默认监听：

```text
http://0.0.0.0:18888
```

## 8. 代理如何与 OpenClaw 配对和授权

代理服务和 OpenClaw Gateway 的接入分两层：

- Gateway 认证
  通过 `OPENCLAW_GATEWAY_TOKEN` 或 `OPENCLAW_GATEWAY_PASSWORD`
- 设备配对
  首次连接时，代理还会使用 Ed25519 设备身份向 Gateway 发起配对

首次连接时，如果 Gateway 要求配对，代理和 App 会进入“等待配对批准”状态。此时你需要：

1. 打开 OpenClaw Console
2. 进入 `Nodes -> Devices`
3. 找到代理服务发起的设备请求
4. 根据界面上显示的 `Pairing Request ID` 或 `Device ID` 找到对应请求
5. 点击批准

批准后：

- 代理会自动重试连接
- 配对成功后会把设备凭据保存到 `~/.clawchat-proxy/.device-key.json`
- 后续同一代理实例重启时通常不需要再次配对

如果你想重新配对，可以删除：

```text
~/.clawchat-proxy/.device-key.json
```

然后重启代理服务。

## 9. App 如何连接代理服务

打开 ClawChat App 后，在登录页填写：

- 服务器地址
  例如 `http://192.168.1.100:18888`
- 用户名
  来自 `PROXY_USERS`
- 用户密码
  对应用户名的密码

注意：

- 手机连接电脑上的代理服务时，不能填写 `localhost`
- 需要填写电脑在局域网中的实际 IP
- 手机和电脑需要在同一局域网下

连接成功后，App 会：

- 建立 SSE 事件流
- 获取/恢复会话列表
- 进入聊天页

如果代理仍在等待配对，App 会显示配对等待界面，等你在 OpenClaw Console 批准后会自动继续连接。

## 10. App 中可用功能

连接成功后可以使用：

- 文本对话
- 上传图片、PDF、DOCX、TXT 等附件
- 自动会话标题总结
- 会话文件浏览
- 下载 OpenClaw 会话目录中的文件

其中：

- 文件浏览和下载依赖 `@claw_chat/clawchatfiles`
- 文档附件会通过代理提取正文后再发送给模型
- 下载能力只允许访问 `DOWNLOAD_ROOTS` 白名单目录

## 11. 推荐完整安装顺序

推荐按以下顺序搭建：

```bash
openclaw plugins install @claw_chat/clawchatfiles
openclaw setup

npx @claw_chat/clawchat-proxy --setup
npx @claw_chat/clawchat-proxy
```

然后在 App 中填写：

- `服务器地址`: `http://你的电脑IP:18888`
- `用户名`: `PROXY_USERS` 中的用户名
- `用户密码`: 对应密码

## 12. 常见问题

### 1. App 连不上代理服务

- 检查代理是否已启动
- 检查是否使用了局域网 IP，而不是 `localhost`
- 检查防火墙是否放行 `18888`

### 2. 代理连接 Gateway 失败

- 检查 `OPENCLAW_GATEWAY_URL`
- 检查 `OPENCLAW_GATEWAY_TOKEN` 或 `OPENCLAW_GATEWAY_PASSWORD`
- 检查 OpenClaw 是否已运行

### 3. App 一直停在等待配对

- 去 OpenClaw Console 的 `Nodes -> Devices` 批准设备
- 如需重新发起配对，删除 `~/.clawchat-proxy/.device-key.json` 后重启代理

### 4. 文件浏览页打不开或无法下载

- 检查插件 `@claw_chat/clawchatfiles` 是否已安装并启用
- 检查插件配置中的 `sessionKeyFilter` 是否允许 ClawChat 会话
- 检查代理中的 `DOWNLOAD_ROOTS` 和 `DOWNLOAD_PATH_MAPS`
