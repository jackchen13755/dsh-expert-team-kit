import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_PERSONAS_ROOT,
  PERSONA_ERROR_CODES,
  PersonaError,
  listPersonas,
  parsePersonaFile,
  personaRoot,
  resolvePersona,
} from '../lib/persona.mjs'

/** 临时改 env，跑完必须还原（测试进程内不互相污染）。 */
function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name)
  const previous = process.env[name]
  try {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    return fn()
  } finally {
    if (had) process.env[name] = previous
    else delete process.env[name]
  }
}

const FRONTMATTER = (name, description) =>
  ['---', `name: ${name}`, `description: ${description}`, '---', ''].join('\n')

/** 造一个自洽的最小素材树，用来验证扫描分支（不依赖真实素材的命名巧合）。 */
function makeFixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.mkdirSync(path.join(root, 'demo'))
  fs.mkdirSync(path.join(root, 'other'))

  // 不带 division 前缀命名
  fs.writeFileSync(
    path.join(root, 'demo', 'alpha-expert.md'),
    `${FRONTMATTER('Alpha Expert', '演示用的无前缀命名人格')}\n# Alpha Expert\n\n正文标记 ALPHA_BODY。\n`,
  )

  // 带 division 前缀命名
  fs.writeFileSync(
    path.join(root, 'other', 'other-beta.md'),
    `${FRONTMATTER('Beta Persona', '演示用的带前缀命名人格')}\n# Beta Persona\n\n正文标记 BETA_BODY。\n`,
  )

  // 完全缺 frontmatter
  fs.writeFileSync(path.join(root, 'other', 'broken.md'), '# Broken\n\n没有 frontmatter。\n')

  // 有 frontmatter 但缺 name
  fs.writeFileSync(path.join(root, 'other', 'nameless.md'), '---\ndescription: 只有描述\n---\n\n# Nameless\n')

  return root
}

test('personaRoot: 默认指向内置人格素材根目录（绝对路径）', () => {
  withEnv('EXPERT_PERSONAS_ROOT', undefined, () => {
    const root = personaRoot()
    assert.equal(root, DEFAULT_PERSONAS_ROOT)
    assert.ok(path.isAbsolute(root), '根目录必须是绝对路径')
    assert.ok(root.endsWith(path.join('assets', 'agency-agents')), '默认根目录应指向 agency-agents')
  })
})

test('personaRoot: 优先级 overrides.root > EXPERT_PERSONAS_ROOT > 默认', () => {
  const envRoot = path.join(os.tmpdir(), 'env-root')
  const overrideRoot = path.join(os.tmpdir(), 'override-root')

  withEnv('EXPERT_PERSONAS_ROOT', envRoot, () => {
    assert.equal(personaRoot(), path.resolve(envRoot), '无 overrides 时用环境变量')
    assert.equal(
      personaRoot({ root: overrideRoot }),
      path.resolve(overrideRoot),
      'overrides.root 优先于环境变量',
    )
  })

  // 空串 / 纯空白视为未提供，不能返回空路径
  withEnv('EXPERT_PERSONAS_ROOT', '   ', () => {
    assert.equal(personaRoot(), DEFAULT_PERSONAS_ROOT, '空白环境变量应被忽略')
  })
  assert.equal(
    personaRoot({ root: '   ' }),
    DEFAULT_PERSONAS_ROOT,
    '空白 overrides.root 应被忽略',
  )
})

test('personaRoot: 支持 ~ 展开成家目录', () => {
  withEnv('EXPERT_PERSONAS_ROOT', undefined, () => {
    assert.equal(personaRoot({ root: '~/personas' }), path.join(os.homedir(), 'personas'))
    assert.equal(personaRoot({ root: '~' }), os.homedir())
  })
})

