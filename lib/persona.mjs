/**
 * dsh-expert-team-kit / lib/persona.mjs
 *
 * 专家人格解析器（第 2 层核心库）。
 *
 * 设计取向（Developer Tooling Engineer 人格的方法论）：
 * - 接口即契约：slug 的三写法、返回字段形状、错误码都固定，调用方可依赖。
 * - 错误必须是可操作的：每个失败都说明「试过哪些路径 / 下一步怎么办」，
 *   未知 slug 额外给最多 3 个候选，绝不让调用方拿到 undefined 后崩在 `undefined.xxx`。
 * - 零依赖：只用 node 内置模块，frontmatter 用正则解析（不引入 yaml）。
 * - 边界输入全覆盖：非字符串 / 空串 / 纯空白 / 不存在的 slug 一律抛 PersonaError。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 默认人格素材根目录。
 * @type {string}
 */
export const DEFAULT_PERSONAS_ROOT = path.join(
  os.homedir(),
  '.dsh',
  'profiles',
  'desktop',
  'node_modules',
  '@jackchen13755',
  'dsh-expert-agents',
  'assets',
  'agency-agents',
)

/**
 * 错误码集合。所有 PersonaError 都带 `code`，调用方可按码分支，不必匹配文案。
 * @type {Readonly<Record<string, string>>}
 */
export const PERSONA_ERROR_CODES = Object.freeze({
  /** slug 不是非空字符串 */
  INVALID_SLUG: 'PERSONA_INVALID_SLUG',
  /** 素材根目录不存在 / 不可读 */
  ROOT_MISSING: 'PERSONA_ROOT_MISSING',
  /** 按所有候选路径都没找到人格文件 */
  NOT_FOUND: 'PERSONA_NOT_FOUND',
  /** 找到文件但读不出来（权限等） */
  READ_FAILED: 'PERSONA_READ_FAILED',
  /** 文件存在但 frontmatter 缺 name，属于素材数据缺陷 */
  INVALID_FORMAT: 'PERSONA_INVALID_FORMAT',
  /** slug 或候选路径越出素材根目录（路径穿越 / 软链接逃逸） */
  OUTSIDE_ROOT: 'PERSONA_OUTSIDE_ROOT',
})

/** frontmatter 缺省时的最大候选路径展示条数（完整列表仍在 error.tried 里）。 */
const MAX_TRIED_IN_MESSAGE = 14
/** 未知 slug 最多给几个建议。 */
const MAX_SUGGESTIONS = 3

/**
 * 人格解析失败。
 */
