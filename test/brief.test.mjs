import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBrief } from '../lib/brief.mjs'
import { PersonaError, resolvePersona } from '../lib/persona.mjs'

const VERIFY = 'node --test dsh-expert-team-kit/test/'
const TASK = '在 dsh-expert-team-kit 下实现 persona 解析与任务书生成。'

/** 取真实人格正文里的一句特征串，用来断言「正文整段」真的被贴进去了。 */
const PERSONA_BODY_MARKER = '# Code Reviewer Agent'

function makeBrief(overrides = {}) {
  return buildBrief({
    slug: 'code-reviewer',
    task: TASK,
    verify: VERIFY,
    scopes: ['dsh-expert-team-kit/lib/persona.mjs', 'dsh-expert-team-kit/test/persona.test.mjs'],
    taskId: 'task-7',
    workerName: 'worker-lib',
    ...overrides,
  })
}

/** 章节顺序断言用：拿到某个锚点的位置。 */
function indexOfOrFail(text, needle) {
  const index = text.indexOf(needle)
  assert.notEqual(index, -1, `任务书应包含锚点：${needle}`)
  return index
}

test('buildBrief: 缺 task 抛 Error 且信息点名 task', () => {
  assert.throws(
    () => buildBrief({ slug: 'code-reviewer', verify: VERIFY }),
    (error) => {
      assert.ok(error instanceof Error, '必须抛 Error')
      assert.match(error.message, /task/, '错误信息必须点名 task 字段')
      assert.match(error.message, /Fix:/, '错误信息必须给修复动作')
      return true
    },
  )

  // 空串 / 纯空白同样算缺失
  for (const emptyTask of ['', '   ', null, 123]) {
    assert.throws(
      () => buildBrief({ slug: 'code-reviewer', task: emptyTask, verify: VERIFY }),
      (error) => {
        assert.match(error.message, /task/)
        return true
      },
      `task=${JSON.stringify(emptyTask)} 必须抛错`,
    )
  }
})

test('buildBrief: 缺 verify 抛 Error 且信息点名 verify', () => {
  assert.throws(
    () => buildBrief({ slug: 'code-reviewer', task: TASK }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /verify/, '错误信息必须点名 verify 字段')
      assert.match(error.message, /Fix:/)
      return true
    },
  )

  for (const emptyVerify of ['', '   ', undefined]) {
    assert.throws(
      () => buildBrief({ slug: 'code-reviewer', task: TASK, verify: emptyVerify }),
      (error) => {
        assert.match(error.message, /verify/)
        return true
      },
      `verify=${JSON.stringify(emptyVerify)} 必须抛错`,
    )
  }
})

test('buildBrief: task 优先于 persona 校验（不让最常见错误先去扫文件系统）', () => {
  // 既没 task 也没 persona：先报 task，说明校验顺序稳定
  assert.throws(
    () => buildBrief({}),
    (error) => {
      assert.match(error.message, /task/)
      return true
    },
  )
})

test('buildBrief: 既没有 persona 也没有 slug 时抛错并给出两种修法', () => {
  assert.throws(
    () => buildBrief({ task: TASK, verify: VERIFY }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /persona/)
      assert.match(error.message, /slug/)
      assert.match(error.message, /Fix:/)
      return true
    },
  )
})

test('buildBrief: 完整任务书依次包含 9 个必需段', () => {
  const text = makeBrief()

  // 1) worker 名 + task id 打头
  assert.ok(
    text.startsWith('你是 Agent Teams 里的 worker-lib。'),
    `任务书应以 worker 名开头，实际开头：${JSON.stringify(text.slice(0, 40))}`,
  )
  assert.ok(text.includes('`task-7`'), '开头必须带 task id')

  // 2..9) 章节顺序
  const order = [
    '## 0. 你的专家人格',
    '## 1. 人格裁剪',
    '## 2. 任务',
    '## 3. 验收命令（必须自己跑一遍）',
    '## 4. 写作用域（只碰这些路径）',
    '## 5. 工作流程（5 步，顺序不要乱）',
    '## 6. 回报格式（严格 4 行，不要其它内容）',
  ]
  const positions = order.map((needle) => indexOfOrFail(text, needle))
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i - 1] < positions[i],
      `章节顺序错了：${order[i - 1]} 应早于 ${order[i]}`,
    )
  }

  return text
})

