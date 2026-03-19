#!/usr/bin/env node
/**
 * ClawChat SSE + HTTP POST 代理服务端
 *
 * 架构：
 * - 多个 APP ←SSE+POST→ 代理服务端 ←共享WS→ OpenClaw Gateway
 * - 支持多用户：每个用户独立 sessionKey，对话完全隔离
 * - 设备身份共享：Gateway 只需配对一次
 *
 * API：
 * - POST /api/connect   建立用户会话
 * - GET  /api/events    SSE 事件流（服务端推送）
 * - POST /api/send      发送 RPC 请求
 * - POST /api/disconnect 断开会话
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import archiver from 'archiver';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, normalize, basename, extname, isAbsolute } from 'path';
import { homedir } from 'os';
import { argv, exit, stdin as input, stdout as output } from 'process';
import { createInterface } from 'readline/promises';
import {
  randomUUID, generateKeyPairSync, createHash,
  sign as ed25519Sign, createPrivateKey,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from 'fs';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_DIR = __dirname;
const DEFAULT_PROXY_HOME = resolve(process.env.CLAWCHAT_PROXY_HOME || join(homedir(), '.clawchat-proxy'));
const LEGACY_CONFIG_PATH = resolve(join(homedir(), '.clawchat-proxy'));
const LEGACY_DATA_DIR = resolve(join(homedir(), '.clawchat-proxy-data'));
const CONFIG_PATH = resolve(process.env.CLAWCHAT_PROXY_CONFIG || join(DEFAULT_PROXY_HOME, '.clawchat-proxy'));
const CONFIG_DIR = dirname(CONFIG_PATH);
const DATA_DIR = resolve(process.env.CLAWCHAT_PROXY_DATA_DIR || CONFIG_DIR);
const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_PORT = '18888';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_DOWNLOAD_ROOT = join(homedir(), '.openclaw', 'workspace', 'sessions');

function resolveConfigPath(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return CONFIG_DIR;
  if (trimmed === '~') return homedir();
  const expanded = trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? join(homedir(), trimmed.slice(2))
    : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(CONFIG_DIR, expanded);
}

function parseDownloadPathMaps(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [from, to] = entry.split('=>').map((s) => s?.trim());
      if (!from || !to) return null;
      return { from, to: resolveConfigPath(to) };
    })
    .filter(Boolean);
}

function loadOpenClawAuthPreset() {
  const fallback = {
    key: 'OPENCLAW_GATEWAY_TOKEN',
    value: '',
    source: '未找到 ~/.openclaw/openclaw.json，将手动配置 Gateway Token',
  };

  if (!existsSync(OPENCLAW_CONFIG_PATH)) return fallback;

  try {
    const parsed = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
    const auth = parsed?.gateway?.auth || {};
    const mode = String(auth.mode || '').trim().toLowerCase();
    const detectedValue = String(auth.token || auth.password || '').trim();

    if (mode === 'token') {
      return {
        key: 'OPENCLAW_GATEWAY_TOKEN',
        value: detectedValue,
        source: `已从 ~/.openclaw/openclaw.json 检测到 gateway.auth.mode=token`,
      };
    }
    if (mode === 'password') {
      return {
        key: 'OPENCLAW_GATEWAY_PASSWORD',
        value: detectedValue,
        source: `已从 ~/.openclaw/openclaw.json 检测到 gateway.auth.mode=password`,
      };
    }
    return {
      ...fallback,
      source: 'openclaw.json 中未识别到 gateway.auth.mode，改为手动配置 Gateway Token',
    };
  } catch (error) {
    return {
      ...fallback,
      source: `读取 ~/.openclaw/openclaw.json 失败：${error.message}`,
    };
  }
}

async function promptWithDefault(rl, label, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix}: `);
  const trimmed = answer.trim();
  return trimmed || defaultValue;
}

function normalizePort(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? String(parsed)
    : DEFAULT_PORT;
}

function normalizeLogLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['error', 'warn', 'info', 'debug', 'trace'].includes(normalized)
    ? normalized
    : 'info';
}

function buildConfigContent(values) {
  const lines = [
    '# ClawChat Proxy 配置文件（首次引导生成）',
    `# 路径: ${CONFIG_PATH}`,
    '',
    '# 代理服务端口',
    `PROXY_PORT=${values.port}`,
    '',
    '# OpenClaw Gateway 地址',
    `OPENCLAW_GATEWAY_URL=${values.gatewayUrl}`,
    '',
    '# OpenClaw Gateway 认证 token',
    `OPENCLAW_GATEWAY_TOKEN=${values.gatewayToken}`,
    '',
    '# OpenClaw Gateway 认证密码（优先于 token）',
    `OPENCLAW_GATEWAY_PASSWORD=${values.gatewayPassword}`,
    '',
    '# 允许下载的目录白名单（逗号分隔，支持 ~/ 家目录）',
    `DOWNLOAD_ROOTS=${values.downloadRoots}`,
    '',
    '# 多用户账号（格式: 用户名:密码,用户名2:密码2）',
    '# 用户名不能包含 : ，密码不要包含逗号',
    `PROXY_USERS=${values.proxyUsers}`,
    '',
    '# 可选：将智能体输出中的虚拟路径映射到本机真实路径',
    '# 例如: DOWNLOAD_PATH_MAPS=/root/.openclaw/workspace=>~/workspace',
    `DOWNLOAD_PATH_MAPS=${values.downloadPathMaps}`,
    '',
    '# 日志级别: error / warn / info / debug / trace',
    `LOG_LEVEL=${values.logLevel}`,
    '',
    '# 允许的跨域来源（逗号分隔）；留空表示允许全部',
    `ALLOWED_ORIGINS=${values.allowedOrigins}`,
    '',
  ];
  return lines.join('\n');
}

function moveDirectoryEntries(sourceDir, targetDir, label) {
  if (!existsSync(sourceDir)) return;
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    if (existsSync(targetPath)) continue;
    try {
      renameSync(sourcePath, targetPath);
      console.log(`[INFO] 已迁移${label}: ${sourcePath} -> ${targetPath}`);
    } catch (error) {
      console.warn(`[WARN] 迁移${label}失败: ${sourcePath} (${error.message})`);
    }
  }

  try {
    if (readdirSync(sourceDir).length === 0) rmSync(sourceDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[WARN] 清理旧目录失败: ${sourceDir} (${error.message})`);
  }
}

function migrateLegacyHomeLayout() {
  if (process.env.CLAWCHAT_PROXY_CONFIG || process.env.CLAWCHAT_PROXY_DATA_DIR || process.env.CLAWCHAT_PROXY_HOME) {
    return;
  }

  if (
    LEGACY_CONFIG_PATH === CONFIG_DIR &&
    existsSync(LEGACY_CONFIG_PATH) &&
    statSync(LEGACY_CONFIG_PATH).isFile() &&
    !existsSync(CONFIG_PATH)
  ) {
    const tempPath = resolve(join(homedir(), `.clawchat-proxy.migrate-${Date.now()}`));
    try {
      renameSync(LEGACY_CONFIG_PATH, tempPath);
      mkdirSync(CONFIG_DIR, { recursive: true });
      renameSync(tempPath, CONFIG_PATH);
      console.log(`[INFO] 已迁移旧版配置文件: ${LEGACY_CONFIG_PATH} -> ${CONFIG_PATH}`);
    } catch (error) {
      console.warn(`[WARN] 迁移旧版配置文件失败: ${error.message}`);
      if (existsSync(tempPath) && !existsSync(LEGACY_CONFIG_PATH)) {
        try {
          renameSync(tempPath, LEGACY_CONFIG_PATH);
        } catch {
          // Ignore rollback failures and let the later config check surface the issue.
        }
      }
    }
  }

  if (
    LEGACY_CONFIG_PATH !== CONFIG_PATH &&
    existsSync(LEGACY_CONFIG_PATH) &&
    statSync(LEGACY_CONFIG_PATH).isFile() &&
    !existsSync(CONFIG_PATH)
  ) {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      renameSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
      console.log(`[INFO] 已迁移旧版配置文件: ${LEGACY_CONFIG_PATH} -> ${CONFIG_PATH}`);
    } catch (error) {
      console.warn(`[WARN] 迁移旧版配置文件失败: ${error.message}`);
    }
  }

  if (LEGACY_DATA_DIR !== DATA_DIR) {
    moveDirectoryEntries(LEGACY_DATA_DIR, DATA_DIR, '旧版运行数据');
  }
}

async function runSetupWizard() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const preset = loadOpenClawAuthPreset();
  const rl = createInterface({ input, output, terminal: true });

  try {
    console.log('');
    console.log('欢迎使用 ClawChat Proxy 初始化向导');
    console.log(`配置文件将写入: ${CONFIG_PATH}`);
    console.log(preset.source);
    console.log('');

    const port = normalizePort(await promptWithDefault(rl, 'PROXY_PORT', DEFAULT_PORT));
    const gatewayUrl = await promptWithDefault(rl, 'OPENCLAW_GATEWAY_URL', DEFAULT_GATEWAY_URL);

    let gatewayToken = '';
    let gatewayPassword = '';
    if (preset.key === 'OPENCLAW_GATEWAY_PASSWORD') {
      gatewayPassword = await promptWithDefault(rl, 'OPENCLAW_GATEWAY_PASSWORD', preset.value);
    } else {
      gatewayToken = await promptWithDefault(rl, 'OPENCLAW_GATEWAY_TOKEN', preset.value);
    }

    const downloadRoots = await promptWithDefault(rl, 'DOWNLOAD_ROOTS', '~/.openclaw/workspace/sessions');

    console.log('');
    console.log('PROXY_USERS 配置说明:');
    console.log('  格式: 用户名:密码,用户名2:密码2');
    console.log('  示例: alice:password1,bob:password2');
    const proxyUsers = await promptWithDefault(rl, 'PROXY_USERS', '');

    const downloadPathMaps = await promptWithDefault(rl, 'DOWNLOAD_PATH_MAPS', '');
    const logLevel = normalizeLogLevel(await promptWithDefault(rl, 'LOG_LEVEL', 'info'));
    const allowedOrigins = await promptWithDefault(rl, 'ALLOWED_ORIGINS（留空表示允许全部）', '');

    writeFileSync(CONFIG_PATH, buildConfigContent({
      port,
      gatewayUrl,
      gatewayToken,
      gatewayPassword,
      downloadRoots,
      proxyUsers,
      downloadPathMaps,
      logLevel,
      allowedOrigins,
    }), 'utf8');

    console.log('');
    console.log(`配置已写入: ${CONFIG_PATH}`);
    console.log('后续可直接运行 `npx @claw_chat/clawchat-proxy` 启动。');
    console.log('');
  } finally {
    rl.close();
  }
}

async function ensureConfigFile() {
  const forceSetup = argv.includes('--setup') || argv.includes('--init');
  if (existsSync(CONFIG_PATH) && !forceSetup) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`配置文件不存在：${CONFIG_PATH}`);
    console.error('请在交互终端中先运行一次 `npx @claw_chat/clawchat-proxy --setup` 完成初始化。');
    exit(1);
  }

  await runSetupWizard();
}

function migrateLegacyRuntimeData() {
  mkdirSync(DATA_DIR, { recursive: true });
  const entries = [
    ['.device-key.json', '.device-key.json'],
    ['clawchat.db', 'clawchat.db'],
    ['clawchat.db-shm', 'clawchat.db-shm'],
    ['clawchat.db-wal', 'clawchat.db-wal'],
    ['.session-titles.json', '.session-titles.json'],
    ['uploads', 'uploads'],
  ];

  for (const [legacyName, targetName] of entries) {
    const legacyPath = join(PACKAGE_DIR, legacyName);
    const targetPath = join(DATA_DIR, targetName);
    if (!existsSync(legacyPath) || existsSync(targetPath)) continue;
    try {
      renameSync(legacyPath, targetPath);
      console.log(`[INFO] 已迁移运行时数据: ${legacyName} -> ${targetPath}`);
    } catch (error) {
      console.warn(`[WARN] 迁移运行时数据失败: ${legacyName} (${error.message})`);
    }
  }
}

migrateLegacyHomeLayout();
await ensureConfigFile();
config({ path: CONFIG_PATH, override: true });
migrateLegacyRuntimeData();

// ==================== 配置 ====================
const CONFIG = {
  port: parseInt(process.env.PROXY_PORT, 10) || 18888,
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL,
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  gatewayPassword: process.env.OPENCLAW_GATEWAY_PASSWORD || '',
  downloadRoots: (process.env.DOWNLOAD_ROOTS || DEFAULT_DOWNLOAD_ROOT)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolveConfigPath(p)),
  downloadPathMaps: parseDownloadPathMaps(process.env.DOWNLOAD_PATH_MAPS),
  distPath: join(PACKAGE_DIR, '..', 'dist'),
};
const CLAWCHAT_FILES_RPC_PREFIX = 'clawchatfiles';

// ==================== 多用户配置 ====================
// 格式: PROXY_USERS=alice:password1,bob:password2
const USERS = new Map();
(process.env.PROXY_USERS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
  const idx = entry.indexOf(':');
  if (idx > 0) {
    const userId = entry.substring(0, idx).trim();
    const userToken = entry.substring(idx + 1).trim();
    if (userId && userToken) USERS.set(userId, userToken);
  }
});
// ==================== Ed25519 设备密钥（全局共享） ====================
const DEVICE_KEY_PATH = join(DATA_DIR, '.device-key.json');
const deviceKey = (() => {
  if (existsSync(DEVICE_KEY_PATH)) {
    return JSON.parse(readFileSync(DEVICE_KEY_PATH, 'utf8'));
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const dk = {
    deviceId: createHash('sha256').update(pubRaw).digest('hex'),
    publicKey: pubRaw.toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  writeFileSync(DEVICE_KEY_PATH, JSON.stringify(dk, null, 2));
  return dk;
})();
const devicePrivateKey = createPrivateKey(deviceKey.privateKeyPem);

// ==================== SQLite 持久化 ====================
const DB_PATH = join(DATA_DIR, 'clawchat.db');
const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL'); // 高并发性能

// 建表
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS session_titles (
    session_key TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    updated_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  )
`);

// 如果旧的 JSON 文件存在，自动迁移数据
const OLD_TITLES_PATH = join(DATA_DIR, '.session-titles.json');
if (existsSync(OLD_TITLES_PATH)) {
  try {
    const oldData = JSON.parse(readFileSync(OLD_TITLES_PATH, 'utf8'));
    const insert = sqlite.prepare('INSERT OR IGNORE INTO session_titles (session_key, title) VALUES (?, ?)');
    const migrate = sqlite.transaction((entries) => {
      for (const [key, title] of entries) insert.run(key, title);
    });
    migrate(Object.entries(oldData));
    // 迁移完成后删除旧文件
    unlinkSync(OLD_TITLES_PATH);
    log.info(`已将 ${Object.keys(oldData).length} 条标题从 JSON 迁移到 SQLite`);
  } catch (e) {
    log.warn('迁移旧标题文件失败:', e.message);
  }
}

// ====== 附件存储 ======
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,
    session_key  TEXT NOT NULL,
    message_text TEXT,
    file_name    TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    file_size    INTEGER,
    file_path    TEXT NOT NULL,
    created_at   INTEGER DEFAULT (strftime('%s','now') * 1000)
  )
`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_att_session ON attachments(session_key)`);

// ====== 助手消息元数据（工具调用、思维链、blocks 交错顺序）======
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS assistant_meta (
    session_key TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    tool_calls  TEXT,
    thinking    TEXT,
    blocks      TEXT,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (session_key, message_id)
  )
`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_meta_session ON assistant_meta(session_key)`);

/** MIME → 文件扩展名 */
function mimeToExt(mime) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'application/pdf': 'pdf', 'text/plain': 'txt',
    'application/zip': 'zip', 'application/json': 'json',
  };
  return map[mime] || (mime?.split('/')?.[1]?.replace(/[^a-z0-9]/gi, '') || 'bin');
}

