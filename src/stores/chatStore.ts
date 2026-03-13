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

/** 提取思维链内容（<thinking>...</thinking> 标签中的内容） */
function extractThinkingContent(text: string): string {
  const matches: string[] = [];
  const re = /<\s*think(?:ing)?\s*>([\s\S]*?)(?:<\s*\/\s*think(?:ing)?\s*>|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]?.trim()) matches.push(m[1].trim());
  }
  return matches.join('\n\n');
}

/** 去除思维链标签（保留非思维链内容） */
function stripThinkingTags(text: string): string {
  return text
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?(?:<\s*\/\s*think(?:ing)?\s*>|$)/gi, '')
    .replace(
      /Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
      ''
    )
    .replace(/\[Queued messages while agent was busy\]\s*---\s*Queued #\d+\s*/gi, '')
    .trim();
}

/**
 * 去除 Gateway 注入的 operator / system 元数据前缀
 * 以及开头的时间戳
 */
function stripOperatorInjectedContent(text: string): string {
  // 去除 "Skills store policy(operator configured): ..." 块
  text = text.replace(
    /Skills\s+store\s+policy\s*\(operator\s+configured\)\s*:[\s\S]*?(?=\n{2,}|\n(?=[A-Z])|$)/gi,
    ''
  );
  // 去除 "[system]" 前缀块
  text = text.replace(/^\[system\][\s\S]*?(?=\n{2,}|$)/gim, '');
  // 去除 "Conversation info" 块
  text = text.replace(
    /Conversation info\s*\(untrusted metadata\)\s*:?\s*```json[\s\S]*?```\s*/gi,
    ''
  );
  // 去除 operator 指令前缀
  text = text.replace(/^##\s*(?:System|Operator)\s+(?:Message|Instructions?)[\s\S]*?(?=\n{2,}|$)/gim, '');
  return text.trim();
}

/** 去除消息开头的时间戳前缀 */
function stripTimestampPrefix(text: string): string {
  // [Fri 2026-03-13 05:49 UTC] 或 [Mon 2026-03-13 05:49:30 UTC] （带星期和时区）
  text = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|[A-Z]{2,5})?\]\s*/gi, '');
  // [2026-03-13 12:00:00] 或 [2026-03-13T12:00:00.000Z]
  text = text.replace(/^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\]\s*/g, '');
  // 2026-03-13 12:00:00\n 或 2026-03-13T12:00:00.000Z\n（独占一行的时间戳）
  text = text.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\s*\n/g, '');
  // Fri 2026-03-13 05:49 UTC\n（不带方括号，带星期和时区，独占一行）
  text = text.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|[A-Z]{2,5})?\s*\n/gi, '');
  // [12:00:00] 或 [12:00]
  text = text.replace(/^\[\d{2}:\d{2}(?::\d{2})?\]\s*/g, '');
  // 纯数字时间戳开头 (Unix ms) 后跟换行
  text = text.replace(/^\d{13,}\s*\n/g, '');
  return text.trim();
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

/** 从 Gateway 消息中提取图片和文件附件 */
function extractAttachments(message?: ChatMessage): FileAttachment[] {
  if (!message) return [];
  const attachments: FileAttachment[] = [];

  // 从 content blocks 提取
  if (Array.isArray(message.content)) {
    for (const block of message.content as ContentBlock[]) {
      const bt = (block.type || '').toLowerCase();

      // 图片类型（宽松匹配多种命名）
      if (bt === 'image' || bt === 'image_url' || bt === 'image_block' || bt === 'photo') {
        const url = extractImageUrl(block);
        if (url) {
          attachments.push({
            id: uuid(),
            name: block.fileName || block.name || 'image',
            type: block.mimeType || block.source?.media_type || 'image/png',
            size: block.size || 0,
            url,
          });
        }
      }
      // 文件类型
      else if (bt === 'file' || bt === 'document' || bt === 'attachment') {
        const url = block.url || block.source?.url || '';
        if (url) {
          attachments.push({
            id: uuid(),
            name: block.fileName || block.name || 'file',
            type: block.mimeType || 'application/octet-stream',
            size: block.size || 0,
            url,
          });
        }
      }
      // 如果 type 不是以上已知类型，但有图片标志性字段
      else if (!bt || bt === 'unknown') {
        const url = extractImageUrl(block);
        if (url) {
          attachments.push({
            id: uuid(),
            name: block.fileName || block.name || 'image',
            type: block.mimeType || block.source?.media_type || 'image/png',
            size: block.size || 0,
            url,
          });
        }
      }
    }
  }

  // 从消息级 attachments 字段提取（部分 Gateway 将附件放在此处）
  const msgAny = message as Record<string, unknown>;
  if (Array.isArray(msgAny.attachments)) {
    for (const att of msgAny.attachments as Record<string, unknown>[]) {
      const url = (att.url as string) || (att.content ? `data:${att.mimeType || 'image/png'};base64,${att.content}` : '');
      if (url) {
        const mime = (att.mimeType as string) || (att.type as string) || 'image/png';
        attachments.push({
          id: uuid(),
          name: (att.fileName as string) || (att.name as string) || 'attachment',
          type: mime,
          size: (att.size as number) || 0,
          url,
        });
      }
    }
  }

  // 从 mediaUrl / mediaUrls 提取
  if (message.mediaUrl) {
    attachments.push({
      id: uuid(),
      name: 'media',
      type: guessMediaType(message.mediaUrl),
      size: 0,
      url: message.mediaUrl,
    });
  }
  if (message.mediaUrls) {
    for (const url of message.mediaUrls) {
      attachments.push({
        id: uuid(),
        name: 'media',
        type: guessMediaType(url),
        size: 0,
        url,
      });
    }
  }

  return attachments;
}

