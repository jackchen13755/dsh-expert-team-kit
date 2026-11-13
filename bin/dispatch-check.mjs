#!/usr/bin/env node
/**
 * dsh-expert-team-kit / bin/dispatch-check.mjs
 *
 * 「改动归属自检」CLI：读会话日志，回答一个具体问题 —— **本轮的 edit/write 到底是谁执行的？**
 *
 * 要解决的失效形态：主 agent 叫了专家做评审，但代码实现仍然自己干完。这种「假合规」
 * 从交付说明里看不出来（说明只写「用了哪些专家」），只能从会话日志的事实事后核对：
 * 父会话自己 edit 了 N 次、跨多个文件，且本轮**没有派过任何实现队友** —— 就是阶段② 没交出去。
 *
 * 设计取向：
 * - **只读**：不改任何会话文件，不写缓存，不联网。
 * - **否决权只给「父会话日志里必然存在」的证据**：实测子会话日志**大多不落盘**（同一台机器上
 *   派了 12 个子 agent、磁盘只有 1 个子会话目录；另一个会话派了 2 个、0 个落盘）。因此
 *   `childEdits` 只能当**归因参考**，绝不出现在否决条件里 —— 否则「723 行代码确实由子 agent 写」
 *   会被误判成「子 agent 改 0 次 → VIOLATION」。
 * - **只有 `subagent` / `subagent_fork` 算「派过实现」**（`dispatch.subagents`）。另三项一律降级为
 *   **咨询证据**，只计数、只进文案，**永不进放行条件**：
 *     · `summon_expert` / `summon_experts` / `summon_expert_team` 是**一次性咨询**，不写代码；
 *     · `expert_brief` 是**纯函数**（只生成任务书文本，不写盘）；
 *     · `subagent/catalog` 只是「子会话登记」，而且**含咨询专家** —— 实测 `summon_expert` 起的
 *       `agent-1..4` 与 `subagent` 起的 `worker-*` 在 catalog 里**全是 `mode: "continuable"`**，
 *       该字段区分不了咨询与实现（日志里另有 `mode: "normal"/"workspace-write"/...`，那是**沙箱
 *       模式**，与子会话无关，更不能用）。既然 catalog 分不出来，就整体不算实现证据。
 *   把这三项当放行条件的后果是：**「叫了专家评审、实现自己全干完」被判 PASS**，而那正是本工具
 *   声称要抓的形态。
 * - **父子分离统计**：子 agent 的 tool/call 记在子会话日志里，不在父日志里。父日志只有
 *   `subagent/catalog`（子会话登记），所以按 `childId` 找同 workspace 下的兄弟目录再读它的日志。
 *   目录名两种形态都要认：老布局 `session-<childId>`、新布局直接是 `<childId>`。
 *   读不到就如实标 `attribution.confidence = low`，**不**把它当成「队友没改」。
 * - **两种日志格式都吃**：真实日志是 `session.v4.jsonl.zstd`（zstd 压缩的 JSONL），
 *   但测试与二次分发不能依赖真机数据，所以同时支持普通 `session.jsonl`；有 `.zstd` 就用
 *   `zstd -dc` 子进程解压，没有就读普通 JSONL。
 * - **坏输入不崩**：`tool/call` 的 `arguments` 是坏 JSON / 空字符串 / 缺 `file_path` 时，
 *   跳过该调用并记一条 warning。宁可少算一次 edit（结论偏保守地「不算主会话改动」），
 *   也不能让一次坏事件把整份报告打成异常 —— 诊断工具崩掉等于没有诊断工具。
 * - **退出码是契约**：0 = PASS、2 = 违规、1 = 出错。CI 里只判退出码，不看 stdout 文案。
 *
 * 用法见下方 USAGE；零依赖，只用 Node 内置模块。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 退出码契约：CI 只认这三个值。 */
export const EXIT = { PASS: 0, ERROR: 1, VIOLATION: 2 }

/** 计入「改动」的工具名。 */
const EDIT_TOOLS = new Set(['edit', 'write'])

/** 计入「叫专家」的工具名。 */
const EXPERT_TOOLS = new Set(['summon_expert', 'summon_experts', 'summon_expert_team'])

/** 计入「起子 agent」的工具名（`spawn_teammate` 自 0.2.2-rc.2 起并入 `subagent`）。 */
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork'])

/** 计入「生成任务书」的工具名。 */
const BRIEF_TOOLS = new Set(['expert_brief'])

/** 子会话登记事件：出现在父日志里，出现即说明起过子会话。 */
const CATALOG_EVENT = 'subagent/catalog'

/**
 * 「队友 prompt 里有没有专家人格」的**文本标记**。
 *
 * 判定的是「prompt 命中了专家人格的招牌字句」，不是「prompt 写得像不像任务书」——
 * 一个字节 persona 都没有的 prompt 也可能很长、很细致（真实事故里 6988 字节的 prompt
 * 一个标记都不命中），所以只能按 persona md 的固定骨架来认。
 *
 * 这几条都是 `expert_brief` 拼出来的任务书与 `assets/agency-agents/**` 人格正文里的
 * **稳定骨架**（标题 `## Core Mission`、`## Critical Rules`、`# <Name> Agent`、
 * `**Agent Personality**`、正文里的「人格」二字等）。放宽到「提到专家名」就会把
 * 「你是 frontend-developer」判成「有人格」，而名字恰恰是事故里唯一对的东西。
 */
export const PERSONA_MARKERS = [
  'You are **',
  'Agent Personality',
  'Core Mission',
  'Critical Rules',
  'Identity',
  '人格',
]

/** 人格正文的 Markdown 标题形态，如 `# Code Reviewer Agent` / `# Frontend Developer Agent`。 */
export const PERSONA_HEADING_RE = /#\s+\w[\w ]*Agent\b/

/** `samples` 最多留几个队友名（只是给人看的线索，不承担准确性）。 */
export const PERSONA_SAMPLE_LIMIT = 5

/**
 * 这段 prompt 文本里有没有专家人格的痕迹。
 *
 * 空串 / 非字符串一律 `false`：空 prompt 显然没人格（它连任务都没有）。
 *
 * @param {unknown} prompt
 * @returns {boolean}
 */
export function hasPersona(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return false
  if (PERSONA_MARKERS.some((marker) => prompt.includes(marker))) return true
  return PERSONA_HEADING_RE.test(prompt)
}

/**
 * 从一条 `subagent` / `subagent_fork` 的 `tool/call` 里取 `prompt` 与 `name`。
 *
 * `arguments` 在真实日志里是**字符串**（JSON 文本），要二次 parse；任何异常形态都返回
 * `{ ok: false, reason }`，绝不抛 —— 由调用方转成 warning 并**不计入 checked**
 * （解析不出 prompt 时不能假装「检查过他，没人格」，那是编造证据）。
 *
 * `prompt` 缺失 / 不是字符串同样 `ok: false`；但**空串 `''` 是合法 prompt**，
 * 会以 `ok: true, prompt: ''` 返回、由 `hasPersona` 判为「没人格」。
 *
 * @returns {{ok: true, prompt: string, name: string|null} | {ok: false, reason: string}}
 */
