/**
 * dsh-expert-team-kit / lib/index.js
 *
 * 第 3 层：cordis 插件入口（ESM）。包的 `main` / `exports["."]` 指向本文件。
 *
 * 这里**必须**用宿主的 `defineTool` 构造工具定义：宿主
 * `ctx.tools.register()` 接受的是 `ToolDefinition`，它要求 `output`
 * （schema + render）等字段并会做 JSON Schema 校验；裸对象能塞进去但
 * 不会出现在工具表里（实测：插件装载无报错、模型侧看不到该工具）。
 * `@deepseek-ai/dsh-tools` 由 DSH 运行时从应用本体解析（profile 故意
 * 不安装核心包，见 pnpm-workspace.yaml 的 overrides 注释），所以只能在
 * 宿主进程里 import —— 单测在没有宿主时跳过本文件的用例。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildToolSpec } from './tool.mjs'

// 便利再导出：`import { buildBrief } from 'dsh-expert-team-kit'` 直接可用。
export { buildBrief } from './brief.mjs'
export { PersonaError, listPersonas, personaRoot, resolvePersona } from './persona.mjs'
export { TOOL_ERROR_CODES, TOOL_NAME, ToolSpecError, buildToolSpec, executeExpertBrief } from './tool.mjs'

/** cordis 插件名。 */
export const name = 'expert-team-kit'

/** 依赖的服务：只用到 tools（注册本插件的工具）。 */
export const inject = ['tools']

/**
 * 把宿主无关的工具规格（lib/tool.mjs）翻译成宿主 `defineTool` 定义。
 *
 * 规格层的 `execute` 返回 `{ content: [...] }`，这里降为字符串交给
 * `output.render` 统一渲染，两层职责不混。
 *
 * @param {{ root?: string }} config
 * @returns {object} defineTool 定义的输入
 */
function definitionInput(config) {
  const spec = buildToolSpec(config)
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute(args) {
      const result = spec.execute(args)
      if (typeof result === 'string') return result
      const text = result?.content?.[0]?.text
      return typeof text === 'string' ? text : ''
    },
  }
}

/**
 * 挂载插件。
 *
 * ctx 不合规时**直接抛错**而不是静默跳过：静默跳过会变成
 * 「插件装上了但工具表里没有」，排查成本远高于启动时报一行错。
 *
 * @param {{ tools: { register: Function }, effect?: Function }} ctx
 * @param {{ root?: string }} [config]
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const tools = ctx?.tools
  if (typeof tools?.register !== 'function') {
    throw new Error(
      [
        'expert-team-kit: 挂载失败 —— ctx.tools.register 不可用。',
        '本插件依赖 cordis 的 tools 服务（inject: ["tools"]），请确认宿主已启用该服务，',
        '且在 apply 时把 ctx 传进来：apply(ctx, { root?: string })。',
      ].join('\n'),
    )
  }

  const definition = defineTool(definitionInput(config))

  // 宿主支持 ctx.effect 时跟随插件生命周期释放；否则直接注册。
  // 必须通过 tools.register(...) 调用以保住 this 绑定：注册表内部读 this.layers，
  // 把方法解构出来单独调用会抛 "Cannot read properties of undefined (reading 'layers')"，
  // 而该异常会被 cordis 吞进 fiber —— 表现就是「插件装上了但工具表里没有」。
  if (typeof ctx.effect === 'function') ctx.effect(() => tools.register(definition))
  else tools.register(definition)
}
