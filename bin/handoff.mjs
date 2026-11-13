#!/usr/bin/env node
/**
 * dsh-expert-team-kit / bin/handoff.mjs
 *
 * 「交接五段」CLI：把「换会话怎么接上前情」变成三条命令。
 *
 * 设计取向（与 bin/expert-brief.mjs 一致）：
 * - **退出码就是判定**：`PASS=0 / ERROR=1 / MISSING=2`。把 `check` 挂进收尾脚本或 hooks 时，
 *   只看退出码就够，不用解析文案。
 * - **stdout 只放判定结果，stderr 放诊断**：`--json` 时 stdout 是一整份 JSON，可直接 `| jq`。
 * - **失败必须可操作**：每条错误都说「发生了什么 / 下一步做什么」，并给出可直接复制的命令。
 * - **`--help` 优先于一切**：只要出现 `-h` / `--help`，哪怕别的参数有错也只打印用法、退出 0。
 * - 用 `process.exitCode` 而不是 `process.exit()`：管道输出时立刻退出可能截断 stdout。
 *
 * 用法见 USAGE；实现只依赖 lib/handoff.mjs，不碰宿主包。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  HANDOFF_SECTIONS,
  MAX_SECTION_LINES,
  appendToHandoff,
  formatHandoff,
  handoffPathFor,
  verifyHandoff,
} from '../lib/handoff.mjs'

/** 退出码：判定结果即退出码，调用脚本按码分支，不必匹配中文文案。 */
const EXIT = Object.freeze({
  /** 通过（或写操作成功） */
  PASS: 0,
  /** 参数/IO 错误：命令没跑起来，或文档读写失败 */
  ERROR: 1,
  /** 交接文档不合格：缺段、空段，或文档根本不存在 */
  MISSING: 2,
})

/** 用法说明（`--help` 与「缺必填参数」时共用）。 */
const USAGE = `用法：
  node dsh-expert-team-kit/bin/handoff.mjs init   --session <id> [--root <dir>] [--force]
  node dsh-expert-team-kit/bin/handoff.mjs check  --session <id> [--root <dir>] [--json]
  node dsh-expert-team-kit/bin/handoff.mjs append --session <id> --section <id> --text <text>

交接五段（缺段或空段都判不合格）：${HANDOFF_SECTIONS.map((section) => `${section.id}（${section.title}）`).join(' / ')}

子命令：
  init     在 <root>/.dsh/handoffs/<id>.md 生成五段空模板；已存在则报错（不静默覆盖）
  check    校验交接文档：缺段 → 退出码 2；超 ${MAX_SECTION_LINES} 行只告警（退出码仍 0）
  append   往某一段末尾追加内容；文档不存在时先 init

可选：
  --root <dir>    工程根目录，缺省 process.cwd()；交接文档固定在 <root>/.dsh/handoffs/ 下
  --force         init 时覆盖已存在的文档
  --json          check 时把完整结果打到 stdout（字段：ok/missing/empty/overlong/counts/path）
  --section <id>  append 的目标段，认 id 或中文标题（decided / 已定 / rejected / 已否决 …）
  --text <text>   append 的内容，多行用引号包住；以 -- 开头的值请写成 --text=<text>
  -h, --help      打印本用法并退出 0（优先于其它选项）

退出码：0 通过；1 参数/IO 错误；2 交接文档不合格（缺段、空段、文档不存在）。

示例：
  node dsh-expert-team-kit/bin/handoff.mjs init --session session-abc123
  node dsh-expert-team-kit/bin/handoff.mjs append --session session-abc123 \\
    --section rejected --text "否决了方案 B：缓存一致性无法验证"
  node dsh-expert-team-kit/bin/handoff.mjs check --session session-abc123 --json`

/** 各子命令允许的选项（选项出现在别的子命令下 = 参数错误，不静默忽略）。 */
const COMMAND_FLAGS = Object.freeze({
  init: new Set(['session', 'root', 'force']),
  check: new Set(['session', 'root', 'json']),
  append: new Set(['session', 'root', 'section', 'text']),
})

/** 需要取值的选项。`--force` / `--json` / `--help` 是不取值的开关。 */
const VALUE_FLAGS = new Set(['session', 'root', 'section', 'text'])

/** `--help` / `-h`：不取值，且优先级最高。 */
const HELP_FLAGS = new Set(['-h', '--help'])