export function readSubagentPrompt(event) {
  const raw = event && event.data ? event.data.arguments : undefined

  if (typeof raw !== 'string') {
    return { ok: false, reason: `arguments 不是字符串（${raw === undefined ? 'undefined' : typeof raw}）` }
  }
  if (raw.trim() === '') return { ok: false, reason: 'arguments 是空字符串' }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `arguments 不是合法 JSON（${error.message}）` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'arguments 不是 JSON 对象' }
  }
  if (typeof parsed.prompt !== 'string') {
    return { ok: false, reason: `缺少 prompt（${parsed.prompt === undefined ? 'undefined' : typeof parsed.prompt}）` }
  }
  return { ok: true, prompt: parsed.prompt, name: typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null }
}

/** 会话日志候选文件名，按优先级排列（压缩优先，与真实布局一致）。 */
const LOG_BASENAMES = ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']

/** zstd 解压的输出上限：会话日志可以很大，但要挡住失控。 */
const MAX_DECOMPRESS_BYTES = 1024 * 1024 * 1024

const USAGE = `用法：
  dispatch-check [--session <dir|id|latest>] [--cwd <路径>] [--any-cwd] [--json] [--help]

读 DSH 会话日志，统计本轮的 edit/write 由谁执行（主会话 vs 子 agent），
给出 PASS / VIOLATION 结论。只读，不修改任何会话文件。

判据只看「主会话自己改了多少 / 跨几个文件」＋「有没有派过实现队友」（只看 subagent /
subagent_fork）。子会话日志读不到时只降低归因精度，不构成违规 —— 实测子会话
日志大多不落盘，拿它当否决判据会把「代码确实是子 agent 写的」误判成违规。
叫专家（summon_expert*）与生成任务书（expert_brief）只是**咨询证据**，不算派过实现；
子会话登记（subagent/catalog）含咨询专家，同样不算。

选项：
  --session <dir|id|latest>  会话目录路径、session uuid（支持前缀）或 latest
                             缺省 latest（取最近一次会话，规则见下）
  --cwd <路径>               只在这些 cwd 匹配的 workspace 里找会话（硬筛，匹配不到退出 1）
                             缺省：--session latest 时按当前目录匹配，见下
  --any-cwd                  --session latest 时**忽略当前目录**，回到「全盘 mtime 最新」
                             的旧行为（逃生口）
  --json                     只输出一份 JSON（便于脚本消费）
  -h, --help                 打印本用法并退出 0

选会话规则（只对 --session latest 生效；给目录路径或 uuid 时一律按你给的选）：
  缺省把 --cwd 当成**当前目录**（process.cwd()）：在哪个工作区跑就解析哪个工作区的
  会话 —— 因为 latest 老行为是「全盘 mtime 最新」，挂进 verify（在会话 cwd 下执行、
  拿不到会话 id）时会读到别的工作区，检查错会话。
  这是**软默认**：当前目录下一条会话都没有时退回「全盘最新」而不是报错（在从没跑过
  会话的新目录里跑 verify 不该因此失败）。显式给 --cwd 则是硬筛，匹配不到直接报错。
  想关掉这个默认（比如故意要看全盘最新的会话），加 --any-cwd。

退出码：
  0   PASS       主会话没改，或只改单文件，或本轮确实派过实现队友（subagent/subagent_fork）
  2   VIOLATION  跨多个文件的主会话改动，且本轮 subagent 0 次（只叫专家 / 只写任务书 / 只有子会话登记都不算）
  1   错误       找不到会话 / 参数错 / 日志不可读

环境变量：
  DSH_SESSIONS_DIR  会话根目录，缺省 ~/.dsh/sessions（测试与多 DSH_HOME 场景用）

示例：
  dispatch-check --session latest
  dispatch-check --session latest --any-cwd
  dispatch-check --session ebab78bb --json
  dispatch-check --session ~/.dsh/sessions/--x--/session-<uuid> 
  dispatch-check --cwd /path/to/project
`

/**
 * CLI 侧的预期错误：带退出码与「下一步怎么做」，避免把栈丢给用户。
 */
class CliError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'CliError'
    this.exitCode = EXIT.ERROR
    this.hint = hint || null
  }
}

/**
 * 解析命令行参数。
 *
 * `--help` 优先于一切：只要出现就立刻返回，不再校验别的参数（调试时最怕「想看用法却先被参数错误打断」）。
 *
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {{session: string, cwd: string|null, anyCwd: boolean, json: boolean, help: boolean}}
 * @throws {CliError} 未知参数 / 选项缺值
 */
export function parseArgs(argv) {
  const opts = { session: 'latest', cwd: null, anyCwd: false, json: false, help: false }
  const list = Array.isArray(argv) ? argv : []

  // `--help` 先整体扫描一遍再逐项解析：像 `--session --help` 这种「想看用法」的输入
  // 不应先被「--session 缺少取值」打断（与同仓库 expert-brief 的约定一致）。
  if (list.includes('-h') || list.includes('--help')) {
    opts.help = true
    return opts
  }

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]

    if (arg === '-h' || arg === '--help') {
      opts.help = true
      return opts
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--any-cwd') {
      opts.anyCwd = true
      continue
    }

    // 同时接受 `--session value` 与 `--session=value` 两种写法。
    if (arg === '--session' || arg === '--cwd') {
      const value = list[i + 1]
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new CliError(`选项 ${arg} 缺少取值`, `改成 ${arg} <值>，或先跑 dispatch-check --help 看用法`)
      }
      i += 1
      if (arg === '--session') opts.session = value
      else opts.cwd = value
      continue
    }
    if (arg.startsWith('--session=') || arg.startsWith('--cwd=')) {
      const [flag, ...rest] = arg.split('=')
      const value = rest.join('=')
      if (value === '') {
        throw new CliError(`选项 ${flag} 缺少取值`, `改成 ${flag} <值>，或先跑 dispatch-check --help 看用法`)
      }
      if (flag === '--session') opts.session = value
      else opts.cwd = value
      continue
    }

    throw new CliError(
      `未知参数：${arg}`,
      '可用参数只有 --session / --cwd / --any-cwd / --json / --help；跑 --help 看用法',
    )
  }

  return opts
}

