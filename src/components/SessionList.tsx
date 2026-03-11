import type { Session } from '../types';

interface SessionListProps {
  sessions: Session[];
  currentSessionKey: string | null;
  onSelectSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/**
 * 会话列表侧边栏
 */
export default function SessionList({
  sessions,
  currentSessionKey,
  onSelectSession,
  onDeleteSession,
  onRefresh,
  onClose,
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
    <div className="h-full flex flex-col bg-neutral-900">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-neutral-800">
        <h2 className="text-lg font-semibold text-white">会话</h2>
        <div className="flex gap-2">
          {/* 刷新按钮 */}
          <button
            onClick={onRefresh}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 transition-colors text-neutral-400"
            title="刷新会话列表"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 transition-colors text-neutral-400 lg:hidden"
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
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <svg className="w-12 h-12 mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <p className="text-sm">暂无会话</p>
            <p className="text-xs mt-1">直接发送消息开始对话</p>
          </div>
        ) : (
          <div className="py-2">
            {sessions.map((session) => (
              <div
                key={session.key}
                className={`group flex items-center mx-2 px-3 py-3 rounded-xl cursor-pointer transition-colors ${
                  session.key === currentSessionKey
                    ? 'bg-neutral-800'
                    : 'hover:bg-neutral-800/50'
                }`}
                onClick={() => onSelectSession(session.key)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-neutral-200 truncate">{session.title}</p>
                  {session.lastMessage && (
                    <p className="text-xs text-neutral-500 truncate mt-0.5">{session.lastMessage}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  <span className="text-xs text-neutral-600">{formatTime(session.updatedAt)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm('确定删除此会话？')) {
                        onDeleteSession(session.key);
                      }
                    }}
                    className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-neutral-500 hover:text-red-400 transition-all"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