test('resolvePersona: 三种 slug 写法解析到同一个文件', () => {
  const full = resolvePersona('engineering-code-reviewer')
  const short = resolvePersona('code-reviewer')
  const slashed = resolvePersona('engineering/code-reviewer')

  for (const result of [full, short, slashed]) {
    assert.ok(path.isAbsolute(result.path), '返回的 path 必须是绝对路径')
    assert.ok(fs.existsSync(result.path), `path 必须真实存在：${result.path}`)
  }

  assert.equal(short.path, full.path, '简名与全名必须指向同一文件')
  assert.equal(slashed.path, full.path, 'division/slug 与全名必须指向同一文件')
  assert.ok(
    full.path.endsWith(path.join('engineering', 'engineering-code-reviewer.md')),
    `期望落到 engineering/engineering-code-reviewer.md，实际：${full.path}`,
  )

  // 返回字段形状是契约
  assert.deepEqual(
    Object.keys(full).sort(),
    ['body', 'description', 'name', 'path', 'slug'],
    '返回字段必须严格是 slug/path/name/description/body',
  )
})

test('resolvePersona: frontmatter 提取正确（真实素材）', () => {
  const persona = resolvePersona('code-reviewer')

  assert.equal(typeof persona.name, 'string')
  assert.ok(persona.name.trim().length > 0, 'name 不能为空')
  assert.equal(persona.name, persona.name.trim(), 'name 不该带首尾空白')
  assert.ok(!persona.name.includes(':'), `name 不能把 frontmatter 的 key 泄漏进来：${persona.name}`)
  assert.ok(!/[\r\n]/.test(persona.name), 'name 不该跨行（frontmatter 是单行标量）')

  assert.ok(persona.description.length > 0, 'description 不能为空')
  assert.ok(
    !persona.description.startsWith('description'),
    'description 不能带 frontmatter key 前缀',
  )
  assert.notEqual(persona.name, persona.description, 'name 与 description 不能被解析成同一个值')

  // 正文：frontmatter 已被切掉，且以 H1 开头；name 应出现在正文里（证明 key 映射到了同一个人格）
  assert.ok(!persona.body.startsWith('---'), 'body 不能残留 frontmatter 分隔符')
  assert.match(persona.body, /^#\s+\S/, 'body 应以 Markdown 一级标题开头')
  assert.equal(persona.body, persona.body.trim(), 'body 不该带首尾空白')
  assert.ok(persona.body.includes(persona.name), 'name 应出现在 body 里')
  assert.ok(persona.body.length > 500, 'body 应是完整正文，而不是被截断的一行')
})

test('parsePersonaFile: 无 yaml 依赖的解析器支持 CRLF 与引号', () => {
  const parsed = parsePersonaFile(
    '---\r\nname: "Quoted Name"\r\ndescription: 一段描述\r\ncolor: "#4F46E5"\r\n---\r\n\r\n# Body Title\r\n\r\n正文。\r\n',
  )

  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.frontmatter.name, 'Quoted Name', '引号应被剥掉')
  assert.equal(parsed.frontmatter.description, '一段描述')
  assert.equal(parsed.frontmatter.color, '#4F46E5', '值里的 # 不能被当注释吃掉')
  assert.equal(parsed.body, '# Body Title\n\n正文。', 'body 应是 frontmatter 之后的正文（去首尾空白）')
})

