#!/usr/bin/env node
/**
 * dsh-expert-team-kit / bin/expert-brief.mjs
 *
 * 任务书 CLI：把「给某个专家派活」这件事变成一条可直接粘进终端/脚本的命令。
 *
 * 设计取向：
 * - **stdout 只放任务书**：成功时 stdout 就是任务书原文，可以 `> brief.md` 或管道给别的工具；
 *   一切诊断（含 `--help` 的用法）走各自该走的流，不污染产物。
 * - **失败必须可定位**：缺什么就逐条列出缺的参数名，再给完整 `--help` 用法，退出码 1。
 * - **歧义即失败**：`--task` 与 `--task-file` 同时给、未知参数、参数缺值都直接报错，
 *   不猜调用方的意图（猜错会生成一份内容不对但看起来正常的任务书）。
 * - **`--help` 优先于一切（N3）**：只要出现 `-h` / `--help`，哪怕同时给了别的选项、
 *   哪怕那些选项本身有错，也只打印用法并退出 0 —— 与 USAGE 里「打印本用法并退出」的
 *   无条件读法一致。调试参数时最怕「想看用法却先被参数错误打断」。
 * - 退出码用 `process.exitCode` 而不是 `process.exit()`：管道输出时立刻退出可能截断 stdout。
 *
 * 用法见下方 USAGE；实现只依赖 lib/tool.mjs，不碰宿主包。
 */

import fs from 'node:fs'

import { executeExpertBrief } from '../lib/tool.mjs'

/** 用法说明（`--help` 与「缺必填参数」时共用）。 */
const USAGE = `用法：
  expert-brief --expert <slug> (--task <text> | --task-file <path>) --verify <cmd>
               [--scope <prefix>]... [--task-id <id>] [--worker <name>]
               [--surface <none|official|agent-teams>] [--kind <implementation|review|work>]

给指定专家生成一份可直接派给 teammate 的自包含任务书（打印到 stdout）。

必填：
  --expert <slug>        专家人格标识，三种写法都支持：
                         engineering-code-reviewer / code-reviewer / engineering/code-reviewer
  --task <text>          任务内容与边界输入
  --task-file <path>     从文件读取任务内容（与 --task 二选一，不可同时给）
  --verify <cmd>         验收命令（队友必须自己跑通的那一条）

可选：
  --scope <prefix>       允许修改的文件前缀，可重复多次；不给表示未限定作用域
  --task-id <id>         任务板 id（如 task-8），任务书流程与回报第 4 行会引用它
  --worker <name>        队友名，默认 worker
  --surface <name>       任务书第 5 节生成的收尾协议，三选一：
                         none（默认，不生成任何任务板调用，只按回报格式收尾）
                         official（team_task_get / team_task_update 的 claim + complete）
                         agent-teams（agent_teams_claim_task / agent_teams_complete_task，带 attempt_id）
                         给别的值会报错，不会静默退回 none
  --kind <type>          任务字段里的交付类型，默认 implementation；可选 review / work
  -h, --help             打印本用法并退出 0
                         （优先于其它选项：即使同时给了别的参数或它们有错，也只打印用法）

示例：
  expert-brief --expert code-reviewer --task "审查 lib/tool.mjs" \\
    --verify "node --test dsh-expert-team-kit/test/" \\
    --scope dsh-expert-team-kit/lib/tool.mjs --task-id task-8 --worker worker-tool \\
    --surface official --kind review

退出码：0 成功（stdout 是任务书）；1 参数错误或生成失败（原因写到 stderr）。`

/** 需要取值的参数（`--key value` / `--key=value` 两种写法都认）。 */
const VALUE_FLAGS = new Set([
  'expert',
  'task',
  'task-file',
  'verify',
  'scope',
  'task-id',
  'worker',
  'surface',
  'kind',
])

/**
 * `--help` / `-h`：优先级最高，先扫一遍再解析（见文件头 N3）。
 * 用独立集合而不是塞进 VALUE_FLAGS，是因为它不取值、且要在「其它参数可能非法」时先返回。
 */
const HELP_FLAGS = new Set(['-h', '--help'])

/**
 * 参数错误：带 `code`，方便调用脚本按码分支（而不是匹配中文文案）。
 */
class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/**
 * 解析 argv（不含 node 与脚本路径）。
 *
 * @param {string[]} argv
 * @returns {{
 *   expert?: string, task?: string, taskFile?: string, verify?: string,
 *   scopes: string[], taskId?: string, worker?: string, surface?: string, kind?: string,
 *   help: boolean,
 * }}
 * @throws {CliError} 未知参数 / 参数缺值 / 位置参数 / --task 与 --task-file 同给
 */
