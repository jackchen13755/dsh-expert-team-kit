/**
 * dsh-expert-team-kit / test/dispatch-check.test.mjs
 *
 * `dispatch-check` 的测试。
 *
 * 关键约束：**不依赖真机会话数据**。真实会话日志是 `session.v4.jsonl.zstd`（zstd 压缩），
 * 内容随用户使用不断变化，拿它做断言等于把测试绑在某台机器的历史上。所以这里的每个用例都在
 * 临时目录里**造普通 `session.jsonl`**，只保留真实日志里有意义的结构：
 *
 *   <tmpRoot>/<workspace-slug>/session-<uuid>/session.jsonl     ← 父会话
 *   <tmpRoot>/<workspace-slug>/session-<childId>/session.jsonl  ← 子会话（与父同 workspace）
 *
 * 真实形状的取证（写代码时实跑确认过）：
 * - `{"type":"session","id":"session-<uuid>","cwd":"...","delegationDepth":0}` 是首行；
 * - `{"type":"tool/call","data":{"name":"edit","arguments":"<JSON 字符串>","callId":"..."}}`
 *   —— `arguments` 是**字符串**，要二次 `JSON.parse` 才能拿到 `file_path`；
 * - `{"type":"subagent/catalog","data":{"childId":"<uuid>","name":"agent-1","label":"Code review",...}}`
 *   只登记子会话 id，**子 agent 的 tool/call 不在父日志里**。
 *
 * 判定规则的两个方向都钉住：既验「该判 PASS 的判了 PASS」（防误报），也验
 * 「该判 VIOLATION 的判了 VIOLATION」（防漏报：把违规判成通过 = 闸门失效）。
 *
 * `dispatch.persona`（队友 prompt 里有没有专家人格）是**独立的告警维度**：它不进 verdict，
 * 用例既钉住「缺人格照样 PASS」（判定不被它带偏），也钉住「缺人格必须出现在 warnings 与人类
 * 输出里」（不被静默吞掉）。真实事故里命名全对、判定 PASS，人格却一个字节都没进 prompt。
 *
 * **判据已换锚点**：否决条件不再看 `childEdits`（实测子会话日志大多不落盘，拿它当判据会把
 * 「代码确实是子 agent 写的」误判成「子 agent 改 0 次」）。现在看的是**父日志里必然存在的派活证据**：
 * `tool/call` 的 `subagent` / `subagent_fork` / `summon_expert` / `summon_experts` /
 * `summon_expert_team` / `expert_brief`，以及 `subagent/catalog` 登记事件。
 * 子会话日志缺失只降 `attribution.confidence`，不改变 verdict。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// 直接 import 纯函数只用于「人格标记矩阵」这一条：7 个标记走 CLI 要起 7 次子进程，
// 而且断言只能看到聚合结果，标记漏一个也定位不到是哪条。其余用例仍走 spawnSync 端到端。
import { hasPersona } from '../../bin/dispatch-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '..', '..', 'bin', 'dispatch-check.mjs')

// 单个临时基目录，所有用例在里面各建各的 workspace；收尾统一删。
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-check-test-'))
after(() => fs.rmSync(BASE, { recursive: true, force: true }))

let caseSeq = 0
/** 每个用例一个独立根目录，避免用例间互相看见对方的会话（尤其 `latest`）。 */
function freshRoot() {
  caseSeq += 1
  const root = path.join(BASE, `case-${caseSeq}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/**
 * workspace slug 的**独立推导**（故意不 import CLI 的 `workspaceSlugForCwd`）：
 * `/a/b-c/d` → `--a-b-c-d--`（去掉开头 `/`，内部 `/` 换 `-`，两端包 `--`）。
 * 用独立公式才能发现实现里「多一个前导短横线」这类 bug。
 */
function slugFor(cwd) {
  return `--${cwd.replace(/^\/+/, '').split('/').join('-')}--`
}

let callSeq = 0
function toolCall(name, argsValue) {
  callSeq += 1
  return { type: 'tool/call', data: { name, arguments: argsValue, callId: `call-${callSeq}` } }
}

/** 正常的 edit 调用：arguments 是 JSON 字符串，与真实日志一致。 */
function edit(filePath, tool = 'edit') {
  return toolCall(tool, JSON.stringify({ file_path: filePath, old_string: 'a', new_string: 'b' }))
}

function catalog(childId, name) {
  return {
    type: 'subagent/catalog',
    data: { version: 3, childId, childCreatedAt: Date.now(), mode: 'continuable', label: 'Code review', name },
  }
}

function writeJsonl(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

/**
 * 造一个会话目录（默认普通 `session.jsonl`，可选 zstd 压缩）。
 *
 * `dirName` 用来造**新布局**的子会话目录（裸 uuid，实测真机就是这种），
 * 缺省仍是老布局 `session-<uuid>`。
 * @returns {{dir: string, skipped: boolean}}
 */
function createSession({
  root,
  cwd = '/tmp/project',
  uuid,
  events = [],
  zstd = false,
  write = true,
  dirName = null,
  delegationDepth = 0,
  origin = null,
}) {
  const dir = path.join(root, slugFor(cwd), dirName || `session-${uuid}`)
  fs.mkdirSync(dir, { recursive: true })
  if (!write) return { dir, skipped: false }

  const meta = { type: 'session', version: 4, id: `session-${uuid}`, cwd, delegationDepth }
  if (origin) meta.origin = origin
  const lines = [meta, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n'

  if (zstd) {
    const src = path.join(dir, 'plain.jsonl')
    const dst = path.join(dir, 'session.v4.jsonl.zstd')
    fs.writeFileSync(src, lines)
    const res = spawnSync('zstd', ['-q', '-f', src, '-o', dst], { encoding: 'utf8' })
    fs.rmSync(src, { force: true })
    if (res.error || res.status !== 0) return { dir, skipped: true }
    return { dir, skipped: false }
  }

  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines)
  return { dir, skipped: false }
}

/** 跑 CLI；`DSH_SESSIONS_DIR` 指到用例自己的根，绝不碰用户真实会话。 */
function run(args, { root, cwd } = {}) {
  const options = {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_DIR: root || path.join(BASE, 'no-such-root') },
  }
  // `cwd` 用来给子进程换工作目录：`--session latest` 的隐式默认 cwd 就是它的
  // `process.cwd()`，不能靠测试进程自己的 cwd（那会被跑测试的位置影响）。
  if (cwd) options.cwd = cwd
  return spawnSync(process.execPath, [BIN, ...args], options)
}

function parseJsonOutput(res) {
  assert.equal(res.status === 0 || res.status === 2, true, `期望 PASS/VIOLATION 退出码，实际 ${res.status}：${res.stderr}`)
  return JSON.parse(res.stdout)
}

/** 造 7 个文件、10 次 edit 的父会话事件（3 次重复落在同名文件上）。 */
function tenEditsOverSevenFiles() {
  const files = [
    '/p/src/domain/quotation-draft.ts',
    '/p/src/contracts/ports/quotation.ts',
    '/p/src/platforms/web/quotation.ts',
    '/p/src/components/QuoteDraftBar.tsx',
    '/p/src/application/use-quotation-draft.ts',
    '/p/src/__tests__/quotation-draft.test.ts',
    '/p/src/__tests__/quote-draft-bar.test.tsx',
  ]
  const events = []
  for (let i = 0; i < 7; i += 1) events.push(edit(files[i]))
  events.push(edit(files[0]), edit(files[0]), edit(files[3])) // 同一文件重复改，仍只是 3 次
  return events
}

test('VIOLATION：父会话 7 文件 10 次 edit、本轮完全没派活 → 退出码 2', () => {
  const root = freshRoot()
  const { dir } = createSession({ root, uuid: '11111111-1111-4111-8111-111111111111', events: tenEditsOverSevenFiles() })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, `应判违规，实际退出码 ${res.status}：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'VIOLATION')
  assert.equal(report.fileCount, 7, '去重后的文件数应为 7')
  assert.equal(report.parentEdits, 10)
  assert.equal(report.childEdits, 0)
  assert.equal(report.warnings.length > 0, true, '违规必须带一条人类可读的提示')
  assert.deepEqual(report.dispatch, {
    subagents: 0,
    expertCalls: 0,
    briefs: 0,
    catalog: 0,
    persona: { checked: 0, missing: 0, samples: [] },
  })
  assert.match(
    report.summary,
    /跨 7 个文件的主会话改动 10 次，且本轮没有任何派活记录/,
    'VIOLATION 文案要说明「没有派活记录」，不再说「子 agent 改 0 次」',
  )
  assert.doesNotMatch(
    report.summary,
    /叫了评审/,
    '一条咨询记录都没有时，不该说成「叫了评审，实现仍自己干」（那是另一种形态，见下一个用例）',
  )
})

