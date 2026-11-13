/**
 * dsh-expert-team-kit / lib/tier.mjs
 *
 * 判档决策记录（第 3 层核心库，零依赖）。
 *
 * 为什么要有这个模块：现在「判档（亲做 / 叫专家 / 起团队）」只写在 AGENTS.md 的祈使句里，
 * 判了什么是不可审计的；越界判档（该起团队却自己做）零成本、零痕迹。把它变成一次
 * **可复跑的纯函数调用 + 一条 append-only 的 JSONL 决策记录**，事后就能回答：
 * 「这个任务当时按哪条规则判到哪一档，依据的 feature 是什么」。
 *
 * 契约（Multi-Agent Systems Architect 的方法论）：
 * - 接口即契约：`classifyTier` 的返回形状固定为 `{ tier, reasons, evidence }`，
 *   不多不少；`recordTier` / `readTier` 的返回形状同样固定。
 * - 纯规则不调模型：同一份 features 永远判出同一档，可复跑、可单测。
 * - 边界输入全覆盖：非对象 / null / undefined / 数组 / 字符串一律抛带 `code` 的
 *   TierError；缺失与非布尔字段按「保守」处理**并留痕**（写进 evidence），
 *   绝不静默把一个不认识的 feature 当成 false 就算完。
 * - 未知字段不静默丢弃：记进 reasons，因为「调用方传了一个我不认识的维度」
 *   本身就说明调用方以为它在影响判档 —— 让它可见，而不是让它消失。
 * - 决策记录 append-only：不覆盖历史，不修改已写行；读回时坏行不静默吞掉（列在 corrupt 里）。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 三档判档结果。顺序即从轻到重，`maxTier` 之类的组合逻辑可依赖这个顺序。
 * @type {ReadonlyArray<'self' | 'expert' | 'team'>}
 */
export const TIERS = Object.freeze(['self', 'expert', 'team'])

/**
 * 错误码集合。所有 TierError 都带 `code`，调用方可按码分支，不必匹配文案。
 * @type {Readonly<Record<string, string>>}
 */
export const TIER_ERROR_CODES = Object.freeze({
  /** tier 不在 TIERS 内 */
  INVALID_TIER: 'INVALID_TIER',
  /** features 不是普通对象（null / 数组 / 原始值都算） */
  INVALID_FEATURES: 'INVALID_FEATURES',
  /** sessionKey 非法（空 / 非字符串 / 含路径分隔符 / 是 .. / 过长 / 含控制字符） */
  INVALID_SESSION_KEY: 'INVALID_SESSION_KEY',
  /** root 非法（非字符串 / 空串） */
  INVALID_ROOT: 'INVALID_ROOT',
  /** 写决策记录失败（权限、磁盘等），message 里带底层原因 */
  WRITE_FAILED: 'WRITE_FAILED',
})

/** reasons 里最多展示多少个未知字段名，避免一条日志被塞爆。 */
const MAX_UNKNOWN_IN_MESSAGE = 6
/** sessionKey 最大长度：足够容纳 uuid/日期前缀，又不会撑爆文件名上限。 */
const MAX_SESSION_KEY_LENGTH = 128

/**
 * 判档/记录失败。
 */