/**
 * 参数错误：带 `code`，方便调用脚本按码分支；`exitCode` 缺省 1（参数错不是「文档不合格」）。
 */
class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(code, message, exitCode = EXIT.ERROR) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

/**
 * 解析 argv（不含 node 与脚本路径）。
 *
 * @param {string[]} argv
 * @returns {{
 *   command: string, help: boolean,
 *   session?: string, root?: string, section?: string, text?: string,
 *   force: boolean, json: boolean,
 * }}
 * @throws {CliError} 未知子命令 / 未知选项 / 选项缺少取值 / 给开关传了值 / 选项不属于该子命令
 */
function parseArgv(argv) {
  /** @type {any} */
  const parsed = { command: '', help: false, force: false, json: false }

  // --help 优先：先整体扫一遍，避免「--help --nope」被参数错误抢先中断
  if (argv.some((token) => HELP_FLAGS.has(token))) {
    parsed.help = true
    return parsed
  }

  const command = argv[0]
  if (command === undefined) {
    throw new CliError(
      'CLI_MISSING_COMMAND',
      `缺少子命令（init / check / append）。\n\n${USAGE}`,
    )
  }
  if (command.startsWith('-')) {
    throw new CliError('CLI_MISSING_COMMAND', `第一个参数必须是子命令（init / check / append），收到选项：${command}。\n\n${USAGE}`)
  }
  if (!Object.hasOwn(COMMAND_FLAGS, command)) {
    throw new CliError(
      'CLI_UNKNOWN_COMMAND',
      [
        `未知子命令：${command}`,
        `可用子命令：${Object.keys(COMMAND_FLAGS).join(' / ')}`,
        '',
        USAGE,
      ].join('\n'),
    )
  }
  parsed.command = command

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]

    if (!token.startsWith('--')) {
      throw new CliError(
        'CLI_UNEXPECTED_ARG',
        `无法识别的位置参数：${JSON.stringify(token)}\n子命令之后的参数都要写成 --key value，用 --help 查看用法。`,
      )
    }

    const body = token.slice(2)
    const equalsIndex = body.indexOf('=')
    const flag = equalsIndex === -1 ? body : body.slice(0, equalsIndex)
    const inlineValue = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1)

    if (!COMMAND_FLAGS[command].has(flag)) {
      throw new CliError(
        'CLI_UNKNOWN_FLAG',
        [
          `子命令 ${command} 不支持选项 --${flag}`,
          `它可用：${[...COMMAND_FLAGS[command]].map((name) => `--${name}`).join(' / ')} / --help`,
          '',
          USAGE,
        ].join('\n'),
      )
    }

    if (!VALUE_FLAGS.has(flag)) {
      // --force / --json：不取值；`--force=1` 说明意图混乱，直接报错
      if (inlineValue !== undefined) {
        throw new CliError(
          'CLI_UNEXPECTED_VALUE',
          `--${flag} 不接受取值（收到：${JSON.stringify(inlineValue)}）；直接写 --${flag}。`,
        )
      }
      parsed[flag] = true
      continue
    }

    let value = inlineValue
    if (value === undefined) {
      const next = argv[index + 1]
      // 下一个 token 是另一个选项（或没有）→ 视作缺值，而不是把选项名当成值吃掉
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        throw new CliError(
          'CLI_MISSING_VALUE',
          `选项 --${flag} 需要一个值，例如 --${flag} <value>；值本身以 -- 开头时写成 --${flag}=<value>。`,
        )
      }
      value = next
      index += 1
    }
    parsed[flag] = value
  }

  return parsed
}

/**
 * 要求某几个选项非空，缺了就一次性列全（不要让人试五次）。
 * @param {Record<string, unknown>} parsed
 * @param {string[]} names
 * @throws {CliError}
 */
function requireOptions(parsed, names) {
  /** @type {string[]} */
  const missing = []
  for (const name of names) {
    const value = parsed[name]
    if (value === undefined || value === null || String(value).trim() === '') missing.push(`--${name}`)
  }
  if (missing.length === 0) return
  throw new CliError(
    'CLI_MISSING_REQUIRED',
    [`子命令 ${parsed.command} 缺少必填参数：${missing.join('、')}`, '', USAGE].join('\n'),
  )
}

/**
 * 交接文档路径（会话 key 与 root 的校验都在 lib 里，这里只负责抛成 CLI 错误）。
 * @param {Record<string, unknown>} parsed
 * @returns {string}
 */
