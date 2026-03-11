import { create } from 'zustand';
import { apiClient, uuid } from '../services/api-client';
import type {
  Message,
  Session,
  ToolCall,
  ConnectionStatus,
  ServerConfig,
  FileAttachment,
  GatewayMessage,
  GatewayEvent,
  ChatEventPayload,
  AgentEventPayload,
  ContentBlock,
  ChatMessage,
} from '../types';
import * as db from '../services/db';

// ==================== 辅助函数 ====================

/** 去除思维链标签 */
function stripThinkingTags(text: string): string {
  return text
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
    .replace(
      /Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
      ''
    )
    .replace(/\[Queued messages while agent was busy\]\s*---\s*Queued #\d+\s*/gi, '')
    .trim();
}

/** 从 Gateway 消息中提取文本内容 */
function extractText(message?: ChatMessage): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return stripThinkingTags(content);
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
    return texts.length ? stripThinkingTags(texts.join('\n')) : '';
  }
  if (typeof message.text === 'string') return stripThinkingTags(message.text);
  return '';
}

// ==================== Store 类型 ====================

interface ChatState {
  // 连接状态
  connectionStatus: ConnectionStatus;
  serverConfig: ServerConfig | null;
  errorMessage: string | null;

  // 会话
  sessions: Session[];
  currentSessionKey: string | null;

  // 消息
  messages: Message[];

  // 流式状态
  isStreaming: boolean;
  currentRunId: string | null;
  currentAiText: string;
  currentAiMessageId: string | null;

  // 工具调用
  toolCards: Map<string, ToolCall>;

