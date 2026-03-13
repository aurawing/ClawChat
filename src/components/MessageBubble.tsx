import { useState, useCallback, useMemo } from 'react';
import type { Message, FileAttachment, ToolCall, MessageBlock } from '../types';
import MarkdownRenderer from './MarkdownRenderer';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';
import ImageViewer from './ImageViewer';

interface MessageBubbleProps {
  message: Message;
}

/**
 * 智能图片组件 — 解决混合内容加载问题
 * 1. 先用 <img> 直接加载（最快）
 * 2. 失败时通过 fetch（CapacitorHttp 原生通道）下载并转 data URL
 * 3. 再失败回退到 base64
 */
function SmartImage({
  att,
  className,
  onClickSrc,
}: {
  att: FileAttachment;
  className?: string;
  onClickSrc?: (actualSrc: string) => void;
}) {
  const [src, setSrc] = useState<string>(() => getInitialSrc(att));
  const [retried, setRetried] = useState(false);

  const handleError = useCallback(async () => {
    if (retried) return;
    setRetried(true);

    // 尝试通过 fetch（走 CapacitorHttp 原生通道）下载
    const httpUrl = att.url && (att.url.startsWith('http://') || att.url.startsWith('https://'))
      ? att.url : null;
    if (httpUrl) {
      try {
        const res = await fetch(httpUrl);
        if (res.ok) {
          const blob = await res.blob();
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          setSrc(dataUrl);
          return;
        }
      } catch { /* continue to fallback */ }
    }

    // 回退到 base64
    if (att.base64) {
      setSrc(`data:${att.type};base64,${att.base64}`);
    }
  }, [att, retried]);

  const handleClick = useCallback(() => {
    // 传递实际加载成功的 src 给查看器
    if (onClickSrc) onClickSrc(src);
  }, [onClickSrc, src]);

  return (
    <img
      src={src}
      alt={att.name}
      className={className}
      loading="lazy"
      onClick={handleClick}
      onError={handleError}
    />
  );
}

/** 获取初始图片 URL（跳过失效的 blob: URL） */
function getInitialSrc(att: FileAttachment): string {
  const url = att.url;
  // blob: URL 重启后失效，跳过
  if (url && !url.startsWith('blob:')) return url;
  // 回退到 base64 data URL
  if (att.base64) return `data:${att.type};base64,${att.base64}`;
  // 最后手段：即使 blob 也尝试
  return url || '';
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
                      <SmartImage
                        att={att}
                        className="max-h-48 max-w-full rounded-xl border border-neutral-700 object-contain cursor-pointer active:opacity-80 transition-opacity"
                        onClickSrc={(actualSrc) => setViewerSrc(actualSrc)}
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
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
  const isToolOnlyMsg = hasToolCalls && !message.content;

  // 构建工具调用 ID → ToolCall 映射
  const toolCallMap = useMemo(() => {
    const map = new Map<string, ToolCall>();
    if (message.toolCalls) {
      for (const tc of message.toolCalls) map.set(tc.id, tc);
    }
    return map;
  }, [message.toolCalls]);

  // 判断是否使用交错渲染
  const useBlocks = message.blocks && message.blocks.length > 0 && hasToolCalls;

  // 收集已被 blocks 引用的 toolCallId，剩余的在 blocks 之后渲染
  const blocksToolIds = useMemo(() => {
    if (!useBlocks) return new Set<string>();
    return new Set(
      message.blocks!
        .filter((b: MessageBlock) => b.type === 'tool' && b.toolCallId)
        .map((b: MessageBlock) => b.toolCallId!)
    );
  }, [useBlocks, message.blocks]);

  const remainingTools = useMemo(() => {
    if (!hasToolCalls) return [];
    if (!useBlocks) return message.toolCalls!;
    return message.toolCalls!.filter((tc) => !blocksToolIds.has(tc.id));
  }, [hasToolCalls, useBlocks, message.toolCalls, blocksToolIds]);

  return (
    <>
      <div className="flex justify-start mb-4">
        {/* AI 头像 */}
        <div className={`w-7 h-7 rounded-full flex items-center justify-center mr-2 mt-1 shrink-0 ${
          isToolOnlyMsg
            ? 'bg-gradient-to-br from-amber-500 to-orange-600'
            : 'bg-gradient-to-br from-emerald-500 to-teal-600'
        }`}>
          {hasToolCalls ? (
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          )}
        </div>

        <div className="max-w-[85%]">
          <div className="space-y-1">
            {/* ====== 交错渲染模式 — 思维链与工具调用按实际顺序展示 ====== */}
            {useBlocks ? (
              <>
                {message.blocks!.map((block: MessageBlock, i: number) => {
                  if (block.type === 'thinking' && block.content) {
                    return (
                      <ThinkingBlock
                        key={`blk-t-${i}`}
                        content={block.content}
                        isStreaming={
                          message.isStreaming &&
                          i === message.blocks!.length - 1 &&
                          !message.content
                        }
                      />
                    );
                  }
                  if (block.type === 'tool' && block.toolCallId) {
                    const tc = toolCallMap.get(block.toolCallId);
                    if (tc) {
                      return <ToolCallBlock key={`blk-tc-${block.toolCallId}`} toolCall={tc} />;
                    }
                  }
                  return null;
                })}
                {/* blocks 中未引用的工具调用（兼容旧数据） */}
                {remainingTools.map((tc) => (
                  <ToolCallBlock key={`tc-rem-${tc.id}`} toolCall={tc} />
                ))}
              </>
            ) : (
              /* ====== 传统渲染模式（无 blocks 时回退） ====== */
              <>
                {message.thinking && (
                  <ThinkingBlock
                    content={message.thinking}
                    isStreaming={message.isStreaming && !message.content}
                  />
                )}
                {message.toolCalls && message.toolCalls.length > 0 &&
                  message.toolCalls.map((tc) => (
                    <ToolCallBlock key={`tc-${tc.id}`} toolCall={tc} />
                  ))
                }
              </>
            )}

            {/* 主要内容 */}
            {message.content && (
              <div
                className="text-neutral-100"
                onClick={(e) => {
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
