import { useState } from 'react';
import type { ToolCall } from '../types';

interface ToolCallBlockProps {
  toolCall: ToolCall;
}

/** 根据工具名称返回分类和图标 */
function getToolMeta(name: string): { icon: React.ReactNode; label: string; color: string } {
  const lower = name.toLowerCase();

  // 命令/终端类
  if (/bash|shell|exec|command|terminal|run/i.test(lower)) {
    return {
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
      label: '终端',
      color: 'text-green-400',
    };
  }

  // 文件操作类
  if (/file|read|write|edit|save|create|delete|mkdir|touch/i.test(lower)) {
    return {
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      label: '文件',
      color: 'text-blue-400',
    };
  }

  // 搜索/浏览类
  if (/search|browse|web|fetch|http|api|query|google|bing/i.test(lower)) {
    return {
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      ),
      label: '搜索',
      color: 'text-purple-400',
    };
  }

  // 代码类
  if (/code|python|javascript|compile|lint/i.test(lower)) {
    return {
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      ),
      label: '代码',
      color: 'text-cyan-400',
    };
  }

  // 默认：通用工具
  return {
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
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
 * 工具调用展示组件 - 层次化展示工具调用过程
 * 类似于 ChatGPT / Claude 的工具调用展示
 */
export default function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const meta = getToolMeta(toolCall.name);

  const isRunning = toolCall.status === 'running';
  const isDone = toolCall.status === 'done';
  const isError = toolCall.status === 'error';

  // 状态对应的颜色
  const statusBg = isRunning
    ? 'bg-neutral-800/60 border-amber-500/30'
    : isError
    ? 'bg-neutral-800/60 border-red-500/30'
    : 'bg-neutral-800/40 border-neutral-700/40';

  // 耗时
  const duration =
    toolCall.startedAt && toolCall.finishedAt
      ? ((toolCall.finishedAt - toolCall.startedAt) / 1000).toFixed(1) + 's'
      : null;

  return (
    <div className={`my-1.5 rounded-lg border ${statusBg} overflow-hidden text-xs`}>
      {/* 头部：可折叠 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition-colors"
      >
        {/* 工具分类图标 */}
        <span
          className={`flex items-center justify-center w-5 h-5 rounded ${
            isRunning ? 'bg-amber-500/20' : isError ? 'bg-red-500/20' : 'bg-neutral-700/50'
          } shrink-0`}
        >
          {isRunning ? (
            <svg className="w-3.5 h-3.5 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <span className={isDone ? meta.color : 'text-red-400'}>{meta.icon}</span>
          )}
        </span>

        {/* 工具名 */}
        <span className="font-mono text-neutral-300 truncate">
          {toolCall.name}
        </span>

        {/* 状态标签 */}
        <span
          className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
            isRunning
              ? 'bg-amber-500/15 text-amber-400'
              : isError
              ? 'bg-red-500/15 text-red-400'
              : 'bg-emerald-500/15 text-emerald-400'
          }`}
        >
          {isRunning ? '执行中…' : isError ? '失败' : '完成'}
        </span>

        {/* 耗时 */}
        {duration && (
          <span className="text-neutral-500 shrink-0">{duration}</span>
        )}

        {/* 展开箭头 */}
        <svg
          className={`w-3 h-3 text-neutral-500 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 展开详情 */}
      {isExpanded && (
        <div className="border-t border-neutral-700/40 px-3 py-2 space-y-2">
          {/* 输入参数 */}
          {toolCall.input && (
            <div>
              <div className="text-neutral-500 mb-0.5 flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                输入
              </div>
              <pre className="bg-black/30 rounded px-2 py-1.5 text-neutral-400 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {truncate(toolCall.input, 2000)}
              </pre>
            </div>
          )}

          {/* 输出结果 */}
          {toolCall.output && (
            <div>
              <div className={`mb-0.5 flex items-center justify-between ${isError ? 'text-red-400' : 'text-neutral-500'}`}>
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                  </svg>
                  {isError ? '错误' : '输出'}
                </div>
                {/* 复制/保存按钮 */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(toolCall.output || '');
                    }}
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title="复制输出"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const blob = new Blob([toolCall.output || ''], { type: 'text/plain;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${toolCall.name}_output.txt`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title="保存为文件"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </button>
                </div>
              </div>
              <pre className={`rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto ${
                isError ? 'bg-red-500/10 text-red-300' : 'bg-black/30 text-neutral-400'
              }`}>
                {truncate(toolCall.output, 2000)}
              </pre>
            </div>
          )}

          {/* 如果没有 input/output，至少显示 ID */}
          {!toolCall.input && !toolCall.output && (
            <div className="text-neutral-500">
              ID: <span className="font-mono text-neutral-400">{toolCall.id}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 工具调用组 — 将多个工具调用以时间线方式展示
 * 在 AI 消息内替代原来的简单列表
 */
export function ToolCallGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const allDone = toolCalls.every((tc) => tc.status === 'done');
  const hasError = toolCalls.some((tc) => tc.status === 'error');
  const runningCount = toolCalls.filter((tc) => tc.status === 'running').length;

  return (
    <div className="my-2">
      {/* 组头部 */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-300 transition-colors mb-1"
      >
        {/* 工具图标 */}
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826-3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>

        {runningCount > 0 ? (
          <span className="text-amber-400">
            正在调用 {runningCount} 个工具…
          </span>
        ) : hasError ? (
          <span className="text-red-400">
            调用了 {toolCalls.length} 个工具（有失败）
          </span>
        ) : (
          <span>
            调用了 {toolCalls.length} 个工具
            {allDone && ' ✓'}
          </span>
        )}

        <svg
          className={`w-3 h-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 工具调用列表 */}
      {!collapsed && (
        <div className="relative pl-3">
          {/* 左侧时间线竖线 */}
          <div className="absolute left-[5px] top-1 bottom-1 w-px bg-neutral-700/60" />

          {toolCalls.map((tc, i) => (
            <div key={tc.id} className="relative">
              {/* 时间线节点 */}
              <div
                className={`absolute left-[-7px] top-2 w-2.5 h-2.5 rounded-full border-2 ${
                  tc.status === 'running'
                    ? 'border-amber-500 bg-amber-500/30 animate-pulse'
                    : tc.status === 'error'
                    ? 'border-red-500 bg-red-500/30'
                    : 'border-emerald-500 bg-emerald-500/30'
                }`}
              />

              {/* 连接线（非最后一个） */}
              {i < toolCalls.length - 1 && (
                <div className="absolute left-[-3px] top-3.5 bottom-0 w-px" />
              )}

              <div className="ml-2">
                <ToolCallBlock toolCall={tc} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
