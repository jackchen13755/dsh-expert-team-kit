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
 * **2026-11 这一轮修掉的四个失效点**（每条都有红牙用例钉住，见 test/bin/dispatch-check.test.mjs）：
 * - 会话来源：缺省 `latest` 按 cwd+mtime 猜会话，实测钉错会话却全 exit 0。现在缺省读
 *   `DSH_SESSION_ID`（`--session current` / `--session-env <VAR>`），取不到 **exit 1**；
 *   `--session latest` 默认拒绝，只有 `--allow-latest` 才按老行为跑并打警告。
 * - 改动来源：`EDIT_TOOLS` 只有 edit/write，**bash 写文件完全不计**（60 份日志里 bash 1788 次
 *   vs edit 252 次）。现在解析 bash 命令串里的重定向/tee/sed -i/perl -i/git apply/patch，
 *   单列 `bashEdits`（`confidence: 'low'`）并计入 `fileCount`。
 * - 人格判据：旧 `PERSONA_MARKERS` 含裸「人格」子串，「不要贴人格正文」也判 true。现在走
 *   `lib/persona-check.mjs`：人格 `name` + 正文前 3 条非空行里至少 1 条（长度 >=30）原样出现。
 *   默认只 warning，`--persona-verdict` 才进 verdict。
 * - 归因松紧：新增 `--strict-attribution`（默认关）：主会话跨多文件改 >=2 次且子会话改动为 0
 *   判 VIOLATION；默认只 warning（因为 childEdits=0 多半是子会话日志没落盘）。
 *
 * 用法见下方 USAGE；零依赖，只用 Node 内置模块（含同仓 `lib/persona-check.mjs`）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BODY_LINE_LIMIT,
  MIN_BODY_LINE_LENGTH,
  loadPersonaCorpus,
  verifyPersonaPrompt,
} from '../lib/persona-check.mjs'

/** 退出码契约：CI 只认这三个值。 */
export const EXIT = { PASS: 0, ERROR: 1, VIOLATION: 2 }

/**
 * 计入「改动」的工具名。
 *
 * **只有 `edit` / `write`** —— `bash` 不在这里，它走 `BASH_TOOL` + `readBashWrites`：
 * bash 的「改没改文件」必须从命令串里尽力解析，解析结果与 edit/write 的**证据强度不同**
 * （`confidence: 'low'`），所以两条路分开统计、分开展示，不混成一个计数。
 */
const EDIT_TOOLS = new Set(['edit', 'write'])

/** 需要解析命令串来判断「有没有写文件」的工具名。 */
const BASH_TOOL = 'bash'

/** 计入「叫专家」的工具名。 */
const EXPERT_TOOLS = new Set(['summon_expert', 'summon_experts', 'summon_expert_team'])

/** 计入「起子 agent」的工具名（`spawn_teammate` 自 0.2.2-rc.2 起并入 `subagent`）。 */
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork'])

/** 计入「生成任务书」的工具名。 */
const BRIEF_TOOLS = new Set(['expert_brief'])

/** 子会话登记事件：出现在父日志里，出现即说明起过子会话。 */
const CATALOG_EVENT = 'subagent/catalog'

/**
 * 「队友 prompt 里有没有专家人格」的**旧版结构标记**（已降级，不再决定判定）。
 *
 * 历史问题（本次修复的第三个失效点）：这组标记里含一个裸「人格」子串，于是
 * 「…不要贴人格正文」这种**明确禁止贴正文**的句子也会判成「有人格」—— 判据对
 * 「提到」与「贴了」不区分，方向正好反了。
 *
 * 现在的判定走 `lib/persona-check.mjs` 的 `verifyPersonaPrompt`（人格 name + 正文行原样出现）。
 * 这个导出**保留**（外部消费者可能 import），但只作为「结构上像不像人格正文」的弱信号，
 * 且已去掉裸「人格」。**不要再拿它当判定依据。**
 */
export const PERSONA_MARKERS = ['You are **', 'Agent Personality', 'Core Mission', 'Critical Rules', 'Identity']

/**
 * 人格正文的 Markdown 标题形态，如 `# Code Reviewer Agent`。
 *
 * 与 `PERSONA_MARKERS` 一样是**旧判据的遗留导出**（外部消费者可能 import），不再参与判定：
 * 它只能证明「贴了个像人格的标题」，证明不了「贴的是哪一位、正文有没有进来」。
 */
export const PERSONA_HEADING_RE = /#\s+\w[\w ]*Agent\b/

/** `samples` 最多留几个队友名（只是给人看的线索，不承担准确性）。 */
export const PERSONA_SAMPLE_LIMIT = 5

/**
 * 这段 prompt 文本里有没有**那位专家**的人格。
 *
 * 判据见 `lib/persona-check.mjs`：必须同时命中某人格 frontmatter 的 `name` 值与
 * 该人格正文前 3 条非空行里至少 1 条（长度 >= 30）的**原样**文本。
 * 只提到名字不算（真实事故里名字恰恰是对的，正文一个字节都没有）。
 *
 * `personas` 缺失/为空时返回 `false` —— 但那是「没法判」，调用方（`countDispatch`）
 * 会把它记成 `unavailable` 并跳过计数，**不能**当成「检查过且没人格」。
 *
 * @param {unknown} prompt
 * @param {{personas?: {name: string, bodyLines?: string[]}[]}} [options]
 * @returns {boolean}
 */