/** 从 ContentBlock 中提取图片 URL（支持多种格式） */
function extractImageUrl(block: ContentBlock): string {
  if (block.url) return block.url;
  if (block.image_url?.url) return block.image_url.url;
  if (block.source?.url) return block.source.url;
  if (block.source?.data && block.source?.media_type) {
    return `data:${block.source.media_type};base64,${block.source.data}`;
  }
  if (block.source?.data) {
    return `data:image/png;base64,${block.source.data}`;
  }
  if (block.data && block.mimeType) {
    return `data:${block.mimeType};base64,${block.data}`;
  }
  if (block.data) {
    return `data:image/png;base64,${block.data}`;
  }
  return '';
}

/** 猜测 URL 的媒体类型 */
function guessMediaType(url: string): string {
  const lower = url.toLowerCase();
  if (/\.jpe?g/.test(lower)) return 'image/jpeg';
  if (/\.png/.test(lower)) return 'image/png';
  if (/\.gif/.test(lower)) return 'image/gif';
  if (/\.webp/.test(lower)) return 'image/webp';
  if (/\.svg/.test(lower)) return 'image/svg+xml';
  if (/\.pdf/.test(lower)) return 'application/pdf';
  if (/^data:([^;]+);/.test(url)) return RegExp.$1;
  return 'image/png'; // 默认图片
}

/** 判断是否应跳过该消息角色 */
function shouldSkipRole(role?: string): boolean {
  if (!role) return true;
  const skip = new Set([
    'operator', 'system', 'tool', 'toolResult', 'tool_result',
    'function', 'function_call', 'developer',
  ]);
  return skip.has(role);
}

/** 从消息内容生成有意义的会话标题（本地快速回退） */
function generateSessionTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  if (!firstLine) return '新对话';
  return firstLine.length > 30 ? firstLine.substring(0, 30) + '…' : firstLine;
}

// ==================== AI 标题生成 ====================

/**
 * 追踪正在进行的标题生成请求
 * tempSessionKey → { originalSessionKey, accumText, resolve }
 */
const titleGenMap = new Map<
  string,
  { originalKey: string; accumText: string; resolve: (title: string) => void }
>();

/**
 * 用 AI 为会话生成标题（方式2：临时 session，用完即删）
 * - 创建临时 sessionKey
 * - 发送摘要请求
 * - 监听 AI 回复，获取标题
 * - 删除临时 session
 */
async function requestAITitle(
  userMessage: string,
  aiMessage: string,
  originalSessionKey: string
): Promise<string> {
  // 生成临时 sessionKey（带 _sys 标记，不会匹配任何用户的过滤规则）
  const baseKey = apiClient.sessionKey;
  if (!baseKey) return generateSessionTitle(userMessage);
  const parts = baseKey.split(':');
  const prefix = parts.slice(0, 2).join(':');
  const tempKey = `${prefix}:clawchat-_sys-titlegen-${Date.now().toString(36)}`;

  const prompt = `请用不超过15个字概括以下对话的主题。要求：只输出标题文字，不要引号、标点和任何其他说明。\n\n用户：${userMessage.substring(0, 300)}\nAI：${aiMessage.substring(0, 300)}`;

  return new Promise<string>((resolve) => {
    // 15秒超时，回退到本地标题
    const timeout = setTimeout(() => {
      titleGenMap.delete(tempKey);
      resolve(generateSessionTitle(userMessage));
      // 尝试删除临时 session（可能失败，忽略）
      apiClient.sessionsDelete(tempKey).catch(() => {});
    }, 15000);

    titleGenMap.set(tempKey, {
      originalKey: originalSessionKey,
      accumText: '',
      resolve: (title: string) => {
        clearTimeout(timeout);
        titleGenMap.delete(tempKey);
        resolve(title);
        // 清理临时 session
        apiClient.sessionsDelete(tempKey).catch(() => {});
      },
    });

    // 发送 AI 请求
    apiClient.chatSend(tempKey, prompt).catch(() => {
      clearTimeout(timeout);
      titleGenMap.delete(tempKey);
      resolve(generateSessionTitle(userMessage));
    });
  });
}

// ==================== Store 类型 ====================

interface ChatState {
  // 连接状态
  connectionStatus: ConnectionStatus;
  serverConfig: ServerConfig | null;
  errorMessage: string | null;

  // 用户身份
  userId: string | null;
  username: string | null;

  // 会话
  sessions: Session[];
  currentSessionKey: string | null;

  // 消息
  messages: Message[];

  // 流式状态
  isStreaming: boolean;
  currentRunId: string | null;
  currentAiText: string;
  currentAiThinking: string;
  currentAiMessageId: string | null;

  // 工具调用
  toolCards: Map<string, ToolCall>;

  // 中止后的操作状态
  lastAbortedUserMsgId: string | null;

  // Actions
  connect: (config: ServerConfig) => void;
  disconnect: () => void;
  sendMessage: (content: string, attachments?: FileAttachment[]) => Promise<void>;
  stopGenerating: () => void;
  switchSession: (key: string) => void;
  createNewSession: () => void;
  loadHistory: () => Promise<void>;
  loadSessions: () => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  resetSession: (key: string) => Promise<void>;
  resendLastMessage: () => void;
  deleteLastUserMessage: () => void;
  loadFirstUserMessage: (sessionKey: string) => Promise<string | null>;
}

/**
 * 将当前流式输出中的 AI 消息（含工具调用、思维链）保存到 IndexedDB。
 * 在切换会话 / 新建会话前调用，避免丢失正在执行中的工具调用内容。
 */
function _saveStreamingStateToDb(state: ChatState) {
  const { currentAiText, currentAiThinking, currentAiMessageId, toolCards, currentSessionKey } = state;
  const hasContent = currentAiText || currentAiThinking || toolCards.size > 0;
  if (!hasContent || !currentAiMessageId || !currentSessionKey) return;

  const partialMsg: Message = {
    id: currentAiMessageId,
    sessionKey: currentSessionKey,
    role: 'assistant',
    content: currentAiText || '',
    thinking: currentAiThinking || undefined,
    toolCalls: toolCards.size > 0 ? Array.from(toolCards.values()) : undefined,
    createdAt: Date.now(),
    isStreaming: false, // 存 DB 时标记为非流式
  };
  db.saveMessage(partialMsg).catch((e) =>
    console.warn('[store] 保存流式状态失败:', e)
  );
}

