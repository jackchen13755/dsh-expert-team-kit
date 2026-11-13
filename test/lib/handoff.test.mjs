/**
 * dsh-expert-team-kit / test/lib/handoff.test.mjs
 *
 * 「交接五段」的测试。
 *
 * 验收重点不是「正常文本能解析」，而是**门禁会不会在该红的时候红**：
 * 交接文档的价值全在「缺段就不让过」，所以每个判定都成对钉住正反两侧
 * ——「该判通过的判通过（防误报）」+「该判不合格的判不合格（防漏报）」。
 *
 * 唯一的**红牙用例**（删掉实现里的对应判定就会变红，见文件末尾 `RED TOOTH` 段）：
 * 「空段只有标题没内容 → 仍算 missing」。历史失效形态就是「有标题就算写过」，
 * 于是五段全在、内容全空，check 一路绿灯，换会话照样什么都不知道。
 *
 * 所有落盘都在 `os.tmpdir()` 下的临时目录里，跑完删掉——测试不许往仓库里写产物。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  HANDOFF_SECTIONS,
  HandoffError,
  MAX_SECTION_LINES,
  appendToHandoff,
  formatHandoff,
  handoffPathFor,
  parseHandoff,
  verifyHandoff,
} from '../../lib/handoff.mjs'

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(KIT_ROOT, 'bin', 'handoff.mjs')

/** 每个用例自己造一个临时根，互不干扰；after 统一清理。 */
const tempRoots = []

/**
 * @returns {string} 新建的临时工程根（绝对路径）
 */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'))
  tempRoots.push(root)
  return root
}

after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不该把测试结果带红：临时目录由系统兜底回收
    }
  }
})

/**
 * 跑 CLI。
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * 五段齐全的交接文档对象（按需覆盖某几段）。
 * @param {Record<string, string | string[]>} overrides
 */
function fullInput(overrides = {}) {
  return {
    decided: ['选了方案 A：缓存层独立部署，理由是回滚粒度更细'],
    rejected: ['否决方案 B：KV 一致性无法在网关层验证'],
    risks: ['并发写同一 key 时后写覆盖，尚未加锁'],
    files: ['dsh-expert-team-kit/lib/handoff.mjs'],
    remaining: ['补 append 的并发用例，验收：node --test dsh-expert-team-kit/test/lib/handoff.test.mjs'],
    ...overrides,
  }
}

/** 段标题（中文），测试里按标题拼文档更方便。 */
function titleOf(id) {
  return HANDOFF_SECTIONS.find((section) => section.id === id).title
}

// ---------------------------------------------------------------------------
// HANDOFF_SECTIONS
// ---------------------------------------------------------------------------

test('HANDOFF_SECTIONS: 五段 id 与中文标题固定，顺序即渲染顺序', () => {
  assert.deepEqual(
    HANDOFF_SECTIONS.map((section) => section.id),
    ['decided', 'rejected', 'risks', 'files', 'remaining'],
  )
  assert.deepEqual(
    HANDOFF_SECTIONS.map((section) => section.title),
    ['已定', '已否决', '风险', '涉及文件', '待办'],
  )
  // 定义是不可变的：调用方误改会静默污染所有渲染
  assert.throws(() => {
    HANDOFF_SECTIONS.push({ id: 'x', title: 'y' })
  })
})

test('HANDOFF_SECTIONS: MAX_SECTION_LINES 是 20', () => {
  assert.equal(MAX_SECTION_LINES, 20)
})

// ---------------------------------------------------------------------------
// parseHandoff
// ---------------------------------------------------------------------------

test('parseHandoff: 五段齐时逐段切出正文，extra 为空', () => {
  const { sections, extra } = parseHandoff(formatHandoff(fullInput()))
  assert.deepEqual(extra, [])
  assert.equal(sections.decided, '选了方案 A：缓存层独立部署，理由是回滚粒度更细')
  assert.equal(sections.rejected, '否决方案 B：KV 一致性无法在网关层验证')
  assert.equal(sections.risks, '并发写同一 key 时后写覆盖，尚未加锁')
  assert.equal(sections.files, 'dsh-expert-team-kit/lib/handoff.mjs')
  assert.match(sections.remaining, /补 append 的并发用例/)
})