/** 会话根目录：优先 `DSH_SESSIONS_DIR`（测试/多 DSH_HOME 用），否则 `~/.dsh/sessions`。 */
export function sessionsRoot(env = process.env) {
  const override = env && env.DSH_SESSIONS_DIR
  if (override && String(override).trim() !== '') return path.resolve(String(override))
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** 目录不存在时返回 []，绝不抛（缺目录是「没有会话」，不是「出错」）。 */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 一个 workspace 目录下的所有 `session-*` 会话目录。 */
function sessionDirsIn(workspaceDir) {
  return safeReaddir(workspaceDir)
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
    .map((entry) => path.join(workspaceDir, entry.name))
}

/** 会话根下所有 workspace 的所有会话目录。 */
export function listSessionDirs(root = sessionsRoot()) {
  const out = []
  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory()) continue
    out.push(...sessionDirsIn(path.join(root, entry.name)))
  }
  return out
}

/** 解析会话目录里的日志文件（压缩优先）；找不到返回 null。 */
export function resolveLogFile(sessionDir) {
  for (const base of LOG_BASENAMES) {
    const file = path.join(sessionDir, base)
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {
      // 不存在就继续试下一个候选
    }
  }
  return null
}

/** 用 `zstd -dc` 解压到内存；zstd 缺失或文件损坏都转成可定位的 CliError。 */
function decompressZstd(file) {
  const res = spawnSync('zstd', ['-dc', file], { maxBuffer: MAX_DECOMPRESS_BYTES })

  if (res.error) {
    const code = res.error.code || ''
    throw new CliError(
      `解压失败：无法执行 zstd（${file}${code ? `，${code}` : ''}）`,
      '安装 zstd（brew install zstd），或把会话导出成未压缩的 session.jsonl 后重试',
    )
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').toString().trim()
    throw new CliError(
      `解压失败：${file} 不是可读的 zstd 文件（zstd 退出码 ${res.status}${stderr ? `：${stderr}` : ''}）`,
      '确认文件没有损坏；损坏时用同目录的 session.jsonl 重试',
    )
  }
  return res.stdout.toString('utf8')
}

/**
 * 读一个会话目录的全部事件。
 *
 * 坏行（截断的 JSONL 尾巴）跳过并计数，不抛：日志正在写入时最后一行可能不完整。
 *
 * @returns {{events: object[], badLines: number, file: string}}
 */
export function readSessionEvents(sessionDir) {
  const file = resolveLogFile(sessionDir)
  if (!file) {
    throw new CliError(
      `会话目录里没有日志文件：${sessionDir}`,
      `该目录下应有 ${LOG_BASENAMES.join(' / ')} 之一；确认 --session 指向的是会话目录（session-<uuid>）而不是 workspace 目录`,
    )
  }

  const text = file.endsWith('.zstd') ? decompressZstd(file) : fs.readFileSync(file, 'utf8')
  const events = []
  let badLines = 0

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }

  return { events, badLines, file }
}

/** 从事件流里取会话元数据（首行的 `type: "session"`）。 */
export function readSessionMeta(events) {
  for (const event of events) {
    if (event && event.type === 'session') {
      return {
        id: event.id || null,
        cwd: event.cwd || null,
        delegationDepth: event.delegationDepth,
        origin: event.origin || null,
        parentSession: event.parentSession || null,
      }
    }
  }
  return { id: null, cwd: null, delegationDepth: null, origin: null, parentSession: null }
}

/**
 * 从一条 `tool/call` 事件里取 `file_path`。
 *
 * `arguments` 在真实日志里是**字符串**（JSON 文本），必须二次 parse。任何异常形态都返回
 * `{ ok: false, reason }`，由调用方统一转成 warning —— 这里绝不抛。
 *
 * @returns {{ok: true, filePath: string} | {ok: false, reason: string}}
 */
export function readEditTarget(event) {
  const raw = event && event.data ? event.data.arguments : undefined

  if (typeof raw !== 'string') {
    return { ok: false, reason: `arguments 不是字符串（${raw === undefined ? 'undefined' : typeof raw}）` }
  }
  if (raw.trim() === '') return { ok: false, reason: 'arguments 是空字符串' }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `arguments 不是合法 JSON（${error.message}）` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'arguments 不是 JSON 对象' }
  }

  const filePath = parsed.file_path
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, reason: '缺少 file_path' }
  }
  return { ok: true, filePath }
}

/**
 * 统计一个会话事件流里的 edit/write。
 *
 * @returns {{edits: number, files: string[], experts: number, warnings: string[]}}
 */
export function countCalls(events, scope = '主会话') {
  const files = []
  const warnings = []
  let edits = 0
  let experts = 0

  for (const event of events) {
    if (!event || event.type !== 'tool/call') continue
    const name = event.data ? event.data.name : undefined
    if (typeof name !== 'string') continue

    if (EDIT_TOOLS.has(name)) {
      const target = readEditTarget(event)
      if (target.ok) {
        edits += 1
        files.push(target.filePath)
      } else {
        warnings.push(`${scope}有一次 ${name} 调用无法解析（${target.reason}），已跳过，不计入统计`)
      }
      continue
    }
    if (EXPERT_TOOLS.has(name)) experts += 1
  }

  return { edits, files, experts, warnings }
}

/**
 * 统计四项派活计数——全部取自**父会话日志**，不依赖子会话日志是否落盘。
 *
 * 四项的**证据强度不一样**，别混用（这是本文件第三次修正的核心）：
 *
 * - `subagents`：`subagent` + `subagent_fork` 的调用次数 —— **唯一有资格当「派过实现」的证据**
 *   （它起的是能写代码的队友，且这两个工具名本身就把咨询排除在外）。
 * - `expertCalls`：`summon_expert` + `summon_experts` + `summon_expert_team` —— **咨询证据**，
 *   一次性咨询、不写代码。
 * - `briefs`：`expert_brief` —— **咨询证据**，纯函数，只生成任务书文本，不写盘。
 * - `catalog`：`subagent/catalog` 事件数（子会话登记）—— 仅作展示；它**包含咨询专家**
 *   （实测 `summon_expert` 起的 `agent-*` 与 `subagent` 起的 `worker-*` 都是 `mode: "continuable"`，
 *   区分不了），所以不能当实现证据。
 *
 * 只数事件、不解析 `arguments`：这里要回答的是「有没有派活」，不是「派给了谁」，
 * 所以坏 arguments 也不影响本计数（也不该为它记 warning，否则诊断噪声掩盖真问题）。
 *
 * **例外：`persona`。** 这一项必须读 `arguments.prompt`，所以坏 arguments 会影响它；
 * 但坏 arguments **不计入 `checked`**（解析不出 prompt ≠ 检查过且没人格），只记 warning。
 * 这条区分很重要：把解析失败算成 missing 会把日志残缺说成「队友没带人格」，
 * 而把解析失败静默跳过又会让人以为「这一轮没人格问题」。
 *
 * @param {any[]} events
 * @param {string[]} [warnings] 解析异常时追加 warning 的数组（不传则只丢给 console 之外的调用方忽略）
 * @returns {{subagents: number, expertCalls: number, briefs: number, catalog: number, persona: {checked: number, missing: number, samples: string[]}}}
 */
