/**
 * dsh-expert-team-kit / lib/tool.mjs
 *
 * 第 3 层：插件工具规格（tool spec）。
 *
 * 架构取向（Software Architect 人格的方法论）：
 * - **接口即契约**：`buildToolSpec()` 返回的是纯数据 + 一个 execute 函数，
 *   形状固定、无隐藏状态；宿主用什么注册方式都不影响这份契约。
 * - **依赖方向朝内**：本模块只依赖 lib/persona.mjs 与 lib/brief.mjs，
 *   绝不 import 宿主包（`@deepseek-ai/dsh-tools`）。宿主依赖一旦进内层，
 *   单测就必须拉起整个宿主，边界立刻被焊死 —— 这也是插件入口用普通对象的原因。
 * - **边界由本层负责**：参数的类型/必填/取值范围在**工具边界**校验一次，
 *   报错点名参数并给修法；不让它下沉成 brief 的「缺 task」或 persona 的路径报错，
 *   否则调用方拿到的错误分不清「我传错了」还是「环境坏了」。
 * - **失败要可分支**：所有错误带 `code`，未知专家另带 `suggestions` 与 `cause`，
 *   调用方可按码处理，也能拿到完整搜索路径做人工排查。
 *
 * 复审（task-11）补的四条契约：
 * - **S1** 「规范化后为空」这类 slug 形状错误（`PERSONA_INVALID_SLUG`）必须在**本层**
 *   翻译成 `ToolSpecError(param: 'expert')`：它是入参错误，不是素材/环境问题。
 *   漏到下层会让按 `TOOL_*` 码分支的调用方整整丢掉一类错误（param 还是 undefined）。
 * - **S3** 验收命令里出现行首三反引号会截断 brief 生成的 ```bash 围栏。该问题的根因在
 *   brief.mjs（现由并行队友改为「取内容最长反引号串 + 1」的自适应围栏），本层不再重复实现
 *   同一套加宽逻辑（重复实现既跑不到、又会在两层漂移）；本层的职责是用**端到端用例**锁住
 *   「execute 产出的任务书围栏不会被验收命令截断、命令内容逐字节不变」这个契约 ——
 *   若 brief 侧将来回退，这里会先红。
 * - **S4** 未知参数键报 `TOOL_INVALID_PARAM`：本模块自己就写了「静默忽略会让调用方以为
 *   参数生效了」，那么多余/拼错的键也必须报错，而不是悄悄丢弃。
 * - **N5** 空 scopes 与 brief 层逐格对齐：单字符串空串 = 「未提供」（两层都接受），
 *   数组里的空项 = 「值非法」（两层都拒绝并点名 `scopes[i]`）。调用方一套逻辑可处理两层。
 */

import { DEFAULT_KIND, DEFAULT_SURFACE, KINDS, SURFACES, buildBrief } from './brief.mjs'
import { PERSONA_ERROR_CODES, resolvePersona } from './persona.mjs'

/** 工具名。宿主注册与测试都引用这个常量，避免字面量漂移。 */
export const TOOL_NAME = 'expert_brief'

/**
 * 工具层错误码。
 * @type {Readonly<Record<string, string>>}
 */
export const TOOL_ERROR_CODES = Object.freeze({
  /** execute 的入参整体不是对象（undefined / null / 字符串 / 数组…） */
  INVALID_ARGS: 'TOOL_INVALID_ARGS',
  /** 必填参数缺失或为空 */
  MISSING_PARAM: 'TOOL_MISSING_PARAM',
  /** 可选参数给了但类型/形状不对 */
  INVALID_PARAM: 'TOOL_INVALID_PARAM',
  /** expert 非空但素材里找不到（已带候选建议） */
  UNKNOWN_EXPERT: 'TOOL_UNKNOWN_EXPERT',
})

/** 缺省队友名（与 buildBrief 的缺省一致）。 */
export const DEFAULT_WORKER = 'worker'

/** 未知专家最多给几条候选（与 persona.mjs 的 MAX_SUGGESTIONS 一致）。 */
const MAX_SUGGESTIONS = 3