test('parseHandoff: 五段的键一定都在（缺的段是 null，不是 undefined）', () => {
  const { sections } = parseHandoff('## 已定\n只写了这一段\n')
  const ids = HANDOFF_SECTIONS.map((section) => section.id)
  assert.deepEqual(Object.keys(sections).sort(), [...ids].sort())
  assert.equal(sections.decided, '只写了这一段')
  for (const id of ids.slice(1)) {
    assert.equal(sections[id], null, `${id} 必须是 null（缺段），不能是 undefined`)
  }
})

test('parseHandoff: 认段 id 当标题、认行尾中英文冒号、认 CRLF', () => {
  const text = '## decided：\r\n选了 A\r\n\r\n## Rejected:\r\n否 B\r\n\r\n## risks\r\nr\r\n\r\n## files\r\nf\r\n\r\n## remaining\r\nn\r\n'
  const { sections } = parseHandoff(text)
  assert.equal(sections.decided, '选了 A')
  assert.equal(sections.rejected, '否 B')
  assert.equal(sections.risks, 'r')
  assert.equal(sections.files, 'f')
  assert.equal(sections.remaining, 'n')
})

test('parseHandoff: 不属于五段的标题进 extra（不静默丢弃）', () => {
  const text = [
    '# 交接 2026-11-13',
    '## 已定',
    '选了 A',
    '## 上下文',
    '这条工作线在改 handoff 模块',
    '## 待办',
    '继续写测试',
  ].join('\n')
  const { sections, extra } = parseHandoff(text)
  assert.equal(sections.decided, '选了 A')
  assert.equal(sections.remaining, '继续写测试')
  assert.equal(extra.length, 1)
  assert.equal(extra[0].title, '上下文')
  assert.equal(extra[0].text, '这条工作线在改 handoff 模块')
})

test('parseHandoff: 同一段标题重复出现时正文拼接，不丢前一段内容', () => {
  const { sections } = parseHandoff('## 已否决\n否 B\n## 已否决\n否 C\n')
  assert.equal(sections.rejected, '否 B\n否 C')
})

test('parseHandoff: 空字符串 / 只有散文 都能解析（五段全 null，不抛错）', () => {
  for (const text of ['', '   \n\n', '一段没有任何标题的散文\n']) {
    const { sections, extra } = parseHandoff(text)
    for (const section of HANDOFF_SECTIONS) {
      assert.equal(sections[section.id], null)
    }
    assert.deepEqual(extra, [])
  }
})

test('parseHandoff: 非字符串入参抛 HandoffError（带 code 与 Fix）', () => {
  for (const bad of [undefined, null, 123, {}, [], Symbol('x'), true]) {
    assert.throws(
      () => parseHandoff(bad),
      (error) => {
        assert.ok(error instanceof HandoffError, '必须是 HandoffError')
        assert.equal(error.code, 'HANDOFF_INVALID_TEXT')
        assert.match(error.message, /Fix:/, '错误信息必须给修复动作')
        return true
      },
      `parseHandoff(${String(bad)}) 必须抛错`,
    )
  }
})

// ---------------------------------------------------------------------------
// verifyHandoff
// ---------------------------------------------------------------------------

test('verifyHandoff: 五段齐 -> ok，missing/empty/overlong 都为空', () => {
  const result = verifyHandoff(formatHandoff(fullInput()))
  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.empty, [])
  assert.deepEqual(result.overlong, [])
  assert.deepEqual(result.counts, { decided: 1, rejected: 1, risks: 1, files: 1, remaining: 1 })
})

