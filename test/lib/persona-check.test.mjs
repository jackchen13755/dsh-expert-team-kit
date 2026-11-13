/**
 * dsh-expert-team-kit / test/lib/persona-check.test.mjs
 *
 * `lib/persona-check.mjs`（人格判定器）的测试。
 *
 * 被替换掉的旧判据（`bin/dispatch-check.mjs` 里的 `PERSONA_MARKERS` 子串表）有两处硬失效：
 * ① 含裸「人格」子串 → 「…不要贴人格正文」被判成「有人格」（方向反了）；
 * ② 只看通用标题 → 「只贴了 `## Core Mission` 一行」也算人格。
 *
 * 新判据只有两条，必须同时成立：
 *   ① prompt 里出现某人格 frontmatter 的 `name` 值；
 *   ② 该人格正文前 3 条非空行里至少 1 条（长度 >= 30）**原样**出现。
 *
 * 每个判据都钉两个方向：**能判成 true**（绿牙）和**该判 false 的确实 false**（红牙）。
 * 只验「没漏」不验「做了」，整体失效会静默通过。
 *
 * 约束：不依赖真机人格目录（那些文件随插件版本漂移），全部用自己的 fixture。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BODY_LINE_LIMIT,
  MIN_BODY_LINE_LENGTH,
  PERSONA_ROOT_ENV,
  collectPersonaFiles,
  defaultPersonaRoots,
  loadPersonaCorpus,
  parsePersonaMarkdown,
  readPersonaFile,
  resolvePersonaRoot,
  verifyPersonaPrompt,
} from '../../lib/persona-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(HERE, '..', '..', 'lib', 'persona-check.mjs')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-check-test-'))
after(() => fs.rmSync(BASE, { recursive: true, force: true }))

let caseSeq = 0
function freshDir(label) {
  caseSeq += 1
  const dir = path.join(BASE, `case-${caseSeq}-${label}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一份人格 md 内容（结构与真实 assets/agency-agents/** 一致）。 */
function personaMd({ name = '代码审查工程师', title = '# 代码审查工程师 Agent', short = '**Agent Personality**', body, extra = '' } = {}) {
  return [
    '---',
    `name: ${name}`,
    'description: 测试用人格',
    'color: green',
    '---',
    '',
    title,
    '',
    short,
    '',
    body || '你是代码审查工程师，负责在改动落地前挑出问题并给出分级结论与改法。',
    extra,
    '',
  ].join('\n')
}

/** 写一份人格 md 到指定目录（自动建父目录）。 */
function writePersona(dir, slug, content) {
  const file = path.join(dir, slug)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** 判据阈值必须有明确取值：改阈值就是改判据，测试要跟着红。 */
test('阈值契约：正文锚只看前 3 条非空行、且该行长度 >= 30', () => {
  assert.equal(BODY_LINE_LIMIT, 3)
  assert.equal(MIN_BODY_LINE_LENGTH, 30)
  assert.equal(PERSONA_ROOT_ENV, 'DSH_PERSONA_ROOT')
})

// ─── parsePersonaMarkdown ────────────────────────────────────────────────────

test('parsePersonaMarkdown：读 frontmatter 的 name，并只取正文前 3 条非空行', () => {
  const parsed = parsePersonaMarkdown(personaMd({ extra: '## 第四行\n## 第五行' }))
  assert.equal(parsed.name, '代码审查工程师')
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.bodyLines.length, BODY_LINE_LIMIT, '正文只留前 3 条非空行')
  assert.equal(parsed.bodyLines[0], '# 代码审查工程师 Agent')
  assert.equal(parsed.bodyLines[1], '**Agent Personality**')
  assert.match(parsed.bodyLines[2], /^你是代码审查工程师/)
})

test('parsePersonaMarkdown：YAML 成对引号要去掉（`name: "A B"` 与 `name: A B` 等价）', () => {
  assert.equal(parsePersonaMarkdown(personaMd({ name: '"Senior Developer"' })).name, 'Senior Developer')
  assert.equal(parsePersonaMarkdown(personaMd({ name: "'Senior Developer'" })).name, 'Senior Developer')
})

test('parsePersonaMarkdown：CRLF / BOM 不影响解析（真实 md 可能是 Windows 换行）', () => {
  const text = '\uFEFF' + personaMd().replace(/\n/g, '\r\n')
  const parsed = parsePersonaMarkdown(text)
  assert.equal(parsed.name, '代码审查工程师')
  assert.equal(parsed.hasFrontmatter, true)
})

