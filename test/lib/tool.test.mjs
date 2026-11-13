/**
 * dsh-expert-team-kit / test/tool.test.mjs
 *
 * 第 3 层（插件工具 + CLI）的验收用例。
 *
 * 覆盖四类契约：
 *   1. **规格形状**：name / description / parameters / execute 齐全，required 标注正确 ——
 *      宿主与调用方读的是这份形状，形状漂移等于接口漂移。
 *   2. **执行行为**：合法入参产出任务书（含人格正文与验收命令），
 *      非法入参逐条抛可定位的错误（点名参数 + Fix）。
 *   3. **依赖方向**：内层文件不得 import 宿主包（`@deepseek-ai/...`），
 *      否则单测与 CLI 都必须拉起宿主，边界作废。
 *   4. **CLI**：退出码与流向（stdout 只放任务书、错误走 stderr）。
 *
 * 断言一律从紧：只认同一个参数名/同一个退出码，不做「模糊包含即通过」的放宽。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// lib/index.js 依赖宿主的 defineTool（@deepseek-ai/dsh-tools 由 DSH 运行时解析，
// profile 不安装核心包）。纯 node 环境下解析不到，此时跳过插件入口的用例，
// 而不是让整个套件变红 —— 入口的正确性在宿主内用「工具表出现 expert_brief」验证。
let apply = null
let inject = null
let pluginName = null
try {
  const indexModule = await import('../../lib/index.js')
  ;({ apply, inject, name: pluginName } = indexModule)
} catch {
  apply = null
  inject = null
  pluginName = null
}
const NO_HOST = pluginName === null ? '需宿主 @deepseek-ai/dsh-tools，纯 node 环境跳过' : false

import { buildBrief } from '../../lib/brief.mjs'
import { PersonaError, resolvePersona } from '../../lib/persona.mjs'
import {
  DEFAULT_WORKER,
  TOOL_ERROR_CODES,
  TOOL_NAME,
  ToolSpecError,
  buildToolSpec,
  executeExpertBrief,
} from '../../lib/tool.mjs'

/** 包的根目录与 CLI 路径，全部由本文件位置推导（不写死绝对路径）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('../../bin/expert-brief.mjs', import.meta.url))

const VERIFY = 'node --test dsh-expert-team-kit/test/'
const TASK = '实现第 3 层：工具规格 + 插件入口 + CLI。'
const SCOPES = ['dsh-expert-team-kit/lib/tool.mjs', 'dsh-expert-team-kit/test/tool.test.mjs']

/** 人格正文里的一级标题，用来断言「正文整段被贴进任务书」而不是只写了个人格名。 */
const PERSONA_MARKER = '# Code Reviewer Agent'

/**
 * 合法入参（可逐项覆盖，便于造非法用例）。
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function makeArgs(overrides = {}) {
  return {
    expert: 'code-reviewer',
    task: TASK,
    verify: VERIFY,
    scopes: SCOPES,
    task_id: 'task-8',
    worker: 'worker-tool',
    ...overrides,
  }
}

/**
 * 断言某次调用抛 ToolSpecError 且点名了指定参数。
 * @param {() => unknown} fn
 * @param {string} param
 * @param {RegExp} [messagePattern]
 */
function assertToolError(fn, param, messagePattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ToolSpecError, `应抛 ToolSpecError，实际：${error?.name}`)
    assert.equal(error.param, param, `错误应点名参数 ${param}，实际：${error.param}`)
    assert.ok(error.message.includes(param), `message 应包含参数名 ${param}`)
    assert.match(error.message, /Fix:/, '错误信息必须给修复动作')
    if (messagePattern) assert.match(error.message, messagePattern)
    return true
  })
}

// ——————————————————————————— 1. 规格形状 ———————————————————————————

test('buildToolSpec: name / description / parameters / execute 齐全，必填标注正确', () => {
  const spec = buildToolSpec()

  assert.equal(spec.name, 'expert_brief')
  assert.equal(spec.name, TOOL_NAME, 'name 必须与导出的 TOOL_NAME 一致')
  assert.equal(typeof spec.execute, 'function', 'execute 必须是函数')

  assert.equal(typeof spec.description, 'string')
  assert.ok(spec.description.length > 30, 'description 要能让人（或模型）判断何时该用这个工具')
  assert.ok(spec.description.includes('任务书'), 'description 应说明产出是任务书')
  assert.match(spec.description, /纯函数/, 'description 应声明副作用边界（纯函数）')

  assert.deepEqual(
    Object.keys(spec.parameters).sort(),
    ['expert', 'kind', 'scopes', 'surface', 'task', 'task_id', 'verify', 'worker'],
    'parameters 必须是这 8 个键，缺一或多一都算接口漂移',
  )

  for (const param of ['expert', 'task', 'verify']) {
    assert.equal(spec.parameters[param].type, 'string', `${param} 应为 string`)
    assert.equal(spec.parameters[param].required, true, `${param} 必须标 required`)
    assert.ok(spec.parameters[param].description.length > 0, `${param} 必须有 description`)
  }

  assert.equal(spec.parameters.scopes.type, 'array')
  assert.deepEqual(spec.parameters.scopes.items, { type: 'string' })
  assert.notEqual(spec.parameters.scopes.required, true, 'scopes 是可选项')

  assert.equal(spec.parameters.task_id.type, 'string')
  assert.notEqual(spec.parameters.task_id.required, true, 'task_id 是可选项')
  assert.equal(spec.parameters.worker.type, 'string')
  assert.notEqual(spec.parameters.worker.required, true, 'worker 是可选项')

  // surface / kind：可选、枚举、description 必须写明缺省值（否则调用方不知道不传会发生什么）
  assert.equal(spec.parameters.surface.type, 'string')
  assert.notEqual(spec.parameters.surface.required, true, 'surface 是可选项')
  assert.deepEqual(spec.parameters.surface.enum, ['agent-teams', 'official', 'none'])
  assert.match(spec.parameters.surface.description, /默认 none/, 'surface 的 description 要写清默认 none')
  assert.equal(spec.parameters.kind.type, 'string')
  assert.notEqual(spec.parameters.kind.required, true, 'kind 是可选项')
  assert.deepEqual(spec.parameters.kind.enum, ['implementation', 'review', 'work'])
  assert.match(
    spec.parameters.kind.description,
    /默认 "implementation"/,
    'kind 的 description 要写清默认 implementation',
  )
})