export function hasPersona(prompt, { personas } = {}) {
  return verifyPersonaPrompt(prompt, { personas }).ok
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
  dispatch-check [--session <dir|id|latest>] [--cwd <路径>] [--any-cwd]
                 [--session current] [--session-env <变量名>] [--allow-latest]
                 [--persona-root <目录>] [--persona-verdict]
                 [--strict-attribution] [--json] [--help]

读 DSH 会话日志，统计本轮的 edit/write（以及 bash 里的写文件操作）由谁执行
（主会话 vs 子 agent），给出 PASS / VIOLATION 结论。只读，不修改任何会话文件。

判据只看「主会话自己改了多少 / 跨几个文件」＋「有没有派过实现队友」（只看 subagent /
subagent_fork）。子会话日志读不到时只降低归因精度，不构成违规 —— 实测子会话
日志大多不落盘，拿它当否决判据会把「代码确实是子 agent 写的」误判成违规。
叫专家（summon_expert*）与生成任务书（expert_brief）只是**咨询证据**，不算派过实现；
子会话登记（subagent/catalog）含咨询专家，同样不算。

选项：
  --session <dir|id|latest>  会话目录路径、session uuid（支持前缀）或 latest
                             缺省：从环境变量取会话 id（见下「选会话规则」）
  --session current          显式要求「用环境变量里的会话 id」（与缺省同义，写出来更明确）
  --session-env <变量名>     换一个环境变量名来取会话 id（缺省 DSH_SESSION_ID）
  --allow-latest             允许 --session latest 按老行为跑（**会钉错会话**，仅逃生用；
                             打印 stderr 警告）
  --cwd <路径>               只在这些 cwd 匹配的 workspace 里找会话（硬筛，匹配不到退出 1）
  --any-cwd                  --session latest --allow-latest 时忽略当前目录，回到「全盘最新」
                             的旧行为（按 mtime 取，逃生口）
  --persona-root <目录>      人格清单根目录（缺省扫专家插件 assets/agency-agents）
  --persona-verdict          把「队友 prompt 缺专家人格」也算进 verdict（缺则 VIOLATION）
  --strict-attribution       开启严格归因：主会话跨多个文件改 >=2 次、而子会话改动为 0 时判
                             VIOLATION（缺省只 warning）
  --json                     只输出一份 JSON（便于脚本消费）
  -h, --help                 打印本用法并退出 0

选会话规则：
  1. 显式 --session <目录|uuid|uuid 前缀> 一律按你给的选（最确定，推荐）。
  2. 显式 --session current 或**缺省**：从环境变量（缺省 DSH_SESSION_ID，可用
     --session-env 换名）取会话 id。**取不到就退出 1，绝不回退 latest** —— 回退会
     静默检查错会话（实测 26 次 verify 全部 exit 0，钉的都不是当前会话）。
  3. --session latest：仍解析，但**默认退出 1** 并说明它会钉错会话。要按老行为跑必须
     同时给 --allow-latest（会在 stderr 打警告）。老行为把 --cwd 缺省当成当前目录
     （process.cwd()），并用 --any-cwd 关掉这一默认。

退出码：
  0   PASS       主会话没改，或只改单文件，或本轮确实派过实现队友（subagent/subagent_fork）
  2   VIOLATION  跨多个文件的主会话改动，且本轮 subagent 0 次（只叫专家 / 只写任务书 /
                 只有子会话登记都不算）；--strict-attribution / --persona-verdict 会额外加判据
  1   错误       找不到会话 / 取不到会话 id / 参数错 / 日志不可读

环境变量：
  DSH_SESSIONS_DIR  会话根目录，缺省 ~/.dsh/sessions（测试与多 DSH_HOME 场景用）
  DSH_SESSION_ID    当前会话 id（--session 缺省与 --session current 读它；可用 --session-env 换名）
  DSH_PERSONA_ROOT  人格清单根目录（等价 --persona-root）

示例：
  dispatch-check                                   # 用 DSH_SESSION_ID
  dispatch-check --session current --json
  dispatch-check --session-env MY_SESSION_ID
  dispatch-check --session ebab78bb --json          # uuid 前缀
  dispatch-check --session ~/.dsh/sessions/--x--/session-<uuid>
  dispatch-check --session latest --allow-latest --any-cwd   # 老行为逃生口
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
 * `session` 的缺省值是 **null**（＝「从环境变量取会话 id」），不是 `'latest'`。
 * 这个改动是本次修复的核心之一：缺省 `latest` 会按 cwd+mtime 猜会话，实测钉错会话
 * （26 次 oracle 执行全 exit 0，检查的根本不是当前会话）。null 表示「用户没指名」，
 * 由 `resolveSelector` 决定去读环境变量，读不到就报错，绝不猜。
 *
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {{session: string|null, cwd: string|null, anyCwd: boolean, json: boolean, help: boolean, allowLatest: boolean, sessionEnv: string|null, personaRoot: string|null, personaVerdict: boolean, strictAttribution: boolean}}
 * @throws {CliError} 未知参数 / 选项缺值
 */
export function parseArgs(argv) {
  const opts = {
    session: null,
    cwd: null,
    anyCwd: false,
    json: false,
    help: false,
    allowLatest: false,
    sessionEnv: null,
    personaRoot: null,
    personaVerdict: false,
    strictAttribution: false,
  }
  const list = Array.isArray(argv) ? argv : []

  // `--help` 先整体扫描一遍再逐项解析：像 `--session --help` 这种「想看用法」的输入
  // 不应先被「--session 缺少取值」打断（与同仓库 expert-brief 的约定一致）。
  if (list.includes('-h') || list.includes('--help')) {
    opts.help = true
    return opts
  }

  /** 取下一个参数作为取值；缺值/取值像另一个选项都报错（`--cwd --json` 不能把 --json 当路径）。 */
  const takeValue = (flag, index) => {
    const value = list[index + 1]
    if (value === undefined || value === '' || value.startsWith('-')) {
      throw new CliError(`选项 ${flag} 缺少取值`, `改成 ${flag} <值>，或先跑 dispatch-check --help 看用法`)
    }
    return value
  }

  const BOOLEAN_FLAGS = {
    '--json': 'json',
    '--any-cwd': 'anyCwd',
    '--allow-latest': 'allowLatest',
    '--persona-verdict': 'personaVerdict',
    '--strict-attribution': 'strictAttribution',
  }

  const VALUE_FLAGS = {
    '--session': 'session',
    '--cwd': 'cwd',
    '--session-env': 'sessionEnv',
    '--persona-root': 'personaRoot',
  }

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]

    if (arg === '-h' || arg === '--help') {
      opts.help = true
      return opts
    }
    if (Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, arg)) {
      opts[BOOLEAN_FLAGS[arg]] = true
      continue
    }

    // 同时接受 `--flag value` 与 `--flag=value` 两种写法。
    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, arg)) {
      opts[VALUE_FLAGS[arg]] = takeValue(arg, i)
      i += 1
      continue
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const at = arg.indexOf('=')
      const flag = arg.slice(0, at)
      const value = arg.slice(at + 1)
      if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, flag)) {
        if (value === '') throw new CliError(`选项 ${flag} 缺少取值`, `改成 ${flag} <值>，或先跑 dispatch-check --help 看用法`)
        opts[VALUE_FLAGS[flag]] = value
        continue
      }
    }

    throw new CliError(
      `未知参数：${arg}`,
      '可用参数只有 --session / --session-env / --cwd / --any-cwd / --allow-latest / --persona-root / --persona-verdict / --strict-attribution / --json / --help；跑 --help 看用法',
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

/** 取「当前会话 id」的缺省环境变量名（`--session current` 与 `--session` 缺省都读它）。 */
export const SESSION_ENV_VAR = 'DSH_SESSION_ID'

/**
 * 把「用户怎么指定会话」解析成一个真正的选择器。
 *
 * 这一步是本次修复的**核心**：老版把 `--session` 的缺省值写成 `latest`，于是不指定会话时
 * 就按 cwd+mtime 猜，实测会钉错会话（26 次 oracle 执行全部 exit 0，检查的根本不是当前会话）。
 * 现在缺省是「读环境变量给你当前会话 id」，读不到就 **exit 1**，绝不回退 latest。
 *
 * 三种输入：
 * - `null` / 空串 / `current` / `env`：读环境变量（名可用 `--session-env` 换），空值报错；
 * - `latest`：**默认拒绝**（提示会钉错会话），只有 `--allow-latest` 才放行并标 `latest-allowed`；
 * - 其它：原样当目录/uuid 前缀，语义与老版一致。
 *
 * @param {{session?: string|null, sessionEnv?: string|null, allowLatest?: boolean, env?: Record<string,string|undefined>}} [options]
 * @returns {{session: string, source: 'env'|'explicit'|'latest-allowed', envName: string}}
 * @throws {CliError} 环境变量取不到 / 环境变量值是 latest / latest 未获放行
 */
export function resolveSelector({ session = null, sessionEnv = null, allowLatest = false, env = process.env } = {}) {
  const envName = typeof sessionEnv === 'string' && sessionEnv.trim() !== '' ? sessionEnv.trim() : SESSION_ENV_VAR
  const raw = session === undefined || session === null ? null : String(session).trim()

  if (raw === 'latest') {
    if (allowLatest) return { session: 'latest', source: 'latest-allowed', envName }
    throw new CliError(
      '--session latest 会按 cwd+mtime 猜会话，实测钉错过会话（检查的不是当前会话却 exit 0），已默认拒绝',
      '改成 --session current（读环境变量里的会话 id）或 --session <uuid|会话目录>；确认就是要看「最近一次会话」再加 --allow-latest',
    )
  }

  if (raw === null || raw === '' || raw === 'current' || raw === 'env') {
    const value = env && env[envName] !== undefined && env[envName] !== null ? String(env[envName]).trim() : ''
    if (value === '') {
      throw new CliError(
        `取不到当前会话 id：环境变量 ${envName} 未设置或为空（--session 缺省与 --session current 都读它）`,
        `三种办法：① 在 DSH 会话里跑（宿主会注入 ${envName}）；② 显式 --session <uuid|会话目录>；③ --session-env <变量名> 指定别的变量名`,
      )
    }
    if (value === 'latest') {
      throw new CliError(
        `环境变量 ${envName} 的值是 latest，不是会话 id（会重新掉进「猜会话」的坑）`,
        `把它设成真实会话 uuid，或显式 --session <uuid|会话目录>`,
      )
    }
    return { session: value, source: 'env', envName }
  }

  return { session: raw, source: 'explicit', envName }
}

/** 目录不存在时返回 []，绝不抛（缺目录是「没有会话」，不是「出错」）。 */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 目录名看起来像一个会话 id（uuid，含任意位置的重叠 uuid 前缀）。 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 一个 workspace 目录下的所有会话目录。
 *
 * **两种真实布局都要认**（实测同一个 sessions 根下同时存在，且新布局占多数）：
 * - 老布局：`session-<uuid>`（本机 101 个）
 * - 新布局：裸 `<uuid>`（本机 285 个，当前正在写的会话就是这种）
 *
 * 老实现只认 `session-` 前缀，后果是 `--session <uuid>` 对**正在跑的会话**永远找不到
 * （它的目录是裸 uuid），`latest` 也只能看见老布局 —— 「按会话 id 定位」这件事根本没生效。
 */
function sessionDirsIn(workspaceDir) {
  return safeReaddir(workspaceDir)
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith('session-') || SESSION_ID_RE.test(entry.name) || resolveLogFile(path.join(workspaceDir, entry.name)) !== null),
    )
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
 * 从一条 `bash` 的 `tool/call` 里取命令串。
 *
 * `arguments` 是 JSON 字符串，字段名可能是 `command`（真机）或 `cmd`（旧/别名形态），
 * 两个都认。任何异常返回 `{ ok: false, reason }`，绝不抛。
 *
 * @returns {{ok: true, command: string} | {ok: false, reason: string}}
 */