/**
 * execute 接受的参数键白名单（对应 buildToolSpec().parameters）。
 * 不在这份清单里的键一律报错 —— 见文件头 S4。
 */
const ALLOWED_ARG_KEYS = Object.freeze([
  'expert',
  'task',
  'verify',
  'scopes',
  'task_id',
  'worker',
  'surface',
  'kind',
])

/**
 * 归因于 **expert 入参** 的 persona 错误码：这些要被翻译成 `ToolSpecError`。
 *
 * 其余码（素材根目录缺失 / 读不出 / 素材缺 name / 越界）属于环境或素材问题，原样透传，
 * 混成入参错误会让排查方向彻底跑偏。
 *
 * 同时列字面量：persona.mjs 正在并行返工（新增越界校验），
 * 码可能新增或改名；用「常量 ∪ 字面量」保证两边都存在时都能命中。
 */
const EXPERT_ARGUMENT_CODES = new Set(
  [
    PERSONA_ERROR_CODES.INVALID_SLUG,
    PERSONA_ERROR_CODES.NOT_FOUND,
    'PERSONA_INVALID_SLUG',
    'PERSONA_NOT_FOUND',
    'PERSONA_OUTSIDE_ROOT',
  ].filter((code) => typeof code === 'string'),
)

/** 「未知专家」这一类码（其余归因于入参的码按「值非法」处理）。 */
const UNKNOWN_EXPERT_CODES = new Set(
  [PERSONA_ERROR_CODES.NOT_FOUND, 'PERSONA_NOT_FOUND'].filter((code) => typeof code === 'string'),
)


/**
 * 工具参数非法。
 */