test('verifyHandoff: 缺一段 -> not ok，只报那一段', () => {
  // 手写文档缺整段标题（不是 formatHandoff 生成的、带占位注释的那种）
  const text = [
    '## 已定',
    '选了方案 A',
    '## 已否决',
    '否决方案 B',
    '## 涉及文件',
    'dsh-expert-team-kit/lib/handoff.mjs',
    '## 待办',
    '补并发用例',
  ].join('\n')

  const result = verifyHandoff(text)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['risks'])
  assert.deepEqual(result.empty, [], '连标题都没有的段不该同时进 empty')
})

test('verifyHandoff: 空字符串 -> 五段全 missing（连标题都没有，故不进 empty）', () => {
  const result = verifyHandoff('')
  assert.equal(result.ok, false)
  assert.equal(result.missing.length, 5)
  assert.deepEqual(result.missing, HANDOFF_SECTIONS.map((section) => section.id))
  assert.deepEqual(result.empty, [], 'empty 只装「有标题没内容」，空文档没有标题')
  assert.deepEqual(result.counts, { decided: 0, rejected: 0, risks: 0, files: 0, remaining: 0 })
})

// ---------------------------------------------------------------------------
// RED TOOTH：空段（只有标题没内容）必须算 missing
//
// 删掉 verifyHandoff 里 `lines.length === 0 → missing/empty` 那段判定，
// 或者把判据改成「标题在就算写过」，这条用例立刻变红：五段全绿、内容全空，
// check 退出码 0，换会话的人拿到的是一份什么信息都没有的、看起来合格的文档。
// ---------------------------------------------------------------------------

test('RED TOOTH verifyHandoff: 空段（只有标题没内容）算 missing，不算写过', () => {
  const text = HANDOFF_SECTIONS.map((section) => `## ${section.title}\n`).join('\n')
  const result = verifyHandoff(text)
  assert.equal(result.ok, false, '五段标题都在但内容全空，必须判不合格')
  assert.deepEqual(result.missing, HANDOFF_SECTIONS.map((section) => section.id))
  assert.deepEqual(result.empty, result.missing, '这五段都属于「有标题没内容」')

  // 只空一段也必须红（防止「整体判空」那种图省事的实现）
  const oneEmpty = formatHandoff(fullInput({ risks: [] }))
  const single = verifyHandoff(oneEmpty)
  assert.equal(single.ok, false)
  assert.deepEqual(single.missing, ['risks'])
  assert.deepEqual(single.empty, ['risks'])

  // 反向：同一份文档把那一段填上就转绿（钉住「红」是这一段引起的，不是别的原因）
  const filled = verifyHandoff(formatHandoff(fullInput({ risks: ['已知风险 X'] })))
  assert.equal(filled.ok, true)
  assert.deepEqual(filled.missing, [])
})

test('verifyHandoff: 只有模板占位注释 <!-- 待补 --> 的段算空段', () => {
  const text = `## 已定\n<!-- 待补 -->\n## 已否决\n否 B\n## 风险\nr\n## 涉及文件\nf\n## 待办\nn\n`
  const result = verifyHandoff(text)
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['decided'])
  assert.deepEqual(result.empty, ['decided'])
  assert.equal(result.counts.decided, 0, '注释行不计入 counts')
})

test('verifyHandoff: 纯空白行不算内容（只剩空白的段仍是空段）', () => {
  const text = '## 已定\n   \n\t\n## 已否决\n否 B\n## 风险\nr\n## 涉及文件\nf\n## 待办\nn\n'
  const result = verifyHandoff(text)
  assert.deepEqual(result.missing, ['decided'])
})

