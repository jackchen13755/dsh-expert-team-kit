/**
 * dsh-expert-team-kit / lib/brief.mjs
 *
 * 任务书生成器（第 2 层核心库）。
 *
 * 一份合格的任务书要能自己把人带完整个回合，所以它必须依次给出：
 *   worker 名 + task id → 任务字段（机器可读 JSON）→ 人格 → 人格裁剪 → 任务
 *   → 验收命令 → 写作用域 → 5 步流程 → 回报格式
 *
 * 三个导出（A）：
 * - `buildPersonaSection(input)`：只出「人格 + 裁剪」两节；
 * - `buildTaskFieldSpec(input)`：出**结构化对象**（surface / kind / objective /
 *   acceptance / verify / inScope / outOfScope / notes），供调用方原样写进任务板字段；
 * - `buildBrief(input)`：组合入口（签名向后兼容），把两者拼成一份完整任务书。
 *
 * 契约要点：
 * - `persona` 可直接传 resolvePersona 的返回值（避免重扫文件系统）；
 * - 只给 `slug` 时内部调用 resolvePersona；
 * - `task` / `verify` 缺失或空一律抛 Error，message 里点名缺哪个字段；
 * - `surface` 决定第 5 节生成哪套任务板协议，缺省 `none`（见 SURFACES）；
 * - 枚举类字段（surface / kind）非法值抛 `BRIEF_INVALID_*`，不静默退回缺省
 *   ——「我写了 agent-teams 但拼错」如果被静默吞掉，任务书会看起来正常却不带认领流程。
 */

import { resolvePersona } from './persona.mjs'

/**
 * 任务书对接的「任务板表面」（D）。
 * - `agent-teams`：@nanmicoder/dsh-agent-teams 的 agent_teams_claim_task / complete_task；
 * - `official`：官方 Agent Teams 的 team_task_get / team_task_update；
 * - `none`（缺省）：本机没有任务板工具，任务书不生成任何协议调用。
 * @type {ReadonlyArray<string>}
 */
export const SURFACES = Object.freeze(['agent-teams', 'official', 'none'])

/**
 * 交付类型（与任务板真实字段 kind 对齐：implementation / review / work）。
 * @type {ReadonlyArray<string>}
 */
export const KINDS = Object.freeze(['implementation', 'review', 'work'])

/** 缺省 surface：本机不一定装了任务板，缺省就不能生成指向不存在工具的调用。 */
export const DEFAULT_SURFACE = 'none'

/** 缺省 kind。 */
export const DEFAULT_KIND = 'implementation'

/**
 * 缺省回报格式的行标签（4 行）。第 4 行会拼上 task id。
 * @param {string} taskId
 * @returns {string[]}
 */
function defaultReportLines(taskId) {
  return [
    '你 read 到的人格名（人格文件的 name 字段）',
    '创建/修改的文件路径（逗号分隔）',
    '验收命令的退出码 + pass/fail 计数',
    `${taskId} 最终 status 与 revision`,
  ]
}

/**
 * 构造带 `code` 的 Error（与 PersonaError 一致的脚本可判定性，但仍满足 `throw Error`）。
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function briefError(code, message) {
  const error = new Error(message)
  error.code = code
  error.name = 'BriefError'
  return error
}

/**
 * 把任意 input 归一成普通对象（非对象视同「什么都没传」，交给必填校验报错）。
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function asOptions(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? /** @type {Record<string, unknown>} */ (input)
    : {}
}

/**
 * 压成一行：换行与连续空白折成单个空格。workerName / taskId 会直接进散文句子，
 * 多行值会打断「你是 …」那一行，把任务书开头结构搞乱。
 * @param {unknown} value
 * @returns {string}
 */
function toSingleLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

/**
 * 转义成可安全放进双引号 JS 字符串的内容（用于生成 `team_task_update({task_id:"…"})` 片段）。
 * 不转义时，id 里一个 `"` 就能把生成片段的引号提前闭合，任务书里给 worker 的调用指令直接坏掉。
 * @param {string} value
 * @returns {string}
 */
