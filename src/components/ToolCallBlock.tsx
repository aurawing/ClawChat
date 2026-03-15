import { useState } from 'react';
import type { ToolCall } from '../types';

interface ToolCallBlockProps {
  toolCall: ToolCall;
}

/** 根据工具名称返回分类图标和颜色 */
function getToolMeta(name: string): { icon: React.ReactNode; label: string; color: string } {
  const lower = name.toLowerCase();

  if (/bash|shell|exec|command|terminal|run/i.test(lower)) {
    return {
      icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
      label: '终端',
      color: 'text-green-400',
    };
  }
  if (/file|read|write|edit|save|create|delete|mkdir|touch/i.test(lower)) {
    return {
      icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />,
      label: '文件',
      color: 'text-blue-400',
    };
  }
  if (/search|browse|web|fetch|http|api|query|google|bing/i.test(lower)) {
    return {
      icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />,
      label: '搜索',
      color: 'text-purple-400',
    };
  }
  if (/code|python|javascript|compile|lint/i.test(lower)) {
    return {
      icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />,
      label: '代码',
      color: 'text-cyan-400',
    };
  }
  return {
    icon: (
      <>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </>
    ),
    label: '工具',
    color: 'text-amber-400',
  };
}

/** 截断长文本 */
function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
}

/**
 * 单个工具调用展示 — 紧凑卡片式
 */
export default function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const meta = getToolMeta(toolCall.name);

  const isRunning = toolCall.status === 'running';
  const isError = toolCall.status === 'error';

  const duration =
    toolCall.startedAt && toolCall.finishedAt
      ? ((toolCall.finishedAt - toolCall.startedAt) / 1000).toFixed(1) + 's'
      : null;

  const inputPreview = truncate(toolCall.input, 80);

  return (
    <div className={`rounded-lg border text-xs overflow-hidden ${
      isRunning ? 'bg-th-elevated/60 border-amber-500/30' :
      isError ? 'bg-th-elevated/60 border-red-500/30' :
      'bg-th-elevated/40 border-th-border/40'
    }`}>
      {/* 头部 — 可折叠 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-th-hover/30 transition-colors"
      >
        <span className={`flex items-center justify-center w-5 h-5 rounded shrink-0 ${
          isRunning ? 'bg-amber-500/20' : isError ? 'bg-red-500/20' : 'bg-th-elevated/50'
        }`}>
          {isRunning ? (
            <svg className="w-3 h-3 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className={`w-3.5 h-3.5 ${isError ? 'text-red-400' : meta.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {meta.icon}
            </svg>
          )}
        </span>

        <span className="flex-1 text-left truncate">
          <span className="font-mono text-th-text-secondary">{toolCall.name}</span>
          {inputPreview && !isExpanded && (
            <span className="text-th-text-dim ml-1.5">{inputPreview}</span>
          )}
        </span>

        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
          isRunning ? 'bg-amber-500/15 text-amber-400' :
          isError ? 'bg-red-500/15 text-red-400' :
          'bg-emerald-500/15 text-emerald-400'
        }`}>
          {isRunning ? '执行中…' : isError ? '失败' : duration || '✓'}
        </span>

        <svg
          className={`w-3 h-3 text-th-text-dim transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 展开详情 */}
      {isExpanded && (
        <div className="border-t border-th-border/40 px-3 py-2 space-y-2">
          {toolCall.input && (
            <div>
              <div className="text-th-text-dim mb-0.5 flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                输入
              </div>
              <pre className="bg-th-base/50 rounded px-2 py-1.5 text-th-text-muted overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {truncate(toolCall.input, 2000)}
              </pre>
            </div>
          )}
          {toolCall.output && (
            <div>
              <div className={`mb-0.5 flex items-center justify-between ${isError ? 'text-red-400' : 'text-th-text-dim'}`}>
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                  </svg>
                  {isError ? '错误' : '输出'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(toolCall.output || '');
                    }}
                    className="text-th-text-dim hover:text-th-text-secondary"
                    title="复制"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                </div>
              </div>
              <pre className={`rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto ${
                isError ? 'bg-red-500/10 text-red-300' : 'bg-th-base/50 text-th-text-muted'
              }`}>
                {truncate(toolCall.output, 2000)}
              </pre>
            </div>
          )}
          {!toolCall.input && !toolCall.output && (
            <div className="text-th-text-dim space-y-1">
              <div>
                <span className="text-th-text-faint">工具: </span>
                <span className="font-mono text-th-text-muted">{toolCall.name}</span>
              </div>
              <div>
                <span className="text-th-text-faint">ID: </span>
                <span className="font-mono text-th-text-dim text-[10px]">{toolCall.id}</span>
              </div>
              {toolCall.status === 'running' && (
                <div className="text-amber-400/70 text-[10px]">等待执行结果…</div>
              )}
              {toolCall.status === 'done' && (
                <div className="text-th-text-faint text-[10px]">（工具未返回详细的输入/输出数据）</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 工具调用组 — 用独立框包裹，思维链下方展示
 */
export function ToolCallGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const allDone = toolCalls.every((tc) => tc.status === 'done');
  const hasError = toolCalls.some((tc) => tc.status === 'error');
  const runningCount = toolCalls.filter((tc) => tc.status === 'running').length;

  return (
    <div className="my-2 rounded-xl border border-th-border/50 bg-th-surface/50 overflow-hidden">
      {/* 组头部 */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-th-hover/30 transition-colors text-xs"
      >
        <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
          runningCount > 0 ? 'bg-amber-500/20' : hasError ? 'bg-red-500/20' : 'bg-emerald-500/15'
        }`}>
          {runningCount > 0 ? (
            <svg className="w-3.5 h-3.5 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className={`w-3.5 h-3.5 ${hasError ? 'text-red-400' : 'text-emerald-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </div>

        <span className="flex-1 text-left">
          {runningCount > 0 ? (
            <span className="text-amber-400">正在调用 {runningCount} 个工具…</span>
          ) : hasError ? (
            <span className="text-red-400">调用了 {toolCalls.length} 个工具（有失败）</span>
          ) : (
            <span className="text-th-text-muted">调用了 {toolCalls.length} 个工具{allDone ? ' ✓' : ''}</span>
          )}
        </span>

        <svg
          className={`w-3 h-3 text-th-text-dim transition-transform ${collapsed ? '-rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 工具调用列表 */}
      {!collapsed && (
        <div className="px-3 pb-2 space-y-1.5">
          {toolCalls.map((tc) => (
            <ToolCallBlock key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}