test(`verifyHandoff: 超过 ${MAX_SECTION_LINES} 行只告警 overlong，不判失败`, () => {
  const over = Array.from({ length: MAX_SECTION_LINES + 1 }, (_, index) => `第 ${index + 1} 行`).join('\n')
  const result = verifyHandoff(formatHandoff(fullInput({ risks: over })))
  assert.equal(result.ok, true, '超长只告警，不判失败')
  assert.deepEqual(result.missing, [])
  assert.equal(result.overlong.length, 1)
  assert.deepEqual(result.overlong[0], { id: 'risks', lines: MAX_SECTION_LINES + 1, max: MAX_SECTION_LINES })
  assert.equal(result.counts.risks, MAX_SECTION_LINES + 1)

  // 边界：正好 20 行不告警
  const exact = Array.from({ length: MAX_SECTION_LINES }, (_, index) => `第 ${index + 1} 行`).join('\n')
  assert.deepEqual(verifyHandoff(formatHandoff(fullInput({ risks: exact }))).overlong, [])
})

test('verifyHandoff: 非字符串入参抛 HandoffError', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.throws(() => verifyHandoff(bad), (error) => error.code === 'HANDOFF_INVALID_TEXT')
  }
})

// ---------------------------------------------------------------------------
// formatHandoff
// ---------------------------------------------------------------------------

test('formatHandoff: 无参调用即五段空模板，且五段标题按序都在', () => {
  const template = formatHandoff()
  const headings = template.split('\n').filter((line) => line.startsWith('## '))
  assert.deepEqual(headings, HANDOFF_SECTIONS.map((section) => `## ${section.title}`))
  assert.match(template, /<!-- 待补 -->/)
  // 空模板必须判不合格（防止把「生成了模板」误当「写完了」）
  assert.equal(verifyHandoff(template).ok, false)
})

test('formatHandoff: 数组与字符串两种写法等价，且以换行结尾', () => {
  const fromArray = formatHandoff(fullInput())
  const fromString = formatHandoff({
    decided: '选了方案 A：缓存层独立部署，理由是回滚粒度更细',
    rejected: '否决方案 B：KV 一致性无法在网关层验证',
    risks: '并发写同一 key 时后写覆盖，尚未加锁',
    files: 'dsh-expert-team-kit/lib/handoff.mjs',
    remaining: '补 append 的并发用例，验收：node --test dsh-expert-team-kit/test/lib/handoff.test.mjs',
  })
  assert.equal(fromArray, fromString)
  assert.ok(fromArray.endsWith('\n'))
  assert.ok(!fromArray.endsWith('\n\n'), '结尾只留一个换行')
})