export class TierError extends Error {
  /**
   * @param {string} code 见 TIER_ERROR_CODES
   * @param {string} message 可操作的中文说明（说清哪个字段、期望什么、怎么办）
   * @param {Record<string, unknown>} [details] 附加结构化字段，便于脚本判定
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'TierError'
    this.code = code
    this.details = details
  }
}

/**
 * 布尔型 feature 的键。
 * @type {ReadonlyArray<string>}
 */
const BOOLEAN_FEATURES = Object.freeze([
  'singlePoint',
  'needsOpinion',
  'needsArtifact',
  'machineVerifiable',
  'needsRework',
])

/**
 * 计数型 feature 的键（非负整数；缺失 / 非法 / **非整数** 一律记 null，规则层按「不满足」处理）。
 *
 * 「非整数也记 null」是刻意的：小数只可能来自估算，而 `Math.floor` 恰好会把估算值推到
 * 最有利的那一侧（1.5→1 够到 self 的单文件豁免，3.9→3 够到 team 的宽度门槛）。
 * 宁可当「未知」落保守档，也不替调用方把估算圆成结论。
 * @type {ReadonlyArray<string>}
 */
const COUNT_FEATURES = Object.freeze(['files', 'modules', 'width'])

/**
 * 全部已识别的 feature 键。
 * @type {ReadonlyArray<string>}
 */
const KNOWN_FEATURES = Object.freeze([...BOOLEAN_FEATURES, ...COUNT_FEATURES])

/**
 * 判断是否「普通对象」（排除 null、数组、类实例以外的原始值）。
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验 features 形状；不合法直接抛 TierError（判档入口不接受「猜」）。
 * @param {unknown} features
 * @returns {Record<string, unknown>}
 */
function assertFeatures(features) {
  if (!isPlainObject(features)) {
    const got = Array.isArray(features) ? 'array' : features === null ? 'null' : typeof features
    throw new TierError(
      TIER_ERROR_CODES.INVALID_FEATURES,
      `features 必须是普通对象（例如 { singlePoint: true, files: 1 }），实际收到 ${got}。` +
        ' Fix: 换个对象重试；字段名见 TIERS 相关文档（singlePoint/files/modules/needsOpinion/' +
        'needsArtifact/machineVerifiable/width/needsRework）。',
      { got },
    )
  }
  return /** @type {Record<string, unknown>} */ (features)
}

/**
 * 把任意输入收敛成「安全文件名片段」，同时拒绝一切能逃出 <root>/.dsh/tiers 的写法。
 * 这是安全边界，不是风格问题：sessionKey 直接拼进路径，`../` 会写到工作区外面。
 * @param {unknown} sessionKey
 * @returns {string}
 */
export function assertSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.trim() === '') {
    throw new TierError(
      TIER_ERROR_CODES.INVALID_SESSION_KEY,
      `sessionKey 必须是非空字符串，实际收到 ${JSON.stringify(sessionKey) ?? String(sessionKey)}。` +
        ' Fix: 传会话 id，如 "sess-2026-11-13-ab12"。',
      { got: typeof sessionKey },
    )
  }
  const key = sessionKey.trim()
  const reason = (() => {
    if (key.length > MAX_SESSION_KEY_LENGTH) return `长度 ${key.length} 超过上限 ${MAX_SESSION_KEY_LENGTH}`
    if (key === '.' || key === '..') return '不能是 "." 或 ".."'
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(key)) return '含控制字符'
    if (/[\\/]/.test(key)) return '含路径分隔符（/ 或 \\）'
    if (path.isAbsolute(key)) return '不能是绝对路径'
    return null
  })()
  if (reason !== null) {
    throw new TierError(
      TIER_ERROR_CODES.INVALID_SESSION_KEY,
      `sessionKey 非法：${reason}（收到 ${JSON.stringify(key)}）。` +
        ' Fix: 用不含路径分隔符的稳定 id，如 "sess-2026-11-13-ab12"；它会作为文件名使用。',
      { key, reason },
    )
  }
  return key
}

/**
 * 校验 root；缺省回落 process.cwd()（CLI 与脚本都受用同一口径）。
 * @param {unknown} root
 * @returns {string}
 */
function resolveRoot(root) {
  if (root === undefined || root === null) return process.cwd()
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TierError(
      TIER_ERROR_CODES.INVALID_ROOT,
      `root 必须是绝对或相对路径字符串，实际收到 ${JSON.stringify(root) ?? String(root)}。` +
        ' Fix: 省略 root 用当前工作目录，或传一个目录路径。',
      { got: typeof root },
    )
  }
  return path.resolve(root.trim())
}

/**
 * 归一化 features：返回纯布尔/数字/缺失三种状态，并把「缺失、类型不对、未识别字段」
 * 全部记成 notes，供 reasons/evidence 留痕。
 * @param {Record<string, unknown>} features
 */
function normalizeFeatures(features) {
  /** @type {Record<string, boolean>} */
  const bools = {}
  /** @type {Record<string, number | null>} */
  const counts = {}
  /** @type {string[]} */
  const notes = []

  for (const key of BOOLEAN_FEATURES) {
    const raw = features[key]
    if (raw === true || raw === false) {
      bools[key] = raw
      continue
    }
    if (raw === undefined) {
      bools[key] = false
      notes.push(`${key} 未提供，按 false 处理`)
      continue
    }
    bools[key] = false
    notes.push(`${key} 非布尔值（${raw === null ? 'null' : typeof raw}），按 false 处理`)
  }

  for (const key of COUNT_FEATURES) {
    const raw = features[key]
    if (raw === undefined) {
      counts[key] = null
      notes.push(`${key} 未提供，按「未知」处理（不满足任何数量条件）`)
      continue
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      // 计数维度只接受**整数**。小数（files:1.5 / width:3.9）一律记 null 走「未知」：
      // 早先这里用 Math.floor 收下，等于把 1.5 当成 1 —— 恰好够到 self 豁免（"单文件"）；
      // width:3.9 被 floor 成 3，又恰好够到 team 的宽度条件。**向下取整在这两处都是
      // 最不保守的方向**，与「信息不足必须落在更谨慎的一侧」直接冲突，所以不能 floor。
      if (!Number.isInteger(raw)) {
        counts[key] = null
        notes.push(
          `${key}=${raw} 不是整数（计数维度只接受非负整数），按「未知」处理（不满足任何数量条件）`,
        )
        continue
      }
      counts[key] = raw
      continue
    }
    counts[key] = null
    notes.push(`${key} 不是非负数字（${raw === null ? 'null' : typeof raw}），按「未知」处理`)
  }

  const unknown = Object.keys(features).filter((key) => !KNOWN_FEATURES.includes(key))
  if (unknown.length > 0) {
    const shown = unknown.slice(0, MAX_UNKNOWN_IN_MESSAGE).join(', ')
    const more = unknown.length > MAX_UNKNOWN_IN_MESSAGE ? ` 等 ${unknown.length} 个` : ''
    notes.push(`忽略未识别字段：${shown}${more}（不会改变判档结果）`)
  }

  return { bools, counts, notes, unknown }
}