export class PersonaError extends Error {
  /**
   * @param {string} code 见 PERSONA_ERROR_CODES
   * @param {string} message 可操作的错误信息（说明原因 + 下一步动作）
   * @param {Record<string, unknown>} [details] 结构化上下文
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PersonaError'
    this.code = code
    this.details = details
    if (Array.isArray(details.tried)) this.tried = details.tried
    if (Array.isArray(details.suggestions)) this.suggestions = details.suggestions
    if (typeof details.root === 'string') this.root = details.root
    Error.captureStackTrace?.(this, PersonaError)
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
 * `~/x` / `~` 展开成绝对路径。
 * @param {string} input
 * @returns {string}
 */
function expandHome(input) {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
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
  return `${Object.prototype.toString.call(value)}`
}

/**
 * 解析人格素材根目录。
 *
 * 优先级：`overrides.root` > 环境变量 `EXPERT_PERSONAS_ROOT` > 内置默认目录。
 * 空串 / 纯空白视为「未提供」，继续看下一级（不会返回空路径）。
 *
 * @param {{ root?: string }} [overrides]
 * @returns {string} 绝对路径
 */
export function personaRoot(overrides) {
  const candidates = [
    { source: 'overrides.root', value: overrides?.root },
    { source: 'EXPERT_PERSONAS_ROOT', value: process.env.EXPERT_PERSONAS_ROOT },
  ]

  for (const { value } of candidates) {
    if (isNonEmptyString(value)) return path.resolve(expandHome(value.trim()))
  }

  return path.resolve(expandHome(DEFAULT_PERSONAS_ROOT))
}

/**
 * 列出根目录下的 division 目录（按名排序，跳过隐藏目录）。目录不可读时抛 ROOT_MISSING。
 * @param {string} root
 * @returns {string[]}
 */
function listDivisions(root) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    throw new PersonaError(
      PERSONA_ERROR_CODES.ROOT_MISSING,
      [
        `专家人格素材目录不存在或不可读：${root}`,
        `底层原因：${error.code ?? error.message}`,
        'Fix: 用环境变量指定素材根目录，或在调用时显式传入 root：',
        '  EXPERT_PERSONAS_ROOT=/path/to/agency-agents node your-script.mjs',
        '  resolvePersona("code-reviewer", { root: "/path/to/agency-agents" })',
      ].join('\n'),
      { root, cause: error.code },
    )
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

/**
 * 只认「存在的普通文件」，目录不算命中。
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

/**
 * `target` 是否落在 `base` 之内（含 base 自身）。
 *
 * 必须按「base + 分隔符」比较前缀：`/x/root-evil` 的字符串前缀是 `/x/root`，
 * 但它是兄弟目录，不是子目录——纯 startsWith 会把它放进来。
 *
 * @param {string} base 已 resolve 的绝对路径
 * @param {string} target 已 resolve 的绝对路径
 * @returns {boolean}
 */
function isInside(base, target) {
  const normalizedBase = base.endsWith(path.sep) ? base.slice(0, -1) : base
  return target === normalizedBase || target.startsWith(normalizedBase + path.sep)
}

/**
 * 素材根的**真实**路径（解开软链接）。目录不可用时与 readdir 失败同码 ROOT_MISSING，
 * 调用方不必区分「不存在」和「不可 realpath」。
 *
 * @param {string} root
 * @returns {string}
 */
function realRootOf(root) {
  try {
    return fs.realpathSync(root)
  } catch (error) {
    throw new PersonaError(
      PERSONA_ERROR_CODES.ROOT_MISSING,
      [
        `专家人格素材目录无法解析真实路径：${root}`,
        `底层原因：${error.code ?? error.message}`,
        'Fix: 确认目录存在且有读权限，或用 EXPERT_PERSONAS_ROOT 指向正确的素材根目录。',
      ].join('\n'),
      { root, cause: error.code },
    )
  }
}

/**
 * 存在的路径取真实路径；不存在返回 null（不抛，用于「顺手判存在」）。
 * @param {string} file
 * @returns {string | null}
 */
function realPathOf(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

/**
 * 构造「越出素材根」错误。属于安全边界，信息要能直接判责。
 *
 * @param {string} slug
 * @param {{ reason: string, root: string, realRoot?: string, candidate?: string, real?: string }} detail
 * @returns {PersonaError}
 */
function outsideRootError(slug, detail) {
  const lines = [
    `slug 越出专家人格素材根目录：${describeValue(slug)}`,
    `原因：${detail.reason}`,
    `素材根目录：${detail.root}`,
  ]
  if (detail.realRoot && detail.realRoot !== detail.root) {
    lines.push(`素材根真实路径：${detail.realRoot}`)
  }
  if (detail.candidate) lines.push(`解析出的候选路径：${detail.candidate}`)
  if (detail.real && detail.real !== detail.candidate) lines.push(`候选路径真实路径：${detail.real}`)
  lines.push(
    '人格正文会被整段贴进任务书交给 worker，越界读取等于把根目录外任意文件提升为「专业身份」指令，',
    '所以这里一律拒绝，而不是靠「文件不存在」碰巧挡住。',
    'Fix: slug 只写素材根目录内的标识，例如 "code-reviewer" / "engineering/code-reviewer"；',
    '     不要传绝对路径、含 ".." 的相对路径，也不要用指向根外的软链接。',
    '     确实要读别的目录，请用 EXPERT_PERSONAS_ROOT 把它设为素材根。',
  )
  return new PersonaError(PERSONA_ERROR_CODES.OUTSIDE_ROOT, lines.join('\n'), {
    slug,
    root: detail.root,
    realRoot: detail.realRoot,
    candidate: detail.candidate,
    real: detail.real,
  })
}

/**
 * slug 段级安全校验：绝对路径、含 `..` 上级段的写法一律拒绝。
 *
 * 这一层挡的是「攻击者直接把穿越路径写进 slug」；候选路径放行后的软链接逃逸
 * 由 `findContainedFile` 的真实路径校验兜住，两层缺一不可。
 *
 * @param {string} slug 已规范化的 slug
 * @param {string} root
 * @param {string} realRoot
 */
function assertSlugStaysInRoot(slug, root, realRoot) {
  if (path.isAbsolute(slug) || /^[A-Za-z]:[\\/]/.test(slug)) {
    throw outsideRootError(slug, {
      reason: 'slug 是绝对路径（绝对路径必然越出素材根）',
      root,
      realRoot,
    })
  }

  if (slug.split(/[\\/]+/).includes('..')) {
    throw outsideRootError(slug, {
      reason: 'slug 含「..」上级目录段，会穿出素材根',
      root,
      realRoot,
    })
  }
}

/**
 * 从候选路径里挑出第一个**确实落在素材根内**的人格文件。
 *
 * 双重护栏：
 *  1. 字面路径必须在根内。候选按构造已满足（division 来自 readdir、slug 已拒 `..`），
 *     这里显式再判一次，防将来新增候选来源绕过。
 *  2. 真实路径必须在根内。`fs.statSync`/`readFileSync` 都会跟随软链接，
 *     根内一个指向根外的软链接就能把根外文件读进来——这一条是真正可被攻击的那道门。
 *
 * @param {string[]} candidates
 * @param {string} slug
 * @param {string} root
 * @param {string} realRoot
 * @returns {string | undefined} 命中的原始候选路径（不是真实路径），未命中返回 undefined
 */
function findContainedFile(candidates, slug, root, realRoot) {
  const resolvedRoot = path.resolve(root)

  for (const candidate of candidates) {
    if (!isInside(resolvedRoot, path.resolve(candidate))) {
      throw outsideRootError(slug, {
        reason: '候选路径的字面路径越出素材根',
        root,
        realRoot,
        candidate,
      })
    }

    if (!isFile(candidate)) continue

    const real = realPathOf(candidate)
    if (real === null) continue // 判存在与解析之间被删掉的竞态，当作没命中
    if (!isInside(realRoot, real)) {
      throw outsideRootError(slug, {
        reason: '候选文件存在，但它的真实路径越出素材根（软链接逃逸）',
        root,
        realRoot,
        candidate,
        real,
      })
    }

    return candidate
  }

  return undefined
}

/**
 * 生成候选路径（按优先级排列，已去重）。
 *
 * 查找顺序（契约）：
 *   1. 带 division 的写法：`<root>/<division>/<rest>.md`，其次 `<division>/<division>-<rest>.md`；
 *   2. 全名写法：按最长的 division 前缀拆出 `<division>-<rest>`，先试 `<division>/<全名>.md`、`<division>/<rest>.md`；
 *   3. 兜底：遍历所有 division，试 `<division>/<slug>.md` 与 `<division>/<division>-<slug>.md`。
 *
 * @param {string} slug 已规范化（trim / 去 .md）
 * @param {string} root
 * @param {string[]} divisions
 * @returns {{ tried: string[], lookupName: string }}
 */
function candidatePaths(slug, root, divisions) {
  /** @type {string[]} */
  const tried = []
  /** @param {string} candidate */
  const push = (candidate) => {
    if (!tried.includes(candidate)) tried.push(candidate)
  }

  const slashIndex = slug.indexOf('/')

  if (slashIndex !== -1) {
    const division = slug.slice(0, slashIndex).trim()
    const rest = slug.slice(slashIndex + 1).trim()

    if (division && rest) {
      // 素材命名有两种：`<division>/<rest>.md` 与 `<division>/<division>-<rest>.md`
      push(path.join(root, division, `${rest}.md`))
      push(path.join(root, division, `${division}-${rest}.md`))

      // 该 division 下没有时，允许跨 division 找同名人格（简名兜底）
      for (const dir of divisions) {
        push(path.join(root, dir, `${rest}.md`))
        push(path.join(root, dir, `${dir}-${rest}.md`))
      }

      return { tried, lookupName: rest }
    }
  } else {
    // 全名写法：division 名本身可能含 `-`（如 game-development），取最长可匹配前缀
    const byLengthDesc = [...divisions].sort(
      (a, b) => b.length - a.length || a.localeCompare(b),
    )
    for (const division of byLengthDesc) {
      if (!slug.startsWith(`${division}-`)) continue
      push(path.join(root, division, `${slug}.md`))
      push(path.join(root, division, `${slug.slice(division.length + 1)}.md`))
      break
    }

    // 简名写法：遍历所有 division
    for (const division of divisions) {
      push(path.join(root, division, `${slug}.md`))
      push(path.join(root, division, `${division}-${slug}.md`))
    }

    return { tried, lookupName: slug }
  }

  // division / rest 有一侧为空的畸形写法：整体当简名处理
  for (const division of divisions) {
    push(path.join(root, division, `${slug}.md`))
    push(path.join(root, division, `${division}-${slug}.md`))
  }

  return { tried, lookupName: slug }
}

/**
 * 扫描所有 division，收集可用人格标识（全名 / division/base / 简名三种写法）。
 * 只用于错误建议，失败静默跳过。
 * @param {string} root
 * @param {string[]} divisions
 * @returns {string[]}
 */
function collectKnownSlugs(root, divisions) {
  /** @type {Set<string>} */
  const known = new Set()

  for (const division of divisions) {
    let files
    try {
      files = fs.readdirSync(path.join(root, division))
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const base = file.slice(0, -'.md'.length)
      if (!base) continue
      known.add(base)
      known.add(`${division}/${base}`)
      if (base.startsWith(`${division}-`)) known.add(base.slice(division.length + 1))
    }
  }

  return [...known].sort()
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return i
}

/**
 * 给未知 slug 找最多 3 个前缀相近的候选。
 *
 * 分档（前一档有结果就不再往后走，保证建议与输入相关）：
 *   1. 前缀相近（互为前缀，或公共前缀 >= 3 字符）；
 *   2. 词元相近（输入里长度 >= 3 的词出现在候选里）；
 *   3. 都没有时给字母序前 3 个，让调用方至少知道有哪些可用标识。
 *
 * @param {string} input
 * @param {string[]} knownSlugs
 * @param {number} [limit]
 * @returns {string[]}
 */
function suggestSlugs(input, knownSlugs, limit = MAX_SUGGESTIONS) {
  const needle = input.toLowerCase()
  const tokens = needle.split(/[-_/\s]+/).filter((token) => token.length >= 3)

  /** @type {{ slug: string, score: number }[]} */
  const prefixHits = []
  /** @type {{ slug: string, score: number }[]} */
  const tokenHits = []

  for (const slug of knownSlugs) {
    const hay = slug.toLowerCase()
    if (hay === needle) continue

    const prefix = commonPrefixLength(needle, hay)
    const prefixRelated = hay.startsWith(needle) || needle.startsWith(hay) || prefix >= 3

    if (prefixRelated) {
      const mutualPrefixBonus = hay.startsWith(needle) || needle.startsWith(hay) ? 1000 : 0
      prefixHits.push({ slug, score: mutualPrefixBonus + prefix })
      continue
    }

    if (tokens.length > 0 && tokens.some((token) => hay.includes(token))) {
      tokenHits.push({ slug, score: tokens.filter((token) => hay.includes(token)).length })
    }
  }

  /** @param {{ slug: string, score: number }[]} hits */
  const rank = (hits) =>
    hits
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.slug.length - b.slug.length ||
          a.slug.localeCompare(b.slug),
      )
      .slice(0, limit)
      .map((hit) => hit.slug)

  if (prefixHits.length > 0) return rank(prefixHits)
  if (tokenHits.length > 0) return rank(tokenHits)
  return knownSlugs.slice(0, limit)
}

/**
 * 解析 frontmatter（`---` 包裹的单行 `key: value`），不引入 yaml 依赖。
 *
 * 限制（已在 README 声明）：只支持单行标量；多行折叠 / 嵌套结构不解析。
 * 对人格素材（name / description / color / emoji / vibe）足够。
 *
 * @param {string} raw 文件原文
 * @returns {{ frontmatter: Record<string, string>, body: string, hasFrontmatter: boolean }}
 */
export function parsePersonaFile(raw) {
  const text = String(raw).replace(/^\uFEFF/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)

  if (!match) {
    // 「以 --- 开头但找不到闭合 ---」和「根本没有 frontmatter」是两种病：
    // 前者按「缺 name」报错会把排查方向指错（缺的是闭合行，不是 name 字段）。
    const unterminated = /^---[ \t]*(?:\r?\n|$)/.test(text)
    return {
      frontmatter: {},
      body: text.replace(/\r\n/g, '\n').trim(),
      hasFrontmatter: false,
      unterminated,
    }
  }

  /** @type {Record<string, string>} */
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!field) continue
    let value = field[2].trim()
    if (value.length >= 2) {
      const quote = value[0]
      if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
        value = value.slice(1, -1)
      }
    }
    frontmatter[field[1]] = value
  }

  return {
    frontmatter,
    body: text.slice(match[0].length).replace(/\r\n/g, '\n').trim(),
    hasFrontmatter: true,
    unterminated: false,
  }
}

