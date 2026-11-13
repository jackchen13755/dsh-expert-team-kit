import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  MAX_REWORK_ROUNDS,
  PHASES,
  PHASE_ERROR_CODES,
  TRANSITIONS,
  advance,
  advanceSession,
  createState,
  readPhaseState,
  writePhaseState,
} from '../../lib/phase.mjs'

const BIN_PHASE = fileURLToPath(new URL('../../bin/phase.mjs', import.meta.url))

/** 每个用例一个独立临时根。 */
function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phase-'))
}

/** 跑 CLI，返回 { status, stdout, stderr }。 */
function runPhase(args) {
  return spawnSync(process.execPath, [BIN_PHASE, ...args], { encoding: 'utf8' })
}

/**
 * 断言一次推进成功并返回新状态。
 * @param {Record<string, unknown>} state
 * @param {string} to
 */
function advanceOk(state, to) {
  const result = advance(state, to)
  assert.equal(result.ok, true, `${String(state.phase)} → ${to} 应成功，实际 error=${JSON.stringify(result.error)}`)
  assert.equal(result.error, null)
  return /** @type {any} */ (result.state)
}

/**
 * 断言一次推进被拒：ok=false、带错误码、状态原样返回。
 * @param {unknown} state
 * @param {unknown} to
 * @param {string} code
 */
function advanceRejected(state, to, code) {
  const result = advance(state, to)
  assert.equal(result.ok, false, `${JSON.stringify(to)} 应被拒`)
  assert.ok(result.error, '被拒必须带 error')
  assert.equal(result.error.code, code, `错误码应为 ${code}，实际 ${result.error && result.error.code}`)
  assert.match(result.error.message, /Fix:/, '错误信息必须给修复动作')
  return result
}

// ---------------------------------------------------------------------------
// 迁移表本身
// ---------------------------------------------------------------------------

test('TRANSITIONS: 主链与返工回路都已声明，done 是终态', () => {
  assert.deepEqual(PHASES, ['plan', 'implement', 'verify', 'review', 'done'])
  assert.deepEqual([...TRANSITIONS.plan], ['implement'])
  assert.deepEqual([...TRANSITIONS.implement], ['verify'])
  assert.deepEqual([...TRANSITIONS.verify], ['review'])
  assert.deepEqual([...TRANSITIONS.review].sort(), ['done', 'implement'])
  assert.deepEqual([...TRANSITIONS.done], [], 'done 不得有任何出口')
  for (const phase of PHASES) {
    assert.ok(TRANSITIONS[phase], `${phase} 必须在迁移表里`)
    for (const to of TRANSITIONS[phase]) {
      assert.ok(PHASES.includes(to), `${phase} → ${to} 的目标必须是已知阶段`)
    }
  }
})

test('createState: 默认从 plan 开始，计数为 0，history 为空', () => {
  const state = createState()
  assert.equal(state.phase, 'plan')
  assert.equal(state.reworkRounds, 0)
  assert.equal(state.revision, 0)
  assert.deepEqual(state.history, [])
  assert.equal(createState({ sessionKey: 'sess-1' }).sessionKey, 'sess-1')
  assert.equal(createState({ sessionKey: 'sess-1', phase: 'review' }).phase, 'review')
})

test('createState: 起始 phase 非法抛错', () => {
  assert.throws(() => createState({ phase: 'deploy' }), /Fix:/)
  assert.throws(() => createState({ phase: '' }), /Fix:/)
})

// ---------------------------------------------------------------------------
// 正常推进
// ---------------------------------------------------------------------------

test('advance: plan → implement → verify → review → done 全程成功', () => {
  let state = createState({ sessionKey: 'sess-ok' })
  for (const to of ['implement', 'verify', 'review', 'done']) {
    state = advanceOk(state, to)
  }
  assert.equal(state.phase, 'done')
  assert.equal(state.reworkRounds, 0, '线性推进不消耗返工预算')
  assert.equal(state.revision, 4)
  assert.deepEqual(
    state.history.map((entry) => `${entry.from}->${entry.to}`),
    ['plan->implement', 'implement->verify', 'verify->review', 'review->done'],
  )
  assert.ok(state.history.every((entry) => entry.rework === false))
  assert.ok(state.history.every((entry) => typeof entry.at === 'string' && entry.at.includes('T')))
})