export function countDispatch(events, warnings = []) {
  const dispatch = {
    subagents: 0,
    expertCalls: 0,
    briefs: 0,
    catalog: 0,
    persona: { checked: 0, missing: 0, samples: [] },
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    if (event.type === CATALOG_EVENT) {
      dispatch.catalog += 1
      continue
    }
    if (event.type !== 'tool/call') continue

    const name = event.data ? event.data.name : undefined
    if (typeof name !== 'string') continue

    if (SUBAGENT_TOOLS.has(name)) {
      dispatch.subagents += 1
      // 每个 subagent 调用都要看 prompt：这是「命名≠人格注入」唯一的事后证据。
      const read = readSubagentPrompt(event)
      if (!read.ok) {
        warnings.push(`有一次 ${name} 调用无法解析（${read.reason}），人格检查跳过，不计入 checked`)
        continue
      }
      dispatch.persona.checked += 1
      if (!hasPersona(read.prompt)) {
        dispatch.persona.missing += 1
        if (dispatch.persona.samples.length < PERSONA_SAMPLE_LIMIT) {
          dispatch.persona.samples.push(read.name || `(未命名队友 #${dispatch.persona.checked})`)
        }
      }
    } else if (EXPERT_TOOLS.has(name)) dispatch.expertCalls += 1
    else if (BRIEF_TOOLS.has(name)) dispatch.briefs += 1
  }

  return dispatch
}

/**
 * 「队友 prompt 里没有专家人格」的 warning 文案；`missing === 0` 时返回 `null`。
 *
 * 文案里的两个数字是同一个量（缺几个），不是笔误：`samples` 最多只留
 * `PERSONA_SAMPLE_LIMIT` 个名字，缺 7 个时名字只能列 5 个，所以**必须同时给出真实缺数**，
 * 否则读者会以为「只缺了列出来的这几个」。
 *
 * 这条文案刻意点出「命名≠人格注入」：真实事故里三个队友名字全对（`frontend-developer` /
 * `frontend-developer-2` / `testing-reality-checker`），prompt 却一个 persona 字节都没有，
 * 人以为人格也跟着名字进去了。不把这句话写在 warning 里，读者只会以为「名字都起了还有什么问题」。
 *
 * @returns {string|null}
 */
export function buildPersonaWarning(dispatch = {}) {
  const persona = dispatch && dispatch.persona ? dispatch.persona : {}
  const missing = Number(persona.missing) || 0
  if (missing <= 0) return null

  const samples = Array.isArray(persona.samples) ? persona.samples.filter((name) => typeof name === 'string') : []
  const names = samples.length > 0 ? `：${samples.join(', ')}` : ''
  return (
    `本轮 ${missing} 个队友的 prompt 里没有专家人格（缺 ${missing} 个${names}）` +
    '—— 命名≠人格注入，请用 expert_brief 生成任务书或把 persona md 正文贴进 prompt'
  )
}

/**
 * 人类输出里的「人格注入」一行；`checked === 0`（本轮没起队友）时返回 `null`（不打印）。
 *
 * @returns {string|null} 如 `人格注入   2/3 有 persona（缺：worker-a）`
 */
export function describePersona(dispatch = {}) {
  const persona = dispatch && dispatch.persona ? dispatch.persona : {}
  const checked = Number(persona.checked) || 0
  if (checked <= 0) return null

  const missing = Number(persona.missing) || 0
  const withPersona = Math.max(checked - missing, 0)
  const samples = Array.isArray(persona.samples) ? persona.samples.filter((name) => typeof name === 'string') : []
  const detail = missing > 0 && samples.length > 0 ? `（缺：${samples.join(', ')}）` : ''
  return `人格注入   ${withPersona}/${checked} 有 persona${detail}`
}

/**
 * 四项派活计数的一句话描述，给 warning / summary 复用（避免两处文案漂移）。
 *
 * 注意它把「实现」与「咨询」混在一行里，只适合附在结论后面当明细；人类报告的主输出
 * 用 `renderHuman` 里的两行（实现队友 / 咨询证据），别用这一行。
 *
 * @returns {string} 如 `2 个子 agent / 1 次专家 / 1 份任务书 / 2 条子会话登记`
 */
export function describeDispatch(dispatch = {}) {
  const subagents = Number(dispatch.subagents) || 0
  const expertCalls = Number(dispatch.expertCalls) || 0
  const briefs = Number(dispatch.briefs) || 0
  const catalog = Number(dispatch.catalog) || 0
  return `${subagents} 个子 agent / ${expertCalls} 次专家 / ${briefs} 份任务书 / ${catalog} 条子会话登记`
}

/** 按 mtime 取最新的会话目录；取不到 mtime 时退回按名字排序。 */
function newestDir(dirs) {
  if (dirs.length <= 1) return dirs[0] || null
  let best = dirs[0]
  let bestTime = -1
  for (const dir of dirs) {
    let stamp = 0
    const logFile = resolveLogFile(dir)
    try {
      stamp = fs.statSync(logFile || dir).mtimeMs
    } catch {
      stamp = 0
    }
    if (stamp > bestTime) {
      bestTime = stamp
      best = dir
    }
  }
  return best
}

/**
 * cwd → workspace 目录名。
 *
 * 真实布局：`/Users/me/Desktop/work/x` → `--Users-me-Desktop-work-x--`，
 * 即「去掉开头的 `/`、把内部 `/` 换成 `-`、两端各包 `--`」。开头那个 `/` 不能换成 `-`，
 * 否则会拼出三个前导短横线，永远匹配不上真实目录（这个坑就写在 tests 里守着）。
 */
export function workspaceSlugForCwd(cwd) {
  const resolved = path.resolve(String(cwd)).replace(/\/+$/, '')
  const inner = resolved.replace(/^[/\\]+/, '').replace(/[/\\]/g, '-')
  return `--${inner}--`
}

/** realpath 失败（路径不存在）时原样返回，用于比较。 */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(String(target))
  }
}

/** 只读日志首行拿元数据（`--cwd` 的兜底匹配用，slug 规则变了也不至于筛错）。 */
function readMetaCheap(sessionDir) {
  try {
    const { events } = readSessionEvents(sessionDir)
    return readSessionMeta(events)
  } catch {
    return { id: null, cwd: null }
  }
}

/**
 * 按 `--cwd` 筛会话：先用 slug 直接比（零解压），筛不到再退化为读元数据里的真实 cwd。
 * 两级是为了「快」和「slug 规则将来变化时不静默筛错」两者都要。
 */
