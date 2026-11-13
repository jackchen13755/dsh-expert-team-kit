/**
 * dsh-expert-team-kit / lib/persona-check.mjs
 *
 * 「队友 prompt 里到底有没有**那一位**专家的人格」的判定器。
 *
 * 为什么不能再用子串标记（`bin/dispatch-check.mjs` 旧版 `PERSONA_MARKERS`）：
 * - 旧判据里含一个裸「人格」子串，于是「不要贴人格正文」这种**明确禁止贴正文**的句子
 *   也会判成「有人格」—— 判据对「提到」和「贴了」不区分，方向正好反了。
 * - `Core Mission` / `Identity` 这类通用标题在任务书里也会出现，同样会把「只写了标题」
 *   当成「注入了正文」。
 *
 * 新判据只有两条，必须**同时**成立：
 *   ① prompt 里出现某位人格 frontmatter 的 `name` 值（锚定「是哪一位」）；
 *   ② 该人格**正文前 3 条非空行**中至少 1 条（长度 >= `MIN_BODY_LINE_LENGTH`）**原样**出现
 *      （锚定「正文真的被贴进去了」）。
 *
 * 为什么锚 3 行、阈值 30：真实事故里 prompt 只贴了专家名与前缀标题，正文一个字节都没有；
 * 而人格正文第 1 行常是 `# Xxx Agent Personality`（不足 30 字符，容易被顺手改写），
 * 第 2-3 行才是「你是谁、你负责什么」的实质句。3 行 + 30 字符是「实质正文」的最小锚。
 *
 * 取向：
 * - **纯函数优先**：`parsePersonaMarkdown` / `verifyPersonaPrompt` 不碰磁盘，测试直接喂字符串。
 * - **扫描失败不崩**：`loadPersonaCorpus` 找不到根目录 / 读不了文件时返回 `ok: false` + 原因，
 *   由调用方降级成 warning —— 「扫不到人格清单」不等于「没人格」。
 * - **零依赖**：只用 node 内置模块。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 正文行要「够实质」才算证据：不足 30 字符的短句（如 `## Identity`）不作为锚。 */
export const MIN_BODY_LINE_LENGTH = 30

/** 正文只取前几条非空行（标题/一句话说明），再多就不是「贴正文」而是「贴了整篇」。 */
export const BODY_LINE_LIMIT = 3

/** 人格根目录的环境变量覆盖（测试与多 profile 场景用；CLI 另有 --persona-root）。 */
export const PERSONA_ROOT_ENV = 'DSH_PERSONA_ROOT'

/**
 * 默认人格根目录候选（按优先级）。
 *
 * 只列**真实存在过的布局**：专家插件 fork 后包名变过（`@michengai/...` → `@jackchen13755/...`），
 * 两种都试一遍，避免升级插件后判据静默失效（扫不到就当「没人格」是最危险的静默失败）。
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string[]} 候选目录（未做存在性过滤）
 */