const MAX_EXTRACTED_DOC_CHARS_PER_FILE = 16000;
const MAX_EXTRACTED_DOC_CHARS_TOTAL = 48000;
const DOC_CONTEXT_START = '[CLAWCHAT_DOC_CONTEXT_BEGIN]';
const DOC_CONTEXT_END = '[CLAWCHAT_DOC_CONTEXT_END]';
let pdfParseLoader = null;
let mammothLoader = null;

function getAttachmentMime(att) {
  return String(att?.mimeType || att?.type || 'application/octet-stream').trim().toLowerCase();
}

function getAttachmentName(att) {
  return String(att?.fileName || att?.name || 'attachment').trim() || 'attachment';
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTextExtractableAttachment(mime, fileName) {
  const lowerName = String(fileName || '').toLowerCase();
  return (
    mime === 'application/pdf' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword' ||
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === 'application/json' ||
    mime === 'text/csv' ||
    /\.pdf$/i.test(lowerName) ||
    /\.docx$/i.test(lowerName) ||
    /\.doc$/i.test(lowerName) ||
    /\.(txt|md|json|csv)$/i.test(lowerName) ||
    mime.startsWith('text/')
  );
}

async function loadPdfParse() {
  if (!pdfParseLoader) {
    pdfParseLoader = import('pdf-parse').then((mod) => mod.default || mod);
  }
  return pdfParseLoader;
}

async function loadMammoth() {
  if (!mammothLoader) {
    mammothLoader = import('mammoth');
  }
  return mammothLoader;
}

async function extractAttachmentText(att) {
  if (!att?.content) return { supported: false, text: '' };

  const mime = getAttachmentMime(att);
  const fileName = getAttachmentName(att);
  if (!isTextExtractableAttachment(mime, fileName)) {
    return { supported: false, text: '' };
  }

  const buffer = Buffer.from(String(att.content || ''), 'base64');
  if (!buffer.length) return { supported: false, text: '' };

  try {
    if (mime === 'application/pdf' || /\.pdf$/i.test(fileName)) {
      const pdfParse = await loadPdfParse();
      const parsed = await pdfParse(buffer);
      return { supported: true, text: normalizeExtractedText(parsed?.text) };
    }

    if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(fileName)
    ) {
      const mammoth = await loadMammoth();
      const parsed = await mammoth.extractRawText({ buffer });
      return { supported: true, text: normalizeExtractedText(parsed?.value) };
    }

    if (mime === 'application/msword' || /\.doc$/i.test(fileName)) {
      return { supported: false, text: '' };
    }

    return { supported: true, text: normalizeExtractedText(buffer.toString('utf8')) };
  } catch (error) {
    log.warn(`提取附件文本失败: ${fileName} (${error.message})`);
    return { supported: true, text: '' };
  }
}

