import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import App from './App';
import './index.css';

// ===== 原生平台初始化 =====
async function initNative() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    // 设置状态栏颜色以匹配主题
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0a0a0a' });
    // 不让 WebView 延伸到状态栏后面
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch (e) {
    console.warn('[native] StatusBar init error:', e);
  }

  // 检测并设置安全区 CSS 变量 (兼容 Android 15 强制 edge-to-edge)
  try {
    const root = document.documentElement;
    const computedTop = getComputedStyle(root).getPropertyValue('env(safe-area-inset-top)');
    if (!computedTop || computedTop === '0px') {
      // env() 未生效时设置 fallback CSS 变量
      root.style.setProperty('--safe-area-top', '0px');
      root.style.setProperty('--safe-area-bottom', '0px');
    }
  } catch {
    /* ignore */
  }
}

initNative();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
