import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { TIERS, TIER_ERROR_CODES, TierError, classifyTier, readTier, recordTier } from '../../lib/tier.mjs'

const BIN_TIER = fileURLToPath(new URL('../../bin/tier.mjs', import.meta.url))

/** 每个用例一个独立临时根，绝不写进仓库工作区。 */
function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tier-'))
}

/** 跑 CLI，返回 { status, stdout, stderr }。 */
function runTier(args) {
  return spawnSync(process.execPath, [BIN_TIER, ...args], { encoding: 'utf8' })
}

// ---------------------------------------------------------------------------
// 分类规则：三个分支各一例
// ---------------------------------------------------------------------------

test('classifyTier: 单点单文件不需判断 → self', () => {
  const result = classifyTier({ singlePoint: true, files: 1, needsOpinion: false })
  assert.equal(result.tier, 'self')
  assert.ok(result.reasons.length > 0, 'self 也要给理由')
  assert.match(result.reasons[0], /规则 self/)
  assert.ok(result.evidence.includes('singlePoint=true'), 'evidence 必须带实际 feature 值')
  assert.ok(result.evidence.includes('files=1'))
})

test('classifyTier: 需要意见且无工件 → expert', () => {
  const result = classifyTier({ needsOpinion: true, needsArtifact: false, files: 3, modules: 2 })
  assert.equal(result.tier, 'expert')
  assert.match(result.reasons.join('\n'), /规则 expert/)
  assert.ok(result.reasons.some((reason) => /needsOpinion=true/.test(reason)), '理由要点名驱动字段')
})

test('classifyTier: 工件 + 可机器验收 + width>=3 + 需返工 → team', () => {
  const result = classifyTier({
    needsArtifact: true,
    machineVerifiable: true,
    width: 3,
    needsRework: true,
    files: 8,
    modules: 3,
  })
  assert.equal(result.tier, 'team')
  assert.match(result.reasons[0], /规则 team/)
  assert.ok(result.reasons[0].includes('width=3'), '理由要带具体宽度')
})

// ---------------------------------------------------------------------------
// 分类规则：四条 team 条件缺一条都不许判 team（逐条反向断言）
// ---------------------------------------------------------------------------

test('classifyTier: team 四条件缺任一即回落 expert 并点名缺哪条', () => {
  const base = { needsArtifact: true, machineVerifiable: true, width: 3, needsRework: true }
  /** @type {Array<[string, Record<string, unknown>, RegExp]>} */
  const cases = [
    ['缺 needsArtifact', { ...base, needsArtifact: false }, /needsArtifact=false/],
    ['缺 machineVerifiable', { ...base, machineVerifiable: false }, /machineVerifiable=false/],
    ['width 不足', { ...base, width: 2 }, /width=2 < 3/],
    ['缺 needsRework', { ...base, needsRework: false }, /needsRework=false/],
  ]
  for (const [label, features, pattern] of cases) {
    const result = classifyTier(features)
    assert.equal(result.tier, 'expert', `${label} 时不应判 team`)
    assert.match(result.reasons.join('\n'), pattern, `${label} 时理由必须点名缺口`)
  }
})

test('classifyTier: width 未提供 / 0 / 负值 都不满足 team 的宽度条件', () => {
  const base = { needsArtifact: true, machineVerifiable: true, needsRework: true }
  assert.equal(classifyTier({ ...base, width: 0 }).tier, 'expert')
  assert.equal(classifyTier({ ...base, width: -5 }).tier, 'expert')
  // 未提供 width：不得因为 undefined>=3 之类比较而误判，且要留痕
  const missingWidth = classifyTier(base)
  assert.equal(missingWidth.tier, 'expert')
  assert.ok(
    missingWidth.reasons.some((reason) => /width 未知/.test(reason)),
    'width 缺失要留下痕迹而不是静默按 0 处理',
  )
})