/**
 * 判档：纯规则，不调模型，同一输入永远同一输出。
 *
 * 规则优先级（顺序即优先级，先命中先返回）：
 * 1. `singlePoint === true && files === 1 && needsOpinion === false && !(modules >= 2)`
 *    → `self`（亲做）
 * 2. `needsArtifact && machineVerifiable && width >= 3 && needsRework` → `team`（起团队）
 * 3. `needsOpinion === true && needsArtifact === false` → `expert`（叫专家买意见）
 * 4. 其余 → `expert`（保守落中间档，并给理由）
 *
 * **为什么 self 要额外看 modules**：AGENTS.md 的触发条件是「跨 ≥2 个模块**或** ≥3 个文件
 * → 必须先叫人」。只看 files 时，`{singlePoint:true, files:1, modules:10}` 会判 self ——
 * 一个跨 10 个模块的改动被套上「单文件机械改动」的豁免，而这正是本模块要防的越界判档。
 * `modules` 未知（未提供/非法）时**不**拦 self（既有调用方多数不传该维度，拦了会让
 * 规则 1 事实上失效），但会在 reasons 里写明「modules 未知，未参与 self 判定」，
 * 让「没传」与「传了 1」在事后可区分。
 *
 * 为什么兜底是 expert 而不是 self：判档错了的两个代价不对称 —— 该叫专家却亲做，
 * 是少买了意见（质量风险且无痕迹）；多叫一次专家只是多花一次咨询成本。所以
 * 「信息不足」必须落在更谨慎的一侧。
 *
 * @param {unknown} features 见 KNOWN_FEATURES；非对象抛 TierError(INVALID_FEATURES)
 * @returns {{ tier: 'self' | 'expert' | 'team', reasons: string[], evidence: string[] }}
 */