/** 派活工具各一条的迷你事件流（可在同一份事件里叠加）。 */
function dispatchEvent(name) {
  return toolCall(name, JSON.stringify({ description: 'x', prompt: 'y' }))
}

test('核心：多文件 + 主会话 10 次 edit + `subagent` 1 次 → PASS（旧版误判 VIOLATION）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '12121212-1111-4111-8111-121212121212',
    events: [...tenEditsOverSevenFiles(), dispatchEvent('subagent')],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, `派过 1 个子 agent 就不该判违规，实际退出码 ${res.status}：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.dispatch.subagents, 1)
  assert.equal(report.dispatch.expertCalls, 0)
  assert.equal(report.dispatch.briefs, 0)
  assert.equal(report.attribution.confidence, 'low', 'subagent 无 catalog 登记 → 找不到子会话日志，归因降级')
})

test('多文件 + 主会话 edit + `subagent_fork` 1 次 → PASS（计入 subagents）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '13131313-1111-4111-8111-131313131313',
    events: [...tenEditsOverSevenFiles(), dispatchEvent('subagent_fork')],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0)
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.dispatch.subagents, 1, 'subagent_fork 要计入 subagents')
})

test('多文件 + 主会话 edit + 仅 `summon_expert` 1 次 → VIOLATION（专家是咨询，不是实现队友）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '14141414-1111-4111-8111-141414141414',
    events: [...tenEditsOverSevenFiles(), dispatchEvent('summon_expert')],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, "只叫专家不算把实现交出去")
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'VIOLATION', '咨询不构成实现交接')
  assert.equal(report.dispatch.expertCalls, 1)

  // blocker B1 的回归断言：文案必须点破「叫了评审、实现仍自己干」这个具体形态，
  // 而不是笼统说一句「没有派活记录」（后者会让人以为是压根没叫人，反而更无害）。
  assert.match(report.summary, /只叫了 1 次专家\/生成 0 份任务书/, '要报出咨询次数，读者才知道自己叫了人却仍被判违规')
  assert.match(report.summary, /没有任何实现队友（subagent 0 次）/, '要明确指出缺的是实现队友')
  assert.match(report.summary, /叫了评审，实现仍自己干/, '要点破「假合规」这一具体失效形态')
  assert.doesNotMatch(report.summary, /没有任何派活记录/, '叫过专家就不是「没有任何派活记录」')
})

test('多文件 + 主会话 edit + `summon_experts` / `summon_expert_team` → 合计计入 expertCalls', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '15151515-1111-4111-8111-151515151515',
    events: [...tenEditsOverSevenFiles(), dispatchEvent('summon_experts'), dispatchEvent('summon_expert_team')],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, "只叫专家不算把实现交出去")
  const report = JSON.parse(res.stdout)
  assert.equal(report.dispatch.expertCalls, 2)
  assert.equal(report.verdict, 'VIOLATION', '咨询不构成实现交接')
})

test('多文件 + 主会话 edit + 仅 `expert_brief` 1 次 → VIOLATION（任务书是纯函数，不等于派活）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '16161616-1111-4111-8111-161616161616',
    events: [...tenEditsOverSevenFiles(), dispatchEvent('expert_brief')],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, "只叫专家不算把实现交出去")
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'VIOLATION', '咨询不构成实现交接')
  assert.equal(report.dispatch.briefs, 1, 'expert_brief 要计入 briefs')
})

test('多文件 + 主会话 edit + 只有 `subagent/catalog` 登记、subagent 0 次 → VIOLATION', () => {
  // catalog 是「子会话登记」，它**包含咨询专家**（summon_expert 起的 agent-* 也会登记），
  // 而且实测 mode 字段全是 continuable，区分不了咨询与实现。所以它不能当实现证据。
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a',
    events: [
      ...tenEditsOverSevenFiles(),
      catalog('51515151-5555-4555-8555-515151515151', 'agent-1'),
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, '有子会话登记但没派实现队友，仍算实现没交出去')
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'VIOLATION')
  assert.equal(report.dispatch.subagents, 0)
  assert.equal(report.dispatch.catalog, 1, 'catalog 照常计数（只作展示，不参与放行）')
  assert.match(report.summary, /本轮只有 1 条子会话登记/, '文案要把这条登记的依据写出来，读者才知道自己为什么被判违规')
})

test('多文件 + 主会话 edit + subagent 1 次 + summon_expert 3 次 → PASS（有实现队友就够）', () => {
  // 咨询与实现同时存在时，只要实现真的派出去了就放行 —— 咨询不算加分项，也不算减分项。
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
    events: [
      ...tenEditsOverSevenFiles(),
      dispatchEvent('subagent'),
      dispatchEvent('summon_expert'),
      dispatchEvent('summon_expert'),
      dispatchEvent('summon_expert'),
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, `有 1 次实现队友调用就不该判违规：${res.stderr}`)
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.dispatch.subagents, 1)
  assert.equal(report.dispatch.expertCalls, 3)
})

test('单文件 + 无派活 → PASS（单文件豁免优先于「没有派活」）', () => {
  const root = freshRoot()
  const events = Array.from({ length: 4 }, () => edit('/p/src/only-one.ts'))
  const { dir } = createSession({ root, uuid: '17171717-1111-4111-8111-171717171717', events })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0)
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.fileCount, 1)
  assert.equal(report.parentEdits, 4)
  assert.deepEqual(report.dispatch, {
    subagents: 0,
    expertCalls: 0,
    briefs: 0,
    catalog: 0,
    persona: { checked: 0, missing: 0, samples: [] },
  })
})

test('0 次 edit → PASS（即使没有任何派活记录）', () => {
  const root = freshRoot()
  const { dir } = createSession({ root, uuid: '18181818-1111-4111-8111-181818181818', events: [] })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0)
  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.parentEdits, 0)
  assert.equal(report.attribution.confidence, 'high', '没起子会话 → 不需要归因，confidence=high')
})

test('子会话日志存在且有 edit → childEdits>0 且 confidence=high（兼容新布局裸 uuid 目录）', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-child-bare'
  const childId = '20202020-2222-4222-8222-202020202020'

  const { dir } = createSession({
    root,
    cwd,
    uuid: '19191919-1111-4111-8111-191919191919',
    events: [edit('/p/src/a.ts'), edit('/p/src/b.ts'), dispatchEvent('subagent'), catalog(childId, 'agent-1')],
  })
  // 真机上子会话目录是**裸 uuid**（父会话才有 session- 前缀），这里按真机布局造。
  createSession({ root, cwd, uuid: childId, dirName: childId, events: [edit('/p/src/c.ts'), edit('/p/src/d.ts')] })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.childEdits, 2, '裸 uuid 目录里的 edit 也必须计入')
  assert.equal(report.attribution.childLogsFound, 1)
  assert.equal(report.attribution.childLogsMissing, 0)
  assert.equal(report.attribution.confidence, 'high')
  assert.equal(report.children[0].found, true)
})

test('回归：父 7 文件 + subagent 2 次 + 子会话日志缺失 → PASS（固定住误报）', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-regression-seven'
  const missingA = '30303030-3333-4333-8333-303030303030'
  const missingB = '31313131-3333-4333-8333-313131313131'

  const { dir } = createSession({
    root,
    cwd,
    uuid: '29292929-1111-4111-8111-292929292929',
    events: [
      ...tenEditsOverSevenFiles(),
      dispatchEvent('subagent'),
      dispatchEvent('subagent'),
      catalog(missingA, 'agent-1'),
      catalog(missingB, 'agent-2'),
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, `派了 2 个子 agent、只是日志没落盘，不能判违规：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.fileCount, 7)
  assert.equal(report.parentEdits, 10)
  assert.equal(report.childEdits, 0, '日志缺失时 childEdits 只能是 0，但不得参与否决')
  assert.equal(report.dispatch.subagents, 2)
  assert.equal(report.dispatch.catalog, 2)
  assert.equal(report.attribution.confidence, 'low')
  assert.equal(
    report.warnings.some((warning) => warning.includes('无法核实执行占比')),
    true,
    '必须写明「派过活但日志不可用，无法核实执行占比」',
  )
})