  // Actions
  connect: (config: ServerConfig) => void;
  disconnect: () => void;
  sendMessage: (content: string, attachments?: FileAttachment[]) => Promise<void>;
  stopGenerating: () => void;
  switchSession: (key: string) => void;
  loadHistory: () => Promise<void>;
  loadSessions: () => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  resetSession: (key: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => {
  // ==================== 事件处理 ====================

  /** 处理 chat 事件 */
  function handleChatEvent(payload: ChatEventPayload) {
    const state = get();
    // 过滤非当前会话
    if (payload.sessionKey && payload.sessionKey !== state.currentSessionKey && state.currentSessionKey) {
      return;
    }

    const { state: chatState } = payload;

    if (chatState === 'delta') {
      const text = extractText(payload.message);
      const currentText = state.currentAiText;
      if (text && text.length > currentText.length) {
        const msgId = state.currentAiMessageId || `ai-${uuid()}`;
        set({
          isStreaming: true,
          currentAiText: text,
          currentAiMessageId: msgId,
          currentRunId: payload.runId || state.currentRunId,
        });
      }
      return;
    }

    if (chatState === 'final') {
      const text = extractText(payload.message);
      const currentText = state.currentAiText;

      // 忽略空 final
      if (!state.currentAiMessageId && !text) return;

      const msgId = state.currentAiMessageId || `ai-${uuid()}`;
      const finalText = text || currentText;

      if (finalText) {
        // 创建最终消息
        const aiMsg: Message = {
          id: msgId,
          sessionKey: state.currentSessionKey || '',
          role: 'assistant',
          content: finalText,
          toolCalls: Array.from(state.toolCards.values()),
          createdAt: Date.now(),
          isStreaming: false,
        };

        set((s) => ({
          messages: [
            ...s.messages.filter((m) => m.id !== msgId),
            aiMsg,
          ],
          isStreaming: false,
          currentAiText: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
        }));

        // 持久化
        db.saveMessage(aiMsg);
      } else {
        set({
          isStreaming: false,
          currentAiText: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
        });
      }
      return;
    }

    if (chatState === 'aborted') {
      const currentText = state.currentAiText;
      if (currentText && state.currentAiMessageId) {
        const aiMsg: Message = {
          id: state.currentAiMessageId,
          sessionKey: state.currentSessionKey || '',
          role: 'assistant',
          content: currentText + '\n\n[已中止]',
          createdAt: Date.now(),
          isStreaming: false,
        };
        set((s) => ({
          messages: [...s.messages.filter((m) => m.id !== state.currentAiMessageId), aiMsg],
          isStreaming: false,
          currentAiText: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
        }));
      } else {
        set({
          isStreaming: false,
          currentAiText: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
        });
      }
      return;
    }

    if (chatState === 'error') {
      const errMsg = payload.errorMessage || '未知错误';
      const errorMessage: Message = {
        id: `err-${uuid()}`,
        sessionKey: state.currentSessionKey || '',
        role: 'system',
        content: `错误: ${errMsg}`,
        createdAt: Date.now(),
      };
      set((s) => ({
        messages: [...s.messages, errorMessage],
        isStreaming: false,
        currentAiText: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
      }));
      return;
    }
  }

  /** 处理 agent 事件 */
  function handleAgentEvent(payload: AgentEventPayload) {
    const state = get();
    if (payload.sessionKey && payload.sessionKey !== state.currentSessionKey) return;

    const { stream, data } = payload;

    if (stream === 'lifecycle') {
      if (data?.phase === 'start') {
        set({
          isStreaming: true,
          currentRunId: payload.runId || null,
        });
      }
      if (data?.phase === 'end') {
        set({ isStreaming: false });
      }
      return;
    }

    // assistant 流 — 高频文本累积
    if (stream === 'assistant') {
      const text = data?.text;
      if (text && typeof text === 'string') {
        const cleaned = stripThinkingTags(text as string);
        const currentText = state.currentAiText;
        if (cleaned && cleaned.length > currentText.length) {
          const msgId = state.currentAiMessageId || `ai-${uuid()}`;
          set({
            currentAiText: cleaned,
            currentAiMessageId: msgId,
            currentRunId: payload.runId || state.currentRunId,
          });
        }
      }
      return;
    }

    // tool 流
    if (stream === 'tool') {
      const toolCallId = data?.toolCallId;
      if (!toolCallId) return;
      const name = (data?.name as string) || 'tool';
      const phase = (data?.phase as string) || '';

      set((s) => {
        const toolCards = new Map(s.toolCards);
        if (!toolCards.has(toolCallId as string)) {
          toolCards.set(toolCallId as string, {
            id: toolCallId as string,
            name,
            status: phase === 'start' ? 'running' : 'done',
          });
        } else {
          const existing = toolCards.get(toolCallId as string)!;
          if (phase === 'result' || phase === 'error') {
            toolCards.set(toolCallId as string, {
              ...existing,
              status: phase === 'error' ? 'error' : 'done',
            });
          }
        }
        return { toolCards };
      });
      return;
    }
  }

  /** 主事件分发 */
  function handleEvent(msg: GatewayMessage) {
    if (msg.type !== 'event') return;
    const evt = msg as GatewayEvent;
    const { event, payload } = evt;

    if (event === 'chat') {
      handleChatEvent(payload as unknown as ChatEventPayload);
    } else if (event === 'agent') {
      handleAgentEvent(payload as unknown as AgentEventPayload);
    }
  }

  // 注册事件监听
  apiClient.onEvent(handleEvent);

  // 连接状态
  apiClient.onStatusChange((status, errorMsg) => {
    set({ connectionStatus: status, errorMessage: errorMsg || null });
  });

  return {
    // 初始状态
    connectionStatus: 'disconnected' as ConnectionStatus,
    serverConfig: null,
    errorMessage: null,
    sessions: [],
    currentSessionKey: null,
    messages: [],
    isStreaming: false,
    currentRunId: null,
    currentAiText: '',
    currentAiMessageId: null,
    toolCards: new Map(),

    connect: (config: ServerConfig) => {
      set({ serverConfig: config, errorMessage: null });

      // 注册一次性 ready 回调
      const unsub = apiClient.onReady((hello, sessionKey, meta) => {
        unsub();
        if (meta?.error) {
          set({ errorMessage: meta.message || '连接失败' });
          return;
        }
        set({ currentSessionKey: sessionKey });

        // 保存配置
        localStorage.setItem('clawchat-config', JSON.stringify(config));

        // 加载历史和会话列表
        get().loadHistory();
        get().loadSessions();
      });

      apiClient.connect(config.host, config.token);
    },

    disconnect: () => {
      apiClient.disconnect();
      set({
        connectionStatus: 'disconnected',
        serverConfig: null,
        currentSessionKey: null,
        messages: [],
        sessions: [],
        isStreaming: false,
        currentAiText: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
      });
    },

    sendMessage: async (content: string, attachments?: FileAttachment[]) => {
      const state = get();
      const sessionKey = state.currentSessionKey;
      if (!sessionKey) return;

      // 创建用户消息
      const userMsg: Message = {
        id: `user-${uuid()}`,
        sessionKey,
        role: 'user',
        content,
        attachments,
        createdAt: Date.now(),
      };
      set((s) => ({ messages: [...s.messages, userMsg], isStreaming: true }));
      db.saveMessage(userMsg);

      // 构造 Gateway 附件格式
      const gatewayAttachments = attachments?.map((att) => ({
        content: att.base64 || '',
        mimeType: att.type,
        fileName: att.name,
        category: att.type.startsWith('image/') ? 'image' : 'file',
      }));

      try {
        await apiClient.chatSend(sessionKey, content, gatewayAttachments);
      } catch (err) {
        const errMsg: Message = {
          id: `err-${uuid()}`,
          sessionKey,
          role: 'system',
          content: `发送失败: ${(err as Error).message}`,
          createdAt: Date.now(),
        };
        set((s) => ({
          messages: [...s.messages, errMsg],
          isStreaming: false,
        }));
      }
    },

    stopGenerating: () => {
      const state = get();
      if (state.currentSessionKey) {
        apiClient
          .chatAbort(state.currentSessionKey, state.currentRunId || undefined)
          .catch(() => {});
      }
    },

    switchSession: (key: string) => {
      set({
        currentSessionKey: key,
        messages: [],
        isStreaming: false,
        currentAiText: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
      });
      localStorage.setItem('clawchat-session-key', key);
      get().loadHistory();
    },

    loadHistory: async () => {
      const state = get();
      const sessionKey = state.currentSessionKey;
      if (!sessionKey || !apiClient.gatewayReady) return;

      try {
        const result = (await apiClient.chatHistory(sessionKey)) as {
          messages?: ChatMessage[];
        };
        if (!result?.messages?.length) return;

        const messages: Message[] = [];
        for (const msg of result.messages) {
          if ((msg.role as string) === 'toolResult') continue;
          const text = extractText(msg);
          if (!text) continue;
          messages.push({
            id: (msg.id as string) || uuid(),
            sessionKey,
            role: msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system',
            content: text,
            createdAt: msg.timestamp || Date.now(),
          });
        }

        set({ messages });
      } catch (e) {
        console.error('[store] loadHistory error:', e);
      }
    },

    loadSessions: async () => {
      if (!apiClient.gatewayReady) return;

      try {
        const result = (await apiClient.sessionsList()) as {
          sessions?: Array<{
            key: string;
            title?: string;
            lastMessage?: string;
            updatedAt?: number;
          }>;
        };
        if (!result?.sessions) return;

        const sessions: Session[] = result.sessions.map((s) => ({
          key: s.key,
          title: s.title || extractSessionTitle(s.key),
          lastMessage: s.lastMessage,
          updatedAt: s.updatedAt || Date.now(),
        }));

        set({ sessions });
      } catch (e) {
        console.error('[store] loadSessions error:', e);
      }
    },

    deleteSession: async (key: string) => {
      try {
        await apiClient.sessionsDelete(key);
        set((s) => {
          const sessions = s.sessions.filter((sess) => sess.key !== key);
          const needSwitch = s.currentSessionKey === key;
          return {
            sessions,
            currentSessionKey: needSwitch
              ? sessions[0]?.key || apiClient.sessionKey
              : s.currentSessionKey,
            messages: needSwitch ? [] : s.messages,
          };
        });
        if (get().currentSessionKey) {
          get().loadHistory();
        }
      } catch (e) {
        console.error('[store] deleteSession error:', e);
      }
    },

    resetSession: async (key: string) => {
      try {
        await apiClient.sessionsReset(key);
        if (get().currentSessionKey === key) {
          set({ messages: [] });
        }
      } catch (e) {
        console.error('[store] resetSession error:', e);
      }
    },
  };
});

/** 从 sessionKey 提取可读标题 */
function extractSessionTitle(key: string): string {
  const parts = key.split(':');
  if (parts.length >= 3) {
    const channel = parts.slice(2).join(':');
    if (channel === 'main') return '主对话';
    return channel.length > 20 ? channel.substring(0, 20) + '…' : channel;
  }
  return key;
}
