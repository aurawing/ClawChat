import { useState, useEffect, useRef } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * 思维链展示组件
 * - 思考中：自动展开，显示 "正在思考，已经过 XX 秒"
 * - 思考完成：默认折叠，可点击展开/收起
 */
export default function ThinkingBlock({ content, isStreaming }: ThinkingBlockProps) {
  const [userToggled, setUserToggled] = useState(false);
  const [isExpanded, setIsExpanded] = useState(!!isStreaming);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startTimeRef = useRef<number>(Date.now());

  // 流式结束时自动折叠（除非用户手动操作过）
  useEffect(() => {
    if (isStreaming) {
      if (!userToggled) setIsExpanded(true);
      startTimeRef.current = Date.now();
      const timer = setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
      return () => clearInterval(timer);
    } else {
      if (!userToggled) setIsExpanded(false);
    }
  }, [isStreaming, userToggled]);

  if (!content) return null;

  const handleToggle = () => {
    setUserToggled(true);
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="mb-2">
      {/* 标题行 — 可点击折叠/展开 */}
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity"
      >
        <svg
          className={`w-3 h-3 text-th-text-dim transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        {isStreaming ? (
          <span className="flex items-center gap-1.5 text-purple-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
            </span>
            正在思考，已经过 {elapsedSec} 秒
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-th-text-muted">
            <svg className="w-3 h-3 text-purple-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            思考内容
          </span>
        )}
      </button>

      {/* 思维链内容 — 使用 Markdown 格式化渲染 */}
      {isExpanded && (
        <div className="mt-1.5 pl-4 border-l-2 border-purple-500/30 text-th-text-muted text-sm leading-relaxed max-h-80 overflow-y-auto">
          <MarkdownRenderer content={content} />
        </div>
      )}
    </div>
  );
}
