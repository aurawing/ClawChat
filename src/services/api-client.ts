/**
 * SSE + HTTP POST 客户端 - 对接 ClawChat 代理服务端
 *
 * 架构：手机 ←SSE+POST→ 代理服务端 ←WS→ OpenClaw Gateway
 */

import type { ConnectionStatus, FileBrowserEntry, GatewayMessage, MessageBlock, ToolCall } from '../types';

const REQUEST_TIMEOUT = 30000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;

/** 解析 baseUrl，要求用户显式填写协议 */
function resolveBaseUrl(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error('请输入服务器地址');
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('服务器地址需包含 http:// 或 https://');
  }
  return trimmed.replace(/\/+$/, '');
}

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

type StatusChangeHandler = (status: ConnectionStatus, errorMsg?: string) => void;
type EventHandler = (msg: GatewayMessage) => void;
type ReadyHandler = (
  hello: Record<string, unknown> | null,
  sessionKey: string | null,
  meta?: { error?: boolean; message?: string }
) => void;

export class ApiClient {
  private _host = '';
  private _token = '';
  private _username = '';
  private _baseUrl = '';
  private _sid: string | null = null;
  private _es: EventSource | null = null;
  private _connected = false;
  private _gatewayReady = false;
  private _pairingPending = false;
  private _deviceId: string | null = null;
  private _requestId: string | null = null;
  private _userId: string | null = null;
  private _intentionalClose = false;
  private _onStatusChange: StatusChangeHandler | null = null;
  private _snapshot: Record<string, unknown> | null = null;
  private _hello: Record<string, unknown> | null = null;
  private _sessionKey: string | null = null;
  private _readyCallbacks: ReadyHandler[] = [];
  private _eventListeners: EventHandler[] = [];
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _esId = 0;
  private _lastSseEventId = 0;
  private _sessionRecoverPromise: Promise<void> | null = null;