function escapeForDoubleQuoted(value) {
  // 这里刻意用 fromCharCode 取反斜杠码点，而不是写转义字面量：
  // 这一段要求逐字符正确，而「几个反斜杠」在二次编辑里极易漂移，码点表达没有歧义。
  const backslash = String.fromCharCode(92)
  return String(value)
    .replaceAll(backslash, backslash + backslash)
    .replaceAll('"', backslash + '"')
    .replaceAll(String.fromCharCode(13), '')
    .replaceAll(String.fromCharCode(10), backslash + 'n')
}

/**
 * 取一段内容的自适应围栏：比内容里最长的反引号串更长（至少 3）。
 * 内容里一旦出现三个反引号，固定的 ``` 围栏就会被提前闭合、后面的结构静默错乱
 * （看起来正常但内容跑到围栏外）。
 * @param {string} content
 * @returns {string}
 */
function fenceOf(content) {
  const longestBacktickRun = (String(content).match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  )
  return '`'.repeat(Math.max(3, longestBacktickRun + 1))
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === undefined) return 'undefined（未提供）'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value === '' ? '空字符串 ""' : `字符串 ${JSON.stringify(value)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${String(value)}（${typeof value}）`
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`
  return Object.prototype.toString.call(value)
}

/**
 * 必填文本字段校验。
 * @param {unknown} value
 * @param {string} field
 * @param {string} label
 * @returns {string}
 */
function requireText(value, field, label) {
  if (!isNonEmptyString(value)) {
    throw briefError(
      'BRIEF_MISSING_FIELD',
      [
        `任务书生成（buildBrief / buildTaskFieldSpec）缺少必填字段 "${field}"（${label}），实际收到：${describeValue(value)}`,
        `Fix: 传入 ${field}：buildBrief({ slug: "code-reviewer", ${field}: "..." })`,
        `     "${field}" 为空会让任务书无法被验收，所以这里直接失败而不是生成半份任务书。`,
      ].join('\n'),
    )
  }
  return value.trim()
}

/**
 * 枚举字段归一化（surface / kind）。
 *
 * 口径与 scopes 一致（N5）：
 * - `undefined` / `null` / 空串 / 纯空白 → 缺省值（「没填」不是「填错」）；
 * - 非字符串（数字 / 布尔 / 数组 / 对象）→ `code`；
 * - 不在白名单里（含大小写不符，如 `NONE`）→ `code`，并列出允许值。
 *
 * 为什么不静默退回缺省：`surface: "agent-team"`（少个 s）被吞成 none 时，
 * 产出会是一份「看起来正常但没有认领流程」的任务书 —— 这正是本模块要消灭的静默降级。
 *
 * @param {unknown} value
 * @param {string} field
 * @param {ReadonlyArray<string>} allowed
 * @param {string} fallback
 * @param {string} code
 * @returns {string}
 */
function normalizeEnum(value, field, allowed, fallback, code) {
  if (value === undefined || value === null) return fallback

  const allowedText = allowed.join(' | ')

  if (typeof value !== 'string') {
    throw briefError(
      code,
      [
        `任务书的 ${field} 必须是字符串，实际收到：${describeValue(value)}`,
        `Fix: ${field}: "${fallback}"，允许值只有 ${allowedText}（不传则用缺省值 ${fallback}）。`,
      ].join('\n'),
    )
  }

  const trimmed = value.trim()
  if (trimmed === '') return fallback

  if (!allowed.includes(trimmed)) {
    throw briefError(
      code,
      [
        `任务书的 ${field} 只接受 ${allowedText}，实际收到：${JSON.stringify(trimmed)}`,
        `Fix: 改成上面某一个值（缺省是 ${fallback}）；大小写与连字符都要一致，例如 "agent-teams" 不是 "agent_teams"。`,
        `     拼错会让任务书静默退回缺省、丢掉本该生成的协议调用，所以这里直接失败。`,
      ].join('\n'),
    )
  }

  return trimmed
}

/**
 * 归一化写作用域。
 * - 未提供 / null → `[]`
 * - 单个字符串 → 包成单元素数组（懒人写法也接受）
 * - 数组 → 逐项校验非空字符串
 *
 * @param {unknown} scopes
 * @returns {string[]}
 */
function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null) return []

  // 空串 / 纯空白视同「未提供」：不把 '' 包成 [''] 再报 scopes[0] 错。
  // 同一份输入在 tool 层是「参数没给」、在 brief 层是「数组项非法」，两套口径调用方没法统一处理（N5）。
  if (typeof scopes === 'string') {
    const single = scopes.trim()
    if (single === '') return []
    return [single]
  }

  const list = scopes
  if (!Array.isArray(list)) {
    throw briefError(
      'BRIEF_INVALID_SCOPES',
      [
        `buildBrief 的 scopes 必须是字符串或字符串数组，实际收到：${describeValue(scopes)}`,
        'Fix: scopes: ["lib/brief.mjs", "test/brief.test.mjs"]；不限定作用域就传空数组 []。',
      ].join('\n'),
    )
  }

  return list.map((item, index) => {
    if (!isNonEmptyString(item)) {
      throw briefError(
        'BRIEF_INVALID_SCOPES',
        [
          `buildBrief 的 scopes[${index}] 必须是非空字符串，实际收到：${describeValue(item)}`,
          'Fix: 每一项写一个相对路径，例如 "lib/brief.mjs"。',
        ].join('\n'),
      )
    }
    return item.trim()
  })
}

/**
 * 归一化回报格式。
 * - 未提供 / null / 空数组 → 缺省 4 行
 * - number N → 取缺省行的前 N 行（N > 4 时补「补充说明」行）
 * - string[] → 原样作为行标签
 *
 * @param {unknown} reportLines
 * @param {string} taskId
 * @returns {string[]}
 */
function normalizeReportLines(reportLines, taskId) {
  const defaults = defaultReportLines(taskId)

  if (reportLines === undefined || reportLines === null) return defaults

  if (typeof reportLines === 'number') {
    if (!Number.isInteger(reportLines) || reportLines < 1) {
      throw briefError(
        'BRIEF_INVALID_REPORT_LINES',
        [
          `buildBrief 的 reportLines 作为行数时必须是 >= 1 的整数，实际收到：${describeValue(reportLines)}`,
          'Fix: reportLines: 4（缺省），或直接传自定义标签数组。',
        ].join('\n'),
      )
    }
    if (reportLines <= defaults.length) return defaults.slice(0, reportLines)
    const extra = Array.from(
      { length: reportLines - defaults.length },
      (_, index) => `补充说明 ${index + 1}：主会话需要知道、但没归入上面几项的内容`,
    )
    return [...defaults, ...extra]
  }

  if (Array.isArray(reportLines)) {
    if (reportLines.length === 0) return defaults
    return reportLines.map((item, index) => {
      if (!isNonEmptyString(item)) {
        throw briefError(
          'BRIEF_INVALID_REPORT_LINES',
          [
            `buildBrief 的 reportLines[${index}] 必须是非空字符串，实际收到：${describeValue(item)}`,
            'Fix: reportLines: ["人格名", "改动文件"]。',
          ].join('\n'),
        )
      }
      return item.trim()
    })
  }

  throw briefError(
    'BRIEF_INVALID_REPORT_LINES',
    [
      `buildBrief 的 reportLines 必须是数字或字符串数组，实际收到：${describeValue(reportLines)}`,
      'Fix: reportLines: 4（缺省）或 reportLines: ["人格名", "改动文件"]。',
    ].join('\n'),
  )
}

/**
 * 取人格：优先用调用方已解析好的 persona，其次按 slug 现场解析。
 * @param {{ persona?: unknown, slug?: unknown, root?: unknown }} input
 * @returns {{ name: string, description: string, body: string, slug?: string, path?: string }}
 */
function resolveBriefPersona(input) {
  const { persona } = input

  if (persona !== undefined && persona !== null) {
    if (typeof persona !== 'object' || Array.isArray(persona)) {
      throw briefError(
        'BRIEF_INVALID_PERSONA',
        [
          `任务书需要的 persona 必须是 resolvePersona 的返回值（对象），实际收到：${describeValue(persona)}`,
          'Fix: const persona = resolvePersona("code-reviewer"); buildBrief({ persona, ... })。',
        ].join('\n'),
      )
    }
    if (!isNonEmptyString(persona.body)) {
      throw briefError(
        'BRIEF_INVALID_PERSONA',
        [
          '任务书的 persona.body 必须是非空字符串：任务书要把人格正文整段贴进去，空正文等于没人格。',
          'Fix: 直接传 resolvePersona(slug) 的返回值，不要自己拼一个 { name } 对象。',
        ].join('\n'),
      )
    }
    return {
      name: isNonEmptyString(persona.name) ? persona.name.trim() : '（未命名人格）',
      description: isNonEmptyString(persona.description) ? persona.description.trim() : '',
      body: persona.body.trim(),
      slug: typeof persona.slug === 'string' ? persona.slug : undefined,
      path: typeof persona.path === 'string' ? persona.path : undefined,
    }
  }

  if (isNonEmptyString(input.slug)) {
    const options = isNonEmptyString(input.root) ? { root: input.root.trim() } : undefined
    const resolved = resolvePersona(input.slug.trim(), options)
    return {
      name: resolved.name,
      description: resolved.description,
      body: resolved.body,
      slug: resolved.slug,
      path: resolved.path,
    }
  }

  throw briefError(
    'BRIEF_NO_PERSONA',
    [
      '任务书需要指定专家人格：persona 与 slug 都没有提供。',
      'Fix: 二选一 ——',
      '  buildBrief({ slug: "code-reviewer", task: "...", verify: "..." })',
      '  buildBrief({ persona: resolvePersona("code-reviewer"), task: "...", verify: "..." })',
    ].join('\n'),
  )
}

/**
 * 任务字段里 notes 的措辞（随 surface 变化，是给人看的一句话说明）。
 * 注意：surface=none 时这里**不得出现任何任务板工具名** ——
 * 「本机没有这个工具」的任务书再提一句 team_task_get，worker 就会去调它然后拿不到。
 *
 * @param {string} surface
 * @param {string} taskId
 * @returns {string}
 */
function buildFieldNotes(surface, taskId) {
  if (surface === 'official') {
    return `surface=official：按第 5 节用 team_task_get 读 revision、team_task_update 做 claim / complete；task_id 固定为 ${taskId}。`
  }
  if (surface === 'agent-teams') {
    return [
      `surface=agent-teams：按第 5 节用 agent_teams_claim_task 认领并记下返回的 attempt_id；`,
      `agent_teams_complete_task 必须原样带回同一个 attempt_id（丢了就收不了尾）；task_id 固定为 ${taskId}。`,
    ].join('')
  }
  return 'surface=none：本机没有任务板工具，不需要认领/完成；做完按第 6 节回报格式回报。'
}

/**
 * 返回**结构化任务字段**（不是 markdown）—— 调用方拿到后原样写进任务板字段。
 *
 * 固定 8 个键，顺序也固定（surface → kind → objective → acceptance → verify
 * → inScope → outOfScope → notes），便于调用方与测试逐键比对；多余键一律不加。
 *
 * @param {{
 *   task?: string,
 *   verify?: string,
 *   scopes?: string[] | string,
 *   taskId?: string,
 *   surface?: string,
 *   kind?: string,
 *   persona?: unknown,
 *   slug?: string,
 *   root?: string,
 * }} input
 * @returns {{
 *   surface: string,
 *   kind: string,
 *   objective: string,
 *   acceptance: string[],
 *   verify: string[],
 *   inScope: string[],
 *   outOfScope: string[],
 *   notes: string,
 * }}
 * @throws {Error} task / verify 缺失；surface / kind 非法；scopes 非法
 */
export function buildTaskFieldSpec(input) {
  const options = asOptions(input)

  // 校验顺序固定：task → verify → surface → kind → scopes。
  // 全部是纯形状校验，不碰文件系统，所以「漏传 task」永远第一个报出来。
  const objective = requireText(options.task, 'task', '任务正文')
  const verify = requireText(options.verify, 'verify', '验收命令')
  const surface = normalizeEnum(
    options.surface,
    'surface',
    SURFACES,
    DEFAULT_SURFACE,
    'BRIEF_INVALID_SURFACE',
  )
  const kind = normalizeEnum(options.kind, 'kind', KINDS, DEFAULT_KIND, 'BRIEF_INVALID_KIND')
  const scopes = normalizeScopes(options.scopes)
  const taskId = toSingleLine(
    isNonEmptyString(options.taskId) ? options.taskId : '（未指定 task id）',
  )

  // acceptance 是「判据」，verify 是「载体」：前者人能读，后者命令可跑。
  const acceptance = [
    '验收命令（verify）退出码 0、全 pass / 0 fail',
    scopes.length > 0
      ? '改动只落在 inScope 列出的路径内，outOfScope 一个都没碰'
      : '不修改本任务范围之外的任何文件',
  ]

  const outOfScope =
    scopes.length > 0
      ? ['除 inScope 之外的任何路径（尤其别的队友负责的文件与已有插件目录）']
      : ['本任务范围之外的任何文件（任务未限定 inScope，但边界仍按「不许越界」执行）']

  return {
    surface,
    kind,
    objective,
    acceptance,
    // 一条命令 = 一个元素。多行 heredoc 属于同一条命令，不拆 —— 拆开会变成「跑半条」。
    verify: [verify],
    inScope: [...scopes],
    outOfScope,
    notes: buildFieldNotes(surface, taskId),
  }
}

/**
 * 只生成「人格 + 裁剪」两节（A）。
 *
 * 给「已经有一份任务书、只想补人格」的调用方用；与 buildBrief 前两节的字节一致，
 * 所以两处拼装不会出现措辞漂移。
 *
 * @param {{ slug?: string, persona?: unknown, root?: string }} [input]
 * @returns {string}
 * @throws {Error} persona / slug 都缺失，或 persona 形状非法
 */
export function buildPersonaSection(input) {
  const options = asOptions(input)
  const persona = resolveBriefPersona(options)
  const personaSource = persona.path ?? persona.slug ?? '（调用方直接传入的 persona）'

  /** @type {string[]} */
  const lines = []

  lines.push('## 0. 你的专家人格')
  lines.push('')
  lines.push(`人格名：${persona.name}`)
  if (persona.description) lines.push(`人格描述：${persona.description}`)
  lines.push(`人格来源：${personaSource}`)
  lines.push('')
  lines.push('下面整段人格正文就是你的专业身份。方法论照做；与本任务无关的技术栈偏好按下一节裁剪。')
  lines.push('')

  // 人格正文整段：只贴标题等于没注入人格
  lines.push(persona.body)
  lines.push('')

  lines.push('## 1. 人格裁剪')
  lines.push('')
  lines.push('人格是专家素材，不是本任务的技术栈说明书。按下面这条界裁剪后再动手：')
  lines.push('')
  lines.push('- **保留（方法论，必须照做）**：DX 优先、错误信息可操作（说清原因 + 下一步）、')
  lines.push('  边界输入全覆盖（非字符串/空值/不存在的输入都要有明确行为）、接口即契约、')
  lines.push('  验收必须可复跑、失败就改实现而不是改断言。')
  lines.push('- **忽略（与本任务无关的技术栈偏好）**：人格里出现的具体语言、框架、打包/发行渠道、')
  lines.push('  版本管理习惯等偏好，与本任务无关时一律忽略。本任务的技术栈以下面的任务与验收命令为准。')
  lines.push('')
  lines.push('')

  return lines.join('\n')
}

/**
 * 第 5 节：按 surface 生成工作流程（C）。
 *
 * 三种 surface 的共同骨架都是 5 步：认领（若有）→ 干活 → 自跑验收 → 自检 → 收尾/回报。
 * `none` 分支只写「按第 6 节回报」，**不出现任何任务板工具名** —— 这是本任务的核心修复：
 * 旧版无论环境如何都让人去调 team_task_get，而本机工具面里没有这个工具。
 *
 * @param {{ surface: string, taskIdArg: string, workerNameArg: string }} params
 * @returns {string[]}
 */
function renderWorkflow({ surface, taskIdArg, workerNameArg }) {
  if (surface === 'official') {
    return [
      `1. 读任务全文记 revision：\`team_task_get({task_id:"${taskIdArg}"})\`，把返回的 revision 记下来。`,
      `2. 占位认领：\`team_task_update({task_id:"${taskIdArg}", expected_revision:<revision>, action:"claim"})\`。`,
      '3. 按第 2 节的任务与第 4 节的写作用域干活，过程中随时回看第 3 节的验收命令。',
      '4. 自己跑一遍验收命令（第 3 节），必须全 pass / 0 fail。',
      `5. 通过后收尾：\`team_task_update({task_id:"${taskIdArg}", expected_revision:<claim 后的最新 revision>, action:"complete"})\`。`,
    ]
  }

  if (surface === 'agent-teams') {
    return [
      `1. 认领任务：\`agent_teams_claim_task({task_id:"${taskIdArg}", assignee:"${workerNameArg}"})\`，把返回的 **attempt_id** 记下来。`,
      '2. 按第 2 节的任务与第 4 节的写作用域干活，过程中随时回看第 3 节的验收命令。',
      '3. 自己跑一遍验收命令（第 3 节），必须全 pass / 0 fail。',
      `4. 收尾完成：\`agent_teams_complete_task({task_id:"${taskIdArg}", attempt_id:"<第 1 步拿到的 attempt_id>"})\`。`,
      '5. **attempt_id 不是装饰**：漏传或写错都会让完成失败/归属错乱；成功后按第 6 节回报。',
    ]
  }

  return [
    '1. 读顶部任务字段与第 2 节任务全文，先确认 objective / inScope / outOfScope 的边界。',
    '2. 按第 2 节的任务与第 4 节的写作用域干活，过程中随时回看第 3 节的验收命令。',
    '3. 自己跑一遍验收命令（第 3 节），必须全 pass / 0 fail。',
    '4. 自检：改动是否全在 inScope 内，outOfScope 是否一个都没碰。',
    '5. 完成后按第 6 节回报（本机没有任务板工具：不要认领，也不要编造完成调用）。',
  ]
}