test('advance: 不改写入参（返回新对象，旧状态保持原样）', () => {
  const state = createState()
  const snapshot = JSON.stringify(state)
  const next = advanceOk(state, 'implement')
  assert.equal(JSON.stringify(state), snapshot, '入参 state 不得被改写')
  assert.notEqual(next, state, '必须返回新对象')
  assert.equal(next.phase, 'implement')
})

// ---------------------------------------------------------------------------
// 非法迁移：返回 error 不抛
// ---------------------------------------------------------------------------

test('advance: 非法迁移返回 ILLEGAL_TRANSITION 且不抛、状态原样', () => {
  const state = createState()
  const result = advanceRejected(state, 'review', PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
  assert.equal(result.state, state, '被拒时返回的必须是同一个状态对象（什么都没发生）')
  assert.equal(state.phase, 'plan', '状态不得被改动')
  assert.deepEqual(result.error.allowed, ['implement'], '错误里要给出允许的目标')
  assert.match(result.error.message, /plan → review/)
})

test('advance: 同一阶段自迁移算非法（不是幂等）', () => {
  for (const phase of PHASES) {
    const state = createState({ phase })
    advanceRejected(state, phase, PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
  }
})

test('advance: 跳过中间阶段一律被拒（plan→verify / plan→done / implement→review）', () => {
  advanceRejected(createState(), 'verify', PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
  advanceRejected(createState(), 'done', PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
  advanceRejected(createState({ phase: 'implement' }), 'review', PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
})

test('advance: done 是终态 —— 任何目标都被拒', () => {
  const done = createState({ phase: 'done' })
  for (const to of PHASES) {
    advanceRejected(done, to, PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
  }
  assert.deepEqual([...TRANSITIONS.done], [])
})

test('advance: 未知目标阶段返回 UNKNOWN_TARGET，并给全量枚举', () => {
  for (const to of ['deploy', '', null, undefined, 42]) {
    const result = advanceRejected(createState(), to, PHASE_ERROR_CODES.UNKNOWN_TARGET)
    assert.deepEqual(result.error.allowed, [...PHASES], '未知目标时必须给出可选阶段清单')
  }
})

test('advance: state 形状非法返回 INVALID_STATE（不抛）', () => {
  /** @type {Array<[string, unknown]>} */
  const badStates = [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['字符串', 'plan'],
    ['phase 不认识', { phase: 'shipping', reworkRounds: 0 }],
    ['phase 缺失', { reworkRounds: 0 }],
    ['reworkRounds 为负', { phase: 'review', reworkRounds: -1 }],
    ['reworkRounds 非整数', { phase: 'review', reworkRounds: 1.5 }],
    ['history 非数组', { phase: 'plan', reworkRounds: 0, history: 'x' }],
  ]
  for (const [label, bad] of badStates) {
    advanceRejected(bad, 'implement', PHASE_ERROR_CODES.INVALID_STATE)
  }
})

// ---------------------------------------------------------------------------
// 返工计数与硬上限
// ---------------------------------------------------------------------------

test('advance: 返工 3 轮内允许，第 4 轮 REWORK_EXHAUSTED 且计数不前进', () => {
  let state = createState()
  state = advanceOk(state, 'implement')
  state = advanceOk(state, 'verify')
  state = advanceOk(state, 'review')

  for (let round = 1; round <= MAX_REWORK_ROUNDS; round += 1) {
    state = advanceOk(state, 'implement') // 第 round 轮返工
    assert.equal(state.reworkRounds, round, `第 ${round} 轮返工应计入`)
    state = advanceOk(state, 'verify')
    state = advanceOk(state, 'review')
  }
  assert.equal(state.reworkRounds, MAX_REWORK_ROUNDS)

  const exhausted = advanceRejected(state, 'implement', PHASE_ERROR_CODES.REWORK_EXHAUSTED)
  assert.equal(exhausted.state.reworkRounds, MAX_REWORK_ROUNDS, '被拒时返工计数不得前进')
  assert.equal(exhausted.state.phase, 'review', '被拒时阶段不得前进')
  assert.equal(exhausted.error.max, MAX_REWORK_ROUNDS)
  assert.match(exhausted.error.message, /升级给人/, '耗尽必须指向人工升级')

  // 耗尽后仍可正常收尾为 done —— 上限只挡返工，不挡出口
  state = advanceOk(state, 'done')
  assert.equal(state.phase, 'done')
})

test('advance: 只有 review → implement 计入返工，其他迁移不计', () => {
  let state = createState()
  state = advanceOk(state, 'implement')
  state = advanceOk(state, 'verify')
  assert.equal(state.reworkRounds, 0, 'plan/implement/verify 三段不消耗返工预算')
  state = advanceOk(state, 'review')
  assert.equal(state.reworkRounds, 0, '进入 review 不消耗预算')
})

// ---------------------------------------------------------------------------
// 持久化：读回一致
// ---------------------------------------------------------------------------

test('advanceSession: 读 + 推进 + 落盘，readPhaseState 读回一致', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const first = advanceSession({ root, sessionKey: 'sess-p', to: 'implement' })
  assert.equal(first.ok, true, `应成功，error=${JSON.stringify(first.error)}`)
  assert.equal(first.file, path.join(root, '.dsh', 'phases', 'sess-p.json'))
  assert.ok(fs.existsSync(first.file))

  const second = advanceSession({ root, sessionKey: 'sess-p', to: 'verify' })
  assert.equal(second.ok, true)

  const read = readPhaseState({ root, sessionKey: 'sess-p' })
  assert.equal(read.missing, false)
  assert.equal(read.corrupt, false)
  assert.equal(read.error, null)
  assert.deepEqual(read.state, second.state, '读回状态必须与写入状态逐字段相等')
  assert.equal(read.state.phase, 'verify')
  assert.deepEqual(
    read.state.history.map((entry) => `${entry.from}->${entry.to}`),
    ['plan->implement', 'implement->verify'],
  )
})

test('readPhaseState: 文件不存在 → 返回初始 plan 状态 + missing=true，不抛', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const read = readPhaseState({ root, sessionKey: 'never' })
  assert.equal(read.missing, true)
  assert.equal(read.corrupt, false)
  assert.equal(read.state.phase, 'plan')
  assert.equal(read.state.reworkRounds, 0)
})

test('advanceSession: 迁移被拒时不写盘（失败不落成事实）', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = advanceSession({ root, sessionKey: 'sess-reject', to: 'done' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, PHASE_ERROR_CODES.ILLEGAL_TRANSITION)
  assert.equal(fs.existsSync(path.join(root, '.dsh', 'phases', 'sess-reject.json')), false, '被拒不得产生状态文件')

  // 该会话后续从 plan 正常起步，说明脏失败没留下痕迹
  const next = advanceSession({ root, sessionKey: 'sess-reject', to: 'implement' })
  assert.equal(next.ok, true)
})

test('readPhaseState: 状态文件损坏 → corrupt=true 且给错误，不静默兜底', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const file = path.join(root, '.dsh', 'phases', 'sess-corrupt.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })

  fs.writeFileSync(file, '{ 不是 JSON\n', 'utf8')
  const broken = readPhaseState({ root, sessionKey: 'sess-corrupt' })
  assert.equal(broken.corrupt, true)
  assert.ok(broken.error, '损坏必须显式报出，不得当成「没有状态」')
  assert.equal(broken.state.phase, 'plan', '同时给一个可用初值，避免调用方崩在 undefined')

  fs.writeFileSync(file, JSON.stringify({ phase: 'shipping', reworkRounds: 0 }), 'utf8')
  const wrongPhase = readPhaseState({ root, sessionKey: 'sess-corrupt' })
  assert.equal(wrongPhase.corrupt, true)
  assert.equal(wrongPhase.error.code, PHASE_ERROR_CODES.INVALID_STATE)

  // 损坏时 advanceSession 必须拒绝推进，不得拿初值覆盖掉现场的脏文件
  const blocked = advanceSession({ root, sessionKey: 'sess-corrupt', to: 'implement' })
  assert.equal(blocked.ok, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).phase, 'shipping', '损坏文件不得被静默覆盖')
})

test('writePhaseState: 拒绝写入非法状态', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => writePhaseState({ root, sessionKey: 'sess-w', state: null }), /非法状态/)
  assert.throws(() => writePhaseState({ root, sessionKey: 'sess-w', state: { phase: 'nope' } }), /非法状态/)
  assert.equal(fs.existsSync(path.join(root, '.dsh')), false)
})

// ---------------------------------------------------------------------------
// CLI 契约：非法迁移 exit 2
// ---------------------------------------------------------------------------

test('CLI: 非法迁移 → 退出码 2，stdout 仍是可解析 JSON', () => {
  for (const to of ['done', 'verify', 'plan']) {
    const result = runPhase(['advance', '--session', 'sess-cli', '--to', to, '--root', makeRoot()])
    assert.equal(result.status, 2, `plan → ${to} 应退出 2（stderr: ${result.stderr}）`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.code, 'stdout 里必须带错误码')
    assert.match(result.stderr, /迁移被拒/)
  }
})

test('CLI: 未知目标阶段 → 退出码 2', () => {
  const result = runPhase(['advance', '--session', 'sess-cli', '--to', 'deploy', '--root', makeRoot()])
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).error.code, PHASE_ERROR_CODES.UNKNOWN_TARGET)
})

