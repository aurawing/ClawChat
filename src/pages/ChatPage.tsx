import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiClient } from '../services/api-client';
import MessageBubble from '../components/MessageBubble';
import ChatInput from '../components/ChatInput';
import SessionList from '../components/SessionList';
import { useTheme } from '../hooks/useTheme';
import type { ChatMessage, ContentBlock, FileAttachment, Message, MessageBlock, ServerConfig, ToolCall } from '../types';

function normalizeAssistantBlocks(message: Message): MessageBlock[] {
  if (message.blocks?.length) {
    return message.blocks.filter((block) => block.type !== 'thinking');
  }

  const blocks: MessageBlock[] = [];
  if (message.toolCalls?.length) {
    for (const tc of message.toolCalls) {
      blocks.push({ type: 'tool', toolCallId: tc.id });
    }
  }
  if (message.content.trim()) {
    blocks.push({ type: 'text', content: message.content });
  }
  return blocks;
}

function buildSegmentMessage(base: Message, index: number, blocks: MessageBlock[], toolCallMap: Map<string, ToolCall>): Message {
  const toolIds = blocks
    .filter((block) => block.type === 'tool' && block.toolCallId)
    .map((block) => block.toolCallId!);

  const text = blocks
    .filter((block) => block.type === 'text' && block.content)
    .map((block) => block.content!)
    .join('\n\n')
    .trim();

  return {
    ...base,
    id: `${base.id}::seg-${index}`,
    content: text,
    thinking: undefined,
    toolCalls: toolIds.map((id) => toolCallMap.get(id)).filter(Boolean) as ToolCall[],
    blocks,
    isStreaming: base.isStreaming && index >= 0,
  };
}

function splitAssistantMessage(message: Message): Message[] {
  if (message.role !== 'assistant') return [message];

  const sourceBlocks = normalizeAssistantBlocks(message);
  if (!sourceBlocks.length) {
    return [{ ...message, thinking: undefined }];
  }

  const toolCallMap = new Map<string, ToolCall>();
  if (message.toolCalls) {
    for (const tc of message.toolCalls) toolCallMap.set(tc.id, tc);
  }

  const segments: Message[] = [];
  let current: MessageBlock[] = [];
  let hasText = false;
  let hasTool = false;

  const flush = () => {
    if (!current.length) return;
    segments.push(buildSegmentMessage(message, segments.length, current, toolCallMap));
    current = [];
    hasText = false;
    hasTool = false;
  };

  for (const block of sourceBlocks) {
    if (block.type === 'tool') {
      if (hasText) flush();
      current.push(block);
      hasTool = true;
      continue;
    }

    if (block.type === 'text' && block.content?.trim()) {
      current.push({ ...block, content: block.content.trim() });
      hasText = true;
      if (hasTool) flush();
    }
  }

  if (current.length) {
    // 流式阶段最后一段可能只有新工具、正文尚未返回。
    // 这时先把工具挂在上一轮气泡里，等正文到达后再正式拆成新一轮，
    // 避免底部长期悬着一个孤立的工具卡。
    if (hasTool && !hasText && segments.length > 0) {
      const last = segments[segments.length - 1];
      const mergedBlocks = [...(last.blocks || []), ...current];
      segments[segments.length - 1] = buildSegmentMessage(message, segments.length - 1, mergedBlocks, toolCallMap);
    } else {
      flush();
    }
  }

  if (!segments.length) {
    return [{ ...message, thinking: undefined, blocks: undefined }];
  }

  return segments.map((segment, index) => ({
    ...segment,
    isStreaming: message.isStreaming ? index === segments.length - 1 : false,
  }));
}

function expandAssistantMessages(messages: Message[]): Message[] {
  const expanded: Message[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') {
      expanded.push(message);
      continue;
    }
    expanded.push(...splitAssistantMessage(message));
  }
  return expanded;
}