test('回归（ebab78bb 那种）：父 8 文件 10 次 edit + 2 次 summon_expert + 2 条 catalog + 子日志缺失 → VIOLATION（叫了专家、实现自己干）', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-regression-ebab'
  const events = []
  const files = [
    '/w/src/a.ts',
    '/w/src/b.ts',
    '/w/src/c.ts',
    '/w/src/d.ts',
    '/w/src/e.ts',
    '/w/src/f.ts',
    '/w/src/g.ts',
    '/w/src/h.ts',
  ]
  for (let i = 0; i < 8; i += 1) events.push(edit(files[i]))
  events.push(edit(files[0]), edit(files[1])) // 10 次 edit、8 个文件（真机就是 8/10）
  events.push(dispatchEvent('summon_expert'), dispatchEvent('summon_expert'))
  events.push(catalog('41414141-4444-4444-8444-414141414141', 'agent-1'))
  events.push(catalog('42424242-4444-4444-8444-424242424242', 'agent-2'))

  const { dir } = createSession({ root, cwd, uuid: '39393939-1111-4111-8111-393939393939', events })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, `叫了专家但没派实现队友 → 必须判 VIOLATION：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'VIOLATION', '咨询不构成实现交接')
  assert.equal(report.fileCount, 8)
  assert.equal(report.parentEdits, 10)
  assert.equal(report.childEdits, 0)
  assert.equal(report.dispatch.expertCalls, 2)
  assert.equal(report.dispatch.catalog, 2)
  assert.equal(report.attribution.childLogsMissing, 2)
  assert.equal(report.attribution.confidence, 'low')
})

test('判据不含 childEdits：子会话无日志时 VIOLATION 只由「subagent 0 次」触发', () => {
  const root = freshRoot()
  // 与上面 PASS 用例唯一的差别：没有任何派活事件（也没有 catalog）
  const { dir } = createSession({
    root,
    uuid: '43434343-1111-4111-8111-434343434343',
    events: tenEditsOverSevenFiles(),
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.verdict, 'VIOLATION')
  assert.equal(report.dispatch.subagents, 0, 'VIOLATION 的唯一条件就是这个计数为 0')
  assert.equal(report.dispatch.subagents + report.dispatch.expertCalls + report.dispatch.briefs + report.dispatch.catalog, 0)
  assert.match(report.summary, /没有任何派活记录/)
})

test('子 agent 会话：delegationDepth / origin 会进报告（判定仍按契约走，不受层级影响）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '45454545-1111-4111-8111-454545454545',
    events: tenEditsOverSevenFiles(),
    delegationDepth: 1,
    origin: 'subagent',
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.session.delegationDepth, 1, '会话层级要如实输出，读者自己判断结论适用性')
  assert.equal(report.session.origin, 'subagent')
  assert.equal(report.parentEdits, 10)
  // 判据不看会话层级：多文件 + 主会话改 + 无派活，主会话该怎么判就怎么判。
  assert.equal(report.verdict, 'VIOLATION')
})

test('主会话（delegationDepth=0）的同一场景：结论与层级解耦，仍判 VIOLATION', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '46464646-1111-4111-8111-464646464646',
    events: tenEditsOverSevenFiles(),
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.session.delegationDepth, 0)
  assert.equal(report.verdict, 'VIOLATION')
})

test('PASS：父会话一次 edit 都没有（叫了专家也不自己改）→ 退出码 0', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '22222222-2222-4222-8222-222222222222',
    events: [toolCall('summon_expert', JSON.stringify({ expert: 'x', task: 'y' }))],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.parentEdits, 0)
  assert.equal(report.experts, 1)
})

test('PASS：单文件豁免（同一文件改 5 次，仍然放行）', () => {
  const root = freshRoot()
  const file = '/p/src/only-one.ts'
  const events = Array.from({ length: 5 }, () => edit(file))
  const { dir } = createSession({ root, uuid: '33333333-3333-4333-8333-333333333333', events })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.fileCount, 1)
  assert.equal(report.parentEdits, 5)
  assert.equal(
    report.warnings.some((warning) => warning.includes('单文件豁免')),
    true,
    '单文件豁免应留一条 warning（让读者知道为什么放行）',
  )
})

test('PASS：父 2 次 edit、子 3 次 edit（子会话按 subagent/catalog 关联）→ childEdits=3', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-child-ok'
  const childId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

  const { dir } = createSession({
    root,
    cwd,
    uuid: '44444444-4444-4444-8444-444444444444',
    events: [edit('/p/src/a.ts'), edit('/p/src/b.ts'), dispatchEvent('subagent'), catalog(childId, 'agent-1')],
  })
  // 子会话必须与父会话在**同一个 workspace 目录**下，目录名 = session-<childId>
  createSession({
    root,
    cwd,
    uuid: childId,
    events: [edit('/p/src/c.ts'), edit('/p/src/c.ts'), edit('/p/src/d.ts')],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.childEdits, 3, '子会话里的 3 次 edit 必须被计入')
  assert.equal(report.parentEdits, 2)
  assert.equal(report.subagents, 1)
  assert.equal(report.children[0].found, true, '子会话目录存在时应标记 found')
  assert.equal(report.fileCount, 4, 'files 是父+子所有 file_path 的并集去重')
})

test('PASS：父 5 次、子日志里 1 次 edit（子会话日志可读 → confidence=high，childEdits 只作归因）', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-lopsided'
  const childId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

  const { dir } = createSession({
    root,
    cwd,
    uuid: '55555555-5555-4555-8555-555555555555',
    events: [
      edit('/p/src/1.ts'),
      edit('/p/src/2.ts'),
      edit('/p/src/3.ts'),
      edit('/p/src/4.ts'),
      edit('/p/src/5.ts'),
      dispatchEvent('subagent'),
      catalog(childId, 'agent-1'),
    ],
  })
  createSession({ root, cwd, uuid: childId, events: [edit('/p/src/x.ts')] })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, '有子会话登记即算派过活 → 不判违规（旧版靠 childEdits 判定，语义不同）')

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.childEdits, 1)
  assert.equal(report.attribution.confidence, 'high', '子会话日志找到了 → 归因精度 high')
  assert.equal(
    report.warnings.some((warning) => warning.includes('少于主会话')),
    true,
    'childEdits < parentEdits 时要提示「日志可能不全，别据此下结论」',
  )
})

test('子会话关联：父日志只有 catalog、edit 全在子目录里 → 仍算队友的改动', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-child-only'
  const childId = 'cccccccc-3333-4333-8333-cccccccccccc'

  const { dir } = createSession({
    root,
    cwd,
    uuid: '66666666-6666-4666-8666-666666666666',
    events: [catalog(childId, 'agent-1')],
  })
  createSession({ root, cwd, uuid: childId, events: [edit('/p/src/z1.ts'), edit('/p/src/z2.ts')] })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.parentEdits, 0)
  assert.equal(report.childEdits, 2)
  assert.equal(report.fileCount, 2)
  assert.equal(report.verdict, 'PASS', '主会话零改动 → PASS（交付规范允许，只是实现了在队友手里）')
})

test('有子会话登记但目录缺失：PASS（派活证据成立）+ confidence=low + warnings 写明无法归因', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: '77777777-7777-4777-8777-777777777777',
    events: [edit('/p/src/a.ts'), edit('/p/src/b.ts'), dispatchEvent('subagent'), catalog('dddddddd-4444-4444-8444-dddddddddddd', 'agent-9')],
  })

  // 旧版这里判 VIOLATION（childEdits 只能是 0）；新判据不得再让「日志没落盘」否决。
  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, `有子会话登记就不该判违规，实际退出码 ${res.status}：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.children[0].found, false)
  assert.equal(report.attribution.childLogsMissing, 1)
  assert.equal(report.attribution.confidence, 'low', '子会话日志缺失必须降级归因精度')
  assert.equal(
    report.warnings.some((warning) => warning.includes('没有日志目录')),
    true,
    '缺失必须显式说明，不能假装「队友没改」是事实',
  )
  assert.equal(
    report.warnings.some((warning) => warning.includes('无法核实执行占比')),
    true,
    'warnings 要写明「派过活但日志不可用，无法核实执行占比」',
  )
})