function resolvePath(parsed) {
  return handoffPathFor({ root: parsed.root, sessionKey: parsed.session })
}

/**
 * 读交接文档；不存在时给「先 init」的可操作错误。
 * @param {string} file
 * @param {string} session
 * @returns {string}
 * @throws {CliError} 文档不存在（退出码 2）或读取失败（退出码 1）
 */
function readHandoff(file, session) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(
        'CLI_HANDOFF_NOT_FOUND',
        [
          `交接文档不存在：${file}`,
          '还没有交接物，等于「本轮的前情一个字都没留下」——判定为不合格。',
          `Fix: 先生成模板：node dsh-expert-team-kit/bin/handoff.mjs init --session ${session}`,
        ].join('\n'),
        EXIT.MISSING,
      )
    }
    throw new CliError(
      'CLI_HANDOFF_UNREADABLE',
      [
        `读不到交接文档：${file}`,
        `底层原因：${error?.code ?? error?.message ?? String(error)}`,
        'Fix: 检查路径与读权限；root 是否是预期目录（--root <dir>）。',
      ].join('\n'),
    )
  }
}

/**
 * 把段 id 渲染成人类可读形式：`rejected（已否决）`。
 * @param {string} id
 * @returns {string}
 */
function labelOf(id) {
  const section = HANDOFF_SECTIONS.find((item) => item.id === id)
  return section === undefined ? id : `${section.id}（${section.title}）`
}

/**
 * 段标识归一：把 `--section` 收到的任意合法写法映射成规范 id。
 *
 * `--section` 同时接受规范 id 与中文标题（USAGE 与 README 都这么承诺，`appendToHandoff`
 * 内部也是靠同一个判据认的）。但 `verifyHandoff().overlong` 报的是**规范 id**，
 * 拿原始输入去 `find` 就会在「用中文标题」时一个都匹配不上——超长告警静默消失，
 * 而这是本命令唯一的 advisory。所以查告警前必须先归一。
 *
 * 判据必须与 lib 里 `matchSectionId` 一致：标题相等，或 id 大小写不敏感相等，
 * 两者都先去掉行尾中英文冒号。这里不导 lib 的内部函数（它没导出），但规则照抄同一份。
 * 认不出来时**原样返回**：让 `appendToHandoff` 抛它自己的「未知的段 + 可用段」错误，
 * 而不是在 CLI 里先编一个说法不同的错误。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function canonicalSectionId(raw) {
  if (typeof raw !== 'string') return /** @type {any} */ (raw)
  const trimmed = raw.replace(/[:：]\s*$/, '').trim()
  if (trimmed === '') return raw
  const section = HANDOFF_SECTIONS.find(
    (item) => item.title === trimmed || item.id === trimmed.toLowerCase(),
  )
  return section === undefined ? raw : section.id
}

/**
 * `init`：生成五段空模板。
 * @param {Record<string, unknown>} parsed
 * @returns {number} 退出码
 */