// ---------------------------------------------------------------------------
// 边界输入：非对象一律抛带错误码的 Error
// ---------------------------------------------------------------------------

test('classifyTier: 非对象 features 抛 TierError(INVALID_FEATURES)', () => {
  /** @type {unknown[]} */
  const badInputs = [undefined, null, [], 'singlePoint', 42, true]
  for (const bad of badInputs) {
    assert.throws(
      () => classifyTier(bad),
      (error) => {
        assert.ok(error instanceof TierError, `必须抛 TierError（收到 ${String(bad)}）`)
        assert.equal(error.code, TIER_ERROR_CODES.INVALID_FEATURES)
        assert.match(error.message, /Fix:/, '错误信息必须给修复动作')
        return true
      },
      `输入 ${JSON.stringify(bad) ?? String(bad)} 必须抛错`,
    )
  }
})

test('classifyTier: 空对象 → expert（保守兜底）且理由点明信息不足', () => {
  const result = classifyTier({})
  assert.equal(result.tier, 'expert')
  const joined = result.reasons.join('\n')
  assert.match(joined, /兜底/, '空输入必须走兜底规则而不是 self')
  assert.match(joined, /未提供/, '缺失字段必须留痕')
  assert.ok(result.evidence.every((item) => typeof item === 'string'))
})

test('classifyTier: 非布尔 / 非数字字段被降级为 false/unknown 且留痕', () => {
  const result = classifyTier({
    singlePoint: 'true', // 字符串 truthy：不得当成 true 判成 self
    files: '1',
    needsOpinion: 0,
    width: Number.NaN,
  })
  assert.equal(result.tier, 'expert', 'truthy 字符串不能被当成 true')
  const joined = result.reasons.join('\n')
  assert.match(joined, /singlePoint 非布尔值/)
  assert.match(joined, /files 不是非负数字/)
  assert.match(joined, /width 不是非负数字/)
})

test('classifyTier: 未识别字段不静默丢弃，写进理由', () => {
  const result = classifyTier({ singlePoint: true, files: 1, needsOpinion: false, unknownDim: true })
  assert.equal(result.tier, 'self', '未识别字段不改变判档结果')
  assert.match(result.reasons.join('\n'), /忽略未识别字段：unknownDim/)
})

test('classifyTier: 纯函数 —— 同一输入两次结果一致，且不修改入参', () => {
  const features = { needsArtifact: true, machineVerifiable: true, width: 4, needsRework: true }
  const snapshot = JSON.stringify(features)
  const first = classifyTier(features)
  const second = classifyTier(features)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(features), snapshot, '入参不得被改写')
})

// ---------------------------------------------------------------------------
// 回归（独立评审 P2）：modules 曾「被接收、被回显、从不参与判定」
//
// 失效形态：`grep -n modules lib/tier.mjs` 只在 COUNT_FEATURES / evidence 出现，没有任何
// 规则读它；于是 `{singlePoint:true, files:1, modules:10}` 判 self（亲做豁免），
// 而 AGENTS.md 的触发条件是「跨 ≥2 个模块**或** ≥3 个文件 → 必须先叫人」——
// 跨 10 个模块的改动被套上「单文件机械改动」豁免，正是本工具要防的越界判档。
// ---------------------------------------------------------------------------

test('🦷 红牙 P2：singlePoint + files:1 + modules:2 → 不得判 self（跨多模块不许走亲做豁免）', () => {
  const result = classifyTier({ singlePoint: true, files: 1, modules: 2 })
  assert.notEqual(result.tier, 'self', 'modules >= 2 时必须拦住 self 豁免')
  assert.equal(result.tier, 'expert', 'self 被拦下后按保守中间档处理')
  const joined = result.reasons.join('\n')
  assert.match(joined, /未判 self：.*modules=2 ≥2/, '理由必须点名 modules 这一维与实际取值')
  assert.match(joined, /AGENTS\.md/, '要点出这是 AGENTS.md 的触发条件，而不是自造规则')
})

