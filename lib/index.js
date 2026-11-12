/**
 * dsh-expert-team-kit / lib/index.js
 *
 * 第 3 层：cordis 插件入口（ESM）。包的 `main` / `exports["."]` 指向本文件。
 *
 * 依赖方向：本文件只向下依赖 lib/tool.mjs（→ brief / persona），
 * 不 import '@deepseek-ai/dsh-tools' 等宿主包。
 *
 * 用普通对象而非 defineTool 是为了不引入宿主依赖：宿主不保证
 * '@deepseek-ai/dsh-tools' 在任意解析上下文（单测、CLI、别的 profile）里都可解析，
 * 而 `ctx.tools.register()` 接受的就是普通对象 —— 工具规格的形状才是契约，
 * 构造它用哪个 SDK 不是。
 */

import { buildToolSpec } from './tool.mjs'

// 便利再导出：`import { buildBrief } from 'dsh-expert-team-kit'` 直接可用，
// 不必记住子路径（./persona、./brief 仍然保留，供只想要单层的调用方按需加载）。
export { buildBrief } from './brief.mjs'
export { PersonaError, listPersonas, personaRoot, resolvePersona } from './persona.mjs'
export { TOOL_ERROR_CODES, TOOL_NAME, ToolSpecError, buildToolSpec, executeExpertBrief } from './tool.mjs'

/** cordis 插件名。 */
export const name = 'expert-team-kit'

/** 依赖的服务：只用到 tools（注册本插件的工具）。 */
export const inject = ['tools']

/**
 * 挂载插件。
 *
 * 只做一件事：把工具规格注册进宿主。配置目前只有 `root`（人格素材根目录覆盖），
 * 透传给 buildToolSpec，便于素材装在非默认位置的环境使用。
 *
 * ctx 不合规时**直接抛错**而不是静默跳过：静默跳过会让插件「装上了但没工具」，
 * 排查成本远高于启动时报一行错。
 *
 * @param {{ tools: { register: (spec: unknown) => unknown } }} ctx
 * @param {{ root?: string }} [config]
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const register = ctx?.tools?.register
  if (typeof register !== 'function') {
    throw new Error(
      [
        'expert-team-kit: 挂载失败 —— ctx.tools.register 不可用。',
        '本插件依赖 cordis 的 tools 服务（inject: ["tools"]），请确认宿主已启用该服务，',
        '且在 apply 时把 ctx 传进来：apply(ctx, { root?: string })。',
      ].join('\n'),
    )
  }

  register(buildToolSpec(config))
}