test('parsePersonaMarkdown：没有 frontmatter / frontmatter 未闭合 / 空文本 / 非字符串都返回中性结果（不抛）', () => {
  const noFront = parsePersonaMarkdown('# 某人格\n\n正文第一行')
  assert.equal(noFront.name, null)
  assert.equal(noFront.hasFrontmatter, false)
  assert.equal(noFront.bodyLines[0], '# 某人格', '没有 frontmatter 时正文从首行开始')

  const unclosed = parsePersonaMarkdown('---\nname: 半截\n正文')
  assert.equal(unclosed.hasFrontmatter, false, '未闭合就当没有 frontmatter，绝不把正文当元数据')
  assert.equal(unclosed.name, null)

  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const parsed = parsePersonaMarkdown(bad)
    assert.deepEqual(parsed, { name: null, nameRaw: null, bodyLines: [], hasFrontmatter: false })
  }
})

// ─── verifyPersonaPrompt ─────────────────────────────────────────────────────

const PERSONA = {
  name: '代码审查工程师',
  bodyLines: [
    '# 代码审查工程师 Agent',
    '**Agent Personality**',
    '你是代码审查工程师，负责在改动落地前挑出问题并给出分级结论与改法。',
  ],
}

test('🦷 红牙：只提到人格名、正文一个字节都没贴 → ok:false（且 nameMatched:true 能区分成因）', () => {
  const verdict = verifyPersonaPrompt('你是 代码审查工程师，任务见附件。', { personas: [PERSONA] })
  assert.equal(verdict.ok, false, '命名 ≠ 人格注入：名字对了不代表正文进去了')
  assert.equal(verdict.nameMatched, true, '要能区分「只提名字」与「完全没提」')
  assert.match(verdict.reason, /命名 ≠ 人格注入|正文/)
})

test('🦷 红牙：「不要贴人格正文」这类句子必须判 false（旧判据在这里方向反了）', () => {
  const prompt = '你是前端开发者。注意：不要贴人格正文，只按任务书做事。'
  const verdict = verifyPersonaPrompt(prompt, { personas: [PERSONA] })
  assert.equal(verdict.ok, false, '句子里有「人格」二字不等于贴了人格')
  assert.equal(verdict.nameMatched, false)
})

test('🦷 红牙：只贴通用短标题（`## Core Mission`）→ false（短于 30 字符的行不作锚）', () => {
  // ① 连人格名都没有
  const anonymous = verifyPersonaPrompt('## Core Mission\n## Critical Rules\n## Identity', { personas: [PERSONA] })
  assert.equal(anonymous.ok, false)
  assert.match(anonymous.reason, /没有命中任何人格的 name/)

  // ② 名字对、但只贴了通用短标题 —— 这才是「只贴标题也算人格」那个失效形态
  const named = verifyPersonaPrompt('代码审查工程师\n## Core Mission\n## Critical Rules\n## Identity', { personas: [PERSONA] })
  assert.equal(named.ok, false, '短标题不是正文实质行')
  assert.equal(named.nameMatched, true)
  assert.match(named.reason, /前 3 条非空行/)
})

test('绿牙：名字 + 正文实质行都在 → ok:true，并报出命中的名字', () => {
  const prompt = ['请按下面人格做事：', '# 代码审查工程师 Agent', '', '**Agent Personality**', '', PERSONA.bodyLines[2]].join('\n')
  const verdict = verifyPersonaPrompt(prompt, { personas: [PERSONA] })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.matchedName, '代码审查工程师')
  assert.match(verdict.reason, /命中人格「代码审查工程师」/)
})

test('边界：正文行长度 29 / 30 各自的结果（阈值是判据的一部分，不能漂）', () => {
  const line29 = 'x'.repeat(29)
  const line30 = 'y'.repeat(30)
  const personas = [{ name: 'P', bodyLines: [line29] }]
  assert.equal(verifyPersonaPrompt(`P\n${line29}`, { personas }).ok, false, '29 字符不算实质正文')

  const okPersona = [{ name: 'P', bodyLines: [line29, line30] }]
  assert.equal(verifyPersonaPrompt(`P\n${line30}`, { personas: okPersona }).ok, true, '前 3 行里有一条够长就够')
})