test('找不到会话：退出码 1，stderr 有可操作提示（不是栈）', () => {
  const root = freshRoot()
  createSession({ root, uuid: '88888888-8888-4888-8888-888888888888' })

  const res = run(['--session', 'deadbeef'], { root })
  assert.equal(res.status, 1)
  assert.equal(res.stdout, '', '错误时 stdout 应为空，避免管道读到半截报告')
  assert.match(res.stderr, /找不到会话/)
  assert.match(res.stderr, /--session latest/, '提示里要给出下一步命令')
  assert.doesNotMatch(res.stderr, /^\s+at /m, '不应把栈丢给用户')
})

test('--help：打印用法并退出 0（且优先于其它选项）', () => {
  const res = run(['--help'], {})
  assert.equal(res.status, 0)
  assert.match(res.stdout, /用法：/)
  assert.match(res.stdout, /--session/)
  assert.match(res.stdout, /VIOLATION/)

  // --help 与错误参数同给，仍只看用法
  const mixed = run(['--session', '--help'], {})
  assert.equal(mixed.status, 0)
  assert.match(mixed.stdout, /用法：/)
})

test('--json：输出是合法 JSON，且带齐契约字段', () => {
  const root = freshRoot()
  const { dir } = createSession({ root, uuid: '99999999-9999-4999-8999-999999999999', events: tenEditsOverSevenFiles() })

  const res = run(['--session', dir, '--json'], { root })
  assert.doesNotThrow(() => JSON.parse(res.stdout), '--json 必须能被 JSON.parse')

  const report = JSON.parse(res.stdout)
  for (const key of [
    'verdict',
    'files',
    'fileCount',
    'parentEdits',
    'childEdits',
    'experts',
    'subagents',
    'dispatch',
    'attribution',
    'warnings',
  ]) {
    assert.equal(key in report, true, `JSON 缺少字段 ${key}`)
  }
  assert.equal(Array.isArray(report.files), true)
  assert.equal(Array.isArray(report.warnings), true)
  assert.equal(report.files.length, report.fileCount)

  assert.deepEqual(report.dispatch, {
    subagents: 0,
    expertCalls: 0,
    briefs: 0,
    catalog: 0,
    persona: { checked: 0, missing: 0, samples: [] },
  })
  assert.deepEqual(Object.keys(report.attribution).sort(), ['childLogsFound', 'childLogsMissing', 'confidence'])
  assert.equal(['high', 'low'].includes(report.attribution.confidence), true, 'confidence 只能是 high / low')
})

test('坏 arguments：坏 JSON / 空字符串 / 缺 file_path 都不崩、不计 edit、各记一条 warning', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    events: [
      toolCall('edit', '{不是 JSON'),
      toolCall('edit', ''),
      toolCall('edit', JSON.stringify({ old_string: 'a', new_string: 'b' })), // 没有 file_path
      toolCall('write', JSON.stringify({ file_path: '' })), // 空 file_path
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, '解析不了不等于违规，更不等于崩溃')

  const report = JSON.parse(res.stdout)
  assert.equal(report.parentEdits, 0, '坏参数既不增加 edit 计数')
  assert.equal(report.fileCount, 0, '也不贡献文件')
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.warnings.length >= 4, true, `4 条坏调用各应有一条 warning，实际 ${report.warnings.length}`)
})

test('坏 arguments 与正常调用混合：正常的照算，坏的跳过（不虚高 parentEdits）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    events: [
      edit('/p/src/ok1.ts'),
      toolCall('edit', 'null'),
      edit('/p/src/ok2.ts'),
      toolCall('edit', '[1,2,3]'), // 是合法 JSON 但不是对象
    ],
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.parentEdits, 2, '只有两条可解析的 edit 计入')
  assert.equal(report.fileCount, 2)
  assert.equal(report.verdict, 'VIOLATION')
  assert.equal(report.warnings.length >= 2, true)
})

