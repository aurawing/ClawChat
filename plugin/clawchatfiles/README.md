# ClawChat Session Files Plugin

这个插件用于给 ClawChat 会话提供首版的“会话级文件目录策略”：

- 在 `before_prompt_build` 中注入会话文件输出规则
- 按 `sessionKey` 为每个会话创建独立目录
- 提供文件相关 Gateway RPC，供代理服务或其他调用方使用
- 支持作为 npm 包被 `openclaw plugins install` 安装
- 提供 `setup` / `setupWizard` 入口生成插件配置

## 目录结构

```text
plugin/
  clawchatfiles/
    package.json
    openclaw.plugin.json
    index.js
    setup.js
    shared.js
    README.md
```

## 安装

本插件现在已经是一个独立 npm 包目录，可以通过以下方式安装：

```bash
cd plugin/clawchatfiles
npm pack
openclaw plugins install ./claw_chat-clawchatfiles-1.0.0.tgz
```

也可以直接尝试本地目录安装：

```bash
openclaw plugins install ./plugin/clawchatfiles
```

`package.json` 中已声明：

- `openclaw.extensions`
- `openclaw.setupEntry`

`openclaw.plugin.json` 中已声明：

- 原生 OpenClaw 插件清单
- 内联 `configSchema`

因此 OpenClaw 可以从该包加载运行时入口和 setup 入口。

## 推荐测试命令

如果本机已经安装 `openclaw` CLI，建议按下面顺序测试：

```bash
cd plugin/clawchatfiles
npm pack
openclaw plugins install ./claw_chat-clawchatfiles-1.0.0.tgz
openclaw plugins list
openclaw setup
```

如果你更倾向于本地目录联调，可以尝试：

```bash
openclaw plugins install -l ./plugin/clawchatfiles
openclaw plugins list
openclaw setup
```

说明：

- `-l` / `--link` 适合本地开发，避免复制插件目录
- 本机当前开发环境里尚未检测到 `openclaw` CLI，所以这里先补齐了可执行的命令清单，但没有直接在本地跑通安装命令

## 建议配置

```json5
{
  plugins: {
    entries: {
      clawchatfiles: {
        enabled: true,
        hooks: {
          allowPromptInjection: true,
        },
        config: {
          sessionKeyFilter: "clawchat-",
          sessionKeyMatchMode: "includes",
          sessionFilesRoot: "~/.openclaw/workspace/sessions",
          dirNameStrategy: "hash",
          hashLength: 24,
        },
      },
    },
  },
}
```

## 配置字段

- `sessionKeyFilter`
  - 会话 key 过滤条件
- `sessionKeyMatchMode`
  - 支持 `prefix` / `includes` / `regex`
- `sessionFilesRoot`
  - 会话文件根目录；未配置时默认按当前运行用户推导为 `~/.openclaw/workspace/sessions`
- `dirNameStrategy`
  - 支持 `hash` / `raw` / `urlencoded`
- `hashLength`
  - 当 `dirNameStrategy=hash` 时使用

## 提供的 Gateway RPC

- `clawchatfiles.ensure`
  - 输入：`{ sessionKey }`
  - 作用：确保会话目录存在
- `clawchatfiles.list`
  - 输入：`{ sessionKey, path }`
  - 作用：列出当前会话目录下的文件/子目录
- `clawchatfiles.resolve`
  - 输入：`{ sessionKey, path }`
  - 作用：解析当前会话目录中的某个相对路径，供代理服务下载前校验使用

## setup / setupWizard

插件提供了单独的 `setup.js` 入口，导出：

- `setup(ctx)`
- `setupWizard(ctx)`

两者都会围绕以下配置项工作：

- `sessionKeyFilter`
- `sessionKeyMatchMode`
- `sessionFilesRoot`
- `dirNameStrategy`
- `hashLength`

生成的配置 patch 目标为：

```json5
{
  plugins: {
    entries: {
      clawchatfiles: {
        enabled: true,
        hooks: {
          allowPromptInjection: true,
        },
        config: {
          sessionKeyFilter: "clawchat-",
          sessionKeyMatchMode: "includes",
          sessionFilesRoot: "~/.openclaw/workspace/sessions",
          dirNameStrategy: "hash",
          hashLength: 24,
        },
      },
    },
  },
}
```

如果宿主提供了写配置能力，`setup` / `setupWizard.apply` 会直接尝试调用；否则会返回 `configPatch` 给宿主处理。

## 推荐协作方式

按方案 A：

- 插件负责：
  - prompt 注入
  - session 目录创建
  - 文件 RPC
- 代理服务负责：
  - 调用上述 RPC
  - 向前端返回 HTTP 下载响应

这样可以让文件目录策略与 OpenClaw 会话生命周期绑定，同时保留 ClawChat 现有代理层的认证和 API 兼容性。

## 与代理服务配合

当前 ClawChat 代理已经按方案 A 预留了对接方式：

- `/api/files`
  - 向插件调用 `clawchatfiles.list`
- `/api/files/download`
  - 向插件调用 `clawchatfiles.resolve`
  - 再由代理服务负责实际文件流下载

如果 OpenClaw 运行环境与代理服务不在同一文件系统中，需要在代理的 `server/.env` 中配置对应的 home 路径映射，例如：

```env
DOWNLOAD_PATH_MAPS=/home/<user>/.openclaw/workspace=>../workspace
```

用于把插件返回的 OpenClaw 侧路径映射到代理本地可访问路径。