test('buildBrief: 人格名 + 人格正文整段都在任务书里', () => {
  const text = makeBrief()
  const persona = resolvePersona('code-reviewer')

  assert.ok(text.includes(`人格名：${persona.name}`), '必须写出人格名')
  assert.ok(text.includes(PERSONA_BODY_MARKER), '人格正文的 H1 必须在任务书里')

  // 正文整段：随机抽正文里的中间段落，逐段核对（防「只贴了标题」）
  const paragraphs = persona.body
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 40)
  assert.ok(paragraphs.length >= 3, '真实人格正文应有多个段落')
  for (const paragraph of paragraphs.slice(0, 5)) {
    assert.ok(text.includes(paragraph), `人格正文段落缺失：${paragraph.slice(0, 40)}…`)
  }

  // 正文必须落在「专家人格」段内、裁剪段之前
  const bodyIndex = text.indexOf(PERSONA_BODY_MARKER)
  assert.ok(indexOfOrFail(text, '## 0. 你的专家人格') < bodyIndex, '正文应在人格段之后')
  assert.ok(bodyIndex < indexOfOrFail(text, '## 1. 人格裁剪'), '正文应在裁剪段之前')
})

test('buildBrief: 任务正文与验收命令原样出现', () => {
  const text = makeBrief()

  assert.ok(text.includes(TASK), '任务正文必须原样出现')
  assert.ok(text.includes(VERIFY), '验收命令必须原样出现')
  assert.match(text, /```bash\nnode --test dsh-expert-team-kit\/test\/\n```/, '验收命令应在 bash 代码块里')

  const taskIndex = indexOfOrFail(text, '## 2. 任务')
  const verifyIndex = indexOfOrFail(text, '## 3. 验收命令')
  assert.ok(text.indexOf(TASK) > taskIndex, '任务正文应在本节内')
  assert.ok(text.indexOf(VERIFY) > verifyIndex, '验收命令应在本节内')
})

test('buildBrief: 写作用域逐个列出；空数组写「无」', () => {
  const scopes = ['dsh-expert-team-kit/lib/brief.mjs', 'dsh-expert-team-kit/test/brief.test.mjs']
  const text = makeBrief({ scopes })

  for (const scope of scopes) {
    assert.ok(text.includes(`- ${scope}`), `写作用域应逐条列出：${scope}`)
  }

  const empty = makeBrief({ scopes: [] })
  assert.ok(empty.includes('- 无'), '空 scopes 必须写「无」')
  assert.ok(!empty.includes('- dsh-expert-team-kit/lib/brief.mjs'), '空 scopes 不该出现任何路径')

  // 未提供 scopes 等价于空数组
  assert.ok(makeBrief({ scopes: undefined }).includes('- 无'))
  // 单个字符串也接受（懒人写法不报错）
  assert.ok(makeBrief({ scopes: 'lib/only.mjs' }).includes('- lib/only.mjs'))
})

test('buildBrief: 5 步流程含 team_task_get / claim / complete', () => {
  const text = makeBrief()

  assert.match(text, /team_task_get\(\{task_id:"task-7"\}\)/, '第 1 步要读任务拿 revision')
  assert.match(text, /expected_revision/, '流程里要出现 expected_revision')
  assert.match(text, /action:"claim"/, '第 2 步要 claim')
  assert.match(text, /action:"complete"/, '第 5 步要 complete')

  const flow = text.slice(indexOfOrFail(text, '## 5. 工作流程'))
  const steps = flow.match(/^\d+\. /gm) ?? []
  assert.equal(steps.length, 5, `流程必须正好 5 步，实际 ${steps.length} 步`)
})

test('buildBrief: 回报格式默认 4 行，缺省标签覆盖人格名/文件/退出码/status', () => {
  const text = makeBrief()

  assert.ok(text.includes('严格 4 行'), '回报格式要声明行数')
  assert.ok(text.includes('1) 你 read 到的人格名'))
  assert.ok(text.includes('2) 创建/修改的文件路径'))
  assert.ok(text.includes('3) 验收命令的退出码 + pass/fail 计数'))
  assert.ok(text.includes('4) task-7 最终 status 与 revision'), '第 4 行要带 task id')
  assert.ok(!text.includes('5) '), '默认只有 4 行')
})

