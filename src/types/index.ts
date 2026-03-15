// ===== 连接配置 =====

export interface ServerConfig {
  host: string; // 服务器地址 (如 192.168.1.100:3210)
  token: string; // 连接密码
  username?: string; // 用户名（多用户模式下用于标识身份）
}

// ===== 连接状态 =====

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'ready' // Gateway 已就绪
  | 'pairing_pending' // 设备等待配对批准
  | 'reconnecting'
  | 'auth_failed'
  | 'error';

// ===== Gateway 消息格式 (OpenClaw Protocol v3) =====

/** Gateway 事件消息 */
export interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: Record<string, unknown>;
}

/** Gateway RPC 响应 */
export interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

/** Gateway 上游消息 */
export type GatewayMessage = GatewayEvent | GatewayResponse;

// ===== Chat 事件 Payload =====

export interface ChatEventPayload {
  sessionKey?: string;
  runId?: string;
  state: 'delta' | 'final' | 'error' | 'aborted';
  message?: ChatMessage;
  errorMessage?: string;
}

export interface ChatMessage {
  role?: string;
  content?: string | ContentBlock[];
  text?: string;
  id?: string;
  timestamp?: number;
  mediaUrl?: string;
  mediaUrls?: string[];
}

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  url?: string;
  source?: { type?: string; data?: string; media_type?: string; url?: string };
  image_url?: { url?: string };
  fileName?: string;
  name?: string;
  size?: number;
  omitted?: boolean;
  duration?: number;
}

// ===== Agent 事件 Payload =====

export interface AgentEventPayload {
  sessionKey?: string;
  runId?: string;
  stream: 'lifecycle' | 'assistant' | 'tool';
  data?: {
    phase?: string;
    text?: string;
    toolCallId?: string;
    name?: string;
    [key: string]: unknown;
  };
}

// ===== 文件附件 =====

export interface FileAttachment {
  id: string;
  name: string;
  type: string; // mime type
  size: number;
  url?: string;
  base64?: string;
  // Gateway 格式
  content?: string; // base64 content
  mimeType?: string;
  category?: string;
}

// ===== 本地消息模型 =====

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  input?: string;   // 工具调用的输入/参数（JSON 或文本）
  output?: string;   // 工具调用的输出/结果
  startedAt?: number;
  finishedAt?: number;
}

/** 消息内容块 — 用于记录思维链 / 工具调用 / 文本的交错顺序 */
export interface MessageBlock {
  type: 'thinking' | 'tool' | 'text';
  content?: string;       // thinking/text 块的文本
  toolCallId?: string;    // tool 块对应的 toolCallId
}

export interface Message {
  id: string;
  sessionKey: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  blocks?: MessageBlock[];   // 思维链 / 工具调用的交错顺序
  attachments?: FileAttachment[];
  createdAt: number;
  isStreaming?: boolean;
}

// ===== 会话模型 =====

export interface Session {
  key: string; // sessionKey
  title: string;
  lastMessage?: string;
  updatedAt: number;
}
