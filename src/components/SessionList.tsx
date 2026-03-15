import { useState, useRef } from 'react';
import type { Session } from '../types';

interface SessionListProps {
  sessions: Session[];
  currentSessionKey: string | null;
  username?: string | null;
  onSelectSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
  onNewSession: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onDisconnect?: () => void;
}

/**
 * 会话列表侧边栏
 */
export default function SessionList({
  sessions,
  currentSessionKey,
  username,
  onSelectSession,
  onDeleteSession,
  onNewSession,
  onRefresh,
  onClose,
  onDisconnect,
}: SessionListProps) {
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return '昨天';
    }

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div className="h-full flex flex-col bg-th-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-th-border-subtle safe-area-top">
        <h2 className="text-lg font-semibold text-th-text">会话</h2>
        <div className="flex gap-2">
          {/* 新建会话按钮 */}
          <button
            onClick={onNewSession}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-emerald-400"
            title="新建对话"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          {/* 刷新按钮 */}
          <button
            onClick={onRefresh}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted"
            title="刷新会话列表"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-muted lg:hidden"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-th-text-dim">
            <svg className="w-12 h-12 mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <p className="text-sm">暂无会话</p>
            <p className="text-xs mt-1">直接发送消息开始对话</p>
          </div>
        ) : (
          <div className="py-2">
            {sessions.map((session) => (
              <SessionItem
                key={session.key}
                session={session}
                isCurrent={session.key === currentSessionKey}
                onSelect={() => onSelectSession(session.key)}
                onDelete={() => onDeleteSession(session.key)}
                formatTime={formatTime}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部用户信息 */}
      {(username || onDisconnect) && (
        <div className="border-t border-th-border-subtle px-4 py-3 safe-area-bottom">
          <div className="flex items-center gap-3">
            {/* 用户头像 */}
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {username ? username.charAt(0).toUpperCase() : '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-th-text-secondary truncate">
                {username || '未命名用户'}
              </p>
              <p className="text-xs text-th-text-dim">已连接</p>
            </div>
            {onDisconnect && (
              <button
                onClick={onDisconnect}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-th-elevated transition-colors text-th-text-dim hover:text-red-400"
                title="断开连接"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 单条会话项 - 支持左滑显示删除按钮（触屏） */
function SessionItem({
  session,
  isCurrent,
  onSelect,
  onDelete,
  formatTime,
}: {
  session: Session;
  isCurrent: boolean;
  onSelect: () => void;
  onDelete: () => void;
  formatTime: (ts: number) => string;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    if (deltaX < -60 && deltaY < 30) {
      setShowDelete(true);
    } else if (deltaX > 40) {
      setShowDelete(false);
    }
  };

  return (
    <div
      className="relative mx-2 mb-0.5 overflow-hidden rounded-xl"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* 删除背景 */}
      <div className="absolute inset-y-0 right-0 flex items-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm('确定删除此会话？')) {
              onDelete();
              setShowDelete(false);
            } else {
              setShowDelete(false);
            }
          }}
          className={`h-full px-5 bg-red-600 text-white text-sm font-medium transition-all duration-200 ${
            showDelete ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          删除
        </button>
      </div>

      {/* 会话内容 */}
      <div
        className={`flex items-center px-3 py-3 cursor-pointer transition-all duration-200 ${
          isCurrent ? 'bg-th-elevated' : 'hover:bg-th-hover bg-th-surface'
        } ${showDelete ? '-translate-x-16' : 'translate-x-0'}`}
        onClick={() => {
          if (showDelete) {
            setShowDelete(false);
          } else {
            onSelect();
          }
        }}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-th-text-secondary truncate">{session.title}</p>
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          <span className="text-xs text-th-text-faint">{formatTime(session.updatedAt)}</span>
          {/* 桌面端 hover 显示删除 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('确定删除此会话？')) {
                onDelete();
              }
            }}
            className="w-6 h-6 hidden lg:flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-th-text-dim hover:text-red-400 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