test('🦷 红牙 P2：modules:10 + files:1 + singlePoint 的极端形态也不得判 self（真机复现输入）', () => {
  // 评审给的复现：node bin/tier.mjs classify --features '{"singlePoint":true,"files":1,"modules":10}'
  const result = classifyTier({ singlePoint: true, files: 1, modules: 10 })
  assert.equal(result.tier, 'expert')
  assert.match(result.reasons.join('\n'), /modules=10 ≥2/)
  assert.ok(result.evidence.includes('modules=10'), 'evidence 仍照实回显（但不只是回显）')
})

test('模块维度：modules=1 / 0 仍可判 self；modules 未知不拦 self 但必须留痕（可区分「没传」与「传了 1」）', () => {
  assert.equal(classifyTier({ singlePoint: true, files: 1, modules: 1 }).tier, 'self')
  assert.equal(classifyTier({ singlePoint: true, files: 1, modules: 0 }).tier, 'self')

  const unknown = classifyTier({ singlePoint: true, files: 1 })
  assert.equal(unknown.tier, 'self', '既有多数调用方不传 modules，未知不得让规则 1 事实失效')
  assert.match(unknown.reasons.join('\n'), /modules 未知（未参与 self 判定/, '未知要留痕')
})

test('模块维度：非 self 分支都要说明「为什么没走 self」（可审计，不只一句兜底）', () => {
  const team = classifyTier({ needsArtifact: true, machineVerifiable: true, width: 3, needsRework: true, files: 8, modules: 1 })
  assert.equal(team.tier, 'team')
  assert.match(team.reasons.join('\n'), /未判 self：/, 'team 分支也要交代 self 被什么条件排除')

  const expert = classifyTier({ needsOpinion: true, needsArtifact: false })
  assert.ok(expert.reasons.some((reason) => /未判 self：/.test(reason)))
})

test('explainTeamShortfall 点名 modules：≥2 与未知各自有话说（不再只在 evidence 里出现）', () => {
  const multiModule = classifyTier({ needsArtifact: true, machineVerifiable: true, width: 2, needsRework: true, modules: 5 })
  assert.equal(multiModule.tier, 'expert')
  assert.match(multiModule.reasons.join('\n'), /模块维度：modules=5 ≥2/)

  const unknownModule = classifyTier({ needsArtifact: true, machineVerifiable: true, width: 2, needsRework: true })
  assert.match(unknownModule.reasons.join('\n'), /模块维度：modules 未知/)
})

// ---------------------------------------------------------------------------
// 回归（独立评审 P3）：非整数计数曾用 Math.floor 收下，恰好落到最不保守的档
//
// 失效形态：`files:1.5` 被 floor 成 1 → 判 self（单文件豁免）；`width:3.9` 被 floor 成 3
// → 判 team（宽度够）。两处向下取整都朝「更激进的结论」走，与模块自己的契约
// （非负整数；缺失或非法记 null、规则层按不满足处理）和「信息不足落更谨慎一侧」直接冲突。
// ---------------------------------------------------------------------------

test('🦷 红牙 P3：files:1.5 不得被判 self（小数计数按未知处理）', () => {
  const result = classifyTier({ singlePoint: true, files: 1.5 })
  assert.notEqual(result.tier, 'self', '1.5 不是「单文件」，不能被 floor 成 1')
  assert.equal(result.tier, 'expert')
  const joined = result.reasons.join('\n')
  assert.match(joined, /files=1\.5 不是整数/, '要说明为什么被降级为未知')
  assert.match(joined, /files 未知/, '规则层要按「未知」处理，而不是按 1')
  assert.equal(result.evidence.includes('files=unknown'), true, 'evidence 必须显示 unknown，不能显示 1')
})