test('边界：catalog 事件缺 data / data 为 null / childId 为空 → 不崩，且归因降级为 low', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'bcbcbcbc-0000-4000-8000-00000000bcbc',
    events: [
      { type: 'subagent/catalog' },
      { type: 'subagent/catalog', data: null },
      { type: 'subagent/catalog', data: { childId: '' } },
      { type: 'tool/call', data: null },
      { type: 'tool/call' },
      toolCall('edit', JSON.stringify({ file_path: '/p/src/a.ts' })),
      toolCall('write', JSON.stringify({ file_path: '/p/src/b.ts' })),
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 2, `坏 catalog 不算实现队友，仍应判违规（且不崩）：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.parentEdits, 2)
  assert.equal(report.dispatch.catalog, 3, 'catalog 按事件数计（契约如此），哪怕 childId 缺失')
  assert.equal(report.children.length, 0, '没有一条能解析出 childId，就没有可读的子会话')
  assert.equal(report.attribution.confidence, 'low', '有登记痕迹却一条都定位不到 → 归因必须降级')
  assert.equal(report.verdict, 'VIOLATION', '坏 catalog 不算实现队友 → 判违规')
  assert.match(
    report.summary,
    /本轮只有 3 条子会话登记/,
    '落实情况要写进结论：登记了 3 条却一条都定位不到，这才是「为什么判违规」的答案',
  )
  assert.doesNotMatch(
    report.summary,
    /叫了 3 次专家/,
    'catalog 不是专家调用，不能混说成「叫了专家」',
  )
})

test('--session 支持 uuid 前缀匹配', () => {
  const root = freshRoot()
  createSession({ root, cwd: '/tmp/proj-prefix', uuid: 'ebab78bb-a98d-42a3-b030-401b09f0c3ab', events: [edit('/p/a.ts')] })

  const res = run(['--session', 'ebab78bb', '--json'], { root })
  assert.equal(res.status, 0)

  const report = JSON.parse(res.stdout)
  assert.match(report.session.id, /ebab78bb/)
  assert.equal(report.session.resolvedBy, 'prefix')
})

test('--session 支持 latest（取最近一次会话）', () => {
  const root = freshRoot()
  const cwd = '/tmp/proj-latest'
  const older = createSession({ root, cwd, uuid: '11112222-0000-4000-8000-000000000001', events: [edit('/p/a.ts')] })
  const newer = createSession({ root, cwd, uuid: '33334444-0000-4000-8000-000000000002', events: tenEditsOverSevenFiles() })

  // 明确把 older 改成更早的时间，不靠创建顺序（同毫秒会抖）
  const oldTime = new Date(Date.now() - 3600_000)
  fs.utimesSync(path.join(older.dir, 'session.jsonl'), oldTime, oldTime)

  const res = run(['--session', 'latest', '--json'], { root: root })
  assert.equal(res.status, 2, 'latest 应选中改 7 个文件那个（违规）')
  const report = JSON.parse(res.stdout)
  assert.equal(report.session.dir, newer.dir)
})

test('--cwd 只在匹配的 workspace 里找会话（slug 掉开头斜杠的规则）', () => {
  const root = freshRoot()
  const cwdA = '/tmp/proj-alpha'
  const cwdB = '/tmp/proj-beta'

  createSession({ root, cwd: cwdA, uuid: 'a1a1a1a1-0000-4000-8000-00000000000a', events: [edit('/p/a.ts')] })
  const b = createSession({ root, cwd: cwdB, uuid: 'b2b2b2b2-0000-4000-8000-00000000000b', events: tenEditsOverSevenFiles() })

  // slug 手工推导：--tmp-proj-beta--（不是 ---tmp-...）
  const betaDir = path.join(root, '--tmp-proj-beta--')
  assert.equal(fs.existsSync(betaDir), true, `测试自己的 slug 推导应产生 ${betaDir}`)

  const res = run(['--session', 'latest', '--cwd', cwdB, '--json'], { root })
  assert.equal(res.status, 2)

  const report = JSON.parse(res.stdout)
  assert.equal(report.session.dir, b.dir, '--cwd 应筛掉 alpha，选中 beta')
  assert.equal(report.session.cwd, cwdB)
})

test('--cwd 匹配不到时报错退出 1，并提示去掉 --cwd', () => {
  const root = freshRoot()
  createSession({ root, cwd: '/tmp/proj-exists', uuid: 'c3c3c3c3-0000-4000-8000-00000000000c' })

  const res = run(['--session', 'latest', '--cwd', '/tmp/definitely-not-a-workspace-xyz'], { root })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /没有 cwd 匹配/)
})

test('未知参数 / 选项缺值：退出码 1 并指出是哪个选项', () => {
  const root = freshRoot()

  const unknown = run(['--nope'], { root })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /未知参数：--nope/)

  const missing = run(['--session'], { root })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /--session 缺少取值/)
})

test('人类输出：统计数字 + 「实现队友」/「咨询证据」两行 + 「结论」行，且不混入 JSON', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'd4d4d4d4-0000-4000-8000-00000000000d',
    events: [...tenEditsOverSevenFiles(), dispatchEvent('subagent'), dispatchEvent('summon_expert'), dispatchEvent('expert_brief')],
  })

  const res = run(['--session', dir], { root })
  assert.equal(res.status, 0, '有派活记录 → PASS')
  assert.match(res.stdout, /改动归属自检/)
  assert.match(res.stdout, /parentEdits\s+10/)
  assert.match(res.stdout, /childEdits\s+0/)
  // 两行必须是**分开的两行**：判定只看「实现队友」，咨询证据单独一行，读者不会误以为叫专家就算派活。
  assert.match(
    res.stdout,
    /实现队友\s+subagent 1\n咨询证据\s+专家 1 \/ 任务书 1 \/ 子会话登记 0/,
    '实现队友与咨询证据必须分行显示',
  )
  assert.match(res.stdout, /归因精度\s+(high|low)/)
  assert.match(res.stdout, /结论\s+PASS/)
  assert.throws(() => JSON.parse(res.stdout), '非 --json 输出不应混成 JSON（脚本会误读）')
})

test('人类输出：违规时「实现队友 subagent 0」+「咨询证据」全 0（一眼看出为什么判违规）', () => {
  const root = freshRoot()
  const { dir } = createSession({ root, uuid: 'd5d5d5d5-0000-4000-8000-0000000000d5', events: tenEditsOverSevenFiles() })

  const res = run(['--session', dir], { root })
  assert.equal(res.status, 2)
  assert.match(res.stdout, /实现队友\s+subagent 0/)
  assert.match(res.stdout, /咨询证据\s+专家 0 \/ 任务书 0 \/ 子会话登记 0/)
  assert.match(res.stdout, /结论\s+VIOLATION/)
})

test('zstd 会话日志（session.v4.jsonl.zstd）走 zstd -dc 解压路径', (t) => {
  const root = freshRoot()
  const created = createSession({
    root,
    uuid: 'e5e5e5e5-0000-4000-8000-00000000000e',
    events: tenEditsOverSevenFiles(),
    zstd: true,
  })
  if (created.skipped) {
    t.skip('本机没有可用的 zstd，跳过压缩格式用例')
    return
  }

  const res = run(['--session', created.dir, '--json'], { root })
  assert.equal(res.status, 2, `压缩日志应读出同样结论：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.parentEdits, 10)
  assert.equal(report.fileCount, 7)
  assert.equal(report.verdict, 'VIOLATION')
})