export function defaultPersonaRoots(env = process.env) {
  const home = os.homedir()
  const dshHome = env && env.DSH_HOME ? String(env.DSH_HOME) : path.join(home, '.dsh')
  const profile = path.join(dshHome, 'profiles', 'desktop', 'node_modules')
  const tail = path.join('assets', 'agency-agents')
  return [
    path.join(profile, '@jackchen13755', 'dsh-expert-agents', tail),
    path.join(profile, '@michengai', 'dsh-agency-agents', tail),
  ]
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析人格清单根目录。
 *
 * 优先级：`--persona-root`（显式）→ `DSH_PERSONA_ROOT` → 默认候选里第一个存在的。
 * 显式给了但不存在 → **照样返回它**（`loadPersonaCorpus` 会报 ok:false 并把路径写进原因），
 * 这样「路径打错」能直接被看见，而不是偷偷滑到默认目录去扫出一份看似正常的清单。
 *
 * @param {{override?: string|null, env?: Record<string,string|undefined>}} [options]
 * @returns {{root: string|null, source: 'override'|'env'|'default'|'none'}}
 */
export function resolvePersonaRoot({ override = null, env = process.env } = {}) {
  if (typeof override === 'string' && override.trim() !== '') {
    return { root: path.resolve(expandHome(override)), source: 'override' }
  }
  const fromEnv = env && env[PERSONA_ROOT_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { root: path.resolve(expandHome(fromEnv)), source: 'env' }
  }
  for (const candidate of defaultPersonaRoots(env)) {
    if (isDir(candidate)) return { root: candidate, source: 'default' }
  }
  return { root: null, source: 'none' }
}

/** 展开开头的 `~`（零依赖，够用）。 */
function expandHome(target) {
  const text = String(target)
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

/**
 * 从人格 md 文本里解析 frontmatter 的 `name` 值与正文前 N 条非空行。
 *
 * 边界（都返回**不抛**的中性结果，由调用方决定怎么处置）：
 * - 不是 `---` 开头（没有 frontmatter）→ `name: null`、正文取全文前几条非空行；
 * - frontmatter 没闭合 → `name: null`（宁可不认，也不要把正文当元数据解析）；
 * - 空文本 / 非字符串 → `{ name: null, bodyLines: [], hasFrontmatter: false }`。
 *
 * @param {unknown} text
 * @returns {{name: string|null, nameRaw: string|null, bodyLines: string[], hasFrontmatter: boolean}}
 */
export function parsePersonaMarkdown(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { name: null, nameRaw: null, bodyLines: [], hasFrontmatter: false }
  }

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const allLines = normalized.split('\n')

  let frontmatter = []
  let bodyStart = 0
  let hasFrontmatter = false

  if (allLines[0].trim() === '---') {
    const closing = allLines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (closing > 0) {
      hasFrontmatter = true
      frontmatter = allLines.slice(1, closing)
      bodyStart = closing + 1
    }
  }

  let nameRaw = null
  for (const line of frontmatter) {
    const match = /^name\s*:\s*(.*)$/.exec(line)
    if (match) {
      nameRaw = match[1].trim()
      break
    }
  }
  // 去掉成对的引号（YAML 里 `name: "A B"` 与 `name: A B` 等价）。
  const name = nameRaw === null ? null : nameRaw.replace(/^(['"])([\s\S]*)\1$/, '$2').trim() || null

  const bodyLines = allLines
    .slice(bodyStart)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, BODY_LINE_LIMIT)

  return { name, nameRaw, bodyLines, hasFrontmatter }
}

/**
 * 递归收集目录下的 `*.md`（排序保证多次扫描结果稳定）。
 *
 * 读不了的子目录/文件不抛，记进 `warnings` —— 人格清单残缺时可以降级，但不能崩。
 *
 * @returns {{files: string[], warnings: string[]}}
 */
export function collectPersonaFiles(root) {
  const files = []
  const warnings = []

  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      warnings.push(`无法读取目录 ${dir}（${error.message}）`)
      return
    }
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of sorted) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full)
    }
  }

  walk(root)
  return { files, warnings }
}

/**
 * 读一份人格 md → persona 记录（`name` 缺失或为空时返回 `null`，由调用方记 warning）。
 *
 * @returns {{persona: null|{name: string, bodyLines: string[], file: string}, reason: string|null}}
 */
export function readPersonaFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { persona: null, reason: `读取失败（${error.message}）` }
  }
  const parsed = parsePersonaMarkdown(text)
  if (!parsed.name) {
    return { persona: null, reason: 'frontmatter 里没有 name（无法锚定是哪一位人格）' }
  }
  return { persona: { name: parsed.name, bodyLines: parsed.bodyLines, file }, reason: null }
}

/**
 * 扫一份人格清单。
 *
 * `ok: false` 的三种来路都**不是**「没人格」，而是「这次没法判」：
 * ① 根目录没解析出来；② 目录不存在/读不了；③ 目录下一条可用人格都没有。
 *
 * @param {{root?: string|null, env?: Record<string,string|undefined>}} [options]
 * @returns {{ok: boolean, root: string|null, source: string, personas: {name: string, bodyLines: string[], file: string}[], files: number, warnings: string[], reason: string|null}}
 */
