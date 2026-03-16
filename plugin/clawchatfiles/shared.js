import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

export const PLUGIN_ID = 'clawchatfiles'
export const PACKAGE_NAME = '@claw_chat/clawchatfiles'
export const DEFAULT_SESSION_FILES_ROOT = path.join(
  os.homedir(),
  '.openclaw',
  'workspace',
  'sessions'
)
export const DEFAULTS = {
  sessionKeyFilter: 'clawchat-',
  sessionKeyMatchMode: 'includes',
  sessionFilesRoot: DEFAULT_SESSION_FILES_ROOT,
  dirNameStrategy: 'hash',
  hashLength: 24,
}

export const SESSION_KEY_MATCH_MODES = ['prefix', 'includes', 'regex']
export const DIR_NAME_STRATEGIES = ['hash', 'raw', 'urlencoded']

export function normalizePluginConfig(rawConfig = {}) {
  const sessionKeyFilter = String(rawConfig.sessionKeyFilter ?? DEFAULTS.sessionKeyFilter).trim()
  const sessionKeyMatchMode = SESSION_KEY_MATCH_MODES.includes(String(rawConfig.sessionKeyMatchMode || '').trim().toLowerCase())
    ? String(rawConfig.sessionKeyMatchMode).trim().toLowerCase()
    : DEFAULTS.sessionKeyMatchMode
  const sessionFilesRoot = String(rawConfig.sessionFilesRoot ?? DEFAULTS.sessionFilesRoot).trim() || DEFAULTS.sessionFilesRoot
  const dirNameStrategy = DIR_NAME_STRATEGIES.includes(String(rawConfig.dirNameStrategy || '').trim().toLowerCase())
    ? String(rawConfig.dirNameStrategy).trim().toLowerCase()
    : DEFAULTS.dirNameStrategy
  const hashLength = Math.max(8, Number.parseInt(rawConfig.hashLength, 10) || DEFAULTS.hashLength)

  return {
    sessionKeyFilter,
    sessionKeyMatchMode,
    sessionFilesRoot,
    dirNameStrategy,
    hashLength,
  }
}

export function getPluginEntryFromConfig(runtimeConfig = {}) {
  return runtimeConfig?.plugins?.entries?.[PLUGIN_ID] || {}
}

export function getPluginConfig(api, ctx) {
  const runtimeConfig = api?.getConfig?.() || ctx?.config || {}
  const pluginConfig = getPluginEntryFromConfig(runtimeConfig)?.config || {}
  return normalizePluginConfig(pluginConfig)
}

export function buildPluginEntryPatch(rawConfig = {}) {
  return {
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          enabled: true,
          hooks: {
            allowPromptInjection: true,
          },
          config: normalizePluginConfig(rawConfig),
        },
      },
    },
  }
}

export function normalizeRootDir(rootDir) {
  return path.resolve(String(rootDir || DEFAULTS.sessionFilesRoot))
}

export function matchesSessionKey(sessionKey, cfg) {
  if (!sessionKey) return false
  const filter = String(cfg.sessionKeyFilter || '').trim()
  if (!filter) return true

  const mode = String(cfg.sessionKeyMatchMode || 'includes').trim().toLowerCase()
  if (mode === 'prefix') return sessionKey.startsWith(filter)
  if (mode === 'regex') {
    try {
      return new RegExp(filter).test(sessionKey)
    } catch {
      return false
    }
  }
  return sessionKey.includes(filter)
}

export function deriveSessionDirId(sessionKey, cfg) {
  const strategy = String(cfg.dirNameStrategy || 'hash').trim().toLowerCase()
  if (strategy === 'raw') return sanitizeSegment(sessionKey)
  if (strategy === 'urlencoded') return encodeURIComponent(sessionKey)
  const hashLength = Math.max(8, Number(cfg.hashLength) || DEFAULTS.hashLength)
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, hashLength)
}

export function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120)
}

export function getSessionDirectoryInfo(sessionKey, cfg) {
  const normalizedCfg = normalizePluginConfig(cfg)
  const sessionDirId = deriveSessionDirId(sessionKey, normalizedCfg)
  const sessionFilesRoot = normalizeRootDir(normalizedCfg.sessionFilesRoot)
  const sessionDir = path.resolve(sessionFilesRoot, sessionDirId)
  return {
    sessionDirId,
    sessionFilesRoot,
    sessionDir,
  }
}