test('resolvePersona: 未知 slug 抛 PersonaError，带可操作信息与建议', () => {
  let error
  try {
    resolvePersona('no-such-expert')
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof PersonaError, '必须抛 PersonaError')
  assert.ok(error instanceof Error, 'PersonaError 必须也是 Error')
  assert.equal(error.code, PERSONA_ERROR_CODES.NOT_FOUND)
  assert.equal(error.name, 'PersonaError')

  assert.match(error.message, /未找到专家人格/)
  assert.match(error.message, /已尝试以下路径/, '错误信息必须说明试过哪些路径')
  assert.match(error.message, /Fix:/, '错误信息必须给出修复动作')

  assert.ok(Array.isArray(error.suggestions), 'error.suggestions 必须是数组')
  assert.ok(error.suggestions.length >= 1, '未知 slug 必须至少给 1 个建议')
  assert.ok(error.suggestions.length <= 3, `建议最多 3 个，实际 ${error.suggestions.length}`)
  for (const suggestion of error.suggestions) {
    assert.ok(error.message.includes(suggestion), `建议 "${suggestion}" 必须出现在错误信息里`)
  }

  assert.ok(Array.isArray(error.tried), 'error.tried 必须保留完整候选路径')
  assert.ok(error.tried.length > 0, 'error.tried 不能为空')

  // 这里必须是 .every：「所有候选路径都在根内」是安全不变量，
  // 用 .some 只要有一条在根内就通过，等于没检查（B2 的原始缺陷）。
  const rootPrefix = path.resolve(error.root) + path.sep
  assert.ok(
    error.tried.every((candidate) => path.resolve(candidate).startsWith(rootPrefix)),
    `所有尝试路径都必须落在素材根目录下，越界的就是已发生的路径穿越：${error.tried.filter(
      (candidate) => !path.resolve(candidate).startsWith(rootPrefix),
    )}`,
  )

  // 候选多于展示上限时，错误信息要显式说明省略了多少（S8 覆盖 MAX_TRIED_IN_MESSAGE 分支）
  if (error.tried.length > 14) {
    assert.match(error.message, /另有 \d+ 个候选路径/, '超出展示上限时要写明另有几个')
  }
})

test('resolvePersona: 建议凡是能与真实素材对上的，都必须可解析', () => {
  let error
  try {
    resolvePersona('code-revie')
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof PersonaError)
  assert.ok(error.suggestions.length > 0)
  // 建议必须是「可以直接喂回去」的标识，而不是文件名
  const resolvable = error.suggestions.filter((suggestion) => {
    try {
      resolvePersona(suggestion)
      return true
    } catch {
      return false
    }
  })
  assert.ok(resolvable.length > 0, `建议里至少要有一个能直接解析成功：${error.suggestions}`)
})

test('resolvePersona: 非字符串 / 空串 / 空白 / 非法类型一律抛 PersonaError', () => {
  const invalidInputs = [
    { value: undefined, label: 'undefined' },
    { value: null, label: 'null' },
    { value: '', label: '空字符串' },
    { value: '   ', label: '纯空白' },
    { value: 123, label: '数字' },
    { value: 0, label: '数字 0' },
    { value: true, label: '布尔' },
    { value: {}, label: '对象' },
    { value: [], label: '数组' },
    { value: Symbol('x'), label: 'Symbol' },
  ]

  for (const { value, label } of invalidInputs) {
    assert.throws(
      () => resolvePersona(value),
      (error) => {
        assert.ok(error instanceof PersonaError, `${label} 应抛 PersonaError`)
        assert.equal(error.code, PERSONA_ERROR_CODES.INVALID_SLUG, `${label} 的错误码应为 INVALID_SLUG`)
        assert.match(error.message, /Fix:/, `${label} 的错误信息必须给修复动作`)
        return true
      },
      `${label} 必须抛 PersonaError`,
    )
  }
})

test('resolvePersona: 素材根目录不存在时抛 ROOT_MISSING 并指出怎么修', () => {
  const missingRoot = path.join(os.tmpdir(), 'dsh-persona-does-not-exist-9f3a')

  assert.throws(
    () => resolvePersona('code-reviewer', { root: missingRoot }),
    (error) => {
      assert.ok(error instanceof PersonaError)
      assert.equal(error.code, PERSONA_ERROR_CODES.ROOT_MISSING)
      assert.ok(error.message.includes(missingRoot), '错误信息要带上看的是哪个目录')
      assert.match(error.message, /EXPERT_PERSONAS_ROOT/, '错误信息要给出环境变量这条修复路径')
      return true
    },
  )
})

