/**
 * dsh-expert-team-kit / lib/handoff.mjs
 *
 * 「交接五段」（第 2 层核心库，零依赖）。
 *
 * 要解决的失效形态：换会话就丢前情。会话日志记得住「做过什么」（tool/call），
 * 记不住「为什么否决了方案 B」「还差哪一步」。于是新会话只能问人，或者从头再推一遍。
 * 这个模块把交接文档定成**固定五段**，缺段就是不合格、空段也算没写：
 *
 *   decided   已定    — 已经拍板的决定（连同理由）
 *   rejected  已否决  — 试过/考虑过但否掉的路，以及为什么否
 *   risks     风险    — 已知坑、未验证的假设、可能返工的地方
 *   files     涉及文件 — 这一轮动过的/下次要动的文件（带路径）
 *   remaining 待办    — 下一步具体动作与验收方式
 *
 * 为什么「缺段」要判失败而不是留空就算过：空着的那一段恰恰是换会话最容易丢的东西，
 * 放行一次，下一次就没人写了。
 *
 * 契约（脚本可判定，不靠文案匹配）：
 * - 段的「缺失」与「空段」是两件事：`sections[id] === null` 表示整个标题都不存在，
 *   `sections[id] === ''` 表示标题在、里面没有非空行。两者都不合格，但报错要能区分，
 *   因为修法不同（前者补标题，后者补内容）。
 * - 超过 `MAX_SECTION_LINES` 行只告警（`overlong`），不判失败：交接该长就长，
 *   但太长说明这一段该拆或该精简。
 */

import path from 'node:path'

/**
 * 单段行数上限：超过只告警，不判失败。
 * @type {number}
 */
export const MAX_SECTION_LINES = 20

/**
 * 五段定义（顺序即渲染顺序，也是 missing/counts 的遍历顺序）。
 * @type {readonly { id: string, title: string }[]}
 */
export const HANDOFF_SECTIONS = Object.freeze([
  Object.freeze({ id: 'decided', title: '已定' }),
  Object.freeze({ id: 'rejected', title: '已否决' }),
  Object.freeze({ id: 'risks', title: '风险' }),
  Object.freeze({ id: 'files', title: '涉及文件' }),
  Object.freeze({ id: 'remaining', title: '待办' }),
])

/**
 * 错误码集合。所有 HandoffError 都带 `code`，调用方可按码分支。
 * @type {Readonly<Record<string, string>>}
 */
export const HANDOFF_ERROR_CODES = Object.freeze({
  /** parseHandoff / verifyHandoff 的入参不是字符串 */
  INVALID_TEXT: 'HANDOFF_INVALID_TEXT',
  /** formatHandoff 的入参不是对象 */
  INVALID_INPUT: 'HANDOFF_INVALID_INPUT',
  /** 某一段的取值既不是字符串也不是字符串数组 */
  INVALID_SECTION: 'HANDOFF_INVALID_SECTION',
  /** root 不是非空字符串 */
  INVALID_ROOT: 'HANDOFF_INVALID_ROOT',
  /** sessionKey 不是可安全用作文件名的非空字符串 */
  INVALID_SESSION: 'HANDOFF_INVALID_SESSION',
})

/**
 * 交接文档问题异常：message 里带 `Fix:`（原因 + 下一步），不让调用方拿到 undefined 再崩。
 */
export class HandoffError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'HandoffError'
    this.code = code
  }
}

/** 二级/三级标题（`## 已定` / `### 已定`），标题文字去掉行尾冒号。 */
const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/

/** 单行 HTML 注释：模板里的占位提示，不算内容。 */
const COMMENT_LINE_RE = /^<!--.*-->$/

/**
 * 去掉标题尾部的中英文冒号与空白，便于 `## 已定：` 与 `## 已定` 等价。
 * @param {string} raw
 * @returns {string}
 */
function normalizeTitle(raw) {
  return raw.replace(/[:：]\s*$/, '').trim()
}

/**
 * 标题文字 → 段 id；不是五段之一返回 null。
 * 既认中文标题（`已定`），也认 id（`decided`，大小写不敏感），
 * 这样机器生成与手写文档都能被同一套规则解析。
 * @param {string} raw
 * @returns {string | null}
 */
function matchSectionId(raw) {
  const title = normalizeTitle(raw)
  for (const section of HANDOFF_SECTIONS) {
    if (title === section.title || title.toLowerCase() === section.id) return section.id
  }
  return null
}