async function buildDocumentContext(attachments) {
  const sections = [];
  const unsupported = [];
  let totalChars = 0;

  for (const att of attachments || []) {
    const mime = getAttachmentMime(att);
    if (mime.startsWith('image/')) continue;

    const fileName = getAttachmentName(att);
    const extracted = await extractAttachmentText(att);
    if (!extracted.supported) {
      unsupported.push(fileName);
      continue;
    }

    if (!extracted.text) continue;

    const remaining = MAX_EXTRACTED_DOC_CHARS_TOTAL - totalChars;
    if (remaining <= 0) break;

    const snippet = extracted.text.slice(0, Math.min(MAX_EXTRACTED_DOC_CHARS_PER_FILE, remaining));
    totalChars += snippet.length;
    sections.push(`[文档] ${fileName}\n${snippet}`);
  }

  if (sections.length === 0 && unsupported.length === 0) return '';

  const parts = [
    DOC_CONTEXT_START,
    '以下是用户本轮上传文档中提取的正文内容，请结合这些内容回答。',
  ];
  if (sections.length > 0) parts.push(sections.join('\n\n'));
  if (unsupported.length > 0) {
    parts.push(`以下附件已上传，但当前代理暂不支持直接提取正文：${unsupported.join('，')}`);
  }
  parts.push(DOC_CONTEXT_END);
  return parts.join('\n\n').trim();
}

// 预编译常用 SQL
const stmts = {
  // 标题
  upsertTitle: sqlite.prepare(`
    INSERT INTO session_titles (session_key, title, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
  `),
  getTitle: sqlite.prepare('SELECT title FROM session_titles WHERE session_key = ?'),
  getTitlesByUser: sqlite.prepare(`SELECT session_key, title FROM session_titles WHERE session_key LIKE ?`),
  deleteTitle: sqlite.prepare('DELETE FROM session_titles WHERE session_key = ?'),
  // 附件
  insertAtt: sqlite.prepare(`INSERT OR IGNORE INTO attachments (id, session_key, message_text, file_name, mime_type, file_size, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getAttBySession: sqlite.prepare(`SELECT id, file_name, mime_type, file_size, message_text, created_at FROM attachments WHERE session_key = ? ORDER BY created_at`),
  getAttById: sqlite.prepare(`SELECT file_name, mime_type, file_path FROM attachments WHERE id = ?`),
  getAttPathsBySession: sqlite.prepare(`SELECT file_path FROM attachments WHERE session_key = ?`),
  deleteAttBySession: sqlite.prepare(`DELETE FROM attachments WHERE session_key = ?`),
  // 助手元数据
  upsertMeta: sqlite.prepare(`
    INSERT INTO assistant_meta (session_key, message_id, tool_calls, thinking, blocks, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key, message_id) DO UPDATE SET
      tool_calls = COALESCE(excluded.tool_calls, assistant_meta.tool_calls),
      thinking = COALESCE(excluded.thinking, assistant_meta.thinking),
      blocks = COALESCE(excluded.blocks, assistant_meta.blocks),
      created_at = excluded.created_at
  `),
  getMetaBySession: sqlite.prepare(`SELECT message_id, tool_calls, thinking, blocks FROM assistant_meta WHERE session_key = ? ORDER BY created_at`),
  deleteMetaBySession: sqlite.prepare(`DELETE FROM assistant_meta WHERE session_key = ?`),
};

/** 持久化 deviceToken */
function saveDeviceToken(token) {
  if (!token) return;
  try {
    const data = JSON.parse(readFileSync(DEVICE_KEY_PATH, 'utf8'));
    if (data.deviceToken === token) return;
    data.deviceToken = token;
    writeFileSync(DEVICE_KEY_PATH, JSON.stringify(data, null, 2));
    deviceKey.deviceToken = token;
    log.info(`deviceToken 已持久化到 ${DEVICE_KEY_PATH}`);
  } catch (e) {
    log.error('保存 deviceToken 失败:', e.message);
  }
}

// ==================== 日志 ====================
// ==================== 可配置日志 ====================
// LOG_LEVEL: error < warn < info < debug < trace
// trace 级别会打印与 Gateway 交互的完整 JSON 消息帧
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;

const log = {
  error: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.error && console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...args),
  warn:  (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.warn  && console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, ...args),
  info:  (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.info  && console.log(`[INFO] ${new Date().toISOString()} ${msg}`, ...args),
  debug: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...args),
  trace: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.trace && console.log(`[TRACE] ${new Date().toISOString()} ${msg}`, ...args),
};
log.info(`日志级别: ${Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === CURRENT_LOG_LEVEL) || 'info'} (设置 LOG_LEVEL 环境变量可调整: error/warn/info/debug/trace)`);

// ==================== 常量 ====================
const SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write'];
const SSE_HEARTBEAT_INTERVAL = 15000;
const SESSION_CLEANUP_INTERVAL = 60000;
const SESSION_IDLE_TIMEOUT = 300000;
const UPSTREAM_LINGER = 120000;
const EVENT_BUFFER_MAX = 200;
const REQUEST_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 15000;
const GW_RECONNECT_BASE = 3000;
const GW_RECONNECT_MAX = 30000;
const PAIRING_RETRY_INTERVAL = 15000;

// ==================== 共享 Gateway 连接 ====================
const gw = {
  ws: null,
  state: 'disconnected',       // disconnected | connecting | connected | pairing_pending
  hello: null,
  snapshot: null,
  defaultSessionKey: null,
  pendingRequests: new Map(),   // reqId → { sid, resolve, reject, timer }
  pairingRequestId: null,       // Gateway 返回的配对请求 ID（用于控制台定位）
  _heartbeat: null,
  _connectTimer: null,
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  _connectPromise: null,
  _connectResolve: null,
  _connectReject: null,
  _pairingRetryTimer: null,
};

// ==================== 用户会话 ====================
const sessions = new Map();     // sid → session

// ==================== Gateway 握手帧 ====================

function createConnectFrame(nonce) {
  const signedAt = Date.now();
  const credential = CONFIG.gatewayPassword || CONFIG.gatewayToken || deviceKey.deviceToken || '';
  const payload = [
    'v2', deviceKey.deviceId, 'gateway-client', 'backend', 'operator',
    SCOPES.join(','), String(signedAt), credential, nonce || '',
  ].join('|');
  const signature = ed25519Sign(null, Buffer.from(payload, 'utf8'), devicePrivateKey).toString('base64');

  let auth;
  if (CONFIG.gatewayPassword) auth = { password: CONFIG.gatewayPassword };
  else if (CONFIG.gatewayToken) auth = { token: CONFIG.gatewayToken };
  else if (deviceKey.deviceToken) auth = { deviceToken: deviceKey.deviceToken };

  return {
    type: 'req',
    id: `connect-${randomUUID()}`,
    method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'gateway-client', version: '1.0.0', platform: 'web', mode: 'backend' },
      role: 'operator',
      scopes: SCOPES,
      caps: ['tool-events'],
      commands: [],
      permissions: {},
      auth,
      device: {
        id: deviceKey.deviceId,
        publicKey: deviceKey.publicKey,
        signedAt, nonce, signature,
      },
      locale: 'zh-CN',
      userAgent: 'ClawChat-Proxy/2.0.0',
    },
  };
}

// ==================== SSE 工具 ====================

function sseWrite(session, event, data) {
  session.eventSeq++;
  const entry = { id: session.eventSeq, event, data };
  session.eventBuffer.push(entry);
  if (session.eventBuffer.length > EVENT_BUFFER_MAX) session.eventBuffer.shift();
  if (session.sseRes && !session.sseRes.writableEnded) {
    session.sseRes.write(`id: ${entry.id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof session.sseRes.flush === 'function') session.sseRes.flush();
  }
}

function broadcastSSE(event, data) {
  for (const [, session] of sessions) {
    sseWrite(session, event, data);
  }
}

// ==================== 认证 ====================

function validateToken(token, username) {
  const normalizedUser = String(username || '').trim();
  const normalizedToken = String(token || '').trim();
  if (!normalizedUser || !normalizedToken) return { valid: false, userId: null };
  const expectedToken = USERS.get(normalizedUser);
  if (!expectedToken) return { valid: false, userId: null };
  return expectedToken === normalizedToken
    ? { valid: true, userId: normalizedUser }
    : { valid: false, userId: null };
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return String(req.headers['x-proxy-token'] || '').trim();
}

function authenticateByToken(req) {
  const token = extractBearerToken(req);
  const username = String(req.headers['x-proxy-user'] || '').trim();
  if (!token || !username) return { valid: false, userId: null };
  return validateToken(token, username);
}

function isPathWithinRoot(targetPath, rootPath) {
  const normalizedTarget = normalize(resolve(targetPath));
  const normalizedRoot = normalize(resolve(rootPath));
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + '\\') || normalizedTarget.startsWith(normalizedRoot + '/');
}

