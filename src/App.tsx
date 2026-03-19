import { useChatStore } from './stores/chatStore';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';

export default function App() {
  const { connectionStatus, currentSessionKey } = useChatStore();

  // 仅当连接就绪 且 已获得 sessionKey 时才进入聊天页面
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {connectionStatus === 'ready' && currentSessionKey ? <ChatPage /> : <LoginPage />}
    </div>
  );
}