test('🦷 红牙 P3：width:3.9 不得够到 team 的宽度门槛（小数不是 3）', () => {
  const result = classifyTier({ needsArtifact: true, machineVerifiable: true, width: 3.9, needsRework: true })
  assert.notEqual(result.tier, 'team', '3.9 不能被 floor 成 3 去满足 width>=3')
  assert.equal(result.tier, 'expert')
  assert.match(result.reasons.join('\n'), /width=3\.9 不是整数/)
  assert.match(result.reasons.join('\n'), /width 未知/)
  assert.equal(result.evidence.includes('width=unknown'), true)
})

test('P3 边界：合法的整数与 0 不被误伤（0 是「合法计数」，只是不满足对应阈值）', () => {
  // 0 / 1 / 3 这类整数照旧接受
  assert.equal(classifyTier({ singlePoint: true, files: 1, modules: 0 }).tier, 'self')
  assert.equal(classifyTier({ needsArtifact: true, machineVerifiable: true, width: 3, needsRework: true }).tier, 'team')
  assert.equal(classifyTier({ needsArtifact: true, machineVerifiable: true, width: 4, needsRework: true }).tier, 'team')

  // files:0 是合法值，但 0 !== 1 → 不判 self（不是因为「0 非法」）
  const zero = classifyTier({ singlePoint: true, files: 0 })
  assert.equal(zero.tier, 'expert')
  assert.match(zero.reasons.join('\n'), /files=0（不是 1）/, '理由要区分「0 合法但不是 1」与「值非法」')
  assert.doesNotMatch(zero.reasons.join('\n'), /files 不是非负数字|files=0 不是整数/)

  // width:0 仍走「< 3」而不是「未知」——它是合法整数，只是不够宽
  const zeroWidth = classifyTier({ needsArtifact: true, machineVerifiable: true, width: 0, needsRework: true })
  assert.match(zeroWidth.reasons.join('\n'), /width=0 < 3/)
})

test('P3 边界：NaN / Infinity / 负数 / 字符串仍是「非法」，与「非整数」区分留痕', () => {
  for (const [label, value, pattern] of [
    ['NaN', Number.NaN, /files 不是非负数字/],
    ['Infinity', Number.POSITIVE_INFINITY, /files 不是非负数字/],
    ['负数', -1, /files 不是非负数字/],
    ['字符串', '2', /files 不是非负数字/],
  ]) {
    const result = classifyTier({ singlePoint: true, files: value })
    assert.notEqual(result.tier, 'self', `${label} 不得判 self`)
    assert.match(result.reasons.join('\n'), pattern, `${label} 的留痕要与非整数区分`)
    assert.doesNotMatch(result.reasons.join('\n'), /不是整数/, `${label} 不该被说成「不是整数」`)
  }
})

// ---------------------------------------------------------------------------
// recordTier / readTier：落盘、读回一致、路径安全
// ---------------------------------------------------------------------------

test('recordTier: 追加写 + readTier 读回一致（append-only，顺序保留）', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const first = recordTier({
    root,
    sessionKey: 'sess-a',
    tier: 'self',
    features: { singlePoint: true, files: 1, needsOpinion: false },
    reasons: ['规则 self：单文件单点'],
  })
  assert.equal(first.file, path.join(root, '.dsh', 'tiers', 'sess-a.jsonl'))
  assert.equal(first.record.tier, 'self')
  assert.equal(first.record.sessionKey, 'sess-a')
  assert.ok(typeof first.record.at === 'string' && first.record.at.includes('T'), 'at 必须是 ISO 时间戳')

  recordTier({ root, sessionKey: 'sess-a', tier: 'team', features: { needsArtifact: true }, reasons: [] })

  const read = readTier({ root, sessionKey: 'sess-a' })
  assert.equal(read.missing, false)
  assert.deepEqual(read.corrupt, [])
  assert.equal(read.records.length, 2, 'append-only：两次写必须两条都在')
  assert.deepEqual(read.records[0], first.record, '读回的第一条必须与写入值逐字段相等')
  assert.equal(read.records[1].tier, 'team')

  // 行数 = 记录数（一条一行，不留空行污染下游 jq）
  const raw = fs.readFileSync(first.file, 'utf8')
  assert.equal(raw.trim().split('\n').length, 2)
})