/**
 * 生成一份可直接发给 worker 的任务书。
 *
 * @param {{
 *   slug?: string,
 *   persona?: unknown,
 *   task?: string,
 *   verify?: string,
 *   scopes?: string[] | string,
 *   taskId?: string,
 *   workerName?: string,
 *   reportLines?: number | string[],
 *   root?: string,
 *   surface?: string,
 *   kind?: string,
 * }} input
 * @returns {string}
 * @throws {Error} task / verify 缺失或空；persona 非法；surface / kind / scopes / reportLines 非法
 */
export function buildBrief(input) {
  const options = asOptions(input)

  // 任务字段先算：它同时承担「必填校验」与「顶部 JSON」两个职责，
  // 也保证顶部 JSON 与任务书正文出自同一份归一键（不会两处口径漂移）。
  const fieldSpec = buildTaskFieldSpec(options)
  const persona = resolveBriefPersona(options)

  const taskId = toSingleLine(
    isNonEmptyString(options.taskId) ? options.taskId : '（未指定 task id）',
  )
  const workerName = toSingleLine(isNonEmptyString(options.workerName) ? options.workerName : 'worker')
  // taskId / workerName 有两个用途：散文里原样显示，以及塞进 JS 调用片段。
  // 后者必须先转义，否则 id 里一个 `"` 就能把生成片段的引号提前闭合。
  const taskIdArg = escapeForDoubleQuoted(taskId)
  const workerNameArg = escapeForDoubleQuoted(workerName)
  const reportLines = normalizeReportLines(options.reportLines, taskId)

  const specJson = JSON.stringify(fieldSpec, null, 2)
  const jsonFence = fenceOf(specJson)
  const verifyFence = fenceOf(fieldSpec.verify.join('\n'))

  /** @type {string[]} */
  const lines = []

  // —— 1. worker 名 + task id ——
  lines.push(`你是 Agent Teams 里的 ${workerName}。任务板上你的任务是 \`${taskId}\`。`)
  lines.push('')

  // —— 2. 任务字段（B：顶部固定输出，原样写进任务板字段）——
  // 提示语独立成行、不加引用前缀：调用方会按这句原文 grep/断言的，加装饰就等于改了契约。
  lines.push('以下 JSON 必须原样写进任务字段，否则门禁不生效。')
  lines.push('')
  lines.push(`${jsonFence}json`)
  lines.push(specJson)
  lines.push(jsonFence)
  lines.push('')

  // —— 3. 人格 + 裁剪（与 buildPersonaSection 同一份渲染）——
  lines.push(buildPersonaSection({ persona }))

  // —— 4. 任务 ——
  lines.push('## 2. 任务')
  lines.push('')
  lines.push(fieldSpec.objective)
  lines.push('')

  // —— 5. 验收命令 ——
  lines.push('## 3. 验收命令（必须自己跑一遍）')
  lines.push('')
  lines.push(`${verifyFence}bash`)
  lines.push(fieldSpec.verify.join('\n'))
  lines.push(verifyFence)
  lines.push('')
  lines.push('期望：退出码 0、全 pass / 0 fail。不通过就改实现，')
  lines.push('**不许跳过失败用例、不许放宽断言来让验收变绿**。')
  lines.push('')

  // —— 6. 写作用域 ——
  lines.push('## 4. 写作用域（只碰这些路径）')
  lines.push('')
  if (fieldSpec.inScope.length === 0) {
    lines.push('- 无')
    lines.push('')
    lines.push('（任务未限定写作用域，但仍不许改本任务范围外的文件，尤其是别的队友负责的文件。）')
  } else {
    for (const scope of fieldSpec.inScope) lines.push(`- ${scope}`)
    lines.push('')
    lines.push('只创建/修改上面列出的路径；**绝对不要**碰队友负责的文件与任何已有插件目录。')
  }
  lines.push('')

  // —— 7. 5 步流程（按 surface 分支）——
  lines.push('## 5. 工作流程（5 步，顺序不要乱）')
  lines.push('')
  lines.push(
    `surface=${fieldSpec.surface}，kind=${fieldSpec.kind}（与顶部任务字段一致；改这里要先改那份 JSON）。`,
  )
  lines.push('')
  for (const step of renderWorkflow({ surface: fieldSpec.surface, taskIdArg, workerNameArg })) {
    lines.push(step)
  }
  lines.push('')

  // —— 8. 回报格式 ——
  lines.push(`## 6. 回报格式（严格 ${reportLines.length} 行，不要其它内容）`)
  lines.push('')
  reportLines.forEach((label, index) => lines.push(`${index + 1}) ${label}`))
  lines.push('')

  return lines.join('\n')
}