export class ToolSpecError extends Error {
  /**
   * @param {string} code 见 TOOL_ERROR_CODES
   * @param {string} message 可操作的错误信息（点名参数 + Fix）
   * @param {{ param?: string, suggestions?: string[], cause?: Error }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ToolSpecError'
    this.code = code
    if (typeof details.param === 'string') this.param = details.param
    if (Array.isArray(details.suggestions)) this.suggestions = details.suggestions
    if (details.cause instanceof Error) this.cause = details.cause
    Error.captureStackTrace?.(this, ToolSpecError)
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 把任意输入描述成一句人能读的话（用于错误信息）。
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === undefined) return 'undefined（未提供）'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value === '' ? '空字符串 ""' : `字符串 ${JSON.stringify(value)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${String(value)}（${typeof value}）`
  }
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`
  return Object.prototype.toString.call(value)
}

/**
 * 必填文本参数。缺失 / 空串 / 纯空白 / 非字符串一律抛 MISSING_PARAM，
 * 并在 message 里点名参数与修法（含修正后的调用样例）。
 *
 * @param {string} param 参数名（与 parameters 的键一致）
 * @param {unknown} value
 * @param {string} fix 这条参数的修法说明
 * @returns {string} trim 后的值
 */
function requireText(param, value, fix) {
  if (!isNonEmptyString(value)) {
    throw new ToolSpecError(
      TOOL_ERROR_CODES.MISSING_PARAM,
      [
        `${TOOL_NAME}: 缺少必填参数 "${param}"，实际收到：${describeValue(value)}`,
        `Fix: ${fix}`,
        `     "${param}" 为空会让任务书不可用，所以这里直接失败而不是生成半份任务书。`,
      ].join('\n'),
      { param },
    )
  }
  return value.trim()
}

/**
 * 可选文本参数：未提供（undefined / null / 空串 / 纯空白）→ undefined，
 * 提供了但不是字符串 → INVALID_PARAM（静默忽略会让调用方以为参数生效了）。
 *
 * @param {string} param
 * @param {unknown} value
 * @param {string} fix
 * @returns {string | undefined}
 */
function optionalText(param, value, fix) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ToolSpecError(
      TOOL_ERROR_CODES.INVALID_PARAM,
      [
        `${TOOL_NAME}: 参数 "${param}" 必须是字符串，实际收到：${describeValue(value)}`,
        `Fix: ${fix}`,
      ].join('\n'),
      { param },
    )
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 可选取值受限于白名单的文本参数（surface / kind）。
 *
 * 口径与 brief 层 `normalizeEnum` 逐格对齐（同 N5 的做法）：
 * - 未提供 / null / 空串 / 纯空白 → undefined（由 buildBrief 用缺省值）；
 * - 非字符串 → INVALID_PARAM；
 * - 不在白名单 → INVALID_PARAM，并列出允许值。
 *
 * **为什么不静默退回缺省**：`surface: "agent-team"`（少个 s）被吞成 none 时，
 * 产出的是一份「看起来正常、但没有认领流程」的任务书 —— 静默降级比报错更难排查。
 *
 * @param {string} param
 * @param {unknown} value
 * @param {ReadonlyArray<string>} allowed
 * @param {string} fallback 缺省值（只用于提示文案）
 * @returns {string | undefined}
 */
function optionalEnum(param, value, allowed, fallback) {
  if (value === undefined || value === null) return undefined

  const allowedText = allowed.join(' | ')

  if (typeof value !== 'string') {
    throw new ToolSpecError(
      TOOL_ERROR_CODES.INVALID_PARAM,
      [
        `${TOOL_NAME}: 参数 "${param}" 必须是字符串，实际收到：${describeValue(value)}`,
        `Fix: ${param}: "${fallback}"，允许值只有 ${allowedText}。`,
      ].join('\n'),
      { param },
    )
  }

  const trimmed = value.trim()
  if (trimmed === '') return undefined

  if (!allowed.includes(trimmed)) {
    throw new ToolSpecError(
      TOOL_ERROR_CODES.INVALID_PARAM,
      [
        `${TOOL_NAME}: 参数 "${param}" 只接受 ${allowedText}，实际收到：${JSON.stringify(trimmed)}`,
        `Fix: 改成上面某一个值（缺省是 ${fallback}）；大小写与连字符要一致，"agent_teams" 不算 "agent-teams"。`,
        '     拼错会让任务书静默退回缺省值、丢掉本该生成的协议调用，所以这里直接失败。',
      ].join('\n'),
      { param },
    )
  }

  return trimmed
}

/**
 * 可选路径前缀列表。
 * - 未提供 → undefined（由 buildBrief 归一成 `[]`，即「未限定作用域」）
 * - 单个字符串 → trim 后包成单元素数组；**空串 / 纯空白视同「未提供」**
 * - 数组 → 逐项必须是**非空字符串**
 *
 * **口径（N5）**：与 brief 层 `normalizeScopes` 逐格对齐，调用方可以用同一段逻辑处理两层错误 ——
 * 同一份输入在两层得到的结论必须相同（接受 / 拒绝），拒绝时都点名 `scopes[i]`：
 * - `scopes: ''` / `'   '`（单字符串）→ 两层都当「未提供」接受，不报错；
 * - `scopes: ['']` / `['  ']`（数组里的空项）→ 两层都拒绝，都点名 `scopes[index]`；
 * - `scopes: 123` 这类非字符串非数组 → 两层都拒绝，都点名 `scopes`。
 *
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function optionalScopes(value) {
  if (value === undefined || value === null) return undefined

  // 单字符串：与 brief 层同口径 —— 空串/纯空白 = 未提供（不是「非法项」）
  if (typeof value === 'string') {
    const single = value.trim()
    return single === '' ? undefined : [single]
  }

  if (!Array.isArray(value)) {
    throw new ToolSpecError(
      TOOL_ERROR_CODES.INVALID_PARAM,
      [
        `${TOOL_NAME}: 参数 "scopes" 必须是字符串数组，实际收到：${describeValue(value)}`,
        'Fix: scopes: ["dsh-expert-team-kit/lib/tool.mjs"]；不限定作用域就不传该参数（或传 []）。',
      ].join('\n'),
      { param: 'scopes' },
    )
  }

  if (value.length === 0) return []

  return value.map((item, index) => {
    if (!isNonEmptyString(item)) {
      throw new ToolSpecError(
        TOOL_ERROR_CODES.INVALID_PARAM,
        [
          `${TOOL_NAME}: 参数 "scopes[${index}]" 必须是非空字符串，实际收到：${describeValue(item)}`,
          'Fix: 每一项写一个相对路径前缀，例如 "dsh-expert-team-kit/test/tool.test.mjs"；',
          '     不限定作用域就传空数组 []，或直接不传该参数。',
        ].join('\n'),
        { param: `scopes[${index}]` },
      )
    }
    return item.trim()
  })
}

/**
 * 入参整体形状校验：非对象（含 undefined / null / 数组 / 函数）一律拒绝，
 * 而不是让 `args.expert` 在后续步骤炸成 TypeError。
 *
 * **S4**：同时拒绝未知键。只读白名单键、把多余键丢掉，会让调用方以为参数生效了 ——
 * 典型踩坑是把 `root` 塞进 args（它其实是 `executeExpertBrief(args, { root })` 的第二个参数），
 * 于是「我指定了素材目录」这个意图被静默吞掉，产物用的是默认目录。
 *
 * @param {unknown} args
 * @returns {Record<string, unknown>}
 */
function normalizeArgs(args) {
  if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolSpecError(
      TOOL_ERROR_CODES.INVALID_ARGS,
      [
        `${TOOL_NAME}: execute 的入参必须是对象，实际收到：${describeValue(args)}`,
        `Fix: ${TOOL_NAME}({ expert: "code-reviewer", task: "...", verify: "..." })`,
      ].join('\n'),
    )
  }