test('resolvePersona: 名片三种写法在自洽素材树上都成立（扫描分支）', (t) => {
  const root = makeFixtureRoot(t)

  // 无前缀命名：简名直接命中 <division>/<slug>.md
  const alpha = resolvePersona('alpha-expert', { root })
  assert.ok(alpha.path.endsWith(path.join('demo', 'alpha-expert.md')))
  assert.equal(alpha.name, 'Alpha Expert')
  assert.ok(alpha.body.includes('ALPHA_BODY'))

  // 带前缀命名：全名（other-beta）与 division/简名（other/beta）都应命中同一文件
  const betaFull = resolvePersona('other-beta', { root })
  const betaSlashed = resolvePersona('other/beta', { root })
  const betaShort = resolvePersona('beta', { root })
  assert.equal(betaFull.path, betaSlashed.path, '全名与 division/简名应指向同一文件')
  assert.equal(betaShort.path, betaFull.path, '简名应跨 division 扫描命中')
  assert.ok(betaFull.path.endsWith(path.join('other', 'other-beta.md')))
  assert.equal(betaFull.name, 'Beta Persona')
})

test('resolvePersona: 素材文件缺 frontmatter 或缺 name 时抛 INVALID_FORMAT', (t) => {
  const root = makeFixtureRoot(t)

  assert.throws(
    () => resolvePersona('broken', { root }),
    (error) => {
      assert.ok(error instanceof PersonaError)
      assert.equal(error.code, PERSONA_ERROR_CODES.INVALID_FORMAT)
      assert.ok(error.message.includes('broken.md'), '错误信息要指出是哪个文件')
      assert.match(error.message, /name/, '错误信息要点名缺的是 name')
      return true
    },
  )

  assert.throws(
    () => resolvePersona('nameless', { root }),
    (error) => {
      assert.equal(error.code, PERSONA_ERROR_CODES.INVALID_FORMAT)
      return true
    },
  )
})

test('resolvePersona: 容忍误带的 .md 后缀与 ./ 前缀（DX）', () => {
  const plain = resolvePersona('code-reviewer')
  for (const variant of ['code-reviewer.md', './code-reviewer', './code-reviewer.md', '  code-reviewer  ']) {
    assert.equal(resolvePersona(variant).path, plain.path, `写法 "${variant}" 应解析到同一文件`)
  }
})

test('listPersonas: 枚举真实素材且每项都能被 resolvePersona 解析', () => {
  const personas = listPersonas()

  assert.ok(personas.length > 100, `真实素材应有上百个人格，实际 ${personas.length}`)
  assert.ok(
    personas.every((persona) => persona.name.trim().length > 0),
    '枚举出来的每个人格都必须有 name',
  )

  const sample = personas.find((persona) => persona.slug === 'engineering-code-reviewer')
  assert.ok(sample, '枚举结果里应有 engineering-code-reviewer')
  assert.equal(sample.division, 'engineering')
  assert.equal(resolvePersona(sample.slug).path, sample.path, '枚举出的 slug 必须能被回解析')
  assert.equal(resolvePersona(`${sample.division}/${sample.slug}`).path, sample.path)
})

// ——————————————————— B1 / B2：路径穿越的安全边界 ———————————————————

const NL = String.fromCharCode(10)
const BOM = String.fromCharCode(0xfeff)

/**
 * 造一棵「素材根 + 根的兄弟目录」的树：根外那个 secret.md 是**真实存在且可读**的攻击目标。
 * 用它才能验证「挡住穿越的是校验，不是文件不存在」。
 */
function makeBoundaryFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-boundary-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))

  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'demo'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })

  fs.writeFileSync(
    path.join(root, 'demo', 'alpha.md'),
    `${FRONTMATTER('Alpha Expert', '根内的正常人格')}${NL}# Alpha Expert${NL}`,
  )

  const secretPath = path.join(outside, 'secret.md')
  fs.writeFileSync(
    secretPath,
    `${FRONTMATTER('SECRET-OUTSIDE-ROOT', '根外机密')}${NL}# Secret${NL}${NL}SECRET_TOKEN_MARKER${NL}`,
  )

  return { base, root, outside, secretPath }
}

test('B1/B2: 路径穿越一律 PERSONA_OUTSIDE_ROOT —— 根外文件真实存在也读不到', (t) => {
  const { root, outside, secretPath } = makeBoundaryFixture(t)

  // 前提：根外目标确实存在且可读。否则「挡住了」可能只是因为文件不存在（这正是原缺陷的假象来源）
  assert.ok(
    fs.readFileSync(secretPath, 'utf8').includes('SECRET_TOKEN_MARKER'),
    '前提：根外文件必须真实存在且可读，测试才有意义',
  )

  const attacks = [
    'x/../../outside/secret',
    'engineering/../../outside/secret',
    '../../outside/secret',
    '../outside/secret',
    '../outside/secret.md',
    './../outside/secret',
    'a/../../../b',
    '../package.json',
    '/etc/passwd',
    path.join(outside, 'secret'),
    'demo/../../../outside/secret',
  ]

  for (const slug of attacks) {
    assert.throws(
      () => resolvePersona(slug, { root }),
      (error) => {
        assert.ok(error instanceof PersonaError, `${JSON.stringify(slug)} 必须抛 PersonaError`)
        assert.equal(
          error.code,
          PERSONA_ERROR_CODES.OUTSIDE_ROOT,
          `${JSON.stringify(slug)} 应判越界，实际 code=${error.code}`,
        )
        assert.match(error.message, /Fix:/, '越界错误也要给修法')
        assert.match(error.message, /越出/, '错误信息要点明越界')
        // 错误文本本身也不能成为回显面
        assert.ok(
          !error.message.includes('SECRET_TOKEN_MARKER'),
          '错误信息不得回显根外文件内容',
        )
        assert.ok(
          !error.message.includes('SECRET-OUTSIDE-ROOT'),
          '错误信息不得回显根外文件的人格名',
        )
        return true
      },
      `穿越写法必须被拒：${JSON.stringify(slug)}`,
    )
  }

  // 越界输入不该产生 error.tried（候选路径根本不该生成）
  try {
    resolvePersona('../../outside/secret', { root })
    assert.fail('应当抛错')
  } catch (error) {
    assert.equal(error.tried, undefined, '越界输入不应生成候选路径列表')
  }

  // 正常输入不受影响
  assert.equal(resolvePersona('demo/alpha', { root }).name, 'Alpha Expert')
})

test('B1(真实路径): 根内软链接指向根外 —— 只有真 realpath 包含性校验能挡住', (t) => {
  const { root, secretPath } = makeBoundaryFixture(t)
  const linkPath = path.join(root, 'demo', 'evil.md')

  try {
    fs.symlinkSync(secretPath, linkPath)
  } catch (error) {
    t.skip(`当前环境无法创建符号链接（${error.code}），跳过软链接逃逸用例`)
    return
  }

  // 锚点：这个 slug 本身完全干净（无 ..、非绝对），段级校验放行，
  // 能被拦住只可能是因为「真实路径必须在根内」这道门存在。
  assert.ok(!linkPath.includes('..'), '软链接路径本身不含 ..')
  assert.ok(fs.statSync(linkPath).isFile(), 'stat 会跟随软链接，所以它看起来就是个正常文件')

  assert.throws(
    () => resolvePersona('demo/evil', { root }),
    (error) => {
      assert.ok(error instanceof PersonaError)
      assert.equal(
        error.code,
        PERSONA_ERROR_CODES.OUTSIDE_ROOT,
        `软链接逃逸必须判越界，实际 code=${error.code}`,
      )
      assert.match(error.message, /软链接/, '错误信息要点明是软链接逃逸')
      assert.ok(error.details.real, '要带出真实路径供排查')
      assert.ok(
        !error.details.real.startsWith(fs.realpathSync(root) + path.sep),
        '真实路径确实在根外',
      )
      return true
    },
  )
})

