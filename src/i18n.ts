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
    serverAddressLabel: '服务器地址',
    serverAddressHint: '请输入完整地址，包含 http:// 或 https://',
    usernameLabel: '用户名',
    usernamePlaceholder: '~/.clawchat-proxy/.clawchat-proxy 中的用户名',
    usernameHint: '需与 ~/.clawchat-proxy/.clawchat-proxy 中 PROXY_USERS 配置的用户名一致',
    userPasswordLabel: '用户密码',
    userPasswordPlaceholder: '对应用户名的密码',
    connectAction: '连接',
    retryAction: '重试',
    cancelAction: '取消',
    saveReconnectAction: '保存并重连',
    authFailedTitle: '认证失败',
    connectFailedTitle: '连接失败',
    authFailedHint: '请检查用户名和用户密码是否正确',
    connectFailedHint: '请检查服务器地址和网络',
    validationHostRequired: '请输入服务器地址',
    validationHostProtocol: '服务器地址需包含 http:// 或 https://',
    validationUsernameRequired: '请输入用户名',
    validationPasswordRequired: '请输入用户密码',
    connectedStatus: '已连接',
    connectingStatus: '连接中...',
    disconnectedStatus: '未连接',
    newConversationAction: '新建对话',
    historyDetailsAction: '历史详情',
    fileBrowserAction: '文件浏览',
    noActiveSessionError: '当前没有可用会话',
    uploadAction: '上传',
    uploadingAction: '上传中...',
    uploadFailed: '上传失败',
    savedToDocuments: '已保存到',
    downloadFailed: '下载失败',
    resendAction: '重新发送',
    deleteMessageAction: '删除消息',
    thinkingLabel: '正在思考',
    closeAction: '关闭',
    historyDetailSubtitle: '历史详情（仅来自 chat.history）',
    loadingHistoryDetails: '正在加载历史详情...',
    historyEmpty: '历史记录为空',
    archiveDownloadAction: '打包下载',
    goParentAction: '返回上级',
    loadingFiles: '正在加载文件...',
    emptyDirectory: '当前目录为空',
    nativeDownloadHintPrefix: '下载文件会保存到',
    browserDownloadHint: '下载文件会弹出另存为窗口；若浏览器不支持，则回退到默认下载目录',
    folderLabel: '文件夹',
    archivingAction: '打包中...',
    downloadingAction: '下载中...',
    sessionsTitle: '会话',
    refreshSessionsTitle: '刷新会话列表',
    noSessionsTitle: '暂无会话',
    startChatHint: '直接发送消息开始对话',
    unnamedUser: '未命名用户',
    connectionSettingsAction: '连接设置',
    disconnectAction: '断开连接',
    deleteAction: '删除',
    deleteSessionConfirm: '确定删除此会话？',
    yesterdayLabel: '昨天',
    cameraAction: '拍照',
    galleryAction: '相册',
    fileAction: '文件',
    messagePlaceholder: '输入消息...',
    switchToLight: '切换为浅色',
    switchToDark: '切换为深色',
    pairingPendingTitle: '等待设备配对批准',
    pairingPendingHint: '代理服务首次连接 OpenClaw Gateway 时需要配对批准。请前往 OpenClaw 控制台的 Nodes → Devices 页面，找到以下设备并批准连接。',
    pairingRequestIdLabel: '配对请求 ID:',
    deviceIdLabel: '设备 ID:',
    cancelConnectAction: '取消连接',
    appArchitectureHint: 'SSE+POST 架构 · Ed25519 设备签名',
    mainSessionTitle: '主对话',
    newSessionTitle: '新对话',
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
    serverAddressLabel: 'Server Address',
    serverAddressHint: 'Enter the full address, including http:// or https://',
    usernameLabel: 'Username',
    usernamePlaceholder: 'Username from ~/.clawchat-proxy/.clawchat-proxy',
    usernameHint: 'Must match a username configured in PROXY_USERS inside ~/.clawchat-proxy/.clawchat-proxy',
    userPasswordLabel: 'Password',
    userPasswordPlaceholder: 'Password for this username',
    connectAction: 'Connect',
    retryAction: 'Retry',
    cancelAction: 'Cancel',
    saveReconnectAction: 'Save and Reconnect',
    authFailedTitle: 'Authentication Failed',
    connectFailedTitle: 'Connection Failed',
    authFailedHint: 'Check whether the username and password are correct',
    connectFailedHint: 'Check the server address and network',
    validationHostRequired: 'Please enter the server address',
    validationHostProtocol: 'The server address must include http:// or https://',
    validationUsernameRequired: 'Please enter a username',
    validationPasswordRequired: 'Please enter a password',
    connectedStatus: 'Connected',
    connectingStatus: 'Connecting...',
    disconnectedStatus: 'Disconnected',
    newConversationAction: 'New Chat',
    historyDetailsAction: 'History Details',
    fileBrowserAction: 'Files',
    noActiveSessionError: 'There is no active session',
    uploadAction: 'Upload',
    uploadingAction: 'Uploading...',
    uploadFailed: 'Upload failed',
    savedToDocuments: 'Saved to',
    downloadFailed: 'Download failed',
    resendAction: 'Resend',
    deleteMessageAction: 'Delete Message',
    thinkingLabel: 'Thinking',
    closeAction: 'Close',
    historyDetailSubtitle: 'History details (from chat.history only)',
    loadingHistoryDetails: 'Loading history details...',
    historyEmpty: 'No history yet',
    archiveDownloadAction: 'Download Zip',
    goParentAction: 'Up',
    loadingFiles: 'Loading files...',
    emptyDirectory: 'This directory is empty',
    nativeDownloadHintPrefix: 'Downloaded files will be saved to',
    browserDownloadHint: 'A save dialog will open in the browser; if unsupported, it falls back to the default download directory',
    folderLabel: 'Folder',
    archivingAction: 'Archiving...',
    downloadingAction: 'Downloading...',
    sessionsTitle: 'Sessions',
    refreshSessionsTitle: 'Refresh sessions',
    noSessionsTitle: 'No sessions yet',
    startChatHint: 'Send a message to start chatting',
    unnamedUser: 'Unnamed User',
    connectionSettingsAction: 'Connection Settings',
    disconnectAction: 'Disconnect',
    deleteAction: 'Delete',
    deleteSessionConfirm: 'Delete this session?',
    yesterdayLabel: 'Yesterday',
    cameraAction: 'Camera',
    galleryAction: 'Gallery',
    fileAction: 'File',
    messagePlaceholder: 'Type a message...',
    switchToLight: 'Switch to light mode',
    switchToDark: 'Switch to dark mode',
    pairingPendingTitle: 'Waiting for Device Approval',
    pairingPendingHint: 'The proxy needs approval the first time it connects to OpenClaw Gateway. Open the OpenClaw console, go to Nodes → Devices, then approve the device below.',
    pairingRequestIdLabel: 'Pairing Request ID:',
    deviceIdLabel: 'Device ID:',
    cancelConnectAction: 'Cancel Connection',
    appArchitectureHint: 'SSE+POST architecture · Ed25519 device signing',
    mainSessionTitle: 'Main Session',
    newSessionTitle: 'New Chat',
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