function filterByCwd(dirs, cwd) {
  const slug = workspaceSlugForCwd(cwd)
  const bySlug = dirs.filter((dir) => path.basename(path.dirname(dir)) === slug)
  if (bySlug.length > 0) return bySlug

  const target = safeRealpath(cwd)
  return dirs.filter((dir) => {
    const meta = readMetaCheap(dir)
    return meta.cwd ? safeRealpath(meta.cwd) === target : false
  })
}

/** 生成「找不到会话」时可操作的提示：把最近几个会话名给出来，省掉用户 ls 一轮。 */
function hintForMissingSession(root, wanted) {
  const dirs = listSessionDirs(root)
  const recent = dirs
    .slice()
    .sort((a, b) => {
      let ta = 0
      let tb = 0
      try {
        ta = fs.statSync(resolveLogFile(a) || a).mtimeMs
      } catch {
        ta = 0
      }
      try {
        tb = fs.statSync(resolveLogFile(b) || b).mtimeMs
      } catch {
        tb = 0
      }
      return tb - ta
    })
    .slice(0, 5)
    .map((dir) => path.basename(path.dirname(dir)) + '/' + path.basename(dir))

  const lines = [
    '  - 用 --session latest 取最近一次会话（缺省按当前目录匹配，--any-cwd 可关）',
    '  - 用 --any-cwd 忽略当前目录限制，回到「全盘最新」',
    '  - 用 --session <uuid> 或 uuid 前缀（会匹配 session-<uuid>*）',
    '  - 用 --session <会话目录绝对路径> 直接指定',
  ]
  if (recent.length > 0) lines.push(`  - ${root} 下最近的会话：${recent.join(' / ')}`)
  else lines.push(`  - ${root} 下一个会话目录都没有：确认 DSH 至少跑过一次，或检查 DSH_SESSIONS_DIR`)

  return `找不到会话 ${wanted}。可尝试：\n${lines.join('\n')}`
}

/**
 * 把「隐式默认 cwd」落成一次真实的会话筛选。
 *
 * 背景：`--session latest` 的老行为是「全盘 mtime 最新」，与当前目录无关。挂进
 * completion-ledger 的 verify（在**会话 cwd** 下执行、拿不到会话 id）时就会读到别的
 * workspace 的会话，检查错会话。所以 `--session latest` 且没显式给 `--cwd` 时，
 * 默认按 `process.cwd()` 匹配 workspace。
 *
 * 三条边界（缺一条就会破坏既有用法）：
 * - 显式 `--cwd` 优先，不被覆盖；
 * - `--any-cwd` 显式关掉默认（回到全盘最新），当作逃生口；
 * - `--session` 是目录路径或 uuid 时完全不受影响（用户已经指名道姓了）。
 *
 * @param {{session?: string, cwd?: string|null, anyCwd?: boolean}} opts
 * @param {string} [processCwd] 当前目录，测试注入用
 * @returns {{cwd: string|null, source: 'explicit'|'any-cwd'|'selector'|'implicit'}}
 */
export function effectiveCwd({ session = 'latest', cwd = null, anyCwd = false } = {}, processCwd = process.cwd()) {
  if (cwd) return { cwd, source: 'explicit' }
  if (anyCwd) return { cwd: null, source: 'any-cwd' }
  const selector = session === undefined || session === null || session === '' ? 'latest' : String(session)
  if (selector !== 'latest') return { cwd: null, source: 'selector' }
  return { cwd: processCwd, source: 'implicit' }
}

/**
 * 解析 `--session` 选择器到一个具体会话目录。
 *
 * 支持三种形态：目录路径、uuid（含前缀）、`latest`。
 *
 * `softCwd`：cwd 筛不到会话时是否退回不筛（**只给隐式默认 cwd 用**）。
 * 隐式默认是「猜」用户的意图，猜不中（新目录里从没有会话）就不该让 verify 失败；
 * 用户显式写 `--cwd` 则是硬筛，筛不到必须报错，否则会静默检查错会话。
 *
 * @returns {{dir: string, resolvedBy: string, cwdFallback: boolean}}
 */
export function resolveSession({ session = 'latest', cwd = null, root = sessionsRoot(), softCwd = false } = {}) {
  const selector = session === undefined || session === null || session === '' ? 'latest' : String(session)

  // 1) 直接给目录路径（含 `~` 展开）——最确定，先试，不要求它在 sessions 根下。
  if (selector !== 'latest') {
    const expanded = selector.startsWith('~')
      ? path.join(os.homedir(), selector.slice(1).replace(/^[/\\]/, ''))
      : selector
    const asDir = path.resolve(expanded)
    try {
      if (fs.statSync(asDir).isDirectory()) return { dir: asDir, resolvedBy: 'dir', cwdFallback: false }
    } catch {
      // 不是目录，接着按 uuid 找
    }
  }

  // 2) 在 sessions 根下按 workspace（--cwd）与 uuid 匹配。
  let candidates = listSessionDirs(root)
  if (candidates.length === 0) {
    throw new CliError(`会话根目录为空：${root}`, `确认 DSH 至少运行过一次，或用 DSH_SESSIONS_DIR 指向正确目录`)
  }
  let cwdFallback = false
  if (cwd) {
    const filtered = filterByCwd(candidates, cwd)
    if (filtered.length === 0) {
      if (!softCwd) {
        throw new CliError(
          `没有 cwd 匹配 ${path.resolve(String(cwd))} 的会话`,
          `用 --cwd <项目的绝对路径>，或干脆去掉 --cwd 让它扫全部 workspace`,
        )
      }
      // 隐式默认 cwd 猜不中：退回全盘（老行为），并在报告里标明，不静默。
      cwdFallback = true
    } else {
      candidates = filtered
    }
  }

  if (selector === 'latest') {
    const dir = newestDir(candidates)
    return { dir, resolvedBy: 'latest', cwdFallback }
  }

  const wanted = selector.startsWith('session-') ? selector : `session-${selector}`
  const matched = candidates.filter((dir) => path.basename(dir).startsWith(wanted))
  if (matched.length === 0) {
    throw new CliError(hintForMissingSession(root, selector), null)
  }

  const dir = newestDir(matched)
  return { dir, resolvedBy: matched.length > 1 ? 'prefix-ambiguous' : 'prefix', cwdFallback }
}

/**
 * 核心分析：父会话 + 所有子会话 → 统计与结论。
 *
 * 子会话关联靠父日志里的 `subagent/catalog`（`childId`），目录是同 workspace 下的
 * `session-<childId>`。同一 childId 可能被登记多次（持久子 agent 反复出现），读取时按 id 去重，
 * 但 `subagents` 计数仍按事件数（契约如此）。
 */