// ==================== 后台会话流式缓冲区 ====================
// 当用户切换到其他会话时，非当前会话的 SSE 事件仍在到达。
// 这里维护后台缓冲区，持续处理这些事件，确保切回时数据不丢失。
interface BgStreamState {
  msgId: string;
  sessionKey: string;
  text: string;
  thinking: string;
  toolCards: Map<string, ToolCall>;
  createdAt: number;
}
const bgStreams = new Map<string, BgStreamState>();

/** 处理非当前会话的 agent 事件 — 后台缓冲 */
function _bgHandleAgentEvent(payload: AgentEventPayload) {
  const sk = payload.sessionKey!;
  const { stream, data } = payload;

  if (stream === 'lifecycle') {
    if (data?.phase === 'start') {
      // 新一轮开始，初始化缓冲区
      bgStreams.set(sk, {
        msgId: `ai-${uuid()}`,
        sessionKey: sk,
        text: '',
        thinking: '',
        toolCards: new Map(),
        createdAt: Date.now(),
      });
    }
    if (data?.phase === 'end') {
      // 生命周期结束，保存到 DB 并清理
      const bg = bgStreams.get(sk);
      if (bg && (bg.text || bg.thinking || bg.toolCards.size > 0)) {
        const msg: Message = {
          id: bg.msgId,
          sessionKey: sk,
          role: 'assistant',
          content: bg.text,
          thinking: bg.thinking || undefined,
          toolCalls: bg.toolCards.size > 0 ? Array.from(bg.toolCards.values()) : undefined,
          createdAt: bg.createdAt,
          isStreaming: false,
        };
        db.saveMessage(msg).catch((e) =>
          console.warn('[bg] 保存后台消息失败:', e)
        );
      }
      bgStreams.delete(sk);
    }
    return;
  }

  // 确保缓冲区存在
  let bg = bgStreams.get(sk);
  if (!bg) {
    bg = {
      msgId: `ai-${uuid()}`,
      sessionKey: sk,
      text: '',
      thinking: '',
      toolCards: new Map(),
      createdAt: Date.now(),
    };
    bgStreams.set(sk, bg);
  }

  if (stream === 'assistant') {
    const text = data?.text;
    if (text && typeof text === 'string') {
      const thinking = extractThinkingContent(text);
      const cleaned = stripThinkingTags(text);
      if (cleaned) {
        if (cleaned.length > bg.text.length) {
          bg.text = cleaned;
        } else if (cleaned.length > 0 && !bg.text.endsWith(cleaned)) {
          bg.text = bg.text + '\n\n' + cleaned;
        }
      }
      if (thinking) {
        if (thinking.length > bg.thinking.length) {
          bg.thinking = thinking;
        } else if (!bg.thinking.endsWith(thinking)) {
          bg.thinking = bg.thinking ? bg.thinking + '\n\n---\n\n' + thinking : thinking;
        }
      }
    }
    return;
  }

  if (stream === 'tool') {
    const toolCallId = data?.toolCallId || data?.id || data?.tool_call_id;
    if (!toolCallId) return;
    const name = (data?.name as string) || (data?.tool_name as string) || 'tool';
    const phase = (data?.phase as string) || (data?.status as string) || '';
    const inputRaw = data?.input ?? data?.arguments ?? data?.params ?? data?.tool_input ?? data?.command;
    const outputRaw = data?.output ?? data?.result ?? data?.content ?? data?.tool_result ?? data?.text ?? data?.response;
    const inputStr = inputRaw ? (typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw, null, 2)) : undefined;
    const outputStr = outputRaw ? (typeof outputRaw === 'string' ? outputRaw : JSON.stringify(outputRaw, null, 2)) : undefined;
    const errorStr = data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : undefined;

    if (!bg.toolCards.has(toolCallId as string)) {
      bg.toolCards.set(toolCallId as string, {
        id: toolCallId as string,
        name,
        status: phase === 'start' ? 'running' : (phase === 'error' ? 'error' : 'done'),
        input: inputStr,
        output: outputStr,
        startedAt: Date.now(),
      });
    } else {
      const existing = bg.toolCards.get(toolCallId as string)!;
      const isFinished = phase === 'result' || phase === 'end' || phase === 'error' || phase === 'done';
      bg.toolCards.set(toolCallId as string, {
        ...existing,
        name: name !== 'tool' ? name : existing.name,
        status: phase === 'error' ? 'error' : (isFinished ? 'done' : existing.status),
        input: inputStr || existing.input,
        output: outputStr || errorStr || existing.output,
        finishedAt: isFinished ? Date.now() : existing.finishedAt,
      });
    }
  }
}

/** 处理非当前会话的 chat.event — 后台保存 */
function _bgHandleChatEvent(payload: ChatEventPayload) {
  const sk = payload.sessionKey!;
  const { state: chatState } = payload;

  if (chatState === 'final') {
    const rawText = extractText(payload.message);
    const text = rawText ? stripThinkingTags(rawText) : '';
    const thinking = rawText ? extractThinkingContent(rawText) : '';

    // 合并后台缓冲区的工具调用数据
    const bg = bgStreams.get(sk);
    const toolCalls = bg && bg.toolCards.size > 0
      ? Array.from(bg.toolCards.values())
      : undefined;
    const finalThinking = thinking || bg?.thinking || undefined;

    if (text || toolCalls) {
      const msg: Message = {
        id: bg?.msgId || `ai-${uuid()}`,
        sessionKey: sk,
        role: 'assistant',
        content: text || bg?.text || '',
        thinking: finalThinking,
        toolCalls,
        createdAt: Date.now(),
        isStreaming: false,
      };
      db.saveMessage(msg).catch((e) =>
        console.warn('[bg] 保存后台 final 消息失败:', e)
      );
    }
    bgStreams.delete(sk);
  }
}

