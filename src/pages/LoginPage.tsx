import { useState, useCallback, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiClient } from '../services/api-client';
import type { ServerConfig } from '../types';
import { useTheme } from '../hooks/useTheme';

/**
 * 登录页面 - 输入服务器地址和连接密码
 */
export default function LoginPage() {
  const { connect, connectionStatus, errorMessage } = useChatStore();
  const { theme, toggleTheme } = useTheme();

  const [host, setHost] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('clawchat-config') || '{}');
      return saved.host || '';
    } catch {
      return '';
    }
  });
  const [token, setToken] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('clawchat-config') || '{}');
      return saved.token || '';
    } catch {
      return '';
    }
  });
  const [username, setUsername] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('clawchat-config') || '{}');
      return saved.username || '';
    } catch {
      return '';
    }
  });
  const [showToken, setShowToken] = useState(false);

  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const isPairingPending = connectionStatus === 'pairing_pending';

  const handleConnect = useCallback(() => {
    if (!host.trim()) return;

    const config: ServerConfig = {
      host: host.trim().replace(/\/+$/, ''),
      token: token.trim(),
      username: username.trim() || undefined,
    };

    connect(config);
  }, [host, token, username, connect]);

  /** 停止重连 */
  const handleStopReconnect = useCallback(() => {
    apiClient.disconnect();
  }, []);

  // 自动连接（如果有保存的配置）
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('clawchat-config') || '{}');
      if (saved.host && saved.token) {
        connect(saved);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showError = connectionStatus === 'error' || connectionStatus === 'auth_failed';

  return (
    <div className="min-h-screen bg-th-base flex flex-col items-center justify-center p-6 safe-area-top safe-area-bottom">
      {/* 主题切换按钮 */}
      <button
        onClick={toggleTheme}
        className="absolute right-4 w-9 h-9 flex items-center justify-center rounded-xl bg-th-elevated text-th-text-muted hover:text-th-text transition-colors p-0 leading-none"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
        title={theme === 'dark' ? '切换为浅色' : '切换为深色'}
      >
        {theme === 'dark' ? (
          <svg className="block w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        ) : (
          <svg className="block w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        )}
      </button>

      {/* Logo */}
      <div className="mb-8 text-center">
        <img
          src="/icon-192.png"
          alt="ClawChat"
          className="w-20 h-20 mx-auto mb-4 rounded-2xl shadow-lg shadow-emerald-500/20"
        />
        <h1 className="text-2xl font-bold text-th-text">ClawChat</h1>
        <p className="text-sm text-th-text-muted mt-1">连接到 OpenClaw 服务</p>
      </div>

      {/* 表单 */}
      <div className="w-full max-w-sm space-y-4">
        {/* 服务器地址 */}
        <div>
          <label className="block text-sm text-th-text-muted mb-1.5">服务器地址</label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.100:3210"
            disabled={isConnecting || isPairingPending}
            className="w-full bg-th-input border border-th-border rounded-xl px-4 py-3 text-th-text text-sm placeholder-th-text-dim outline-none focus:border-emerald-500/50 transition-colors disabled:opacity-50"
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          />
          <p className="text-xs text-th-text-faint mt-1">
            IP 地址自动使用 http，域名自动使用 https
          </p>
        </div>

        {/* 连接密码 */}
        <div>
          <label className="block text-sm text-th-text-muted mb-1.5">连接密码</label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="server/.env 中的 PROXY_TOKEN"
              disabled={isConnecting || isPairingPending}
              className="w-full bg-th-input border border-th-border rounded-xl px-4 py-3 pr-11 text-th-text text-sm placeholder-th-text-dim outline-none focus:border-emerald-500/50 transition-colors disabled:opacity-50"
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            />
            <button
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-th-text-dim hover:text-th-text transition-colors"
            >
              {showToken ? (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* 用户名 */}
        <div>
          <label className="block text-sm text-th-text-muted mb-1.5">用户名 <span className="text-th-text-faint text-xs">(可选)</span></label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="输入你的昵称，区分不同用户"
            disabled={isConnecting || isPairingPending}
            className="w-full bg-th-input border border-th-border rounded-xl px-4 py-3 text-th-text text-sm placeholder-th-text-dim outline-none focus:border-emerald-500/50 transition-colors disabled:opacity-50"
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          />
          <p className="text-xs text-th-text-faint mt-1">
            多用户模式下用于标识身份，单用户可不填
          </p>
        </div>

        {/* 连接按钮 */}
        {isPairingPending ? null : isConnecting ? (
          <div className="space-y-2">
            <button
              disabled
              className="w-full py-3 rounded-xl bg-th-elevated text-th-text font-medium text-sm cursor-not-allowed"
            >
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {connectionStatus === 'reconnecting' ? '重连中...' : '连接中...'}
              </span>
            </button>
            <button
              onClick={handleStopReconnect}
              className="w-full py-2 rounded-xl border border-th-border text-th-text-muted hover:text-th-text hover:border-th-text-dim text-sm transition-colors"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!host.trim()}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:from-neutral-700 disabled:to-neutral-700 text-white font-medium text-sm transition-all disabled:cursor-not-allowed"
          >
            {showError ? '重试' : '连接'}
          </button>
        )}

        {/* 配对等待提示 */}
        {isPairingPending && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-4 text-amber-300 text-sm">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="font-medium">🔗 等待设备配对批准</p>
            </div>
            <p className="text-amber-400/80 text-xs mb-3 leading-relaxed">
              代理服务首次连接 OpenClaw Gateway 时需要配对批准。
              请前往 <strong>OpenClaw 控制台</strong> 的
              <strong> Nodes → Devices </strong>
              页面，找到以下设备并批准连接。
            </p>
            <div className="space-y-2">
              {apiClient.requestId && (
                <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2">
                  <p className="text-amber-400/60 text-xs mb-1">配对请求 ID:</p>
                  <p className="text-amber-300/90 text-sm font-mono break-all select-all font-bold">
                    {apiClient.requestId}
                  </p>
                </div>
              )}
              {apiClient.deviceId && (
                <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2">
                  <p className="text-amber-400/60 text-xs mb-1">设备 ID:</p>
                  <p className="text-amber-300/90 text-xs font-mono break-all select-all">
                    {apiClient.deviceId}
                  </p>
                </div>
              )}
            </div>
            <button
              onClick={handleStopReconnect}
              className="w-full mt-3 py-2 rounded-xl border border-amber-500/30 text-amber-400 hover:text-amber-200 hover:border-amber-500/50 text-xs transition-colors"
            >
              取消连接
            </button>
          </div>
        )}

        {/* 错误提示 */}
        {showError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-red-300 text-sm">
            <p className="font-medium mb-1">
              {connectionStatus === 'auth_failed' ? '🔒 认证失败' : '❌ 连接失败'}
            </p>
            <p className="text-red-400/80 text-xs">
              {errorMessage || (connectionStatus === 'auth_failed' ? '请检查连接密码是否正确' : '请检查服务器地址和网络')}
            </p>
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="text-xs text-th-text-faint mt-8 text-center space-y-1">
        <p>兼容 qingchencloud/clawapp 协议</p>
        <p>SSE+POST 架构 · Ed25519 设备签名</p>
      </div>
    </div>
  );
}
