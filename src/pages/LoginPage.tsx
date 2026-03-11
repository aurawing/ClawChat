import { useState, useCallback, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiClient } from '../services/api-client';
import type { ServerConfig } from '../types';

/**
 * 登录页面 - 输入服务器地址和连接密码
 */
export default function LoginPage() {
  const { connect, connectionStatus, errorMessage } = useChatStore();

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
  const [showToken, setShowToken] = useState(false);

  const isConnecting = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';

  const handleConnect = useCallback(() => {
    if (!host.trim()) return;

    const config: ServerConfig = {
      host: host.trim().replace(/\/+$/, ''),
      token: token.trim(),
    };

    connect(config);
  }, [host, token, connect]);

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
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-6">
      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
          <svg className="w-9 h-9 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-white">ClawChat</h1>
        <p className="text-sm text-neutral-400 mt-1">连接到 OpenClaw 服务</p>
      </div>

      {/* 表单 */}
      <div className="w-full max-w-sm space-y-4">
        {/* 服务器地址 */}
        <div>
          <label className="block text-sm text-neutral-400 mb-1.5">服务器地址</label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.100:3210"
            disabled={isConnecting}
            className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-white text-sm placeholder-neutral-500 outline-none focus:border-emerald-500/50 transition-colors disabled:opacity-50"
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
          />
          <p className="text-xs text-neutral-600 mt-1">
            IP 地址自动使用 http，域名自动使用 https
          </p>
        </div>

        {/* 连接密码 */}
        <div>
          <label className="block text-sm text-neutral-400 mb-1.5">连接密码</label>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="server/.env 中的 PROXY_TOKEN"
              disabled={isConnecting}
              className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 pr-11 text-white text-sm placeholder-neutral-500 outline-none focus:border-emerald-500/50 transition-colors disabled:opacity-50"
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            />
            <button
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
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

        {/* 连接按钮 */}
        {isConnecting ? (
          <div className="space-y-2">
            <button
              disabled
              className="w-full py-3 rounded-xl bg-neutral-700 text-white font-medium text-sm cursor-not-allowed"
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
              className="w-full py-2 rounded-xl border border-neutral-700 text-neutral-400 hover:text-white hover:border-neutral-500 text-sm transition-colors"
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
      <div className="text-xs text-neutral-600 mt-8 text-center space-y-1">
        <p>兼容 qingchencloud/clawapp 协议</p>
        <p>SSE+POST 架构 · Ed25519 设备签名</p>
      </div>
    </div>
  );
}
