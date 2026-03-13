import Dexie, { type EntityTable } from 'dexie';
import type { Message, Session } from '../types';

/**
 * ClawChat 本地数据库 - 使用 Dexie (IndexedDB)
 * 支持离线消息缓存和会话持久化
 */
class ClawChatDB extends Dexie {
  messages!: EntityTable<Message, 'id'>;
  sessions!: EntityTable<Session, 'key'>;

  constructor() {
    super('ClawChatDB');
    this.version(1).stores({
      messages: 'id, sessionKey, createdAt',
      sessions: 'key, updatedAt',
    });
  }
}

export const db = new ClawChatDB();

// ===== Session 操作 =====

export async function getSessions(): Promise<Session[]> {
  return db.sessions.orderBy('updatedAt').reverse().toArray();
}

export async function getSession(key: string): Promise<Session | undefined> {
  return db.sessions.get(key);
}

export async function saveSession(session: Session): Promise<void> {
  await db.sessions.put(session);
}

export async function deleteSession(key: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.messages], async () => {
    await db.messages.where('sessionKey').equals(key).delete();
    await db.sessions.delete(key);
  });
}

export async function updateSessionTitle(key: string, title: string): Promise<void> {
  // 使用 put 确保即使 session 不存在也能创建（而非 update 静默忽略）
  const existing = await db.sessions.get(key);
  if (existing) {
    await db.sessions.update(key, { title, updatedAt: Date.now() });
  } else {
    await db.sessions.put({ key, title, updatedAt: Date.now() });
  }
}

// ===== Message 操作 =====

export async function getMessages(sessionKey: string): Promise<Message[]> {
  return db.messages.where('sessionKey').equals(sessionKey).sortBy('createdAt');
}

export async function saveMessage(message: Message): Promise<void> {
  // 清理 blob: URL（重启后失效，不应存入 DB）
  if (message.attachments) {
    message = {
      ...message,
      attachments: message.attachments.map((att) => {
        if (att.url && att.url.startsWith('blob:')) {
          // 有 base64 时移除 blob URL，无 base64 时转换为 data URL 后移除 blob
          const { url: _blobUrl, ...rest } = att;
          return rest;
        }
        return att;
      }),
    };
  }
  await db.messages.put(message);
  // 同时更新（或创建）会话记录
  const session = await db.sessions.get(message.sessionKey);
  if (session) {
    await db.sessions.update(message.sessionKey, {
      lastMessage: message.content.slice(0, 100),
      updatedAt: Date.now(),
    });
  } else {
    // session 不存在时自动创建
    await db.sessions.put({
      key: message.sessionKey,
      title: '新对话',
      lastMessage: message.content.slice(0, 100),
      updatedAt: Date.now(),
    });
  }
}

export async function updateMessage(id: string, updates: Partial<Message>): Promise<void> {
  await db.messages.update(id, updates);
}

export async function deleteMessage(id: string): Promise<void> {
  await db.messages.delete(id);
}

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', [db.sessions, db.messages], async () => {
    await db.messages.clear();
    await db.sessions.clear();
  });
}