test('目录里没有日志文件：退出码 1 且提示应有什么文件', () => {
  const root = freshRoot()
  const { dir } = createSession({ root, uuid: 'f6f6f6f6-0000-4000-8000-00000000000f', write: false })

  const res = run(['--session', dir], { root })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /没有日志文件/)
  assert.match(res.stderr, /session\.jsonl/, '提示里应说明期望的文件名')
})

test('--session 也接受带 session- 前缀的写法', () => {
  const root = freshRoot()
  createSession({ root, cwd: '/tmp/proj-session-prefix', uuid: 'abcdef01-2345-4678-89ab-cdef01234567', events: [edit('/p/a.ts')] })

  const res = run(['--session', 'session-abcdef01', '--json'], { root })
  assert.equal(res.status, 0, `带前缀的选择器应能解析：${res.stderr}`)
  assert.match(JSON.parse(res.stdout).session.id, /abcdef01/)
})

test('zstd 不可用且只有压缩日志：退出码 1 并提示装 zstd（不崩栈）', (t) => {
  const root = freshRoot()
  const created = createSession({
    root,
    cwd: '/tmp/proj-no-zstd',
    uuid: '7a7a7a7a-0000-4000-8000-00000000007a',
    events: [edit('/p/a.ts')],
    zstd: true,
  })
  if (created.skipped) {
    t.skip('本机没有可用的 zstd，无法构造压缩日志')
    return
  }

  // PATH 指向不存在的目录：node 用绝对路径启动，只有子进程 zstd 会 ENOENT。
  const res = spawnSync(process.execPath, [BIN, '--session', created.dir], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SESSIONS_DIR: root, PATH: path.join(root, 'no-such-bin') },
  })

  assert.equal(res.status, 1)
  assert.match(res.stderr, /解压失败/)
  assert.match(res.stderr, /zstd/, '提示里要给出可操作的下一步（装 zstd）')
  assert.doesNotMatch(res.stderr, /^\s+at /m, '不应把栈丢给用户')
})

// ─── 选会话规则：`--session latest` 缺省按当前目录，`--any-cwd` 回到全盘最新 ───────────
//
// 回归背景（真机实测过）：老行为是「全盘 mtime 最新」，与当前目录无关。挂进
// completion-ledger 的 verify 时（verify 在**会话 cwd** 下执行、拿不到会话 id）就会读到
// 别的工作区的会话，检查错会话 —— 在 A 的工作区里跑，却报告 B 的工作区。
//
// 每个用例都让 A 的 mtime **更旧**、B 更**新**。这是刻意的：只有「命中的是更旧那条」，
// 才唯一地证明 latest 跟着 cwd 走；否则「命中 B」既可能是跟着 cwd、也可能是碰巧全盘最新。
//
// A 用单文件 1 次 edit（PASS，退出码 0），B 用 7 文件 10 次 edit（VIOLATION，退出码 2）——
// 退出码本身就把「命中了谁」区分开，不必只看 dir 字段。

/** 造一个**真实存在**的目录并返回 realpath。 */
function makeCwdDir(label) {
  const dir = path.join(BASE, 'cwds', `${caseSeq}-${label}`)
  fs.mkdirSync(dir, { recursive: true })
  // 必须取 realpath：macOS 上 os.tmpdir() 是 `/var/folders/...`，而子进程的 `process.cwd()`
  // 返回解析过符号链接的 `/private/var/folders/...`；两边不一致会让 slug 匹配假阴性。
  return fs.realpathSync(dir)
}

/** 造「A 更旧、B 更新」的一对 workspace。 */
function twoWorkspacesWithNewerB(root) {
  const cwdA = makeCwdDir('work-a')
  const cwdB = makeCwdDir('work-b')
  const a = createSession({
    root,
    cwd: cwdA,
    uuid: 'a0a0a0a0-0000-4000-8000-0000000000a0',
    events: [edit('/p/a.ts')],
  })
  const b = createSession({
    root,
    cwd: cwdB,
    uuid: 'b0b0b0b0-0000-4000-8000-0000000000b0',
    events: tenEditsOverSevenFiles(),
  })
  const oldTime = new Date(Date.now() - 3600_000)
  fs.utimesSync(path.join(a.dir, 'session.jsonl'), oldTime, oldTime)
  return { cwdA, cwdB, a, b }
}

test('核心回归：`--session latest` 在 A 的 cwd 下跑 → 命中更旧的 A，不再是全盘最新的 B', () => {
  const root = freshRoot()
  const { cwdA, a, b } = twoWorkspacesWithNewerB(root)

  const res = run(['--session', 'latest', '--json'], { root, cwd: cwdA })
  assert.equal(res.status, 0, `应命中 A（PASS，退出码 0），实际 ${res.status}：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.notEqual(report.session.dir, b.dir, '不再取全盘 mtime 最新（B）')
  assert.equal(report.session.dir, a.dir, '必须命中当前目录 A 的会话，即使它的 mtime 更旧')
  assert.equal(report.session.cwd, cwdA)
  assert.equal(report.session.selectedBy, 'implicit', 'JSON 里要能看出「按当前目录匹配」')
  assert.equal(report.session.cwdFilter, cwdA)

  // 人类输出必须说明这次会话是怎么选出来的，否则读者没法判断结论对不对。
  const human = run(['--session', 'latest'], { root, cwd: cwdA })
  assert.match(human.stdout, /选会话\s+按当前目录匹配（--any-cwd 可关）/)
})

test('`--any-cwd`：关掉当前目录默认，回到全盘最新 → 命中更新的 B', () => {
  const root = freshRoot()
  const { cwdA, a, b } = twoWorkspacesWithNewerB(root)

  const res = run(['--session', 'latest', '--any-cwd', '--json'], { root, cwd: cwdA })
  assert.equal(res.status, 2, `应命中 B（VIOLATION，退出码 2），实际 ${res.status}：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.session.dir, b.dir, '--any-cwd 要回到「全盘 mtime 最新」的老行为')
  assert.notEqual(report.session.dir, a.dir)
  assert.equal(report.session.selectedBy, 'any-cwd')
  assert.equal('cwdFilter' in report.session, false, '没按 cwd 筛过就不该写 cwdFilter（假证据）')

  const human = run(['--session', 'latest', '--any-cwd'], { root, cwd: cwdA })
  assert.match(human.stdout, /选会话\s+全盘最新（--any-cwd）/)
})

