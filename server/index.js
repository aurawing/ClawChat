/**
 * ClawChat SSE + HTTP POST 代理服务端
 * 完全兼容 qingchencloud/clawapp 协议
 *
 * 架构：
 * - 手机 ←SSE+POST→ 代理服务端 ←WS→ OpenClaw Gateway
 * - POST /api/connect   建立会话（握手 Gateway）
 * - GET  /api/events    SSE 事件流（服务端推送）
 * - POST /api/send      发送请求（RPC 转发）
 * - POST /api/disconnect 断开会话
 */

import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  randomUUID, randomBytes, generateKeyPairSync, createHash,
  sign as ed25519Sign, createPrivateKey,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = join(__dirname, '.env');

// ==================== 自动创建 .env ====================
if (!existsSync(ENV_PATH)) {
  const tmpToken = randomBytes(12).toString('base64url');
  const content = [
    '# ClawChat 配置文件（自动生成）',
    'PROXY_PORT=3210',
    '',
    '# 客户端连接密码（登录时填写的 Token）',
    `PROXY_TOKEN=${tmpToken}`,
    '',
    '# OpenClaw Gateway 地址',
    'OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789',
    '',
    '# OpenClaw Gateway 认证 token',
    'OPENCLAW_GATEWAY_TOKEN=',
    '',
    '# OpenClaw Gateway 认证密码（优先于 token）',
    'OPENCLAW_GATEWAY_PASSWORD=',
    '',
  ].join('\n');
  writeFileSync(ENV_PATH, content, 'utf8');
  console.log('[INFO] 首次启动，已自动创建 server/.env 配置文件');
  console.log(`[INFO] 自动生成的连接密码: ${tmpToken}`);
}

// 加载环境变量
config({ path: ENV_PATH });

// ==================== 配置 ====================
const CONFIG = {
  port: parseInt(process.env.PROXY_PORT, 10) || 3210,
  proxyToken: process.env.PROXY_TOKEN || '',
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '',
  gatewayPassword: process.env.OPENCLAW_GATEWAY_PASSWORD || '',
  distPath: join(__dirname, '..', 'dist'),
};