export function readBashCommand(event) {
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

  const command = typeof parsed.command === 'string' ? parsed.command : typeof parsed.cmd === 'string' ? parsed.cmd : null
  if (command === null) {
    return { ok: false, reason: `缺少 command（${parsed.command === undefined ? 'undefined' : typeof parsed.command}）` }
  }
  return { ok: true, command }
}

/** 重定向目标里这些不是「文件」：`/dev/null`、`&1`、`&2`、`/dev/stdout` 等。 */
const NON_FILE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '&1', '&2', '-'])

/** 一个写操作（bash 解析出来的，证据强度低 —— 只是「命令串里看起来在写这个文件」）。 */
export const BASH_WRITE_KINDS = /** @type {const} */ (['redirect', 'tee', 'sed-in-place', 'perl-in-place', 'git-apply', 'patch'])

/** `sed` / `perl` 的原地修改标志：`-i`、`-i.bak`、`-Ei`、`-pi` 等。 */
const IN_PLACE_RE = /(?:^|\s)-[a-zA-Z]*i(?:\.\S+)?(?:\s|$)/

/** 从一段命令里挑出「最后一个不含引号、不像重定向的 token」当作目标路径。 */
function lastPathToken(segment) {
  const tokens = segment.match(/(?:'[^']*'|"[^"]*"|\S+)/g) || []
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i].replace(/^['"]|['"]$/g, '')
    if (token === '' || token.startsWith('-') || token.startsWith('&') || /^[0-9]*[<>]/.test(token)) continue
    if (NON_FILE_TARGETS.has(token)) continue
    return token
  }
  return null
}

/**
 * 按 shell 分隔符切段，但**跳过引号内部**的分隔符。
 *
 * 只处理 `'` 与 `"` 两种引号与反斜杠转义；heredoc / 命令替换不做特判（够了 ——
 * 我们只需要「不要把引号里的 `|` 当管道」这一件事）。
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitShellSegments(command) {
  const text = typeof command === 'string' ? command : ''
  const segments = []
  let current = ''
  let quote = null

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (quote) {
      current += char
      if (char === '\\' && i + 1 < text.length) {
        current += text[i + 1]
        i += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }

    if (char === '\\' && i + 1 < text.length) {
      current += char + text[i + 1]
      i += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === '&' && text[i + 1] === '&') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === '|') {
      if (text[i + 1] === '|') i += 1
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }

  segments.push(current)
  return segments
}

/** 像路径的字符集（ASCII，不含空白/引号/CJK/括号/反引号）。 */
const PATH_SHAPE_RE = /^[\w@%+.,:/~^$\-]+$/

/**
 * 这个 token 像不像一个「文件路径」。
 *
 * 为什么必须卡这一道：命令串里到处是 `>= 30`、`2>&1`、`a > b` 这类**不是重定向**的 `>`。
 * 不卡的话，`>= 30` 会被读成「把内容写进 `=30`」，报告里立刻多出一堆垃圾路径（真实跑过一次：
 * 60 条 bashEdits 里大半是 `=30`、`0)`、`是**读**操作`）—— 那比不检测更糟，因为读者会
 * 以为工具在瞎报。
 *
 * 判据：ASCII 路径字符集 + 不是纯数字/纯符号 + （含 `/` 或带扩展名）。
 */
export function looksLikePath(target) {
  if (typeof target !== 'string' || target === '') return false
  if (!PATH_SHAPE_RE.test(target)) return false
  if (/^\d+$/.test(target)) return false
  if (/^[=+\-]+$/.test(target)) return false
  return target.includes('/') || /\.[A-Za-z0-9]+$/.test(target)
}

/** argv 类目标（tee / sed -i / git apply / patch）的宽松校验：只要不是空白、CJK、选项即可。 */
function looksLikeArgvPath(target) {
  if (typeof target !== 'string' || target === '') return false
  if (/^[=-]+$/.test(target)) return false
  return PATH_SHAPE_RE.test(target)
}

/**
 * 从一段 bash 命令串里**尽力**解析出写操作与目标路径。
 *
 * 为什么「尽力」就够：bash 能写文件的方式无穷（`python -c`、`node -e`、`xxd -r`…），
 * 想要完备是不可能的。这里只覆盖工位上真正高频的 6 类（见 `BASH_WRITE_KINDS`），
 * 并把结论标成 `confidence: 'low'` —— 它用于**提高可见性**，不用于精确判定。
 * 解析不出路径的写操作会计进 `unparsed`，由调用方写进 warning（不能静默丢）。
 *
 * 明确不认的形态（免得把自己骗了）：
 * - 引号里的 `>` 是数据不是重定向 —— 先按引号切 token 再判断；
 * - `2>&1` / `>/dev/null` 不是写文件；
 * - `--dry-run` 之类的 flag 不作特殊处理（宁可多算一次，不静默少算）。
 *
 * @param {unknown} command
 * @returns {{writes: {path: string, kind: string}[], unparsed: number, isWrite: boolean}}
 */
export function extractBashWrites(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { writes: [], unparsed: 0, isWrite: false }
  }

  const writes = []
  let unparsed = 0
  /**
   * 记一处写操作。
   * - `missingTarget`：命令确实在写，但取不到目标（如行尾 `> `）→ 计 unparsed，留 warning；
   * - 目标存在但不像路径（`2>&1`、`>=`、引号里的 `a > b`）→ 当作**不是**写文件，静默跳过。
   *   这一条很重要：把 `>=` 当写操作会在报告里造垃圾路径，噪声会让人不再看报告。
   */
  const add = (target, kind, { strictShape = true } = {}) => {
    if (!target) {
      unparsed += 1
      return
    }
    if (NON_FILE_TARGETS.has(target)) return
    const ok = strictShape ? looksLikePath(target) : looksLikeArgvPath(target)
    if (!ok) return
    writes.push({ path: target, kind })
  }

  // 按 shell 分隔符切段：`&&`、`||`、`;`、`|`、换行。管道两侧各算一段，
  // `tee` 正好出现在管道右侧。切段后再判重定向，避免跨段串味。
  //
  // **必须引号安全**：`sed -i "s|a|b|" f.ts` 里的 `|` 是 sed 的分隔符，不是管道。
  // 按字符朴素切分的话它会切成 `sed -i "s` / `a` / `b"` / `f.ts`，前一段就会被当成
  // 「sed 原地改文件 s」—— 又一个垃圾路径（真机踩过一次）。
  const segments = splitShellSegments(command)

  /** 引号安全的 token 化：`"a b"` 算一个 token。 */
  const tokenize = (text) => text.match(/(?:'[^']*'|"[^"]*"|\S+)/g) || []
  const unquote = (token) => token.replace(/^['"]|['"]$/g, '')

  for (const segment of segments) {
    const text = segment.trim()
    if (text === '') continue
    const tokens = tokenize(text)

    // ① 重定向：`> f` / `>> f` / `2> f` / `1>f`。`>&2`、`2>&1`、`>/dev/null` 不算写文件。
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]
      const inline = /^\d*(?:>>?|&>)(.*)$/.exec(token)
      if (!inline) continue

      const rest = unquote(inline[1])
      if (rest.startsWith('&')) continue // `2>&1` / `>&2`：目标不是文件
      if (rest.startsWith('=')) continue // `>=` / `>>=`：比较运算符，不是重定向
      if (rest !== '') {
        add(rest, 'redirect') // `>f` / `2>f`
        continue
      }
      const next = tokens[i + 1] === undefined ? null : unquote(tokens[i + 1])
      if (next === null) unparsed += 1 // `> ` 后面没东西：写操作存在但目标不明
      else add(next, 'redirect') // `> f`
    }

    const first = unquote(tokens[0] || '')

    // ② tee（可选 -a）
    if (first === 'tee') {
      add(lastPathToken(text), 'tee', { strictShape: false })
      continue
    }

    // ③ sed -i / perl -i：目标通常是最后一个路径参数
    if ((first === 'sed' || first === 'perl') && IN_PLACE_RE.test(text)) {
      const target = lastPathToken(text)
      add(target && target !== first ? target : null, first === 'sed' ? 'sed-in-place' : 'perl-in-place')
      continue
    }

    // ④ git apply <patch>
    if (first === 'git' && /^\s*git\s+apply\b/.test(text)) {
      add(lastPathToken(text.replace(/^\s*git\s+apply\b/, '')), 'git-apply')
      continue
    }

    // ⑤ patch -p<N> [file]
    if (first === 'patch' && /(?:^|\s)-p\s*\d/.test(text)) {
      const target = lastPathToken(text)
      add(target && target !== first ? target : null, 'patch')
      continue
    }
  }

  return { writes, unparsed, isWrite: writes.length > 0 || unparsed > 0 }
}

/**
 * 统计一个会话事件流里的 edit/write（以及 bash 里的写文件操作）。
 *
 * `bashEdits` / `bashFiles` 与 `edits` / `files` **分开返回**：前者的证据强度是
 * `confidence: 'low'`（从命令串猜的），后者是结构化的 `file_path`。混成一个数字，
 * 报告里就再也分不清「真的调了 edit」和「命令里看起来像写了个文件」。
 *
 * @returns {{edits: number, files: string[], experts: number, bashEdits: number, bashFiles: string[], bashWrites: {path: string, kind: string}[], warnings: string[]}}
 */
export function countCalls(events, scope = '主会话') {
  const files = []
  const bashFiles = []
  const bashWrites = []
  const warnings = []
  let edits = 0
  let experts = 0
  let bashEdits = 0

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
    if (name === BASH_TOOL) {
      const read = readBashCommand(event)
      if (!read.ok) {
        // bash 解析不出命令串不影响 edit 结论；但「有一次 bash 不知道写了什么」必须留痕，
        // 否则结论看起来比实际更确定（这是本工具最要避免的静默形态）。
        warnings.push(`${scope}有一次 bash 调用无法解析（${read.reason}），其中的写文件操作未计入`)
        continue
      }
      const parsed = extractBashWrites(read.command)
      if (parsed.writes.length === 0 && parsed.unparsed === 0) continue
      bashEdits += parsed.writes.length
      for (const write of parsed.writes) {
        bashFiles.push(write.path)
        bashWrites.push(write)
      }
      if (parsed.writes.length > 0) {
        warnings.push(
          `${scope}有 ${parsed.writes.length} 处 bash 写文件操作（confidence: low，从命令串解析）：` +
            `${parsed.writes.map((write) => `${write.kind} ${write.path}`).join('、')}`,
        )
      }
      if (parsed.unparsed > 0) {
        warnings.push(
          `${scope}有 ${parsed.unparsed} 处 bash 写操作识别不出目标路径（如管道/变量拼接），未计入改动文件`,
        )
      }
      continue
    }
    if (EXPERT_TOOLS.has(name)) experts += 1
  }

  return { edits, files, experts, bashEdits, bashFiles, bashWrites, warnings }
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
 * @param {{personas?: {name: string, bodyLines?: string[]}[], personaUnavailableReason?: string|null, diagnostics?: {personaUnavailable?: string|null}}} [options]
 *   `personas` 是人格清单（来自 `loadPersonaCorpus`）。**清单不可用时不计数**，只记 warning 并
 *   在 `persona.unavailable` 里留原因 —— 「扫不到清单」与「队友没带人格」是两件事，
 *   混为一谈会让一批会话凭空多出一堆「缺人格」结论。
 * @returns {{subagents: number, expertCalls: number, briefs: number, catalog: number, persona: {checked: number, missing: number, samples: string[], unavailable: string|null}}}
 */
export function countDispatch(events, warnings = [], { personas = [], personaUnavailableReason = null, diagnostics = null } = {}) {
  const dispatch = {
    subagents: 0,
    expertCalls: 0,
    briefs: 0,
    catalog: 0,
    persona: { checked: 0, missing: 0, samples: [] },
  }
  const canCheckPersona = Array.isArray(personas) && personas.length > 0
  // `unavailable` 只在真出现「需要判却判不了」时才有值（见下方 subagent 分支）。
  let personaUnavailable = null

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
      if (!canCheckPersona) {
        // 清单不可用：不能计 checked（等于编造「检查过」），也不能算 missing（等于编造「没人格」）。
        personaUnavailable = personaUnavailableReason || '人格清单不可用（为空或未提供）'
        continue
      }
      const verdict = verifyPersonaPrompt(read.prompt, { personas })
      if (verdict.unavailable) {
        personaUnavailable = verdict.reason
        continue
      }
      dispatch.persona.checked += 1
      if (!verdict.ok) {
        dispatch.persona.missing += 1
        if (dispatch.persona.samples.length < PERSONA_SAMPLE_LIMIT) {
          dispatch.persona.samples.push(read.name || `(未命名队友 #${dispatch.persona.checked})`)
        }
      }
    } else if (EXPERT_TOOLS.has(name)) dispatch.expertCalls += 1
    else if (BRIEF_TOOLS.has(name)) dispatch.briefs += 1
  }

  if (personaUnavailable) {
    warnings.push(`人格检查未执行：${personaUnavailable}—— 这一项不参与判定，也不代表队友没带人格`)
  }
  // `unavailable` 走 `diagnostics` 传出，**不挂到 dispatch 上**：`dispatch` 的字段是既有契约
  // （测试与外部脚本按全等比较），多一个键就会静默破坏它们。
  if (diagnostics && typeof diagnostics === 'object') diagnostics.personaUnavailable = personaUnavailable

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
    `  - 不给 --session 时读环境变量 ${SESSION_ENV_VAR}（DSH 会话里通常已注入）；取不到会报错而不是猜`,
    '  - 用 --session <uuid> 或 uuid 前缀（两种目录布局 session-<uuid> / <uuid> 都认）',
    '  - 用 --session <会话目录绝对路径> 直接指定',
    '  - 确实要看「最近一次会话」：--session latest --allow-latest（会按 cwd+mtime 猜，可能选错）',
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

  // 选择器去掉可选的 `session-` 前缀后是「会话 id 前缀」，两种目录名都要匹配得上。
  const wantedId = selector.startsWith('session-') ? selector.slice('session-'.length) : selector
  const matched = candidates.filter((dir) => {
    const base = path.basename(dir)
    const id = base.startsWith('session-') ? base.slice('session-'.length) : base
    return id.startsWith(wantedId)
  })
  if (matched.length === 0) {
    throw new CliError(hintForMissingSession(root, selector), null)
  }

  const dir = newestDir(matched)
  return { dir, resolvedBy: matched.length > 1 ? 'prefix-ambiguous' : 'prefix', cwdFallback }
}