export function analyzeSession(sessionDir, { cwd } = {}) {
  const parentRead = readSessionEvents(sessionDir)
  const meta = readSessionMeta(parentRead.events)
  const warnings = []

  if (parentRead.badLines > 0) {
    warnings.push(`主会话日志有 ${parentRead.badLines} 行不是合法 JSON，已跳过`)
  }

  const parentStats = countCalls(parentRead.events, '主会话')
  warnings.push(...parentStats.warnings)

  // 派活计数：全部来自父日志，**不依赖子会话日志是否落盘**（后者实测大多缺失）。
  // 四项里只有 subagents 能当「派过实现」的证据，其余三项只作咨询证据（见 countDispatch 注释）。
  // 传 warnings 进去：人格检查要读 `arguments.prompt`，解析失败要留痕（但不计入 checked）。
  const dispatch = countDispatch(parentRead.events, warnings)
  if (dispatch.subagents > 0 && dispatch.catalog === 0) {
    warnings.push(
      `父日志里有 ${dispatch.subagents} 次 subagent 调用但没有任何 subagent/catalog 登记，无法定位子会话日志（归因精度降级）`,
    )
  }

  // 子会话登记：计数按事件数，读取按 childId 去重。
  const catalogs = []
  const seenChildIds = new Set()
  for (const event of parentRead.events) {
    if (!event || event.type !== CATALOG_EVENT) continue
    const data = event.data || {}
    if (data.childId) catalogs.push(data)
  }

  const children = []
  let childEdits = 0
  const allFiles = [...parentStats.files]

  for (const catalog of catalogs) {
    const childId = catalog.childId
    if (seenChildIds.has(childId)) continue
    seenChildIds.add(childId)

    const childDir = resolveChildDir(sessionDir, childId)
    const label = catalog.name || catalog.label || childId
    let found = false
    let edits = 0
    let exists = Boolean(childDir)

    if (!exists) {
      warnings.push(`子会话 ${label} 没有日志目录（缺 session-${childId} / ${childId}），其改动无法计入、执行占比无法归因`)
    } else {
      try {
        const childRead = readSessionEvents(childDir)
        if (childRead.badLines > 0) {
          warnings.push(`子会话 ${label} 的日志有 ${childRead.badLines} 行不是合法 JSON，已跳过`)
        }
        const childStats = countCalls(childRead.events, `子会话 ${label} `)
        warnings.push(...childStats.warnings)
        edits = childStats.edits
        allFiles.push(...childStats.files)
        found = true
      } catch (error) {
        // 子会话日志读不出来不影响主结论：如实记 warning，childEdits 保持已统计到的值。
        warnings.push(`子会话 ${label} 的日志读取失败（${error.message}），其改动无法计入、执行占比无法归因`)
      }
    }

    childEdits += edits
    children.push({ id: childId, name: catalog.name || null, label: catalog.label || null, dir: childDir, found, edits })
  }

  const files = [...new Set(allFiles)]

  const attribution = summarizeAttribution({ children, dispatch })
  const judgment = judge({
    files,
    parentEdits: parentStats.edits,
    childEdits,
    dispatch,
    attribution,
  })

  const report = {
    session: {
      id: meta.id,
      dir: sessionDir,
      cwd: meta.cwd || null,
      delegationDepth: meta.delegationDepth === undefined ? null : meta.delegationDepth,
      origin: meta.origin,
    },
    verdict: judgment.verdict,
    files,
    fileCount: files.length,
    parentEdits: parentStats.edits,
    childEdits,
    experts: parentStats.experts,
    // 兼容旧字段：历史语义是「subagent/catalog 事件数」，新代码请读 dispatch.subagents。
    subagents: catalogs.length,
    dispatch,
    attribution,
    children,
    warnings: [...warnings, ...judgment.warnings],
    summary: judgment.summary,
  }
  if (cwd) report.session.cwdFilter = path.resolve(String(cwd))
  return report
}

/**
 * 子会话目录名有两种真实形态，都要认：
 * - 老布局：`<workspace>/session-<childId>`
 * - 新布局：`<workspace>/<childId>`（实测父会话是 `session-*`、子会话是裸 uuid）
 *
 * 两种都不存在时返回 null（调用方据此标 `found: false` 并降级 confidence）。
 * 先找老布局再找新布局：顺序稳定，测试与真机都能复现。
 */
export function resolveChildDir(parentDir, childId) {
  const workspaceDir = path.dirname(parentDir)
  for (const name of [`session-${childId}`, childId]) {
    const candidate = path.join(workspaceDir, name)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // 不存在就试下一个候选
    }
  }
  return null
}

/**
 * 归因精度：子会话日志找到几个、缺几个。
 *
 * `confidence`：
 * - `high`：该找的都找到了（或本轮压根没起子会话，没有需要归因的东西）
 * - `low`：有子会话登记但日志缺失 —— 此时 `childEdits` 只可能偏小，结论只能靠实现队友计数
 *   （`dispatch.subagents`，父日志里必然存在）判定，所以**必须降级并写明**，
 *   不能把「日志没落盘」当成「队友没改」。
 */
export function summarizeAttribution({ children = [], dispatch = {} } = {}) {
  const childLogsFound = children.filter((child) => child.found).length
  const childLogsMissing = children.length - childLogsFound

  // 登记了 k 个、找到了 k 个才是 high。两条 low 的来路：
  // ① 有登记但目录缺失；② 有 `subagent` / `catalog` 痕迹却一条登记都没解析出 `childId`
  //    （数据残缺），此时同样无从归因。
  const hints = (Number(dispatch.subagents) || 0) + (Number(dispatch.catalog) || 0)
  let confidence = 'high'
  if (childLogsMissing > 0) confidence = 'low'
  else if (children.length === 0 && hints > 0) confidence = 'low'

  return { childLogsFound, childLogsMissing, confidence }
}

/**
 * VIOLATION 的说明文案：只决定「怎么说」，不决定「判不判」。
 *
 * 判据只有 `judge` 里那一条 `subagents === 0`（见该函数 ③）。这里读 expertCalls / briefs /
 * catalog **纯粹是为了把话说准**：同样是没派实现队友，「只叫了专家评审」和「什么都没叫」是两种
 * 完全不同的失效形态，读者要一眼分清。所以这些计数只出现在文案模板里，绝不出现在任何
 * `verdict === 'VIOLATION'` 的条件里。
 *
 * @returns {string} 如 `跨 7 个文件的主会话改动 10 次，且本轮没有任何派活记录`
 */
