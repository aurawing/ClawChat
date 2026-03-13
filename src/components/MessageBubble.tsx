import { useState } from 'react';
import type { Message } from '../types';
import MarkdownRenderer from './MarkdownRenderer';
import ThinkingBlock from './ThinkingBlock';
import { ToolCallGroup } from './ToolCallBlock';
import ImageViewer from './ImageViewer';

interface MessageBubbleProps {
  message: Message;
}

/** 格式化消息时间（小字显示） */
function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // 今天只显示时分
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hhmm;
  }

  // 昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${hhmm}`;
  }

  // 今年只显示月-日 时:分
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
  }

  // 其他显示完整日期
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}

/**
 * 消息气泡组件 - 根据角色和内容类型渲染不同样式
 */
export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  const timeStr = formatTime(message.createdAt);

  /** 获取图片的显示 URL */
  const getImageSrc = (att: { url?: string; base64?: string; type: string }) => {
    return att.url || (att.base64 ? `data:${att.type};base64,${att.base64}` : '');
  };

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
      <>
        <div className="flex flex-col items-end mb-4">
          <div className="max-w-[85%] space-y-2">
            {/* 附件预览 */}
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-end">
                {message.attachments.map((att) => (
                  <div key={att.id} className="relative">
                    {att.type.startsWith('image/') ? (
                      <img
                        src={getImageSrc(att)}
                        alt={att.name}
                        className="max-h-48 max-w-full rounded-xl border border-neutral-700 object-contain cursor-pointer active:opacity-80 transition-opacity"
                        loading="lazy"
                        onClick={() => setViewerSrc(getImageSrc(att))}
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
            {message.content && (
              <div className="bg-blue-600 text-white px-4 py-3 rounded-2xl rounded-br-md">
                <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
              </div>
            )}
          </div>

          {/* 时间 */}
          {timeStr && (
            <span className="text-[10px] text-neutral-500 mt-1 mr-1">{timeStr}</span>
          )}
        </div>

        {/* 图片查看器 */}
        {viewerSrc && (
          <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />
        )}
      </>
    );
  }

  // AI 助手消息
  return (
    <>
      <div className="flex justify-start mb-4">
        {/* AI 头像 */}
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mr-2 mt-1 shrink-0">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>

        <div className="max-w-[85%]">
          <div className="space-y-1">
            {/* 思维链 */}
            {message.thinking && (
              <ThinkingBlock
                content={message.thinking}
                isStreaming={message.isStreaming && !message.content}
              />
            )}

            {/* 工具调用 — 层次化展示 */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <ToolCallGroup toolCalls={message.toolCalls} />
            )}

            {/* 主要内容（Markdown 中的图片也可点击放大） */}
            {message.content && (
              <div
                className="text-neutral-100"
                onClick={(e) => {
                  // 检查是否点击了 Markdown 渲染出的 <img> 标签
                  const target = e.target as HTMLElement;
                  if (target.tagName === 'IMG') {
                    const imgSrc = (target as HTMLImageElement).src;
                    if (imgSrc) {
                      e.preventDefault();
                      setViewerSrc(imgSrc);
                    }
                  }
                }}
              >
                <MarkdownRenderer content={message.content} />
              </div>
            )}

            {/* 流式光标 */}
            {message.isStreaming && (
              <span className="inline-block w-2 h-4 bg-neutral-400 animate-pulse ml-0.5" />
            )}
          </div>

          {/* 时间 */}
          {timeStr && !message.isStreaming && (
            <span className="text-[10px] text-neutral-500 mt-1 block">{timeStr}</span>
          )}
        </div>
      </div>

      {/* 图片查看器 */}
      {viewerSrc && (
        <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />
      )}
    </>
  );
}