test('边界：清单为空 / 不传清单 → ok:false 且 unavailable:true（「没法判」≠「没人格」）', () => {
  for (const args of [{ personas: [] }, {}, { personas: null }, { personas: 'not-an-array' }]) {
    const verdict = verifyPersonaPrompt('随便一段话', args)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.unavailable, true, '调用方必须能把它与 missing 分开处置')
    assert.match(verdict.reason, /清单不可用/)
  }
})

test('边界：空 prompt / 非字符串 prompt 都不抛，且不是 unavailable', () => {
  const empty = verifyPersonaPrompt('', { personas: [PERSONA] })
  assert.equal(empty.ok, false)
  assert.equal(empty.unavailable, false)
  assert.match(empty.reason, /空字符串/)

  for (const bad of [null, undefined, 42, {}, []]) {
    const verdict = verifyPersonaPrompt(bad, { personas: [PERSONA] })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.unavailable, false, 'prompt 本身有问题不是「清单不可用」')
    assert.match(verdict.reason, /不是字符串/)
  }
})

test('边界：人格缺 name / 缺 bodyLines / bodyLines 里混入非字符串 → 不崩，按无证据处理', () => {
  const weird = [
    { name: '', bodyLines: [PERSONA.bodyLines[2]] },
    { name: null, bodyLines: [PERSONA.bodyLines[2]] },
    { name: '代码审查工程师' },
    { name: '代码审查工程师', bodyLines: [null, 42, PERSONA.bodyLines[2]] },
    null,
    {},
  ]
  const verdict = verifyPersonaPrompt(`代码审查工程师\n${PERSONA.bodyLines[2]}`, { personas: weird })
  assert.equal(verdict.ok, true, '同清单里只要有一条能对上就算命中')
  assert.equal(verdict.matchedName, '代码审查工程师')
})

// ─── readPersonaFile ────────────────────────────────────────────────────────

test('readPersonaFile：name 缺失 → persona:null + 可读原因（不抛）', () => {
  const dir = freshDir('noname')
  const file = writePersona(dir, 'x.md', '# 没有 frontmatter 的人格\n正文')
  const { persona, reason } = readPersonaFile(file)
  assert.equal(persona, null)
  assert.match(reason, /没有 name/)

  const missing = readPersonaFile(path.join(dir, 'no-such.md'))
  assert.equal(missing.persona, null)
  assert.match(missing.reason, /读取失败/)
})

// ─── collectPersonaFiles / loadPersonaCorpus ────────────────────────────────

test('collectPersonaFiles：递归收集 .md、排序稳定，非 md 文件忽略', () => {
  const root = freshDir('collect')
  writePersona(root, 'engineering/b.md', personaMd())
  writePersona(root, 'engineering/a.md', personaMd())
  writePersona(root, 'testing/deep/dir/c.MD', personaMd())
  fs.writeFileSync(path.join(root, 'README.txt'), 'not a persona')

  const { files, warnings } = collectPersonaFiles(root)
  assert.deepEqual(warnings, [])
  assert.equal(files.length, 3, '3 份 md（含大写 .MD）都要收，.txt 不要')
  assert.deepEqual(files, files.slice().sort(), '排序稳定，多次扫描结果一致')
})

test('loadPersonaCorpus：正常目录 → ok:true，产出 {name, bodyLines} 供判定器直接使用', () => {
  const root = freshDir('ok')
  writePersona(root, 'engineering/code-reviewer.md', personaMd())
  writePersona(root, 'engineering/frontend.md', personaMd({ name: '前端开发者', title: '# 前端开发者 Agent', body: '你是前端开发者，负责按设计稿实现界面并保证交互与可访问性。' }))

  const corpus = loadPersonaCorpus({ root })
  assert.equal(corpus.ok, true)
  assert.equal(corpus.root, root)
  assert.equal(corpus.personas.length, 2)
  assert.deepEqual(
    corpus.personas.map((persona) => persona.name).sort(),
    ['前端开发者', '代码审查工程师'].sort(),
  )
  for (const persona of corpus.personas) {
    assert.equal(Array.isArray(persona.bodyLines), true)
    assert.equal(persona.bodyLines.length <= BODY_LINE_LIMIT, true)
  }

  // 直接喂判定器：真链路（扫目录 → 判定）能跑通
  const prompt = personaMd()
  assert.equal(verifyPersonaPrompt(prompt, { personas: corpus.personas }).ok, true)
})