function translateDownloadPath(rawPath) {
  const normalizedInput = rawPath.trim().replace(/^["']|["']$/g, '');
  for (const mapping of CONFIG.downloadPathMaps) {
    if (normalizedInput === mapping.from || normalizedInput.startsWith(mapping.from + '/') || normalizedInput.startsWith(mapping.from + '\\')) {
      const suffix = normalizedInput.slice(mapping.from.length).replace(/^[\\/]+/, '');
      return resolve(mapping.to, suffix);
    }
  }
  return null;
}

function resolveDownloadableFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const normalizedInput = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!normalizedInput) return null;

  const translatedPath = translateDownloadPath(normalizedInput);
  const candidates = normalizedInput.match(/^[A-Za-z]:[\\/]/) || normalizedInput.startsWith('/')
    ? [translatedPath, resolve(normalizedInput)].filter(Boolean)
    : [
        translatedPath,
        resolve(process.cwd(), normalizedInput),
        ...CONFIG.downloadRoots.map((root) => resolve(root, normalizedInput)),
      ].filter(Boolean);

  for (const resolvedPath of candidates) {
    const allowedRoot = CONFIG.downloadRoots.find((root) => isPathWithinRoot(resolvedPath, root));
    if (!allowedRoot || !existsSync(resolvedPath)) continue;

    try {
      const stat = statSync(resolvedPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    return {
      absolutePath: resolvedPath,
      allowedRoot,
      fileName: basename(resolvedPath),
      ext: extname(resolvedPath).toLowerCase(),
    };
  }
  return null;
}

function resolvePluginFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const translated = translateDownloadPath(rawPath);
  const candidates = [translated, resolve(rawPath)].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const stat = statSync(candidate);
      return {
        absolutePath: candidate,
        fileName: basename(candidate),
        stat,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// 插件 resolve 会返回 absolutePath，但“目标文件可能尚不存在”（上传场景）。
// 此函数只做路径映射，不要求路径已存在。
function mapPluginAbsolutePathToLocal(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const translated = translateDownloadPath(rawPath);
  const candidates = [translated, resolve(rawPath)].filter(Boolean);
  return candidates.length > 0 ? { absolutePath: candidates[0] } : null;
}

function buildArchiveName(name) {
  const base = String(name || 'archive')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'archive';
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

async function handleSessionFileDownload({ sid, sessionKey, rawPath, archive }, res) {
  const session = sessions.get(String(sid || ''));
  if (!session) {
    res.status(404).json({ ok: false, error: '会话不存在' });
    return;
  }
  if (!sessionKey) {
    res.status(400).json({ ok: false, error: '缺少 sessionKey' });
    return;
  }

  try {
    const result = await callClawChatFilesRPC(String(sid || ''), 'resolve', {
      sessionKey: String(sessionKey),
      path: String(rawPath || ''),
    });

    if (!result?.exists) {
      res.status(404).json({ ok: false, error: '文件不存在' });
      return;
    }

    const localTarget = resolvePluginFilePath(result.absolutePath);
    if (!localTarget) {
      res.status(500).json({
        ok: false,
        error: '插件返回的文件路径在代理侧不可访问，请检查 OpenClaw 与代理的目录映射配置',
      });
      return;
    }

    if (archive) {
      if (!localTarget.stat.isDirectory()) {
        res.status(400).json({ ok: false, error: '只能打包下载目录' });
        return;
      }

      const archiveName = buildArchiveName(result.name || localTarget.fileName || 'archive');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`);
      res.setHeader('Cache-Control', 'no-store');

      const zip = archiver('zip', { zlib: { level: 9 } });
      zip.on('error', (err) => {
        log.warn('目录打包下载失败:', err?.message || err);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: '目录打包失败' });
          return;
        }
        res.destroy(err);
      });
      zip.pipe(res);
      zip.directory(localTarget.absolutePath, result.name || localTarget.fileName);
      await zip.finalize();
      return;
    }

    if (!localTarget.stat.isFile()) {
      res.status(400).json({ ok: false, error: '只能下载文件' });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.name || localTarget.fileName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(localTarget.absolutePath);
  } catch (e) {
    const message = (e && e.message) || '';
    if (/does not match plugin filter/i.test(message)) {
      res.status(400).json({ ok: false, error: '当前会话未启用 ClawChat 文件插件' });
      return;
    }
    if (/escapes session directory/i.test(message)) {
      res.status(400).json({ ok: false, error: '路径无效' });
      return;
    }
    res.status(500).json({ ok: false, error: message || '下载失败' });
  }
}

async function callClawChatFilesRPC(sid, action, params) {
  return sendGatewayRPC(sid, `${CLAWCHAT_FILES_RPC_PREFIX}.${action}`, params);
}

// ==================== 会话管理 ====================

function cleanupSession(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  log.info(`清理会话 [${sid}] userId=${session.userId || 'default'}`);
  if (session._sseHeartbeat) clearInterval(session._sseHeartbeat);
  if (session._lingerTimer) clearTimeout(session._lingerTimer);
  if (session.sseRes && !session.sseRes.writableEnded) session.sseRes.end();
  sessions.delete(sid);
}

/** 为用户生成隔离的 sessionKey（使用 clawchat- 前缀，便于过滤非本应用的会话） */
function getUserSessionKey(userId) {
  const base = gw.defaultSessionKey || 'agent:main:main';
  const parts = base.split(':');
  const prefix = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : 'agent:main';
  const userTag = userId || 'default';
  return `${prefix}:clawchat-${userTag}`;
}

/**
 * App「新建会话」会在默认 key 后追加 `-{suffix}`，此时尚未经过 /api/send，
 * session.sessionKeys 里只有连接时的默认 key。上传前需按用户归属放行并登记 key。
 */
function isOwnedClawchatSessionKey(sk, session) {
  if (!sk || !session) return false;
  const userTag = String(session.userId || session.username || 'default');
  const base = gw.defaultSessionKey || 'agent:main:main';
  const parts = String(base).split(':');
  const prefix = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : 'agent:main';
  const defaultKey = `${prefix}:clawchat-${userTag}`;
  if (sk === defaultKey) return true;
  if (sk.startsWith(`${defaultKey}-`)) return true;
  return false;
}

/**
 * 是否允许向 clawchatfiles 写入该 sessionKey 对应目录。
 * 优先信任本连接已登记的 sessionKeys（含连接时下发的默认 key），并允许 `已登记key-后缀`（新建对话）。
 * 这样客户端用的前缀与 Gateway 重连后 gw.defaultSessionKey 变化时仍一致，避免误报「无权限写入该会话目录」。
 */
function canProxyWriteSessionFiles(sk, session) {
  if (!sk || !session) return false;
  const key = String(sk);
  if (session.sessionKeys?.has(key)) return true;
  if (session.sessionKeys && session.sessionKeys.size > 0) {
    for (const registered of session.sessionKeys) {
      const r = String(registered || '');
      if (!r) continue;
      if (key === r) return true;
      if (key.startsWith(`${r}-`)) return true;
    }
  }
  return isOwnedClawchatSessionKey(key, session);
}

// ==================== 共享 Gateway 消息处理 ====================

function handleGatewayMessage(rawData) {
  const str = typeof rawData === 'string' ? rawData : rawData.toString();
  let msg;
  try { msg = JSON.parse(str); } catch { return; }

  log.debug(`GW ← type=${msg.type} event=${msg.event} id=${msg.id} state=${gw.state}`);
  log.trace(`GW ← 完整帧:\n${JSON.stringify(msg, null, 2)}`);

  // ── 1. connect.challenge ──────────────────────────────────
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    log.info(`收到 connect.challenge, nonce: ${msg.payload?.nonce}`);
    if (gw._connectTimer) { clearTimeout(gw._connectTimer); gw._connectTimer = null; }
    const nonce = msg.payload?.nonce || '';
    if (gw.ws?.readyState === WebSocket.OPEN) {
      const frame = createConnectFrame(nonce);
      log.trace(`GW → 完整帧 (connect-challenge):\n${JSON.stringify(frame, null, 2)}`);
      gw.ws.send(JSON.stringify(frame));
    }
    return;
  }

  // ── 2. 配对事件推送（pairing_pending 阶段）────────────────
  if (msg.type === 'event' && gw.state === 'pairing_pending') {
    switch (msg.event) {
      case 'node.pair.approved': {
        log.info('✅ 设备配对已批准');
        gw.state = 'connected';
        const dt = msg.payload?.deviceToken || msg.payload?.token;
        if (dt) saveDeviceToken(dt);
        gw.hello = msg.payload;
        broadcastSSE('proxy.paired', {
          message: '设备配对成功',
          snapshot: msg.payload?.snapshot || null,
        });
        gw._connectResolve?.('connected');
        gw._connectResolve = null;
        gw._connectReject = null;
        return;
      }
      case 'node.pair.rejected':
        log.error('❌ 设备配对被拒绝');
        broadcastSSE('proxy.error', { message: '设备配对被拒绝' });
        gw._connectReject?.(new Error('设备配对被拒绝'));
        gw._connectResolve = null;
        gw._connectReject = null;
        return;
      case 'node.pair.expired':
        log.error('⌛ 配对请求已过期（5分钟超时）');
        broadcastSSE('proxy.error', { message: '配对请求已过期（5分钟超时），请重新连接' });
        gw._connectReject?.(new Error('配对请求已过期'));
        gw._connectResolve = null;
        gw._connectReject = null;
        return;
      default:
        log.debug(`配对阶段忽略事件: ${msg.event}`);
        return;
    }
  }

  // ── 3. connect 响应 ───────────────────────────────────────
  if (msg.type === 'res' && msg.id?.startsWith('connect-')) {
    if (!msg.ok || msg.error) {
      const errMsg = msg.error?.message || msg.error?.code || '';
      const errCode = msg.error?.code || '';
      const detailCode = msg.error?.details?.code || '';

      // ====== NOT_PAIRED / PAIRING_REQUIRED → 进入配对等待 ======
      if (errCode === 'NOT_PAIRED' || detailCode === 'PAIRING_REQUIRED' || /pairing.required/i.test(errMsg)) {
        const requestId = msg.error?.details?.requestId || '';
        log.info(`⏳ 设备需要配对, deviceId: ${deviceKey.deviceId}, requestId: ${requestId}`);
        gw.state = 'pairing_pending';
        gw.pairingRequestId = requestId || null;
        broadcastSSE('proxy.pairing_pending', {
          message: '请前往 OpenClaw Web 控制台的 Nodes → Devices 页面批准此设备',
          deviceId: deviceKey.deviceId,
          requestId,
        });
        // 解决 connect promise 为 pairing_pending（非错误）
        gw._connectResolve?.('pairing_pending');
        gw._connectResolve = null;
        gw._connectReject = null;
        // Gateway 会关闭连接 → 启动定时重试
        schedulePairingRetry();
        return;
      }

      if (gw.state === 'pairing_pending') {
        log.warn(`配对期间收到错误: ${errMsg}`);
        return;
      }
      log.error('Gateway 握手失败:', msg.error || '未知错误');
      gw._connectReject?.(new Error(errMsg || 'Gateway 握手失败'));
      gw._connectResolve = null;
      gw._connectReject = null;
    } else {
      const resultType = msg.payload?.type;

      // pair-pending
      if (resultType === 'pair-pending' || msg.payload?.status === 'pending') {
        const rid = msg.payload?.requestId || msg.payload?.pairRequestId || '';
        log.info(`⏳ 设备需要配对, deviceId: ${deviceKey.deviceId}, requestId: ${rid}`);
        gw.state = 'pairing_pending';
        gw.pairingRequestId = rid || null;
        broadcastSSE('proxy.pairing_pending', {
          message: '请前往 OpenClaw Web 控制台的 Nodes → Devices 页面批准此设备',
          deviceId: deviceKey.deviceId,
          requestId: rid,
        });
        gw._connectResolve?.('pairing_pending');
        gw._connectResolve = null;
        gw._connectReject = null;
        return;
      }

      // hello-ok
      log.info(`Gateway 握手成功, type=${resultType}`);
      gw.state = 'connected';
      gw.pairingRequestId = null;
      gw.hello = msg.payload;
      gw.snapshot = msg.payload?.snapshot || null;
      const defaults = gw.snapshot?.sessionDefaults;
      gw.defaultSessionKey = defaults?.mainSessionKey || `agent:${defaults?.defaultAgentId || 'main'}:main`;
      if (msg.payload?.auth?.deviceToken) saveDeviceToken(msg.payload.auth.deviceToken);
      gw._connectResolve?.('connected');
      gw._connectResolve = null;
      gw._connectReject = null;
    }
    return;
  }

  // ── 4. RPC 响应 → 匹配到发起请求的会话 ────────────────────
  if (msg.type === 'res') {
    const pending = gw.pendingRequests.get(msg.id);
    if (pending) {
      gw.pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);
      log.debug(`RPC 响应: id=${msg.id} ok=${msg.ok}`);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new Error(msg.error?.message || msg.error?.code || '请求失败'));
    }
    return;
  }

  // ── 5. 事件 → 按 sessionKey 路由到对应用户 ────────────────
  if (msg.type === 'event') {
    const eventName = msg.event || '(unknown)';
    const stream = msg.payload?.stream;
    const phase = msg.payload?.data?.phase;
    log.debug(`Gateway 事件: event=${eventName}${stream ? ` stream=${stream}` : ''}${phase ? ` phase=${phase}` : ''}`);
    // 工具事件详细日志 — 帮助诊断 input/output 字段
    if (stream === 'tool') {
      log.info(`🔧 Tool event: phase=${phase}, data keys=${JSON.stringify(Object.keys(msg.payload?.data || {}))}, data=${JSON.stringify(msg.payload?.data).substring(0, 500)}`);
    }
    // chat 事件 delta 中的 tool_use 块日志
    if (eventName === 'chat' && msg.payload?.state === 'delta') {
      const content = msg.payload?.message?.content;
      if (Array.isArray(content)) {
        const toolUseBlocks = content.filter(b => b.type === 'tool_use' || b.type === 'tool_result');
        if (toolUseBlocks.length > 0) {
          log.info(`🔧 Chat delta tool blocks: ${JSON.stringify(toolUseBlocks).substring(0, 800)}`);
        }
      }
    }

    const eventSessionKey = msg.payload?.sessionKey;
    if (eventSessionKey) {
      for (const [, session] of sessions) {
        if (session.sessionKeys.has(eventSessionKey)) {
          sseWrite(session, 'message', msg);
        }
      }
    } else {
      // 无 sessionKey 的系统事件，广播给所有用户
      for (const [, session] of sessions) {
        sseWrite(session, 'message', msg);
      }
    }
  }
}

// ==================== Gateway 连接管理 ====================

/** 建立共享 Gateway WebSocket 连接 */
function connectGateway() {
  if (gw._connectPromise) return gw._connectPromise;
  if (gw.state === 'connected') return Promise.resolve('connected');
  if (gw.state === 'pairing_pending') return Promise.resolve('pairing_pending');

  gw._connectPromise = new Promise((resolve, reject) => {
    gw._connectResolve = (result) => {
      clearTimeout(timeout);
      gw._connectPromise = null;
      gw._reconnectAttempts = 0;
      resolve(result);
    };
    gw._connectReject = (err) => {
      clearTimeout(timeout);
      gw._connectPromise = null;
      reject(err);
    };

    log.info(`连接到 Gateway: ${CONFIG.gatewayUrl}`);
    const ws = new WebSocket(CONFIG.gatewayUrl, {
      headers: { 'Origin': CONFIG.gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://') },
    });
    gw.ws = ws;
    gw.state = 'connecting';

    // 整体超时
    const timeout = setTimeout(() => {
      if (gw.state === 'connecting') {
        log.error('Gateway 连接超时');
        gw._connectResolve = null;
        gw._connectReject = null;
        gw._connectPromise = null;
        gw.state = 'disconnected';
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('连接超时'));
      }
    }, CONNECT_TIMEOUT);

    ws.on('open', () => {
      log.info('Gateway WebSocket 已建立');
      // 等 500ms 看是否有 challenge
      gw._connectTimer = setTimeout(() => {
        if (gw.state === 'connecting') {
          log.info('未收到 challenge，直接发送 connect');
          const frame = createConnectFrame('');
          log.trace(`GW → 完整帧 (direct-connect):\n${JSON.stringify(frame, null, 2)}`);
          ws.send(JSON.stringify(frame));
        }
      }, 500);
    });

    ws.on('message', (data) => handleGatewayMessage(data.toString()));

    ws.on('close', (code) => {
      log.warn(`Gateway 连接关闭: code=${code}, state=${gw.state}`);
      const wasConnected = gw.state === 'connected';
      const wasPairing = gw.state === 'pairing_pending';

      // 清理 WebSocket 相关资源
      gw.ws = null;
      if (gw._heartbeat) { clearInterval(gw._heartbeat); gw._heartbeat = null; }
      if (gw._connectTimer) { clearTimeout(gw._connectTimer); gw._connectTimer = null; }

      // 拒绝所有 pending RPC
      for (const [id, pending] of gw.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Gateway 连接已断开'));
      }
      gw.pendingRequests.clear();

      if (wasPairing) {
        // ====== 配对等待中 Gateway 主动关闭 → 保持 pairing_pending 状态 ======
        // 不设为 disconnected，定时重试会负责重连
        log.info('Gateway 连接关闭（配对等待中），定时重试将自动检查配对状态');
        gw._connectPromise = null;
        gw._connectResolve = null;
        gw._connectReject = null;
        // 不广播错误，配对重试 timer 已在运行
        return;
      }

      gw.state = 'disconnected';

      if (wasConnected) {
        broadcastSSE('proxy.disconnect', { message: 'Gateway 连接已断开', code });
        scheduleGatewayReconnect();
      } else {
        gw._connectReject?.(new Error(`Gateway 连接关闭: ${code}`));
      }
      gw._connectResolve = null;
      gw._connectReject = null;
      gw._connectPromise = null;
    });

    ws.on('error', (error) => {
      log.error('Gateway 连接错误:', error.message);
    });

    // 心跳
    gw._heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);
  });

  return gw._connectPromise;
}

/** 配对重试：定时重连 Gateway 检查配对是否已批准 */
function schedulePairingRetry() {
  if (gw._pairingRetryTimer) return;
  log.info(`🔄 配对重试已启动，每 ${PAIRING_RETRY_INTERVAL / 1000} 秒检查一次`);

  gw._pairingRetryTimer = setInterval(async () => {
    // 如果不再是 pairing_pending 状态，停止重试
    if (gw.state !== 'pairing_pending') {
      clearInterval(gw._pairingRetryTimer);
      gw._pairingRetryTimer = null;
      log.info('配对重试已停止（状态已变更）');
      return;
    }
    // 如果没有活跃会话了，停止重试
    if (sessions.size === 0) {
      clearInterval(gw._pairingRetryTimer);
      gw._pairingRetryTimer = null;
      gw.state = 'disconnected';
      log.info('配对重试已停止（无活跃会话）');
      return;
    }

    log.info('尝试重连 Gateway（检查配对状态）...');
    try {
      // 临时设为 disconnected 以允许 connectGateway 执行
      gw.state = 'disconnected';
      const result = await connectGateway();

      if (result === 'connected') {
        clearInterval(gw._pairingRetryTimer);
        gw._pairingRetryTimer = null;
        log.info('✅ 设备配对已通过，Gateway 连接成功');

        // 通知所有 APP 客户端：配对成功
        for (const [sid, session] of sessions) {
          const sessionKey = getUserSessionKey(session.userId);
          session.sessionKeys.add(sessionKey);
          sseWrite(session, 'proxy.paired', {
            message: '设备配对成功',
            hello: gw.hello,
            snapshot: gw.snapshot,
            sessionKey,
            userId: session.userId || null,
          });
        }
      }
      // 如果仍是 pairing_pending，定时器继续运行
    } catch (e) {
      log.debug(`配对重试连接失败: ${e.message}`);
      // 确保状态保持 pairing_pending
      if (gw.state === 'disconnected') gw.state = 'pairing_pending';
    }
  }, PAIRING_RETRY_INTERVAL);
}

function stopPairingRetry() {
  if (gw._pairingRetryTimer) {
    clearInterval(gw._pairingRetryTimer);
    gw._pairingRetryTimer = null;
  }
}

/** 自动重连（仅在有活跃会话时） */
function scheduleGatewayReconnect() {
  if (gw._reconnectTimer) return;
  if (sessions.size === 0) {
    log.info('无活跃会话，跳过 Gateway 重连');
    return;
  }
  const delay = Math.min(GW_RECONNECT_BASE * Math.pow(2, gw._reconnectAttempts), GW_RECONNECT_MAX);
  gw._reconnectAttempts++;
  log.info(`Gateway 将在 ${delay}ms 后重连（第 ${gw._reconnectAttempts} 次）`);

  gw._reconnectTimer = setTimeout(async () => {
    gw._reconnectTimer = null;
    try {
      const result = await connectGateway();
      if (result === 'connected') {
        log.info('Gateway 重连成功');
        broadcastSSE('proxy.reconnected', { message: 'Gateway 已重新连接' });
      }
    } catch (e) {
      log.error('Gateway 重连失败:', e.message);
      scheduleGatewayReconnect();
    }
  }, delay);
}

/** 确保 Gateway 已连接 */
async function ensureGatewayConnected() {
  if (gw.state === 'connected') return 'connected';
  if (gw.state === 'pairing_pending') return 'pairing_pending';
  if (gw._connectPromise) return gw._connectPromise;
  return connectGateway();
}

/** 在共享连接上发送 RPC */
function sendGatewayRPC(sid, method, params) {
  return new Promise((resolve, reject) => {
    if (gw.state !== 'connected' || !gw.ws || gw.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Gateway 未连接'));
    }
    const reqId = `rpc-${randomUUID()}`;
    const timer = setTimeout(() => {
      gw.pendingRequests.delete(reqId);
      reject(new Error('请求超时'));
    }, REQUEST_TIMEOUT);

    gw.pendingRequests.set(reqId, { sid, resolve, reject, timer });
    const frame = { type: 'req', id: reqId, method, params };
    log.debug(`RPC → [${sid?.slice(0, 8)}] ${method} id=${reqId}`);
    log.trace(`GW → 完整帧 (RPC ${method}):\n${JSON.stringify(frame, null, 2)}`);
    gw.ws.send(JSON.stringify(frame));
  });
}

// ==================== Express 应用 ====================

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowAllOrigins = configuredOrigins.length === 0 || configuredOrigins.includes('*');
  const origin = req.headers.origin;
  if (origin && (allowAllOrigins || configuredOrigins.includes(origin) || origin.startsWith('capacitor://') || origin.startsWith('ionic://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Proxy-User');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sessions: sessions.size,
    gateway: { state: gw.state, hasDeviceToken: !!deviceKey.deviceToken },
    config: {
      port: CONFIG.port,
      gatewayUrl: CONFIG.gatewayUrl,
      hasGatewayToken: !!CONFIG.gatewayToken,
      multiUser: true,
      userCount: USERS.size,
      downloadRoots: CONFIG.downloadRoots,
      configPath: CONFIG_PATH,
      dataDir: DATA_DIR,
      allowAllOrigins: !(process.env.ALLOWED_ORIGINS || '').trim(),
    },
  });
});

// ==================== API 路由 ====================

/** POST /api/connect — 建立用户会话 */
app.post('/api/connect', async (req, res) => {
  const { token, username } = req.body || {};
  const auth = validateToken(token, username);
  if (!auth.valid) {
    return res.status(401).json({ ok: false, error: '认证失败：用户名或用户密码错误' });
  }

  if (!CONFIG.gatewayToken && !CONFIG.gatewayPassword && !deviceKey.deviceToken) {
    return res.status(502).json({
      ok: false,
      error: `Gateway 认证未配置：请在 ${CONFIG_PATH} 中设置 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD`,
    });
  }

  const sid = randomUUID();
  const userId = auth.userId;

  try {
    const gwState = await ensureGatewayConnected();
    const sessionKey = getUserSessionKey(userId);

    const session = {
      userId,
      username: username || userId || null,
      token,
      sseRes: null,
      eventBuffer: [],
      eventSeq: 0,
      lastActivity: Date.now(),
      sessionKeys: new Set([sessionKey]),
      _sseHeartbeat: null,
      _lingerTimer: null,
    };
    sessions.set(sid, session);

    if (gwState === 'pairing_pending') {
      log.info(`会话建立（等待配对）[${sid}] userId=${userId || 'default'} requestId=${gw.pairingRequestId || 'N/A'}`);
      return res.json({
        ok: true, sid,
        state: 'pairing_pending',
        deviceId: deviceKey.deviceId,
        requestId: gw.pairingRequestId || null,
        userId: userId || null,
      });
    }

    log.info(`会话建立成功 [${sid}] userId=${userId || 'default'} sessionKey=${sessionKey}`);
    res.json({ ok: true, sid, snapshot: gw.snapshot, hello: gw.hello, sessionKey, userId: userId || null });
  } catch (e) {
    log.error(`会话建立失败 [${sid}]:`, e.message);
    sessions.delete(sid);

    let userError = e.message;
    let statusCode = 502;
    if (/ECONNREFUSED/.test(userError)) {
      userError = 'OpenClaw 服务未启动，请先在电脑上启动 OpenClaw 后再连接';
    } else if (/ETIMEDOUT|EHOSTUNREACH/.test(userError)) {
      userError = '无法连接到 OpenClaw 服务，请检查网络或 Gateway 地址配置';
    } else if (/连接超时/.test(userError)) {
      userError = '连接超时，请检查 OpenClaw 是否正在运行';
    } else if (/unauthorized|token missing|auth.*token|握手失败/i.test(userError)) {
      userError = `Gateway 认证失败：请在 ${CONFIG_PATH} 中配置 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD`;
    }
    res.status(statusCode).json({ ok: false, error: userError });
  }
});

/** GET /api/events — SSE 事件流 */
app.get('/api/events', (req, res) => {
  const sid = req.query.sid;
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
  });
  res.flushHeaders();
  if (req.socket) req.socket.setNoDelay(true);
  res.write(`: padding ${' '.repeat(2048)}\n\n`);

  // 关闭旧 SSE
  if (session.sseRes && !session.sseRes.writableEnded) session.sseRes.end();
  if (session._sseHeartbeat) clearInterval(session._sseHeartbeat);

  session.sseRes = res;
  session.lastActivity = Date.now();
  if (session._lingerTimer) { clearTimeout(session._lingerTimer); session._lingerTimer = null; }

  // 断线续传
  const lastId = parseInt(req.headers['last-event-id'], 10);
  if (lastId && session.eventBuffer.length > 0) {
    const missed = session.eventBuffer.filter(e => e.id > lastId);
    for (const entry of missed) {
      res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
    log.info(`SSE 续传 [${sid}] 补发 ${missed.length} 条事件`);
  }

  // 就绪确认
  res.write(`event: proxy.ready\ndata: ${JSON.stringify({ sid, state: gw.state })}\n\n`);
  if (typeof res.flush === 'function') res.flush();

  // 心跳
  session._sseHeartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
      if (typeof res.flush === 'function') res.flush();
    }
  }, SSE_HEARTBEAT_INTERVAL);

  res.on('close', () => {
    log.info(`SSE 关闭 [${sid}]`);
    if (session._sseHeartbeat) { clearInterval(session._sseHeartbeat); session._sseHeartbeat = null; }
    session.sseRes = null;
    session._lingerTimer = setTimeout(() => {
      const s = sessions.get(sid);
      if (s && !s.sseRes) {
        log.info(`SSE 未重连，清理会话 [${sid}]`);
        cleanupSession(sid);
      }
    }, UPSTREAM_LINGER);
  });
});

/** POST /api/send — RPC 转发 */
app.post('/api/send', async (req, res) => {
  const { sid, method, params } = req.body || {};
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  if (gw.state !== 'connected') return res.status(400).json({ ok: false, error: 'Gateway 未就绪' });

  session.lastActivity = Date.now();

  // 自动订阅请求中涉及的 sessionKey（用于事件路由）
  if (params?.sessionKey) session.sessionKeys.add(params.sessionKey);

  // ====== 拦截 chat.send：保存附件到磁盘 ======
  if (method === 'chat.send' && params?.attachments?.length > 0 && params?.sessionKey) {
    const messageText = (params.message || params.content || '').substring(0, 100).trim();
    const saveAtt = sqlite.transaction((atts) => {
      for (const att of atts) {
        if (!att.content) continue; // 没有 base64 数据则跳过
        try {
          const id = randomUUID();
          const ext = mimeToExt(att.mimeType || att.type || 'application/octet-stream');
          const fileName = att.fileName || att.name || `attachment.${ext}`;
          const filePath = `${id}.${ext}`;
          const buffer = Buffer.from(att.content, 'base64');
          writeFileSync(join(UPLOADS_DIR, filePath), buffer);
          stmts.insertAtt.run(id, params.sessionKey, messageText, fileName, att.mimeType || att.type || 'application/octet-stream', buffer.length, filePath, Date.now());
          log.debug(`保存附件: ${fileName} (${(buffer.length / 1024).toFixed(1)}KB) → uploads/${filePath}`);
        } catch (e) {
          log.error('保存附件失败:', e.message);
        }
      }
    });
    saveAtt(params.attachments);

    const docContext = await buildDocumentContext(params.attachments);
    if (docContext) {
      const originalMessage = String(params.message || params.content || '').trim();
      const mergedMessage = originalMessage
        ? `${originalMessage}\n\n${docContext}`
        : docContext;
      params.message = mergedMessage;
    }
  }

  try {
    let result = await sendGatewayRPC(sid, method, params);

    // ====== 删除会话时同步清理 SQLite 标题和附件文件 ======
    if (method === 'sessions.delete' && params?.key) {
      stmts.deleteTitle.run(params.key);
      // 清理附件文件
      const attPaths = stmts.getAttPathsBySession.all(params.key);
      for (const { file_path } of attPaths) {
        try { unlinkSync(join(UPLOADS_DIR, file_path)); } catch { /* 文件可能已不在 */ }
      }
      stmts.deleteAttBySession.run(params.key);
      stmts.deleteMetaBySession.run(params.key);
      log.debug(`清理已删除会话: ${params.key} (标题 + ${attPaths.length} 个附件 + 元数据)`);
    }

    // ====== 过滤 sessions.list，只返回 ClawChat 创建的会话（带 clawchat- 前缀） ======
    if (method === 'sessions.list') {
      const userId = session.userId || session.username || 'default';
      const filterSession = (s) => {
        const key = s?.key || s?.sessionKey || '';
        // 必须是 ClawChat 创建的会话
        if (!key.includes(':clawchat-')) return false;
        // 始终按用户隔离（不仅限多用户模式）
        if (userId) return key.includes(`:clawchat-${userId}`);
        return true;
      };

      /** 为会话注入服务端存储的标题 */
      const injectTitles = (sessions) => sessions.map(s => {
        const key = s?.key || s?.sessionKey || '';
        const row = stmts.getTitle.get(key);
        if (row?.title && (!s.title || s.title === key)) {
          return { ...s, title: row.title };
        }
        return s;
      });

      if (result?.sessions && Array.isArray(result.sessions)) {
        log.debug(`sessions.list 过滤前: ${result.sessions.length} 条, userId=${userId}`);
        const filtered = result.sessions.filter(filterSession);
        result = { ...result, sessions: injectTitles(filtered) };
        log.debug(`sessions.list 过滤后: ${result.sessions.length} 条`);
      } else if (result?.items && Array.isArray(result.items)) {
        result = { ...result, items: injectTitles(result.items.filter(filterSession)) };
      } else if (Array.isArray(result)) {
        result = injectTitles(result.filter(filterSession));
      } else {
        log.debug(`sessions.list 响应格式未知: ${JSON.stringify(result).substring(0, 300)}`);
      }
    }

    res.json({ ok: true, payload: result });
  } catch (e) {
    if (/Gateway 未连接/.test(e.message)) {
      return res.status(502).json({ ok: false, error: 'Gateway 连接已断开' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/disconnect */
app.post('/api/disconnect', (req, res) => {
  const { sid } = req.body || {};
  if (sessions.has(sid)) cleanupSession(sid);
  res.json({ ok: true });
});

/** GET /api/files — 浏览当前会话对应目录下的文件和子目录（通过 clawchatfiles 插件） */
app.get('/api/files', async (req, res) => {
  const sid = String(req.query.sid || '');
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  const sessionKey = String(req.query.sessionKey || '');
  if (!sessionKey) return res.status(400).json({ ok: false, error: '缺少 sessionKey' });

  try {
    const result = await callClawChatFilesRPC(sid, 'list', {
      sessionKey,
      path: String(req.query.path || ''),
    });
    res.json({
      ok: true,
      rootName: '当前对话文件',
      sessionDirId: result?.sessionDirId || '',
      currentPath: result?.currentPath || '',
      parentPath: result?.parentPath ?? null,
      entries: Array.isArray(result?.entries) ? result.entries : [],
    });
  } catch (e) {
    const message = (e && e.message) || '';
    if (/does not match plugin filter/i.test(message)) {
      return res.status(400).json({ ok: false, error: '当前会话未启用 ClawChat 文件插件' });
    }
    if (/Requested path is not a directory/i.test(message)) {
      return res.status(400).json({ ok: false, error: '当前路径不是目录' });
    }
    res.status(500).json({ ok: false, error: message || '加载文件列表失败' });
  }
});

/** POST /api/files/upload — 上传文件到当前会话目录（通过 clawchatfiles 插件解析落盘位置） */
app.post('/api/files/upload', async (req, res) => {
  const { sid, sessionKey, path: rawDirPath, fileName, mimeType, size, base64 } = req.body || {};

  const session = sessions.get(String(sid || ''));
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });

  const sk = String(sessionKey || '');
  if (!sk) return res.status(400).json({ ok: false, error: '缺少 sessionKey' });

  // 多用户隔离：已登记 key、其 `-后缀` 派生（新对话）、或按用户归属推导
  if (!canProxyWriteSessionFiles(sk, session)) {
    return res.status(403).json({ ok: false, error: '无权限写入该会话目录' });
  }
  if (!session.sessionKeys.has(sk)) session.sessionKeys.add(sk);

  if (!base64 || typeof base64 !== 'string') return res.status(400).json({ ok: false, error: '缺少 base64 文件内容' });
  const fileNameStr = String(fileName || '').trim();
  if (!fileNameStr) return res.status(400).json({ ok: false, error: '缺少 fileName' });

  const safeMimeType = String(mimeType || 'application/octet-stream').trim();
  const safeSize = Number.isFinite(Number(size)) ? Number(size) : undefined;

  const safeDirPath = String(rawDirPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

  const safeBase64 = base64.startsWith('data:')
    ? String(base64).replace(/^data:.*?;base64,/, '')
    : base64;

  const sanitizeFileName = (name) => {
    return String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.+$/g, '') // 避免以 . 或 .. 结尾
      || 'upload.bin';
  };

  // 防止用户在 fileName 里塞入路径分隔符，导致写入非目标目录
  const safeFile = sanitizeFileName(fileNameStr).replace(/[\\/]/g, '_');

  // client 传的是“目录”，插件 resolve 需要相对 session 根的“文件相对路径”
  const fileRelativePath = safeDirPath ? `${safeDirPath}/${safeFile}` : safeFile;

  try {
    // 确保 session 目录存在（在第一次打开文件浏览页之前也可主动调用）
    await callClawChatFilesRPC(String(sid || ''), 'ensure', { sessionKey: sk });

    // 通过插件 resolve 校验相对路径是否越界，并拿到 absolutePath（即使文件不存在也会返回）
    const resolved = await callClawChatFilesRPC(String(sid || ''), 'resolve', {
      sessionKey: sk,
      path: fileRelativePath,
    });

    if (!resolved?.absolutePath) {
      return res.status(500).json({ ok: false, error: '解析失败：插件未返回可写入的路径' });
    }

    const localTarget = mapPluginAbsolutePathToLocal(resolved.absolutePath);
    if (!localTarget?.absolutePath) {
      return res.status(500).json({
        ok: false,
        error: '插件返回的文件路径在代理侧不可访问，请检查 OpenClaw 与代理的目录映射配置',
      });
    }

    mkdirSync(dirname(localTarget.absolutePath), { recursive: true });
    const buffer = Buffer.from(String(safeBase64), 'base64');
    if (!buffer.length) {
      return res.status(400).json({ ok: false, error: '文件内容为空或 base64 非法' });
    }

    writeFileSync(localTarget.absolutePath, buffer);

    log.debug(`文件上传完成: ${safeFile} (${(buffer.length / 1024).toFixed(1)}KB) -> ${localTarget.absolutePath}`);
    // 这里不需要保存 mimeType/size 到 SQLite：文件浏览由插件直接读目录即可
    res.json({ ok: true, fileName: safeFile, mimeType: safeMimeType, size: safeSize ?? buffer.length });
  } catch (e) {
    const message = (e && e.message) || '';
    if (/does not match plugin filter/i.test(message)) {
      return res.status(400).json({ ok: false, error: '当前会话未启用 ClawChat 文件插件' });
    }
    if (/escapes session directory/i.test(message)) {
      return res.status(400).json({ ok: false, error: '路径无效' });
    }
    res.status(500).json({ ok: false, error: message || '上传失败' });
  }
});

/** POST /api/files/download — 下载当前会话目录下的文件（通过 clawchatfiles 插件解析） */
app.post('/api/files/download', async (req, res) => {
  const { sid, sessionKey, path: rawPath, archive } = req.body || {};
  await handleSessionFileDownload({ sid, sessionKey, rawPath, archive: !!archive }, res);
});

/** GET /api/files/download — 原生端直连下载，避免 WebView 二进制转码损坏 */
app.get('/api/files/download', async (req, res) => {
  await handleSessionFileDownload({
    sid: String(req.query.sid || ''),
    sessionKey: String(req.query.sessionKey || ''),
    rawPath: String(req.query.path || ''),
    archive: String(req.query.archive || '') === '1' || String(req.query.archive || '').toLowerCase() === 'true',
  }, res);
});

/** GET /api/progress */
app.get('/api/progress', (req, res) => {
  const sid = String(req.query.sid || '');
  if (!sid) return res.status(400).json({ ok: false, error: '缺少 sid' });
  if (!sessions.has(sid)) return res.status(404).json({ ok: false, error: '会话不存在' });
  res.json({ ok: true, sid, busy: false, state: 'idle', updatedAt: Date.now() });
});

/** POST /api/session-title — 保存会话标题 */
app.post('/api/session-title', (req, res) => {
  const { sid, sessionKey, title } = req.body || {};
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  if (!sessionKey || !title) return res.status(400).json({ ok: false, error: '缺少参数' });

  stmts.upsertTitle.run(sessionKey, title, Date.now());
  log.debug(`保存会话标题: ${sessionKey} → ${title}`);
  res.json({ ok: true });
});

/** GET /api/session-titles — 获取用户的所有会话标题 */
app.get('/api/session-titles', (req, res) => {
  const sid = String(req.query.sid || '');
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });

  // 只返回当前用户的标题
  const userId = session.userId || session.username || 'default';
  const rows = stmts.getTitlesByUser.all(`%:clawchat-${userId}%`);
  const userTitles = {};
  for (const row of rows) {
    userTitles[row.session_key] = row.title;
  }
  res.json({ ok: true, titles: userTitles });
});

/** GET /api/session-attachments — 获取会话的所有附件元数据 */
app.get('/api/session-attachments', (req, res) => {
  const sid = String(req.query.sid || '');
  const sessionKey = String(req.query.sessionKey || '');
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  if (!sessionKey) return res.status(400).json({ ok: false, error: '缺少 sessionKey' });

  const rows = stmts.getAttBySession.all(sessionKey);
  const attachments = rows.map(r => ({
    id: r.id,
    name: r.file_name,
    type: r.mime_type,
    size: r.file_size,
    url: `/api/attachment/${r.id}`,
    messageText: r.message_text,
    createdAt: r.created_at,
  }));
  res.json({ ok: true, attachments });
});

/** GET /api/attachment/:id — 下载/显示附件文件 */
app.get('/api/attachment/:id', (req, res) => {
  const row = stmts.getAttById.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Attachment not found' });

  const filePath = join(UPLOADS_DIR, row.file_path);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 附件不变，长缓存
  res.sendFile(filePath);
});

/** POST /api/download-file — 下载受限目录中的构建产物 */
app.post('/api/download-file', (req, res) => {
  const auth = authenticateByToken(req);
  if (!auth.valid) {
    return res.status(401).json({ ok: false, error: '认证失败：用户名或用户密码错误' });
  }

  const requestedPath = String(req.body?.path || '').trim();
  if (!requestedPath) {
    return res.status(400).json({ ok: false, error: '缺少 path' });
  }

  const resolved = resolveDownloadableFilePath(requestedPath);
  if (!resolved) {
    return res.status(403).json({ ok: false, error: '文件不存在或不在允许下载的目录中' });
  }

  log.info(`下载构建产物: ${resolved.fileName} <= ${resolved.absolutePath} userId=${auth.userId || 'default'}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(resolved.fileName)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(resolved.absolutePath);
});

/** POST /api/message-meta — 保存助手消息元数据（工具调用、思维链、blocks） */
app.post('/api/message-meta', (req, res) => {
  const { sid, sessionKey, messageId, toolCalls, thinking, blocks } = req.body || {};
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  if (!sessionKey || !messageId) return res.status(400).json({ ok: false, error: '缺少参数' });

  const tcJson = toolCalls ? JSON.stringify(toolCalls) : null;
  const thkStr = thinking || null;
  const blkJson = blocks ? JSON.stringify(blocks) : null;
  stmts.upsertMeta.run(sessionKey, messageId, tcJson, thkStr, blkJson, Date.now());
  log.debug(`保存助手元数据: ${sessionKey} / ${messageId} (tc=${!!tcJson} thk=${!!thkStr} blk=${!!blkJson})`);
  res.json({ ok: true });
});

/** GET /api/message-meta — 获取会话的所有助手元数据 */
app.get('/api/message-meta', (req, res) => {
  const sid = String(req.query.sid || '');
  const sessionKey = String(req.query.sessionKey || '');
  const session = sessions.get(sid);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  if (!sessionKey) return res.status(400).json({ ok: false, error: '缺少 sessionKey' });

  const rows = stmts.getMetaBySession.all(sessionKey);
  const meta = rows.map(r => ({
    messageId: r.message_id,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    thinking: r.thinking || undefined,
    blocks: r.blocks ? JSON.parse(r.blocks) : undefined,
  }));
  res.json({ ok: true, meta });
});

// ==================== 定期清理 ====================

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (session.sseRes && !session.sseRes.writableEnded) continue;
    if (now - session.lastActivity > SESSION_IDLE_TIMEOUT) {
      log.info(`会话空闲超时 [${sid}]`);
      cleanupSession(sid);
    }
  }
}, SESSION_CLEANUP_INTERVAL);

// ==================== 静态文件 ====================

if (existsSync(CONFIG.distPath)) {
  app.use(express.static(CONFIG.distPath));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not Found' });
    res.sendFile(join(CONFIG.distPath, 'index.html'));
  });
  log.info(`静态文件目录: ${CONFIG.distPath}`);
}