export function classifyTier(features) {
  const safeFeatures = assertFeatures(features)
  const { bools, counts, notes, unknown } = normalizeFeatures(safeFeatures)

  /** @type {string[]} */
  const evidence = [
    `singlePoint=${bools.singlePoint}`,
    `files=${counts.files === null ? 'unknown' : counts.files}`,
    `modules=${counts.modules === null ? 'unknown' : counts.modules}`,
    `needsOpinion=${bools.needsOpinion}`,
    `needsArtifact=${bools.needsArtifact}`,
    `machineVerifiable=${bools.machineVerifiable}`,
    `width=${counts.width === null ? 'unknown' : counts.width}`,
    `needsRework=${bools.needsRework}`,
  ]

  /** @type {string[]} */
  const reasons = []

  // self 豁免的四个缺口逐条算出来：既决定判不判 self，也直接进理由（可审计）。
  // modules >= 2 单独成一条：这是 AGENTS.md 明写的「必须先叫人」触发条件。
  /** @type {string[]} */
  const selfGaps = []
  if (!bools.singlePoint) selfGaps.push('singlePoint=false')
  if (counts.files === null) selfGaps.push('files 未知（无法确认是单文件）')
  else if (counts.files !== 1) selfGaps.push(`files=${counts.files}（不是 1）`)
  if (bools.needsOpinion) selfGaps.push('needsOpinion=true（需要判断）')
  if (counts.modules !== null && counts.modules >= 2) {
    selfGaps.push(`modules=${counts.modules} ≥2（跨多个模块，AGENTS.md 要求先叫人）`)
  }
  /** 只在「有缺口」时用：任何非 self 分支都要带上它，否则读者看不出为什么没走豁免。 */
  const notSelfReason = selfGaps.length > 0 ? `未判 self：${selfGaps.join('；')}` : null

  // modules 未提供时的留痕（不拦 self，但要说清「这一维没参与判定」）。
  const moduleUnknownNote =
    counts.modules === null
      ? 'modules 未知（未参与 self 判定；若实际跨 ≥2 个模块，按 AGENTS.md 必须先叫人）'
      : null

  // 规则 1：单点 + 单文件 + 不需判断 + **不跨多模块** → 亲做。
  if (selfGaps.length === 0) {
    reasons.push('规则 self：singlePoint=true 且 files=1 且 needsOpinion=false（单文件单点、不需判断的机械改动）')
    if (moduleUnknownNote) reasons.push(moduleUnknownNote)
    if (unknown.length > 0) {
      reasons.push(...notes.filter((note) => note.startsWith('忽略未识别字段')))
    }
    return { tier: 'self', reasons, evidence }
  }

  // 规则 2：工件 + 可机器验收 + 宽度 ≥3 + 需返工 → 起团队（四条缺一不可）。
  if (bools.needsArtifact && bools.machineVerifiable && counts.width !== null && counts.width >= 3 && bools.needsRework) {
    reasons.push(
      `规则 team：needsArtifact=true 且 machineVerifiable=true 且 width=${counts.width}（≥3）且 needsRework=true ` +
        '（有工件、验收可机器判定、并发宽度够、需要审阅返工）',
    )
    if (notSelfReason) reasons.push(notSelfReason)
    if (unknown.length > 0) {
      reasons.push(...notes.filter((note) => note.startsWith('忽略未识别字段')))
    }
    return { tier: 'team', reasons, evidence }
  }

  // 规则 3：要意见不要工件 → 叫专家。
  if (bools.needsOpinion && !bools.needsArtifact) {
    reasons.push('规则 expert：needsOpinion=true 且 needsArtifact=false（要的是专业意见，不是交付工件）')
    if (notSelfReason) reasons.push(notSelfReason)
    return { tier: 'expert', reasons, evidence }
  }

  // 规则 4：兜底。
  reasons.push('规则 expert（兜底）：不满足 self 的条件，也不满足 team 的四条件，按保守中间档处理')
  if (notSelfReason) reasons.push(notSelfReason)
  reasons.push(...explainTeamShortfall(bools, counts))
  if (notes.length > 0) reasons.push(...notes)
  return { tier: 'expert', reasons, evidence }
}

/**
 * 说明「为什么没判到 team」——把缺的那几条逐条点名，而不是只说一句「不满足」。
 * 判档理由不可审计的典型形态就是「其余落 expert」四个字，事后没人能复盘。
 *
 * 只在规则 4（兜底）里被调用，因此 gaps 必然非空：四条 team 条件全满足的情况
 * 早在规则 2 就返回了，走不到这里。这个前提由测试覆盖（缺一条必点名）。
 * @param {Record<string, boolean>} bools
 * @param {Record<string, number | null>} counts
 * @returns {string[]}
 */
function explainTeamShortfall(bools, counts) {
  /** @type {string[]} */
  const gaps = []
  if (!bools.needsArtifact) gaps.push('needsArtifact=false（交付物不是工件）')
  if (!bools.machineVerifiable) gaps.push('machineVerifiable=false（没有可机器判定的验收）')
  if (counts.width === null) gaps.push('width 未知（并发宽度不足 3）')
  else if (counts.width < 3) gaps.push(`width=${counts.width} < 3（并发宽度不足）`)
  if (!bools.needsRework) gaps.push('needsRework=false（不需要审阅返工）')

  const lines = [`未判 team，缺：${gaps.join('；')}`]

  // modules 不是 team 的四条件之一（团队席位取决于并发宽度），但它是 AGENTS.md 的
  // 「必须先叫人」触发条件之一。不点出来，modules=10 的输入在理由里会完全看不到这一维 ——
  // 这正是它当初沦成「被接收、被回显、从不参与判定」的原因。
  if (counts.modules === null) {
    lines.push('模块维度：modules 未知（跨模块情况无法确认；若实际跨 ≥2 个模块，按 AGENTS.md 必须先叫人）')
  } else if (counts.modules >= 2) {
    lines.push(
      `模块维度：modules=${counts.modules} ≥2（跨多个模块，按 AGENTS.md 必须先叫人；` +
        '团队席位数由 width 决定，故此处仍按 width 判 team）',
    )
  }

  return lines
}

/**
 * 决策记录文件路径：`<root>/.dsh/tiers/<sessionKey>.jsonl`。
 * @param {string} root 已 resolve 的根目录
 * @param {string} sessionKey 已校验的会话 id
 * @returns {string}
 */