test('buildBrief: reportLines 支持自定义标签数组', () => {
  const text = makeBrief({ reportLines: ['人格名（原样）', '改了哪些文件'] })

  assert.ok(text.includes('严格 2 行'), '自定义标签应改变行数声明')
  assert.ok(text.includes('1) 人格名（原样）'))
  assert.ok(text.includes('2) 改了哪些文件'))
  assert.ok(
    !text.includes('人格文件的 name 字段'),
    '自定义标签后不该残留缺省标签',
  )
  assert.ok(!text.includes('3) '), '自定义 2 行时不该出现第 3 行')
})

test('buildBrief: reportLines 传数字时按行数裁剪 / 补齐', () => {
  const two = makeBrief({ reportLines: 2 })
  assert.ok(two.includes('严格 2 行'))
  assert.ok(two.includes('1) 你 read 到的人格名'))
  assert.ok(!two.includes('3) '), '只要 2 行时不该出现第 3 行')

  const six = makeBrief({ reportLines: 6 })
  assert.ok(six.includes('严格 6 行'))
  assert.ok(six.includes('补充说明 1'), '超过缺省 4 行时要补齐行')
  assert.ok(six.includes('补充说明 2'))
})

test('buildBrief: reportLines / scopes 非法输入抛可操作错误', () => {
  assert.throws(() => makeBrief({ reportLines: 0 }), /reportLines/)
  assert.throws(() => makeBrief({ reportLines: -1 }), /reportLines/)
  assert.throws(() => makeBrief({ reportLines: 1.5 }), /reportLines/)
  assert.throws(() => makeBrief({ reportLines: 'four' }), /reportLines/)
  assert.throws(() => makeBrief({ reportLines: ['ok', ''] }), /reportLines\[1\]/)

  assert.throws(() => makeBrief({ scopes: 123 }), /scopes/)
  assert.throws(() => makeBrief({ scopes: [{ path: 'x' }] }), /scopes\[0\]/)
  assert.throws(() => makeBrief({ scopes: ['  '] }), /scopes\[0\]/)
})

test('buildBrief: persona 直接传 resolvePersona 结果时不再解析文件系统', () => {
  const persona = resolvePersona('code-reviewer')
  const text = makeBrief({ slug: undefined, persona })

  assert.ok(text.includes(`人格名：${persona.name}`))
  assert.ok(text.includes(PERSONA_BODY_MARKER))
  assert.ok(text.includes(persona.path), '人格来源应写出文件路径')
})

test('buildBrief: persona 形状非法时抛错（空正文 / 非对象）', () => {
  assert.throws(
    () => makeBrief({ slug: undefined, persona: { name: 'X' } }),
    /persona\.body/,
    '缺 body 的 persona 必须被拒（否则任务书里没有人格正文）',
  )

  for (const badPersona of ['code-reviewer', 123, []]) {
    assert.throws(() => makeBrief({ slug: undefined, persona: badPersona }), /persona/)
  }
})

test('buildBrief: slug 不存在时透传 PersonaError（错误码不被吞）', () => {
  assert.throws(
    () => buildBrief({ slug: 'no-such-expert', task: TASK, verify: VERIFY }),
    (error) => {
      assert.ok(error instanceof PersonaError, '人格解析失败必须是 PersonaError')
      assert.equal(error.code, 'PERSONA_NOT_FOUND')
      return true
    },
  )
})

test('buildBrief: 同参数多次调用结果稳定（纯函数，无隐藏状态）', () => {
  const first = makeBrief()
  const second = makeBrief()
  assert.equal(first, second, 'buildBrief 必须是纯函数')
  assert.equal(typeof first, 'string')
})

test('buildBrief: taskId / workerName 缺失时有明确缺省，而非 undefined 字样', () => {
  const text = buildBrief({ slug: 'code-reviewer', task: TASK, verify: VERIFY })

  assert.ok(text.startsWith('你是 Agent Teams 里的 worker。'), 'workerName 缺省为 worker')
  assert.ok(text.includes('（未指定 task id）'), 'taskId 缺省应显式标注')
  // 只查「缺省值被渲染成 undefined」这几个具体位置。
  // 全局禁用 undefined 会误报：任务正文里合法提到 undefined 是正常内容（N2）。
  assert.ok(!text.includes('人格名：undefined'), '人格名缺省不该渲染成 undefined')
  assert.ok(!text.includes('人格来源：undefined'), '人格来源缺省不该渲染成 undefined')
  assert.ok(!text.includes('task_id:"undefined"'), 'task id 缺省不该渲染成 undefined')
})

