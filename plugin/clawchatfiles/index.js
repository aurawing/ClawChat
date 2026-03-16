import {
  PLUGIN_ID,
  buildAppendSystemContext,
  buildListResult,
  buildPromptPolicy,
  buildResolveResult,
  ensureSessionDirectory,
  extractSessionKey,
  getPluginConfig,
  matchesSessionKey,
} from './shared.js'

export default function register(api) {
  api.on(
    'before_prompt_build',
    (event, ctx) => {
      const cfg = getPluginConfig(api, ctx)
      const sessionKey = extractSessionKey(event, ctx)
      if (!sessionKey || !matchesSessionKey(sessionKey, cfg)) return undefined

      const info = ensureSessionDirectory(sessionKey, cfg)
      return {
        prependSystemContext: buildPromptPolicy(info.sessionDir),
        appendSystemContext: buildAppendSystemContext(),
      }
    },
    { priority: 10 }
  )

  api.registerGatewayMethod(`${PLUGIN_ID}.ensure`, ({ params, respond }) => {
    try {
      const cfg = getPluginConfig(api)
      const sessionKey = String(params?.sessionKey || '')
      if (!sessionKey || !matchesSessionKey(sessionKey, cfg)) {
        respond(false, { ok: false, error: 'Session key is missing or does not match plugin filter' })
        return
      }
      const info = ensureSessionDirectory(sessionKey, cfg)
      respond(true, {
        ok: true,
        sessionKey,
        sessionDirId: info.sessionDirId,
        sessionDir: info.sessionDir,
      })
    } catch (error) {
      respond(false, { ok: false, error: error.message || 'Failed to ensure session directory' })
    }
  })

  api.registerGatewayMethod(`${PLUGIN_ID}.list`, ({ params, respond }) => {
    try {
      const cfg = getPluginConfig(api)
      const sessionKey = String(params?.sessionKey || '')
      if (!sessionKey || !matchesSessionKey(sessionKey, cfg)) {
        respond(false, { ok: false, error: 'Session key is missing or does not match plugin filter' })
        return
      }
      respond(true, buildListResult(sessionKey, params?.path || '', cfg))
    } catch (error) {
      respond(false, { ok: false, error: error.message || 'Failed to list session files' })
    }
  })

  api.registerGatewayMethod(`${PLUGIN_ID}.resolve`, ({ params, respond }) => {
    try {
      const cfg = getPluginConfig(api)
      const sessionKey = String(params?.sessionKey || '')
      if (!sessionKey || !matchesSessionKey(sessionKey, cfg)) {
        respond(false, { ok: false, error: 'Session key is missing or does not match plugin filter' })
        return
      }
      respond(true, buildResolveResult(sessionKey, params?.path || '', cfg))
    } catch (error) {
      respond(false, { ok: false, error: error.message || 'Failed to resolve session file' })
    }
  })
}