export function loadPersonaCorpus({ root = null, env = process.env } = {}) {
  const resolved = root === null ? resolvePersonaRoot({ env }) : { root, source: 'explicit' }
  const warnings = []

  if (!resolved.root) {
    return {
      ok: false,
      root: null,
      source: resolved.source,
      personas: [],
      files: 0,
      warnings,
      reason: `没有可用的人格根目录（${PERSONA_ROOT_ENV} 未设置，默认候选也都不存在）`,
    }
  }
  if (!isDir(resolved.root)) {
    return {
      ok: false,
      root: resolved.root,
      source: resolved.source,
      personas: [],
      files: 0,
      warnings,
      reason: `人格根目录不存在或不是目录：${resolved.root}`,
    }
  }

  const { files, warnings: walkWarnings } = collectPersonaFiles(resolved.root)
  warnings.push(...walkWarnings)

  const personas = []
  for (const file of files) {
    const { persona, reason } = readPersonaFile(file)
    if (!persona) {
      warnings.push(`${file} 已跳过：${reason}`)
      continue
    }
    personas.push(persona)
  }

  if (personas.length === 0) {
    return {
      ok: false,
      root: resolved.root,
      source: resolved.source,
      personas: [],
      files: files.length,
      warnings,
      reason: `人格根目录下没有可用的人格（扫描 ${files.length} 个 md）`,
    }
  }

  return { ok: true, root: resolved.root, source: resolved.source, personas, files: files.length, warnings, reason: null }
}

/**
 * 判定一段 prompt 是否真的带了某位专家的人格。
 *
 * 判据（必须同时成立，见文件头）：
 *   ① 出现某位人格的 `name` 值；
 *   ② 该人格正文前 3 条非空行里至少 1 条（长度 >= 30）**原样**出现。
 *
 * 边界：
 * - prompt 非字符串 / 空串 → `ok: false`（空 prompt 连任务都没有，更不可能贴人格）；
 * - `personas` 不是数组或为空 → `ok: false` 且 `unavailable: true`
 *   —— 「没有清单」不能算「没人格」，调用方必须把它和 missing 分开处置；
 * - 只提到名字、正文没贴 → `ok: false, nameMatched: true`，reason 明确说是「缺正文」。
 *
 * @param {unknown} prompt
 * @param {{personas?: {name: string, bodyLines?: string[]}[]}} [options]
 * @returns {{ok: boolean, matchedName: string|null, nameMatched: boolean, unavailable: boolean, reason: string}}
 */
export function verifyPersonaPrompt(prompt, { personas } = {}) {
  if (typeof prompt !== 'string') {
    return {
      ok: false,
      matchedName: null,
      nameMatched: false,
      unavailable: false,
      reason: `prompt 不是字符串（${prompt === undefined ? 'undefined' : prompt === null ? 'null' : typeof prompt}）`,
    }
  }
  if (prompt === '') {
    return { ok: false, matchedName: null, nameMatched: false, unavailable: false, reason: 'prompt 是空字符串，没有任何人格内容' }
  }

  const list = Array.isArray(personas) ? personas : []
  if (list.length === 0) {
    return {
      ok: false,
      matchedName: null,
      nameMatched: false,
      unavailable: true,
      reason: '人格清单不可用（为空），无法判定 prompt 里有没有人格',
    }
  }

  let nameMatched = false
  for (const persona of list) {
    const name = persona && typeof persona.name === 'string' ? persona.name.trim() : ''
    if (name === '' || !prompt.includes(name)) continue
    nameMatched = true

    const bodyLines = Array.isArray(persona.bodyLines) ? persona.bodyLines : []
    const hit = bodyLines.find(
      (line) => typeof line === 'string' && line.trim().length >= MIN_BODY_LINE_LENGTH && prompt.includes(line.trim()),
    )
    if (hit) {
      return {
        ok: true,
        matchedName: name,
        nameMatched: true,
        unavailable: false,
        reason: `命中人格「${name}」的正文行：${hit.trim().slice(0, 40)}`,
      }
    }
  }

  if (nameMatched) {
    return {
      ok: false,
      matchedName: null,
      nameMatched: true,
      unavailable: false,
      reason: `只提到了人格名，但该人格正文前 ${BODY_LINE_LIMIT} 条非空行（长度 >= ${MIN_BODY_LINE_LENGTH}）一条都没原样出现（命名 ≠ 人格注入）`,
    }
  }
  return {
    ok: false,
    matchedName: null,
    nameMatched: false,
    unavailable: false,
    reason: `没有命中任何人格的 name，也没有任何人格正文行（清单共 ${list.length} 条）`,
  }
}