test('buildToolSpec: 多次调用 name 相同（幂等），且不共享可变状态', () => {
  const first = buildToolSpec()
  const second = buildToolSpec()

  assert.equal(first.name, second.name, '两次调用的 name 必须相同')
  assert.equal(first.name, 'expert_brief')
  assert.deepEqual(Object.keys(first.parameters), Object.keys(second.parameters))

  assert.notEqual(first, second, '每次返回新对象，避免调用方互相改坏对方的 spec')
  assert.notEqual(first.parameters, second.parameters, 'parameters 也不该是同一个对象')
})

// ——————————————————————————— 2. 执行：合法入参 ———————————————————————————

test('execute: 合法入参返回 { content:[{type:text}] }，含人格正文整段与验收命令', () => {
  const spec = buildToolSpec()
  const result = spec.execute(makeArgs())

  assert.deepEqual(Object.keys(result), ['content'], '返回体只有 content 一个键')
  assert.ok(Array.isArray(result.content))
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  assert.equal(typeof result.content[0].text, 'string')

  const text = result.content[0].text
  assert.ok(text.length > 500, '任务书应该是一份完整长文，不是一句摘要')

  // 人格：名 + 正文（不止标题 —— 抽真实段落逐段核对）
  const persona = resolvePersona('code-reviewer')
  assert.ok(text.includes(`人格名：${persona.name}`), '必须写出人格名')
  assert.ok(text.includes(PERSONA_MARKER), '人格正文的 H1 必须在任务书里')
  const paragraphs = persona.body
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 40)
  assert.ok(paragraphs.length >= 3, '真实人格正文应有多个段落')
  for (const paragraph of paragraphs.slice(0, 4)) {
    assert.ok(text.includes(paragraph), `人格正文段落缺失：${paragraph.slice(0, 40)}…`)
  }

  // 任务 / 验收 / 作用域 / worker / task id 逐个原样落位
  assert.ok(text.includes(TASK), '任务正文必须原样出现')
  assert.ok(text.includes(VERIFY), '验收命令必须原样出现')
  assert.match(text, /```bash\nnode --test dsh-expert-team-kit\/test\/\n```/, '验收命令应在 bash 块里')
  for (const scope of SCOPES) assert.ok(text.includes(`- ${scope}`), `写作用域应逐条列出：${scope}`)
  assert.ok(text.startsWith('你是 Agent Teams 里的 worker-tool。'), '开头是 worker 名')
  assert.ok(text.includes('`task-8`'), '必须带 task id')
})

test('execute: worker / task_id / scopes 缺省有明确兜底，不出现 undefined', () => {
  const text = executeExpertBrief({ expert: 'code-reviewer', task: TASK, verify: VERIFY }).content[0]
    .text

  assert.ok(text.startsWith(`你是 Agent Teams 里的 ${DEFAULT_WORKER}。`), 'worker 缺省为 worker')
  assert.ok(text.includes('（未指定 task id）'), 'task_id 缺省要显式标注')
  assert.ok(text.includes('- 无'), '未给 scopes 应写「无」')

  // N2：断言收窄到「缺省值没被渲染成 undefined 字样」，而不是全局禁用 undefined 子串 ——
  // 任务正文里合法出现 undefined（如「检查 undefined 与 null」）不该让本用例假失败。
  assert.ok(!text.includes('人格名：undefined'), '人格名不该是 undefined')
  assert.ok(!/你是 Agent Teams 里的 undefined[。\n]/.test(text), 'worker 名不该是 undefined')
  assert.ok(!text.includes('任务板上你的任务是 `undefined`'), 'task id 不该是 undefined')
})

test('execute: 任务正文里合法出现 undefined / null 时不被误伤（N2 回归）', () => {
  const task = '检查 undefined 与 null 的处理边界。'
  const text = executeExpertBrief({ expert: 'code-reviewer', task, verify: VERIFY }).content[0].text

  assert.ok(text.includes(task), '任务正文必须原样保留，哪怕它提到 undefined')
})

test('execute: scopes 接受单字符串（懒人写法），并转成一条作用域', () => {
  const text = executeExpertBrief({
    expert: 'code-reviewer',
    task: TASK,
    verify: VERIFY,
    scopes: 'dsh-expert-team-kit/lib/tool.mjs',
  }).content[0].text

  assert.ok(text.includes('- dsh-expert-team-kit/lib/tool.mjs'))
})

// ——————————————————————————— 3. 执行：非法入参 ———————————————————————————

test('execute: 缺 task 抛错并点名 task（含空串/空白/null/数字）', () => {
  const spec = buildToolSpec()

  assertToolError(() => spec.execute(makeArgs({ task: undefined })), 'task')
  assert.throws(
    () => spec.execute(makeArgs({ task: undefined })),
    (error) => {
      assert.equal(error.code, TOOL_ERROR_CODES.MISSING_PARAM, '缺必填参数应是 MISSING_PARAM')
      return true
    },
  )

  for (const badTask of ['', '   ', null, 123, false]) {
    assert.throws(
      () => spec.execute(makeArgs({ task: badTask })),
      (error) => {
        assert.ok(error instanceof ToolSpecError)
        assert.equal(error.param, 'task')
        return true
      },
      `task=${JSON.stringify(badTask)} 必须抛错`,
    )
  }
})