/**
 * 把用户给的 slug 规范化：trim、去掉 `./` 前缀、去掉误带的 `.md` 后缀。
 * @param {string} slug
 * @returns {string}
 */
function normalizeSlug(slug) {
  let value = slug.trim()
  while (value.startsWith('./') || value.startsWith('.\\')) value = value.slice(2)
  // 注意：这里**不**剥前导分隔符——`/etc/passwd` 必须保持「绝对路径」形态，
  // 才能被 assertSlugStaysInRoot 判成越界；洗成相对路径等于帮攻击者绕过校验。
  value = value.replace(/\.md$/i, '')
  return value.trim()
}

/**
 * 解析专家人格。
 *
 * @param {string} slug 三种写法均可：`engineering-code-reviewer` / `code-reviewer` / `engineering/code-reviewer`
 * @param {{ root?: string }} [options]
 * @returns {{ slug: string, path: string, name: string, description: string, body: string }}
 * @throws {PersonaError} slug 非法 / 目录缺失 / 找不到 / 读不出 / 缺 name
 */
export function resolvePersona(slug, options) {
  if (!isNonEmptyString(slug)) {
    throw new PersonaError(
      PERSONA_ERROR_CODES.INVALID_SLUG,
      [
        `slug 必须是非空字符串，实际收到：${describeValue(slug)}`,
        'Fix: 传专家人格标识，三种写法都支持：',
        '  resolvePersona("engineering-code-reviewer")  // 全名',
        '  resolvePersona("code-reviewer")              // 简名',
        '  resolvePersona("engineering/code-reviewer")  // division/简名',
      ].join('\n'),
      { slug },
    )
  }

  const normalized = normalizeSlug(slug)
  if (!normalized) {
    throw new PersonaError(
      PERSONA_ERROR_CODES.INVALID_SLUG,
      [
        `slug 规范化后为空：${describeValue(slug)}`,
        'Fix: 传专家人格标识，例如 "code-reviewer"；不要只传路径分隔符或 ".md"。',
      ].join('\n'),
      { slug },
    )
  }

  const root = personaRoot(options)
  const divisions = listDivisions(root)
  const realRoot = realRootOf(root)

  // 段级安全校验必须在生成候选路径之前：越界输入不该出现在 error.tried 里
  assertSlugStaysInRoot(normalized, root, realRoot)

  const { tried } = candidatePaths(normalized, root, divisions)
  const found = findContainedFile(tried, normalized, root, realRoot)

  if (!found) {
    const suggestions = suggestSlugs(normalized, collectKnownSlugs(root, divisions))
    const shownTried =
      tried.length <= MAX_TRIED_IN_MESSAGE
        ? tried
        : tried.slice(0, MAX_TRIED_IN_MESSAGE)
    const omitted = tried.length - shownTried.length

    const lines = [
      `未找到专家人格：${normalized}`,
      `素材根目录：${root}`,
      `已尝试以下路径（均不存在）：`,
      ...shownTried.map((candidate) => `  - ${candidate}`),
    ]
    if (omitted > 0) lines.push(`  … 另有 ${omitted} 个候选路径，见 error.tried`)
    if (suggestions.length > 0) {
      lines.push(`最接近的候选（最多 ${MAX_SUGGESTIONS} 个）：`)
      for (const suggestion of suggestions) lines.push(`  - ${suggestion}`)
    }
    lines.push(
      'Fix: 用上面任一候选重试；或检查 EXPERT_PERSONAS_ROOT 是否指向正确的素材根目录。',
    )

    throw new PersonaError(
      PERSONA_ERROR_CODES.NOT_FOUND,
      lines.join('\n'),
      { slug: normalized, root, tried, suggestions },
    )
  }

  let raw
  try {
    raw = fs.readFileSync(found, 'utf8')
  } catch (error) {
    throw new PersonaError(
      PERSONA_ERROR_CODES.READ_FAILED,
      [
        `专家人格文件存在但读不出来：${found}`,
        `底层原因：${error.code ?? error.message}`,
        'Fix: 检查文件权限，或换一份可读的素材目录（EXPERT_PERSONAS_ROOT）。',
      ].join('\n'),
      { slug: normalized, path: found, cause: error.code },
    )
  }

  const { frontmatter, body, unterminated } = parsePersonaFile(raw)
  const name = (frontmatter.name ?? '').trim()
  const description = (frontmatter.description ?? '').trim()

  if (!name) {
    // 未闭合与缺 name 是两种病，给两种 Fix：按「缺 name」去补字段，怎么补都修不好。
    const lines = unterminated
      ? [
          `专家人格文件的 frontmatter 未闭合：${found}`,
          '文件以 `---` 开头，但找不到第二个 `---` 闭合行，所以 name/description 根本没被解析出来。',
          '（这不是「缺 name」：真的缺的是那个闭合的 `---`。）',
          'Fix: 在 frontmatter 字段之后补一行 `---`，形如：',
          '  ---',
          '  name: Code Reviewer',
          '  description: 一句话描述',
          '  ---',
        ]
      : [
          `专家人格文件缺少 frontmatter 的 name 字段：${found}`,
          '人格名是任务书「你是 <人格>」的锚点，缺了会生成一份没人格的任务书，所以这里直接失败。',
          'Fix: 在文件头部补上：',
          '  ---',
          '  name: Code Reviewer',
          '  description: 一句话描述',
          '  ---',
        ]

    throw new PersonaError(PERSONA_ERROR_CODES.INVALID_FORMAT, lines.join('\n'), {
      slug: normalized,
      path: found,
      unterminated,
    })
  }

  return { slug: normalized, path: found, name, description, body }
}