/**
 * 这一行算不算「内容行」：非空，且不是模板占位注释。
 * @param {string} line
 * @returns {boolean}
 */
function isContentLine(line) {
  const trimmed = line.trim()
  return trimmed !== '' && !COMMENT_LINE_RE.test(trimmed)
}

/**
 * 一段正文 → 内容行数组（去空行、去注释、去首尾空白，保留行内缩进）。
 * @param {string} text
 * @returns {string[]}
 */
function contentLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isContentLine)
}

/**
 * 断言入参是字符串，并把「给了什么」原样写进错误信息。
 * @param {unknown} value
 * @param {string} where
 * @returns {asserts value is string}
 */
function assertText(value, where) {
  if (typeof value === 'string') return
  throw new HandoffError(
    HANDOFF_ERROR_CODES.INVALID_TEXT,
    [
      `${where} 需要一段交接文档文本（字符串），实际收到：${describe(value)}`,
      'Fix: 先读文件再传入，例如 `const text = fs.readFileSync(p, "utf8")`；',
      '     没有文档就先跑 `node dsh-expert-team-kit/bin/handoff.mjs init --session <id>`。',
    ].join('\n'),
  )
}

/**
 * 把任意值描述成一行可读文本（错误信息用）。
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') {
    return value === '' ? '空字符串' : `字符串 ${JSON.stringify(value)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${String(value)}`
  }
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`
  return typeof value === 'object' ? '对象' : typeof value
}

/**
 * 解析交接文档。
 *
 * 返回的 `sections` 一定包含五段的键，值有三种：
 * - `string`（可能是 `''`）：标题存在，值是该段正文（未做行级过滤，保留原始换行）；
 * - `null`：整段标题都不存在。
 * 正文里的 `<!-- ... -->` 单行注释不算内容（模板占位就是这种写法），但会原样保留在字符串里。
 *
 * 不是五段之一的标题收进 `extra`，按出现顺序返回 `{ title, level, text }`，不静默丢弃。
 * 同一段标题重复出现时，正文按出现顺序拼接（不丢内容）。
 *
 * @param {string} text
 * @returns {{
 *   sections: { decided: string | null, rejected: string | null, risks: string | null, files: string | null, remaining: string | null },
 *   extra: { title: string, level: number, text: string }[],
 * }}
 * @throws {HandoffError} 入参不是字符串（code `HANDOFF_INVALID_TEXT`）
 */
export function parseHandoff(text) {
  assertText(text, 'parseHandoff')

  /** @type {Record<string, string[] | null>} */
  const collected = Object.fromEntries(HANDOFF_SECTIONS.map((section) => [section.id, null]))
  /** @type {{ title: string, level: number, text: string[] }[]} */
  const extraEntries = []
  /** @type {{ key: string, level: number, bucket: string[] | { title: string, level: number, text: string[] } } | null} */
  let current = null

  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line)
    if (heading === null) {
      if (current === null) continue // 第一个标题之前的散文不属于任何一段
      if (current.key === 'extra') {
        /** @type {{ title: string, level: number, text: string[] }} */ (current.bucket).text.push(line)
      } else {
        /** @type {string[]} */ (current.bucket).push(line)
      }
      continue
    }

    const level = heading[1].length
    const title = normalizeTitle(heading[2])
    const sectionId = matchSectionId(title)

    if (sectionId !== null) {
      // 重复的同一段标题：拼接正文，不覆盖前面写过的内容
      if (collected[sectionId] === null) collected[sectionId] = []
      current = { key: sectionId, level, bucket: /** @type {string[]} */ (collected[sectionId]) }
      continue
    }

    const entry = { title: heading[2].trim(), level, text: [] }
    extraEntries.push(entry)
    current = { key: 'extra', level, bucket: entry }
  }

  /** @type {Record<string, string | null>} */
  const sections = {}
  for (const section of HANDOFF_SECTIONS) {
    const lines = collected[section.id]
    sections[section.id] = lines === null ? null : lines.join('\n').trim()
  }

  return {
    sections: /** @type {any} */ (sections),
    extra: extraEntries.map((entry) => ({
      title: entry.title,
      level: entry.level,
      text: entry.text.join('\n').trim(),
    })),
  }
}