test('execute: 缺 verify 抛错并点名 verify', () => {
  const spec = buildToolSpec()

  assertToolError(() => spec.execute(makeArgs({ verify: undefined })), 'verify')
  for (const badVerify of ['', '  ', null]) {
    assert.throws(
      () => spec.execute(makeArgs({ verify: badVerify })),
      (error) => {
        assert.equal(error.param, 'verify')
        return true
      },
      `verify=${JSON.stringify(badVerify)} 必须抛错`,
    )
  }
})

test('execute: expert 为 undefined / 空串时抛错并点名 expert（不落到 TypeError）', () => {
  const spec = buildToolSpec()

  for (const badExpert of [undefined, '', '   ', null]) {
    assert.throws(
      () => spec.execute(makeArgs({ expert: badExpert })),
      (error) => {
        assert.ok(error instanceof ToolSpecError, `expert=${JSON.stringify(badExpert)} 应抛 ToolSpecError`)
        assert.equal(error.code, TOOL_ERROR_CODES.MISSING_PARAM)
        assert.equal(error.param, 'expert')
        return true
      },
    )
  }
})

test('execute: 未知 expert 抛 UNKNOWN_EXPERT，带候选建议与原错误 cause', () => {
  const spec = buildToolSpec()

  assert.throws(
    () => spec.execute(makeArgs({ expert: 'code-reviewr' })),
    (error) => {
      assert.ok(error instanceof ToolSpecError)
      assert.equal(error.code, TOOL_ERROR_CODES.UNKNOWN_EXPERT)
      assert.equal(error.param, 'expert')
      assert.match(error.message, /expert/, '必须点名 expert 参数')
      assert.match(error.message, /Fix:/)

      // 拼错一个字母应当能拿到真候选，而不是空建议
      assert.ok(Array.isArray(error.suggestions) && error.suggestions.length > 0, '必须给候选建议')
      assert.ok(error.suggestions.length <= 3, '候选最多 3 个')
      assert.ok(
        error.suggestions.includes('code-reviewer'),
        `候选里应含 code-reviewer，实际：${error.suggestions.join(', ')}`,
      )
      for (const suggestion of error.suggestions) {
        assert.ok(error.message.includes(suggestion), `候选 ${suggestion} 应写进 message`)
        // 建议必须真的能用：逐条回代解析，防止给出一堆解析不了的标识
        assert.ok(resolvePersona(suggestion).body.length > 0)
      }

      assert.ok(error.cause instanceof PersonaError, '原始 PersonaError 必须挂在 cause 上')
      // 不写死具体码：persona.mjs 正在并行返工（新增越界校验），码可能从 NOT_FOUND 变成 OUTSIDE_ROOT 等
      assert.match(error.cause.code, /^PERSONA_/, 'cause 应是 persona 层的错误码')
      return true
    },
  )
})

test('execute: 必填参数的报错顺序稳定（先 expert，再 task，再 verify）', () => {
  // 三个都缺：先报 expert（形状校验全部走完才碰文件系统）
  assert.throws(() => executeExpertBrief({}), (error) => {
    assert.equal(error.param, 'expert')
    return true
  })

  // 给了 expert，缺 task：报 task，而不是先去扫素材目录
  assert.throws(() => executeExpertBrief({ expert: 'code-reviewer' }), (error) => {
    assert.equal(error.param, 'task')
    return true
  })

  // expert + task 齐全，缺 verify：报 verify
  assert.throws(
    () => executeExpertBrief({ expert: 'code-reviewer', task: TASK }),
    (error) => {
      assert.equal(error.param, 'verify')
      return true
    },
  )
})

test('execute: 入参整体不是对象时抛 INVALID_ARGS（不炸成 TypeError）', () => {
  for (const badArgs of [undefined, null, 'code-reviewer', 42, [], () => {}]) {
    assert.throws(
      () => executeExpertBrief(badArgs),
      (error) => {
        assert.ok(error instanceof ToolSpecError, `args=${String(badArgs)} 应抛 ToolSpecError`)
        assert.equal(error.code, TOOL_ERROR_CODES.INVALID_ARGS)
        assert.match(error.message, /必须是对象/)
        return true
      },
      `args=${String(badArgs)} 必须被拒`,
    )
  }
})

test('execute: scopes 非法时点名 scopes / scopes[i]', () => {
  assertToolError(() => executeExpertBrief(makeArgs({ scopes: 123 })), 'scopes')
  assertToolError(() => executeExpertBrief(makeArgs({ scopes: { a: 1 } })), 'scopes')
  assertToolError(() => executeExpertBrief(makeArgs({ scopes: ['ok', ''] })), 'scopes[1]')
  assertToolError(() => executeExpertBrief(makeArgs({ scopes: ['ok', '  '] })), 'scopes[1]')
  assertToolError(() => executeExpertBrief(makeArgs({ scopes: [{ path: 'x' }] })), 'scopes[0]')

  // 空数组是合法的「未限定作用域」
  const text = executeExpertBrief(makeArgs({ scopes: [] })).content[0].text
  assert.ok(text.includes('- 无'))
})

// ————————————————————— N5：与 brief 层同口径 —————————————————————

/**
 * 跑一次 scopes 输入，归一成「接受 / 拒绝」+「拒绝时是否点名 scopes[i]」。
 * 用来逐格比对 tool 层与 brief 层的口径。
 * @param {() => unknown} run
 */
function scopesOutcome(run) {
  try {
    run()
    return { accepted: true, namesIndex: false, namesScopes: false }
  } catch (error) {
    return {
      accepted: false,
      namesIndex: /scopes\[\d+\]/.test(error.message),
      namesScopes: /scopes/.test(error.message),
    }
  }
}