  const input = /** @type {Record<string, unknown>} */ (args)
  const unknownKeys = Object.keys(input).filter((key) => !ALLOWED_ARG_KEYS.includes(key))

  if (unknownKeys.length > 0) {
    const shown = unknownKeys.map((key) => `"${key}"`).join('、')
    const lines = [
      `${TOOL_NAME}: 不认识的参数 ${shown}（可用参数：${ALLOWED_ARG_KEYS.join(' / ')}）`,
      '本工具不接受多余/拼错的键：静默忽略会让你以为参数生效了。',
    ]
    if (unknownKeys.includes('root')) {
      lines.push('Fix: `root`（人格素材根目录）不是工具参数，它是第二个参数：')
      lines.push('  executeExpertBrief(args, { root })   或   buildToolSpec({ root }).execute(args)')
    } else {
      lines.push(`Fix: 检查拼写；删掉 ${shown} 后重试。`)
    }
    throw new ToolSpecError(TOOL_ERROR_CODES.INVALID_PARAM, lines.join('\n'), {
      param: unknownKeys[0],
    })
  }

  return input
}

/**
 * 解析专家人格，把**归因于 expert 入参**的错误翻译成点名 expert 的 `ToolSpecError`。
 *
 * 翻译哪些（见 EXPERT_ARGUMENT_CODES）：
 * - 「找不到」→ `TOOL_UNKNOWN_EXPERT`，带候选建议；
 * - 「规范化后为空」（`expert: ".md"` / `"/"` / `"./"` 这类非空但去掉前后缀就空了的写法）
 *   → `TOOL_INVALID_PARAM`。
 *
 * 其余人格错误（素材根目录缺失 / 读不出 / 素材缺 name）**原样透传**：
 * 那是环境或素材问题，不是调用方传错了参数，混成 INVALID_PARAM 会误导排查方向。
 *
 * 所有翻译后的错误都保留 `cause`，原始错误信息（含完整搜索路径）不丢。
 *
 * @param {string} expert
 * @param {string} [root]
 * @returns {{ slug: string, path: string, name: string, description: string, body: string }}
 * @throws {ToolSpecError | PersonaError}
 */