/**
 * 校验交接文档是否合格。
 *
 * - `missing`：没有可用内容的段 id（**完全缺标题** 与 **标题在但无非空行** 都算）。
 *   对「门禁」而言两者一样糟，所以统一进 `missing`；需要区分时看 `empty` 与 `sections`。
 * - `empty`：`missing` 中属于「标题在、内容空」的那部分（有标题没内容）。
 * - `overlong`：超过 `MAX_SECTION_LINES` 行的段，`{ id, lines, max }`，**只告警不判失败**。
 * - `counts`：每段的内容行数（空行与 `<!-- -->` 注释不计）。
 * - `ok`：`missing.length === 0`。
 *
 * @param {string} text
 * @returns {{
 *   ok: boolean,
 *   missing: string[],
 *   empty: string[],
 *   overlong: { id: string, lines: number, max: number }[],
 *   counts: Record<string, number>,
 * }}
 * @throws {HandoffError} 入参不是字符串（code `HANDOFF_INVALID_TEXT`）
 */
export function verifyHandoff(text) {
  assertText(text, 'verifyHandoff')
  const { sections } = parseHandoff(text)

  /** @type {string[]} */
  const missing = []
  /** @type {string[]} */
  const empty = []
  /** @type {{ id: string, lines: number, max: number }[]} */
  const overlong = []
  /** @type {Record<string, number>} */
  const counts = {}

  for (const section of HANDOFF_SECTIONS) {
    const body = sections[section.id]
    if (body === null) {
      missing.push(section.id)
      counts[section.id] = 0
      continue
    }

    const lines = contentLines(body)
    counts[section.id] = lines.length
    if (lines.length === 0) {
      missing.push(section.id)
      empty.push(section.id)
      continue
    }
    if (lines.length > MAX_SECTION_LINES) {
      overlong.push({ id: section.id, lines: lines.length, max: MAX_SECTION_LINES })
    }
  }

  return { ok: missing.length === 0, missing, empty, overlong, counts }
}

/**
 * 一段的取值 → 内容行数组。
 *
 * 支持：字符串（按行拆）、字符串数组（每项一行）、`null`/`undefined`（空段）。
 * 其它类型一律抛错——静默 `String(obj)` 会渲染出 `[object Object]` 这种看起来像内容、
 * 实际没有信息的东西，门禁还会判它合格。
 *
 * @param {unknown} value
 * @param {string} id
 * @returns {string[]}
 * @throws {HandoffError} 类型不支持（code `HANDOFF_INVALID_SECTION`）
 */
function toSectionLines(value, id) {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return contentLines(value)
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (item === null || item === undefined) return []
      if (typeof item === 'string') return contentLines(item)
      if (typeof item === 'number' || typeof item === 'boolean') return [String(item)]
      throw new HandoffError(
        HANDOFF_ERROR_CODES.INVALID_SECTION,
        [
          `formatHandoff 的 sections.${id}[${index}] 只能是字符串，实际收到：${describe(item)}`,
          'Fix: 传字符串，或把一项拆成多个字符串放进数组。',
        ].join('\n'),
      )
    })
  }
  throw new HandoffError(
    HANDOFF_ERROR_CODES.INVALID_SECTION,
    [
      `formatHandoff 的 sections.${id} 只能是字符串或字符串数组，实际收到：${describe(value)}`,
      'Fix: 例：{ decided: ["选了 A", "理由：…"] } 或 { decided: "选了 A" }。',
    ].join('\n'),
  )
}

/**
 * 把对象渲染成带五段标题的交接 markdown。
 *
 * 空段仍然渲染标题 + 一行 `<!-- 待补 -->` 注释占位：先出骨架再逐段填，比「缺段直接不渲染」
 * 更容易看出漏了哪段，也让 `verifyHandoff(formatHandoff({}))` 稳定返回 5 条 missing。
 * 不截断任何内容（超过 `MAX_SECTION_LINES` 只是校验时的告警，渲染阶段不静默丢行）。
 *
 * `input.extra`（可选）为 `{ title, text }[]`，渲染在五段之后，用于承载五段之外的信息。
 *
 * @param {{
 *   decided?: string | string[] | null,
 *   rejected?: string | string[] | null,
 *   risks?: string | string[] | null,
 *   files?: string | string[] | null,
 *   remaining?: string | string[] | null,
 *   extra?: { title: string, text?: string | string[] | null }[],
 * }} [input]
 * @returns {string} markdown（以换行结尾）
 * @throws {HandoffError} input 不是对象，或某段类型不支持
 */