function extractThinkingContent(text: string): string {
  const matches = Array.from(text.matchAll(/<thinking>([\s\S]*?)<\/thinking>/gi))
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  return matches.join('\n\n---\n\n');
}

function stripThinkingTags(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
}

function extractContentBlockText(content: unknown): string {
  if (typeof content === 'string') return stripThinkingTags(content);
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const rec = block as unknown as Record<string, unknown>;
      return typeof rec.text === 'string' ? stripThinkingTags(rec.text) : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractTextFromHistoryMessage(msg: ChatMessage): string {
  if (typeof msg.text === 'string' && msg.text.trim()) return stripThinkingTags(msg.text);
  return extractContentBlockText(msg.content);
}

function extractToolCallId(rec: Record<string, unknown>): string | undefined {
  return (rec.tool_use_id || rec.tool_call_id || rec.toolCallId || rec.id) as string | undefined;
}

function extractToolCallName(rec: Record<string, unknown>): string {
  return ((rec.name as string) || (rec.tool_name as string) || (rec.toolName as string) || 'tool');
}

function stringifyToolPayload(payload: unknown): string | undefined {
  if (payload === undefined || payload === null || payload === '') return undefined;
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

function parseHistoryDetailMessages(history: ChatMessage[]): Message[] {
  const toolResults = new Map<string, { output: string; isError?: boolean }>();

  for (const msg of history) {
    const role = String(msg.role || '');
    if (role === 'tool' || role === 'tool_result' || role === 'toolResult') {
      const tcId = extractToolCallId(msg as unknown as Record<string, unknown>);
      const output = typeof msg.content === 'string' ? msg.content : extractContentBlockText(msg.content);
      if (tcId && output) {
        const rec = msg as unknown as Record<string, unknown>;
        toolResults.set(tcId, { output, isError: !!(rec.is_error ?? rec.isError) });
      }
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        const rec = block as unknown as Record<string, unknown>;
        if (rec.type === 'tool_result' && extractToolCallId(rec)) {
          const tcId = extractToolCallId(rec)!;
          const output = extractContentBlockText(rec.content) || (rec.output as string) || (rec.text as string) || '';
          if (output) toolResults.set(tcId, { output, isError: !!(rec.is_error ?? rec.isError) });
        }
      }
    }
  }

  const messages: Message[] = [];
  for (const msg of history) {
    const role = String(msg.role || '');
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractTextFromHistoryMessage(msg);
    let thinking: string | undefined;
    let toolCalls: ToolCall[] | undefined;
    let blocks: MessageBlock[] | undefined;

    if (role === 'assistant') {
      const parsedToolCalls: ToolCall[] = [];
      const parsedBlocks: MessageBlock[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          const rec = block as unknown as Record<string, unknown>;
          if (rec.type === 'thinking' && typeof rec.thinking === 'string') {
            parsedBlocks.push({ type: 'thinking', content: rec.thinking as string });
          } else if (rec.type === 'text' && typeof rec.text === 'string') {
            const thk = extractThinkingContent(rec.text as string);
            const clean = stripThinkingTags(rec.text as string);
            if (thk) parsedBlocks.push({ type: 'thinking', content: thk });
            if (clean) parsedBlocks.push({ type: 'text', content: clean });
          } else if ((rec.type === 'tool_use' || rec.type === 'toolCall') && extractToolCallId(rec)) {
            const tcId = extractToolCallId(rec)!;
            const result = toolResults.get(tcId);
            parsedToolCalls.push({
              id: tcId,
              name: extractToolCallName(rec),
              status: result ? (result.isError ? 'error' : 'done') : 'done',
              input: stringifyToolPayload(rec.input ?? rec.arguments ?? rec.params),
              output: result?.output,
              startedAt: msg.timestamp || Date.now(),
              finishedAt: result ? (msg.timestamp || Date.now()) : undefined,
            });
            parsedBlocks.push({ type: 'tool', toolCallId: tcId });
          }
        }
      } else if (typeof msg.content === 'string') {
        const thk = extractThinkingContent(msg.content);
        if (thk) parsedBlocks.push({ type: 'thinking', content: thk });
      }

      if (parsedToolCalls.length) toolCalls = parsedToolCalls;
      if (parsedBlocks.length) blocks = parsedBlocks;

      const taggedThinking = typeof msg.content === 'string' ? extractThinkingContent(msg.content) : '';
      if (taggedThinking) thinking = taggedThinking;
      if (!thinking && blocks?.length) {
        const thinkingBlocks = blocks.filter((block) => block.type === 'thinking' && block.content).map((block) => block.content!);
        if (thinkingBlocks.length) thinking = thinkingBlocks.join('\n\n---\n\n');
      }
      if (!blocks && (toolCalls?.length || thinking)) {
        const fallback: MessageBlock[] = [];
        if (thinking) fallback.push({ type: 'thinking', content: thinking });
        if (toolCalls?.length) {
          fallback.push(...toolCalls.map((tc): MessageBlock => ({ type: 'tool', toolCallId: tc.id })));
        }
        if (text) fallback.push({ type: 'text', content: text });
        blocks = fallback;
      } else if (blocks && text && !blocks.some((block) => block.type === 'text' && block.content?.trim())) {
        blocks = [...blocks, { type: 'text', content: text }];
      }
    }

    if (!text && !thinking && !toolCalls?.length && !blocks?.length) continue;

    messages.push({
      id: (msg.id as string) || `history-${messages.length}-${Date.now()}`,
      sessionKey: '',
      role: role === 'assistant' ? 'assistant' : 'user',
      content: text,
      thinking,
      toolCalls,
      blocks,
      createdAt: msg.timestamp || Date.now(),
      isStreaming: false,
    });
  }

  return messages;
}

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
    currentAiThinking,
    currentAiMessageId,
    toolCards,
    currentBlocks,
    _blockThinkingBase,
    _blockTextBase,
    connectionStatus,
    serverConfig,
    username,
    lastAbortedUserMsgId,
    sendMessage,
    stopGenerating,
    switchSession,
    createNewSession,
    loadSessions,
    deleteSession,
    resendLastMessage,
    deleteLastUserMessage,
    disconnect,
    connect,
  } = useChatStore();

  const { theme, toggleTheme } = useTheme();
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistoryDetail, setShowHistoryDetail] = useState(false);
  const [historyDetailMessages, setHistoryDetailMessages] = useState<Message[]>([]);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyDetailError, setHistoryDetailError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserNearBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);

  // 检测用户是否在底部附近（80px 阈值）
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 80;
    isUserNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // 自动滚动到底部 — 仅当用户在底部时触发，使用 rAF 避免抖动
  useEffect(() => {
    if (!isUserNearBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      scrollRafRef.current = null;
    });
  }, [
    messages.length,
    currentAiText,
    currentAiThinking,
    isStreaming,
    currentBlocks.length,
    toolCards.size,
    currentAiMessageId,
  ]);

  // 切换会话时强制滚到底部
  useEffect(() => {
    isUserNearBottomRef.current = true;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [currentSessionKey]);

  // 主题切换时更新原生 StatusBar
  useEffect(() => {
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform()) return;
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        const isDark = theme === 'dark';
        await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
        await StatusBar.setBackgroundColor({ color: isDark ? '#0a0a0a' : '#ffffff' });
      } catch { /* ignore */ }
    })();
  }, [theme]);

  useEffect(() => {
    if (!showHistoryDetail || !currentSessionKey || !apiClient.gatewayReady) return;
    let cancelled = false;

    setHistoryDetailLoading(true);
    setHistoryDetailError(null);

    apiClient.chatHistory(currentSessionKey)
      .then((result) => {
        if (cancelled) return;
        const parsed = parseHistoryDetailMessages(((result as { messages?: ChatMessage[] })?.messages) || []);
        setHistoryDetailMessages(parsed.map((msg) => ({ ...msg, sessionKey: currentSessionKey })));
      })
      .catch((e) => {
        if (cancelled) return;
        setHistoryDetailError((e as Error).message || '加载历史详情失败');
      })
      .finally(() => {
        if (!cancelled) setHistoryDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showHistoryDetail, currentSessionKey]);

  const handleSend = useCallback(
    (content: string, attachments?: FileAttachment[]) => {
      sendMessage(content, attachments);
    },
    [sendMessage]
  );

  // 构造显示用的消息列表
  const displayMessages = [...messages];
  const hasToolCards = toolCards.size > 0;

  const liveBlocks = (() => {
    if (!currentBlocks.length && !currentAiThinking && !currentAiText) return undefined;
    const blocks = [...currentBlocks];
    // 补全当前 thinking 段
    if (currentAiThinking.length > _blockThinkingBase) {
      const seg = currentAiThinking.substring(_blockThinkingBase);
      if (blocks.length > 0 && blocks[blocks.length - 1].type === 'thinking') {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], content: seg };
      } else {
        blocks.push({ type: 'thinking', content: seg });
      }
    }
    // 补全当前 text 段（工具调用后的文本或流式增长文本）
    if (currentAiText.length > _blockTextBase) {
      const textSeg = currentAiText.substring(_blockTextBase).trim();
      if (textSeg) {
        blocks.push({ type: 'text', content: textSeg });
      }
    }
    return blocks.length > 0 ? blocks : undefined;
  })();

  if (currentAiText || hasToolCards || currentAiThinking) {
    const msgId = currentAiMessageId || 'ai-streaming';
    const existing = displayMessages.find((m) => m.id === msgId);
    if (!existing) {
      const streamingMsg: Message = {
        id: msgId,
        sessionKey: currentSessionKey || '',
        role: 'assistant',
        content: currentAiText || '',
        thinking: currentAiThinking || undefined,
        toolCalls: Array.from(toolCards.values()),
        blocks: liveBlocks,
        createdAt: Date.now(),
        isStreaming: true,
      };
      displayMessages.push(streamingMsg);
    } else {
      const idx = displayMessages.indexOf(existing);
      displayMessages[idx] = {
        ...existing,
        toolCalls: Array.from(toolCards.values()),
        thinking: currentAiThinking || existing.thinking,
        blocks: liveBlocks || existing.blocks,
        content: currentAiText || existing.content,
        isStreaming: true,
      };
    }
  }

  const renderedMessages = useMemo(() => expandAssistantMessages(displayMessages), [displayMessages]);

  const showThinkingPlaceholder = isStreaming && !currentAiText && !hasToolCards && !currentAiThinking;

  const currentSession = sessions.find((s) => s.key === currentSessionKey);
  const currentTitle = currentSession?.title || (currentSessionKey ? extractTitle(currentSessionKey) : 'ClawChat');

  return (
    <div className="h-screen flex bg-th-base">
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
          username={username}
          onSelectSession={(key) => {
            switchSession(key);
            setShowSidebar(false);
          }}
          onDeleteSession={deleteSession}
          onNewSession={() => {
            createNewSession();
            setShowSidebar(false);
          }}
          onRefresh={loadSessions}
          onClose={() => setShowSidebar(false)}
          onDisconnect={disconnect}
        />
      </div>

      {/* 主聊天区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <div className="flex items-center px-4 py-3 border-b border-th-border-subtle bg-th-base/80 backdrop-blur-sm safe-area-top">
          {/* 菜单按钮 */}
          <button
            onClick={() => setShowSidebar(true)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted mr-3 lg:hidden"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* 标题 */}
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-medium text-th-text truncate">
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
              <span className="text-xs text-th-text-dim">
                {connectionStatus === 'ready' || connectionStatus === 'connected'
                  ? (username ? `${username} · 已连接` : '已连接')
                  : connectionStatus === 'connecting' || connectionStatus === 'reconnecting'
                  ? '连接中...'
                  : '未连接'}
              </span>
            </div>
          </div>

          {/* 右侧按钮 */}
          <div className="flex items-center gap-1">
            {/* 新建会话 */}
            <button
              onClick={createNewSession}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-emerald-400"
              title="新建对话"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
            {/* 主题切换 */}
            <button
              onClick={toggleTheme}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted"
              title={theme === 'dark' ? '切换为浅色' : '切换为深色'}
            >
              {theme === 'dark' ? (
                <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            {/* 设置 */}
            <button
              onClick={() => setShowSettings(true)}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted"
              title="连接设置"
            >
              <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={() => setShowHistoryDetail(true)}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted"
              title="历史详情"
            >
              <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17h6M9 13h6M9 9h6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
              </svg>
            </button>
          </div>
        </div>

        {/* 消息区域 */}
        <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4">
          {displayMessages.length === 0 && !showThinkingPlaceholder ? (
            <EmptyState />
          ) : (
            <>
              {renderedMessages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              {showThinkingPlaceholder && <ThinkingPlaceholder />}

              {/* 中止后的操作按钮 */}
              {lastAbortedUserMsgId && !isStreaming && (
                <AbortedActions
                  onResend={resendLastMessage}
                  onDelete={deleteLastUserMessage}
                />
              )}

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

      {/* 设置面板 */}
      {showSettings && (
        <SettingsModal
          currentConfig={serverConfig}
          onSave={(config) => {
            setShowSettings(false);
            disconnect();
            setTimeout(() => connect(config), 100);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showHistoryDetail && (
        <HistoryDetailModal
          title={currentTitle}
          messages={historyDetailMessages}
          loading={historyDetailLoading}
          error={historyDetailError}
          onClose={() => setShowHistoryDetail(false)}
        />
      )}
    </div>
  );
}

// ===== 子组件 =====

/** 连接设置弹窗 */
function SettingsModal({
  currentConfig,
  onSave,
  onClose,
}: {
  currentConfig: ServerConfig | null;
  onSave: (config: ServerConfig) => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState(currentConfig?.host || '');
  const [token, setToken] = useState(currentConfig?.token || '');
  const [username, setUsername] = useState(currentConfig?.username || '');
  const [showToken, setShowToken] = useState(false);

  const handleSave = () => {
    if (!host.trim()) return;
    const config: ServerConfig = {
      host: host.trim().replace(/\/+$/, ''),
      token: token.trim(),
      username: username.trim() || undefined,
    };
    localStorage.setItem('clawchat-config', JSON.stringify(config));
    onSave(config);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* 弹窗 */}
      <div className="relative bg-th-surface border border-th-border rounded-2xl w-full max-w-sm shadow-2xl animate-fadeIn">
        {/* 标题 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-th-border-subtle">
          <h3 className="text-base font-semibold text-th-text">连接设置</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-th-elevated text-th-text-muted hover:text-th-text transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 表单 */}
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm text-th-text-muted mb-1.5">服务器地址</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100:3210"
              className="w-full bg-th-input border border-th-border rounded-xl px-4 py-2.5 text-th-text text-sm placeholder-th-text-dim outline-none focus:border-emerald-500/50 transition-colors"
            />
            <p className="text-xs text-th-text-faint mt-1">IP 自动 http，域名自动 https</p>
          </div>

          <div>
            <label className="block text-sm text-th-text-muted mb-1.5">连接密码</label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="PROXY_TOKEN"
                className="w-full bg-th-input border border-th-border rounded-xl px-4 py-2.5 pr-11 text-th-text text-sm placeholder-th-text-dim outline-none focus:border-emerald-500/50 transition-colors"
              />
              <button
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-th-text-dim hover:text-th-text transition-colors"
              >
                {showToken ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-th-text-muted mb-1.5">
              用户名 <span className="text-th-text-faint text-xs">(可选)</span>
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="昵称，区分不同用户"
              className="w-full bg-th-input border border-th-border rounded-xl px-4 py-2.5 text-th-text text-sm placeholder-th-text-dim outline-none focus:border-emerald-500/50 transition-colors"
            />
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3 px-5 py-4 border-t border-th-border-subtle">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-th-border text-th-text-secondary text-sm hover:bg-th-elevated transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={!host.trim()}
            className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:from-neutral-700 disabled:to-neutral-700 text-white text-sm font-medium transition-all disabled:cursor-not-allowed"
          >
            保存并重连
          </button>
        </div>
      </div>
    </div>
  );
}

function extractTitle(key: string): string {
  const parts = key.split(':');
  if (parts.length >= 3) {
    const agent = parts[1];
    const channel = parts.slice(2).join(':');

    let label: string;
    if (/^clawchat-[^-]+$/.test(channel)) {
      label = '主对话';
    } else if (/^clawchat-.+-.+$/.test(channel)) {
      label = '新对话';
    } else if (channel === 'main') {
      label = '主对话';
    } else {
      label = channel;
    }

    if (label.length > 20) label = label.substring(0, 20) + '…';
    if (agent !== 'main') label = `[${agent}] ${label}`;
    return label;
  }
  return 'ClawChat';
}

/** 中止后操作按钮 */
function AbortedActions({ onResend, onDelete }: { onResend: () => void; onDelete: () => void }) {
  return (
    <div className="flex justify-center gap-3 my-3 animate-fadeIn">
      <button
        onClick={onResend}
        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-600/30 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        重新发送
      </button>
      <button
        onClick={onDelete}
        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-xs hover:bg-red-500/20 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        删除消息
      </button>
    </div>
  );
}

/** AI 思考中占位符 */
function ThinkingPlaceholder() {
  return (
    <div className="flex justify-start mb-4">
      <div className="w-7 h-7 rounded-full mr-2 mt-1 shrink-0 overflow-hidden">
        <img src="/icon-192.png" alt="AI" className="w-full h-full object-cover" />
      </div>
      <div className="bg-th-elevated/60 rounded-2xl rounded-tl-md px-4 py-3 min-w-[150px]">
        <div className="flex items-center gap-2 text-sm text-th-text-muted">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>正在思考</span>
        </div>
        <div className="mt-2 h-1.5 w-24 rounded-full bg-th-border-subtle overflow-hidden">
          <div className="h-full w-1/2 rounded-full bg-emerald-400/70 animate-pulse" />
        </div>
      </div>
    </div>
  );
}

function HistoryDetailModal({
  title,
  messages,
  loading,
  error,
  onClose,
}: {
  title: string;
  messages: Message[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-th-base">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-th-border-subtle bg-th-base/95 backdrop-blur-sm safe-area-top">
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted"
          title="关闭"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-th-text truncate">{title}</h2>
          <p className="text-xs text-th-text-dim">历史详情（仅来自 chat.history）</p>
        </div>
      </div>

      <div
        className="overflow-y-auto px-4 py-4"
        style={{ height: 'calc(100vh - env(safe-area-inset-top, 0px) - 57px)' }}
      >
        {loading ? (
          <div className="text-sm text-th-text-muted">正在加载历史详情...</div>
        ) : error ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : messages.length === 0 ? (
          <div className="text-sm text-th-text-muted">历史记录为空</div>
        ) : (
          messages.map((msg) => <MessageBubble key={`detail-${msg.id}`} message={msg} />)
        )}
      </div>
    </div>
  );
}

/** 空状态提示 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="w-16 h-16 rounded-2xl overflow-hidden mb-4">
        <img src="/icon-192.png" alt="ClawChat" className="w-full h-full object-cover" />
      </div>
      <h2 className="text-lg font-semibold text-th-text mb-2">欢迎使用 ClawChat</h2>
      <p className="text-sm text-th-text-muted mb-6 max-w-xs">
        已连接 OpenClaw 智能体，发送消息开始对话。支持流式输出、工具调用、文件上传。
      </p>
    </div>
  );
}