test('formatHandoff: 空段渲染标题 + 占位注释（先出骨架再逐段填）', () => {
  const text = formatHandoff({ decided: '选了 A' })
  assert.match(text, /## 已定\n选了 A/)
  assert.match(text, /## 已否决\n<!-- 待补 -->/)
  assert.equal(verifyHandoff(text).counts.decided, 1)
})

test('formatHandoff: extra 段渲染在五段之后', () => {
  const text = formatHandoff({ ...fullInput(), extra: [{ title: '上下文', text: '改 handoff 模块' }] })
  assert.match(text, /### 上下文\n改 handoff 模块/)
  assert.ok(text.indexOf('### 上下文') > text.indexOf('## 待办'))
  assert.equal(verifyHandoff(text).ok, true, 'extra 不影响五段判定')
})

test('formatHandoff: 非对象 / 段类型不支持 一律抛可操作错误（不渲染 [object Object]）', () => {
  for (const bad of [null, 'text', 42, []]) {
    assert.throws(() => formatHandoff(bad), (error) => {
      assert.equal(error.code, 'HANDOFF_INVALID_INPUT')
      assert.match(error.message, /Fix:/)
      return true
    })
  }

  assert.throws(() => formatHandoff({ decided: { a: 1 } }), (error) => {
    assert.equal(error.code, 'HANDOFF_INVALID_SECTION')
    assert.match(error.message, /decided/)
    assert.match(error.message, /Fix:/)
    return true
  })

  assert.throws(() => formatHandoff({ files: ['ok', { path: 'x' }] }), (error) => {
    assert.equal(error.code, 'HANDOFF_INVALID_SECTION')
    assert.match(error.message, /files\[1\]/)
    return true
  })
})

// ---------------------------------------------------------------------------
// appendToHandoff
// ---------------------------------------------------------------------------

test('appendToHandoff: 往已存在的段追加到段尾，不打断后一段', () => {
  const before = formatHandoff(fullInput())
  const after = appendToHandoff(before, 'rejected', '- 否决方案 C：网关无法回滚')
  const { sections } = parseHandoff(after)
  assert.equal(sections.rejected, '否决方案 B：KV 一致性无法在网关层验证\n- 否决方案 C：网关无法回滚')
  assert.equal(sections.risks, '并发写同一 key 时后写覆盖，尚未加锁', '后一段不受影响')
  assert.equal(verifyHandoff(after).ok, true)
})

test('appendToHandoff: 段不存在时在文末补该段标题（并保持整体可解析）', () => {
  const before = '## 已定\n选了 A\n'
  const after = appendToHandoff(before, 'remaining', '继续写测试')
  const { sections } = parseHandoff(after)
  assert.equal(sections.decided, '选了 A')
  assert.equal(sections.remaining, '继续写测试')
  assert.deepEqual(verifyHandoff(after).missing, ['rejected', 'risks', 'files'])
})

test('appendToHandoff: 认中文标题作为段标识', () => {
  const after = appendToHandoff(formatHandoff(fullInput()), titleOf('risks'), '新增风险 Y')
  assert.match(parseHandoff(after).sections.risks, /新增风险 Y/)
})

test('appendToHandoff: 未知段 / 空内容 / 非字符串 抛 HandoffError', () => {
  assert.throws(() => appendToHandoff('## 已定\nx\n', 'nope', 'y'), (error) => error.code === 'HANDOFF_INVALID_SECTION')
  assert.throws(() => appendToHandoff('## 已定\nx\n', 'risks', '   \n\n'), (error) => error.code === 'HANDOFF_INVALID_SECTION')
  assert.throws(() => appendToHandoff(undefined, 'risks', 'y'), (error) => error.code === 'HANDOFF_INVALID_TEXT')
})

// ---------------------------------------------------------------------------
// handoffPathFor
// ---------------------------------------------------------------------------

test('handoffPathFor: 默认 root 是 process.cwd()，规则为 <root>/.dsh/handoffs/<id>.md', () => {
  const expected = path.join(process.cwd(), '.dsh', 'handoffs', 'session-abc123.md')
  assert.equal(handoffPathFor({ sessionKey: 'session-abc123' }), expected)
  assert.equal(handoffPathFor({ sessionKey: 'session-abc123' }), handoffPathFor({ root: '', sessionKey: 'session-abc123' }))
  assert.equal(handoffPathFor({ sessionKey: 'session-abc123' }), handoffPathFor({ root: '   ', sessionKey: 'session-abc123' }))
})

test('handoffPathFor: 给 root 时按其解析，返回绝对路径', () => {
  assert.equal(
    handoffPathFor({ root: '/tmp/example-root', sessionKey: 's1' }),
    path.join('/tmp/example-root', '.dsh', 'handoffs', 's1.md'),
  )
  const relative = handoffPathFor({ root: 'some/rel', sessionKey: 's1' })
  assert.ok(path.isAbsolute(relative), '返回必须是绝对路径')
  assert.equal(relative, path.join(path.resolve('some/rel'), '.dsh', 'handoffs', 's1.md'))
})

test('handoffPathFor: sessionKey 不能带路径分隔符或 ..（防写出交接目录）', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b', '', '   ', '.', '..', null, undefined, 123, 'x\u0000y']) {
    assert.throws(
      () => handoffPathFor({ sessionKey: bad }),
      (error) => {
        assert.equal(error.code, 'HANDOFF_INVALID_SESSION')
        assert.match(error.message, /Fix:/)
        return true
      },
      `sessionKey=${String(bad)} 必须被拦下`,
    )
  }
})

test('handoffPathFor: root 不是字符串抛 HANDOFF_INVALID_ROOT；入参不是对象抛 HANDOFF_INVALID_INPUT', () => {
  assert.throws(() => handoffPathFor({ root: 42, sessionKey: 's1' }), (error) => error.code === 'HANDOFF_INVALID_ROOT')
  for (const bad of [null, 'x', []]) {
    assert.throws(() => handoffPathFor(bad), (error) => error.code === 'HANDOFF_INVALID_INPUT')
  }
})

// ---------------------------------------------------------------------------
// CLI：退出码 0 / 1 / 2 三个方向都要钉住
// ---------------------------------------------------------------------------

test('CLI --help: 退出码 0，用法打在 stdout', () => {
  for (const flag of ['--help', '-h']) {
    const result = runCli([flag])
    assert.equal(result.status, 0, `${flag} 必须退出 0`)
    assert.match(result.stdout, /用法/)
    assert.match(result.stdout, /init/)
    assert.match(result.stdout, /check/)
    assert.match(result.stdout, /append/)
    assert.match(result.stdout, /退出码/)
  }
})

test('CLI --help: 优先于其它参数（哪怕别的参数有错）', () => {
  const result = runCli(['--help', '--nope', 'init'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /用法/)
})

test('CLI init: 生成模板 -> 退出 0；空模板 check -> 退出 2（缺段即不合格）', () => {
  const root = makeRoot()
  const init = runCli(['init', '--session', 'session-a1', '--root', root])
  assert.equal(init.status, 0, init.stderr)
  const file = path.join(root, '.dsh', 'handoffs', 'session-a1.md')
  assert.ok(fs.existsSync(file), `模板应落在 ${file}`)
  assert.equal(verifyHandoff(fs.readFileSync(file, 'utf8')).ok, false)

  const check = runCli(['check', '--session', 'session-a1', '--root', root])
  assert.equal(check.status, 2, `空模板必须判 2，实际：${check.status}`)
  assert.match(check.stdout + check.stderr, /不合格/)
})

test('CLI check: 五段填齐 -> 退出 0', () => {
  const root = makeRoot()
  const file = path.join(root, '.dsh', 'handoffs', 'session-b2.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, formatHandoff(fullInput()), 'utf8')

  const check = runCli(['check', '--session', 'session-b2', '--root', root])
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /通过/)
})

test('CLI check: 缺一段 -> 退出 2（不是 1：这是「不合格」不是「跑不起来」）', () => {
  const root = makeRoot()
  const file = path.join(root, '.dsh', 'handoffs', 'session-c3.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const input = fullInput()
  delete input.remaining
  fs.writeFileSync(file, formatHandoff(input), 'utf8')

  const check = runCli(['check', '--session', 'session-c3', '--root', root])
  assert.equal(check.status, 2, check.stderr)
  assert.match(check.stdout, /remaining/)
})

test('CLI check: 文档不存在 -> 退出 2，并给 init 的下一步命令', () => {
  const root = makeRoot()
  const check = runCli(['check', '--session', 'never-init', '--root', root])
  assert.equal(check.status, 2)
  assert.match(check.stderr, /不存在/)
  assert.match(check.stderr, /handoff\.mjs init --session never-init/, '错误信息必须给出可直接复制的下一步')
})

test('CLI check --json: stdout 是可解析 JSON，字段含 ok/missing/empty/overlong/counts/path', () => {
  const root = makeRoot()
  const file = path.join(root, '.dsh', 'handoffs', 'session-d4.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, formatHandoff(fullInput({ files: [] })), 'utf8')

  const check = runCli(['check', '--session', 'session-d4', '--root', root, '--json'])
  assert.equal(check.status, 2)
  const parsed = JSON.parse(check.stdout)
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.missing, ['files'])
  assert.deepEqual(parsed.empty, ['files'])
  assert.deepEqual(parsed.overlong, [])
  assert.equal(parsed.counts.files, 0)
  assert.equal(parsed.path, file)
})

test('CLI check: 超 20 行只告警，退出码仍是 0', () => {
  const root = makeRoot()
  const file = path.join(root, '.dsh', 'handoffs', 'session-e5.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const over = Array.from({ length: MAX_SECTION_LINES + 2 }, (_, index) => `风险 ${index + 1}`).join('\n')
  fs.writeFileSync(file, formatHandoff(fullInput({ risks: over })), 'utf8')

  const check = runCli(['check', '--session', 'session-e5', '--root', root])
  assert.equal(check.status, 0, `超长不该判失败：${check.stdout}${check.stderr}`)
  assert.match(check.stdout, /告警/)
  assert.match(check.stdout, /超过上限 20/)
})

test('CLI append: 逐段追加后 check 转绿（init -> 5 次 append -> 0）', () => {
  const root = makeRoot()
  assert.equal(runCli(['init', '--session', 'session-f6', '--root', root]).status, 0)

  const contents = {
    decided: '选了方案 A：缓存层独立部署',
    rejected: '否决方案 B：KV 一致性无法验证',
    risks: '并发写同一 key 时后写覆盖',
    files: 'dsh-expert-team-kit/lib/handoff.mjs',
    remaining: '补并发用例',
  }
  for (const [section, text] of Object.entries(contents)) {
    const append = runCli(['append', '--session', 'session-f6', '--root', root, '--section', section, '--text', text])
    assert.equal(append.status, 0, append.stderr)
  }

  const check = runCli(['check', '--session', 'session-f6', '--root', root])
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`)

  const file = path.join(root, '.dsh', 'handoffs', 'session-f6.md')
  const { sections } = parseHandoff(fs.readFileSync(file, 'utf8'))
  assert.equal(sections.decided, contents.decided)
  assert.equal(sections.remaining, contents.remaining)
})

test('CLI append: 文档不存在 -> 退出 2 并提示 init（不静默创建半成品）', () => {
  const root = makeRoot()
  const append = runCli(['append', '--session', 'no-such', '--root', root, '--section', 'risks', '--text', 'x'])
  assert.equal(append.status, 2)
  assert.match(append.stderr, /init/)
})

test('CLI append: 未知段 -> 退出 1（参数错，不是文档不合格）', () => {
  const root = makeRoot()
  runCli(['init', '--session', 'session-g7', '--root', root])
  const append = runCli(['append', '--session', 'session-g7', '--root', root, '--section', 'nope', '--text', 'x'])
  assert.equal(append.status, 1)
  assert.match(append.stderr, /可用段/)
})

/**
 * 造一份 rejected 段已满 20 行的交接文档，返回 cli 跑完 append 一次的结果。
 *
 * 20 行是「刚好不告警」的边界：再 append 一行就 21 行，必须出 overlong 告警。
 * 这个夹具供下面两条用例（规范 id / 中文标题）共用 —— 两者除了 `--section` 的拼写
 * 必须给出**完全一样**的告警，否则说明告警跟着输入的写法漂移。
 *
 * @param {string} sectionArg
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function appendToFullSection(sectionArg) {
  const root = makeRoot()
  const file = path.join(root, '.dsh', 'handoffs', 'session-overlong.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const full = Array.from({ length: MAX_SECTION_LINES }, (_, index) => `否决 ${index + 1}`).join('\n')
  fs.writeFileSync(file, formatHandoff(fullInput({ rejected: full })), 'utf8')

  const result = runCli([
    'append',
    '--session',
    'session-overlong',
    '--root',
    root,
    '--section',
    sectionArg,
    '--text',
    '否决 21',
  ])
  // 断言前先确认夹具本身在正确的位置：20 行时不该有告警
  assert.equal(verifyHandoff(fs.readFileSync(file, 'utf8')).counts.rejected, MAX_SECTION_LINES + 1)
  return result
}

test('CLI append: --section 用规范 id 时，超长告警出现在 stderr（且退出码仍 0）', () => {
  const append = appendToFullSection('rejected')
  assert.equal(append.status, 0, append.stderr)
  assert.match(append.stderr, /告警/, '超长必须告警')
  assert.match(append.stderr, new RegExp(`${MAX_SECTION_LINES + 1} 行`), `告警必须报出实际行数 ${MAX_SECTION_LINES + 1}`)
  assert.match(append.stderr, new RegExp(`超过上限 ${MAX_SECTION_LINES}`))
  assert.match(append.stderr, /不影响退出码/, '必须说明它不判失败')
})

test('CLI append: --section 用中文标题时，超长告警与规范 id 完全一致（不静默丢告警）', () => {
  const byId = appendToFullSection('rejected')
  const byTitle = appendToFullSection(titleOf('rejected'))

  assert.equal(byTitle.status, 0, byTitle.stderr)
  assert.match(byTitle.stderr, /告警/, '中文标题是合法写法，告警不能因拼写不同而消失')
  assert.match(byTitle.stderr, new RegExp(`${MAX_SECTION_LINES + 1} 行`))
  assert.equal(
    byTitle.stderr,
    byId.stderr,
    '同一份文档、同一个段，只换了 --section 的写法，告警文本必须一字不差',
  )
  // 告警里的段名统一渲染成 `rejected（已否决）`，不随输入的写法漂移
  assert.match(byTitle.stderr, /rejected（已否决）/)
  assert.match(byTitle.stdout, /已追加 1 行到 rejected（已否决）/, 'stdout 的段名也应归一')
})

test('CLI init: 已存在时不覆盖 -> 退出 1；--force 才覆盖', () => {
  const root = makeRoot()
  const file = path.join(root, '.dsh', 'handoffs', 'session-h8.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, formatHandoff(fullInput()), 'utf8')

  const again = runCli(['init', '--session', 'session-h8', '--root', root])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /已存在/)
  assert.equal(verifyHandoff(fs.readFileSync(file, 'utf8')).ok, true, '失败时原文件必须原样保留')

  const forced = runCli(['init', '--session', 'session-h8', '--root', root, '--force'])
  assert.equal(forced.status, 0, forced.stderr)
  assert.equal(verifyHandoff(fs.readFileSync(file, 'utf8')).ok, false, '--force 后是空模板')
})

test('CLI 参数错误一律退出 1：缺子命令 / 未知子命令 / 缺必填 / 未知选项 / 开关带值', () => {
  const cases = [
    [],
    ['nope'],
    ['check'],
    ['check', '--session', 's1', '--bogus', 'x'],
    ['init', '--session', 's1', '--json'],
    ['check', '--session'],
    ['init', '--session', 's1', '--force=1'],
    ['check', '--session', 's1', 'extra'],
    ['check', '--session', '../escape'],
  ]
  for (const args of cases) {
    const result = runCli(args)
    assert.equal(result.status, 1, `参数 ${JSON.stringify(args)} 必须退出 1，实际 ${result.status}`)
    assert.notEqual(result.stderr.trim(), '', `参数 ${JSON.stringify(args)} 必须有可读错误`)
  }
})

test('CLI: 不往仓库里写任何产物（落盘只在 --root 指定的临时根下）', () => {
  const root = makeRoot()
  const repoHandoffs = path.join(KIT_ROOT, '.dsh', 'handoffs')
  const existedBefore = fs.existsSync(repoHandoffs)

  assert.equal(runCli(['init', '--session', 'session-i9', '--root', root]).status, 0)
  assert.equal(fs.existsSync(path.join(KIT_ROOT, '.dsh', 'handoffs', 'session-i9.md')), false)
  if (!existedBefore) {
    assert.equal(fs.existsSync(repoHandoffs), false, '仓库里不该出现 .dsh/handoffs')
  }
})