test('N5: 同一份 scopes 输入，tool 层与 brief 层的结论逐格一致（接受/拒绝 + 报错点名）', () => {
  const persona = resolvePersona('code-reviewer')
  const matrix = [
    undefined,
    null,
    '', // 单字符串空串：两层都当「未提供」
    '   ',
    'dsh-expert-team-kit/lib/tool.mjs',
    [], // 空数组：未限定作用域
    [''], // 数组里的空项：两层都拒绝并点名 scopes[0]
    ['  '],
    ['dsh-expert-team-kit/lib/tool.mjs', ''],
    123, // 非字符串非数组：两层都拒绝
    { path: 'x' },
  ]

  for (const scopes of matrix) {
    const tool = scopesOutcome(() => executeExpertBrief(makeArgs({ scopes })))
    const brief = scopesOutcome(() =>
      buildBrief({ persona, task: TASK, verify: VERIFY, scopes }),
    )
    const label = JSON.stringify(scopes)

    assert.equal(
      tool.accepted,
      brief.accepted,
      `scopes=${label} 两层结论不一致：tool=${tool.accepted ? '接受' : '拒绝'} brief=${brief.accepted ? '接受' : '拒绝'}`,
    )
    if (!tool.accepted) {
      assert.equal(
        tool.namesScopes,
        brief.namesScopes,
        `scopes=${label} 两层拒绝时都该点名 scopes`,
      )
      assert.equal(
        tool.namesIndex,
        brief.namesIndex,
        `scopes=${label} 两层对「是否点名 scopes[i]」的判定不一致`,
      )
    }
  }
})

test('N5: 单字符串空 scopes 视同未提供（两层都接受，任务书写「无」）', () => {
  for (const empty of ['', '   ']) {
    const text = executeExpertBrief(makeArgs({ scopes: empty })).content[0].text
    assert.ok(text.includes('- 无'), `scopes=${JSON.stringify(empty)} 应视同未提供，写「无」`)
  }

  // 数组里的空项则必须被拒，且点名 scopes[0]（与 brief 层同形）
  for (const bad of [[''], ['   ']]) {
    assert.throws(
      () => executeExpertBrief(makeArgs({ scopes: bad })),
      (error) => {
        assert.ok(error instanceof ToolSpecError)
        assert.equal(error.code, TOOL_ERROR_CODES.INVALID_PARAM)
        assert.equal(error.param, 'scopes[0]', '参数名要与 brief 层 scopes[index] 同形')
        return true
      },
      `scopes=${JSON.stringify(bad)} 必须被拒并点名 scopes[0]`,
    )
  }
})

// ————————————————————— S4：未知参数不再静默忽略 —————————————————————

test('S4: 未知参数键报 TOOL_INVALID_PARAM 并点名该键（含误传的 root 与拼错的键）', () => {
  for (const unknownKey of ['root', 'tavk', 'Task', 'worke']) {
    assert.throws(
      () => executeExpertBrief(makeArgs({ [unknownKey]: 'x' })),
      (error) => {
        assert.ok(error instanceof ToolSpecError, `${unknownKey} 应抛 ToolSpecError`)
        assert.equal(error.code, TOOL_ERROR_CODES.INVALID_PARAM)
        assert.equal(error.param, unknownKey, `错误应点名参数 ${unknownKey}`)
        assert.match(error.message, new RegExp(unknownKey))
        assert.match(error.message, /expert/, '应列出可用参数')
        assert.match(error.message, /Fix:/)
        return true
      },
      `未知键 ${unknownKey} 必须被拒`,
    )
  }

  // 误传 root 时，Fix 要指向真正的传法（第二个参数 / buildToolSpec 的 config）
  assert.throws(
    () => executeExpertBrief(makeArgs({ root: '/tmp/x' })),
    (error) => {
      assert.match(error.message, /executeExpertBrief\(args, \{ root \}\)/, '要告诉调用方 root 的正确传法')
      assert.match(error.message, /buildToolSpec\(\{ root \}\)/)
      return true
    },
  )

  // 多个未知键要全部列出（只报第一个会让调用方改一轮跑一轮）
  assert.throws(
    () => executeExpertBrief(makeArgs({ aaa: 1, bbb: 2 })),
    (error) => {
      assert.match(error.message, /aaa/)
      assert.match(error.message, /bbb/)
      return true
    },
  )

  // 白名单内的键不受影响（含可选键的显式 undefined）
  const text = executeExpertBrief(makeArgs({ scopes: undefined, task_id: undefined })).content[0].text
  assert.ok(text.includes('（未指定 task id）'))
})

// ————————————————————— S1：slug 形状错误在工具边界被翻译 —————————————————————

test('S1: expert「规范化后为空」抛 ToolSpecError(param=expert)，码落在 TOOL_ERROR_CODES 内', () => {
  const knownCodes = Object.values(TOOL_ERROR_CODES)

  for (const badExpert of ['.md', '/', '///', './', '\\', ' ./ ', '/.md/']) {
    assert.throws(
      () => executeExpertBrief(makeArgs({ expert: badExpert })),
      (error) => {
        assert.ok(error instanceof ToolSpecError, `expert=${JSON.stringify(badExpert)} 应是 ToolSpecError 而不是下层 PersonaError`)
        assert.equal(error.param, 'expert', `expert=${JSON.stringify(badExpert)} 必须点名参数 expert`)
        assert.ok(knownCodes.includes(error.code), `码必须纳入 TOOL_ERROR_CODES，实际：${error.code}`)
        assert.match(error.message, /expert/)
        assert.match(error.message, /Fix:/)
        assert.equal(typeof error.cause?.code, 'string', '原始错误要挂在 cause 上，诊断信息不丢')
        assert.match(error.cause.code, /^PERSONA_/, 'cause 应是 persona 层的错误码')
        return true
      },
      `expert=${JSON.stringify(badExpert)} 必须被翻译成带参数名的工具层错误`,
    )
  }
})