/**
 * 列出所有可用人格（供 CLI `--list` 与错误提示复用）。
 *
 * 返回的是可直接喂回 resolvePersona 的标识（全名 / division/简名 / 简名）。
 *
 * @param {{ root?: string }} [options]
 * @returns {{ slug: string, division: string, path: string, name: string, description: string }[]}
 * @throws {PersonaError} 目录缺失
 */
export function listPersonas(options) {
  const root = personaRoot(options)
  const divisions = listDivisions(root)
  /** @type {{ base: string, division: string, path: string, name: string, description: string }[]} */
  const entries = []
  /** 结构不合法、resolvePersona 会抛错的文件（缺 name / frontmatter 未闭合 / 读不出） */
  /** @type {{ slug: string, division: string, path: string, reason: string, code: string }[]} */
  const invalid = []

  for (const division of divisions) {
    let files
    try {
      files = fs.readdirSync(path.join(root, division)).filter((file) => file.endsWith('.md'))
    } catch {
      continue
    }

    for (const file of files.sort()) {
      const filePath = path.join(root, division, file)
      const base = file.slice(0, -'.md'.length)

      let raw
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch (error) {
        invalid.push({
          slug: base,
          division,
          path: filePath,
          reason: `文件读不出来（${error.code ?? error.message}）`,
          code: PERSONA_ERROR_CODES.READ_FAILED,
        })
        continue
      }

      const { frontmatter, body, unterminated } = parsePersonaFile(raw)
      const name = (frontmatter.name ?? '').trim()

      if (!name) {
        // 与 resolvePersona 保持一致：这种文件喂回 resolvePersona 一定抛 INVALID_FORMAT，
        // 所以不能出现在「可直接回解析」的列表里，否则枚举→回代会在运行期炸。
        invalid.push({
          slug: base,
          division,
          path: filePath,
          reason: unterminated ? 'frontmatter 未闭合' : '缺少 frontmatter 的 name 字段',
          code: PERSONA_ERROR_CODES.INVALID_FORMAT,
        })
        continue
      }

      entries.push({
        base,
        division,
        path: filePath,
        name,
        description: (frontmatter.description ?? body.split('\n')[0]).trim(),
      })
    }
  }

  // 简名可能指偏：`specialized/prompt-engineer.md` 的简名 `prompt-engineer`，
  // 在跨 division 扫描时会先命中 `engineering/engineering-prompt-engineer.md`。
  // 这样 listPersonas 列出的条目喂回 resolvePersona 会落到**另一个文件**（S2）。
  // 所以逐条用真实解析逻辑自证一次：简名能指回自己就用简名，否则退回 `division/base`。
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const resolveEntry = (slug) => {
    const { tried } = candidatePaths(slug, root, divisions)
    const hit = tried.find((candidate) => byPath.has(candidate))
    return hit === undefined ? undefined : byPath.get(hit)
  }

  /** @type {{ slug: string, division: string, path: string, name: string, description: string }[]} */
  const personas = entries.map((entry) => {
    const slug = resolveEntry(entry.base) === entry ? entry.base : `${entry.division}/${entry.base}`
    return {
      slug,
      division: entry.division,
      path: entry.path,
      name: entry.name,
      description: entry.description,
    }
  })

  // 用数组属性带出被跳过的文件，保持「返回数组」的既有形状不被破坏，
  // 同时不把数据问题静默吞掉（调用方可以按需报警）。
  personas.invalid = invalid
  return personas
}
