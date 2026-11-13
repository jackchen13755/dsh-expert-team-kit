#!/usr/bin/env node
/**
 * dsh-expert-team-kit / bin/tier.mjs
 *
 * 判档 CLI：`tier classify` 让「这一单该谁做」在终端里可复跑可存档，
 * `tier record` 把决策追加进 `<root>/.dsh/tiers/<session>.jsonl` 供事后审计。
 *
 * 设计取向：
 * - **stdout 只放 JSON**：成功时 stdout 就是唯一产物，可直接 `| jq` 或落盘；
 *   一切诊断（用法、非法 JSON 原因）走 stderr，绝不污染产物。
 * - **退出码分层**：0 成功；1 用法/输入错误（参数缺值、JSON 坏、写盘失败）。
 *   迁移类判定没有「2」这一档 —— 判档永远给定一个档，不存在「拒绝判档」。
 * - **歧义即失败**：未知命令、未知选项、选项缺值都直接报错，不猜调用方意图。
 * - **`--help` 优先于一切**：调试参数时最怕「想看用法却先被别的参数错误打断」。
 * - 用 `process.exitCode` 而非 `process.exit()`：管道输出时立即退出可能截断 stdout。
 *
 * 用法见下方 USAGE；实现只依赖 node 内置模块与 ../lib/tier.mjs。
 */

import { classifyTier, recordTier, readTier, TIERS } from '../lib/tier.mjs'

/** 用法说明（`--help` 与参数错误共用）。 */
const USAGE = `用法：
  tier classify --features <json> [--root <path>]
  tier record   --session <id> --features <json> [--tier <self|expert|team>] [--root <path>]
  tier show     --session <id> [--root <path>]

判档（亲做 / 叫专家 / 起团队）并可选地把决策记录落盘。成功时 stdout 只有 JSON。

子命令：
  classify               只判档，打印 {"tier","reasons","evidence"}，不写盘
  record                 判档（或用 --tier 指定）后追加一条记录到
                         <root>/.dsh/tiers/<session>.jsonl，打印 {"file","record"}
  show                   打印某会话已有的全部判档记录，含 missing / corrupt 信息

必填：
  --features <json>      判档输入（JSON 对象），字段：
                         singlePoint, files, modules, needsOpinion, needsArtifact,
                         machineVerifiable, width, needsRework
  --session <id>         record / show 必填；会作为文件名，故不能含 / 或 \\\\

可选：
  --tier <name>          record 时显式指定档位（${TIERS.join(' | ')}）；
                         不给则由 --features 现判
  --root <path>          落盘根目录，缺省当前工作目录
  -h, --help             打印本用法并退出 0
`

/**
 * 解析 argv（不含 node 与脚本路径）。
 * @param {string[]} argv
 * @returns {{ command: string | null, flags: Record<string, string | boolean>, help: boolean, problem: string | null }}
 */
function parseArgv(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  /** @type {string | null} */
  let command = null
  let help = false

  /** 需要取值的选项。 */
  const VALUE_FLAGS = new Set(['features', 'session', 'tier', 'root'])

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h' || token === '--help') {
      help = true
      continue
    }
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (!VALUE_FLAGS.has(name)) {
        return { command, flags, help, problem: `未知选项 --${name}（可用：--features/--session/--tier/--root/--help）` }
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
 * 解析 --features 的 JSON；失败给出可操作消息（含收到的原文片段）。
 * @param {unknown} raw
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, message: string }}
 */
function parseFeatures(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, message: '缺少必填选项 --features <json>（例如 --features \'{"singlePoint":true,"files":1}\'）' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
    return {
      ok: false,
      message: `--features 不是合法 JSON（${cause instanceof Error ? cause.message : String(cause)}）：${snippet}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed
    return { ok: false, message: `--features 必须是 JSON 对象，实际是 ${got}` }
  }
  return { ok: true, value: parsed }
}

/**
 * 打印 JSON 到 stdout。
 * @param {unknown} value
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 失败出口：stderr 说明 + 用法 + 退出码。
 * @param {string} message
 * @param {number} exitCode
 */
function fail(message, exitCode) {
  process.stderr.write(`tier: ${message}\n\n${USAGE}`)
  process.exitCode = exitCode
}

function main() {
  const { command, flags, help, problem } = parseArgv(process.argv.slice(2))

  if (help) {
    process.stdout.write(USAGE)
    return
  }
  if (problem) {
    fail(problem, 1)
    return
  }
  if (command === null) {
    fail('缺少子命令（classify / record / show）', 1)
    return
  }

  const root = typeof flags.root === 'string' ? flags.root : undefined

  if (command === 'classify') {
    const features = parseFeatures(flags.features)
    if (!features.ok) {
      fail(features.message, 1)
      return
    }
    try {
      printJson(classifyTier(features.value))
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause), 1)
    }
    return
  }

  if (command === 'record') {
    if (typeof flags.session !== 'string') {
      fail('record 缺少必填选项 --session <id>', 1)
      return
    }
    const features = parseFeatures(flags.features)
    if (!features.ok) {
      fail(features.message, 1)
      return
    }
    try {
      let tier = flags.tier
      let reasons
      if (tier === undefined) {
        const classified = classifyTier(features.value)
        tier = classified.tier
        reasons = classified.reasons
      } else if (!TIERS.includes(String(tier))) {
        fail(`--tier 必须是 ${TIERS.join(' | ')} 之一，实际收到 ${JSON.stringify(tier)}`, 1)
        return
      }
      const saved = recordTier({ root, sessionKey: flags.session, tier: String(tier), features: features.value, reasons })
      printJson(saved)
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause), 1)
    }
    return
  }

  if (command === 'show') {
    if (typeof flags.session !== 'string') {
      fail('show 缺少必填选项 --session <id>', 1)
      return
    }
    try {
      printJson(readTier({ root, sessionKey: flags.session }))
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause), 1)
    }
    return
  }

  fail(`未知子命令：${command}（可用：classify / record / show）`, 1)
}

main()
