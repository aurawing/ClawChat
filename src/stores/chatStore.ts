import { create } from 'zustand';
import { apiClient, uuid } from '../services/api-client';
import type {
  Message,
  MessageBlock,
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
  // 去除 ClawChat 注入的文档正文上下文（新版：带明确边界标记）
  text = text.replace(
    /\n*\[CLAWCHAT_DOC_CONTEXT_BEGIN\][\s\S]*?\[CLAWCHAT_DOC_CONTEXT_END\]\s*/g,
    ''
  );
  // 去除 ClawChat 注入的文档正文上下文（兼容旧版：无边界标记）
  text = text.replace(
    /\n*以下是用户本轮上传文档中提取的正文内容，请结合这些内容回答。[^\S\r\n]*[\s\S]*$/g,
    ''
  );
  // 去除被代理/终端注入到用户消息前部的执行完成日志
  text = text.replace(
    /^(?:\s*System:\s*\[[^\]]+\]\s*Exec completed\s*\([^)]+\)\s*::\s*[\s\S]*?(?=(?:\s*System:\s*\[[^\]]+\]\s*Exec completed|\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-|$)))+/i,
    ''
  );
  return text.trim();
}

/** 去除消息开头的时间戳前缀 */
function stripTimestampPrefix(text: string): string {
  // [Fri 2026-03-13 05:49 UTC] 或 [Mon 2026-03-13 05:49:30 UTC] （带星期和时区）
  text = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:(?:UTC|GMT)(?:[+-]\d{1,2})?|[A-Z]{2,5})?\]\s*/gi, '');
  // [2026-03-13 12:00:00] 或 [2026-03-13T12:00:00.000Z]
  text = text.replace(/^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\]\s*/g, '');
  // 2026-03-13 12:00:00\n 或 2026-03-13T12:00:00.000Z\n（独占一行的时间戳）
  text = text.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\s*\n/g, '');
  // Fri 2026-03-13 05:49 UTC\n（不带方括号，带星期和时区，独占一行）
  text = text.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:(?:UTC|GMT)(?:[+-]\d{1,2})?|[A-Z]{2,5})?\s*\n/gi, '');
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

function extractRawMessageText(message?: ChatMessage): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const texts: string[] = [];
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
      const rec = block as unknown as Record<string, unknown>;
      if (block.type === 'thinking' && typeof rec.thinking === 'string') {
        texts.push(`<thinking>${rec.thinking as string}</thinking>`);
      }
    }
    return texts.join('\n');
  }
  if (typeof message.text === 'string') return message.text;
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

