import { useChatStore } from './stores/chatStore';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';

export default function App() {
  const { connectionStatus } = useChatStore();

  // 已就绪才显示聊天页面
  if (connectionStatus === 'ready' || connectionStatus === 'connected') {
    return <ChatPage />;
  }

  return <LoginPage />;
}
