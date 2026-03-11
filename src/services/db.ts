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
  await db.sessions.update(key, { title, updatedAt: Date.now() });
}

// ===== Message 操作 =====

export async function getMessages(sessionKey: string): Promise<Message[]> {
  return db.messages.where('sessionKey').equals(sessionKey).sortBy('createdAt');
}

export async function saveMessage(message: Message): Promise<void> {
  await db.messages.put(message);
  // 同时更新会话的最后消息
  const session = await db.sessions.get(message.sessionKey);
  if (session) {
    await db.sessions.update(message.sessionKey, {
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