export function formatHandoff(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new HandoffError(
      HANDOFF_ERROR_CODES.INVALID_INPUT,
      [
        `formatHandoff 需要一个对象（形如 { decided, rejected, risks, files, remaining }），实际收到：${describe(input)}`,
        'Fix: 无参数调用即是空模板：formatHandoff()。',
      ].join('\n'),
    )
  }

  /** @type {string[]} */
  const blocks = []
  for (const section of HANDOFF_SECTIONS) {
    const lines = toSectionLines(input[section.id], section.id)
    blocks.push(`## ${section.title}`)
    if (lines.length === 0) blocks.push('<!-- 待补 -->')
    else blocks.push(...lines)
    blocks.push('')
  }

  const extra = input.extra
  if (extra !== undefined && extra !== null) {
    if (!Array.isArray(extra)) {
      throw new HandoffError(
        HANDOFF_ERROR_CODES.INVALID_INPUT,
        `formatHandoff 的 extra 必须是数组（{ title, text }[]），实际收到：${describe(extra)}`,
      )
    }
    for (const [index, entry] of extra.entries()) {
      if (entry === null || typeof entry !== 'object') {
        throw new HandoffError(
          HANDOFF_ERROR_CODES.INVALID_INPUT,
          `formatHandoff 的 extra[${index}] 必须是 { title, text } 对象，实际收到：${describe(entry)}`,
        )
      }
      const title = typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title.trim() : `附记 ${index + 1}`
      const lines = toSectionLines(entry.text, `extra[${index}]`)
      blocks.push(`### ${title}`)
      if (lines.length === 0) blocks.push('<!-- 待补 -->')
      else blocks.push(...lines)
      blocks.push('')
    }
  }

  return `${blocks.join('\n').trimEnd()}\n`
}

/**
 * `~` 展开（只处理 `~` 与 `~/...`，不猜测 `~user` —— 那需要读 passwd，超出零依赖的边界）。
 * @param {string} value
 * @returns {string}
 */
function expandTilde(value) {
  if (value === '~') return process.env.HOME ?? value
  if (value.startsWith('~/')) return path.join(process.env.HOME ?? '', value.slice(2))
  return value
}

/**
 * sessionKey 必须是能安全当文件名的单段字符串。
 * 这类校验是安全边界而非排序细节：`../../x` 会把交接文档写到仓库外。
 * @param {unknown} sessionKey
 * @returns {string}
 * @throws {HandoffError} 非字符串 / 空串 / 含 `/`、`\`、`.`/`..` 段 / 含 NUL
 */
function assertSessionKey(sessionKey) {
  const bad = (reason) =>
    new HandoffError(
      HANDOFF_ERROR_CODES.INVALID_SESSION,
      [
        `sessionKey 不合法：${reason}（实际收到：${describe(sessionKey)}）`,
        'Fix: 用会话 id 这样的单段名字，例如 `handoff init --session session-abc123`；',
        '     不许含 `/`、`\\` 或 `..`（会把交接文档写出 <root>/.dsh/handoffs/）。',
      ].join('\n'),
    )

  if (typeof sessionKey !== 'string') throw bad('必须是字符串')
  const trimmed = sessionKey.trim()
  if (trimmed === '') throw bad('不能为空')
  if (trimmed === '.' || trimmed === '..') throw bad('不能是 `.` 或 `..`')
  if (/[/\\]/.test(trimmed)) throw bad('不能含路径分隔符')
  if (trimmed.includes('\u0000')) throw bad('不能含 NUL 字符')
  return trimmed
}

/**
 * 往某一段末尾追加内容行，返回新的全文（CLI `append` 的落盘实现）。
 *
 * 只做**定点插入**，不重排、不重渲染整份文档：手写的段落顺序、段间空行、
 * 不属于五段的其它标题都原样保留。段不存在时在文末补上该段标题。
 *
 * 该段里残留的 `<!-- 待补 -->` 占位注释会被摘掉：它是「还没写」的标记，
 * 留在段首会让后续解析的第一行变成占位符而不是真内容。
 *
 * @param {string} text 现有交接文档
 * @param {string} sectionId 段 id（也认中文标题，如 `已否决`）
 * @param {string | string[]} lines 要追加的内容（多行字符串按行拆）
 * @returns {string} 新全文（以换行结尾）
 * @throws {HandoffError} text 不是字符串 / 段未知 / 追加内容为空
 */