test('execute: worker / task_id 给了非字符串时报错点名（不静默忽略）', () => {
  assertToolError(() => executeExpertBrief(makeArgs({ worker: 7 })), 'worker')
  assertToolError(() => executeExpertBrief(makeArgs({ task_id: 8 })), 'task_id')

  // 空串视为「未提供」，走缺省 —— 不报错
  const text = executeExpertBrief(makeArgs({ worker: '', task_id: '   ' })).content[0].text
  assert.ok(text.startsWith(`你是 Agent Teams 里的 ${DEFAULT_WORKER}。`))
  assert.ok(text.includes('（未指定 task id）'))
})

// ————————————————————— S3：验收命令里的三反引号不破坏围栏 —————————————————————

test('S3: verify 含行首三反引号时围栏自动加长，命令内容逐字节保留', () => {
  const verify = 'node --test\n```\necho 逃逸'
  const text = executeExpertBrief(makeArgs({ verify })).content[0].text

  // 1) 无损：验收命令整段原样还在（worker 仍可直接复制去跑）
  assert.ok(text.includes(verify), 'verify 必须逐字节保留，不能被转义成别的东西')

  // 2) 结构：verify 所在代码块的开/闭围栏都要比内容最长的反引号串更长（4+）
  const lines = text.split('\n')
  const at = lines.findIndex(
    (line, index) =>
      line === 'node --test' && lines[index + 1] === '```' && lines[index + 2] === 'echo 逃逸',
  )
  assert.notEqual(at, -1, '验收命令应原样出现在任务书里')

  assert.match(lines[at - 1] ?? '', /^`{4,}bash$/, '开启围栏应加长到 4 个以上反引号并保留 bash 信息串')
  assert.match(lines[at + 3] ?? '', /^`{4,}$/, '闭合围栏应与开启同宽')

  // 3) 原来会被挤出围栏的 `echo 逃逸`，现在必须在代码块内：
  //    即「更长的开启围栏」出现在它之前，且中间没有更短的闭合行把它截断
  const openIndex = at - 1
  const between = lines.slice(openIndex, at + 3)
  assert.equal(between.length, 4, '代码块应恰好包住 3 行验收命令')
  assert.ok(!between.slice(1, 3).some((line) => /^`{4,}[ \t]*$/.test(line)), '块内不应出现同宽闭合行')
})

test('S3: 普通单行 / 行内反引号 verify 不被改写（不做多余加工）', () => {
  const plain = executeExpertBrief(makeArgs({ verify: VERIFY })).content[0].text
  assert.match(plain, /```bash\nnode --test dsh-expert-team-kit\/test\/\n```/, '常规命令仍是 3 反引号围栏')

  const inline = 'node -e "console.log(`hi`)"'
  const text = executeExpertBrief(makeArgs({ verify: inline })).content[0].text
  assert.ok(text.includes(inline), '行内反引号不算围栏截断，内容原样保留')
  assert.match(text, /```bash\n[\s\S]*\n```/, '围栏仍是 3 个反引号')
})

test('S3: verify 含 4 个反引号时围栏加到 5 个（比内容更长，不是固定 4 个）', () => {
  const verify = 'run:\n````\ninner\n````'
  const text = executeExpertBrief(makeArgs({ verify })).content[0].text

  assert.ok(text.includes(verify), '内容逐字节保留')
  const lines = text.split('\n')

  // 定位「verify 第一行」且它的上一行是开启围栏（不能只找 ```` 行 —— 内容里也有一行 ````）
  const at = lines.findIndex(
    (line, index) =>
      line === 'run:' &&
      /^`{3,}bash$/.test(lines[index - 1] ?? '') &&
      lines[index + 1] === '````' &&
      lines[index + 2] === 'inner',
  )
  assert.notEqual(at, -1, '验收命令应被包在 ```bash 代码块里')

  const openLine = lines[at - 1] ?? ''
  const open = /^(`{3,})bash$/.exec(openLine)
  assert.ok(open, `开启围栏应是 \`\`\`bash 形态，实际：${openLine}`)
  assert.ok(
    open[1].length >= 5,
    `围栏应长于内容里最长的 4 个反引号，实际宽度 ${open[1].length}`,
  )
  assert.equal(lines[at + 4] ?? '', open[1], '闭合围栏应与开启同宽')
})

// ——————————————————————————— 4. 纯函数 / 依赖方向 ———————————————————————————

test('execute: 同参数多次调用产出逐字节相同（纯函数，无隐藏状态）', () => {
  const first = executeExpertBrief(makeArgs()).content[0].text
  const second = executeExpertBrief(makeArgs()).content[0].text

  assert.equal(first, second, 'execute 必须是纯函数：同参数同输出')
  assert.equal(typeof first, 'string')
})

test('依赖方向: lib/tool.mjs、bin/expert-brief.mjs 不 import 宿主包（index.js 例外）', () => {
  const files = ['../../lib/tool.mjs', '../../bin/expert-brief.mjs']

  for (const relative of files) {
    const source = fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

    assert.ok(
      !/from\s+['"]@deepseek-ai\//.test(source),
      `${relative} 不得 import @deepseek-ai/*（内层一旦依赖宿主，单测与 CLI 就得拉起宿主）`,
    )
    assert.ok(
      !/require\(\s*['"]@deepseek-ai\//.test(source),
      `${relative} 不得 require @deepseek-ai/*`,
    )
    assert.ok(
      !/from\s+['"]cordis['"]/.test(source),
      `${relative} 不得 import cordis（工具规格是纯数据，不需要框架类型）`,
    )
  }

  // 插件入口必须用宿主 defineTool：裸对象塞进 ctx.tools.register 不会出现在工具表里
  const indexSource = fs.readFileSync(fileURLToPath(new URL('../../lib/index.js', import.meta.url)), 'utf8')
  assert.match(
    indexSource,
    /import \{ defineTool \} from '@deepseek-ai\/dsh-tools'/,
    'index.js 必须用宿主 defineTool 构造工具定义（裸对象不会被宿主投影成可用工具）',
  )
  assert.match(indexSource, /output:\s*\{/, 'index.js 的定义必须带 output（schema + render）')
})

test('人格素材环境问题原样透传（不被误报成入参错误）', () => {
  const missingRoot = path.join(os.tmpdir(), `dsh-expert-kit-nope-${process.pid}-${Date.now()}`)
  const spec = buildToolSpec({ root: missingRoot })

  assert.throws(
    () => spec.execute(makeArgs()),
    (error) => {
      assert.ok(error instanceof PersonaError, '素材目录问题应是 PersonaError，而不是 ToolSpecError')
      // 不写死 ROOT_MISSING：只要求它仍落在 persona 层错误族里（并行返工可能新增码）
      assert.match(error.code, /^PERSONA_/)
      return true
    },
  )
})

// ——————————————————————————— 5. 插件入口 ———————————————————————————

test('lib/index.js: name / inject / apply 形状正确，apply 注册的工具名是 expert_brief', { skip: NO_HOST }, async () => {
  assert.equal(pluginName, 'expert-team-kit')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')

  /** @type {unknown[]} */
  const registered = []
  const ctx = { tools: { register: (spec) => registered.push(spec) } }

  apply(ctx)

  assert.equal(registered.length, 1, 'apply 必须注册恰好一个工具')
  assert.equal(registered[0].name, 'expert_brief')
  assert.equal(typeof registered[0].execute, 'function')
  // 宿主要求定义带 output（schema + render），否则不会被投影成可用工具
  assert.equal(typeof registered[0].output?.render, 'function', '定义必须带 output.render')

  // 注册的定义真的可执行（不是空壳）。defineTool 会把 execute 包成异步，
  // 返回值再经 output.render 收敛为渲染后的文本。
  const raw = registered[0].execute(makeArgs())
  const value = raw instanceof Promise ? await raw : raw
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) ? (value[0]?.text ?? '') : (value?.content?.[0]?.text ?? '')
  assert.equal(typeof text, 'string')
  assert.ok(text.includes(PERSONA_MARKER), 'execute 必须真的产出任务书正文')

  // ctx.effect 存在时应经由它注册（跟随插件生命周期释放）
  const viaEffect = []
  const ctxWithEffect = {
    tools: { register: (spec) => viaEffect.push(spec) },
    effect: (fn) => fn(),
  }
  apply(ctxWithEffect)
  assert.equal(viaEffect.length, 1, 'ctx.effect 可用时应在 effect 内注册')
})

test('lib/index.js: ctx 缺 tools.register 时直接抛可操作错误，而不是静默跳过', { skip: NO_HOST }, () => {
  for (const badCtx of [undefined, null, {}, { tools: {} }, { tools: { register: 'nope' } }]) {
    assert.throws(() => apply(badCtx), /ctx\.tools\.register/, `ctx=${JSON.stringify(badCtx)} 必须抛错`)
  }
})

test('回归: index.js 不得解构 tools.register（会丢 this，注册表抛 layers 未定义）', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../lib/index.js', import.meta.url)), 'utf8')

  // 真实注册表内部读 this.layers：把 register 解构出来再调用会抛
  // "Cannot read properties of undefined (reading 'layers')"，而该异常被 cordis
  // 吞进 fiber —— 症状是「插件装上了但工具表里没有」，没有可见报错。
  assert.ok(
    !/const\s+register\s*=\s*ctx\??\.tools\??\.register/.test(source),
    'index.js 不得把 tools.register 解构到局部变量后再调用（丢 this）',
  )
  assert.match(
    source,
    /tools\.register\(definition\)/,
    '必须通过 tools.register(...) 调用以保住 this 绑定',
  )
})

// ——————————————————————————— 6. CLI ———————————————————————————

/**
 * 跑一次 CLI。
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('CLI: --help 退出码 0，用法打 stdout', () => {
  for (const flag of ['--help', '-h']) {
    const { status, stdout, stderr } = runCli([flag])

    assert.equal(status, 0, `${flag} 退出码应为 0`)
    assert.match(stdout, /用法/, '--help 应打印用法')
    assert.match(stdout, /--expert/, '用法要列出 --expert')
    assert.match(stdout, /--verify/, '用法要列出 --verify')
    assert.match(stdout, /--task-file/, '用法要列出 --task-file')
    assert.match(stdout, /--scope/, '用法要列出 --scope')
    assert.match(stdout, /退出码/, '用法要说明退出码约定')
    assert.equal(stderr, '', '--help 是成功路径，stderr 应为空')
  }
})

test('N3: --help 优先于其它参数 —— 即使别的选项有错也只打印用法并退出 0', () => {
  const cases = [
    ['--help', '--nope'], // 未知选项
    ['--help', '--task'], // 缺值的选项
    ['--expert', 'code-reviewer', '--help'], // 参数合法也照样只打用法
    ['-h', '--nope'],
    ['--task', TASK, '-h', '--verify'], // 缺值 + -h
  ]

  for (const args of cases) {
    const { status, stdout, stderr } = runCli(args)

    assert.equal(status, 0, `--help 应无条件成功，args=${JSON.stringify(args)}，stderr=${stderr}`)
    assert.equal(stderr, '', `--help 是成功路径，stderr 应为空，args=${JSON.stringify(args)}`)
    assert.match(stdout, /用法/, `应打印用法，args=${JSON.stringify(args)}`)
    assert.ok(!stdout.includes('缺少必填参数'), '--help 不该落到「缺参数」分支')
  }

  // 对照：不带 --help 时同样的错误参数仍然失败（不是把错误全吞了）
  assert.equal(runCli(['--nope']).status, 1)
  assert.equal(runCli(['--task']).status, 1)

  // `--help=1` 这种给 help 带值的写法仍算意图错误
  const withValue = runCli(['--help=1'])
  assert.equal(withValue.status, 1)
  assert.match(withValue.stderr, /--help/)
})

test('CLI: 缺必填参数退出码 1，stderr 列出缺失项并提示 --help', () => {
  const { status, stdout, stderr } = runCli([])

  assert.equal(status, 1, '缺参数退出码应为 1')
  assert.equal(stdout, '', '失败时 stdout 必须为空（不许把半份任务书当产物）')
  assert.match(stderr, /缺少必填参数/)
  assert.match(stderr, /--expert/)
  assert.match(stderr, /--verify/)
  assert.match(stderr, /--help/, '要提示去看 --help')

  // 只缺 verify 时，不该把 --expert 也列成缺失项
  const partial = runCli(['--expert', 'code-reviewer', '--task', TASK])
  assert.equal(partial.status, 1)
  assert.match(partial.stderr, /--verify/)
  assert.match(partial.stderr, /缺少必填参数/)
})

test('CLI: 正常参数退出码 0，stdout 是完整任务书', () => {
  const { status, stdout, stderr } = runCli([
    '--expert',
    'engineering-software-architect',
    '--task',
    TASK,
    '--verify',
    VERIFY,
    '--scope',
    'dsh-expert-team-kit/lib/tool.mjs',
    '--task-id',
    'task-8',
    '--worker',
    'worker-tool',
  ])

  assert.equal(status, 0, `CLI 应成功，stderr=${stderr}`)
  assert.equal(stderr, '', '成功时 stderr 应为空')

  assert.ok(stdout.trim().length > 500, 'stdout 应是完整任务书')
  assert.ok(stdout.includes('# Software Architect Agent'), '全名写法应解析到 Software Architect 人格')
  assert.ok(stdout.includes(TASK), '任务正文原样出现')
  assert.ok(stdout.includes(VERIFY), '验收命令原样出现')
  assert.ok(stdout.includes('- dsh-expert-team-kit/lib/tool.mjs'), '--scope 生效')
  assert.ok(stdout.includes('`task-8`'), '--task-id 生效')
  assert.ok(stdout.startsWith('你是 Agent Teams 里的 worker-tool。'), '--worker 生效')
  assert.ok(stdout.endsWith('\n'), 'stdout 应以换行结尾（可直接重定向成文件）')
})

test('CLI: --task-file 生效；与 --task 同给时报错退出码 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-expert-kit-cli-'))
  const taskFile = path.join(dir, 'task.md')

  try {
    const fileTask = '任务来自文件：只改 lib/tool.mjs。'
    fs.writeFileSync(taskFile, `${fileTask}\n`, 'utf8')

    const ok = runCli([
      '--expert',
      'code-reviewer',
      '--task-file',
      taskFile,
      '--verify',
      VERIFY,
    ])
    assert.equal(ok.status, 0, `--task-file 应成功，stderr=${ok.stderr}`)
    assert.ok(ok.stdout.includes(fileTask), '任务内容应来自文件')

    const conflict = runCli([
      '--expert',
      'code-reviewer',
      '--task',
      'inline task text',
      '--task-file',
      taskFile,
      '--verify',
      VERIFY,
    ])
    assert.equal(conflict.status, 1, '--task 与 --task-file 同给应失败')
    assert.equal(conflict.stdout, '')
    assert.match(conflict.stderr, /--task/)
    assert.match(conflict.stderr, /--task-file/)

    // 文件不存在：报错要指出文件路径与修法
    const missing = runCli([
      '--expert',
      'code-reviewer',
      '--task-file',
      path.join(dir, 'nope.md'),
      '--verify',
      VERIFY,
    ])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /nope\.md/)
    assert.match(missing.stderr, /--task/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: 未知参数 / 参数缺值时退出码 1 并指出是哪个选项', () => {
  const unknown = runCli(['--expert', 'code-reviewer', '--task', TASK, '--verify', VERIFY, '--nope', 'x'])
  assert.equal(unknown.status, 1)
  assert.equal(unknown.stdout, '')
  assert.match(unknown.stderr, /--nope/, '必须点名未知选项')

  const missingValue = runCli(['--expert', 'code-reviewer', '--task', TASK, '--verify'])
  assert.equal(missingValue.status, 1)
  assert.equal(missingValue.stdout, '')
  assert.match(missingValue.stderr, /--verify/, '必须点名缺值的选项')

  const positional = runCli(['code-reviewer'])
  assert.equal(positional.status, 1)
  assert.match(positional.stderr, /位置参数/)
})

test('CLI: 未知专家退出码 1，stderr 给出候选（不把路径错误当成功）', () => {
  const { status, stdout, stderr } = runCli([
    '--expert',
    'code-reviewr',
    '--task',
    TASK,
    '--verify',
    VERIFY,
  ])

  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /expert/)
  assert.match(stderr, /code-reviewer/, '应给出最接近的候选')
})

test('CLI: 重复 --scope 逐条进入写作用域', () => {
  const { status, stdout } = runCli([
    '--expert',
    'code-reviewer',
    '--task',
    TASK,
    '--verify',
    VERIFY,
    '--scope',
    'dsh-expert-team-kit/lib/tool.mjs',
    '--scope',
    'dsh-expert-team-kit/test/tool.test.mjs',
  ])

  assert.equal(status, 0)
  assert.ok(stdout.includes('- dsh-expert-team-kit/lib/tool.mjs'))
  assert.ok(stdout.includes('- dsh-expert-team-kit/test/tool.test.mjs'))
})

// ——————————— T2-E：surface / kind 透传（含三类 surface 的收尾协议）———————————

/**
 * 从任务书顶部抠出任务字段 JSON 并解析（定位方式不写死围栏长度）。
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseTopFieldSpec(text) {
  const banner = '以下 JSON 必须原样写进任务字段，否则门禁不生效'
  const at = text.indexOf(banner)
  assert.notEqual(at, -1, '任务书顶部必须有任务字段 JSON 的固定提示语')

  const rest = text.slice(at)
  const open = /^(`{3,})json$/m.exec(rest)
  assert.ok(open, '提示语之后必须紧跟 ```json 代码块')
  const openLineEnd = rest.indexOf(open[0]) + open[0].length
  const closeAt = rest.indexOf(`\n${open[1]}`, openLineEnd)
  assert.notEqual(closeAt, -1, 'JSON 代码块必须闭合')
  return JSON.parse(rest.slice(openLineEnd, closeAt).trim())
}

test('E: surface / kind 作为可选参数透传到任务字段 JSON', () => {
  for (const surface of ['none', 'official', 'agent-teams']) {
    for (const kind of ['implementation', 'review', 'work']) {
      const text = executeExpertBrief(makeArgs({ surface, kind })).content[0].text
      const fieldSpec = parseTopFieldSpec(text)

      assert.equal(fieldSpec.surface, surface, `surface=${surface} 必须原样进任务字段`)
      assert.equal(fieldSpec.kind, kind, `kind=${kind} 必须原样进任务字段`)
    }
  }
})

test('E: 不传 surface 时任务书不出现 team_task_get（默认 none，向后兼容）', () => {
  const text = executeExpertBrief(makeArgs()).content[0].text

  assert.equal(parseTopFieldSpec(text).surface, 'none', 'surface 缺省必须是 none')
  assert.equal(parseTopFieldSpec(text).kind, 'implementation', 'kind 缺省必须是 implementation')
  assert.ok(!text.includes('team_task_get'), '默认不该让队友去调本机不存在的 team_task_get')
  assert.ok(!text.includes('team_task_update'), '默认不该出现 team_task_update')
  assert.ok(!text.includes('agent_teams_claim_task({'), '默认不该出现 agent_teams_claim_task 调用')
  assert.match(text.slice(text.indexOf('## 5. 工作流程')), /第 6 节/, '必须给出收尾指引')
})

test('E: surface=official / agent-teams 各自生成对应协议（互不混入）', () => {
  const official = executeExpertBrief(makeArgs({ surface: 'official' })).content[0].text
  assert.match(official, /team_task_get\(\{task_id:"task-8"\}\)/)
  assert.ok(!official.includes('agent_teams_claim_task('), 'official 不该出现 agent-teams 调用')

  const agentTeams = executeExpertBrief(makeArgs({ surface: 'agent-teams' })).content[0].text
  assert.match(agentTeams, /agent_teams_claim_task\(\{task_id:"task-8", assignee:"worker-tool"\}\)/)
  assert.match(agentTeams, /agent_teams_complete_task\(\{task_id:"task-8", attempt_id:/)
  assert.ok(!agentTeams.includes('team_task_get'), 'agent-teams 不该出现 team_task_get')
})

test('E: surface / kind 非法值抛 INVALID_PARAM 并点名参数（不静默退回缺省）', () => {
  for (const badSurface of ['agent_teams', 'Agent-Teams', 'team', '']) {
    if (badSurface === '') continue // 空串 = 没填，属合法
    assertToolError(
      () => executeExpertBrief(makeArgs({ surface: badSurface })),
      'surface',
      /agent-teams/,
    )
  }

  for (const badKind of ['impl', 'Implementation', 'coding']) {
    assertToolError(() => executeExpertBrief(makeArgs({ kind: badKind })), 'kind', /implementation/)
  }

  // 非字符串同样拒绝（静默忽略会让调用方以为传进去了）
  assertToolError(() => executeExpertBrief(makeArgs({ surface: 1 })), 'surface')
  assertToolError(() => executeExpertBrief(makeArgs({ kind: true })), 'kind')
})

test('E: surface / kind 传空串或空白视同「未提供」，走缺省值', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const text = executeExpertBrief(makeArgs({ surface: blank, kind: blank })).content[0].text
    const fieldSpec = parseTopFieldSpec(text)

    assert.equal(fieldSpec.surface, 'none', `surface=${JSON.stringify(blank)} 应缺省成 none`)
    assert.equal(fieldSpec.kind, 'implementation', `kind=${JSON.stringify(blank)} 应缺省成 implementation`)
  }
})

test('CLI: --surface / --kind 生效（含 --surface=official 的等号写法）', () => {
  const spaced = runCli([
    '--expert',
    'code-reviewer',
    '--task',
    TASK,
    '--verify',
    VERIFY,
    '--surface',
    'agent-teams',
    '--kind',
    'review',
  ])
  assert.equal(spaced.status, 0, `CLI 应成功，stderr=${spaced.stderr}`)
  const spacedSpec = parseTopFieldSpec(spaced.stdout)
  assert.equal(spacedSpec.surface, 'agent-teams')
  assert.equal(spacedSpec.kind, 'review')
  assert.match(spaced.stdout, /agent_teams_claim_task\(\{task_id:"（未指定 task id）", assignee:"worker"\}\)/)

  const inline = runCli([
    '--expert',
    'code-reviewer',
    '--task',
    TASK,
    '--verify',
    VERIFY,
    '--surface=official',
  ])
  assert.equal(inline.status, 0, `--surface=official 应成功，stderr=${inline.stderr}`)
  assert.equal(parseTopFieldSpec(inline.stdout).surface, 'official')
})

test('CLI: --surface 非法值退出码 1，stderr 点名 surface 并列出允许值', () => {
  const { status, stdout, stderr } = runCli([
    '--expert',
    'code-reviewer',
    '--task',
    TASK,
    '--verify',
    VERIFY,
    '--surface',
    'agent_teams',
  ])

  assert.equal(status, 1, '非法 surface 必须失败，不能静默退回 none')
  assert.equal(stdout, '', '失败时 stdout 必须为空')
  assert.match(stderr, /surface/)
  assert.match(stderr, /agent-teams/, '要列出允许值')
})

test('CLI: --help 列出 --surface 与 --kind', () => {
  const { status, stdout } = runCli(['--help'])
  assert.equal(status, 0)
  assert.match(stdout, /--surface/)
  assert.match(stdout, /--kind/)
  assert.match(stdout, /none（默认/, '用法里要写清 surface 默认 none')
})