export function tierFile(root, sessionKey) {
  return path.join(root, '.dsh', 'tiers', `${sessionKey}.jsonl`)
}

/**
 * 追加写一条判档决策记录（append-only，不覆盖历史）。
 *
 * @param {object} input
 * @param {string} [input.root] 根目录，缺省 process.cwd()
 * @param {string} input.sessionKey 会话 id（会作为文件名，故拒绝路径分隔符）
 * @param {'self'|'expert'|'team'} input.tier 判档结果
 * @param {unknown} input.features 判档输入（非对象抛 INVALID_FEATURES）
 * @param {string[]} [input.reasons] 判档理由；缺省 []
 * @returns {{ file: string, record: { at: string, sessionKey: string, tier: string, features: Record<string, unknown>, reasons: string[] } }}
 */
export function recordTier({ root, sessionKey, tier, features, reasons } = {}) {
  const resolvedRoot = resolveRoot(root)
  const key = assertSessionKey(sessionKey)

  if (!TIERS.includes(tier)) {
    throw new TierError(
      TIER_ERROR_CODES.INVALID_TIER,
      `tier 必须是 ${TIERS.join(' | ')} 之一，实际收到 ${JSON.stringify(tier) ?? String(tier)}。` +
        ' Fix: 传 classifyTier(features).tier，或显式指定三档之一。',
      { got: tier, allowed: [...TIERS] },
    )
  }

  const safeFeatures = assertFeatures(features)

  /** @type {string[]} */
  let safeReasons
  if (reasons === undefined) {
    safeReasons = []
  } else if (!Array.isArray(reasons)) {
    throw new TierError(
      TIER_ERROR_CODES.INVALID_FEATURES,
      `reasons 必须是字符串数组（可省略），实际收到 ${reasons === null ? 'null' : typeof reasons}。` +
        ' Fix: 传 classifyTier(features).reasons，或省略该字段。',
      { got: typeof reasons },
    )
  } else {
    // 理由进 JSONL：非字符串会污染下游解析，逐条 stringify 而不是静默丢弃。
    safeReasons = reasons.map((reason) => (typeof reason === 'string' ? reason : JSON.stringify(reason)))
  }

  /** @type {{ at: string, sessionKey: string, tier: string, features: Record<string, unknown>, reasons: string[] }} */
  const record = {
    at: new Date().toISOString(),
    sessionKey: key,
    tier,
    features: safeFeatures,
    reasons: safeReasons,
  }

  const file = tierFile(resolvedRoot, key)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (cause) {
    throw new TierError(
      TIER_ERROR_CODES.WRITE_FAILED,
      `写判档记录失败：${file}（${cause instanceof Error ? cause.message : String(cause)}）。` +
        ' Fix: 检查目录权限/磁盘空间，或用 --root 指到可写目录。',
      { file },
    )
  }

  return { file, record }
}

/**
 * 读回某个会话的全部判档记录。
 *
 * 不存在的文件不是错误（读操作必须幂等）：返回 `{ records: [], missing: true }`，
 * 让调用方自己决定「没有记录」意味着什么，而不是逼它 try/catch。
 * 坏行（截断/手改）也不静默吞掉：跳过并记进 `corrupt`，附行号与原因。
 *
 * @param {object} input
 * @param {string} [input.root] 根目录，缺省 process.cwd()
 * @param {string} input.sessionKey 会话 id
 * @returns {{ file: string, records: Array<Record<string, unknown>>, missing: boolean, corrupt: Array<{ line: number, message: string }> }}
 */
export function readTier({ root, sessionKey } = {}) {
  const resolvedRoot = resolveRoot(root)
  const key = assertSessionKey(sessionKey)
  const file = tierFile(resolvedRoot, key)

  /** @type {Array<Record<string, unknown>>} */
  const records = []
  /** @type {Array<{ line: number, message: string }>} */
  const corrupt = []

  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return { file, records, missing: true, corrupt }
    }
    throw new TierError(
      TIER_ERROR_CODES.WRITE_FAILED,
      `读判档记录失败：${file}（${cause instanceof Error ? cause.message : String(cause)}）。` +
        ' Fix: 检查文件权限，或用 --root 指到正确目录。',
      { file },
    )
  }

  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line)
      if (!isPlainObject(parsed)) {
        corrupt.push({ line: index + 1, message: `不是 JSON 对象（${Array.isArray(parsed) ? 'array' : typeof parsed}）` })
        continue
      }
      records.push(parsed)
    } catch (cause) {
      corrupt.push({ line: index + 1, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return { file, records, missing: false, corrupt }
}