/**
 * 明显不是「仓库里的改动」的路径：临时目录与日志。
 *
 * 为什么必须排除：bash 里 `npm test > /tmp/out.log`、`cmd 2>&1 | tee /tmp/x.log` 是**读**操作
 * 的常见写法。把它们算成「改了 2 个文件」，默认判据（files >= 2 && subagents === 0）立刻误报。
 * 排除项不静默丢：计入 `bashEdits.scratchExcluded` 并在报告里说明。
 */
const SCRATCH_PREFIXES = [os.tmpdir()]

/** 这个 bash 写目标算不算「仓库里的改动」（临时目录/日志不算）。 */
export function isScratchTarget(target) {
  if (typeof target !== 'string' || target === '') return true
  const resolved = target.startsWith('~') ? path.join(os.homedir(), target.slice(1).replace(/^[/\\]/, '')) : target
  const normalized = path.isAbsolute(resolved) ? resolved : path.resolve(resolved)
  for (const prefix of SCRATCH_PREFIXES) {
    if (prefix && normalized.startsWith(prefix)) return true
  }
  return normalized.startsWith('/tmp/') || normalized.startsWith('/var/folders/') || normalized.startsWith('/dev/')
}

/**
 * 核心分析：父会话 + 所有子会话 → 统计与结论。
 *
 * 子会话关联靠父日志里的 `subagent/catalog`（`childId`），目录是同 workspace 下的
 * `session-<childId>`。同一 childId 可能被登记多次（持久子 agent 反复出现），读取时按 id 去重，
 * 但 `subagents` 计数仍按事件数（契约如此）。
 *
 * @param {string} sessionDir
 * @param {{cwd?: string|null, personas?: {name: string, bodyLines?: string[]}[], personaUnavailableReason?: string|null, personaVerdict?: boolean, strictAttribution?: boolean, judgeOptions?: object}} [options]
 *   `personas` 不传时人格检查**不执行**（记 warning，不计 checked）—— 调用方（`inspect`）
 *   负责先用 `loadPersonaCorpus` 扫清单。这样纯函数层不碰磁盘，测试可以直接喂清单。
 */
