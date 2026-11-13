#!/usr/bin/env node
/**
 * dsh-expert-team-kit / bin/phase.mjs
 *
 * 阶段 CLI：把「方案 → 实现 → 验收 → 评审 → 完成」这条链路变成可执行的状态机。
 *
 * 设计取向：
 * - **stdout 只放 JSON 结果**（advance 的成功与拒绝都打 JSON，`ok` 字段区分），
 *   诊断与用法走 stderr —— 脚本可以无条件 `| jq`，不必先分辨这行是不是报错。
 * - **退出码分层**：0 成功；2 迁移被拒（非法迁移 / 未知目标 / 返工耗尽 / 状态损坏）；
 *   1 用法或 IO 错误（缺参数、未知选项、写盘失败）。
 *   把「业务判定拒绝」和「调用姿势错了」分开，脚本才能只对后者告警。
 * - **拒绝不落盘**：被拒时状态文件保持原样，失败尝试不会变成事实。
 * - **`--help` 优先于一切**：调试参数时最怕「想看用法却先被参数错误打断」。
 * - 用 `process.exitCode` 而非 `process.exit()`：管道输出时立即退出可能截断 stdout。
 *
 * 用法见下方 USAGE；实现只依赖 node 内置模块与 ../lib/phase.mjs。
 */

import { PHASES, MAX_REWORK_ROUNDS, advanceSession, readPhaseState } from '../lib/phase.mjs'

/** 用法说明（`--help` 与参数错误共用）。 */
const USAGE = `用法：
  phase advance --session <id> --to <phase> [--root <path>]
  phase show    --session <id> [--root <path>]

按显式迁移表推进阶段状态，状态落盘在 <root>/.dsh/phases/<session>.json。
advance 成功与拒绝都往 stdout 打 JSON（用 ok 字段区分）。

子命令：
  advance                从当前阶段迁移到 --to；非法迁移不写盘
  show                   打印某会话当前状态（不存在时返回初始 plan 状态 + missing:true）

必填：
  --session <id>         会话 id；会作为文件名，故不能含 / 或 \\\\
  --to <phase>           advance 必填，取值：${PHASES.join(' | ')}

可选：
  --root <path>          状态根目录，缺省当前工作目录
  -h, --help             打印本用法并退出 0

迁移表：
  plan → implement → verify → review → done
  review → implement（返工，最多 ${MAX_REWORK_ROUNDS} 轮，超限 REWORK_EXHAUSTED）

退出码：
  0 成功        2 迁移被拒（ok=false）        1 用法/IO 错误
`

/**
 * 解析 argv（不含 node 与脚本路径）。
 * @param {string[]} argv
 */
function parseArgv(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  /** @type {string | null} */
  let command = null
  let help = false

  const VALUE_FLAGS = new Set(['session', 'to', 'root'])

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h' || token === '--help') {
      help = true
      continue
    }
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (!VALUE_FLAGS.has(name)) {
        return { command, flags, help, problem: `未知选项 --${name}（可用：--session/--to/--root/--help）` }
      }
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { command, flags, help, problem: `选项 --${name} 缺少取值` }
      }
      flags[name] = value
      index += 1
      continue
    }
    if (command === null) {
      command = token
      continue
    }
    return { command, flags, help, problem: `多余的参数：${token}（每个子命令只接受一个位置参数作为子命令名）` }
  }

  return { command, flags, help, problem: null }
}

/**
 * 打印 JSON 到 stdout。
 * @param {unknown} value
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 用法/IO 错误出口（exit 1）。
 * @param {string} message
 */
function fail(message) {
  process.stderr.write(`phase: ${message}\n\n${USAGE}`)
  process.exitCode = 1
}

function main() {
  const { command, flags, help, problem } = parseArgv(process.argv.slice(2))

  if (help) {
    process.stdout.write(USAGE)
    return
  }
  if (problem) {
    fail(problem)
    return
  }
  if (command === null) {
    fail('缺少子命令（advance / show）')
    return
  }

  const root = typeof flags.root === 'string' ? flags.root : undefined

  if (command === 'advance') {
    if (typeof flags.session !== 'string') {
      fail('advance 缺少必填选项 --session <id>')
      return
    }
    if (typeof flags.to !== 'string') {
      fail(`advance 缺少必填选项 --to <phase>（取值：${PHASES.join(' | ')}）`)
      return
    }
    try {
      const result = advanceSession({ root, sessionKey: flags.session, to: flags.to })
      printJson(result)
      if (!result.ok) {
        // 迁移被拒是「业务判定」，用 2 与用法错误区分开；同时给一行人读的诊断。
        process.stderr.write(`phase: 迁移被拒（${result.error?.code}）：${result.error?.message}\n`)
        process.exitCode = 2
      }
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause))
    }
    return
  }

  if (command === 'show') {
    if (typeof flags.session !== 'string') {
      fail('show 缺少必填选项 --session <id>')
      return
    }
    try {
      printJson(readPhaseState({ root, sessionKey: flags.session }))
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause))
    }
    return
  }

  fail(`未知子命令：${command}（可用：advance / show）`)
}

main()
