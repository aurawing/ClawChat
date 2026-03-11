import { useState } from 'react';
import type { ToolCall } from '../types';

interface ToolCallBlockProps {
  toolCall: ToolCall;
}

/**
 * 工具调用展示组件 - 显示工具调用的名称和状态
 */
export default function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const statusConfig: Record<string, { color: string; bgColor: string; icon: React.ReactNode; label: string }> = {
    running: {
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10 border-amber-500/20',
      icon: (
        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ),
      label: '调用中',
    },
    done: {
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10 border-emerald-500/20',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ),
      label: '已完成',
    },
    error: {
      color: 'text-red-400',
      bgColor: 'bg-red-500/10 border-red-500/20',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      ),
      label: '失败',
    },
  };

  const config = statusConfig[toolCall.status] || statusConfig.running;

  return (
    <div className={`my-2 rounded-lg border ${config.bgColor} overflow-hidden`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5 transition-colors"
      >
        <span className={config.color}>{config.icon}</span>
        <span className={`font-mono text-xs ${config.color}`}>{toolCall.name}</span>
        <span className="text-neutral-500 text-xs ml-auto">{config.label}</span>
        <svg
          className={`w-3 h-3 text-neutral-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          <div className="text-xs text-neutral-500">
            ID: <span className="font-mono text-neutral-400">{toolCall.id}</span>
          </div>
        </div>
      )}
    </div>
  );
}