export function ensureSessionDirectory(sessionKey, cfg) {
  const info = getSessionDirectoryInfo(sessionKey, cfg)
  mkdirSync(info.sessionDir, { recursive: true })
  writeSessionMeta(info.sessionDir, sessionKey, info.sessionDirId)
  return info
}

export function writeSessionMeta(sessionDir, sessionKey, sessionDirId) {
  const metaPath = path.join(sessionDir, '.session-files.json')
  const now = Date.now()
  let existing = null
  if (existsSync(metaPath)) {
    try {
      existing = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {
      existing = null
    }
  }
  const next = {
    sessionKey,
    sessionDirId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  writeFileSync(metaPath, JSON.stringify(next, null, 2), 'utf8')
}

export function resolveRelativePath(sessionKey, relativePath, cfg) {
  const info = getSessionDirectoryInfo(sessionKey, cfg)
  const safeRelativePath = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim()
  const absolutePath = path.resolve(info.sessionDir, safeRelativePath || '.')
  if (!isWithinRoot(absolutePath, info.sessionDir)) {
    throw new Error('Requested path escapes session directory')
  }
  return {
    ...info,
    relativePath: safeRelativePath,
    absolutePath,
  }
}

export function isWithinRoot(targetPath, rootPath) {
  const normalizedTarget = path.resolve(targetPath)
  const normalizedRoot = path.resolve(rootPath)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep)
}

export function buildPromptPolicy(sessionDir) {
  return [
    'File Output Policy:',
    '- All generated files for this conversation must be written under the session output directory only.',
    '- Do not write files outside the session output directory.',
    '- If a tool creates a file elsewhere, move or copy it into the session output directory before finishing.',
    `- Session output directory: ${sessionDir}`,
  ].join('\n')
}

export function buildAppendSystemContext() {
  return [
    'Output Reporting Rules:',
    '- Prefer reporting generated files using file names or paths relative to the session output directory.',
    '- Do not expose unrelated absolute local paths unless necessary.',
    '- If writing to the session output directory fails, explain the reason explicitly.',
  ].join('\n')
}

export function extractSessionKey(event, ctx) {
  return (
    event?.sessionKey ||
    event?.payload?.sessionKey ||
    ctx?.sessionKey ||
    ctx?.session?.key ||
    ctx?.message?.sessionKey ||
    null
  )
}

export function buildListResult(sessionKey, relativePath, cfg) {
  const info = ensureSessionDirectory(sessionKey, cfg)
  const resolved = resolveRelativePath(sessionKey, relativePath, cfg)
  const stat = statSync(resolved.absolutePath)
  if (!stat.isDirectory()) throw new Error('Requested path is not a directory')

  const entries = readdirSync(resolved.absolutePath, { withFileTypes: true })
    .filter((entry) => entry.name !== '.session-files.json')
    .map((entry) => {
      const fullPath = path.join(resolved.absolutePath, entry.name)
      const entryStat = statSync(fullPath)
      const childRelativePath = resolved.relativePath
        ? `${resolved.relativePath}/${entry.name}`
        : entry.name
      return {
        name: entry.name,
        path: childRelativePath.replace(/\\/g, '/'),
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : entryStat.size,
        modifiedAt: entryStat.mtimeMs || entryStat.mtime.getTime(),
      }
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })

  return {
    ok: true,
    sessionKey,
    sessionDirId: info.sessionDirId,
    sessionDir: info.sessionDir,
    currentPath: resolved.relativePath,
    parentPath: resolved.relativePath ? resolved.relativePath.split('/').slice(0, -1).join('/') || '' : null,
    entries,
  }
}

export function buildResolveResult(sessionKey, relativePath, cfg) {
  const info = ensureSessionDirectory(sessionKey, cfg)
  const resolved = resolveRelativePath(sessionKey, relativePath, cfg)
  if (!existsSync(resolved.absolutePath)) {
    return {
      ok: false,
      sessionKey,
      sessionDirId: info.sessionDirId,
      sessionDir: info.sessionDir,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      exists: false,
    }
  }

  const stat = statSync(resolved.absolutePath)
  return {
    ok: true,
    sessionKey,
    sessionDirId: info.sessionDirId,
    sessionDir: info.sessionDir,
    relativePath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    name: path.basename(resolved.absolutePath),
    size: stat.isFile() ? stat.size : 0,
    modifiedAt: stat.mtimeMs || stat.mtime.getTime(),
  }
}