function parseArgv(argv) {
  /** @type {{ expert?: string, task?: string, taskFile?: string, verify?: string, scopes: string[], taskId?: string, worker?: string, surface?: string, kind?: string, help: boolean }} */
  const parsed = { scopes: [], help: false }

  // N3：--help 优先。先整体扫一遍再解析，避免「--help --nope」被参数错误抢先中断。
  if (argv.some((token) => HELP_FLAGS.has(token))) {
    parsed.help = true
    return parsed
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (!token.startsWith('--') || token === '--') {
      throw new CliError(
        'CLI_UNEXPECTED_ARG',
        `无法识别的位置参数：${JSON.stringify(token)}\n本命令只接受 -- 开头的选项，用 --help 查看用法。`,
      )
    }

    const body = token.slice(2)
    const equalsIndex = body.indexOf('=')
    const flag = equalsIndex === -1 ? body : body.slice(0, equalsIndex)
    const inlineValue = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1)

    // `--help=1` 这类给 help 带值的写法：说明意图混乱，直接报错（不带值的 --help 已在上面短路）
    if (flag === 'help') {
      throw new CliError(
        'CLI_UNEXPECTED_VALUE',
        `--help 不接受取值（实际收到：${JSON.stringify(inlineValue ?? '')}）；直接写 --help 或 -h。`,
      )
    }

    if (!VALUE_FLAGS.has(flag)) {
      throw new CliError(
        'CLI_UNKNOWN_FLAG',
        [
          `未知选项：--${flag}`,
          `可用选项：${[...VALUE_FLAGS].map((name) => `--${name}`).join(' / ')} / --help`,
        ].join('\n'),
      )
    }

    let value = inlineValue
    if (value === undefined) {
      const next = argv[index + 1]
      // 下一个 token 是另一个选项（或没有）→ 视为缺值，而不是把选项名当成值吃掉
      if (next === undefined || (next.startsWith('--') && next.length > 2) || HELP_FLAGS.has(next)) {
        throw new CliError(
          'CLI_MISSING_VALUE',
          `选项 --${flag} 需要一个值，例如 --${flag} <value>；用 --help 查看用法。`,
        )
      }
      value = next
      index += 1
    }

    if (flag === 'scope') {
      parsed.scopes.push(value)
      continue
    }

    if (flag === 'task-file') {
      parsed.taskFile = value
      continue
    }

    if (flag === 'task-id') {
      parsed.taskId = value
      continue
    }

    // expert / task / verify / worker（--scope / --task-file / --task-id 已在上面先行处理）
    parsed[flag] = value
  }

  if (parsed.task !== undefined && parsed.taskFile !== undefined) {
    throw new CliError(
      'CLI_CONFLICTING_ARGS',
      '--task 与 --task-file 只能给一个：同时给会让人分不清任务书实际用了哪份内容。\nFix: 去掉其中一个。',
    )
  }

  return parsed
}

/**
 * argv → executeExpertBrief 的入参（含 --task-file 读取）。
 *
 * @param {ReturnType<typeof parseArgv>} parsed
 * @returns {{ args: Record<string, unknown>, missing: string[] }}
 */
function toToolArgs(parsed) {
  /** @type {string[]} */
  const missing = []
  if (parsed.expert === undefined || parsed.expert.trim() === '') missing.push('--expert')
  if (
    (parsed.task === undefined || parsed.task.trim() === '') &&
    (parsed.taskFile === undefined || parsed.taskFile.trim() === '')
  ) {
    missing.push('--task 或 --task-file')
  }
  if (parsed.verify === undefined || parsed.verify.trim() === '') missing.push('--verify')

  /** @type {Record<string, unknown>} */
  const args = {
    expert: parsed.expert,
    task: parsed.task,
    verify: parsed.verify,
    scopes: parsed.scopes,
    task_id: parsed.taskId,
    worker: parsed.worker,
    surface: parsed.surface,
    kind: parsed.kind,
  }

  if (parsed.task === undefined && parsed.taskFile !== undefined) {
    const file = parsed.taskFile.trim()
    let content
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw new CliError(
        'CLI_TASK_FILE_UNREADABLE',
        [
          `读不到 --task-file 指定的文件：${file}`,
          `底层原因：${error.code ?? error.message}`,
          'Fix: 检查路径是否存在、是否有读权限；或改用 --task <text> 直接内联任务内容。',
        ].join('\n'),
      )
    }
    if (content.trim() === '') {
      throw new CliError(
        'CLI_TASK_FILE_EMPTY',
        [
          `--task-file 指向的文件是空的：${file}`,
          'Fix: 写入任务内容，或改用 --task <text>。',
        ].join('\n'),
      )
    }
    args.task = content
  }

  return { args, missing }
}

/**
 * 入口。成功 → stdout 任务书 + 退出码 0；失败 → stderr 原因 + 退出码 1。
 *
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
  try {
    const parsed = parseArgv(argv)

    if (parsed.help) {
      process.stdout.write(`${USAGE}\n`)
      return
    }

    const { args, missing } = toToolArgs(parsed)
    if (missing.length > 0) {
      throw new CliError(
        'CLI_MISSING_REQUIRED',
        [
          `缺少必填参数：${missing.join('、')}`,
          '',
          USAGE,
        ].join('\n'),
      )
    }

    const result = executeExpertBrief(args)
    const text = result.content[0].text

    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  } catch (error) {
    // 直接把可操作信息打到 stderr：ToolSpecError / PersonaError 的 message 已经含 Fix。
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  }
}

main(process.argv.slice(2))