function resolveExpert(expert, root) {
  try {
    return resolvePersona(expert, root ? { root } : undefined)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : ''

    // 不是「expert 传错了」这一类：环境/素材问题，原样抛出（保留 PersonaError 身份与 code）
    if (!EXPERT_ARGUMENT_CODES.has(code)) throw error

    if (UNKNOWN_EXPERT_CODES.has(code)) {
      const suggestions = Array.isArray(error.suggestions)
        ? error.suggestions.slice(0, MAX_SUGGESTIONS)
        : []

      const lines = [`${TOOL_NAME}: 参数 "expert" 指向的专家人格不存在：${expert}`]
      if (suggestions.length > 0) {
        lines.push(`最接近的候选（最多 ${MAX_SUGGESTIONS} 个）：`)
        for (const suggestion of suggestions) lines.push(`  - ${suggestion}`)
      }
      lines.push('Fix: 用上面任一候选重试，三种写法都支持：')
      lines.push('  "engineering-code-reviewer" / "code-reviewer" / "engineering/code-reviewer"')
      lines.push('     想枚举全部可用标识：listPersonas()；完整搜索路径见 error.cause.message。')

      throw new ToolSpecError(TOOL_ERROR_CODES.UNKNOWN_EXPERT, lines.join('\n'), {
        param: 'expert',
        suggestions,
        cause: error,
      })
    }

    // 剩下是「形状不对」：非空但规范化后为空（".md" / "/" / "./"）、或越界路径
    throw new ToolSpecError(
      TOOL_ERROR_CODES.INVALID_PARAM,
      [
        `${TOOL_NAME}: 参数 "expert" 的值无法解析成专家标识：${JSON.stringify(expert)}`,
        '它必须能定位到素材里的一个人格文件，三种写法都支持：',
        '  "engineering-code-reviewer" / "code-reviewer" / "engineering/code-reviewer"',
        '注意：只传 ".md"、"/"、"///"、"\\"、"./" 这类去掉前后缀就为空的写法会被拒绝。',
        'Fix: 换成完整标识；想枚举全部可用标识用 listPersonas()。',
        '（完整原因见 error.cause.message）',
      ].join('\n'),
      { param: 'expert', cause: error },
    )
  }
}

/**
 * 工具的执行体（单独导出，便于不使用 buildToolSpec 的调用方复用与单测）。
 *
 * 纯函数、无副作用：只读人格素材文件，不写文件、不调外部命令、不碰网络。
 *
 * @param {unknown} args
 *   `{ expert, task, verify, scopes?, task_id?, worker?, surface?, kind? }`
 * @param {{ root?: string }} [options] 人格素材根目录覆盖（插件 config 透传）
 * @returns {{ content: { type: string, text: string }[] }}
 * @throws {ToolSpecError} 入参非法 / 专家不存在
 * @throws {PersonaError} 人格素材环境问题（原样透传）
 */
export function executeExpertBrief(args, options) {
  const input = normalizeArgs(args)

  // 1) 先把三个必填参数的**形状**校验完，再碰文件系统。
  //    顺序固定：expert → task → verify，调用方拿到的错误稳定可预期；
  //    也避免「漏传 task」这种最常见的错误要先扫一遍素材目录才报出来。
  const expert = requireText(
    'expert',
    input.expert,
    '传专家人格标识，三种写法都支持："engineering-code-reviewer" / "code-reviewer" / "engineering/code-reviewer"。',
  )
  const task = requireText('task', input.task, '写清任务内容与边界输入，例如 task: "实现 lib/tool.mjs"。')
  const verify = requireText(
    'verify',
    input.verify,
    '写一条可复跑的验收命令，例如 verify: "node --test dsh-expert-team-kit/test/"。',
  )

  // 2) 可选参数只校验「给了就必须合法」，缺省交给 buildBrief 归一化。
  const scopes = optionalScopes(input.scopes)
  const taskId = optionalText('task_id', input.task_id, 'task_id: "task-8"。')
  const workerName = optionalText('worker', input.worker, `worker: "${DEFAULT_WORKER}"。`)
  // surface 缺省 none（本机不一定装任务板）；kind 缺省 implementation。
  const surface = optionalEnum('surface', input.surface, SURFACES, DEFAULT_SURFACE)
  const kind = optionalEnum('kind', input.kind, KINDS, DEFAULT_KIND)

  // 3) 解析人格（唯一一次文件系统读取），再拼任务书。
  const root = isNonEmptyString(options?.root) ? options.root.trim() : undefined
  const persona = resolveExpert(expert, root)

  // 围栏自适应（S3）由 brief.mjs 负责：它取「verify 里最长反引号串 + 1」当围栏。
  // 本层不重复实现，只用测试锁住「产出的任务书围栏不会被验收命令截断」这个契约。
  const text = buildBrief({ persona, task, verify, scopes, taskId, workerName, surface, kind })

  return { content: [{ type: 'text', text }] }
}