export function analyzeSession(
  sessionDir,
  {
    cwd = null,
    personas = undefined,
    personaRoot = null,
    personaUnavailableReason = null,
    personaVerdict = false,
    strictAttribution = false,
    env = process.env,
  } = {},
) {
  const parentRead = readSessionEvents(sessionDir)
  const meta = readSessionMeta(parentRead.events)
  const warnings = []

  if (parentRead.badLines > 0) {
    warnings.push(`主会话日志有 ${parentRead.badLines} 行不是合法 JSON，已跳过`)
  }

  const parentStats = countCalls(parentRead.events, '主会话')
  warnings.push(...parentStats.warnings)

  // 人格清单**按需扫描**：本轮没有 subagent 调用就没有「队友 prompt」要判，扫 300+ 份 md
  // 纯属浪费（本工具挂进 verify，每个会话跑一次）。有 subagent 才真的去扫。
  let personaList = Array.isArray(personas) ? personas : null
  let personaGap = personaUnavailableReason
  if (personaList === null) {
    const needsPersona = parentRead.events.some(
      (event) =>
        event && event.type === 'tool/call' && event.data && typeof event.data.name === 'string' && SUBAGENT_TOOLS.has(event.data.name),
    )
    if (needsPersona) {
      const corpus = loadPersonaCorpus({ root: personaRoot === null ? null : personaRoot, env })
      if (corpus.ok) {
        personaList = corpus.personas
        warnings.push(...corpus.warnings)
        warnings.push(`人格清单：${corpus.personas.length} 位（扫描 ${corpus.root}）`)
      } else {
        personaList = []
        personaGap = corpus.reason
        warnings.push(...corpus.warnings)
      }
    } else {
      personaList = []
    }
  }

  // 派活计数：全部来自父日志，**不依赖子会话日志是否落盘**（后者实测大多缺失）。
  // 四项里只有 subagents 能当「派过实现」的证据，其余三项只作咨询证据（见 countDispatch 注释）。
  // 传 warnings 进去：人格检查要读 `arguments.prompt`，解析失败要留痕（但不计入 checked）。
  const diagnostics = { personaUnavailable: null }
  const dispatch = countDispatch(parentRead.events, warnings, {
    personas: personaList || [],
    personaUnavailableReason: personaGap,
    diagnostics,
  })
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
  let childBashEdits = 0
  const allFiles = [...parentStats.files]
  const allBashWrites = parentStats.bashWrites.map((write) => ({ ...write, scope: '主会话' }))

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
        childBashEdits += childStats.bashEdits
        allFiles.push(...childStats.files)
        allBashWrites.push(...childStats.bashWrites.map((write) => ({ ...write, scope: `子会话 ${label}`.trim() })))
        found = true
      } catch (error) {
        // 子会话日志读不出来不影响主结论：如实记 warning，childEdits 保持已统计到的值。
        warnings.push(`子会话 ${label} 的日志读取失败（${error.message}），其改动无法计入、执行占比无法归因`)
      }
    }

    childEdits += edits
    children.push({ id: childId, name: catalog.name || null, label: catalog.label || null, dir: childDir, found, edits })
  }

  // bash 写文件：单列、标 confidence low；只有「看起来在仓库里」的目标才并入 files
  // （临时目录/日志是读操作的常见写法，并进去会让默认判据误报 —— 见 isScratchTarget）。
  const bashWrites = allBashWrites.map((write) => ({ ...write, counted: !isScratchTarget(write.path) }))
  const bashFiles = [...new Set(bashWrites.filter((write) => write.counted).map((write) => write.path))]
  const scratchExcluded = bashWrites.filter((write) => !write.counted).length
  if (scratchExcluded > 0) {
    warnings.push(
      `有 ${scratchExcluded} 处 bash 写操作落在临时目录/日志上（如 > /tmp/x.log），未计入改动文件：` +
        `${bashWrites
          .filter((write) => !write.counted)
          .map((write) => write.path)
          .join('、')}`,
    )
  }
  const bashEdits = {
    count: parentStats.bashEdits + childBashEdits,
    parent: parentStats.bashEdits,
    child: childBashEdits,
    confidence: 'low',
    scratchExcluded,
    writes: bashWrites,
  }

  const files = [...new Set([...allFiles, ...bashFiles])]

  const attribution = summarizeAttribution({ children, dispatch })
  const judgment = judge({
    files,
    parentEdits: parentStats.edits,
    parentBashEdits: parentStats.bashEdits,
    childEdits,
    dispatch,
    attribution,
    personaUnavailable: diagnostics.personaUnavailable,
    personaVerdict,
    strictAttribution,
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
    bashEdits,
    bashFiles,
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
 * 判定规则（**从上到下命中即停**，顺序就是代码顺序，改顺序 = 改判据）：
 *
 *   ⓪ `personaVerdict && dispatch.persona.missing > 0` → VIOLATION
 *      （仅 `--persona-verdict` 时存在；它先于文件数判定：没改几个文件不能豁免「队友没带人格」）
 *   ① `parentEdits === 0` → PASS（主会话没 edit/write）
 *   ② `files.length <= 1` → PASS（单文件豁免）
 *   ③ `files.length >= 2 && parentEdits > 0 && subagents === 0` → VIOLATION
 *      （文案按「只叫了咨询」/「什么都没叫」/「只有子会话登记」分开写，见 violationDetail）
 *   ④ `strictAttribution && parentEdits >= 2 && files.length >= 2 && childEdits === 0` → VIOLATION
 *      （放在 ③ 之后：③ 是更具体的诊断，先判它，违规文案才不会丢掉「只叫了专家」那句原因）
 *   ⑤ 其余（真派了实现队友）→ PASS
 *
 * ④ 未开启时，同一条件会被写成一条 warning（可见但不拦）—— 否则开关等于没人知道。
 *
 * **四条硬约束（前两条是核心，后两条是本次新增判据的边界）：**
 * ① **VIOLATION 条件里不得出现 `childEdits`。** 实测子会话日志大多不落盘，拿它当否决判据会把
 *    「723 行代码确实由子 agent 写」误判成「子 agent 改 0 次」。`childEdits` 仍然收、仍然输出，
 *    但只用于归因说明（配合 `attribution.confidence`）。
 * ② **VIOLATION 条件里也不得出现 `expertCalls` / `briefs` / `catalog`。** 这三项是**咨询证据**：
 *    `summon_expert` 一次性咨询不写代码、`expert_brief` 是纯函数不写盘、`subagent/catalog` 连
 *    咨询专家也会登记（`mode` 全为 `continuable`，区分不了咨询与实现）。把它们算进放行条件，
 *    「叫了专家评审、实现自己全干完」就会判 PASS —— 而那正是本工具要抓的形态。
 * ③ **人格检查（`dispatch.persona`）默认只进 `warnings`，不进 `verdict`。** 它回答的是「队友
 *    prompt 里有没有专家人格」，与「实现交给谁」正交：真实事故里三个队友命名全对、prompt 零
 *    persona，判定本身没有问题（确实派了人），问题在「派的质量」。默认不判，是因为算进去会让
 *    大批历史会话判违规（起名字容易、贴 persona 需要人主动做），闸门一上线就满地红灯。
 *    显式加 `--persona-verdict`（`personaVerdict: true`）才让它进 verdict。
 * ④ **严格归因（`strictAttribution`）默认关。** 开了之后 `parentEdits >= 2 && fileCount >= 2
 *    && childEdits === 0` 直接判 VIOLATION。默认关是因为 `childEdits === 0` 最常见的成因是
 *    **子会话日志没落盘**（实测大多数不落盘），而不是队友真的没干活 —— 默认开会把
 *    「代码确实是子 agent 写的」判成违规。开了就按字面判，并在文案里写明日志是否可读。
 */
export function judge({
  files = [],
  parentEdits = 0,
  parentBashEdits = 0,
  childEdits = 0,
  dispatch = {},
  attribution = null,
  personaUnavailable = null,
  personaVerdict = false,
  strictAttribution = false,
} = {}) {
  const fileCount = Array.isArray(files) ? files.length : 0
  const subagents = Number(dispatch.subagents) || 0
  const personaLacking = Number(dispatch && dispatch.persona ? dispatch.persona.missing : 0) || 0
  const bashCount = Number(parentBashEdits) || 0

  // 人格检查默认只**追加 warning**：判定只看 `dispatch.subagents`（见下方 ③）。
  // 三条短路（① ② ③ 与末尾 PASS）都要带上它 —— 「队友 prompt 里没人格」与「主会话改了几个
  // 文件」是两件正交的事，只在某一条分支里提示，换个场景就静默了（这正是这次事故的形态：
  // 命名全对、判定也 PASS，于是没人发现人格根本没进 prompt）。
  const personaWarning = buildPersonaWarning(dispatch)
  const withPersona = (warnings) => (personaWarning ? [...warnings, personaWarning] : warnings)

  // `--persona-verdict` 打开后才把「队友缺人格」当违规。它**先于**文件数判定：
  // 「没改几个文件」不能豁免「派出去的队友没带人格」—— 那是两个维度，混在一起会互相掩盖。
  if (personaVerdict && personaLacking > 0) {
    const detail = `本轮 ${personaLacking} 个队友的 prompt 里没有专家人格（--persona-verdict 生效）`
    return {
      verdict: 'VIOLATION',
      warnings: withPersona([
        `${detail} —— 用 expert_brief 生成任务书，或把人格 md 正文整段贴进 prompt`,
        ...(personaUnavailable ? [`注意：${personaUnavailable}`] : []),
      ]),
      summary: `VIOLATION：${detail}`,
    }
  }

  // ① ② 先短路：主会话没改 / 只改一个文件，不涉及「有没有把实现交出去」。
  //    注意 `parentEdits === 0` 只看 edit/write：bash 写的文件会进 fileCount（见下），
  //    但**不解除**这条短路 —— 「主会话一次 edit 都没做」确实无从谈「实现没交出去」。
  if (parentEdits === 0) {
    const extra =
      bashCount > 0
        ? [`主会话没有 edit/write，但有 ${bashCount} 次 bash 写操作（confidence: low，只计入文件数、不参与判定）`]
        : []
    return { verdict: 'PASS', warnings: withPersona(extra), summary: 'PASS：主会话没有 edit/write' }
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

  // ④ 严格归因（默认关）：主会话自己跨多文件改 >=2 次，而可读到的子会话改动是 0。
  //    放在 `subagents === 0` 之后：那条是更具体的诊断（「只叫了专家」/「什么都没叫」），
  //    先判它，违规文案才不会丢掉读者最需要的那句原因。
  if (strictAttribution && parentEdits >= 2 && fileCount >= 2 && childEdits === 0) {
    const confidence = attribution ? attribution.confidence : 'high'
    const caveat =
      confidence === 'low'
        ? '（注意：本轮子会话日志不可读，childEdits=0 也可能只是日志没落盘 —— 需要更准的归因请补齐子会话日志）'
        : ''
    const detail = `主会话跨 ${fileCount} 个文件改了 ${parentEdits} 次，而子会话可读到的改动是 0 次（--strict-attribution 生效）`
    return {
      verdict: 'VIOLATION',
      warnings: withPersona([`${detail}${caveat}`]),
      summary: `VIOLATION：${detail}`,
    }
  }

  // 严格归因关着时，把「本该判违规」的情形显式提示出来（可见但不拦），否则开关等于没人知道。
  const strictHint =
    !strictAttribution && parentEdits >= 2 && fileCount >= 2 && childEdits === 0
      ? [
          `严格归因未开启（--strict-attribution）：主会话跨 ${fileCount} 个文件改了 ${parentEdits} 次且子会话改动为 0，` +
            '当前只提示、不判违规',
        ]
      : []

  // 派过实现队友：子会话日志缺失只影响归因精度，不代表没派人。
  const missing = attribution && Number(attribution.childLogsMissing) > 0
  const confidence = attribution ? attribution.confidence : 'high'
  const found = Number(attribution ? attribution.childLogsFound : 0) || 0
  const reason = `本轮派了 ${subagents} 次实现队友（${describeDispatch(dispatch)}）`
  const warnings = [...strictHint]

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
  // bash 写文件单独一行、显式标 confidence low：它和 edit/write 不是同一个证据等级，
  // 混进 parentEdits 会让读者以为自己看见的是结构化事实。
  const bash = report.bashEdits || { count: 0, parent: 0, child: 0, confidence: 'low', scratchExcluded: 0, writes: [] }
  lines.push(`  bashEdits            ${bash.count}（confidence: ${bash.confidence}；主 ${bash.parent} / 子 ${bash.child}${bash.scratchExcluded > 0 ? `；临时目录已排除 ${bash.scratchExcluded}` : ''}）`)

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

  // bash 写操作明细：只列被计入改动文件集合的（其余在 warnings 里说明为什么没计入）。
  const bashWrites = Array.isArray(bash.writes) ? bash.writes.filter((write) => write.counted) : []
  if (bashWrites.length > 0) {
    lines.push('')
    lines.push('bash 写文件（confidence: low，从命令串解析）')
    for (const write of bashWrites) lines.push(`  - [${write.kind}] ${write.path}（${write.scope}）`)
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
    case 'env':
      return '按环境变量里的会话 id（--session current / 缺省行为）'
    default:
      return null
  }
}

/**
 * 供测试/库调用：跑一次分析并返回报告（不打印、不退出）。
 *
 * `session` 缺省是 **null**（读环境变量），与 CLI 一致 —— 库调用同样不该「猜会话」。
 * 取不到会话 id 时抛 `CliError`（exit 1），调用方按错误处理。
 *
 * @param {{session?: string|null, cwd?: string|null, anyCwd?: boolean, root?: string, sessionEnv?: string|null, allowLatest?: boolean, personaRoot?: string|null, personaVerdict?: boolean, strictAttribution?: boolean, diagnose?: {warnings: string[]}, env?: Record<string,string|undefined>}} [options]
 */
export function inspect({
  session = null,
  cwd = null,
  anyCwd = false,
  root = sessionsRoot(),
  sessionEnv = null,
  allowLatest = false,
  personaRoot = null,
  personaVerdict = false,
  strictAttribution = false,
  diagnose = null,
  env = process.env,
} = {}) {
  let resolvedSelector
  try {
    resolvedSelector = resolveSelector({ session, sessionEnv, allowLatest, env })
  } catch (error) {
    // 只给了 --cwd 却取不到会话 id 的人，心里想的其实是「查这个目录下的会话」。
    // 把这条具体出路补进 hint，否则他只能自己去猜参数组合。
    if (cwd && error && typeof error === 'object' && typeof error.hint === 'string') {
      error.hint = `${error.hint}\n只给 --cwd 时请再指定会话来源：--session latest --allow-latest --cwd ${cwd}（或 --session <uuid> --cwd ${cwd}）`
    }
    throw error
  }
  const selector = resolvedSelector.session
  const effective = effectiveCwd({ session: selector, cwd, anyCwd })
  const { dir, resolvedBy, cwdFallback } = resolveSession({
    session: selector,
    cwd: effective.cwd,
    root,
    // 只有「隐式默认 cwd」可以退回全盘；显式 --cwd 是硬筛（resolveSession 里会报错）。
    softCwd: effective.source === 'implicit',
  })

  // 退回全盘时不要写 cwdFilter：那一刻并没有按 cwd 筛过，写了就是假证据。
  const report = analyzeSession(dir, {
    cwd: cwdFallback ? null : effective.cwd,
    personaRoot,
    personaVerdict,
    strictAttribution,
    env,
  })
  report.session.selectorSource = resolvedSelector.source
  report.session.selectorEnv = resolvedSelector.envName
  if (resolvedSelector.source === 'latest-allowed') {
    const note = `--session latest 已按 --allow-latest 放行：它会按 cwd+mtime 猜会话，可能检查的不是当前会话`
    report.warnings.push(note)
    if (diagnose && Array.isArray(diagnose.warnings)) diagnose.warnings.push(note)
  }
  report.session.resolvedBy = resolvedBy
  report.session.cwdSource = effective.source
  report.session.selectedBy =
    resolvedSelector.source === 'latest-allowed'
      ? cwdFallback
        ? 'implicit-fallback'
        : effective.source === 'any-cwd'
          ? 'any-cwd'
          : effective.source === 'explicit'
            ? 'explicit'
            : 'implicit'
      : resolvedBy === 'dir'
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
            : resolvedSelector.source === 'env'
              ? 'env'
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
  const diagnose = { warnings: [] }
  try {
    report = inspect({
      session: opts.session,
      cwd: opts.cwd,
      anyCwd: opts.anyCwd,
      sessionEnv: opts.sessionEnv,
      allowLatest: opts.allowLatest,
      personaRoot: opts.personaRoot,
      personaVerdict: opts.personaVerdict,
      strictAttribution: opts.strictAttribution,
      diagnose,
    })
  } catch (error) {
    process.stderr.write(`dispatch-check: ${error.message}\n`)
    if (error.hint) process.stderr.write(`${error.hint}\n`)
    process.exitCode = error.exitCode || EXIT.ERROR
    return
  }

  // 逃生口的警告走 stderr：报告本身也留了同一条 warning，但 stderr 是「终端里直接看得见」的
  // 那一份，不能只写在 --json 才读到的字段里。
  for (const warning of diagnose.warnings) process.stderr.write(`dispatch-check: 警告：${warning}\n`)

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