test('B1: 候选路径与 error.tried 不含任何根外路径', () => {
  let error
  try {
    resolvePersona('definitely-not-a-real-persona-xyz')
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof PersonaError)
  assert.equal(error.code, PERSONA_ERROR_CODES.NOT_FOUND)
  const rootPrefix = path.resolve(error.root) + path.sep
  assert.ok(
    error.tried.every((candidate) => path.resolve(candidate).startsWith(rootPrefix)),
    'error.tried 必须全部落在根内',
  )
  assert.ok(error.tried.length > 14, '真实素材树的候选数应超过 message 展示上限')
  assert.match(error.message, /另有 \d+ 个候选路径/, '超上限时要说明省略了多少（S8 分支）')
})

// ——————————————————— S7：frontmatter 未闭合说实话 ———————————————————

test('S7: frontmatter 未闭合时报告「未闭合」，不是误导性的「缺 name」', (t) => {
  const root = makeFixtureRoot(t)
  const unclosed = ['---', 'name: Unclosed Persona', 'description: 少了闭合行', '', '# Body'].join(NL)
  fs.writeFileSync(path.join(root, 'other', 'unclosed.md'), unclosed)

  const parsed = parsePersonaFile(unclosed)
  assert.equal(parsed.hasFrontmatter, false)
  assert.equal(parsed.unterminated, true, '以 --- 开头但无闭合时，unterminated 必须为 true')

  assert.throws(
    () => resolvePersona('unclosed', { root }),
    (error) => {
      assert.ok(error instanceof PersonaError)
      assert.equal(error.code, PERSONA_ERROR_CODES.INVALID_FORMAT)
      assert.match(error.message, /未闭合/, '必须直说 frontmatter 未闭合')
      assert.ok(
        !/缺少 frontmatter 的 name/.test(error.message),
        '不能沿用「缺 name」的误导说法（按那个 Fix 照做修不好）',
      )
      assert.match(error.message, /`---`/, 'Fix 要指向补上闭合的 ---')
      assert.equal(error.details.unterminated, true, '结构化字段也要能程序化判定')
      return true
    },
  )

  // 对照：真的缺 frontmatter（不是未闭合）仍报「缺 name」
  assert.throws(
    () => resolvePersona('broken', { root }),
    (error) => {
      assert.match(error.message, /缺少 frontmatter 的 name/);
      assert.equal(error.details.unterminated, false)
      return true
    },
  )
})

// ——————————————————— S8：覆盖缺口 ———————————————————

test('S8: BOM 开头的文件仍能解析（删掉剥 BOM 就会红）', (t) => {
  const root = makeFixtureRoot(t)
  fs.writeFileSync(
    path.join(root, 'other', 'bom.md'),
    `${BOM}${FRONTMATTER('BOM Persona', '带 BOM 的人格')}${NL}# BOM Persona${NL}`,
  )

  const persona = resolvePersona('bom', { root })
  assert.equal(persona.name, 'BOM Persona', 'BOM 必须被剥掉，否则 frontmatter 解析不出来')

  const parsed = parsePersonaFile(`${BOM}---${NL}name: BOM Name${NL}---${NL}${NL}# Body${NL}`)
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.frontmatter.name, 'BOM Name')
})

test('S8: parsePersonaFile 的无 frontmatter 分支（hasFrontmatter=false）', () => {
  const parsed = parsePersonaFile(`# 只有正文${NL}${NL}没有 frontmatter。${NL}`)
  assert.equal(parsed.hasFrontmatter, false)
  assert.equal(parsed.unterminated, false)
  assert.deepEqual(parsed.frontmatter, {})
  assert.ok(parsed.body.startsWith('# 只有正文'), '无 frontmatter 时整段都是正文')
})