function violationDetail({ fileCount, parentEdits, dispatch = {} }) {
  const expertCalls = Number(dispatch.expertCalls) || 0
  const briefs = Number(dispatch.briefs) || 0
  const catalog = Number(dispatch.catalog) || 0
  const head = `跨 ${fileCount} 个文件的主会话改动 ${parentEdits} 次`

  // 情况一：什么都没叫 —— 主会话就是自己从头干到尾。
  if (expertCalls + briefs + catalog === 0) return `${head}，且本轮没有任何派活记录`

  // 情况二：叫过咨询（专家 / 任务书 / 子会话登记）但没派实现队友 —— 最像合规的假合规形态。
  const catalogNote = catalog > 0 ? `（子会话登记 ${catalog} 条）` : ''
    // 只有子会话登记、专家与任务书都是 0 时，不能说「叫了评审」（会自相矛盾）。
    if (expertCalls + briefs === 0) {
      return (
        `${head}；本轮只有 ${catalog} 条子会话登记，既没叫专家也没派实现队友` +
        '——实现全由主会话自己完成'
      )
    }
  return (
    `${head}；本轮只叫了 ${expertCalls} 次专家/生成 ${briefs} 份任务书${catalogNote}` +
    '，但没有任何实现队友（subagent 0 次）——「叫了评审，实现仍自己干」'
  )
}

/**
 * 判定规则（严格按契约实现，从上到下命中即停）：
 *
 *   ① `parentEdits === 0` → PASS（主会话没改）
 *   ② `files.length <= 1` → PASS（单文件豁免）
 *   ③ `files.length >= 2 && parentEdits > 0`：
 *      - `dispatch.subagents > 0` → PASS（真派了实现队友 subagent / subagent_fork）
 *      - 否则 → VIOLATION（文案按「只叫了咨询」/「什么都没叫」分两种，见 violationDetail）
 *
 * **两条硬约束：**
 * ① **VIOLATION 条件里不得出现 `childEdits`。** 实测子会话日志大多不落盘，拿它当否决判据会把
 *    「723 行代码确实由子 agent 写」误判成「子 agent 改 0 次」。`childEdits` 仍然收、仍然输出，
 *    但只用于归因说明（配合 `attribution.confidence`）。
 * ② **VIOLATION 条件里也不得出现 `expertCalls` / `briefs` / `catalog`。** 这三项是**咨询证据**：
 *    `summon_expert` 一次性咨询不写代码、`expert_brief` 是纯函数不写盘、`subagent/catalog` 连
 *    咨询专家也会登记（`mode` 全为 `continuable`，区分不了咨询与实现）。把它们算进放行条件，
 *    「叫了专家评审、实现自己全干完」就会判 PASS —— 而那正是本工具要抓的形态。
 * ③ **人格检查（`dispatch.persona`）只进 `warnings`，不进 `verdict`。** 它回答的是「队友 prompt
 *    里有没有专家人格」，与「实现交给谁」正交：真实事故里三个队友命名全对、prompt 零 persona，
 *    判定本身没有问题（确实派了人），问题在「派的质量」。把它算进放行条件会让大批历史会话判违规
 *    （起名字容易、贴 persona 需要人主动做），闸门一上线就满地红灯、结论没人看。先让它可见。
 */
export function judge({ files = [], parentEdits = 0, childEdits = 0, dispatch = {}, attribution = null } = {}) {
  const fileCount = Array.isArray(files) ? files.length : 0
  const subagents = Number(dispatch.subagents) || 0

  // 人格检查只**追加 warning**，绝不进 verdict：判定只看 `dispatch.subagents`（见下方 ③）。
  // 三条短路（① ② ③ 与末尾 PASS）都要带上它 —— 「队友 prompt 里没人格」与「主会话改了几个
  // 文件」是两件正交的事，只在某一条分支里提示，换个场景就静默了（这正是这次事故的形态：
  // 命名全对、判定也 PASS，于是没人发现人格根本没进 prompt）。
  const personaWarning = buildPersonaWarning(dispatch)
  const withPersona = (warnings) => (personaWarning ? [...warnings, personaWarning] : warnings)

  // ① ② 先短路：主会话没改 / 只改一个文件，不涉及「有没有把实现交出去」。
  if (parentEdits === 0) {
    return { verdict: 'PASS', warnings: withPersona([]), summary: 'PASS：主会话没有 edit/write' }
  }
  if (fileCount <= 1) {
    return {
      verdict: 'PASS',
      warnings: withPersona([`单文件豁免生效（改动 ${parentEdits} 次但只落在 ${fileCount} 个文件上），不判违规`]),
      summary: `PASS：只改了 ${fileCount} 个文件，命中单文件豁免`,
    }
  }

  // ③ 多文件 + 主会话自己改：**唯一**的放行条件是「派过实现队友」。
  //    这条 if 里只允许出现 subagents。把 expertCalls / briefs / catalog 加进来，就等于
  //    把「叫了专家评审、代码自己全干完」判成 PASS —— 本工具存在的理由就是抓这种形态。
  if (subagents === 0) {
    const detail = violationDetail({ fileCount, parentEdits, dispatch })
    return {
      verdict: 'VIOLATION',
      warnings: withPersona([`${detail} —— 实现没有交出去（要么派实现队友 subagent，要么把改动合回单文件）`]),
      summary: `VIOLATION：${detail}`,
    }
  }

  // 派过实现队友：子会话日志缺失只影响归因精度，不代表没派人。
  const missing = attribution && Number(attribution.childLogsMissing) > 0
  const confidence = attribution ? attribution.confidence : 'high'
  const found = Number(attribution ? attribution.childLogsFound : 0) || 0
  const reason = `本轮派了 ${subagents} 次实现队友（${describeDispatch(dispatch)}）`
  const warnings = []

  if (confidence === 'low') {
    warnings.push(
      missing
        ? `${reason}，但子会话日志不可用，无法核实执行占比（归因降级，不构成违规）`
        : `${reason}，但没有一条能定位到子会话日志的登记（childId 缺失），无法核实执行占比（归因降级，不构成违规）`,
    )
  } else if (found > 0) {
    warnings.push(`${reason}；子会话日志可读，childEdits ${childEdits} 次（仅供参考，不参与判定）`)
  } else {
    warnings.push(`${reason}；本轮没有子会话日志需要归因`)
  }

  if (childEdits > 0 && childEdits < parentEdits) {
    warnings.push(
      `子会话里可读到的 edit 只有 ${childEdits} 次，少于主会话的 ${parentEdits} 次；日志可能不全，如需精确归因建议补齐子会话日志`,
    )
  }

  return {
    verdict: 'PASS',
    warnings: withPersona(warnings),
    summary: `PASS：${reason}；主会话跨 ${fileCount} 个文件改了 ${parentEdits} 次`,
  }
}

