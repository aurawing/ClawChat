export type SupportedLocale = 'zh-CN' | 'en';
export type LocalePreference = 'system' | SupportedLocale;

const LOCALE_STORAGE_KEY = 'clawchat-locale';
const LOCALE_CHANGE_EVENT = 'clawchat-locale-change';

const messages = {
  'zh-CN': {
    appName: '虾聊',
    loginSubtitle: '连接到 OpenClaw 服务',
    settingsTitle: '连接设置',
    languageLabel: '显示语言',
    followSystem: '跟随系统',
    chinese: '中文',
    english: 'English',
    welcomeTitle: '欢迎使用虾聊',
    welcomeDescription: '已连接 OpenClaw 智能体，发送消息开始对话。支持流式输出、工具调用、文件上传。',
  },
  en: {
    appName: 'ClawChat',
    loginSubtitle: 'Connect to OpenClaw',
    settingsTitle: 'Settings',
    languageLabel: 'Language',
    followSystem: 'Follow System',
    chinese: '中文',
    english: 'English',
    welcomeTitle: 'Welcome to ClawChat',
    welcomeDescription: 'Connected to OpenClaw. Send a message to start chatting. Supports streaming output, tool calls, and file uploads.',
  },
} as const;

export type MessageKey = keyof typeof messages.en;

export function getLocalePreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored === 'zh-CN' || stored === 'en' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function getSystemLocale(): SupportedLocale {
  const lang = typeof navigator !== 'undefined' ? String(navigator.language || '').toLowerCase() : '';
  return lang.startsWith('zh') ? 'zh-CN' : 'en';
}

export function resolveLocale(preference: LocalePreference = getLocalePreference()): SupportedLocale {
  return preference === 'system' ? getSystemLocale() : preference;
}

export function t(key: MessageKey, locale = resolveLocale()): string {
  return messages[locale][key];
}

export function getAppName(locale = resolveLocale()): string {
  return t('appName', locale);
}

export function applyLocaleSideEffects(): void {
  const locale = resolveLocale();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.title = getAppName(locale);
  }
}

export function setLocalePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
  applyLocaleSideEffects();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT));
  }
}

export function subscribeLocaleChange(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener(LOCALE_CHANGE_EVENT, listener);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(LOCALE_CHANGE_EVENT, listener);
    window.removeEventListener('storage', handleStorage);
  };
}