test('S8: 首行之前有空行时不算 frontmatter（锁定行为，不静默误解析）', () => {
  const parsed = parsePersonaFile(`${NL}---${NL}name: X${NL}---${NL}${NL}# Body${NL}`)
  assert.equal(parsed.hasFrontmatter, false, 'frontmatter 必须紧贴文件开头（BOM 之外）')
  assert.equal(parsed.unterminated, false)
  assert.ok(parsed.body.includes('name: X'), 'frontmatter 会被当成正文，因此缺 name 会在 resolvePersona 处显式报错')
})

test('S8: 没有前缀/词元相近时，建议退化为兜底列表（仍不为空）', () => {
  assert.throws(
    () => resolvePersona('zzzzqqqq-not-close-to-anything'),
    (error) => {
      assert.ok(error instanceof PersonaError)
      assert.equal(error.code, PERSONA_ERROR_CODES.NOT_FOUND)
      assert.equal(error.suggestions.length, 3, '兜底仍应给满 3 个候选（不给空建议）')
      for (const suggestion of error.suggestions) {
        assert.ok(error.message.includes(suggestion), '兜底候选也要写进 message')
        assert.ok(resolvePersona(suggestion).body.length > 0, '兜底候选必须真的能解析')
      }
      return true
    },
  )
})

// ——————————————————— S2：listPersonas 与 resolvePersona 契约一致 ———————————————————

test('S2: listPersonas 只返回可回解析的人格，非法文件记在 .invalid', (t) => {
  const root = makeFixtureRoot(t)
  const personas = listPersonas({ root })
  const slugs = personas.map((persona) => persona.slug)

  assert.ok(slugs.includes('alpha-expert'), '合法人格应被列出')
  assert.ok(slugs.includes('other-beta'), '带 division 前缀命名的也应被列出')
  assert.ok(!slugs.includes('nameless'), '缺 name 的文件不能出现在「可直接回解析」的列表里')
  assert.ok(!slugs.includes('broken'), '无 frontmatter 的文件也不能出现')
  assert.ok(!slugs.includes('unclosed') && true, '未闭合文件同样不该出现')

  // 契约：列表里的每一项都必须能喂回 resolvePersona，且落到同一文件
  for (const persona of personas) {
    assert.ok(persona.name.trim().length > 0, `${persona.slug} 必须有 name`)
    assert.doesNotThrow(
      () => resolvePersona(persona.slug, { root }),
      `枚举出的 ${persona.slug} 必须能回解析（这正是 S2 的不一致点）`,
    )
    assert.equal(resolvePersona(persona.slug, { root }).path, persona.path)
  }

  // 被跳过的文件不能静默消失，要在 .invalid 里说清原因
  assert.ok(Array.isArray(personas.invalid), '被跳过的文件应挂在数组的 invalid 属性上')
  assert.deepEqual(
    personas.invalid.map((item) => item.slug).sort(),
    ['broken', 'nameless'],
    `被跳过的文件应被记录，实际：${JSON.stringify(personas.invalid.map((i) => i.slug))}`,
  )
  for (const item of personas.invalid) {
    assert.equal(item.code, PERSONA_ERROR_CODES.INVALID_FORMAT)
    assert.ok(item.reason.length > 0, '要写清跳过原因')
    assert.ok(fs.existsSync(item.path), '记录里要带上真实路径')
  }
})

test('S2: 真实素材树上 listPersonas 的每一项都能回解析', () => {
  const personas = listPersonas()
  assert.ok(personas.length > 100)
  for (const persona of personas) {
    assert.equal(resolvePersona(persona.slug).path, persona.path)
  }
  assert.deepEqual(personas.invalid, [], '真实素材树应当没有结构不合法的人格')
})