// ==================== Ed25519 设备密钥 ====================
const DEVICE_KEY_PATH = join(__dirname, '.device-key.json');
const deviceKey = (() => {
  if (existsSync(DEVICE_KEY_PATH)) {
    return JSON.parse(readFileSync(DEVICE_KEY_PATH, 'utf8'));
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const dk = {
    deviceId: createHash('sha256').update(pubRaw).digest('hex'),
    publicKey: pubRaw.toString('base64url'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  writeFileSync(DEVICE_KEY_PATH, JSON.stringify(dk, null, 2));
  return dk;
})();
const devicePrivateKey = createPrivateKey(deviceKey.privateKeyPem);

// ==================== 日志 ====================
const log = {
  info: (msg, ...args) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...args),
  debug: (msg, ...args) => process.env.DEBUG && console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...args),
};

// ==================== 常量 ====================
const SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write'];
const SSE_HEARTBEAT_INTERVAL = 15000;
const SESSION_CLEANUP_INTERVAL = 60000;
const SESSION_IDLE_TIMEOUT = 300000;
const UPSTREAM_LINGER = 120000;
const EVENT_BUFFER_MAX = 200;
const REQUEST_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 10000;
const GATEWAY_RETRY_COUNT = 3;
const GATEWAY_RETRY_DELAY = 1000;

// ==================== 会话管理 ====================
const sessions = new Map();

/**
 * 生成 connect 握手帧（含 Ed25519 device 签名）
 */
function createConnectFrame(nonce) {
  const signedAt = Date.now();
  const credential = CONFIG.gatewayPassword || CONFIG.gatewayToken;
  const payload = [
    'v2', deviceKey.deviceId, 'gateway-client', 'backend', 'operator',
    SCOPES.join(','), String(signedAt), credential, nonce || '',
  ].join('|');
  const signature = ed25519Sign(null, Buffer.from(payload, 'utf8'), devicePrivateKey).toString('base64url');
  const auth = CONFIG.gatewayPassword
    ? { password: CONFIG.gatewayPassword }
    : { token: CONFIG.gatewayToken };
  return {
    type: 'req',
    id: `connect-${randomUUID()}`,
    method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'gateway-client', version: '1.0.0', platform: 'web', mode: 'backend' },
      role: 'operator',
      scopes: SCOPES,
      caps: [],
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

/** 验证客户端 token */
function validateToken(token) {
  if (!CONFIG.proxyToken) return true;
  return token === CONFIG.proxyToken;
}

/** 向 SSE 客户端推送事件 */
function sseWrite(session, event, data) {
  session.eventSeq++;
  const entry = { id: session.eventSeq, event, data };
  session.eventBuffer.push(entry);
  if (session.eventBuffer.length > EVENT_BUFFER_MAX) {
    session.eventBuffer.shift();
  }
  if (session.sseRes && !session.sseRes.writableEnded) {
    session.sseRes.write(`id: ${entry.id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof session.sseRes.flush === 'function') session.sseRes.flush();
  }
}

/** 清理会话 */
function cleanupSession(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  log.info(`清理会话: ${sid}`);
  if (session._heartbeat) clearInterval(session._heartbeat);
  if (session._sseHeartbeat) clearInterval(session._sseHeartbeat);
  if (session._connectTimer) clearTimeout(session._connectTimer);
  if (session._lingerTimer) clearTimeout(session._lingerTimer);
  if (session.sseRes && !session.sseRes.writableEnded) {
    session.sseRes.end();
  }
  if (session.upstream && session.upstream.readyState !== WebSocket.CLOSED) {
    session.upstream.close();
  }
  for (const [, cb] of session.pendingRequests) {
    clearTimeout(cb.timer);
    cb.reject(new Error('会话已关闭'));
  }
  session.pendingRequests.clear();
  sessions.delete(sid);
}

/**
 * 处理上游消息（Gateway → 代理服务端）
 */
function handleUpstreamMessage(sid, rawData) {
  const session = sessions.get(sid);
  if (!session) return;

  const str = typeof rawData === 'string' ? rawData : rawData.toString();
  session.lastActivity = Date.now();

  // 已连接状态：解析后推送 SSE
  if (session.state === 'connected') {
    let msg;
    try { msg = JSON.parse(str); } catch { return; }

    // RPC 响应 → 匹配 pendingRequests
    if (msg.type === 'res') {
      const cb = session.pendingRequests.get(msg.id);
      log.debug(`RPC 响应 [${sid}] id=${msg.id} ok=${msg.ok} matched=${!!cb}`);
      if (cb) {
        session.pendingRequests.delete(msg.id);
        clearTimeout(cb.timer);
        if (msg.ok) cb.resolve(msg.payload);
        else cb.reject(new Error(msg.error?.message || msg.error?.code || '请求失败'));
      }
      return;
    }

    // 事件 → 推送 SSE
    if (msg.type === 'event') {
      log.debug(`SSE 推送 [${sid}] event=${msg.event} stream=${msg.payload?.stream} state=${msg.payload?.state}`);
      sseWrite(session, 'message', msg);
    }
    return;
  }

  // 握手阶段
  let message;
  try { message = JSON.parse(str); } catch { return; }

  log.debug(`上游消息 [${sid}] type=${message.type} event=${message.event}`);

  // connect.challenge
  if (message.type === 'event' && message.event === 'connect.challenge') {
    log.info(`收到 connect.challenge [${sid}]`);
    if (session._connectTimer) { clearTimeout(session._connectTimer); session._connectTimer = null; }
    const nonce = message.payload?.nonce || '';
    const connectFrame = createConnectFrame(nonce);
    if (session.upstream?.readyState === WebSocket.OPEN) {
      session.upstream.send(JSON.stringify(connectFrame));
    }
    return;
  }

  // connect 响应
  if (message.type === 'res' && message.id?.startsWith('connect-')) {
    if (!message.ok || message.error) {
      log.error(`Gateway 握手失败 [${sid}]:`, message.error || '未知错误');
      session._connectReject?.(new Error(message.error?.message || 'Gateway 握手失败'));
    } else {
      log.info(`Gateway 握手成功 [${sid}]`);
      session.state = 'connected';
      session.hello = message.payload;
      session.snapshot = message.payload?.snapshot || null;
      // 发送缓存消息
      for (const msg of session._pendingMessages) {
        if (session.upstream?.readyState === WebSocket.OPEN) session.upstream.send(msg);
      }
      session._pendingMessages = [];
      session._connectResolve?.();
    }
    return;
  }
}

/**
 * 建立到 Gateway 的上游 WS 连接
 */
function connectToGateway(sid) {
  const session = sessions.get(sid);
  if (!session) return Promise.reject(new Error('会话不存在'));

  return new Promise((resolve, reject) => {
    session._connectResolve = resolve;
    session._connectReject = reject;

    log.info(`连接到 Gateway: ${CONFIG.gatewayUrl} [${sid}]`);
    const upstream = new WebSocket(CONFIG.gatewayUrl, {
      headers: { 'Origin': CONFIG.gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://') },
    });
    session.upstream = upstream;
    session.state = 'connecting';

    upstream.on('open', () => {
      log.info(`上游连接已建立 [${sid}]`);
      // 等 500ms 看是否收到 challenge
      session._connectTimer = setTimeout(() => {
        if (session.state === 'connecting') {
          log.info(`未收到 challenge，直接发送 connect [${sid}]`);
          upstream.send(JSON.stringify(createConnectFrame('')));
        }
      }, 500);
    });

    upstream.on('message', (data) => handleUpstreamMessage(sid, data.toString()));

    upstream.on('close', (code, reason) => {
      log.warn(`上游连接关闭 [${sid}] code=${code}`);
      if (session.state !== 'connected') {
        reject(new Error(`Gateway 连接关闭: ${code}`));
      } else {
        sseWrite(session, 'proxy.disconnect', { message: 'Gateway 连接已断开', code });
        cleanupSession(sid);
      }
    });

    upstream.on('error', (error) => {
      log.error(`上游连接错误 [${sid}]:`, error.message);
      if (session.state !== 'connected') {
        reject(new Error(`Gateway 连接错误: ${error.message}`));
      }
    });

    // 上游心跳
    session._heartbeat = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.ping();
      }
    }, 30000);
  });
}

// ==================== Express 应用 ====================

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS
app.use((req, res, next) => {
  const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowedOrigins = [
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'https://localhost', 'https://127.0.0.1',
    `http://localhost:${CONFIG.port}`, `http://127.0.0.1:${CONFIG.port}`,
    'capacitor://localhost', 'ionic://localhost',
    'http://localhost',
    ...extraOrigins,
  ];
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || origin.startsWith('capacitor://') || origin.startsWith('ionic://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // 无 Origin 时（如 Capacitor 原生请求）允许
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    config: {
      port: CONFIG.port,
      gatewayUrl: CONFIG.gatewayUrl,
      hasProxyToken: !!CONFIG.proxyToken,
      hasGatewayToken: !!CONFIG.gatewayToken,
    },
  });
});

// ==================== API 路由 ====================

/** POST /api/connect — 建立会话 */
app.post('/api/connect', async (req, res) => {
  const { token } = req.body || {};
  if (!validateToken(token)) {
    return res.status(401).json({ ok: false, error: '认证失败：无效的连接密码' });
  }

  // 前置检查：Gateway 认证信息是否配置
  if (!CONFIG.gatewayToken && !CONFIG.gatewayPassword) {
    log.error('Gateway 认证未配置，拒绝连接请求');
    return res.status(502).json({
      ok: false,
      error: 'Gateway 认证未配置：请在服务器的 server/.env 中设置 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD',
    });
  }

  const sid = randomUUID();
  const session = {
    token,
    upstream: null,
    state: 'init',
    sseRes: null,
    eventBuffer: [],
    eventSeq: 0,
    pendingRequests: new Map(),
    snapshot: null,
    hello: null,
    lastActivity: Date.now(),
    _pendingMessages: [],
    _connectTimer: null,
    _connectResolve: null,
    _connectReject: null,
    _heartbeat: null,
    _lingerTimer: null,
    _sseHeartbeat: null,
  };
  sessions.set(sid, session);

  try {
    let lastError;
    for (let attempt = 1; attempt <= GATEWAY_RETRY_COUNT; attempt++) {
      try {
        const timeout = setTimeout(() => {
          session._connectReject?.(new Error('连接超时'));
        }, CONNECT_TIMEOUT);

        await connectToGateway(sid);
        clearTimeout(timeout);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (session._heartbeat) { clearInterval(session._heartbeat); session._heartbeat = null; }
        if (session._connectTimer) { clearTimeout(session._connectTimer); session._connectTimer = null; }
        if (session.upstream && session.upstream.readyState !== WebSocket.CLOSED) {
          session.upstream.close();
        }
        session.upstream = null;
        session.state = 'init';
        session.pendingRequests.clear();

        if (attempt < GATEWAY_RETRY_COUNT) {
          log.warn(`Gateway 连接失败 [${sid}] 第${attempt}次，${GATEWAY_RETRY_DELAY}ms 后重试: ${e.message}`);
          await new Promise(r => setTimeout(r, GATEWAY_RETRY_DELAY));
        }
      }
    }

    if (lastError) throw lastError;

    const defaults = session.snapshot?.sessionDefaults;
    const sessionKey = defaults?.mainSessionKey || `agent:${defaults?.defaultAgentId || 'main'}:main`;

    log.info(`会话建立成功 [${sid}]`);
    res.json({ ok: true, sid, snapshot: session.snapshot, hello: session.hello, sessionKey });
  } catch (e) {
    log.error(`会话建立失败 [${sid}]:`, e.message);
    cleanupSession(sid);

    let userError = e.message;
    let statusCode = 502;
    if (/ECONNREFUSED/.test(userError)) {
      userError = 'OpenClaw 服务未启动，请先在电脑上启动 OpenClaw 后再连接';
    } else if (/ETIMEDOUT|EHOSTUNREACH/.test(userError)) {
      userError = '无法连接到 OpenClaw 服务，请检查网络或 Gateway 地址配置';
    } else if (/连接超时/.test(userError)) {
      userError = '连接超时，请检查 OpenClaw 是否正在运行';
    } else if (/unauthorized|token missing|auth.*token|握手失败/i.test(userError)) {
      userError = 'Gateway 认证失败：请在服务器的 server/.env 中配置 OPENCLAW_GATEWAY_TOKEN 或 OPENCLAW_GATEWAY_PASSWORD';
      statusCode = 502;
    }
    res.status(statusCode).json({ ok: false, error: userError });
  }
});

/** GET /api/events — SSE 事件流 */
app.get('/api/events', (req, res) => {
  const sid = req.query.sid;
  const session = sessions.get(sid);
  if (!session) {
    return res.status(404).json({ ok: false, error: '会话不存在' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
  });
  res.flushHeaders();

  if (req.socket) req.socket.setNoDelay(true);

  // 填充注释，触发代理/CDN 刷新缓冲区
  res.write(`: padding ${' '.repeat(2048)}\n\n`);

  // 关闭旧 SSE 连接
  if (session.sseRes && !session.sseRes.writableEnded) {
    session.sseRes.end();
  }
  if (session._sseHeartbeat) {
    clearInterval(session._sseHeartbeat);
  }

  session.sseRes = res;
  session.lastActivity = Date.now();

  if (session._lingerTimer) {
    clearTimeout(session._lingerTimer);
    session._lingerTimer = null;
  }

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

  // 发送就绪确认
  res.write(`event: proxy.ready\ndata: ${JSON.stringify({ sid, state: session.state })}\n\n`);
  if (typeof res.flush === 'function') res.flush();

  // SSE 心跳
  session._sseHeartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
      if (typeof res.flush === 'function') res.flush();
    }
  }, SSE_HEARTBEAT_INTERVAL);

  res.on('close', () => {
    log.info(`SSE 连接关闭 [${sid}]`);
    if (session._sseHeartbeat) {
      clearInterval(session._sseHeartbeat);
      session._sseHeartbeat = null;
    }
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

/** POST /api/send — 发送请求（RPC 转发） */
app.post('/api/send', async (req, res) => {
  const { sid, method, params } = req.body || {};
  const session = sessions.get(sid);
  if (!session) {
    return res.status(404).json({ ok: false, error: '会话不存在' });
  }
  if (session.state !== 'connected') {
    return res.status(400).json({ ok: false, error: '会话未就绪' });
  }
  if (!session.upstream || session.upstream.readyState !== WebSocket.OPEN) {
    return res.status(502).json({ ok: false, error: 'Gateway 连接已断开' });
  }

  session.lastActivity = Date.now();
  const reqId = `rpc-${randomUUID()}`;

  log.info(`RPC 请求 [${sid}] id=${reqId} method=${method}`);
  const frame = { type: 'req', id: reqId, method, params };

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingRequests.delete(reqId);
        reject(new Error('请求超时'));
      }, REQUEST_TIMEOUT);

      session.pendingRequests.set(reqId, { resolve, reject, timer });
      session.upstream.send(JSON.stringify(frame));
    });

    res.json({ ok: true, payload: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/disconnect — 断开会话 */
app.post('/api/disconnect', (req, res) => {
  const { sid } = req.body || {};
  const session = sessions.get(sid);
  if (!session) {
    return res.json({ ok: true });
  }
  cleanupSession(sid);
  res.json({ ok: true });
});

/** GET /api/progress — 查询会话执行状态 */
app.get('/api/progress', (req, res) => {
  const sid = String(req.query.sid || '');
  if (sid) {
    const session = sessions.get(sid);
    if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
    return res.json({
      ok: true,
      sid,
      busy: false,
      state: 'idle',
      updatedAt: Date.now(),
    });
  }
  return res.status(400).json({ ok: false, error: '缺少 sid' });
});

// ==================== 会话清理 ====================

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (session.sseRes && !session.sseRes.writableEnded) continue;
    if (now - session.lastActivity > SESSION_IDLE_TIMEOUT) {
      log.info(`会话空闲超时，清理 [${sid}]`);
      cleanupSession(sid);
    }
  }
}, SESSION_CLEANUP_INTERVAL);

