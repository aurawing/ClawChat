import {
  DEFAULTS,
  DIR_NAME_STRATEGIES,
  PLUGIN_ID,
  SESSION_KEY_MATCH_MODES,
  buildPluginEntryPatch,
  getPluginEntryFromConfig,
  normalizePluginConfig,
} from './shared.js'

function getRuntimeConfig(ctx = {}) {
  return ctx.config || ctx.currentConfig || ctx.runtimeConfig || {}
}

function getExistingValues(ctx = {}) {
  const runtimeConfig = getRuntimeConfig(ctx)
  const pluginEntry = getPluginEntryFromConfig(runtimeConfig)
  return normalizePluginConfig(pluginEntry?.config || DEFAULTS)
}

function buildWizardFields(current = DEFAULTS) {
  return [
    {
      key: 'sessionKeyFilter',
      type: 'text',
      label: 'Session key 过滤条件',
      description: '只对匹配该条件的会话启用 ClawChat 文件策略。',
      defaultValue: current.sessionKeyFilter,
      required: true,
    },
    {
      key: 'sessionKeyMatchMode',
      type: 'select',
      label: 'Session key 匹配方式',
      description: '推荐使用 includes，以兼容包含 clawchat- 的 session key。',
      defaultValue: current.sessionKeyMatchMode,
      options: SESSION_KEY_MATCH_MODES.map((value) => ({
        label: value,
        value,
      })),
      required: true,
    },
    {
      key: 'sessionFilesRoot',
      type: 'text',
      label: '会话文件根目录',
      description: '填写 OpenClaw 运行环境内可见、可写的绝对路径。',
      defaultValue: current.sessionFilesRoot,
      required: true,
    },
    {
      key: 'dirNameStrategy',
      type: 'select',
      label: '会话目录命名策略',
      description: '首版推荐 hash。',
      defaultValue: current.dirNameStrategy,
      options: DIR_NAME_STRATEGIES.map((value) => ({
        label: value,
        value,
      })),
      required: true,
    },
    {
      key: 'hashLength',
      type: 'number',
      label: 'Hash 长度',
      description: '仅在 dirNameStrategy=hash 时生效，建议保留 24。',
      defaultValue: current.hashLength,
      min: 8,
      required: true,
    },
  ]
}

async function promptText(ctx, field) {
  const helpers = [
    ctx.prompt,
    ctx.ask,
    ctx.io?.prompt,
    ctx.io?.ask,
    ctx.ui?.prompt,
  ].filter((candidate) => typeof candidate === 'function')

  if (!helpers.length) return field.defaultValue

  for (const helper of helpers) {
    const result = await helper.call(ctx.io || ctx.ui || ctx, {
      type: field.type === 'number' ? 'input' : field.type,
      name: field.key,
      message: `${field.label}${field.description ? ` (${field.description})` : ''}`,
      initial: field.defaultValue,
      defaultValue: field.defaultValue,
      options: field.options,
      min: field.min,
      required: field.required,
    })
    if (result !== undefined && result !== null && result !== '') return result
  }

  return field.defaultValue
}

async function collectSetupValues(ctx = {}) {
  if (ctx.values && typeof ctx.values === 'object') {
    return normalizePluginConfig(ctx.values)
  }

  const current = getExistingValues(ctx)
  const answers = {}
  for (const field of buildWizardFields(current)) {
    answers[field.key] = await promptText(ctx, field)
  }
  return normalizePluginConfig(answers)
}

async function applyConfigPatch(ctx, patch) {
  const writers = [
    ctx.applyConfigPatch,
    ctx.writeConfigPatch,
    ctx.updateConfig,
    ctx.io?.applyConfigPatch,
    ctx.io?.writeConfigPatch,
    ctx.ui?.applyConfigPatch,
  ].filter((candidate) => typeof candidate === 'function')

  for (const writer of writers) {
    const result = await writer.call(ctx.io || ctx.ui || ctx, patch)
    if (result !== undefined) return result
  }

  return null
}

function buildSetupResult(configValues) {
  const patch = buildPluginEntryPatch(configValues)
  return {
    ok: true,
    pluginId: PLUGIN_ID,
    title: 'ClawChat Session Files',
    message: 'ClawChat Session Files 插件配置已生成。',
    config: normalizePluginConfig(configValues),
    configPatch: patch,
    nextSteps: [
      '确认 OpenClaw 运行环境可以访问 sessionFilesRoot 指定目录。',
      '重启 Gateway 以加载新的插件配置。',
      '如果代理与 OpenClaw 不在同一文件系统，请同步配置 DOWNLOAD_PATH_MAPS。',
    ],
  }
}

export async function setup(ctx = {}) {
  const configValues = await collectSetupValues(ctx)
  const result = buildSetupResult(configValues)
  await applyConfigPatch(ctx, result.configPatch)
  return result
}

export async function setupWizard(ctx = {}) {
  const current = getExistingValues(ctx)
  const fields = buildWizardFields(current)

  if (ctx.values && typeof ctx.values === 'object') {
    const configValues = normalizePluginConfig(ctx.values)
    const result = buildSetupResult(configValues)
    await applyConfigPatch(ctx, result.configPatch)
    return result
  }

  return {
    id: `${PLUGIN_ID}.setup`,
    pluginId: PLUGIN_ID,
    title: 'ClawChat Session Files',
    description: '配置 ClawChat 会话文件目录策略与提示词注入行为。',
    fields,
    defaults: current,
    apply: async (values) => {
      const configValues = normalizePluginConfig(values)
      const result = buildSetupResult(configValues)
      await applyConfigPatch(ctx, result.configPatch)
      return result
    },
  }
}

export default {
  setup,
  setupWizard,
}
