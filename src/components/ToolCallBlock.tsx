import { useState, useMemo } from 'react';
import type { ToolCall } from '../types';

interface ToolCallBlockProps {
  toolCall: ToolCall;
}

// ====== 工具图标 SVG path ======

const ICONS = {
  terminal: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  ),
  file: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  ),
  fileEdit: (
    <>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </>
  ),
  search: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  ),
  code: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
  ),
  globe: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
  ),
  gear: (
    <>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </>
  ),
};

/** 根据工具名称返回图标、显示名称和颜色 */
function getToolMeta(name: string): {
  icon: React.ReactNode;
  displayName: string;
  color: string;
  bgColor: string;
} {
  const lower = name.toLowerCase();

  if (/bash|shell|exec|command|terminal|run/i.test(lower)) {
    return { icon: ICONS.terminal, displayName: name, color: 'text-green-400', bgColor: 'bg-green-500/15' };
  }
  if (/write|save|create|mkdir|touch/i.test(lower)) {
    return { icon: ICONS.fileEdit, displayName: name, color: 'text-blue-400', bgColor: 'bg-blue-500/15' };
  }
  if (/file|read|cat|head|tail/i.test(lower)) {
    return { icon: ICONS.file, displayName: name, color: 'text-sky-400', bgColor: 'bg-sky-500/15' };
  }
  if (/search|find|grep|glob|ls|list/i.test(lower)) {
    return { icon: ICONS.search, displayName: name, color: 'text-purple-400', bgColor: 'bg-purple-500/15' };
  }
  if (/browse|web|fetch|http|api|url|curl|request/i.test(lower)) {
    return { icon: ICONS.globe, displayName: name, color: 'text-indigo-400', bgColor: 'bg-indigo-500/15' };
  }
  if (/code|python|javascript|compile|lint|edit/i.test(lower)) {
    return { icon: ICONS.code, displayName: name, color: 'text-cyan-400', bgColor: 'bg-cyan-500/15' };
  }
  return { icon: ICONS.gear, displayName: name, color: 'text-amber-400', bgColor: 'bg-amber-500/15' };
}

/** 尝试解析 JSON 字符串 */
function tryParseJson(str: string | undefined): Record<string, unknown> | null {
  if (!str) return null;
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** 截断文本 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '…';
}

/**
 * 根据工具名称和输入生成人类可读的摘要
 * 参考 OpenClaw Dashboard 风格：`with [动作] [参数摘要]`
 */
function generateInputSummary(name: string, input: string | undefined): string {
  if (!input) return '';

  const parsed = tryParseJson(input);
  const lower = name.toLowerCase();

  if (parsed) {
    // Exec / Bash / Shell 类
    if (/bash|shell|exec|command|terminal|run/i.test(lower)) {
      const cmd = (parsed.command || parsed.cmd || parsed.script || parsed.code || parsed.inline) as string;
      if (cmd) return `run ${truncate(cmd, 200)}`;
    }

    // Write / 文件写入
    if (/write|save|create|mkdir|touch/i.test(lower)) {
      const path = (parsed.path || parsed.file_path || parsed.filename || parsed.file || parsed.target_file) as string;
      const content = (parsed.content || parsed.text || parsed.data || parsed.contents) as string;
      const size = content ? `(${content.length} chars)` : '';
      if (path) return `to ${path} ${size}`.trim();
    }

    // Read / 文件读取
    if (/read|cat|head|tail|read_file/i.test(lower)) {
      const path = (parsed.path || parsed.file_path || parsed.filename || parsed.file || parsed.target_file) as string;
      if (path) return `from ${path}`;
    }

    // Web 搜索
    if (/web_search|websearch|web search/i.test(lower)) {
      const query = (parsed.search_term || parsed.query || parsed.search_query || parsed.keyword || parsed.q) as string;
      if (query) return `"${truncate(query, 150)}"`;
    }

    // 代码搜索 / 文件搜索
    if (/search|find|grep|glob|ls|list|codebase_search|file_search/i.test(lower)) {
      const query = (parsed.query || parsed.pattern || parsed.keyword || parsed.search_term
        || parsed.path || parsed.directory || parsed.glob_pattern || parsed.target_directories) as string;
      if (query) {
        const qStr = typeof query === 'string' ? query : JSON.stringify(query);
        return `"${truncate(qStr, 150)}"`;
      }
    }

    // Web / HTTP / Browse
    if (/browse|web|fetch|http|api|url|curl|request/i.test(lower)) {
      const url = (parsed.url || parsed.endpoint || parsed.href || parsed.search_term) as string;
      if (url) return `${parsed.method || 'GET'} ${truncate(url, 200)}`;
    }

    // Edit / 编辑 / Replace
    if (/edit|replace|search_replace/i.test(lower)) {
      const path = (parsed.path || parsed.file_path || parsed.file || parsed.target_file) as string;
      if (path) return `${path}`;
    }

    // 通用：列出有意义的参数（跳过太长的值和元数据字段）
    const metaKeys = new Set(['type', 'id', 'name', 'status', 'phase', 'toolCallId', 'tool_call_id']);
    const keys = Object.keys(parsed).filter(k => !metaKeys.has(k));
    if (keys.length > 0) {
      const parts: string[] = [];
      for (const k of keys.slice(0, 3)) {
        const v = parsed[k];
        if (typeof v === 'string') {
          parts.push(`${k}: ${truncate(v, 80)}`);
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          parts.push(`${k}: ${v}`);
        } else if (Array.isArray(v)) {
          parts.push(`${k}: [${v.length} items]`);
        }
      }
      if (parts.length > 0) return parts.join(', ');
    }
  }

  // 非 JSON 纯文本
  return truncate(input, 200);
}