// ==================== 静态文件服务 ====================

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
  if (CONFIG.proxyToken) {
    console.log(`║  连接 Token:   ${CONFIG.proxyToken.padEnd(40)}║`);
  } else {
    console.log('║  连接 Token:   (未设置, 任何人可连接)                ║');
  }
  if (CONFIG.gatewayToken || CONFIG.gatewayPassword) {
    console.log(`║  Gateway 认证: ✅ 已配置                             ║`);
  } else {
    console.log('║  Gateway 认证: ❌ 未配置                             ║');
  }
  console.log(`║  设备 ID:      ${deviceKey.deviceId.slice(0, 32)}...   ║`);
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');

  if (!CONFIG.gatewayToken && !CONFIG.gatewayPassword) {
    console.log('');
    console.log('⚠️  警告: 未配置 Gateway 认证信息！');
    console.log('   大多数 OpenClaw Gateway 需要认证才能连接。');
    console.log('   请编辑 server/.env 文件，设置以下其中一项：');
    console.log('     OPENCLAW_GATEWAY_TOKEN=你的Gateway-Token');
    console.log('     OPENCLAW_GATEWAY_PASSWORD=你的Gateway密码');
    console.log('');
    console.log('   如何获取 Gateway Token:');
    console.log('   - 打开 OpenClaw 客户端 → 设置 → Gateway → 复制 Token');
    console.log('   - 或查看 OpenClaw 配置文件中的 auth.token 字段');
    console.log('');
  }

  if (!CONFIG.proxyToken) {
    log.warn('未设置连接密码 (PROXY_TOKEN)，所有客户端连接将被允许');
  }
});

// 优雅关闭
function shutdown() {
  log.info('正在关闭服务...');
  for (const [sid] of sessions) {
    cleanupSession(sid);
  }
  server.close(() => {
    log.info('服务已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
