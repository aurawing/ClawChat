import { useChatStore } from './stores/chatStore';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';

export default function App() {
  const { connectionStatus, currentSessionKey } = useChatStore();

  // 仅当连接就绪 且 已获得 sessionKey 时才进入聊天页面
  if (connectionStatus === 'ready' && currentSessionKey) {
    return <ChatPage />;
  }

  return <LoginPage />;
}