// ==================== 启动服务器 ====================

const server = createServer(app);

server.listen(CONFIG.port, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║         ✅ ClawChat 代理服务已启动成功！              ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  端口:         ${String(CONFIG.port).padEnd(40)}║`);
  console.log(`║  绑定地址:     0.0.0.0（公网可访问）                  ║`);
  console.log(`║  Gateway 地址: ${CONFIG.gatewayUrl.padEnd(40)}║`);
  console.log(`║  用户模式:     多用户（${USERS.size} 个用户，对话隔离）${' '.repeat(Math.max(0, 15 - String(USERS.size).length))}║`);
  for (const [uid] of USERS) {
    const line = `    - ${uid}`;
    console.log(`║  ${line.padEnd(53)}║`);
  }
  if (CONFIG.gatewayToken || CONFIG.gatewayPassword) {
    console.log('║  Gateway 认证: ✅ 已配置                             ║');
  } else if (deviceKey.deviceToken) {
    console.log('║  Gateway 认证: ✅ 使用已保存的 deviceToken            ║');
  } else {
    console.log('║  Gateway 认证: ❌ 未配置                             ║');
  }
  console.log(`║  设备 ID:      ${deviceKey.deviceId.slice(0, 32)}...   ║`);
  if (deviceKey.deviceToken) {
    console.log('║  Device Token: ✅ 已保存（免配对重连）                ║');
  } else {
    console.log('║  Device Token: ⏳ 未获取（首次需配对）                ║');
  }
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');

  console.log(`ℹ️  多用户模式已启用，共 ${USERS.size} 个用户`);
  console.log('   每个用户拥有独立的对话空间，共享同一个 Gateway 设备身份');
  console.log('   Gateway 只需配对一次，所有用户即可使用');
  console.log(`   配置文件: ${CONFIG_PATH}`);
  console.log(`   运行数据目录: ${DATA_DIR}`);
  console.log(`   默认下载目录白名单: ${DEFAULT_DOWNLOAD_ROOT}`);
  console.log('');

  if (!CONFIG.gatewayToken && !CONFIG.gatewayPassword && !deviceKey.deviceToken) {
    console.log('⚠️  警告: 未配置 Gateway 认证信息！');
    console.log(`   请编辑 ${CONFIG_PATH}，设置以下其中一项：`);
    console.log('     OPENCLAW_GATEWAY_TOKEN=你的Gateway-Token');
    console.log('     OPENCLAW_GATEWAY_PASSWORD=你的Gateway密码');
    console.log('');
  } else if (!CONFIG.gatewayToken && !CONFIG.gatewayPassword && deviceKey.deviceToken) {
    console.log('ℹ️  使用已保存的 deviceToken 进行 Gateway 认证');
    console.log(`   （如需切换 Gateway，请删除 ${DEVICE_KEY_PATH} 并重新配对）`);
    console.log('');
  }

  if (USERS.size === 0) {
    log.warn(`未设置任何用户，请编辑 ${CONFIG_PATH} 中的 PROXY_USERS=用户名:密码`);
  }
});

// ==================== 优雅关闭 ====================

function shutdown() {
  log.info('正在关闭服务...');
  for (const [sid] of sessions) cleanupSession(sid);
  if (gw._heartbeat) clearInterval(gw._heartbeat);
  if (gw._reconnectTimer) clearTimeout(gw._reconnectTimer);
  if (gw._connectTimer) clearTimeout(gw._connectTimer);
  stopPairingRetry();
  if (gw.ws && gw.ws.readyState !== WebSocket.CLOSED) gw.ws.close();
  for (const [, pending] of gw.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('服务关闭'));
  }
  gw.pendingRequests.clear();
  server.close(() => {
    log.info('服务已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