// ——————————————————— S3 / N4 / N5：结构安全与口径一致 ———————————————————

const NL = String.fromCharCode(10)

test('S3: 验收命令含三反引号时，围栏自动加长，内容不会跑出围栏', () => {
  const verify = ['node --test', '```', 'echo 逃逸'].join(NL)
  const text = makeBrief({ verify })

  const section = text.slice(text.indexOf('## 3.'), text.indexOf('## 4.'))
  assert.ok(section.includes('echo 逃逸'), '逃逸内容必须仍留在第 3 节里')

  // 围栏必须比内容里最长的反引号串更长，否则会被提前闭合
  const fenceLine = section.split(NL).find((line) => line.startsWith('```'))
  assert.ok(fenceLine, '应能找到围栏行')
  const fenceLength = fenceLine.length - 'bash'.length
  assert.ok(fenceLength >= 4, `围栏至少 4 个反引号，实际 ${fenceLength}`)

  // 逐一核对：内容里的反引号串都不能等于围栏
  const fence = '`'.repeat(fenceLength)
  for (const run of verify.match(/`+/g) ?? []) {
    assert.notEqual(run, fence, '内容里的反引号串不能等于围栏，否则会提前闭合')
  }
  // 围栏成对出现（开 + 闭）
  assert.equal(section.split(fence).length - 1, 2, '围栏必须成对')
})

test('S3: 内容里出现四反引号时，围栏升级到五个', () => {
  const verify = ['node --test', '````', 'echo 逃逸'].join(NL)
  const text = makeBrief({ verify })
  const section = text.slice(text.indexOf('## 3.'), text.indexOf('## 4.'))
  const fenceLine = section.split(NL).find((line) => line.startsWith('```'))
  const fenceLength = fenceLine.length - 'bash'.length
  assert.ok(fenceLength >= 5, `围栏要超过内容最长反引号串，实际 ${fenceLength}`)
  assert.ok(section.includes('echo 逃逸'))
})

test('N4: taskId 含引号与换行时，生成的调用片段仍是合法 JS 且值可还原', () => {
  const taskId = ['task-"7"', 'import evil'].join(NL)
  const text = makeBrief({ taskId })

  const step = text.split(NL).find((line) => line.includes('action:"claim"'))
  assert.ok(step, '应能定位到 claim 步骤行')

  const snippet = /`([^`]+)`/.exec(step)[1].replace('<revision>', '7')
  let received
  const run = new Function('team_task_update', `return ${snippet}`)
  received = run((args) => args)

  assert.ok(received, '片段必须能被 JS 解析并执行（引号没提前闭合）')
  assert.equal(received.task_id, 'task-"7" import evil', 'task_id 必须原值还原（引号保留、换行被压平）')
  assert.equal(received.action, 'claim')
  assert.equal(received.expected_revision, 7)
})

test('N4: workerName 含换行时不会打断任务书首行', () => {
  const text = makeBrief({ workerName: ['worker', 'lib'].join(NL) })
  const firstLine = text.split(NL)[0]
  assert.equal(firstLine, '你是 Agent Teams 里的 worker lib。任务板上你的任务是 `task-7`。')
  assert.ok(!firstLine.includes(NL), '首行必须是单行')
})

test('N5: scopes 传空串 / 纯空白视同「未提供」，与 tool 层口径一致', () => {
  for (const blank of ['', '   ', NL]) {
    const text = makeBrief({ scopes: blank })
    assert.ok(text.includes('- 无'), `scopes=${JSON.stringify(blank)} 应渲染成「无」`)
  }
  // 但数组里的空项仍然要报错（那是真的写错了，不是「没给」）
  assert.throws(() => makeBrief({ scopes: [''] }), /scopes\[0\]/)
})

test('N2: 任务正文里合法提到 undefined 不应导致假失败', () => {
  // 这正是原断言（全局 !text.includes('undefined')）会假失败的情形
  const task = '检查 undefined 与 null 的处理'
  const text = makeBrief({ task })
  assert.ok(text.includes(task), '任务正文必须原样保留，哪怕里面含 undefined')
})
