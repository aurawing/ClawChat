/**
 * SSE + HTTP POST 客户端 - 对接 ClawChat 代理服务端
 * 兼容 qingchencloud/clawapp 协议
 *
 * 架构：手机 ←SSE+POST→ 代理服务端 ←WS→ OpenClaw Gateway
 */

import type { ConnectionStatus, GatewayMessage } from '../types';

const REQUEST_TIMEOUT = 30000;
const MAX_RECONNECT_DELAY = 30000;

/** 推断 baseUrl 协议 */
function resolveBaseUrl(host: string): string {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '');
  const hostOnly = host.split(':')[0];
  const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostOnly);
  const isLocal = hostOnly === 'localhost' || hostOnly === '127.0.0.1';
  const protocol = isIP || isLocal ? 'http' : 'https';
  return `${protocol}://${host}`;
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
  private _baseUrl = '';
  private _sid: string | null = null;
  private _es: EventSource | null = null;
  private _connected = false;
  private _gatewayReady = false;
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
  async connect(host: string, token: string): Promise<void> {
    this._host = host;
    this._token = token;
    this._baseUrl = resolveBaseUrl(host);
    this._intentionalClose = false;
    this._setConnected(false, 'connecting');

    try {
      // 1. POST /api/connect 建立会话
      const res = await fetch(`${this._baseUrl}/api/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
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
          this._readyCallbacks.forEach((fn) => {
            try {
              fn(null, null, { error: true, message: msg });
            } catch (_e) {
              /* ignore */
            }
          });
          return;
        }
        if (res.status === 502) {
          this._setConnected(false, 'error', msg);
          return;
        }
        throw new Error(msg);
      }

      this._sid = data.sid;
      this._hello = data.hello;
      this._snapshot = data.snapshot;
      this._sessionKey = data.sessionKey;
      this._lastSseEventId = 0;

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
        } catch (_e) {
          /* ignore */
        }
      });
    } catch (e) {
      console.error('[api] connect error:', e);
      this._setConnected(false, 'error', (e as Error).message);
      if (!this._intentionalClose) this._scheduleReconnect();
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

    // proxy.disconnect（Gateway 断开）
    es.addEventListener('proxy.disconnect', () => {
      if (esId !== this._esId) return;
      this._gatewayReady = false;
      this._setConnected(false, 'disconnected');
      this._closeEventSource();
      if (!this._intentionalClose) this._scheduleReconnect();
    });

    es.onerror = () => {
      if (esId !== this._esId) return;
      if (this._gatewayReady) {
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
    this._setConnected(false, 'disconnected');
  }

  /** 手动触发重连 */
  reconnect(): void {
    if (!this._host || !this._token) return;
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._clearReconnectTimer();
    this._closeEventSource();
    this._sid = null;
    this._gatewayReady = false;
    this.connect(this._host, this._token);
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
    if (!this._host || !this._token) return Promise.reject(new Error('未连接'));

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

  // ==================== 内部辅助 ====================

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
    const delay =
      this._reconnectAttempts < 3
        ? 1000
        : Math.min(1000 * Math.pow(2, this._reconnectAttempts - 2), MAX_RECONNECT_DELAY);
    this._reconnectAttempts++;
    this._setConnected(false, 'reconnecting');
    this._reconnectTimer = setTimeout(() => this.connect(this._host, this._token), delay);
  }
}

// 全局单例
export const apiClient = new ApiClient();