/**
 * 单个工具调用展示 — 仿 OpenClaw Dashboard 风格
 */
export default function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [showDetail, setShowDetail] = useState(false);
  const meta = getToolMeta(toolCall.name);

  const isRunning = toolCall.status === 'running';
  const isError = toolCall.status === 'error';
  const isDone = toolCall.status === 'done';

  const inputSummary = useMemo(
    () => generateInputSummary(toolCall.name, toolCall.input),
    [toolCall.name, toolCall.input],
  );

  const duration = toolCall.startedAt && toolCall.finishedAt
    ? ((toolCall.finishedAt - toolCall.startedAt) / 1000).toFixed(1) + 's'
    : null;

  return (
    <div className={`my-1.5 rounded-xl border overflow-hidden ${
      isRunning ? 'border-amber-500/30 bg-th-elevated/70' :
      isError   ? 'border-red-500/30 bg-th-elevated/70' :
                  'border-th-border/40 bg-th-elevated/50'
    }`}>
      {/* ====== 头部：图标 + 工具名 + 操作/状态 ====== */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* 工具图标 */}
        <span className={`flex items-center justify-center w-6 h-6 rounded-md shrink-0 ${meta.bgColor}`}>
          {isRunning ? (
            <svg className="w-3.5 h-3.5 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className={`w-4 h-4 ${meta.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {meta.icon}
            </svg>
          )}
        </span>

        {/* 工具名称 */}
        <span className="font-semibold text-sm text-th-text flex-1 truncate">
          {meta.displayName}
        </span>

        {/* 查看详情 / 状态 */}
        {(toolCall.input || toolCall.output) && isDone && (
          <button
            onClick={() => setShowDetail(!showDetail)}
            className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-0.5 shrink-0"
          >
            {showDetail ? '收起' : 'View'}
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </button>
        )}
        {isRunning && (
          <span className="text-xs text-amber-400 animate-pulse shrink-0">Running…</span>
        )}
        {isError && (
          <button
            onClick={() => setShowDetail(!showDetail)}
            className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-0.5 shrink-0"
          >
            {showDetail ? '收起' : 'View'}
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {isDone && !toolCall.input && !toolCall.output && (
          <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* ====== 摘要行：with [动作] [参数] ====== */}
      {inputSummary && !showDetail && (
        <div className="px-3 pb-2 -mt-0.5">
          <p className="text-xs text-th-text-muted leading-relaxed break-all line-clamp-3">
            <span className="text-th-text-dim">with </span>{inputSummary}
          </p>
        </div>
      )}

      {/* ====== 输出摘要（无需展开，简短输出直接显示）====== */}
      {toolCall.output && !showDetail && !isError && toolCall.output.length <= 120 && (
        <div className="px-3 pb-2 -mt-0.5">
          <p className="text-xs text-th-text-muted leading-relaxed break-all">
            {toolCall.output}
          </p>
        </div>
      )}

      {/* ====== 状态行 ====== */}
      {!showDetail && (
        <div className="px-3 pb-2">
          <span className={`text-[11px] ${
            isRunning ? 'text-amber-400/70' :
            isError   ? 'text-red-400/70' :
                        'text-th-text-dim'
          }`}>
            {isRunning ? 'Running…' : isError ? 'Error' : duration ? `Completed in ${duration}` : 'Completed'}
          </span>
        </div>
      )}

      {/* ====== 展开详情面板 ====== */}
      {showDetail && (
        <div className="border-t border-th-border/30 px-3 py-2 space-y-2">
          {/* 输入 */}
          {toolCall.input && (
            <div>
              <div className="flex items-center gap-1 text-[11px] text-th-text-dim mb-1">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                Input
              </div>
              <pre className="bg-th-base/60 rounded-lg px-2.5 py-2 text-xs text-th-text-muted overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto leading-relaxed">
                {formatInput(toolCall.input)}
              </pre>
            </div>
          )}
          {/* 输出 */}
          {toolCall.output && (
            <div>
              <div className={`flex items-center justify-between text-[11px] mb-1 ${isError ? 'text-red-400' : 'text-th-text-dim'}`}>
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                  </svg>
                  {isError ? 'Error' : 'Output'}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(toolCall.output || '');
                  }}
                  className="text-th-text-dim hover:text-th-text-secondary transition-colors"
                  title="复制"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
              <pre className={`rounded-lg px-2.5 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto leading-relaxed ${
                isError ? 'bg-red-500/10 text-red-300' : 'bg-th-base/60 text-th-text-muted'
              }`}>
                {truncate(toolCall.output, 3000)}
              </pre>
            </div>
          )}
          {/* 底部状态 */}
          <div className="flex items-center justify-between text-[10px] text-th-text-dim pt-1">
            <span>
              {isRunning ? 'Running…' : isError ? 'Failed' : duration ? `Completed in ${duration}` : 'Completed'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 格式化输入文本：如果是 JSON 则美化，否则原样显示 */
function formatInput(input: string): string {
  const parsed = tryParseJson(input);
  if (parsed) return JSON.stringify(parsed, null, 2);
  return truncate(input, 3000);
}

/**
 * 工具调用组 — 用独立框包裹
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
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