test('loadPersonaCorpus：目录不存在 / 不是目录 / 空目录 → ok:false + 原因（绝不抛）', () => {
  const missing = loadPersonaCorpus({ root: path.join(BASE, 'definitely-missing') })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在或不是目录/)

  const fileAsRoot = path.join(BASE, 'a-file.txt')
  fs.writeFileSync(fileAsRoot, 'x')
  assert.equal(loadPersonaCorpus({ root: fileAsRoot }).ok, false)

  const empty = loadPersonaCorpus({ root: freshDir('empty') })
  assert.equal(empty.ok, false)
  assert.match(empty.reason, /没有可用的人格/)
})

test('loadPersonaCorpus：根目录解析不出（无 override/env/默认候选）→ ok:false，原因是「没有可用根目录」', () => {
  const env = { DSH_HOME: path.join(BASE, 'no-such-home') }
  const resolved = resolvePersonaRoot({ env })
  assert.equal(resolved.root, null)
  assert.equal(resolved.source, 'none')

  const corpus = loadPersonaCorpus({ env })
  assert.equal(corpus.ok, false)
  assert.match(corpus.reason, /没有可用的人格根目录/)
})

test('loadPersonaCorpus：没有 name 的 md 被跳过并留 warning（清单不静默残缺）', () => {
  const root = freshDir('partial')
  writePersona(root, 'good.md', personaMd())
  writePersona(root, 'bad.md', '# 没有 frontmatter\n正文')

  const corpus = loadPersonaCorpus({ root })
  assert.equal(corpus.ok, true, '有一份可用就算可用')
  assert.equal(corpus.personas.length, 1)
  assert.equal(corpus.warnings.length, 1)
  assert.match(corpus.warnings[0], /已跳过：frontmatter 里没有 name/)
})

test('resolvePersonaRoot：override > env > 默认候选 > none', () => {
  const explicit = resolvePersonaRoot({ override: '/some/dir' })
  assert.equal(explicit.source, 'override')
  assert.equal(explicit.root, path.resolve('/some/dir'))

  const viaEnv = resolvePersonaRoot({ env: { [PERSONA_ROOT_ENV]: '/from/env' } })
  assert.equal(viaEnv.source, 'env')
  assert.equal(viaEnv.root, path.resolve('/from/env'))

  // env 优先于默认候选：默认候选在本机可能存在，也必须让位给 env
  assert.equal(resolvePersonaRoot({ env: { [PERSONA_ROOT_ENV]: '/from/env' } }).root, path.resolve('/from/env'))

  // 默认候选都不存在 → none
  const none = resolvePersonaRoot({ env: { DSH_HOME: path.join(BASE, 'nope-home') } })
  assert.equal(none.source, 'none')
  assert.equal(none.root, null)
})

test('resolvePersonaRoot：override 打错路径时**照样返回它**（不静默滑到默认目录扫出假正常）', () => {
  const bad = path.join(BASE, 'typo-personas')
  const resolved = resolvePersonaRoot({ override: bad })
  assert.equal(resolved.root, bad, '显式路径必须原样返回，让 loadPersonaCorpus 报「不存在」')
  assert.equal(loadPersonaCorpus({ root: resolved.root }).ok, false)
})

test('defaultPersonaRoots：两种包名（旧 fork / 新 fork）都在候选里，避免升级插件后判据静默失效', () => {
  const roots = defaultPersonaRoots({ DSH_HOME: '/h' })
  assert.equal(roots.length >= 2, true)
  assert.equal(
    roots.some((root) => root.includes('dsh-expert-agents')),
    true,
  )
  assert.equal(
    roots.some((root) => root.includes('dsh-agency-agents')),
    true,
  )
  for (const root of roots) assert.match(root, /assets[/\\]agency-agents$/)
})

test('零依赖：源码里只 import node: 内置模块（这条判据挂进 CI 时不能被第三方包拖垮）', () => {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.equal(specifiers.length > 0, true, '解析不到 import 说明这条断言失效了')
  for (const specifier of specifiers) {
    assert.equal(specifier.startsWith('node:'), true, `非内置依赖：${specifier}`)
  }
})