test('CLI: 正常推进链 exit 0，show 读回当前阶段', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  for (const to of ['implement', 'verify', 'review']) {
    const result = runPhase(['advance', '--session', 'sess-cli2', '--to', to, '--root', root])
    assert.equal(result.status, 0, `advance 到 ${to} 应成功（stderr: ${result.stderr}）`)
    assert.equal(JSON.parse(result.stdout).ok, true)
  }

  const shown = runPhase(['show', '--session', 'sess-cli2', '--root', root])
  assert.equal(shown.status, 0, `stderr: ${shown.stderr}`)
  const read = JSON.parse(shown.stdout)
  assert.equal(read.missing, false)
  assert.equal(read.state.phase, 'review')
  assert.equal(read.state.revision, 3)
})

test('CLI: show 未写过的会话 → exit 0 + missing=true（读操作幂等）', () => {
  const result = runPhase(['show', '--session', 'sess-fresh', '--root', makeRoot()])
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).missing, true)
})

test('CLI: 返工耗尽 → 退出码 2 且 error.code=REWORK_EXHAUSTED', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // 先把状态直接置到「3 轮已用完的 review」
  const state = createState({ sessionKey: 'sess-ex' })
  state.reworkRounds = MAX_REWORK_ROUNDS
  state.phase = 'review'
  writePhaseState({ root, sessionKey: 'sess-ex', state })

  const result = runPhase(['advance', '--session', 'sess-ex', '--to', 'implement', '--root', root])
  assert.equal(result.status, 2, `stderr: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.error.code, PHASE_ERROR_CODES.REWORK_EXHAUSTED)
  assert.equal(parsed.state.reworkRounds, MAX_REWORK_ROUNDS, '被拒时计数不得前进')
})

test('CLI: 用法错误 → 退出码 1（与迁移被拒的 2 区分开）', () => {
  const cases = [
    ['advance', '--session', 's'], // 缺 --to
    ['advance', '--to', 'implement'], // 缺 --session
    ['advance'], // 两者都缺
    ['advance', '--session', 's', '--to', 'implement', '--bogus', 'x'],
    ['show'], // 缺 --session
    ['nope'],
    [],
  ]
  for (const args of cases) {
    const result = runPhase(args)
    assert.equal(result.status, 1, `args=${JSON.stringify(args)} 应退出 1（stderr: ${result.stderr}）`)
    assert.match(result.stderr, /用法/)
  }
})

test('CLI: --help 退出 0 且打印迁移表', () => {
  const result = runPhase(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /phase advance/)
  assert.match(result.stdout, /review → implement/)
  assert.match(result.stdout, new RegExp(String(MAX_REWORK_ROUNDS)))
})