  get connected(): boolean {
    return this._connected;
  }
  get gatewayReady(): boolean {
    return this._gatewayReady;
  }
  get pairingPending(): boolean {
    return this._pairingPending;
  }
  get deviceId(): string | null {
    return this._deviceId;
  }
  get requestId(): string | null {
    return this._requestId;
  }
  get userId(): string | null {
    return this._userId;
  }
  get username(): string {
    return this._username;
  }
  get snapshot(): Record<string, unknown> | null {
    return this._snapshot;
  }
  get hello(): Record<string, unknown> | null {
    return this._hello;
  }
  get sessionKey(): string | null {
    return this._sessionKey;
  }
  get sid(): string | null {
    return this._sid;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  onStatusChange(fn: StatusChangeHandler): void {
    this._onStatusChange = fn;
  }

  onReady(fn: ReadyHandler): () => void {
    this._readyCallbacks.push(fn);
    return () => {
      this._readyCallbacks = this._readyCallbacks.filter((cb) => cb !== fn);
    };
  }

  onEvent(callback: EventHandler): () => void {
    this._eventListeners.push(callback);
    return () => {
      this._eventListeners = this._eventListeners.filter((fn) => fn !== callback);
    };
  }

  /** 连接到代理服务端 */
  async connect(host: string, token: string, username: string): Promise<void> {
    this._host = host;
    this._token = token;
    this._username = username;
    this._baseUrl = resolveBaseUrl(host);
    this._intentionalClose = false;
    this._setConnected(false, 'connecting');

    try {
      // 1. POST /api/connect 建立会话
      const body: Record<string, string> = { token, username };
      const res = await fetch(`${this._baseUrl}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`服务暂时不可用 (${res.status})`);
      }
      const data = await res.json();

      if (!data.ok) {
        const msg = data.error || '连接失败';
        if (res.status === 401) {
          this._setConnected(false, 'auth_failed', msg);
          this._notifyReadyError(msg);
          return;
        }
        if (res.status === 502) {
          this._setConnected(false, 'error', msg);
          this._notifyReadyError(msg);
          return;
        }
        throw new Error(msg);
      }

      this._sid = data.sid;
      this._lastSseEventId = 0;

      // ===== 配对待批准：等待 SSE 通知 =====
      if (data.state === 'pairing_pending') {
        this._pairingPending = true;
        this._deviceId = data.deviceId || null;
        this._requestId = data.requestId || null;
        this._connected = false;
        this._gatewayReady = false;
        this._reconnectAttempts = 0;
        this._setConnected(false, 'pairing_pending');
        // 开启 SSE 事件流监听配对结果
        this._setupEventSource();
        return;
      }

      // ===== 正常连接成功 =====
      this._hello = data.hello;
      this._snapshot = data.snapshot;
      this._sessionKey = data.sessionKey;
      this._userId = data.userId || null;
      this._pairingPending = false;
      this._deviceId = null;
      this._requestId = null;

      // 2. 开启 SSE 事件流
      this._setupEventSource();

      // 3. 标记就绪
      this._gatewayReady = true;
      this._connected = true;
      this._reconnectAttempts = 0;
      this._setConnected(true, 'ready');
      this._readyCallbacks.forEach((fn) => {
        try {
          fn(this._hello, this._sessionKey);
        } catch {
          /* ignore */
        }
      });
    } catch (e) {
      console.error('[api] connect error:', e);
      const errMsg = (e as Error).message;
      if (!this._intentionalClose && this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this._scheduleReconnect();
      } else {
        // 达到最大重试次数或主动断开，停止重连
        this._setConnected(false, 'error', errMsg);
        this._notifyReadyError(errMsg);
      }
    }
  }

  /** 建立 SSE 事件流 */
  private _setupEventSource(): void {
    this._closeEventSource();
    const esId = ++this._esId;
    const url = `${this._baseUrl}/api/events?sid=${encodeURIComponent(this._sid!)}`;
    const es = new EventSource(url);
    this._es = es;

    // 通用事件（Gateway 推送的消息）
    es.addEventListener('message', (evt: MessageEvent) => {
      if (esId !== this._esId) return;

      const idNum = Number(evt.lastEventId || 0);
      if (Number.isFinite(idNum) && idNum > 0) {
        if (idNum <= this._lastSseEventId) return;
        this._lastSseEventId = idNum;
      }

      let msg: GatewayMessage;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      this._eventListeners.forEach((fn) => {
        try {
          fn(msg);
        } catch (e) {
          console.error('[api] handler error:', e);
        }
      });
    });

    // proxy.ready（SSE 重连后的确认）
    es.addEventListener('proxy.ready', () => {
      if (esId !== this._esId) return;
      if (!this._gatewayReady) {
        this._gatewayReady = true;
        this._setConnected(true, 'ready');
      }
    });

    // proxy.pairing_pending（配对重试时更新配对码）
    es.addEventListener('proxy.pairing_pending', (evt: MessageEvent) => {
      if (esId !== this._esId) return;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(evt.data); } catch { /* ignore */ }
      console.log('[api] 收到配对等待通知:', data);
      this._pairingPending = true;
      this._deviceId = (data.deviceId as string) || this._deviceId;
      this._requestId = (data.requestId as string) || this._requestId;
      this._setConnected(false, 'pairing_pending');
    });

    // proxy.paired（配对成功）
    es.addEventListener('proxy.paired', (evt: MessageEvent) => {
      if (esId !== this._esId) return;
      console.log('[api] 设备配对成功！');
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(evt.data); } catch { /* ignore */ }
      this._hello = (data.hello as Record<string, unknown>) || null;
      this._snapshot = (data.snapshot as Record<string, unknown>) || null;
      this._sessionKey = (data.sessionKey as string) || null;
      this._userId = (data.userId as string) || null;
      this._pairingPending = false;
      this._deviceId = null;
      this._requestId = null;
      this._gatewayReady = true;
      this._connected = true;
      this._reconnectAttempts = 0;
      this._setConnected(true, 'ready');
      this._readyCallbacks.forEach((fn) => {
        try { fn(this._hello, this._sessionKey); } catch { /* ignore */ }
      });
    });

    // proxy.error（服务端推送错误）
    es.addEventListener('proxy.error', (evt: MessageEvent) => {
      if (esId !== this._esId) return;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(evt.data); } catch { /* ignore */ }
      const msg = (data.message as string) || '连接错误';
      console.error('[api] proxy.error:', msg);
      if (this._pairingPending) {
        this._pairingPending = false;
        this._setConnected(false, 'error', msg);
        this._notifyReadyError(msg);
      }
    });

    // proxy.disconnect（Gateway 断开）
    es.addEventListener('proxy.disconnect', () => {
      if (esId !== this._esId) return;
      this._gatewayReady = false;
      this._pairingPending = false;
      this._setConnected(false, 'disconnected');
      this._closeEventSource();
      if (!this._intentionalClose) this._scheduleReconnect();
    });

    es.onerror = () => {
      if (esId !== this._esId) return;
      if (this._pairingPending) {
        console.log('[api] SSE 断开（配对等待中），等待自动重连...');
      } else if (this._gatewayReady) {
        console.log('[api] SSE 断开，等待自动重连...');
      }
    };
  }

  /** 断开连接 */
  disconnect(): void {
    this._intentionalClose = true;
    this._clearReconnectTimer();
    this._closeEventSource();
    if (this._sid && this._baseUrl) {
      fetch(`${this._baseUrl}/api/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: this._sid }),
      }).catch(() => {});
    }
    this._sid = null;
    this._gatewayReady = false;
    this._pairingPending = false;
    this._deviceId = null;
    this._requestId = null;
    this._userId = null;
    this._setConnected(false, 'disconnected');
  }

  /** 手动触发重连 */
  reconnect(): void {
    if (!this._host || !this._token || !this._username) return;
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._clearReconnectTimer();
    this._closeEventSource();
    this._sid = null;
    this._gatewayReady = false;
    this.connect(this._host, this._token, this._username);
  }

  private _waitReady(timeoutMs = 15000): Promise<{ hello: unknown; sessionKey: string | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('等待重连超时'));
      }, timeoutMs);
      const unsub = this.onReady((hello, sessionKey, meta) => {
        clearTimeout(timer);
        unsub();
        if (meta?.error) {
          reject(new Error(meta.message || '连接失败'));
          return;
        }
        resolve({ hello, sessionKey });
      });
    });
  }

  private _recoverSession(): Promise<void> {
    if (this._sessionRecoverPromise) return this._sessionRecoverPromise;
    if (!this._host || !this._token || !this._username) return Promise.reject(new Error('未连接'));

    this._sessionRecoverPromise = (async () => {
      this.reconnect();
      await this._waitReady(15000);
    })().finally(() => {
      this._sessionRecoverPromise = null;
    });

    return this._sessionRecoverPromise;
  }

  /** 发送 RPC 请求 */
  async request(
    method: string,
    params: Record<string, unknown> = {},
    hasRetriedAfterSessionMissing = false
  ): Promise<unknown> {
    if (!this._sid || !this._gatewayReady) {
      if (!this._intentionalClose && this._reconnectAttempts > 0) {
        return new Promise((resolve, reject) => {
          const waitTimeout = setTimeout(() => {
            unsub();
            reject(new Error('等待重连超时'));
          }, 15000);
          const unsub = this.onReady(() => {
            clearTimeout(waitTimeout);
            unsub();
            this.request(method, params).then(resolve, reject);
          });
        });
      }
      throw new Error('未连接');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(`${this._baseUrl}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: this._sid, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json();
      if (!data.ok) {
        const message = data.error || '请求失败';
        const isSessionMissing =
          res.status === 404 && /会话不存在|session\s+not\s+found/i.test(message);
        if (
          isSessionMissing &&
          !hasRetriedAfterSessionMissing &&
          !this._intentionalClose &&
          this._host &&
          this._token
        ) {
          console.warn('[api] 会话不存在，尝试自动重连并重试请求:', method);
          await this._recoverSession();
          return this.request(method, params, true);
        }
        throw new Error(message);
      }
      return data.payload;
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') throw new Error('请求超时');
      throw e;
    }
  }

  // ==================== 业务方法 ====================

  chatSend(
    sessionKey: string,
    message: string,
    attachments?: Array<Record<string, unknown>>
  ): Promise<unknown> {
    const params: Record<string, unknown> = {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: uuid(),
    };
    if (attachments?.length) params.attachments = attachments;
    return this.request('chat.send', params);
  }

  chatHistory(sessionKey: string, limit = 200): Promise<unknown> {
    return this.request('chat.history', { sessionKey, limit });
  }

  chatAbort(sessionKey: string, runId?: string): Promise<unknown> {
    const params: Record<string, unknown> = { sessionKey };
    if (runId) params.runId = runId;
    return this.request('chat.abort', params);
  }

  sessionsList(limit = 50): Promise<unknown> {
    return this.request('sessions.list', { limit });
  }

  sessionsDelete(key: string): Promise<unknown> {
    return this.request('sessions.delete', { key });
  }

  sessionsReset(key: string): Promise<unknown> {
    return this.request('sessions.reset', { key });
  }

  /** 保存会话标题到服务端（跨安装持久化） */
  async saveSessionTitle(sessionKey: string, title: string): Promise<void> {
    if (!this._sid || !this._baseUrl) return;
    try {
      await fetch(`${this._baseUrl}/api/session-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: this._sid, sessionKey, title }),
      });
    } catch (e) {
      console.warn('[api] saveSessionTitle error:', e);
    }
  }

  /** 从服务端获取所有会话标题 */
  async getSessionTitles(): Promise<Record<string, string>> {
    if (!this._sid || !this._baseUrl) return {};
    try {
      const res = await fetch(`${this._baseUrl}/api/session-titles?sid=${this._sid}`);
      const data = await res.json();
      return data?.titles || {};
    } catch (e) {
      console.warn('[api] getSessionTitles error:', e);
      return {};
    }
  }

  /** 获取会话的服务端存储附件 */
  async getSessionAttachments(sessionKey: string): Promise<Array<{
    id: string;
    name: string;
    type: string;
    size: number;
    url: string;
    messageText: string;
    createdAt: number;
  }>> {
    if (!this._sid || !this._baseUrl) return [];
    try {
      const res = await fetch(
        `${this._baseUrl}/api/session-attachments?sid=${this._sid}&sessionKey=${encodeURIComponent(sessionKey)}`
      );
      const data = await res.json();
      // 将相对 URL 转为绝对 URL
      return (data?.attachments || []).map((att: Record<string, unknown>) => ({
        ...att,
        url: `${this._baseUrl}${att.url}`,
      }));
    } catch (e) {
      console.warn('[api] getSessionAttachments error:', e);
      return [];
    }
  }

  /** 保存助手消息元数据到服务端（工具调用、思维链、blocks） */
  async saveMessageMeta(
    sessionKey: string,
    messageId: string,
    meta: { toolCalls?: ToolCall[]; thinking?: string; blocks?: MessageBlock[] }
  ): Promise<void> {
    if (!this._sid || !this._baseUrl) return;
    try {
      await fetch(`${this._baseUrl}/api/message-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sid: this._sid,
          sessionKey,
          messageId,
          toolCalls: meta.toolCalls,
          thinking: meta.thinking,
          blocks: meta.blocks,
        }),
      });
    } catch (e) {
      console.warn('[api] saveMessageMeta error:', e);
    }
  }

  /** 从服务端获取会话的所有助手元数据 */
  async getSessionMeta(sessionKey: string): Promise<Array<{
    messageId: string;
    toolCalls?: ToolCall[];
    thinking?: string;
    blocks?: MessageBlock[];
  }>> {
    if (!this._sid || !this._baseUrl) return [];
    try {
      const res = await fetch(
        `${this._baseUrl}/api/message-meta?sid=${this._sid}&sessionKey=${encodeURIComponent(sessionKey)}`
      );
      const data = await res.json();
      return data?.meta || [];
    } catch (e) {
      console.warn('[api] getSessionMeta error:', e);
      return [];
    }
  }

  async downloadGeneratedFile(path: string): Promise<{ blob: Blob; fileName: string }> {
    if (!this._baseUrl || !this._token) throw new Error('未连接');

    const res = await fetch(`${this._baseUrl}/api/download-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this._token}`,
        'X-Proxy-User': this._username,
      },
      body: JSON.stringify({ path }),
    });

    if (!res.ok) {
      let message = '下载失败';
      try {
        const data = await res.json();
        message = data?.error || message;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const fallbackMatch = disposition.match(/filename="?([^"]+)"?/i);
    const fileName = utf8Match
      ? decodeURIComponent(utf8Match[1])
      : (fallbackMatch?.[1] || path.split(/[\\/]/).pop() || 'download.bin');

    return { blob, fileName };
  }

  async listFiles(sessionKey: string, path = ''): Promise<{
    rootName: string;
    currentPath: string;
    parentPath: string | null;
    entries: FileBrowserEntry[];
  }> {
    if (!this._baseUrl || !this._sid) throw new Error('未连接');
    if (!sessionKey) throw new Error('缺少 sessionKey');

    const res = await fetch(
      `${this._baseUrl}/api/files?sid=${encodeURIComponent(this._sid)}&sessionKey=${encodeURIComponent(sessionKey)}&path=${encodeURIComponent(path)}`
    );
    const data = await res.json();
    if (!res.ok || !data?.ok) throw new Error(data?.error || '加载文件列表失败');
    return {
      rootName: data.rootName || '文件',
      currentPath: data.currentPath || '',
      parentPath: data.parentPath ?? null,
      entries: data.entries || [],
    };
  }

  async downloadBrowserFile(
    sessionKey: string,
    path: string,
    options?: { archive?: boolean }
  ): Promise<{ blob: Blob; fileName: string }> {
    if (!this._baseUrl || !this._sid) throw new Error('未连接');
    if (!sessionKey) throw new Error('缺少 sessionKey');

    const res = await fetch(`${this._baseUrl}/api/files/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: this._sid, sessionKey, path, archive: !!options?.archive }),
    });

    if (!res.ok) {
      let message = '下载失败';
      try {
        const data = await res.json();
        message = data?.error || message;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const fallbackMatch = disposition.match(/filename="?([^"]+)"?/i);
    const fileName = utf8Match
      ? decodeURIComponent(utf8Match[1])
      : (fallbackMatch?.[1] || path.split(/[\\/]/).pop() || 'download.bin');

    return { blob, fileName };
  }

  buildBrowserDownloadUrl(sessionKey: string, path: string, options?: { archive?: boolean }): string {
    if (!this._baseUrl || !this._sid) throw new Error('未连接');
    if (!sessionKey) throw new Error('缺少 sessionKey');

    const query = new URLSearchParams({
      sid: this._sid,
      sessionKey,
      path,
    });
    if (options?.archive) {
      query.set('archive', '1');
    }
    return `${this._baseUrl}/api/files/download?${query.toString()}`;
  }

  // ==================== 内部辅助 ====================

  private _notifyReadyError(msg: string): void {
    this._readyCallbacks.forEach((fn) => {
      try {
        fn(null, null, { error: true, message: msg });
      } catch {
        /* ignore */
      }
    });
  }

  private _setConnected(val: boolean, status?: ConnectionStatus, errorMsg?: string): void {
    this._connected = val;
    this._onStatusChange?.(
      status || (val ? 'connected' : 'disconnected'),
      errorMsg
    );
  }

  private _closeEventSource(): void {
    if (this._es) {
      const old = this._es;
      this._es = null;
      this._esId++;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    this._clearReconnectTimer();
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._setConnected(false, 'error', `连接失败，已重试 ${MAX_RECONNECT_ATTEMPTS} 次`);
      this._notifyReadyError(`连接失败，已重试 ${MAX_RECONNECT_ATTEMPTS} 次`);
      return;
    }
    const delay =
      this._reconnectAttempts < 3
        ? 1000
        : Math.min(1000 * Math.pow(2, this._reconnectAttempts - 2), MAX_RECONNECT_DELAY);
    this._reconnectAttempts++;
    this._setConnected(false, 'reconnecting');
    this._reconnectTimer = setTimeout(() => this.connect(this._host, this._token, this._username), delay);
  }
}

// 全局单例
export const apiClient = new ApiClient();