export function appendToHandoff(text, sectionId, lines) {
  assertText(text, 'appendToHandoff')

  const id = HANDOFF_SECTIONS.some((section) => section.id === sectionId)
    ? sectionId
    : matchSectionId(typeof sectionId === 'string' ? sectionId : '')
  if (id === null) {
    throw new HandoffError(
      HANDOFF_ERROR_CODES.INVALID_SECTION,
      [
        `未知的段：${describe(sectionId)}`,
        `可用段：${HANDOFF_SECTIONS.map((section) => `${section.id}（${section.title}）`).join(' / ')}`,
      ].join('\n'),
    )
  }

  const additions = toSectionLines(lines, id)
  if (additions.length === 0) {
    throw new HandoffError(
      HANDOFF_ERROR_CODES.INVALID_SECTION,
      `追加内容不能为空（段 ${id}）：没有内容可写，调用方大概传错了变量。\nFix: 传非空文本，例如 --text "否决了方案 B：缓存一致性无法验证"。`,
    )
  }

  const currentLines = text.split(/\r?\n/)
  const headingIndex = currentLines.findIndex((line) => {
    const heading = HEADING_RE.exec(line)
    return heading !== null && matchSectionId(heading[2]) === id
  })

  /** @type {string[]} */
  let nextLines

  if (headingIndex === -1) {
    // 段不存在：去掉尾部空行后在文末补一段（前面留一个空行分隔）
    const body = [...currentLines]
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const title = HANDOFF_SECTIONS.find((section) => section.id === id).title
    nextLines = [...body, '', `## ${title}`, ...additions]
  } else {
    // 段尾 = 下一个标题出现的位置（没有下一个标题就到 EOF）
    let endIndex = currentLines.length
    for (let index = headingIndex + 1; index < currentLines.length; index += 1) {
      if (HEADING_RE.test(currentLines[index])) {
        endIndex = index
        break
      }
    }

    // 该段现有正文：去掉 `<!-- 待补 -->` 这类单行注释占位符。
    // 不摘掉的话，模板里那行占位会一直留在段首，解析回来的第一行就成了占位符而不是真内容。
    const existing = currentLines
      .slice(headingIndex + 1, endIndex)
      .filter((line) => !COMMENT_LINE_RE.test(line.trim()))

    // 回退到最后一个非空行之后，避免把追加内容插在段尾的一串空行后面
    let insertAt = existing.length
    while (insertAt > 0 && existing[insertAt - 1].trim() === '') insertAt -= 1

    const tail = currentLines.slice(endIndex)
    nextLines = [
      ...currentLines.slice(0, headingIndex + 1),
      ...existing.slice(0, insertAt),
      ...additions,
    ]
    if (tail.length > 0) {
      // 段与下一段之间保留一个空行
      nextLines.push('')
      nextLines.push(...tail)
    }
  }

  return `${nextLines.join('\n').trimEnd()}\n`
}

/**
 * 交接文档路径：`<root>/.dsh/handoffs/<sessionKey>.md`。
 *
 * root 缺省 `process.cwd()`；空串 / 纯空白视为「未提供」（与 personaRoot 的取值规则一致）。
 * 返回绝对路径（`root` 会先 `path.resolve`），避免调用方在别的 cwd 下拼出相对路径。
 *
 * @param {{ root?: string, sessionKey?: string }} [input]
 * @returns {string}
 * @throws {HandoffError} input 不是对象 / root 不是字符串 / sessionKey 不合法
 */
export function handoffPathFor(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new HandoffError(
      HANDOFF_ERROR_CODES.INVALID_INPUT,
      [
        `handoffPathFor 需要一个对象 { root?, sessionKey }，实际收到：${describe(input)}`,
        'Fix: handoffPathFor({ sessionKey: "session-abc" })。',
      ].join('\n'),
    )
  }

  const rawRoot = input.root
  let root
  if (rawRoot === undefined || rawRoot === null || (typeof rawRoot === 'string' && rawRoot.trim() === '')) {
    root = process.cwd()
  } else if (typeof rawRoot !== 'string') {
    throw new HandoffError(
      HANDOFF_ERROR_CODES.INVALID_ROOT,
      [
        `handoffPathFor 的 root 必须是字符串，实际收到：${describe(rawRoot)}`,
        'Fix: 传绝对路径或相对路径字符串；不传则用 process.cwd()。',
      ].join('\n'),
    )
  } else {
    root = expandTilde(rawRoot.trim())
  }

  const sessionKey = assertSessionKey(input.sessionKey)
  return path.join(path.resolve(root), '.dsh', 'handoffs', `${sessionKey}.md`)
}