function extractAssistantTitleCandidate(content: string): string | null {
  const normalized = content
    .replace(/[`*_#>\-\[\]]/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!normalized) return null;

  const firstClause = normalized
    .replace(/^(当然|好的|没问题|可以|下面|以下|这是|我们来|让我来|我来|先来|总结一下|概括一下)[：:，,\s]*/u, '')
    .split(/[。！？!?；;]/)[0]
    .trim()
    .replace(/^[“"'']|[”"'']$/g, '')
    .trim();

  if (!firstClause) return null;
  const tooGeneric = new Set(['当然', '好的', '没问题', '可以', '当然可以', '好的，我们开始']);
  if (tooGeneric.has(firstClause)) return null;
  if (firstClause.length < 4) return null;
  return firstClause.length > 25 ? `${firstClause.substring(0, 25)}…` : firstClause;
}

function pickInitialSessionTitle(userMessage: string, aiMessage?: string): string {
  return extractAssistantTitleCandidate(aiMessage || '') || generateSessionTitle(userMessage);
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
      resolve(pickInitialSessionTitle(userMessage, aiMessage));
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
      resolve(pickInitialSessionTitle(userMessage, aiMessage));
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
  isHistoryLoading: boolean;

  // 流式状态
  isStreaming: boolean;
  currentRunId: string | null;
  currentAiText: string;
  currentAiThinking: string;
  currentAiMessageId: string | null;

  // 工具调用
  toolCards: Map<string, ToolCall>;

  // 内容块顺序追踪（思维链 / 工具调用 / 文本交错）
  currentBlocks: MessageBlock[];
  _blockThinkingBase: number; // 当前 thinking segment 在 currentAiThinking 中的起始位置
  _blockTextBase: number;     // 当前 text segment 在 currentAiText 中的起始位置

  // 多轮文本累积追踪（防止工具调用后新 turn 的 delta 重复追加）
  _turnBaseText: string;     // 上一轮结束时的完整文本（基线）
  _lastTurnDelta: string;    // 当前轮次 gateway 最后一次发来的 delta 文本

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
 * 从 content block 数组中提取纯文本
 * Anthropic 格式：[{type:"text", text:"..."}, {type:"tool_use", id:..., name:..., input:{...}}]
 */
function extractContentBlockText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: Record<string, unknown>) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b: Record<string, unknown>) => (b.text as string) || '')
      .filter(Boolean);
    return texts.length > 0 ? texts.join('\n') : undefined;
  }
  return undefined;
}

function hasAssistantMetaContent(message?: ChatMessage): boolean {
  if (!message) return false;
  if (typeof message.content === 'string') {
    return !!extractThinkingContent(message.content);
  }
  if (Array.isArray(message.content)) {
    return message.content.some((block) => {
      const b = block as unknown as Record<string, unknown>;
      if (b.type === 'tool_use' || b.type === 'toolCall' || b.type === 'thinking') return true;
      if (b.type === 'text' && typeof b.text === 'string') {
        return !!extractThinkingContent(b.text as string);
      }
      return false;
    });
  }
  return false;
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

/** 快照当前 blocks（补全最后一个 thinking 段 + 剩余文本段） */
function _snapshotBlocks(state: ChatState): MessageBlock[] {
  const blocks = [...state.currentBlocks];
  const thinkingLen = state.currentAiThinking.length;
  const thinkingBase = state._blockThinkingBase;
  // 如果有未分配到 block 的新 thinking 内容，创建或更新最后一个 thinking block
  if (thinkingLen > thinkingBase) {
    const newContent = state.currentAiThinking.substring(thinkingBase);
    if (blocks.length > 0 && blocks[blocks.length - 1].type === 'thinking') {
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], content: newContent };
    } else {
      blocks.push({ type: 'thinking', content: newContent });
    }
  }
  // 补全剩余文本段（工具调用后的文本）
  const textLen = state.currentAiText.length;
  const textBase = state._blockTextBase;
  if (textLen > textBase) {
    const textContent = state.currentAiText.substring(textBase).trim();
    if (textContent) {
      blocks.push({ type: 'text', content: textContent });
    }
  }
  return blocks;
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
    blocks: _snapshotBlocks(state),
    createdAt: Date.now(),
    isStreaming: false,
  };
  db.saveMessage(partialMsg).catch((e) =>
    console.warn('[store] 保存流式状态失败:', e)
  );
}

// ==================== 多轮文本累积辅助 ====================
// Gateway 在每个 agent turn 开始时会重置 text（从 0 增长），
// 我们需要正确区分「同 turn 内增长」和「新 turn 开始」，
// 避免重复追加导致输出内容重复。

/**
 * 多轮文本累积：根据 base / lastDelta 正确拼接当前 delta
 * @returns { text: 新 currentAiText, base: 新 turnBase, delta: 新 lastTurnDelta }
 */
function accumulateText(
  cleaned: string,
  currentText: string,
  turnBase: string,
  lastTurnDelta: string,
): { text: string; base: string; delta: string } {
  if (!cleaned) return { text: currentText, base: turnBase, delta: lastTurnDelta };

  // Case 1: 文本超过当前总长度 → Gateway 发送完整累积文本（单 turn 模式）
  if (cleaned.length > currentText.length) {
    return { text: cleaned, base: turnBase, delta: cleaned };
  }

  // Case 2: 首个 delta 或同一 turn 内增长
  // 判断：如果 cleaned 以 lastTurnDelta 开头，说明是同一 turn 的增长
  const isSameTurn = !lastTurnDelta || cleaned.startsWith(lastTurnDelta);

  if (isSameTurn) {
    // 同 turn：替换当前 turn 部分
    const sep = turnBase ? '\n\n' : '';
    return { text: turnBase + sep + cleaned, base: turnBase, delta: cleaned };
  }

  // Case 3: 新 turn（cleaned 不以 lastTurnDelta 开头 → 文本被重置了）
  const newBase = currentText;
  return { text: currentText + '\n\n' + cleaned, base: newBase, delta: cleaned };
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
  blocks: MessageBlock[];
  thinkingBase: number; // thinking 长度基准（用于 blocks 切分）
  textBase: number;     // text 长度基准（用于 blocks 切分）
  turnBaseText: string;   // 上一轮的文本基线
  lastTurnDelta: string;  // 当前轮次最后一次 delta
  createdAt: number;
}
const bgStreams = new Map<string, BgStreamState>();
const sessionMessagesCache = new Map<string, Message[]>();
let historyRequestSerial = 0;
let sessionViewVersion = 0;

// ==================== 对话完成标记 ====================
// 只有 chat.final 才是真正的对话结束信号。
// agent.lifecycle end 仅结束当前一轮（agent 可能有多轮：工具调用 → 输出 → 继续）。
// 此标记用于区分"一轮结束"和"整个对话结束"，防止后续轮次的事件被误拦。
let _conversationFinalized = false;

// ==================== 流式超时保护 ====================
// 软超时：最后一次收到 **有实际内容** 的事件后 15 秒无新内容，自动 finalize。
// 硬超时：从 sendMessage 开始 3 分钟绝对上限，无论有无事件到达都会 finalize。
const STREAMING_SOFT_TIMEOUT_MS = 15_000;
const STREAMING_HARD_TIMEOUT_MS = 3 * 60 * 1000;
let _streamingSoftHandle: ReturnType<typeof setTimeout> | null = null;
let _streamingHardHandle: ReturnType<typeof setTimeout> | null = null;

function _resetStreamingSoftTimeout(finalizeFn: () => void) {
  if (_streamingSoftHandle) clearTimeout(_streamingSoftHandle);
  _streamingSoftHandle = setTimeout(() => {
    _streamingSoftHandle = null;
    finalizeFn();
  }, STREAMING_SOFT_TIMEOUT_MS);
}
function _startStreamingHardTimeout(finalizeFn: () => void) {
  if (_streamingHardHandle) clearTimeout(_streamingHardHandle);
  _streamingHardHandle = setTimeout(() => {
    _streamingHardHandle = null;
    finalizeFn();
  }, STREAMING_HARD_TIMEOUT_MS);
}
function _clearStreamingTimeout() {
  if (_streamingSoftHandle) {
    clearTimeout(_streamingSoftHandle);
    _streamingSoftHandle = null;
  }
  if (_streamingHardHandle) {
    clearTimeout(_streamingHardHandle);
    _streamingHardHandle = null;
  }
}

function stripThinkingBlocks(blocks?: MessageBlock[]): MessageBlock[] | undefined {
  if (!blocks?.length) return undefined;
  const filtered = blocks.filter((block) => block.type !== 'thinking');
  return filtered.length > 0 ? filtered : undefined;
}

function hideThinkingForDisplay(message: Message): Message {
  if (message.role !== 'assistant') return message;
  return {
    ...message,
    thinking: undefined,
    blocks: stripThinkingBlocks(message.blocks),
  };
}

function isPlaceholderSessionTitle(title?: string | null): boolean {
  return !title || title === '新对话' || title === '主对话';
}

function buildToolCallSignature(toolCalls?: ToolCall[]): string {
  if (!toolCalls?.length) return '';
  return toolCalls
    .map((tc) => `${tc.name}|${tc.status}|${tc.input || ''}|${tc.output || ''}`)
    .sort()
    .join('||');
}

function isDuplicateAssistantMessage(
  message: Message | undefined,
  content: string,
  thinking?: string,
  toolCalls?: ToolCall[],
): boolean {
  if (!message || message.role !== 'assistant') return false;
  const sameContent = message.content.trim() === content.trim();
  const sameThinking = (message.thinking || '').trim() === (thinking || '').trim();
  const sameTools = buildToolCallSignature(message.toolCalls) === buildToolCallSignature(toolCalls);
  return sameContent && sameThinking && sameTools;
}

function dedupeMessages(messages: Message[]): Message[] {
  const deduped: Message[] = [];
  for (const msg of messages) {
    const last = deduped[deduped.length - 1];
    if (!last) {
      deduped.push(msg);
      continue;
    }
    if (last.id === msg.id) {
      deduped[deduped.length - 1] = msg;
      continue;
    }
    if (
      last.sessionKey === msg.sessionKey
      && last.role === 'assistant'
      && msg.role === 'assistant'
      && isDuplicateAssistantMessage(last, msg.content, msg.thinking, msg.toolCalls)
    ) {
      deduped[deduped.length - 1] = msg;
      continue;
    }
    deduped.push(msg);
  }
  return deduped;
}

function looksLikeTranscriptLeak(text: string, historyMessages: Message[]): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.length < 80) return false;

  const candidates = historyMessages
    .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
    .map((msg) => msg.content.trim())
    .filter((content) => content.length >= 12);

  let hits = 0;
  for (const content of candidates) {
    if (normalized === content) continue;
    if (normalized.includes(content)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return false;
}

function resolveStreamingAssistantMessageId(
  state: ChatState,
  candidateId?: string,
): string {
  if (state.currentAiMessageId) return state.currentAiMessageId;

  const baseId = candidateId || `ai-${uuid()}`;
  const hasCollision = state.messages.some(
    (message) =>
      message.sessionKey === state.currentSessionKey
      && message.role === 'assistant'
      && message.id === baseId
      && !message.isStreaming
  );

  return hasCollision ? `${baseId}::${uuid()}` : baseId;
}

/** 处理非当前会话的 agent 事件 — 后台缓冲 */
function _bgHandleAgentEvent(payload: AgentEventPayload) {
  const sk = payload.sessionKey!;
  const { stream, data } = payload;

    if (stream === 'lifecycle') {
    if (data?.phase === 'start') {
      bgStreams.set(sk, {
        msgId: `ai-${uuid()}`,
        sessionKey: sk,
        text: '',
        thinking: '',
        toolCards: new Map(),
        blocks: [],
        thinkingBase: 0,
        textBase: 0,
        turnBaseText: '',
        lastTurnDelta: '',
        createdAt: Date.now(),
      });
    }
    if (data?.phase === 'end') {
      const bg = bgStreams.get(sk);
      if (bg && (bg.text || bg.thinking || bg.toolCards.size > 0)) {
        // 快照最后一个 thinking block + 剩余 text block
        const blocks = [...bg.blocks];
        if (bg.thinking.length > bg.thinkingBase) {
          const tc = bg.thinking.substring(bg.thinkingBase);
          if (blocks.length > 0 && blocks[blocks.length - 1].type === 'thinking') {
            blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], content: tc };
          } else {
            blocks.push({ type: 'thinking', content: tc });
          }
        }
        if (bg.text.length > bg.textBase) {
          const textSeg = bg.text.substring(bg.textBase).trim();
          if (textSeg) blocks.push({ type: 'text', content: textSeg });
        }
        const msg: Message = {
          id: bg.msgId,
          sessionKey: sk,
          role: 'assistant',
          content: bg.text,
          thinking: bg.thinking || undefined,
          toolCalls: bg.toolCards.size > 0 ? Array.from(bg.toolCards.values()) : undefined,
          blocks: blocks.length > 0 ? blocks : undefined,
          createdAt: bg.createdAt,
          isStreaming: false,
        };
        db.saveMessage(msg).catch((e) =>
          console.warn('[bg] 保存后台消息失败:', e)
        );
        // 持久化元数据到服务端
        if (msg.toolCalls?.length || msg.thinking || msg.blocks?.length) {
          apiClient.saveMessageMeta(sk, msg.id, {
            toolCalls: msg.toolCalls,
            thinking: msg.thinking,
            blocks: msg.blocks,
          }).catch(() => {});
        }
      }
      bgStreams.delete(sk);
    }
    return;
  }

  // 确保缓冲区存在
  if (!bgStreams.has(sk)) {
    bgStreams.set(sk, {
      msgId: `ai-${uuid()}`,
      sessionKey: sk,
      text: '',
      thinking: '',
      toolCards: new Map(),
      blocks: [],
      thinkingBase: 0,
      textBase: 0,
      turnBaseText: '',
      lastTurnDelta: '',
      createdAt: Date.now(),
    });
  }
  const bg = bgStreams.get(sk)!;

  if (stream === 'assistant') {
    const text = data?.text;
    if (text && typeof text === 'string') {
      const thinking = extractThinkingContent(text);
      const cleaned = stripThinkingTags(text);
      if (cleaned) {
        const acc = accumulateText(cleaned, bg.text, bg.turnBaseText, bg.lastTurnDelta);
        bg.text = acc.text;
        bg.turnBaseText = acc.base;
        bg.lastTurnDelta = acc.delta;
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
    const inputRaw = data?.input ?? data?.arguments ?? data?.params
      ?? data?.tool_input ?? data?.command ?? data?.query
      ?? data?.search_query ?? data?.file_path ?? data?.path
      ?? data?.code ?? data?.script;
    let outputRaw = data?.output ?? data?.result ?? data?.tool_result ?? data?.response;
    if (!outputRaw && data?.content) {
      outputRaw = extractContentBlockText(data.content) ?? data.content;
    }
    if (!outputRaw && data?.text && phase !== 'start') {
      outputRaw = data.text;
    }
    // 兜底 input
    let inputFallback: unknown = undefined;
    if (!inputRaw && data && phase === 'start') {
      const metaKeys = new Set(['toolCallId', 'id', 'tool_call_id', 'name', 'tool_name', 'phase', 'status', 'error', 'type', 'stream']);
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!metaKeys.has(k) && v !== undefined && v !== null && v !== '') extra[k] = v;
      }
      if (Object.keys(extra).length > 0) inputFallback = extra;
    }
    const inputStr = inputRaw
      ? (typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw, null, 2))
      : (inputFallback ? JSON.stringify(inputFallback, null, 2) : undefined);
    const outputStr = outputRaw
      ? (typeof outputRaw === 'string' ? outputRaw : JSON.stringify(outputRaw, null, 2))
      : undefined;
    const errorStr = data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : undefined;

    const isNew = !bg.toolCards.has(toolCallId as string);
    if (isNew) {
      // 新工具：先快照当前 thinking 段和 text 段，再添加 tool block
      if (bg.thinking.length > bg.thinkingBase) {
        const tc = bg.thinking.substring(bg.thinkingBase);
        if (bg.blocks.length > 0 && bg.blocks[bg.blocks.length - 1].type === 'thinking') {
          bg.blocks[bg.blocks.length - 1] = { type: 'thinking', content: tc };
        } else {
          bg.blocks.push({ type: 'thinking', content: tc });
        }
        bg.thinkingBase = bg.thinking.length;
      }
      if (bg.text.length > bg.textBase) {
        const textSeg = bg.text.substring(bg.textBase).trim();
        if (textSeg) bg.blocks.push({ type: 'text', content: textSeg });
        bg.textBase = bg.text.length;
      }
      bg.blocks.push({ type: 'tool', toolCallId: toolCallId as string });

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
    const rawMessageText = extractRawMessageText(payload.message);
    const text = extractText(payload.message);
    const thinking = rawMessageText ? extractThinkingContent(rawMessageText) : '';

    const bg = bgStreams.get(sk);
    const toolCalls = bg && bg.toolCards.size > 0
      ? Array.from(bg.toolCards.values())
      : undefined;
    const finalThinking = thinking || bg?.thinking || undefined;

    // 快照 blocks（补全 thinking + text 段）
    let blocks: MessageBlock[] | undefined;
    if (bg && bg.blocks.length > 0) {
      blocks = [...bg.blocks];
      if (bg.thinking.length > bg.thinkingBase) {
        const tc = bg.thinking.substring(bg.thinkingBase);
        if (blocks.length > 0 && blocks[blocks.length - 1].type === 'thinking') {
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], content: tc };
        } else {
          blocks.push({ type: 'thinking', content: tc });
        }
      }
      if (bg.text.length > bg.textBase) {
        const textSeg = bg.text.substring(bg.textBase).trim();
        if (textSeg) blocks.push({ type: 'text', content: textSeg });
      }
    }

    if (text || toolCalls) {
      const msg: Message = {
        id: (payload.message?.id as string) || bg?.msgId || `ai-${uuid()}`,
        sessionKey: sk,
        role: 'assistant',
        content: text || bg?.text || '',
        thinking: finalThinking,
        toolCalls,
        blocks,
        createdAt: Date.now(),
        isStreaming: false,
      };
      db.saveMessage(msg).catch((e) =>
        console.warn('[bg] 保存后台 final 消息失败:', e)
      );
      // 持久化元数据到服务端
      if (msg.toolCalls?.length || msg.thinking || msg.blocks?.length) {
        apiClient.saveMessageMeta(sk, msg.id, {
          toolCalls: msg.toolCalls,
          thinking: msg.thinking,
          blocks: msg.blocks,
        }).catch(() => {});
      }
    }
    bgStreams.delete(sk);
  }
}

export const useChatStore = create<ChatState>((set, get) => {
  // ==================== 事件处理 ====================

  function resetStreamingState(): Partial<ChatState> {
    _clearStreamingTimeout();
    return {
      isStreaming: false,
      currentAiText: '',
      currentAiThinking: '',
      currentAiMessageId: null,
      currentRunId: null,
      toolCards: new Map(),
      currentBlocks: [],
      _blockThinkingBase: 0,
      _blockTextBase: 0,
      _turnBaseText: '',
      _lastTurnDelta: '',
      lastAbortedUserMsgId: null,
    };
  }

  function finalizeStreamingAssistant(options?: {
    msgId?: string;
    finalText?: string;
    finalThinking?: string;
    createdAt?: number;
  }): Message | null {
    const state = get();
    const sessionKey = state.currentSessionKey;
    const msgId = options?.msgId || state.currentAiMessageId;
    const finalText = options?.finalText ?? state.currentAiText;
    const finalThinking = options?.finalThinking ?? state.currentAiThinking;
    const toolCalls = Array.from(state.toolCards.values());
    const hasContent = !!(finalText || finalThinking || toolCalls.length > 0);

    if (!sessionKey || !msgId || !hasContent) {
      set(resetStreamingState());
      return null;
    }

    const finalBlocks = _snapshotBlocks(state);
    const aiMsg: Message = {
      id: msgId,
      sessionKey,
      role: 'assistant',
      content: finalText || '',
      thinking: finalThinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      blocks: finalBlocks.length > 0 ? finalBlocks : undefined,
      createdAt: options?.createdAt ?? Date.now(),
      isStreaming: false,
    };

    set((s) => ({
      messages: dedupeMessages([
        ...s.messages.filter((m) => m.id !== msgId && m.id !== state.currentAiMessageId),
        aiMsg,
      ]),
      ...resetStreamingState(),
    }));

    db.saveMessage(aiMsg);

    if (aiMsg.toolCalls?.length || aiMsg.thinking || aiMsg.blocks?.length) {
      apiClient.saveMessageMeta(
        aiMsg.sessionKey,
        aiMsg.id,
        {
          toolCalls: aiMsg.toolCalls,
          thinking: aiMsg.thinking,
          blocks: aiMsg.blocks,
        }
      ).catch(() => {});
    }

    const nextMessages = dedupeMessages([
      ...state.messages.filter((m) => m.id !== msgId && m.id !== state.currentAiMessageId),
      aiMsg,
    ]);
    sessionMessagesCache.set(sessionKey, nextMessages);

    const currentSession = state.sessions.find((sess) => sess.key === sessionKey);
    const shouldGenerateTitle = state.messages.filter(m => m.role === 'assistant').length === 0
      && isPlaceholderSessionTitle(currentSession?.title);
    if (shouldGenerateTitle) {
      const firstUserMsg = state.messages.find(m => m.role === 'user');
      const sessionKeyForTitle = state.currentSessionKey;
      if (firstUserMsg && sessionKeyForTitle) {
        const fallbackTitle = extractAssistantTitleCandidate(finalText);
        if (fallbackTitle) {
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.key === sessionKeyForTitle
                ? { ...sess, title: fallbackTitle }
                : sess
            ),
          }));
          db.updateSessionTitle(sessionKeyForTitle, fallbackTitle).catch(() => {});
          apiClient.saveSessionTitle(sessionKeyForTitle, fallbackTitle).catch(() => {});
        }

        requestAITitle(firstUserMsg.content, finalText, sessionKeyForTitle)
          .then((title) => {
            if (!title || title === '新对话') return;
            const cleanTitle = title.length > 25 ? title.substring(0, 25) + '…' : title;
            console.log('[store] AI 生成标题:', cleanTitle, '会话:', sessionKeyForTitle);
            set((s) => ({
              sessions: s.sessions.map((sess) =>
                sess.key === sessionKeyForTitle
                  ? { ...sess, title: cleanTitle }
                  : sess
              ),
            }));
            db.updateSessionTitle(sessionKeyForTitle, cleanTitle).catch(() => {});
            apiClient.saveSessionTitle(sessionKeyForTitle, cleanTitle).catch(() => {});
          })
          .catch((e) => console.warn('[store] AI 标题生成失败:', e));
      }
    }

    return aiMsg;
  }

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
      // 只有在 chat.final 已经处理后（整个对话真正结束），才忽略迟到的 delta。
      // agent.lifecycle end 仅结束当前一轮，后续轮次的 delta 不应被拦截。
      if (_conversationFinalized) return;

      const rawMessageText = extractRawMessageText(payload.message);
      const text = extractText(payload.message);
      const thinking = rawMessageText ? extractThinkingContent(rawMessageText) : '';

      // 只有当 delta 携带实际内容时才重置软超时（避免空心跳事件无限续命）
      const hasContentInDelta = !!(text || thinking || (Array.isArray(payload.message?.content) && payload.message!.content.length > 0));
      if (hasContentInDelta) {
        _resetStreamingSoftTimeout(() => {
          const s = get();
          if (s.isStreaming && s.currentAiMessageId) {
            console.warn('[store] 流式软超时 (15s 无新内容)，自动 finalize');
            finalizeStreamingAssistant();
          }
        });
      }
      const msgId = resolveStreamingAssistantMessageId(state, payload.message?.id as string | undefined);

      const updates: Record<string, unknown> = {
        isStreaming: true,
        currentAiMessageId: msgId,
        currentRunId: payload.runId || state.currentRunId,
        lastAbortedUserMsgId: null,
      };

      // ====== Agent 模式下跳过文本/思维链累积 ======
      // 当 agent 事件流（handleAgentEvent）正在运行时，
      // 文本和思维链由 agent 事件准确分离后累积。
      // chat 事件可能携带不同格式的相同内容（如不带 <think> 标签的纯文本），
      // 导致思维链内容泄漏到 currentAiText 中出现重复。
      // 因此在 agent 模式下仅处理 tool_use 块，跳过文本累积。
      const isAgentMode = !!(state.currentRunId || payload.runId);
      if (!isAgentMode) {
        // 文本累积（使用多轮累积辅助函数，防止重复追加）
        if (text) {
          const acc = accumulateText(text, state.currentAiText, state._turnBaseText, state._lastTurnDelta);
          updates.currentAiText = acc.text;
          updates._turnBaseText = acc.base;
          updates._lastTurnDelta = acc.delta;
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
      } else if (thinking) {
        // agent 模式下仍允许 chat 事件补充 thinking；
        // 只跳过 text，避免与 agent assistant 流重复累积正文。
        if (thinking.length > state.currentAiThinking.length) {
          updates.currentAiThinking = thinking;
        } else if (!state.currentAiThinking.endsWith(thinking)) {
          updates.currentAiThinking = state.currentAiThinking
            ? state.currentAiThinking + '\n\n---\n\n' + thinking
            : thinking;
        }
      }

      // ====== 从 delta 消息中提取 tool_use 块（工具调用输入）======
      const msgContent = payload.message?.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          const b = block as unknown as Record<string, unknown>;
          if (b.type === 'tool_use' && (b.id || b.tool_use_id)) {
            const tcId = (b.id || b.tool_use_id) as string;
            const tcName = (b.name as string) || 'tool';
            const inputRaw = b.input;
            const inputStr = inputRaw
              ? (typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw, null, 2))
              : undefined;
            set((s) => {
              const toolCards = new Map(s.toolCards);
              const isNewTc = !toolCards.has(tcId);
              if (isNewTc) {
                toolCards.set(tcId, {
                  id: tcId,
                  name: tcName,
                  status: 'running',
                  input: inputStr,
                  startedAt: Date.now(),
                });
              } else {
                const existing = toolCards.get(tcId)!;
                toolCards.set(tcId, { ...existing, input: inputStr || existing.input });
              }
              // 追踪 blocks 顺序
              let currentBlocks = s.currentBlocks;
              let _blockThinkingBase = s._blockThinkingBase;
              let _blockTextBase = s._blockTextBase;
              if (isNewTc) {
                currentBlocks = [...currentBlocks];
                if (s.currentAiThinking.length > _blockThinkingBase) {
                  const seg = s.currentAiThinking.substring(_blockThinkingBase);
                  if (currentBlocks.length > 0 && currentBlocks[currentBlocks.length - 1].type === 'thinking') {
                    currentBlocks[currentBlocks.length - 1] = { type: 'thinking', content: seg };
                  } else {
                    currentBlocks.push({ type: 'thinking', content: seg });
                  }
                  _blockThinkingBase = s.currentAiThinking.length;
                }
                if (s.currentAiText.length > _blockTextBase) {
                  const textSeg = s.currentAiText.substring(_blockTextBase).trim();
                  if (textSeg) currentBlocks.push({ type: 'text', content: textSeg });
                  _blockTextBase = s.currentAiText.length;
                }
                currentBlocks.push({ type: 'tool', toolCallId: tcId });
              }
              return { toolCards, currentBlocks, _blockThinkingBase, _blockTextBase };
            });
          }
          // 也提取 tool_result 块（工具调用输出）
          if (b.type === 'tool_result' && (b.tool_use_id || b.id)) {
            const tcId = (b.tool_use_id || b.id) as string;
            const outputText = extractContentBlockText(b.content) || (b.output as string);
            if (outputText) {
              set((s) => {
                const toolCards = new Map(s.toolCards);
                if (toolCards.has(tcId)) {
                  const existing = toolCards.get(tcId)!;
                  toolCards.set(tcId, {
                    ...existing,
                    output: outputText,
                    status: b.is_error ? 'error' : 'done',
                    finishedAt: Date.now(),
                  });
                }
                return { toolCards };
              });
            }
          }
        }
      }

      // 始终更新基础状态（isStreaming, msgId, runId）；
      // 在非 agent 模式下还会包含 text/thinking 更新
      if (text || thinking || isAgentMode) set(updates as Partial<ChatState>);
      return;
    }

    if (chatState === 'final') {
      // chat.final 是对话的真正结束信号，标记对话已完成。
      // 后续到达的 delta / agent 事件将被 _conversationFinalized 拦截。
      _conversationFinalized = true;

      const rawMessageText = extractRawMessageText(payload.message);
      const text = extractText(payload.message);
      const thinking = rawMessageText ? extractThinkingContent(rawMessageText) : '';
      const currentText = state.currentAiText;

      // 忽略空 final
      if (!state.currentAiMessageId && !text) return;

      const msgId = state.currentAiMessageId || resolveStreamingAssistantMessageId(state, payload.message?.id as string | undefined);
      const payloadLooksLeaked = !!text && looksLikeTranscriptLeak(text, state.messages);
      const currentLooksLeaked = !!currentText && looksLikeTranscriptLeak(currentText, state.messages);
      const finalText = payloadLooksLeaked && currentText && !currentLooksLeaked
        ? currentText
        : (text || currentText);
      const finalThinking = thinking || state.currentAiThinking;

      const lastAssistantMsg = [...state.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.sessionKey === (state.currentSessionKey || ''));
      const shouldIgnoreLateDuplicate = !state.isStreaming && (
        ((payload.message?.id as string | undefined) && lastAssistantMsg?.id === payload.message?.id) ||
        isDuplicateAssistantMessage(lastAssistantMsg, finalText, finalThinking, Array.from(state.toolCards.values()))
      );
      if (shouldIgnoreLateDuplicate) {
        set({ isStreaming: false, currentRunId: null });
        return;
      }

      if (finalText || finalThinking || state.toolCards.size > 0) {
        const hadNoAssistantReply = state.messages.filter(m => m.role === 'assistant').length === 0;
        finalizeStreamingAssistant({
          msgId,
          finalText,
          finalThinking,
          createdAt: Date.now(),
        });
        if (hadNoAssistantReply) {
          // 同时刷新会话列表（确保新会话出现在列表中）
          setTimeout(() => get().loadSessions(), 500);
        }
        if (payloadLooksLeaked || currentLooksLeaked) {
          setTimeout(() => {
            get().loadHistory().catch(() => {});
          }, 0);
        }
      } else {
        set(resetStreamingState());
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
          currentBlocks: [],
          _blockThinkingBase: 0,
          _blockTextBase: 0,
          _turnBaseText: '',
          _lastTurnDelta: '',
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
          currentBlocks: [],
          _blockThinkingBase: 0,
          _blockTextBase: 0,
          _turnBaseText: '',
          _lastTurnDelta: '',
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
          currentBlocks: [],
          _blockThinkingBase: 0,
          _blockTextBase: 0,
          _turnBaseText: '',
          _lastTurnDelta: '',
      }));
      return;
    }
  }

  /** 处理 agent 事件 */
  function handleAgentEvent(payload: AgentEventPayload) {
    // ====== 拦截标题生成会话的 agent 事件 ======
    if (payload.sessionKey && titleGenMap.has(payload.sessionKey)) {
      const gen = titleGenMap.get(payload.sessionKey)!;
      const text = typeof payload.data?.text === 'string'
        ? stripThinkingTags(payload.data.text).trim()
        : '';
      if (payload.stream === 'assistant' && text) {
        gen.accumText = text;
      } else if (payload.stream === 'lifecycle') {
        const phase = String(payload.data?.phase || '').toLowerCase();
        if (phase === 'end') {
          gen.resolve(gen.accumText.trim() || '新对话');
        } else if (phase === 'error' || phase === 'aborted') {
          gen.resolve(gen.accumText.trim() || '新对话');
        }
      }
      return;
    }

    const state = get();
    // 非当前会话 → 路由到后台缓冲区（不丢弃）
    if (payload.sessionKey && payload.sessionKey !== state.currentSessionKey) {
      _bgHandleAgentEvent(payload);
      return;
    }

    const { stream, data } = payload;

    if (stream === 'lifecycle') {
      if (data?.phase === 'start') {
        // 如果整个对话已经被 chat.final 标记为完成，忽略迟到的 lifecycle.start。
        // 但如果只是某一轮结束（lifecycle end），下一轮的 start 应该放行。
        if (_conversationFinalized) return;
        set({
          isStreaming: true,
          currentRunId: payload.runId || null,
          lastAbortedUserMsgId: null,
        });
        // lifecycle.start 重置软超时（相当于"流刚开始"）
        _resetStreamingSoftTimeout(() => {
          const s = get();
          if (s.isStreaming && s.currentAiMessageId) {
            console.warn('[store] 流式软超时 (15s 无新内容)，自动 finalize');
            finalizeStreamingAssistant();
          }
        });
      }
      if (data?.phase === 'end') {
        const current = get();
        const hasPendingContent = !!(
          current.currentAiText ||
          current.currentAiThinking ||
          current.toolCards.size > 0
        );

        if (hasPendingContent) {
          finalizeStreamingAssistant();
        } else {
          set(resetStreamingState());
          // 没有累积到任何内容但 lifecycle 结束了，说明文本可能通过 chat 通道传递
          // 延迟加载历史确保消息不丢
          if (current.currentSessionKey) {
            setTimeout(() => get().loadHistory().catch(() => {}), 500);
          }
        }
      }
      return;
    }

    // assistant 流 — 高频文本累积 + 思维链提取
    // 注意：agent 模式下工具调用之间，text 可能从头开始（新 turn）
    if (stream === 'assistant') {
      // 只有 chat.final 后才忽略迟到的 assistant 事件。
      if (_conversationFinalized) return;

      const text = data?.text;
      if (text && typeof text === 'string') {
        // 有实际文本内容时才重置软超时
        _resetStreamingSoftTimeout(() => {
          const s = get();
          if (s.isStreaming && s.currentAiMessageId) {
            console.warn('[store] 流式软超时 (15s 无新内容)，自动 finalize');
            finalizeStreamingAssistant();
          }
        });
        const thinking = extractThinkingContent(text);
        const cleaned = stripThinkingTags(text);
        const msgId = resolveStreamingAssistantMessageId(state);

        const updates: Partial<ChatState> = {
          currentAiMessageId: msgId,
          currentRunId: payload.runId || state.currentRunId,
        };

        if (cleaned) {
          const acc = accumulateText(cleaned, state.currentAiText, state._turnBaseText, state._lastTurnDelta);
          updates.currentAiText = acc.text;
          updates._turnBaseText = acc.base;
          updates._lastTurnDelta = acc.delta;
        }

        if (thinking) {
          if (thinking.length > state.currentAiThinking.length) {
            updates.currentAiThinking = thinking;
          } else if (!state.currentAiThinking.endsWith(thinking)) {
            updates.currentAiThinking = state.currentAiThinking
              ? state.currentAiThinking + '\n\n---\n\n' + thinking
              : thinking;
          }
        }

        if (updates.currentAiText !== undefined || updates.currentAiThinking) {
          set(updates as ChatState);
        }
      }
      return;
    }

    // tool 流
    if (stream === 'tool') {
      // 只有 chat.final 后才忽略迟到的 tool 事件
      if (_conversationFinalized) return;
      const toolCallId = data?.toolCallId || data?.id || data?.tool_call_id;
      if (!toolCallId) return;
      const name = (data?.name as string) || (data?.tool_name as string) || 'tool';
      const phase = (data?.phase as string) || (data?.status as string) || '';

      // 提取工具 input — 尝试多种字段路径（覆盖不同 Gateway 格式）
      const inputRaw = data?.input ?? data?.arguments ?? data?.params
        ?? data?.tool_input ?? data?.command ?? data?.query
        ?? data?.search_query ?? data?.file_path ?? data?.path
        ?? data?.code ?? data?.script;
      // 提取工具 output — 尝试多种字段路径 + content block 数组解析
      let outputRaw = data?.output ?? data?.result ?? data?.tool_result ?? data?.response;
      if (!outputRaw && data?.content) {
        // content 可能是 [{type:"text", text:"..."}] 格式
        outputRaw = extractContentBlockText(data.content) ?? data.content;
      }
      if (!outputRaw && data?.text && phase !== 'start') {
        outputRaw = data.text;
      }
      // 兜底：如果没有匹配到任何已知字段，提取 data 中除元数据外的所有字段作为 input
      let inputFallback: unknown = undefined;
      if (!inputRaw && data && phase === 'start') {
        const metaKeys = new Set(['toolCallId', 'id', 'tool_call_id', 'name', 'tool_name', 'phase', 'status', 'error', 'type', 'stream']);
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          if (!metaKeys.has(k) && v !== undefined && v !== null && v !== '') extra[k] = v;
        }
        if (Object.keys(extra).length > 0) inputFallback = extra;
      }
      // 序列化
      const inputStr = inputRaw
        ? (typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw, null, 2))
        : (inputFallback ? JSON.stringify(inputFallback, null, 2) : undefined);
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
        const isNew = !toolCards.has(toolCallId as string);

        if (isNew) {
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
            name: name !== 'tool' ? name : existing.name,
            status: phase === 'error' ? 'error' : (isFinished ? 'done' : existing.status),
            input: inputStr || existing.input,
            output: outputStr || errorStr || existing.output,
            finishedAt: isFinished ? Date.now() : existing.finishedAt,
          });
        }

        // ====== 追踪 blocks 顺序 ======
        let currentBlocks = s.currentBlocks;
        let _blockThinkingBase = s._blockThinkingBase;
        let _blockTextBase = s._blockTextBase;
        if (isNew) {
          currentBlocks = [...currentBlocks];
          // 快照当前 thinking 段到 block 中
          if (s.currentAiThinking.length > _blockThinkingBase) {
            const thinkSeg = s.currentAiThinking.substring(_blockThinkingBase);
            if (currentBlocks.length > 0 && currentBlocks[currentBlocks.length - 1].type === 'thinking') {
              currentBlocks[currentBlocks.length - 1] = { type: 'thinking', content: thinkSeg };
            } else {
              currentBlocks.push({ type: 'thinking', content: thinkSeg });
            }
            _blockThinkingBase = s.currentAiThinking.length;
          }
          // 快照当前 text 段到 block 中
          if (s.currentAiText.length > _blockTextBase) {
            const textSeg = s.currentAiText.substring(_blockTextBase).trim();
            if (textSeg) {
              currentBlocks.push({ type: 'text', content: textSeg });
            }
            _blockTextBase = s.currentAiText.length;
          }
          // 添加 tool block
          currentBlocks.push({ type: 'tool', toolCallId: toolCallId as string });
        }

        return { toolCards, currentBlocks, _blockThinkingBase, _blockTextBase };
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
    isHistoryLoading: false,
    isStreaming: false,
    currentRunId: null,
    currentAiText: '',
    currentAiThinking: '',
    currentAiMessageId: null,
    toolCards: new Map(),
    currentBlocks: [],
    _blockThinkingBase: 0,
    _blockTextBase: 0,
    _turnBaseText: '',
    _lastTurnDelta: '',
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
          isHistoryLoading: false,
        });
        sessionViewVersion++;

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
      sessionViewVersion++;
      set({
        connectionStatus: 'disconnected',
        serverConfig: null,
        userId: null,
        username: null,
        currentSessionKey: null,
        messages: [],
        sessions: [],
        isHistoryLoading: false,
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        currentBlocks: [],
        _blockThinkingBase: 0,
        _blockTextBase: 0,
        _turnBaseText: '',
        _lastTurnDelta: '',
        lastAbortedUserMsgId: null,
      });
    },

    sendMessage: async (content: string, attachments?: FileAttachment[]) => {
      let state = get();
      let sessionKey = state.currentSessionKey;
      if (!sessionKey) return;

      // ——— 如果当前 session 不在列表中，说明是新会话的第一条消息 ———
      const isNewSession = !state.sessions.some((s) => s.key === sessionKey);
      // 已存在的历史会话在重装/重开后，若消息尚未恢复出来，先补拉历史再发送，
      // 避免挂起的历史加载被中途覆盖，导致用户看到旧消息瞬间消失。
      if (!isNewSession && state.messages.length === 0) {
        await get().loadHistory();
        state = get();
        sessionKey = state.currentSessionKey;
        if (!sessionKey) return;
      }

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
        // 立即持久化，避免被稍后一次 loadSessions 覆盖掉
        db.saveSession(newSession).catch(() => {});
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
      const pendingAiMsgId = `ai-${uuid()}`;
      // 新一轮对话开始，重置"对话已完成"标记，允许事件正常处理。
      _conversationFinalized = false;
      // 发送新问题前强制清空上一轮遗留的流式缓存，
      // 避免旧的 assistant 临时状态混入本轮，导致历史消失或最后一条串接前文。
      bgStreams.delete(sessionKey);
      set((s) => {
        const nextMessages = [...s.messages, userMsg];
        sessionMessagesCache.set(sessionKey, nextMessages);
        return {
          ...resetStreamingState(),
          messages: nextMessages,
          isStreaming: true,
          currentAiMessageId: pendingAiMsgId,
          lastAbortedUserMsgId: null,
        };
      });
      db.saveMessage(userMsg);

      // 构造 Gateway 附件格式
      const gatewayAttachments = attachments?.map((att) => ({
        content: att.base64 || '',
        mimeType: att.type,
        fileName: att.name,
        category: att.type.startsWith('image/') ? 'image' : 'file',
      }));

      // 启动双重超时保护：
      // - 软超时 (15s)：最后一次有实际内容的事件后 15 秒无新内容则 finalize
      // - 硬超时 (3min)：绝对上限，无论有无事件都会 finalize，防止彻底卡死
      const _autoFinalize = () => {
        const s = get();
        if (s.isStreaming || s.currentAiMessageId) {
          console.warn('[store] 流式超时，自动 finalize');
          _conversationFinalized = true; // 超时也标记对话完成，拦截后续迟到事件
          if (s.currentAiText || s.currentAiThinking || s.toolCards.size > 0) {
            finalizeStreamingAssistant();
          } else {
            set(resetStreamingState());
          }
          // 超时 finalize 后从历史恢复，确保不丢消息
          if (s.currentSessionKey) {
            setTimeout(() => get().loadHistory().catch(() => {}), 300);
          }
        }
      };
      _resetStreamingSoftTimeout(_autoFinalize);
      _startStreamingHardTimeout(_autoFinalize);

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
        set((s) => {
          const nextMessages = [...s.messages, errMsg];
          sessionMessagesCache.set(sessionKey, nextMessages);
          return {
            messages: nextMessages,
            isStreaming: false,
          };
        });
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
        currentBlocks: [],
        _blockThinkingBase: 0,
        _blockTextBase: 0,
        _turnBaseText: '',
        _lastTurnDelta: '',
        lastAbortedUserMsgId: lastUserMsg?.id || null,
      });
    },

    switchSession: (key: string) => {
      const state = get();
      const viewVersion = ++sessionViewVersion;
      if (state.currentSessionKey && state.messages.length > 0) {
        sessionMessagesCache.set(state.currentSessionKey, state.messages);
      }
      // ——— 切换前：保存正在流式输出的 AI 消息到 DB + bgStreams ———
      _saveStreamingStateToDb(state);

      // 关键：如果当前会话正在流式输出，将完整状态移入 bgStreams
      // 这样后续 SSE 事件能在已有状态基础上继续积累（而不是从零开始）
      if (state.isStreaming && state.currentSessionKey && state.currentSessionKey !== key) {
        const sk = state.currentSessionKey;
        if (!bgStreams.has(sk)) {
          bgStreams.set(sk, {
            msgId: state.currentAiMessageId || `ai-${uuid()}`,
            sessionKey: sk,
            text: state.currentAiText,
            thinking: state.currentAiThinking,
            toolCards: new Map(state.toolCards),
            blocks: [...state.currentBlocks],
            thinkingBase: state._blockThinkingBase,
            textBase: state._blockTextBase,
            turnBaseText: state._turnBaseText,
            lastTurnDelta: state._lastTurnDelta,
            createdAt: Date.now(),
          });
          console.debug(`[store] 流式状态转入后台: ${sk} (blocks=${state.currentBlocks.length} tools=${state.toolCards.size})`);
        }
      }

      set({
        currentSessionKey: key,
        messages: sessionMessagesCache.get(key) || [],
        isHistoryLoading: false,
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        currentBlocks: [],
        _blockThinkingBase: 0,
        _blockTextBase: 0,
        _turnBaseText: '',
        _lastTurnDelta: '',
        lastAbortedUserMsgId: null,
      });
      localStorage.setItem('clawchat-session-key', key);

      // 检查目标会话是否有后台流式缓冲区（切走时还在输出的那段）
      const bg = bgStreams.get(key);
      if (bg) {
        // 将后台缓冲区的状态"提升"到前台（包括 blocks 和 turn 追踪）
        set({
          currentAiMessageId: bg.msgId,
          currentAiText: bg.text,
          currentAiThinking: bg.thinking,
          toolCards: new Map(bg.toolCards),
          currentBlocks: bg.blocks,
          _blockThinkingBase: bg.thinkingBase,
          _blockTextBase: bg.textBase,
          _turnBaseText: bg.turnBaseText,
          _lastTurnDelta: bg.lastTurnDelta,
          isStreaming: true,
        });
        bgStreams.delete(key);
        db.getMessages(key)
          .then((localMessages) => {
            const current = get();
            if (sessionViewVersion !== viewVersion || current.currentSessionKey !== key || current.currentAiMessageId !== bg.msgId) return;

            const cachedMessages = sessionMessagesCache.get(key) || [];
            const baseMessages = localMessages.length >= cachedMessages.length ? localMessages : cachedMessages;
            const partialMsg = localMessages.find((m) => m.id === bg.msgId);
            const mergedText = partialMsg && partialMsg.content.length > current.currentAiText.length
              ? partialMsg.content
              : current.currentAiText;
            const mergedToolCards = new Map(current.toolCards);
            if (partialMsg?.toolCalls?.length) {
              for (const tc of partialMsg.toolCalls) {
                const existing = mergedToolCards.get(tc.id);
                mergedToolCards.set(tc.id, existing ? { ...tc, ...existing } : tc);
              }
            }
            const mergedBlocks = stripThinkingBlocks(partialMsg?.blocks?.length ? partialMsg.blocks : current.currentBlocks) || [];

            set({
              messages: baseMessages
                .filter((m) => m.id !== bg.msgId)
                .map(hideThinkingForDisplay),
              currentAiText: mergedText,
              currentAiThinking: '',
              toolCards: mergedToolCards,
              currentBlocks: mergedBlocks,
              _blockThinkingBase: 0,
              _blockTextBase: mergedText.length,
              isStreaming: true,
            });
            sessionMessagesCache.set(
              key,
              baseMessages.filter((m) => m.id !== bg.msgId).map(hideThinkingForDisplay)
            );
          })
          .catch(() => {});
        return;
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
      sessionViewVersion++;

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
        isHistoryLoading: false,
        isStreaming: false,
        currentAiText: '',
        currentAiThinking: '',
        currentAiMessageId: null,
        currentRunId: null,
        toolCards: new Map(),
        currentBlocks: [],
        _blockThinkingBase: 0,
        _blockTextBase: 0,
        _turnBaseText: '',
        _lastTurnDelta: '',
        lastAbortedUserMsgId: null,
      });
      localStorage.setItem('clawchat-session-key', newKey);
    },

    loadHistory: async () => {
      const state = get();
      const sessionKey = state.currentSessionKey;
      if (!sessionKey || !apiClient.gatewayReady) return;
      const requestSerial = ++historyRequestSerial;
      const viewVersion = sessionViewVersion;
      set({ isHistoryLoading: true });

      const finishHistoryLoading = () => {
        const current = get();
        if (
          requestSerial === historyRequestSerial
          && viewVersion === sessionViewVersion
          && current.currentSessionKey === sessionKey
        ) {
          set({ isHistoryLoading: false });
        }
      };

      try {
        const result = (await apiClient.chatHistory(sessionKey)) as {
          messages?: ChatMessage[];
        };
        if (requestSerial !== historyRequestSerial || viewVersion !== sessionViewVersion || get().currentSessionKey !== sessionKey) {
          return;
        }
        if (!result?.messages?.length) {
          // Gateway 无记录，尝试加载本地 DB
          const localMessages = await db.getMessages(sessionKey);
          if (requestSerial !== historyRequestSerial || viewVersion !== sessionViewVersion || get().currentSessionKey !== sessionKey) {
            return;
          }
          if (localMessages.length > 0) {
            const nextMessages = dedupeMessages(localMessages.map(hideThinkingForDisplay));
            sessionMessagesCache.set(sessionKey, nextMessages);
            set({ messages: nextMessages, isHistoryLoading: false });
          } else {
            finishHistoryLoading();
          }
          return;
        }

        // ====== 预处理：收集 Gateway 中的 tool_result（用于恢复工具调用输出）======
        const gwToolResults = new Map<string, { output: string; isError?: boolean; timestamp?: number }>();
        for (const msg of result.messages) {
          const role = msg.role as string;

          // 工具角色消息 — 可能是 string 或 array content
          if (role === 'tool' || role === 'tool_result' || role === 'toolResult') {
            const tcId = extractToolCallId(msg as Record<string, unknown>);
            if (tcId) {
              let output = '';
              if (typeof msg.content === 'string') {
                output = msg.content;
              } else if (Array.isArray(msg.content)) {
                output = extractContentBlockText(msg.content) || '';
              }
              if (output) {
                const msgRec = msg as Record<string, unknown>;
                gwToolResults.set(tcId, {
                  output,
                  isError: !!(msgRec.is_error ?? msgRec.isError),
                  timestamp: msg.timestamp || Date.now(),
                });
              }
            }
          }

          // 用户消息中可能嵌入 tool_result 块（Anthropic 格式）
          if (Array.isArray(msg.content)) {
            for (const block of msg.content as ContentBlock[]) {
              const b = block as unknown as Record<string, unknown>;
              if (b.type === 'tool_result' && (b.tool_use_id || b.id)) {
                const tcId = (b.tool_use_id || b.id) as string;
                const output = extractContentBlockText(b.content) || (b.output as string) || (b.text as string) || '';
                if (output) {
                  gwToolResults.set(tcId, { output, isError: !!(b.is_error), timestamp: msg.timestamp || Date.now() });
                }
              }
            }
          }
        }
        console.debug(`[store] loadHistory: gwToolResults collected ${gwToolResults.size} tool results`);

        // ====== 并行加载：本地 DB 消息 + 服务端附件 + 服务端元数据 ======
        const [localMessages, serverAttachments, serverMeta] = await Promise.all([
          db.getMessages(sessionKey),
          apiClient.getSessionAttachments(sessionKey).catch(() => []),
          apiClient.getSessionMeta(sessionKey).catch(() => [] as Array<{messageId: string; toolCalls?: ToolCall[]; thinking?: string; blocks?: MessageBlock[]}>),
        ]);

        // 构建服务端元数据索引（messageId → meta）+ 文本匹配索引
        type MetaEntry = { toolCalls?: ToolCall[]; thinking?: string; blocks?: MessageBlock[] };
        const serverMetaById = new Map<string, MetaEntry>();
        const serverMetaByText = new Map<string, MetaEntry>();
        for (const m of serverMeta) {
          if (m.messageId) serverMetaById.set(m.messageId, m);
          // 同时用 toolCalls 中的信息构建文本匹配索引（用于 ID 不匹配时的回退）
          if (m.toolCalls?.length) {
            // 用工具名列表作为辅助匹配键
            const toolKey = m.toolCalls.map((tc: ToolCall) => tc.name).sort().join(',');
            if (toolKey) serverMetaByText.set(toolKey, m);
          }
        }

        // 构建本地 DB 附件匹配索引 + 工具调用索引
        const localAttById = new Map<string, FileAttachment[]>();
        const localAttByText = new Map<string, FileAttachment[]>();
        const localUserMsgsWithAtt: { content: string; attachments: FileAttachment[] }[] = [];
        const localToolCallsById = new Map<string, ToolCall[]>();
        const localToolCallsByText = new Map<string, ToolCall[]>();
        const localThinkingById = new Map<string, string>();
        const localThinkingByText = new Map<string, string>();
        const localBlocksById = new Map<string, MessageBlock[]>();
        const localBlocksByText = new Map<string, MessageBlock[]>();

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
          // 收集 blocks 顺序数据（用于交错渲染恢复）
          if (lm.blocks && lm.blocks.length > 0 && lm.role === 'assistant') {
            localBlocksById.set(lm.id, lm.blocks);
            const bKey = lm.content.substring(0, 50).trim();
            if (bKey) localBlocksByText.set(bKey, lm.blocks);
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
        const localAssistantMetaCandidates = localMessages.filter(
          (lm) => lm.role === 'assistant' && (lm.toolCalls?.length || lm.thinking || lm.blocks?.length)
        );
        let localAssistantMetaIdx = 0;

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

          // ====== 恢复工具调用 + 思维链 + blocks 数据 ======
          // 优先级：Gateway 消息内容解析 → 服务端元数据 → 本地 IndexedDB
          let toolCalls: ToolCall[] | undefined;
          let thinking: string | undefined;
          let blocks: MessageBlock[] | undefined;
          if (role === 'assistant') {
            const msgId = msg.id as string;
            const tcKey = text.substring(0, 50).trim();

            // ① 从 Gateway 消息 content 数组解析 tool_use 块（即使重装也可恢复）
            let gwToolCalls: ToolCall[] | undefined;
            let gwBlocks: MessageBlock[] | undefined;
            let gwThinking: string | undefined;
            if (Array.isArray(msg.content)) {
              const parsedTc: ToolCall[] = [];
              const parsedBlocks: MessageBlock[] = [];
              let hasThinkingBlock = false;
              for (const block of msg.content as ContentBlock[]) {
                const b = block as unknown as Record<string, unknown>;
                if (b.type === 'thinking' && typeof b.thinking === 'string') {
                  // Anthropic 格式 thinking block
                  parsedBlocks.push({ type: 'thinking', content: b.thinking as string });
                  hasThinkingBlock = true;
                } else if (b.type === 'text' && typeof b.text === 'string') {
                  const thk = extractThinkingContent(b.text as string);
                  const clean = stripThinkingTags(b.text as string);
                  if (thk) parsedBlocks.push({ type: 'thinking', content: thk });
                  if (clean.trim()) parsedBlocks.push({ type: 'text', content: clean.trim() });
                } else if ((b.type === 'tool_use' || b.type === 'toolCall') && extractToolCallId(b)) {
                  const tcId = extractToolCallId(b)!;
                  const tcName = extractToolCallName(b);
                  const inputRaw = b.input ?? b.arguments ?? b.params;
                  const inputStr = stringifyToolPayload(inputRaw);
                  // 查找对应的 tool_result
                  const resultInfo = gwToolResults.get(tcId);
                  parsedTc.push({
                    id: tcId,
                    name: tcName,
                    status: resultInfo ? (resultInfo.isError ? 'error' : 'done') : 'done',
                    input: inputStr,
                    output: resultInfo?.output,
                    startedAt: msg.timestamp || Date.now(),
                    finishedAt: resultInfo?.timestamp,
                  });
                  parsedBlocks.push({ type: 'tool', toolCallId: tcId });
                }
              }
              if (parsedTc.length > 0) gwToolCalls = parsedTc;
              if (parsedBlocks.length > 0) gwBlocks = parsedBlocks;
              if (hasThinkingBlock) {
                gwThinking = parsedBlocks
                  .filter(b => b.type === 'thinking' && b.content)
                  .map(b => b.content!)
                  .join('\n\n---\n\n');
              }
            }

            // ② 提取 <thinking> 标签中的思维链（通用兼容）
            const rawTextContent = typeof msg.content === 'string' ? msg.content : '';
            const tagThinking = rawTextContent ? extractThinkingContent(rawTextContent) : '';

            const hasGatewayStructuredMeta = !!(gwBlocks?.length || gwToolCalls?.length || gwThinking || tagThinking);

            // ③ 从服务端元数据恢复（先按 ID，再按工具名列表匹配）
            let sMeta = msgId ? serverMetaById.get(msgId) : undefined;
            if (!sMeta && !hasGatewayStructuredMeta && gwToolCalls?.length) {
              const toolKey = gwToolCalls.map((tc: ToolCall) => tc.name).sort().join(',');
              if (toolKey) sMeta = serverMetaByText.get(toolKey);
            }

            // ④ 从本地 IndexedDB 恢复
            const localTc = (msgId ? localToolCallsById.get(msgId) : undefined)
              || (tcKey ? localToolCallsByText.get(tcKey) : undefined);
            const localThk = (msgId ? localThinkingById.get(msgId) : undefined)
              || (tcKey ? localThinkingByText.get(tcKey) : undefined);
            const localBlk = (msgId ? localBlocksById.get(msgId) : undefined)
              || (tcKey ? localBlocksByText.get(tcKey) : undefined);
            const localSeqMeta = localAssistantMetaCandidates[localAssistantMetaIdx];
            const canUseLocalSeqMeta = !!localSeqMeta
              && !gwToolCalls
              && !gwThinking
              && !sMeta?.toolCalls
              && !sMeta?.thinking
              && !sMeta?.blocks
              && !localTc
              && !localThk
              && !localBlk;
            if (canUseLocalSeqMeta) localAssistantMetaIdx++;

            // 合并结果：
            // 若 Gateway 历史本身已带 thinking/toolCall 结构，优先使用 Gateway，避免与本地/服务端聚合 meta 错配后重复渲染。
            // 若 Gateway 历史缺失结构化信息，再回退到服务端/本地持久化数据。
            if (hasGatewayStructuredMeta) {
              toolCalls = gwToolCalls || sMeta?.toolCalls || localTc || (canUseLocalSeqMeta ? localSeqMeta.toolCalls : undefined) || undefined;
              thinking = gwThinking || tagThinking || sMeta?.thinking || localThk || (canUseLocalSeqMeta ? localSeqMeta.thinking : undefined) || undefined;
              blocks = gwBlocks || sMeta?.blocks || localBlk || (canUseLocalSeqMeta ? localSeqMeta.blocks : undefined) || undefined;
            } else {
              toolCalls = sMeta?.toolCalls || localTc || gwToolCalls || (canUseLocalSeqMeta ? localSeqMeta.toolCalls : undefined) || undefined;
              thinking = sMeta?.thinking || localThk || gwThinking || tagThinking || (canUseLocalSeqMeta ? localSeqMeta.thinking : undefined) || undefined;
              blocks = sMeta?.blocks || localBlk || (canUseLocalSeqMeta ? localSeqMeta.blocks : undefined) || gwBlocks || undefined;
            }

            // ⑤ 兜底：当有 toolCalls 或 thinking 但无 blocks 时，构建合理的 blocks 顺序
            // 确保使用交错渲染模式（而非传统模式将所有工具调用堆在顶部）
            if (!blocks && (toolCalls?.length || thinking)) {
              const fallbackBlocks: MessageBlock[] = [];
              if (thinking) fallbackBlocks.push({ type: 'thinking', content: thinking });
              if (toolCalls?.length) {
                for (const tc of toolCalls) {
                  fallbackBlocks.push({ type: 'tool', toolCallId: tc.id });
                }
              }
              if (text) fallbackBlocks.push({ type: 'text', content: text });
              blocks = fallbackBlocks;
            }

            // 如果已有 blocks 但缺少文本段，补一个 text block，避免渲染时回退到聚合 content
            if (blocks && text && !blocks.some((b) => b.type === 'text' && b.content?.trim())) {
              blocks = [...blocks, { type: 'text', content: text }];
            }

          }

          if (!text && attachments.length === 0 && !toolCalls?.length && !thinking && !blocks?.length && !hasAssistantMetaContent(msg)) {
            continue;
          }

          const rawMsgId = msg.id as string | undefined;
          const finalMsgId = rawMsgId || uuid();

          if (role === 'assistant' && (toolCalls?.length || blocks?.length)) {
            console.debug(`[store] loadHistory: msg ${finalMsgId} recovered tc=${toolCalls?.length || 0} blk=${blocks?.length || 0}`);
            // 仅对带稳定 Gateway message.id 的消息回写服务端元数据，
            // 避免为历史消息反复生成随机 ID，导致后续文本匹配错配。
            if (rawMsgId && !serverMetaById.has(rawMsgId)) {
              apiClient.saveMessageMeta(sessionKey, rawMsgId, { toolCalls, thinking, blocks }).catch(() => {});
            }
          }

          messages.push({
            id: finalMsgId,
            sessionKey,
            role: role === 'assistant' ? 'assistant' : 'user',
            content: text,
            thinking: role === 'assistant' ? undefined : thinking,
            attachments: attachments.length > 0 ? attachments : undefined,
            toolCalls,
            blocks: role === 'assistant' ? stripThinkingBlocks(blocks) : blocks,
            createdAt: msg.timestamp || Date.now(),
          });
        }

        const liveState = get();
        if (
          liveState.currentSessionKey === sessionKey
          && liveState.isStreaming
          && (liveState.currentAiText || liveState.currentAiThinking || liveState.toolCards.size > 0)
        ) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === 'assistant') {
            const liveText = liveState.currentAiText.trim();
            const historyText = lastMsg.content.trim();
            const liveThinking = liveState.currentAiThinking.trim();
            const historyThinking = (lastMsg.thinking || '').trim();
            const liveToolNames = new Set(Array.from(liveState.toolCards.values()).map((tc) => tc.name));
            const sharedTool = (lastMsg.toolCalls || []).some((tc) => liveToolNames.has(tc.name));
            const textOverlap = !!(liveText && historyText && (liveText.startsWith(historyText) || historyText.startsWith(liveText)));
            const thinkingOverlap = !!(
              liveThinking
              && historyThinking
              && (liveThinking.startsWith(historyThinking) || historyThinking.startsWith(liveThinking))
            );

            if (textOverlap || thinkingOverlap || sharedTool) {
              messages.pop();
            }
          }
        }

        if (requestSerial !== historyRequestSerial || viewVersion !== sessionViewVersion || get().currentSessionKey !== sessionKey) {
          return;
        }
        const nextMessages = dedupeMessages(messages.map(hideThinkingForDisplay));
        sessionMessagesCache.set(sessionKey, nextMessages);
        set({ messages: nextMessages, isHistoryLoading: false });
      } catch (e) {
        console.error('[store] loadHistory error:', e);
        // 出错时回退到本地 DB
        try {
          const localMessages = await db.getMessages(state.currentSessionKey || '');
          if (requestSerial !== historyRequestSerial || viewVersion !== sessionViewVersion || get().currentSessionKey !== sessionKey) {
            return;
          }
          if (localMessages.length > 0) {
            const nextMessages = dedupeMessages(localMessages.map(hideThinkingForDisplay));
            sessionMessagesCache.set(sessionKey, nextMessages);
            set({ messages: nextMessages, isHistoryLoading: false });
          } else {
            finishHistoryLoading();
          }
        } catch (_) {
          finishHistoryLoading();
        }
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
          if (!isPlaceholderSessionTitle(ls.title)) {
            localTitleMap.set(ls.key, ls.title);
          }
        }

        const sessionsFromGateway: Session[] = filteredSessions.map((s) => {
          // 标题优先级：本地DB > 服务端持久化 > Gateway返回 > lastMessage推断 > sessionKey解析
          const serverTitle = !isPlaceholderSessionTitle(serverTitles[s.key]) ? serverTitles[s.key] : undefined;
          const gatewayTitle = !isPlaceholderSessionTitle(s.title) ? s.title : undefined;
          let title = localTitleMap.get(s.key)
            || serverTitle
            || gatewayTitle;

          // 如果有服务端标题但本地没有，同步到本地 DB
          if (!localTitleMap.get(s.key) && serverTitle) {
            db.updateSessionTitle(s.key, serverTitle).catch(() => {});
          }

          if (!title || isPlaceholderSessionTitle(title) || title === s.key || /^agent:/.test(title)) {
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

        const optimisticSessions = [
          ...state.sessions,
          ...localSessions.filter((sess) => sess.key.includes(`:clawchat-${currentUserId}`)),
        ].filter((sess, index, arr) => arr.findIndex((it) => it.key === sess.key) === index);

        const sessions: Session[] = [
          ...sessionsFromGateway,
          ...optimisticSessions.filter((sess) => !sessionsFromGateway.some((item) => item.key === sess.key)),
        ].sort((a, b) => b.updatedAt - a.updatedAt);

        // 对于仍然是"新对话"的会话，异步尝试从聊天记录生成标题
        for (const sess of sessions) {
          if (isPlaceholderSessionTitle(sess.title)) {
            // 用 lastMessage 生成，或异步加载首条用户消息
            get().loadFirstUserMessage(sess.key).then((firstMsg: string | null) => {
              if (firstMsg) {
                const betterTitle = generateSessionTitle(firstMsg);
                if (betterTitle && !isPlaceholderSessionTitle(betterTitle)) {
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
        currentBlocks: [],
        _blockThinkingBase: 0,
        _blockTextBase: 0,
        _turnBaseText: '',
        _lastTurnDelta: '',
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
        currentBlocks: [],
        _blockThinkingBase: 0,
        _blockTextBase: 0,
        _turnBaseText: '',
        _lastTurnDelta: '',
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
    // clawchat-{user} / clawchat-{user}-{suffix} 都显示为新对话
    if (/^clawchat-[^-]+$/.test(channel)) return '新对话';
    // clawchat-{user}-{suffix} 格式: 新对话
    if (/^clawchat-.+-.+$/.test(channel)) return '新对话';
    if (channel === 'main') return '新对话';
    return channel.length > 20 ? channel.substring(0, 20) + '…' : channel;
  }
  return key;
}