function commandInit(parsed) {
  requireOptions(parsed, ['session'])
  const file = resolvePath(parsed)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const template = formatHandoff()
  try {
    // wx：已存在即失败，避免两个会话同时 init 时互相覆盖
    fs.writeFileSync(file, template, { encoding: 'utf8', flag: parsed.force ? 'w' : 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new CliError(
        'CLI_HANDOFF_EXISTS',
        [
          `交接文档已存在：${file}`,
          '不会静默覆盖：里面可能有上一轮已经写好的内容。',
          `Fix: 要沿用就继续 append；确定重来再加 --force（会清空现有内容）。`,
        ].join('\n'),
      )
    }
    throw new CliError(
      'CLI_HANDOFF_UNWRITABLE',
      [
        `写不了交接文档：${file}`,
        `底层原因：${error?.code ?? error?.message ?? String(error)}`,
        'Fix: 检查目录写权限，或用 --root 指向可写的工程根。',
      ].join('\n'),
    )
  }

  process.stdout.write(
    [
      `已生成交接模板：${file}`,
      `下一步：把五段填上（${HANDOFF_SECTIONS.map((section) => section.title).join(' / ')}），`,
      `然后跑 check 复核：node dsh-expert-team-kit/bin/handoff.mjs check --session ${parsed.session}`,
      '（空模板会被 check 判为不合格，退出码 2 —— 这是预期行为，别把空模板当成交接完。）',
    ].join('\n') + '\n',
  )
  return EXIT.PASS
}

/**
 * `check`：校验交接文档。缺段/空段/文档不存在 → 退出码 2；超长只告警。
 * @param {Record<string, unknown>} parsed
 * @returns {number} 退出码
 */
function commandCheck(parsed) {
  requireOptions(parsed, ['session'])
  const file = resolvePath(parsed)
  const text = readHandoff(file, parsed.session)
  const result = verifyHandoff(text)

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ path: file, ...result }, null, 2)}\n`)
    return result.ok ? EXIT.PASS : EXIT.MISSING
  }

  /** @type {string[]} */
  const lines = [`交接文档：${file}`]

  if (result.ok) {
    lines.push(`结论：通过（五段齐，共 ${Object.values(result.counts).reduce((sum, n) => sum + n, 0)} 行）`)
  } else {
    lines.push(
      `结论：不合格（缺 ${result.missing.length} 段：${result.missing.map(labelOf).join('、')}）`,
    )
    if (result.empty.length > 0) {
      lines.push(`  空段（有标题没内容）：${result.empty.map(labelOf).join('、')}`)
    }
    const absent = result.missing.filter((id) => !result.empty.includes(id))
    if (absent.length > 0) {
      lines.push(`  缺段（连标题都没有）：${absent.map(labelOf).join('、')}`)
    }
    const firstMissing = result.missing[0]
    lines.push(
      `Fix: 补齐第一段即可先看效果：node dsh-expert-team-kit/bin/handoff.mjs append --session ${parsed.session} --section ${firstMissing} --text "<内容>"`,
    )
  }

  if (result.overlong.length > 0) {
    lines.push(
      `告警（不判失败）：${result.overlong
        .map((item) => `${labelOf(item.id)} ${item.lines} 行，超过上限 ${item.max}`)
        .join('；')}`,
      '  超长段通常意味着该拆成两段或该精简——它不阻止通过，但下一轮读的人会费力。',
    )
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  return result.ok ? EXIT.PASS : EXIT.MISSING
}

/**
 * `append`：往某一段末尾追加内容行。
 * @param {Record<string, unknown>} parsed
 * @returns {number} 退出码
 */
function commandAppend(parsed) {
  requireOptions(parsed, ['session', 'section', 'text'])
  const file = resolvePath(parsed)
  const text = readHandoff(file, parsed.session)

  // 归一后的段 id：既用于查 overlong（它报的是规范 id），也用于人类可读输出。
  // 未知段仍交给 appendToHandoff 抛错（错误文案只有一处，不会漂移）。
  const sectionId = canonicalSectionId(parsed.section)

  const next = appendToHandoff(text, parsed.section, parsed.text)
  fs.writeFileSync(file, next, 'utf8')

  const result = verifyHandoff(next)
  const addedLines = String(parsed.text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '').length

  process.stdout.write(`已追加 ${addedLines} 行到 ${labelOf(sectionId)}（文件：${file}）\n`)
  process.stdout.write(
    result.ok
      ? '当前状态：五段齐，可以 check 通过。\n'
      : `当前状态：仍缺 ${result.missing.length} 段（${result.missing.map(labelOf).join('、')}），check 会返回 2。\n`,
  )

  const overlong = result.overlong.find((item) => item.id === sectionId)
  if (overlong !== undefined) {
    process.stderr.write(
      `告警：${labelOf(overlong.id)} 已有 ${overlong.lines} 行，超过上限 ${MAX_SECTION_LINES}；建议精简或拆段（不影响退出码）。\n`,
    )
  }

  return EXIT.PASS
}

/**
 * 入口。成功 → 退出码 0；参数错误 → 1；交接文档不合格 → 2。
 *
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  try {
    const parsed = parseArgv(argv)
    if (parsed.help) {
      process.stdout.write(`${USAGE}\n`)
      return EXIT.PASS
    }

    switch (parsed.command) {
      case 'init':
        return commandInit(parsed)
      case 'check':
        return commandCheck(parsed)
      case 'append':
        return commandAppend(parsed)
      default:
        // parseArgv 已挡住未知子命令，这里是防御性兜底
        throw new CliError('CLI_UNKNOWN_COMMAND', `未知子命令：${parsed.command}`)
    }
  } catch (error) {
    // 错误信息本身要可操作：lib 的 HandoffError 也带 Fix，直接透传
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    return typeof error?.exitCode === 'number' ? error.exitCode : EXIT.ERROR
  }
}

process.exitCode = main(process.argv.slice(2))
