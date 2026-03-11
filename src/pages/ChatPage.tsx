import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../stores/chatStore';
import MessageBubble from '../components/MessageBubble';
import ChatInput from '../components/ChatInput';
import SessionList from '../components/SessionList';
import type { FileAttachment, Message } from '../types';

/**
 * 聊天主页面
 */
export default function ChatPage() {
  const {
    messages,
    sessions,
    currentSessionKey,
    isStreaming,
    currentAiText,
    currentAiMessageId,
    toolCards,
    connectionStatus,
    sendMessage,
    stopGenerating,
    switchSession,
    loadSessions,
    deleteSession,
    disconnect,
  } = useChatStore();

  const [showSidebar, setShowSidebar] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, currentAiText]);

  const handleSend = useCallback(
    (content: string, attachments?: FileAttachment[]) => {
      sendMessage(content, attachments);
    },
    [sendMessage]
  );

  // 构造显示用的消息列表（包含流式中的 AI 消息）
  const displayMessages = [...messages];
  if (currentAiText && currentAiMessageId) {
    // 检查是否已有这个消息
    const existing = displayMessages.find((m) => m.id === currentAiMessageId);
    if (!existing) {
      const streamingMsg: Message = {
        id: currentAiMessageId,
        sessionKey: currentSessionKey || '',
        role: 'assistant',
        content: currentAiText,
        toolCalls: Array.from(toolCards.values()),
        createdAt: Date.now(),
        isStreaming: true,
      };
      displayMessages.push(streamingMsg);
    }
  }

  // 从 sessionKey 中提取当前会话标题
  const currentTitle = currentSessionKey
    ? extractTitle(currentSessionKey)
    : 'ClawChat';

  return (
    <div className="h-screen flex bg-neutral-950">
      {/* 侧边栏遮罩 */}
      {showSidebar && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setShowSidebar(false)}
        />
      )}

      {/* 侧边栏 */}
      <div
        className={`fixed lg:relative inset-y-0 left-0 z-40 w-72 transition-transform duration-300 lg:translate-x-0 ${
          showSidebar ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <SessionList
          sessions={sessions}
          currentSessionKey={currentSessionKey}
          onSelectSession={(key) => {
            switchSession(key);
            setShowSidebar(false);
          }}
          onDeleteSession={deleteSession}
          onRefresh={loadSessions}
          onClose={() => setShowSidebar(false)}
        />
      </div>

      {/* 主聊天区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <div className="flex items-center px-4 py-3 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm safe-area-top">
          {/* 菜单按钮 */}
          <button
            onClick={() => setShowSidebar(true)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 transition-colors text-neutral-400 mr-3 lg:hidden"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* 标题 */}
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-medium text-white truncate">
              {currentTitle}
            </h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  connectionStatus === 'ready' || connectionStatus === 'connected'
                    ? 'bg-emerald-500'
                    : connectionStatus === 'connecting' || connectionStatus === 'reconnecting'
                    ? 'bg-amber-500 animate-pulse'
                    : 'bg-red-500'
                }`}
              />
              <span className="text-xs text-neutral-500">
                {connectionStatus === 'ready' || connectionStatus === 'connected'
                  ? '已连接'
                  : connectionStatus === 'connecting' || connectionStatus === 'reconnecting'
                  ? '连接中...'
                  : '未连接'}
              </span>
            </div>
          </div>

          {/* 右侧按钮 */}
          <div className="flex items-center gap-2">
            {/* 断开连接 */}
            <button
              onClick={disconnect}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 transition-colors text-neutral-400"
              title="断开连接"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {displayMessages.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {displayMessages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* 输入区域 */}
        <ChatInput
          onSend={handleSend}
          onStop={stopGenerating}
          isGenerating={isStreaming}
          disabled={connectionStatus !== 'ready' && connectionStatus !== 'connected'}
        />
      </div>
    </div>
  );
}

function extractTitle(key: string): string {
  const parts = key.split(':');
  if (parts.length >= 3) {
    const agent = parts[1];
    const channel = parts.slice(2).join(':');
    let label = channel === 'main' ? '主对话' : channel;
    if (label.length > 20) label = label.substring(0, 20) + '…';
    if (agent !== 'main') label = `[${agent}] ${label}`;
    return label;
  }
  return 'ClawChat';
}

/** 空状态提示 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-teal-600/20 flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-white mb-2">欢迎使用 ClawChat</h2>
      <p className="text-sm text-neutral-400 mb-6 max-w-xs">
        已连接 OpenClaw 智能体，发送消息开始对话。支持流式输出、工具调用、文件上传。
      </p>
    </div>
  );
}