test('recordTier: root 缺省用 cwd（临时切目录验证，写完还原）', (t) => {
  const root = makeRoot()
  const previous = process.cwd()
  t.after(() => {
    process.chdir(previous)
    fs.rmSync(root, { recursive: true, force: true })
  })
  process.chdir(root)

  const saved = recordTier({ sessionKey: 'sess-cwd', tier: 'expert', features: {}, reasons: [] })
  assert.equal(saved.file, path.join(fs.realpathSync(root), '.dsh', 'tiers', 'sess-cwd.jsonl'))
  assert.ok(fs.existsSync(saved.file))
})

test('readTier: 文件不存在 → records=[] 且 missing=true，不抛', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const read = readTier({ root, sessionKey: 'never-written' })
  assert.deepEqual(read.records, [])
  assert.equal(read.missing, true)
  assert.deepEqual(read.corrupt, [])
})

test('readTier: 坏行不静默吞掉 —— 跳过并报行号，好行照读', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  recordTier({ root, sessionKey: 'sess-bad', tier: 'self', features: {}, reasons: [] })
  const file = path.join(root, '.dsh', 'tiers', 'sess-bad.jsonl')
  fs.appendFileSync(file, '{ 不是 JSON\n', 'utf8')
  fs.appendFileSync(file, '["数组不是记录"]\n', 'utf8')
  recordTier({ root, sessionKey: 'sess-bad', tier: 'expert', features: {}, reasons: [] })

  const read = readTier({ root, sessionKey: 'sess-bad' })
  assert.equal(read.records.length, 2, '两条合法记录必须都能读回')
  assert.equal(read.corrupt.length, 2, '两条坏行都要被报出来')
  assert.equal(read.corrupt[0].line, 2, '坏行必须带行号便于手修')
  assert.equal(read.corrupt[1].line, 3)
})

test('recordTier: tier 非法抛 TierError(INVALID_TIER)，且不落盘', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const bad of ['TEAM', 'worker', '', null, 3, undefined]) {
    assert.throws(
      () => recordTier({ root, sessionKey: 'sess-x', tier: bad, features: {}, reasons: [] }),
      (error) => {
        assert.ok(error instanceof TierError)
        assert.equal(error.code, TIER_ERROR_CODES.INVALID_TIER)
        assert.match(error.message, /Fix:/)
        return true
      },
      `tier=${String(bad)} 必须抛错`,
    )
  }
  assert.equal(fs.existsSync(path.join(root, '.dsh')), false, '被判非法时不得产生任何文件')
})

test('recordTier: features 非对象抛 TierError(INVALID_FEATURES)', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(
    () => recordTier({ root, sessionKey: 'sess-y', tier: 'self', features: null }),
    (error) => error instanceof TierError && error.code === TIER_ERROR_CODES.INVALID_FEATURES,
  )
  assert.throws(
    () => recordTier({ root, sessionKey: 'sess-y', tier: 'self', features: 'oops' }),
    (error) => error instanceof TierError && error.code === TIER_ERROR_CODES.INVALID_FEATURES,
  )
})

test('recordTier: sessionKey 越界写法一律拒绝（不写到 <root> 之外）', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  /** @type {unknown[]} */
  const badKeys = ['', '   ', '../escape', 'a/b', 'a\\b', '.', '..', '/abs', 42, null, undefined]
  for (const key of badKeys) {
    assert.throws(
      () => recordTier({ root, sessionKey: key, tier: 'self', features: {}, reasons: [] }),
      (error) => {
        assert.ok(error instanceof TierError, `sessionKey=${String(key)} 必须抛 TierError`)
        assert.equal(error.code, TIER_ERROR_CODES.INVALID_SESSION_KEY)
        return true
      },
      `sessionKey=${String(key)} 必须被拒`,
    )
  }
  assert.equal(fs.existsSync(path.join(root, '.dsh')), false, '越界 key 不得写出任何文件')
  assert.equal(fs.existsSync(path.join(path.dirname(root), 'escape.jsonl')), false, '../escape 不得逃出 root')
})