/** 人类可读报告。 */
export function renderHuman(report) {
  const lines = []
  lines.push('改动归属自检（dispatch-check）')
  lines.push('')
  lines.push(`会话      ${report.session.id || '(未知)'}`)
  lines.push(`目录      ${report.session.dir}`)
  // 选会话规则必须显式打出来：同一份报告用「按当前目录」还是「全盘最新」选出来的会话
  // 可能完全不同，读者不先知道这一点，就没法判断下面的结论对不对。
  const selection = describeSelection(report.session)
  if (selection) lines.push(`选会话    ${selection}`)
  if (report.session.cwd) lines.push(`cwd       ${report.session.cwd}`)
  if (report.session.delegationDepth) {
    const origin = report.session.origin ? `，origin=${report.session.origin}` : ''
    lines.push(`深度      delegationDepth ${report.session.delegationDepth}${origin}（判定按契约针对主会话，此值仅提示会话层级）`)
  }
  lines.push('')
  lines.push('统计')
  lines.push(`  files（去重文件数）  ${report.fileCount}`)
  lines.push(`  parentEdits          ${report.parentEdits}`)
  lines.push(`  childEdits           ${report.childEdits}`)

  // 旧字段 experts / subagents 只留在 JSON 里（experts 与 expertCalls 同值、subagents 是
  // 子会话登记数）；人类输出统一用下面两行，避免同一份报告出现两个互相矛盾的数字。
  //
  // 两行分开打印是**判据契约的一部分**：判定只看第一行（实现队友），第二行全是「咨询证据」。
  // 混成一行会让读者以为「叫了专家也算派活」，而上一版判据的失效恰恰来自这个混淆。
  const dispatch = report.dispatch || {
    subagents: 0,
    expertCalls: 0,
    briefs: 0,
    catalog: 0,
    persona: { checked: 0, missing: 0, samples: [] },
  }
  const attribution = report.attribution || { childLogsFound: 0, childLogsMissing: 0, confidence: 'high' }
  lines.push('')
  lines.push(`实现队友  subagent ${dispatch.subagents}`)
  lines.push(`咨询证据  专家 ${dispatch.expertCalls} / 任务书 ${dispatch.briefs} / 子会话登记 ${dispatch.catalog}`)
  // 人格注入这一行**不是判定的一部分**（判定只看上面第一行）；它在 checked=0（本轮没起队友）时
  // 不打印 —— 没队友就没有「队友 prompt 带不带人格」可言，印一行 0/0 只会让人以为检查出问题。
  const personaLine = describePersona(dispatch)
  if (personaLine) lines.push(personaLine)
  lines.push(
    `归因精度  ${attribution.confidence}（子会话日志：找到 ${attribution.childLogsFound} 个，缺 ${attribution.childLogsMissing} 个）`,
  )

  if (report.children.length > 0) {
    lines.push('')
    lines.push('子会话')
    for (const child of report.children) {
      const kind = child.label || child.name || child.id
      const state = child.found ? `改动 ${child.edits} 次` : '无可读日志'
      lines.push(`  - ${child.name || child.id}（${kind}）：${state}`)
    }
  }

  if (report.files.length > 0) {
    lines.push('')
    lines.push('改动文件')
    for (const file of report.files) lines.push(`  - ${file}`)
  }

  if (report.warnings.length > 0) {
    lines.push('')
    lines.push('warnings')
    for (const warning of report.warnings) lines.push(`  ! ${warning}`)
  }

  lines.push('')
  lines.push(`结论  ${report.summary}`)
  return lines.join('\n')
}

/**
 * 「选会话」那一行的文案：把 `session.selectedBy` 翻成人话。
 *
 * 这一行不是装饰：同一份报告里「按当前目录匹配」与「全盘最新」选出来的会话可能完全
 * 不同，读者必须先知道这次是哪种，才谈得上判断结论对不对。
 *
 * @returns {string|null} 未知取值返回 null（不打印，而不是印一句可能是错的说明）
 */
export function describeSelection(session = {}) {
  switch (session.selectedBy) {
    case 'implicit':
      return '按当前目录匹配（--any-cwd 可关）'
    case 'implicit-fallback':
      return '全盘最新（当前目录下没有会话，已退回全盘；--any-cwd 可直接关）'
    case 'any-cwd':
      return '全盘最新（--any-cwd）'
    case 'explicit':
      return '显式 --cwd 匹配'
    case 'dir':
      return '按 --session 提供的目录（不看当前目录）'
    case 'selector':
      return '按 --session 提供的 uuid（不看当前目录）'
    default:
      return null
  }
}

/** 供测试/库调用：跑一次分析并返回报告（不打印、不退出）。 */
export function inspect({ session = 'latest', cwd = null, anyCwd = false, root = sessionsRoot() } = {}) {
  const selector = session === undefined || session === null || session === '' ? 'latest' : String(session)
  const effective = effectiveCwd({ session: selector, cwd, anyCwd })
  const { dir, resolvedBy, cwdFallback } = resolveSession({
    session: selector,
    cwd: effective.cwd,
    root,
    // 只有「隐式默认 cwd」可以退回全盘；显式 --cwd 是硬筛（resolveSession 里会报错）。
    softCwd: effective.source === 'implicit',
  })

  // 退回全盘时不要写 cwdFilter：那一刻并没有按 cwd 筛过，写了就是假证据。
  const report = analyzeSession(dir, { cwd: cwdFallback ? null : effective.cwd })
  report.session.resolvedBy = resolvedBy
  report.session.cwdSource = effective.source
  report.session.selectedBy =
    resolvedBy === 'dir'
      ? 'dir'
      : cwdFallback
        ? 'implicit-fallback'
        : selector === 'latest'
          ? effective.source === 'explicit'
            ? 'explicit'
            : effective.source === 'any-cwd'
              ? 'any-cwd'
              : 'implicit'
          : effective.source === 'explicit'
            ? 'explicit'
            : 'selector'
  if (resolvedBy === 'prefix-ambiguous') {
    report.warnings.push('--session 的前缀匹配到多个会话，已取最新那个；给完整 uuid 可消除歧义')
  }
  if (cwdFallback) {
    report.warnings.push(
      `当前目录 ${effective.cwd} 下没有会话，已退回全盘最新（老行为）；要给别的目录就用 --cwd，要固定全盘就用 --any-cwd`,
    )
  }
  return report
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`dispatch-check: ${error.message}\n`)
    if (error.hint) process.stderr.write(`${error.hint}\n`)
    process.exitCode = EXIT.ERROR
    return
  }

  if (opts.help) {
    process.stdout.write(USAGE)
    process.exitCode = EXIT.PASS
    return
  }

  let report
  try {
    report = inspect({ session: opts.session, cwd: opts.cwd, anyCwd: opts.anyCwd })
  } catch (error) {
    process.stderr.write(`dispatch-check: ${error.message}\n`)
    if (error.hint) process.stderr.write(`${error.hint}\n`)
    process.exitCode = error.exitCode || EXIT.ERROR
    return
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderHuman(report)}\n`)
  }

  // 用 exitCode 而不是 exit()：管道输出时立刻退出可能截断 stdout。
  process.exitCode = report.verdict === 'VIOLATION' ? EXIT.VIOLATION : EXIT.PASS
}

// 只在被直接执行时跑 main；被 import 时（测试）保持纯函数。
const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) main(process.argv.slice(2))
