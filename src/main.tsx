import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import App from './App';
import { applyLocaleSideEffects } from './i18n';
import './index.css';

// ===== 初始化主题 class（在 React 渲染前，避免闪烁）=====
(function initTheme() {
  try {
    const stored = localStorage.getItem('clawchat-theme');
    const theme = stored === 'light' ? 'light' : stored === 'dark' ? 'dark'
      : (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.classList.add(theme);
  } catch {
    document.documentElement.classList.add('dark');
  }
})();

applyLocaleSideEffects();

// ===== 原生平台初始化 =====
async function initNative() {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const isDark = document.documentElement.classList.contains('dark');
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: isDark ? '#0a0a0a' : '#ffffff' });
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch (e) {
    console.warn('[native] StatusBar init error:', e);
  }

  try {
    const root = document.documentElement;
    const computedTop = getComputedStyle(root).getPropertyValue('env(safe-area-inset-top)');
    if (!computedTop || computedTop === '0px') {
      root.style.setProperty('--safe-area-top', '0px');
      root.style.setProperty('--safe-area-bottom', '0px');
    }
  } catch {
    /* ignore */
  }

  // Android WebView：键盘收起后偶发视口高度未恢复，底部留一块空白；触发 resize 让布局重算
  try {
    await Keyboard.addListener('keyboardDidHide', () => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    });
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
