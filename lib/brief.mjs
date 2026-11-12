/**
 * dsh-expert-team-kit / lib/brief.mjs
 *
 * 任务书生成器（第 2 层核心库）。
 *
 * 一份合格的任务书要能自己把人带完整个回合，所以它必须依次给出：
 *   worker 名 + task id → 人格名 → 人格正文整段 → 人格裁剪 → 任务 → 验收命令
 *   → 写作用域 → 5 步流程 → 回报格式
 *
 * 契约要点：
 * - `persona` 可直接传 resolvePersona 的返回值（避免重扫文件系统）；
 * - 只给 `slug` 时内部调用 resolvePersona；
 * - `task` / `verify` 缺失或空一律抛 Error，message 里点名缺哪个字段。
 */

import { resolvePersona } from './persona.mjs'

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
        `buildBrief 缺少必填字段 "${field}"（${label}），实际收到：${describeValue(value)}`,
        `Fix: 传入 ${field}：buildBrief({ slug: "code-reviewer", ${field}: "..." })`,
        `     "${field}" 为空会让任务书无法被验收，所以这里直接失败而不是生成半份任务书。`,
      ].join('\n'),
    )
  }
  return value.trim()
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
          `buildBrief 的 persona 必须是 resolvePersona 的返回值（对象），实际收到：${describeValue(persona)}`,
          'Fix: const persona = resolvePersona("code-reviewer"); buildBrief({ persona, ... })。',
        ].join('\n'),
      )
    }
    if (!isNonEmptyString(persona.body)) {
      throw briefError(
        'BRIEF_INVALID_PERSONA',
        [
          'buildBrief 的 persona.body 必须是非空字符串：任务书要把人格正文整段贴进去，空正文等于没人格。',
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
      'buildBrief 需要指定专家人格：persona 与 slug 都没有提供。',
      'Fix: 二选一 ——',
      '  buildBrief({ slug: "code-reviewer", task: "...", verify: "..." })',
      '  buildBrief({ persona: resolvePersona("code-reviewer"), task: "...", verify: "..." })',
    ].join('\n'),
  )
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
 * }} input
 * @returns {string}
 * @throws {Error} task / verify 缺失或空；persona 非法；scopes / reportLines 非法
 */
export function buildBrief(input) {
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {}

  // 先校验必填，让「缺 task」这类最常见的错误第一时间报出来（而不是先读一遍文件系统）
  const task = requireText(options.task, 'task', '任务正文')
  const verify = requireText(options.verify, 'verify', '验收命令')
  const persona = resolveBriefPersona(options)

  const scopes = normalizeScopes(options.scopes)
  const taskId = toSingleLine(
    isNonEmptyString(options.taskId) ? options.taskId : '（未指定 task id）',
  )
  const workerName = toSingleLine(isNonEmptyString(options.workerName) ? options.workerName : 'worker')
  // taskId 有两个用途：散文里原样显示（taskId），塞进 JS 调用片段（taskIdArg）。后者必须先转义。
  const taskIdArg = escapeForDoubleQuoted(taskId)
  const reportLines = normalizeReportLines(options.reportLines, taskId)

  // 验收命令常是多行脚本（heredoc、node -e '...'）。内容里一旦出现三个反引号，
  // 固定的 ```bash 围栏就会被提前闭合、第 3 节结构静默错乱（看起来正常但内容跑到围栏外）。
  // 取「内容里最长反引号串 + 1」当围栏（至少 3），任何内容都关不掉它。
  const longestBacktickRun = (verify.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  )
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  const personaSource = persona.path ?? persona.slug ?? '（调用方直接传入的 persona）'

  /** @type {string[]} */
  const lines = []

  // —— 1. worker 名 + task id ——
  lines.push(`你是 Agent Teams 里的 ${workerName}。任务板上你的任务是 \`${taskId}\`。`)
  lines.push('')

  // —— 2. 人格名 ——
  lines.push('## 0. 你的专家人格')
  lines.push('')
  lines.push(`人格名：${persona.name}`)
  if (persona.description) lines.push(`人格描述：${persona.description}`)
  lines.push(`人格来源：${personaSource}`)
  lines.push('')
  lines.push('下面整段人格正文就是你的专业身份。方法论照做；与本任务无关的技术栈偏好按下一节裁剪。')
  lines.push('')

  // —— 3. 人格正文整段 ——
  lines.push(persona.body)
  lines.push('')

  // —— 4. 人格裁剪 ——
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

  // —— 5. 任务 ——
  lines.push('## 2. 任务')
  lines.push('')
  lines.push(task)
  lines.push('')

  // —— 6. 验收命令 ——
  lines.push('## 3. 验收命令（必须自己跑一遍）')
  lines.push('')
  lines.push(`${fence}bash`)
  lines.push(verify)
  lines.push(fence)
  lines.push('')
  lines.push('期望：退出码 0、全 pass / 0 fail。不通过就改实现，')
  lines.push('**不许跳过失败用例、不许放宽断言来让验收变绿**。')
  lines.push('')

  // —— 7. 写作用域 ——
  lines.push('## 4. 写作用域（只碰这些路径）')
  lines.push('')
  if (scopes.length === 0) {
    lines.push('- 无')
    lines.push('')
    lines.push('（任务未限定写作用域，但仍不许改本任务范围外的文件，尤其是别的队友负责的文件。）')
  } else {
    for (const scope of scopes) lines.push(`- ${scope}`)
    lines.push('')
    lines.push('只创建/修改上面列出的路径；**绝对不要**碰队友负责的文件与任何已有插件目录。')
  }
  lines.push('')

  // —— 8. 5 步流程 ——
  lines.push('## 5. 工作流程（5 步，顺序不要乱）')
  lines.push('')
  lines.push(`1. 读任务全文记 revision：\`team_task_get({task_id:"${taskIdArg}"})\`，把返回的 revision 记下来。`)
  lines.push(`2. 占位认领：\`team_task_update({task_id:"${taskIdArg}", expected_revision:<revision>, action:"claim"})\`。`)
  lines.push('3. 按上面的任务与写作用域干活，实现过程中随时回看第 3 节的验收命令。')
  lines.push(`4. 自己跑一遍验收命令（第 3 节），必须全 pass / 0 fail。`)
  lines.push(`5. 通过后收尾：\`team_task_update({task_id:"${taskIdArg}", expected_revision:<claim 后的最新 revision>, action:"complete"})\`。`)
  lines.push('')

  // —— 9. 回报格式 ——
  lines.push(`## 6. 回报格式（严格 ${reportLines.length} 行，不要其它内容）`)
  lines.push('')
  reportLines.forEach((label, index) => lines.push(`${index + 1}) ${label}`))
  lines.push('')

  return lines.join('\n')
}