/**
 * 构造工具规格。
 *
 * 返回的是**普通对象**，不是宿主 SDK 的类型实例：
 * 这样单测与 CLI 都不需要拉起宿主，插件入口也能按需把它交给
 * `ctx.tools.register(...)`。每次调用返回新对象（不共享可变状态），
 * 但 `name` 是常量，所以多次调用在宿主看来是同一个工具（幂等）。
 *
 * @param {{ root?: string }} [config] 可选：人格素材根目录覆盖
 * @returns {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, Record<string, unknown>>,
 *   execute: (args: unknown) => { content: { type: string, text: string }[] },
 * }}
 */
export function buildToolSpec(config = {}) {
  const root = isNonEmptyString(config?.root) ? config.root.trim() : undefined

  return {
    name: TOOL_NAME,
    description: [
      '给指定专家生成一份可直接派给 teammate 的自包含任务书。',
      '内容依次为：队友名与任务板 id、任务字段（机器可读 JSON）、专家人格（名称/来源/正文整段）、',
      '人格裁剪规则、任务内容、验收命令、写作用域、5 步工作流程、回报格式。',
      'surface 参数决定第 5 节的收尾协议，默认 none（不生成任何任务板调用）。',
      '纯函数：只读取本机专家人格素材，不写文件、不调外部命令。',
    ].join(''),
    parameters: {
      expert: {
        type: 'string',
        required: true,
        description:
          '专家 slug，支持全名/简名/division 三种写法（engineering-code-reviewer / code-reviewer / engineering/code-reviewer）。未知标识会报错并给出候选。',
      },
      task: {
        type: 'string',
        required: true,
        description: '任务内容与边界输入：要做什么、哪些文件可改、已确认的事实与已知约束。',
      },
      verify: {
        type: 'string',
        required: true,
        description:
          '验收命令：队友必须自己跑通的那一条（退出码 0、全 pass），例如 node --test dsh-expert-team-kit/test/。多行脚本可直接写；若含行首三反引号，产出时会自动加长代码块围栏（命令内容不变）。',
      },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description:
          '允许修改的文件前缀（可多条）；不传表示未限定作用域。队友只准碰这些路径。任一项为空会报 scopes[i]（与 buildBrief 同口径）。',
      },
      task_id: {
        type: 'string',
        description: '任务板 id（如 "task-8"）；任务书里的 5 步流程与回报第 4 行会引用它。',
      },
      worker: {
        type: 'string',
        description: `队友名，默认 "${DEFAULT_WORKER}"；任务书开头「你是 Agent Teams 里的 <名字>」。`,
      },
      surface: {
        type: 'string',
        enum: [...SURFACES],
        description:
          '任务书对接的任务板表面，决定第 5 节生成哪套协议：agent-teams（agent_teams_claim_task / agent_teams_complete_task，需 attempt_id）| official（team_task_get / team_task_update 的 claim+complete）| none（不生成任何协议调用，只按回报格式收尾）。默认 none —— 本机不一定装了任务板，缺省就不该让队友去调不存在的工具。给别的值会报错而不是静默退回 none。',
      },
      kind: {
        type: 'string',
        enum: [...KINDS],
        description: `任务字段里的交付类型，默认 "${DEFAULT_KIND}"；可选 ${KINDS.join(' / ')}，会原样写进任务书顶部的任务字段 JSON。`,
      },
    },
    execute: (args) => executeExpertBrief(args, { root }),
  }
}
