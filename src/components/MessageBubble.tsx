import type { Message } from '../types';
import MarkdownRenderer from './MarkdownRenderer';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';

interface MessageBubbleProps {
  message: Message;
}

/**
 * 消息气泡组件 - 根据角色和内容类型渲染不同样式
 */
export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  // 系统消息（错误等）
  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <div className="bg-red-500/10 border border-red-500/20 text-red-300 px-4 py-2 rounded-lg text-sm max-w-[90%]">
          {message.content}
        </div>
      </div>
    );
  }

  // 用户消息
  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[85%] space-y-2">
          {/* 附件预览 */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 justify-end">
              {message.attachments.map((att) => (
                <div key={att.id} className="relative">
                  {att.type.startsWith('image/') ? (
                    <img
                      src={att.url || `data:${att.type};base64,${att.base64}`}
                      alt={att.name}
                      className="h-20 w-20 rounded-lg object-cover border border-neutral-700"
                    />
                  ) : (
                    <div className="flex items-center gap-2 bg-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-300 border border-neutral-700">
                      <svg className="w-4 h-4 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 消息内容 */}
          <div className="bg-blue-600 text-white px-4 py-3 rounded-2xl rounded-br-md">
            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  // AI 助手消息
  return (
    <div className="flex justify-start mb-4">
      {/* AI 头像 */}
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mr-2 mt-1 shrink-0">
        <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>

      <div className="max-w-[85%] space-y-1">
        {/* 思维链 */}
        {message.thinking && (
          <ThinkingBlock
            content={message.thinking}
            isStreaming={message.isStreaming && !message.content}
          />
        )}

        {/* 工具调用 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallBlock key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {/* 主要内容 */}
        {message.content && (
          <div className="text-neutral-100">
            <MarkdownRenderer content={message.content} />
          </div>
        )}

        {/* 流式光标 */}
        {message.isStreaming && (
          <span className="inline-block w-2 h-4 bg-neutral-400 animate-pulse ml-0.5" />
        )}
      </div>
    </div>
  );
}