test('recordTier: reasons 非数组抛错；非字符串元素被 stringify 而不是丢弃', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(
    () => recordTier({ root, sessionKey: 'sess-r', tier: 'self', features: {}, reasons: 'not-array' }),
    (error) => error instanceof TierError,
  )
  const saved = recordTier({ root, sessionKey: 'sess-r', tier: 'self', features: {}, reasons: ['ok', 42] })
  assert.deepEqual(saved.record.reasons, ['ok', '42'])
})

// ---------------------------------------------------------------------------
// CLI 契约
// ---------------------------------------------------------------------------

test('CLI: tier classify 输出 JSON、退出码 0', () => {
  const result = runTier(['classify', '--features', '{"singlePoint":true,"files":1,"needsOpinion":false}'])
  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.tier, 'self')
  assert.ok(Array.isArray(parsed.reasons))
  assert.ok(Array.isArray(parsed.evidence))
})

test('CLI: tier record → tier show 读回一致，退出码 0', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const recorded = runTier([
    'record',
    '--session',
    'sess-cli',
    '--features',
    '{"needsArtifact":true,"machineVerifiable":true,"width":3,"needsRework":true}',
    '--root',
    root,
  ])
  assert.equal(recorded.status, 0, `stderr: ${recorded.stderr}`)
  const saved = JSON.parse(recorded.stdout)
  assert.equal(saved.record.tier, 'team', '未给 --tier 时应现判')

  const shown = runTier(['show', '--session', 'sess-cli', '--root', root])
  assert.equal(shown.status, 0, `stderr: ${shown.stderr}`)
  const read = JSON.parse(shown.stdout)
  assert.equal(read.records.length, 1)
  assert.deepEqual(read.records[0], saved.record)
})

test('CLI: tier record --tier 显式指定时按其落盘', (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const recorded = runTier(['record', '--session', 'sess-t', '--features', '{}', '--tier', 'self', '--root', root])
  assert.equal(recorded.status, 0, `stderr: ${recorded.stderr}`)
  assert.equal(JSON.parse(recorded.stdout).record.tier, 'self')
})

test('CLI: 非法 JSON / 未知选项 / 缺参数 / 非对象 features → 退出码 1 且诊断走 stderr', () => {
  const cases = [
    ['classify', '--features', '{oops}'],
    ['classify'],
    ['classify', '--bogus', 'x'],
    ['record', '--features', '{}'], // 缺 --session
    ['nope'],
    [],
    // 合法 JSON 但不是对象：必须拒绝，且文案点明真实类型（null 不能报成 object）
    ['classify', '--features', 'null'],
    ['classify', '--features', '[]'],
    ['classify', '--features', '42'],
  ]
  for (const args of cases) {
    const result = runTier(args)
    assert.equal(result.status, 1, `args=${JSON.stringify(args)} 应退出 1（stderr: ${result.stderr}）`)
    assert.equal(result.stdout, '', '失败时 stdout 必须干净')
    assert.match(result.stderr, /用法/, '失败必须附用法说明')
  }
  // 类型文案精确断言：null / array / number 各说各的，便于排障
  assert.match(runTier(['classify', '--features', 'null']).stderr, /实际是 null/)
  assert.match(runTier(['classify', '--features', '[]']).stderr, /实际是 array/)
  assert.match(runTier(['classify', '--features', '42']).stderr, /实际是 number/)
})

test('CLI: --help 退出 0 且打印用法', () => {
  const result = runTier(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /tier classify/)
  assert.match(result.stdout, new RegExp(TIERS.join(' \\| ')))
})