export const useChatStore = create<ChatState>((set, get) => {
  // ==================== 事件处理 ====================

  /** 处理 chat 事件 */
  function handleChatEvent(payload: ChatEventPayload) {
    // ====== 拦截标题生成会话的事件 ======
    if (payload.sessionKey && titleGenMap.has(payload.sessionKey)) {
      const gen = titleGenMap.get(payload.sessionKey)!;
      const text = extractText(payload.message);
      if (payload.state === 'delta' && text) {
        gen.accumText = text;
      } else if (payload.state === 'final') {
        const finalText = text || gen.accumText;
        const title = finalText.replace(/["""'']/g, '').trim();
        gen.resolve(title || '新对话');
      } else if (payload.state === 'aborted' || payload.state === 'error') {
        gen.resolve(gen.accumText.trim() || '新对话');
      }
      return; // 标题生成事件不进入正常消息流
    }

    const state = get();
    // 非当前会话 → 路由到后台处理（不丢弃）
    if (payload.sessionKey && payload.sessionKey !== state.currentSessionKey && state.currentSessionKey) {
      _bgHandleChatEvent(payload);
      return;
    }

    const { state: chatState } = payload;

    if (chatState === 'delta') {
      const rawText = extractText(payload.message);
      if (!rawText) return;
      const thinking = extractThinkingContent(rawText);
      const text = stripThinkingTags(rawText);
      const msgId = state.currentAiMessageId || `ai-${uuid()}`;

      const updates: Record<string, unknown> = {
        isStreaming: true,
        currentAiMessageId: msgId,
        currentRunId: payload.runId || state.currentRunId,
        lastAbortedUserMsgId: null,
      };
      // 文本累积（兼容 agent 多 turn 重置）
      if (text) {
        if (text.length > state.currentAiText.length) {
          updates.currentAiText = text;
        } else if (text.length > 0 && text.length < state.currentAiText.length
          && !state.currentAiText.endsWith(text)) {
          updates.currentAiText = state.currentAiText + '\n\n' + text;
        }
      }
      // 思维链累积
      if (thinking) {
        if (thinking.length > state.currentAiThinking.length) {
          updates.currentAiThinking = thinking;
        } else if (!state.currentAiThinking.endsWith(thinking)) {
          updates.currentAiThinking = state.currentAiThinking
            ? state.currentAiThinking + '\n\n---\n\n' + thinking
            : thinking;
        }
      }
      set(updates as Partial<ChatState>);
      return;
    }

    if (chatState === 'final') {
      const rawText = extractText(payload.message);
      const text = rawText ? stripThinkingTags(rawText) : '';
      const thinking = rawText ? extractThinkingContent(rawText) : '';
      const currentText = state.currentAiText;

      // 忽略空 final
      if (!state.currentAiMessageId && !text) return;

      const msgId = state.currentAiMessageId || `ai-${uuid()}`;
      const finalText = text || currentText;
      const finalThinking = thinking || state.currentAiThinking;

      if (finalText || finalThinking) {
        // 创建最终消息
        const aiMsg: Message = {
          id: msgId,
          sessionKey: state.currentSessionKey || '',
          role: 'assistant',
          content: finalText,
          thinking: finalThinking || undefined,
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
          currentAiThinking: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
          lastAbortedUserMsgId: null,
        }));

        // 持久化
        db.saveMessage(aiMsg);

        // 如果是第一条 AI 回复, 用 AI 生成会话标题
        if (state.messages.filter(m => m.role === 'assistant').length === 0) {
          const firstUserMsg = state.messages.find(m => m.role === 'user');
          const sessionKeyForTitle = state.currentSessionKey;
          if (firstUserMsg && sessionKeyForTitle) {
            // 异步生成标题，不阻塞主流程
            requestAITitle(firstUserMsg.content, finalText, sessionKeyForTitle)
              .then((title) => {
                if (!title || title === '新对话') return;
                const cleanTitle = title.length > 25 ? title.substring(0, 25) + '…' : title;
                console.log('[store] AI 生成标题:', cleanTitle, '会话:', sessionKeyForTitle);
                // 更新 sessions 列表中对应会话的标题
                set((s) => ({
                  sessions: s.sessions.map((sess) =>
                    sess.key === sessionKeyForTitle
                      ? { ...sess, title: cleanTitle }
                      : sess
                  ),
                }));
                // 保存到本地 DB + 服务端（跨安装持久化）
                db.updateSessionTitle(sessionKeyForTitle, cleanTitle).catch(() => {});
                apiClient.saveSessionTitle(sessionKeyForTitle, cleanTitle).catch(() => {});
              })
              .catch((e) => console.warn('[store] AI 标题生成失败:', e));
          }
          // 同时刷新会话列表（确保新会话出现在列表中）
          setTimeout(() => get().loadSessions(), 500);
        }
      } else {
        set({
          isStreaming: false,
          currentAiText: '',
          currentAiThinking: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
        });
      }
      return;
    }

    if (chatState === 'aborted') {
      const currentText = state.currentAiText;
      // 找到最后一条用户消息 ID
      const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');

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
          currentAiThinking: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
          lastAbortedUserMsgId: lastUserMsg?.id || null,
        }));
      } else {
        set({
          isStreaming: false,
          currentAiText: '',
          currentAiThinking: '',
          currentAiMessageId: null,
          currentRunId: null,
          toolCards: new Map(),
          lastAbortedUserMsgId: lastUserMsg?.id || null,
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
        currentAiThinking: '',
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
    // 非当前会话 → 路由到后台缓冲区（不丢弃）
    if (payload.sessionKey && payload.sessionKey !== state.currentSessionKey) {
      _bgHandleAgentEvent(payload);
      return;
    }

    const { stream, data } = payload;

    if (stream === 'lifecycle') {
      if (data?.phase === 'start') {
        set({
          isStreaming: true,
          currentRunId: payload.runId || null,
          lastAbortedUserMsgId: null,
        });
      }
      if (data?.phase === 'end') {
        set({ isStreaming: false });
      }
      return;
    }

    // assistant 流 — 高频文本累积 + 思维链提取
    // 注意：agent 模式下工具调用之间，text 可能从头开始（新 turn）
    if (stream === 'assistant') {
      const text = data?.text;
      if (text && typeof text === 'string') {
        const thinking = extractThinkingContent(text);
        const cleaned = stripThinkingTags(text);
        const msgId = state.currentAiMessageId || `ai-${uuid()}`;

        const updates: Partial<ChatState> = {
          currentAiMessageId: msgId,
          currentRunId: payload.runId || state.currentRunId,
        };

        if (cleaned) {
          if (cleaned.length > state.currentAiText.length) {
            // 同 turn 内文本持续增长
            updates.currentAiText = cleaned;
          } else if (cleaned.length > 0 && cleaned.length < state.currentAiText.length
            && !state.currentAiText.endsWith(cleaned)) {
            // 新 turn：text 变短了（从头开始） → 拼接到已有文本后面
            updates.currentAiText = state.currentAiText + '\n\n' + cleaned;
          }
        }

        if (thinking) {
          if (thinking.length > state.currentAiThinking.length) {
            // 同 turn 思维链增长
            updates.currentAiThinking = thinking;
          } else if (!state.currentAiThinking.endsWith(thinking)) {
            // 新 turn 出现新的思维链 → 追加（用分隔符区分不同轮次）
            updates.currentAiThinking = state.currentAiThinking
              ? state.currentAiThinking + '\n\n---\n\n' + thinking
              : thinking;
          }
        }

        if (updates.currentAiText || updates.currentAiThinking) {
          set(updates as ChatState);
        }
      }
      return;
    }

    // tool 流
    if (stream === 'tool') {
      const toolCallId = data?.toolCallId || data?.id || data?.tool_call_id;
      if (!toolCallId) return;
      const name = (data?.name as string) || (data?.tool_name as string) || 'tool';
      const phase = (data?.phase as string) || (data?.status as string) || '';

      // 提取工具 input — 尝试多种字段路径
      const inputRaw = data?.input ?? data?.arguments ?? data?.params
        ?? data?.tool_input ?? data?.command;
      // 提取工具 output — 尝试多种字段路径
      const outputRaw = data?.output ?? data?.result ?? data?.content
        ?? data?.tool_result ?? data?.text ?? data?.response;
      // 序列化
      const inputStr = inputRaw
        ? (typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw, null, 2))
        : undefined;
      const outputStr = outputRaw
        ? (typeof outputRaw === 'string' ? outputRaw : JSON.stringify(outputRaw, null, 2))
        : undefined;
      // 错误信息
      const errorStr = data?.error
        ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
        : undefined;

      console.debug(`[store] tool event: id=${toolCallId} name=${name} phase=${phase} hasInput=${!!inputStr} hasOutput=${!!outputStr} dataKeys=${Object.keys(data || {})}`);

      set((s) => {
        const toolCards = new Map(s.toolCards);
        if (!toolCards.has(toolCallId as string)) {
          toolCards.set(toolCallId as string, {
            id: toolCallId as string,
            name,
            status: phase === 'start' ? 'running' : (phase === 'error' ? 'error' : 'done'),
            input: inputStr,
            output: outputStr,
            startedAt: Date.now(),
          });
        } else {
          const existing = toolCards.get(toolCallId as string)!;
          const isFinished = phase === 'result' || phase === 'end' || phase === 'error' || phase === 'done';
          toolCards.set(toolCallId as string, {
            ...existing,
            name: name !== 'tool' ? name : existing.name, // 保留更具体的名字
            status: phase === 'error' ? 'error' : (isFinished ? 'done' : existing.status),
            input: inputStr || existing.input,
            output: outputStr || errorStr || existing.output,
            finishedAt: isFinished ? Date.now() : existing.finishedAt,
          });
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
    } else if (event === 'stream' || event === 'tool' || event === 'run') {
      // 兼容部分 Gateway 版本：stream/tool/run 事件可能也包含 agent 数据
      const p = payload as Record<string, unknown>;
      const data = p?.data as Record<string, unknown> | undefined;
      if (p?.stream || data?.toolCallId) {
        handleAgentEvent(p as unknown as AgentEventPayload);
      }
    }
    // 调试：未知事件
    else {
      console.debug('[store] 未识别事件:', event, payload);
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
    userId: null,
    username: null,
    sessions: [],
    currentSessionKey: null,
    messages: [],
    isStreaming: false,
    currentRunId: null,
    currentAiText: '',
    currentAiThinking: '',
    currentAiMessageId: null,
    toolCards: new Map(),
    lastAbortedUserMsgId: null,

    connect: (config: ServerConfig) => {
      set({ serverConfig: config, errorMessage: null });

      // 注册一次性 ready 回调
      const unsub = apiClient.onReady((hello, sessionKey, meta) => {
        unsub();
        if (meta?.error) {
          set({ errorMessage: meta.message || '连接失败' });
          return;
        }
        // 保存用户身份
        const resolvedUserId = apiClient.userId || config.username || null;

        // 恢复上次打开的会话（如果存在且属于当前用户）
        const savedSessionKey = localStorage.getItem('clawchat-session-key');
        let finalSessionKey: string = sessionKey || '';
        if (savedSessionKey) {
          // 验证 key 包含当前用户标识（clawchat-{userId}）
          const userTag = resolvedUserId ? `clawchat-${resolvedUserId}` : 'clawchat-';
          if (savedSessionKey.includes(userTag)) {
            finalSessionKey = savedSessionKey;
            console.log('[store] 恢复上次会话:', savedSessionKey);
          } else {
            console.log('[store] 保存的会话不属于当前用户，使用默认:', sessionKey);
          }
        }

        set({
          currentSessionKey: finalSessionKey || null,
          userId: resolvedUserId,
          username: config.username || apiClient.userId || null,
        });

        // 保存当前 sessionKey（确保下次打开时能恢复）
        if (finalSessionKey) {
          localStorage.setItem('clawchat-session-key', finalSessionKey);
        }

        // 保存配置
        localStorage.setItem('clawchat-config', JSON.stringify(config));

        // 加载历史和会话列表
        get().loadHistory();
        get().loadSessions();
      });

      apiClient.connect(config.host, config.token, config.username);
    },

    disconnect: () => {
      apiClient.disconnect();
      set({
        connectionStatus: 'disconnected',
        serverConfig: null,
        userId: null,
        username: null,
        currentSessionKey: null,
        messages: [],
        sessions: [],
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        lastAbortedUserMsgId: null,
      });
    },

    sendMessage: async (content: string, attachments?: FileAttachment[]) => {
      const state = get();
      const sessionKey = state.currentSessionKey;
      if (!sessionKey) return;

      // ——— 如果当前 session 不在列表中，说明是新会话的第一条消息 ———
      const isNewSession = !state.sessions.some((s) => s.key === sessionKey);
      if (isNewSession) {
        const title = generateSessionTitle(content); // 用用户问题做标题
        const newSession: Session = {
          key: sessionKey,
          title,
          lastMessage: content.length > 40 ? content.substring(0, 40) + '…' : content,
          updatedAt: Date.now(),
        };
        set((s) => ({
          sessions: [newSession, ...s.sessions],
        }));
        // 持久化标题
        db.updateSessionTitle(sessionKey, title).catch(() => {});
        apiClient.saveSessionTitle(sessionKey, title).catch(() => {});
      }

      // 创建用户消息
      const userMsg: Message = {
        id: `user-${uuid()}`,
        sessionKey,
        role: 'user',
        content,
        attachments,
        createdAt: Date.now(),
      };
      set((s) => ({
        messages: [...s.messages, userMsg],
        isStreaming: true,
        lastAbortedUserMsgId: null,
      }));
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
      // 保存当前流式输出的内容（包括工具调用）
      _saveStreamingStateToDb(state);

      // 立即更新本地状态，标记最后一条用户消息
      const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
      set({
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        lastAbortedUserMsgId: lastUserMsg?.id || null,
      });
    },

    switchSession: (key: string) => {
      // ——— 切换前：保存正在流式输出的 AI 消息（包括工具调用）到 DB ———
      _saveStreamingStateToDb(get());

      set({
        currentSessionKey: key,
        messages: [],
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        lastAbortedUserMsgId: null,
      });
      localStorage.setItem('clawchat-session-key', key);

      // 检查目标会话是否有后台流式缓冲区（切走时还在输出的那段）
      const bg = bgStreams.get(key);
      if (bg) {
        // 将后台缓冲区的状态"提升"到前台
        set({
          currentAiMessageId: bg.msgId,
          currentAiText: bg.text,
          currentAiThinking: bg.thinking,
          toolCards: new Map(bg.toolCards),
          isStreaming: true,
        });
        bgStreams.delete(key);
      }

      get().loadHistory();
    },

    /**
     * 新建会话 — 仅生成 sessionKey 并清空状态，
     * 不在列表中创建条目；等用户发送第一条消息时才创建。
     */
    createNewSession: () => {
      // 切换前保存当前流式状态
      _saveStreamingStateToDb(get());

      const baseKey = apiClient.sessionKey;
      if (!baseKey) return;
      // 从 agent:main:clawchat-xxx 提取 agent:main 前缀
      const parts = baseKey.split(':');
      const prefix = parts.slice(0, 2).join(':'); // 'agent:main'
      const state = get();
      const userTag = state.userId || state.username || 'default';
      const suffix = Date.now().toString(36); // 短时间戳作后缀
      const newKey = `${prefix}:clawchat-${userTag}-${suffix}`;

      // 只切换到新 key、清空消息，不加入 sessions 列表
      set({
        currentSessionKey: newKey,
        messages: [],
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        lastAbortedUserMsgId: null,
      });
      localStorage.setItem('clawchat-session-key', newKey);
    },

    loadHistory: async () => {
      const state = get();
      const sessionKey = state.currentSessionKey;
      if (!sessionKey || !apiClient.gatewayReady) return;

      try {
        const result = (await apiClient.chatHistory(sessionKey)) as {
          messages?: ChatMessage[];
        };
        if (!result?.messages?.length) {
          // Gateway 无记录，尝试加载本地 DB
          const localMessages = await db.getMessages(sessionKey);
          if (localMessages.length > 0) {
            set({ messages: localMessages });
          }
          return;
        }

        // ====== 并行加载：本地 DB 消息 + 服务端附件 ======
        const [localMessages, serverAttachments] = await Promise.all([
          db.getMessages(sessionKey),
          apiClient.getSessionAttachments(sessionKey).catch(() => []),
        ]);

        // 构建本地 DB 附件匹配索引 + 工具调用索引
        const localAttById = new Map<string, FileAttachment[]>();
        const localAttByText = new Map<string, FileAttachment[]>();
        const localUserMsgsWithAtt: { content: string; attachments: FileAttachment[] }[] = [];
        const localToolCallsById = new Map<string, ToolCall[]>();
        const localToolCallsByText = new Map<string, ToolCall[]>();
        const localThinkingById = new Map<string, string>();
        const localThinkingByText = new Map<string, string>();

        for (const lm of localMessages) {
          if (lm.attachments && lm.attachments.length > 0) {
            localAttById.set(lm.id, lm.attachments);
            const fuzzyKey = lm.content.substring(0, 50).trim();
            if (fuzzyKey) localAttByText.set(fuzzyKey, lm.attachments);
            if (lm.role === 'user') {
              localUserMsgsWithAtt.push({ content: lm.content, attachments: lm.attachments });
            }
          }
          // 收集工具调用数据（用于历史恢复）
          if (lm.toolCalls && lm.toolCalls.length > 0 && lm.role === 'assistant') {
            localToolCallsById.set(lm.id, lm.toolCalls);
            const tcKey = lm.content.substring(0, 50).trim();
            if (tcKey) localToolCallsByText.set(tcKey, lm.toolCalls);
          }
          // 收集思维链数据（用于历史恢复）
          if (lm.thinking && lm.role === 'assistant') {
            localThinkingById.set(lm.id, lm.thinking);
            const tkKey = lm.content.substring(0, 50).trim();
            if (tkKey) localThinkingByText.set(tkKey, lm.thinking);
          }
        }

        // 构建服务端附件匹配索引（按 messageText 前 50 字符分组）
        const serverAttByText = new Map<string, FileAttachment[]>();
        const serverAttOrdered: FileAttachment[][] = [];
        let lastServerGroup = '__INIT__'; // 初始哨兵值，不同于空字符串
        for (const sa of serverAttachments) {
          const key = (sa.messageText || '').substring(0, 50).trim();
          const att: FileAttachment = {
            id: sa.id,
            name: sa.name,
            type: sa.type,
            size: sa.size,
            url: sa.url,
          };
          if (key) {
            const existing = serverAttByText.get(key) || [];
            existing.push(att);
            serverAttByText.set(key, existing);
          }
          // 按消息分组收集（按顺序匹配的候选）
          const groupKey = key || `__empty_${sa.createdAt}__`; // 空文本也用唯一key分组
          if (groupKey !== lastServerGroup) {
            serverAttOrdered.push([att]);
            lastServerGroup = groupKey;
          } else if (serverAttOrdered.length > 0) {
            serverAttOrdered[serverAttOrdered.length - 1].push(att);
          }
        }

        // 按顺序处理 Gateway 消息
        const messages: Message[] = [];
        let localUserMsgIdx = 0;
        let serverAttIdx = 0;

        for (const msg of result.messages) {
          const role = msg.role as string;
          if (shouldSkipRole(role)) continue;
          if (role !== 'user' && role !== 'assistant') continue;

          let text = extractText(msg);
          if (role === 'user') {
            text = stripOperatorInjectedContent(text);
            text = stripTimestampPrefix(text);
          }

          let attachments = extractAttachments(msg);

          // ====== 附件恢复：多策略（Gateway → 服务端文件 → 本地DB） ======
          if (attachments.length === 0 && role === 'user') {
            const msgId = msg.id as string;
            const fuzzyKey = text.substring(0, 50).trim();
            let found: FileAttachment[] | undefined;
            let foundSource = '';

            // 策略1：按文本匹配服务端附件（最精确）
            if (fuzzyKey) {
              found = serverAttByText.get(fuzzyKey);
              if (found) foundSource = '服务端(文本匹配)';
            }

            // 策略2：按消息 ID 匹配本地 IndexedDB
            if (!found && msgId) {
              found = localAttById.get(msgId);
              if (found) foundSource = '本地DB(ID匹配)';
            }

            // 策略3：按文本匹配本地 IndexedDB
            if (!found && fuzzyKey) {
              found = localAttByText.get(fuzzyKey);
              if (found) foundSource = '本地DB(文本匹配)';
            }

            // 策略4：本地 IndexedDB 按内容模糊匹配
            if (!found && localUserMsgIdx < localUserMsgsWithAtt.length) {
              const candidate = localUserMsgsWithAtt[localUserMsgIdx];
              const candidateClean = stripTimestampPrefix(stripOperatorInjectedContent(candidate.content)).substring(0, 30);
              const currentClean = text.substring(0, 30);
              if (!currentClean || !candidateClean || currentClean === candidateClean) {
                found = candidate.attachments;
                localUserMsgIdx++;
                foundSource = '本地DB(顺序匹配)';
              }
            }

            // 策略5：服务端顺序匹配 — 仅当前面的策略都失败且文本为空时才尝试
            // （避免为无附件的消息误消费服务端附件组）
            if (!found && serverAttIdx < serverAttOrdered.length) {
              // 只有当这条消息确实可能有附件时才使用顺序匹配
              // 判断依据：消息文本为空或很短（通常发图时文字很少）
              if (!text || text.length < 10) {
                found = serverAttOrdered[serverAttIdx];
                serverAttIdx++;
                foundSource = '服务端(顺序匹配)';
              }
            }

            if (found) {
              attachments = found;
              console.debug('[store] 恢复附件:', fuzzyKey || msgId, `${attachments.length} 个, 来源: ${foundSource}`);
            }
          }

          if (!text && attachments.length === 0) continue;

          // ====== 恢复工具调用 + 思维链数据（从本地 DB）======
          let toolCalls: ToolCall[] | undefined;
          let thinking: string | undefined;
          if (role === 'assistant') {
            const msgId = msg.id as string;
            const tcKey = text.substring(0, 50).trim();
            toolCalls = (msgId ? localToolCallsById.get(msgId) : undefined)
              || (tcKey ? localToolCallsByText.get(tcKey) : undefined)
              || undefined;
            thinking = (msgId ? localThinkingById.get(msgId) : undefined)
              || (tcKey ? localThinkingByText.get(tcKey) : undefined)
              || undefined;
          }

          messages.push({
            id: (msg.id as string) || uuid(),
            sessionKey,
            role: role === 'assistant' ? 'assistant' : 'user',
            content: text,
            thinking,
            attachments: attachments.length > 0 ? attachments : undefined,
            toolCalls,
            createdAt: msg.timestamp || Date.now(),
          });
        }

        set({ messages });
      } catch (e) {
        console.error('[store] loadHistory error:', e);
        // 出错时回退到本地 DB
        try {
          const localMessages = await db.getMessages(state.currentSessionKey || '');
          if (localMessages.length > 0) {
            set({ messages: localMessages });
          }
        } catch (_) { /* ignore */ }
      }
    },

    loadSessions: async () => {
      if (!apiClient.gatewayReady) return;

      try {
        // 并行获取 Gateway 会话列表 + 服务端持久化标题
        const [result, serverTitles] = await Promise.all([
          apiClient.sessionsList() as Promise<{
            sessions?: Array<{
              key: string;
              title?: string;
              lastMessage?: string;
              updatedAt?: number;
            }>;
          }>,
          apiClient.getSessionTitles().catch(() => ({} as Record<string, string>)),
        ]);

        if (!result?.sessions) return;

        // ====== 客户端侧过滤：只显示 ClawChat 创建的会话 ======
        const state = get();
        const currentUserId = state.userId || state.username || 'default';
        const filteredSessions = result.sessions.filter(s => {
          if (!s.key?.includes(':clawchat-')) return false;
          if (currentUserId) return s.key.includes(`:clawchat-${currentUserId}`);
          return true;
        });

        // 从本地 DB 加载已缓存的 AI 标题
        const localSessions = await db.getSessions();
        const localTitleMap = new Map<string, string>();
        for (const ls of localSessions) {
          if (ls.title && ls.title !== '新对话' && ls.title !== '主对话') {
            localTitleMap.set(ls.key, ls.title);
          }
        }

        const sessions: Session[] = filteredSessions.map((s) => {
          // 标题优先级：本地DB > 服务端持久化 > Gateway返回 > lastMessage推断 > sessionKey解析
          let title = localTitleMap.get(s.key)
            || serverTitles[s.key]
            || s.title;

          // 如果有服务端标题但本地没有，同步到本地 DB
          if (!localTitleMap.get(s.key) && serverTitles[s.key]) {
            db.updateSessionTitle(s.key, serverTitles[s.key]).catch(() => {});
          }

          if (!title || title === s.key || /^agent:/.test(title)) {
            if (s.lastMessage) {
              title = generateSessionTitle(s.lastMessage);
            } else {
              title = extractSessionTitle(s.key);
            }
          }
          return {
            key: s.key,
            title,
            lastMessage: s.lastMessage,
            updatedAt: s.updatedAt || Date.now(),
          };
        });

        // 对于仍然是"新对话"的会话，异步尝试从聊天记录生成标题
        for (const sess of sessions) {
          if (sess.title === '新对话' || sess.title === '主对话') {
            // 用 lastMessage 生成，或异步加载首条用户消息
            get().loadFirstUserMessage(sess.key).then((firstMsg: string | null) => {
              if (firstMsg) {
                const betterTitle = generateSessionTitle(firstMsg);
                if (betterTitle && betterTitle !== '新对话') {
                  // 更新 sessions 状态
                  set((s) => ({
                    sessions: s.sessions.map((item) =>
                      item.key === sess.key ? { ...item, title: betterTitle } : item
                    ),
                  }));
                  // 持久化（本地 + 服务端）
                  db.updateSessionTitle(sess.key, betterTitle).catch(() => {});
                  apiClient.saveSessionTitle(sess.key, betterTitle).catch(() => {});
                }
              }
            }).catch(() => {});
          }
        }

        set({ sessions });
      } catch (e) {
        console.error('[store] loadSessions error:', e);
      }
    },

    /** 加载会话的第一条用户消息内容（用于生成标题） */
    loadFirstUserMessage: async (sessionKey: string): Promise<string | null> => {
      try {
        // 先查本地 DB
        const localMsgs = await db.getMessages(sessionKey);
        const localUserMsg = localMsgs.find(m => m.role === 'user');
        if (localUserMsg) {
          const text = stripTimestampPrefix(stripOperatorInjectedContent(localUserMsg.content));
          if (text) return text;
        }

        // 再查 Gateway（限制 5 条减少开销）
        const result = (await apiClient.chatHistory(sessionKey, 5)) as {
          messages?: ChatMessage[];
        };
        if (result?.messages) {
          for (const msg of result.messages) {
            if (msg.role === 'user') {
              let text = extractText(msg);
              text = stripOperatorInjectedContent(text);
              text = stripTimestampPrefix(text);
              if (text) return text;
            }
          }
        }
        return null;
      } catch {
        return null;
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

    /** 重新发送最后一条用户消息 */
    resendLastMessage: () => {
      const state = get();
      const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
      if (!lastUserMsg) return;

      // 移除最后一条用户消息及之后的所有消息
      const idx = state.messages.findIndex(m => m.id === lastUserMsg.id);
      const messagesBeforeLastUser = state.messages.slice(0, idx);
      set({
        messages: messagesBeforeLastUser,
        isStreaming: false,
        currentAiText: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        lastAbortedUserMsgId: null,
      });

      // 重新发送
      get().sendMessage(lastUserMsg.content, lastUserMsg.attachments);
    },

    /** 删除最后一条用户消息及之后的 AI 回复 */
    deleteLastUserMessage: () => {
      const state = get();
      const lastUserMsg = [...state.messages].reverse().find(m => m.role === 'user');
      if (!lastUserMsg) return;

      const idx = state.messages.findIndex(m => m.id === lastUserMsg.id);
      const messagesBeforeLastUser = state.messages.slice(0, idx);
      set({
        messages: messagesBeforeLastUser,
        isStreaming: false,
        currentAiText: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        lastAbortedUserMsgId: null,
      });

      // 从本地 DB 删除
      db.deleteMessage(lastUserMsg.id).catch(() => {});
    },
  };
});

/** 从 sessionKey 提取可读标题 */
function extractSessionTitle(key: string): string {
  const parts = key.split(':');
  if (parts.length >= 3) {
    const channel = parts.slice(2).join(':');
    // clawchat-{user} 格式: 主对话
    if (/^clawchat-[^-]+$/.test(channel)) return '主对话';
    // clawchat-{user}-{suffix} 格式: 新对话
    if (/^clawchat-.+-.+$/.test(channel)) return '新对话';
    if (channel === 'main') return '主对话';
    return channel.length > 20 ? channel.substring(0, 20) + '…' : channel;
  }
  return key;
}