test('显式 `--cwd` 优先于当前目录：cwd=B 时 `--cwd A` → 命中 A', () => {
  const root = freshRoot()
  const { cwdA, cwdB, a, b } = twoWorkspacesWithNewerB(root)

  const res = run(['--session', 'latest', '--cwd', cwdA, '--json'], { root, cwd: cwdB })
  assert.equal(res.status, 0, `显式 --cwd 应生效（命中 A），实际 ${res.status}：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.session.dir, a.dir, '用户显式给的 --cwd 不能被缺省值覆盖')
  assert.notEqual(report.session.dir, b.dir)
  assert.equal(report.session.selectedBy, 'explicit')
  assert.equal(report.session.cwdFilter, cwdA)
})

test('`--session <uuid>` 行为不变：cwd=A 时指名 B 仍解析到 B（且不受目录限制）', () => {
  const root = freshRoot()
  const { cwdA, b } = twoWorkspacesWithNewerB(root)

  // uuid 选择器就是「指名道姓」，隐式默认 cwd 不该插一脚（否则跨 workspace 指定会话会失效）。
  const res = run(['--session', 'b0b0b0b0', '--json'], { root, cwd: cwdA })
  assert.equal(res.status, 2, `应解析到 B（VIOLATION），实际 ${res.status}：${res.stderr}`)
  const report = JSON.parse(res.stdout)
  assert.equal(report.session.dir, b.dir)
  assert.equal(report.session.selectedBy, 'selector')
  assert.equal('cwdFilter' in report.session, false)

  // 当前目录压根没有会话时也一样：uuid 选择器不走 cwd 默认，更不该退回/报错。
  const foreignCwd = makeCwdDir('work-foreign')
  const fromForeign = run(['--session', 'b0b0b0b0', '--json'], { root, cwd: foreignCwd })
  assert.equal(fromForeign.status, 2, `uuid 选择器不受当前目录影响：${fromForeign.stderr}`)
  assert.equal(JSON.parse(fromForeign.stdout).session.dir, b.dir)
})

test('隐式默认 cwd 匹配不到会话时退回全盘最新（不报错），并写明「已退回」', () => {
  const root = freshRoot()
  const cwdA = makeCwdDir('work-empty-a')
  const cwdB = makeCwdDir('work-only-b')
  // 只有 B 有会话；A 目录真实存在但一条会话都没有（新目录里跑 verify 就是这个场景）
  const b = createSession({
    root,
    cwd: cwdB,
    uuid: 'b0b0b0b0-0000-4000-8000-0000000000b0',
    events: tenEditsOverSevenFiles(),
  })

  const res = run(['--session', 'latest', '--json'], { root, cwd: cwdA })
  assert.equal(res.status, 2, `猜不中就该退回全盘最新而不是失败：${res.stderr}`)
  const report = JSON.parse(res.stdout)
  assert.equal(report.session.dir, b.dir)
  assert.equal(report.session.selectedBy, 'implicit-fallback')
  assert.equal('cwdFilter' in report.session, false, '退回时并没有按 cwd 筛过')
  assert.match(report.warnings.join('\n'), /退回全盘最新/, '退回这件事必须写在报告里，不能静默')

  const human = run(['--session', 'latest'], { root, cwd: cwdA })
  assert.match(human.stdout, /选会话\s+全盘最新（当前目录下没有会话，已退回全盘；--any-cwd 可直接关）/)

  // 同一场景换成**显式** --cwd：仍是硬筛，匹配不到必须报错退出 1（软默认只属于缺省值）
  const explicit = run(['--session', 'latest', '--cwd', cwdA], { root, cwd: cwdA })
  assert.equal(explicit.status, 1, '显式 --cwd 不许静默退回全盘')
  assert.match(explicit.stderr, /没有 cwd 匹配/)
})

test('`--help` 写明 `--any-cwd`（逃生口必须能被发现）', () => {
  const res = run(['--help'], {})
  assert.equal(res.status, 0)
  // 三处都要在，缺一处就等于「有这个参数但没人知道」：
  // ① 用法行（一眼看到参数存在）② 选项表里的条目（知道它干什么）③ 语义说明。
  assert.match(
    res.stdout,
    /dispatch-check \[--session <dir\|id\|latest>\] \[--cwd <路径>\] \[--any-cwd\]/,
    '用法行要带 [--any-cwd]，否则读者根本不知道有这个参数',
  )
  assert.match(res.stdout, /^\s+--any-cwd\s+\S/m, '选项表里要有一条 --any-cwd 的说明，不能只在散文里提到')
  assert.match(res.stdout, /全盘最新/, '要说明 --any-cwd 是回到「全盘最新」，不是只列个参数名')
  assert.match(res.stdout, /按当前目录匹配|当前目录/, '要说明缺省是按当前目录选会话')
})


// ============================================================================
// 人格注入检查（`dispatch.persona`）：**只告警、不参与判定**
//
// 真实事故：三个队友叫 `frontend-developer` / `frontend-developer-2` /
// `testing-reality-checker`（命名规则执行了），prompt 里却一个 persona 字节都没有
// （`You are **` / `Agent Personality` / `Core Mission` / 「人格」全部 0 命中）。
// 名字对了，人以为人格也进去了 —— 所以这一项必须可见。但它**不进 verdict**：
// 判定若算它，大量历史会话会被判违规，先让它可见、再谈是否收紧。
// ============================================================================

/** 带专家人格骨架的 prompt（`expert_brief` 任务书 / persona md 正文的招牌字句）。 */
const PERSONA_PROMPT = [
  '# 代码审查工程师 Agent',
  '',
  '**Agent Personality**',
  '你是代码审查工程师，负责在改动落地前挑出问题。',
  '',
  '## Core Mission',
  '审查本轮改动并给出分级结论。',
].join('\n')

/** 完全没有人格痕迹的任务型 prompt —— 真实事故里的形态：可以很长，但不是 persona。 */
const PLAIN_PROMPT = '请把 src/app/panel/Button.tsx 里的按钮文案改成「提交」，并补一条单测。'

/** 一次带 prompt 的 subagent 调用；`arguments` 仍是 JSON 字符串（与真实日志一致）。 */
function subagentCall(name, prompt, tool = 'subagent') {
  return toolCall(tool, JSON.stringify({ name, description: 'x', prompt }))
}

test('persona 标记矩阵：七种标记任一命中即算「有人格」，普通任务文案不算', () => {
  for (const mark of [
    'You are **前端开发者**',
    '**Agent Personality**',
    '## Core Mission',
    '## Critical Rules',
    '## Identity',
    '把人格正文整段贴进 prompt', // 命中「人格」二字
    '# Code Reviewer Agent', // 命中 /#\s+\w[\w ]*Agent\b/
  ]) {
    assert.equal(hasPersona(mark), true, `标记 ${JSON.stringify(mark)} 应算「有人格」`)
  }
  assert.equal(hasPersona(PLAIN_PROMPT), false, '普通任务文案（只有文件名与要求）不算有人格')
  assert.equal(hasPersona(''), false, '空串没人格')
  assert.equal(hasPersona(null), false, '非字符串没人格（不能抛）')
  assert.equal(hasPersona('## Core Mission 之外的普通标题'), true, '只要命中 Core Mission 即可，不要求整段匹配')
})

test('persona：本轮没有 subagent 调用 → 全 0、不打印「人格注入」行、无 warning', () => {
  const root = freshRoot()
  const { dir } = createSession({ root, uuid: 'a0000001-0000-4000-8000-000000000001', events: [edit('/p/src/a.ts')] })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.deepEqual(report.dispatch.persona, { checked: 0, missing: 0, samples: [] })
  assert.equal(
    report.warnings.some((warning) => warning.includes('没有专家人格')),
    false,
    '没起队友就不该报「队友 prompt 缺人格」',
  )

  const human = run(['--session', dir], { root })
  assert.doesNotMatch(human.stdout, /人格注入/, 'checked=0 时不打印该行（印 0/0 会被读成检查失败）')
  assert.doesNotMatch(human.stdout, /有 persona/)
})

test('persona：arguments 坏 JSON / 空串 / 缺 prompt → 跳过不崩（不计 checked），各记一条 warning', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000002-0000-4000-8000-000000000002',
    events: [
      toolCall('subagent', '{不是 JSON'), // 坏 JSON
      toolCall('subagent', ''), // 空串
      toolCall('subagent', JSON.stringify({ name: 'no-prompt' })), // 缺 prompt
      toolCall('subagent', JSON.stringify({ name: 'num-prompt', prompt: 42 })), // prompt 非字符串
      subagentCall('ok-persona', PERSONA_PROMPT), // 唯一一条能检查的
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, `解析不了不等于违规，更不等于崩溃：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.dispatch.subagents, 5, '派活计数照旧按事件数（坏 arguments 不影响「有没有派人」）')
  assert.deepEqual(
    report.dispatch.persona,
    { checked: 1, missing: 0, samples: [] },
    '解析不出 prompt 的三条不能算进 checked（那等于编造「检查过且没人格」）；prompt 非字符串也只跳过',
  )
  const skipped = report.warnings.filter((warning) => warning.includes('人格检查跳过'))
  assert.equal(skipped.length, 4, `4 条无法解析的调用各应有一条说明，实际 ${skipped.length}：${report.warnings.join(' | ')}`)
})

test('persona：prompt 是空串 → 计入 checked 且算 missing（空 prompt 显然没人格）', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000003-0000-4000-8000-000000000003',
    events: [subagentCall('empty-tom', ''), subagentCall('ok-dev', PERSONA_PROMPT)],
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.deepEqual(report.dispatch.persona, { checked: 2, missing: 1, samples: ['empty-tom'] })
  assert.match(
    report.warnings.join('\n'),
    /没有专家人格（缺 1 个：empty-tom）/,
    '空 prompt 的队友名要出现在 warning 里',
  )
})

test('persona：全部带人格 → checked=N、missing=0、无 warning', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000004-0000-4000-8000-000000000004',
    events: [
      subagentCall('code-reviewer', PERSONA_PROMPT),
      subagentCall('frontend-developer', '## Critical Rules\n只改这一个文件。', 'subagent_fork'),
    ],
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.dispatch.persona.checked, 2)
  assert.equal(report.dispatch.persona.missing, 0)
  assert.deepEqual(report.dispatch.persona.samples, [])
  assert.equal(
    report.warnings.some((warning) => warning.includes('没有专家人格')),
    false,
    'missing=0 时不许出现该 warning',
  )
})

test('persona：部分缺失 → warning 带上缺失队友名，并点明「命名≠人格注入」', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000005-0000-4000-8000-000000000005',
    events: [
      subagentCall('code-reviewer', PERSONA_PROMPT),
      subagentCall('frontend-developer', PLAIN_PROMPT), // 名字对、prompt 没人格（事故形态）
      subagentCall('testing-reality-checker', '**Agent Personality**\n你是验收测试工程师。'),
    ],
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.dispatch.persona.checked, 3)
  assert.equal(report.dispatch.persona.missing, 1)
  assert.deepEqual(report.dispatch.persona.samples, ['frontend-developer'])

  const personaWarning = report.warnings.find((warning) => warning.includes('没有专家人格'))
  assert.ok(personaWarning, 'missing>0 必须有 warning')
  assert.match(personaWarning, /本轮 1 个队友的 prompt 里没有专家人格（缺 1 个：frontend-developer）/)
  assert.match(personaWarning, /命名≠人格注入/, '必须点出「名字对了不代表人格进去了」这件事')
  assert.match(personaWarning, /expert_brief/, '要给出可执行的下一步（用 expert_brief 生成任务书）')
  assert.match(personaWarning, /persona md/, '另一条可执行的下一步：把 persona md 正文贴进 prompt')
})

test('persona：缺失超过 5 个 → samples 只留 5 个名字，但 warning 里的缺数是真实总数', () => {
  const root = freshRoot()
  const names = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']
  const { dir } = createSession({
    root,
    uuid: 'a0000006-0000-4000-8000-000000000006',
    events: names.map((name) => subagentCall(name, PLAIN_PROMPT)),
  })

  const report = parseJsonOutput(run(['--session', dir, '--json'], { root }))
  assert.equal(report.dispatch.persona.checked, 7)
  assert.equal(report.dispatch.persona.missing, 7)
  assert.deepEqual(report.dispatch.persona.samples, ['w1', 'w2', 'w3', 'w4', 'w5'], 'samples 最多留 5 个')

  const personaWarning = report.warnings.find((warning) => warning.includes('没有专家人格'))
  assert.match(personaWarning, /缺 7 个/, '名字只列 5 个，缺数必须是真实的 7，否则读者以为只缺了列出来的那几个')
})

test('persona 不参与判定：复刻事故（3 个队友全无人格）→ 仍然 PASS', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000007-0000-4000-8000-000000000007',
    events: [
      ...tenEditsOverSevenFiles(),
      subagentCall('frontend-developer', PLAIN_PROMPT),
      subagentCall('frontend-developer-2', '再补一个页面。'),
      subagentCall('testing-reality-checker', '写单测。'),
    ],
  })

  const res = run(['--session', dir, '--json'], { root })
  assert.equal(res.status, 0, `派过实现队友就是 PASS，人格缺失不该改变 verdict：${res.stderr}`)

  const report = JSON.parse(res.stdout)
  assert.equal(report.verdict, 'PASS', '判定仍只看 dispatch.subagents')
  assert.equal(report.dispatch.persona.checked, 3, '事故里的 3 个队友都要被检查')
  assert.equal(report.dispatch.persona.missing, 3)
  assert.deepEqual(report.dispatch.persona.samples, [
    'frontend-developer',
    'frontend-developer-2',
    'testing-reality-checker',
  ])
})

test('persona：人类输出「人格注入 N/M 有 persona」，部分缺失时带缺失名单', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000008-0000-4000-8000-000000000008',
    events: [
      subagentCall('code-reviewer', PERSONA_PROMPT),
      subagentCall('worker-b', PLAIN_PROMPT),
    ],
  })

  const human = run(['--session', dir], { root })
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, /^人格注入\s+1\/2 有 persona（缺：worker-b）$/m, `实际输出：${human.stdout}`)
  // 该行必须与「实现队友」「咨询证据」同处统计块，而不是被塞进 warnings 里
  assert.match(human.stdout, /实现队友\s+subagent 2[\s\S]*咨询证据[\s\S]*人格注入[\s\S]*归因精度/)
  // warnings 里那条也照旧打印（一眼看到「命名≠人格注入」的处置建议）
  assert.match(human.stdout, /命名≠人格注入/)
})

test('persona：人类输出在全部带人格时是「3/3 有 persona」且不带省略名单', () => {
  const root = freshRoot()
  const { dir } = createSession({
    root,
    uuid: 'a0000009-0000-4000-8000-000000000009',
    events: [
      subagentCall('a1', PERSONA_PROMPT),
      subagentCall('a2', PERSONA_PROMPT),
      subagentCall('a3', PERSONA_PROMPT),
    ],
  })

  const human = run(['--session', dir], { root })
  assert.match(human.stdout, /^人格注入\s+3\/3 有 persona$/m, `实际输出：${human.stdout}`)
})
