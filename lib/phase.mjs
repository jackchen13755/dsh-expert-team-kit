/**
 * dsh-expert-team-kit / lib/phase.mjs
 *
 * 阶段迁移表（第 3 层核心库，零依赖）。
 *
 * 为什么要有这个模块：「方案 → 实现 → 验收」现在全是 AGENTS.md 里的纪律条文，
 * 越界（比如 plan 直接跳 done、验收没过就 declare done）零成本零痕迹。把它变成
 * 一张显式的 TRANSITIONS 表 + 一个可持久化的状态对象，越界就从「没人发现」
 * 变成「返回 ILLEGAL_TRANSITION 并带上允许的目标」。
 *
 * 契约（Multi-Agent Systems Architect 的方法论）：
 * - `advance(state, to)` **不抛**：任何拒绝都以 `{ ok: false, state, error }` 返回。
 *   迁移判定是「正常路径上的业务分支」，不是异常；抛错会逼调用方 try/catch，
 *   一旦忘了 catch，程序就在一个可恢复的分支上崩掉。
 * - 被拒绝时 `state` **原样返回**，且返工计数不前进：失败的一次尝试不消耗预算。
 * - 状态**不可变**：advance 返回新对象，输入对象不被改写（便于对比 / 回滚 / 单测）。
 * - 返工有硬上限：review → implement 最多 MAX_REWORK_ROUNDS(3) 轮，超了返回
 *   REWORK_EXHAUSTED 并要求升级给人 —— 与「evaluator 永不收敛」的循环失败对应。
 * - 边界输入全覆盖：null / 非对象 / phase 不存在 / 未知目标 / 同一阶段自迁移，
 *   全部有确定的返回形状和错误码，绝不返回 undefined 或抛意外异常。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 阶段集合（线性主链）。
 * @type {ReadonlyArray<'plan'|'implement'|'verify'|'review'|'done'>}
 */
export const PHASES = Object.freeze(['plan', 'implement', 'verify', 'review', 'done'])

/**
 * 迁移表：显式列出每个阶段允许去的下一站。
 * - 线性主链：plan → implement → verify → review → done
 * - 返工回路：review → implement（验收/评审不过，回炉重做）
 * - `done` 是终态，没有出口（要重开就新起一个 session，而不是原地复活）
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const TRANSITIONS = Object.freeze({
  plan: Object.freeze(['implement']),
  implement: Object.freeze(['verify']),
  verify: Object.freeze(['review']),
  review: Object.freeze(['done', 'implement']),
  done: Object.freeze([]),
})

/**
 * 允许的最大返工轮数（review → implement 记 1 轮）。
 * 与人格里的「循环必须有硬出口，建议最大迭代 3 次」一致。
 * @type {number}
 */
export const MAX_REWORK_ROUNDS = 3

/**
 * 错误码集合。`advance` 的 error.code 取这里的值。
 * @type {Readonly<Record<string, string>>}
 */
export const PHASE_ERROR_CODES = Object.freeze({
  /** 当前状态对象形状非法（null / phase 不认识 / 计数类型错） */
  INVALID_STATE: 'INVALID_STATE',
  /** 目标阶段不在 PHASES 内 */
  UNKNOWN_TARGET: 'UNKNOWN_TARGET',
  /** 迁移表里没有这条边（含同一阶段自迁移） */
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  /** 返工轮数超过 MAX_REWORK_ROUNDS */
  REWORK_EXHAUSTED: 'REWORK_EXHAUSTED',
  /** 读写状态文件失败（权限/磁盘） */
  IO_FAILED: 'IO_FAILED',
})

/** sessionKey 最大长度（与 lib/tier.mjs 同口径：会作为文件名）。 */
const MAX_SESSION_KEY_LENGTH = 128

/**
 * 构造一个结构化错误对象（不是 Error 实例：它是数据，会被 JSON 序列化给 CLI）。
 * @param {string} code
 * @param {string} message 可操作说明
 * @param {Record<string, unknown>} [details]
 * @returns {{ code: string, message: string } & Record<string, unknown>}
 */
function phaseError(code, message, details = {}) {
  return { code, message, ...details }
}

/**
 * 是否普通对象。
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验 sessionKey（会拼进文件名，属于安全边界）。
 * 与 lib/tier.mjs 的同名校验规则一致；这里刻意各自持有一份而不是互相 import ——
 * 两个模块各自可独立使用，不该为了省 20 行把 phase 绑到 tier 上。
 * @param {unknown} sessionKey
 * @returns {string}
 */
export function assertSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.trim() === '') {
    throw new Error(
      `sessionKey 必须是非空字符串，实际收到 ${JSON.stringify(sessionKey) ?? String(sessionKey)}。` +
        ' Fix: 传会话 id，如 "sess-2026-11-13-ab12"。',
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
    throw new Error(
      `sessionKey 非法：${reason}（收到 ${JSON.stringify(key)}）。` +
        ' Fix: 用不含路径分隔符的稳定 id，如 "sess-2026-11-13-ab12"；它会作为文件名使用。',
    )
  }
  return key
}

/**
 * 创建初始状态（默认从 plan 开始）。
 *
 * @param {object} [init]
 * @param {string} [init.sessionKey] 归属会话（会写进状态，便于对账）
 * @param {string} [init.phase] 起始阶段（缺省 plan；用于恢复/迁移场景，必须在 PHASES 内）
 * @returns {{ sessionKey: string | null, phase: string, reworkRounds: number, revision: number, history: Array<{ from: string, to: string, rework: boolean, at: string }> }}
 */
export function createState(init = {}) {
  const phase = init && init.phase !== undefined ? init.phase : 'plan'
  if (!PHASES.includes(phase)) {
    throw new Error(
      `createState 的起始 phase 必须是 ${PHASES.join(' | ')} 之一，实际收到 ${JSON.stringify(phase) ?? String(phase)}。` +
        ' Fix: 省略 phase（默认 plan），或传 PHASES 里的一个值。',
    )
  }
  return {
    sessionKey: init && typeof init.sessionKey === 'string' ? init.sessionKey : null,
    phase,
    reworkRounds: 0,
    revision: 0,
    history: [],
  }
}

/**
 * 校验状态对象；返回错误对象或 null。
 * 只做形状校验（phase 是否认识、计数是否非负整数、history 是否数组），
 * 不做业务判定 —— 业务判定在 advance 里，理由各自独立。
 * @param {unknown} state
 * @returns {null | { code: string, message: string, details?: Record<string, unknown> }}
 */
function validateState(state) {
  if (!isPlainObject(state)) {
    const got = state === null ? 'null' : Array.isArray(state) ? 'array' : typeof state
    return phaseError(
      PHASE_ERROR_CODES.INVALID_STATE,
      `state 必须是 createState() 返回的对象，实际收到 ${got}。` +
        ' Fix: 传 createState() 的结果（或 readPhaseState 读回的状态）。',
      { got },
    )
  }
  if (!PHASES.includes(state.phase)) {
    return phaseError(
      PHASE_ERROR_CODES.INVALID_STATE,
      `state.phase 必须是 ${PHASES.join(' | ')} 之一，实际收到 ${JSON.stringify(state.phase) ?? String(state.phase)}。` +
        ' Fix: 用 createState() 重置，或把 phase 改成已知阶段。',
      { got: state.phase, allowed: [...PHASES] },
    )
  }
  if (state.reworkRounds !== undefined) {
    if (typeof state.reworkRounds !== 'number' || !Number.isInteger(state.reworkRounds) || state.reworkRounds < 0) {
      return phaseError(
        PHASE_ERROR_CODES.INVALID_STATE,
        `state.reworkRounds 必须是非负整数，实际收到 ${JSON.stringify(state.reworkRounds) ?? String(state.reworkRounds)}。` +
          ' Fix: 用 createState() 重置计数。',
        { got: state.reworkRounds },
      )
    }
  }
  if (state.history !== undefined && !Array.isArray(state.history)) {
    return phaseError(
      PHASE_ERROR_CODES.INVALID_STATE,
      `state.history 必须是数组，实际收到 ${typeof state.history}。 Fix: 用 createState() 重置。`,
      { got: typeof state.history },
    )
  }
  return null
}

/**
 * 推进一个阶段。
 *
 * **永不抛**：所有拒绝都走 `{ ok: false, state, error }`。被拒绝时返回的 `state`
 * 就是传进来的那个（引用相同），调用方可据此确认「什么都没发生」。
 *
 * @param {unknown} state createState() 返回的状态对象
 * @param {unknown} to 目标阶段
 * @returns {{ ok: boolean, state: Record<string, unknown>, error: null | (Record<string, unknown> & { code: string, message: string }) }}
 */
export function advance(state, to) {
  // 1) 状态形状先校验：形状不对时「当前阶段」本身不可信，不能拿它去查迁移表。
  const stateProblem = validateState(state)
  if (stateProblem) {
    return { ok: false, state: /** @type {Record<string, unknown>} */ (state), error: stateProblem }
  }

  /** @type {Record<string, any>} */
  const current = /** @type {Record<string, any>} */ (state)

  // 2) 目标阶段必须是已知阶段；未知目标给全量枚举，别让调用方去翻源码。
  if (!PHASES.includes(to)) {
    return {
      ok: false,
      state: current,
      error: phaseError(
        PHASE_ERROR_CODES.UNKNOWN_TARGET,
        `目标 phase 必须是 ${PHASES.join(' | ')} 之一，实际收到 ${JSON.stringify(to) ?? String(to)}。` +
          ` Fix: 当前阶段 ${current.phase} 允许去：${TRANSITIONS[current.phase].join(', ') || '（终态，无出口）'}。`,
        { got: to, current: current.phase, allowed: [...PHASES] },
      ),
    }
  }

  // 3) 查迁移表：没有这条边就拒绝（含 a→a 自迁移，它不是幂等，是没定义）。
  const allowed = TRANSITIONS[current.phase]
  if (!allowed.includes(to)) {
    return {
      ok: false,
      state: current,
      error: phaseError(
        PHASE_ERROR_CODES.ILLEGAL_TRANSITION,
        `非法迁移：${current.phase} → ${to}。当前阶段 ${current.phase} 只能去：` +
          `${allowed.length > 0 ? allowed.join(', ') : '（终态，无出口）'}。` +
          ' Fix: 按 TRANSITIONS 表逐步推进，或新起一个 session 重新开始。',
        { from: current.phase, to, allowed: [...allowed] },
      ),
    }
  }

  // 4) 返工预算：只有 review → implement 计入；超限就拒绝并要求升级给人。
  const reworkRounds = typeof current.reworkRounds === 'number' ? current.reworkRounds : 0
  const isRework = current.phase === 'review' && to === 'implement'
  const nextReworkRounds = reworkRounds + (isRework ? 1 : 0)
  if (nextReworkRounds > MAX_REWORK_ROUNDS) {
    return {
      ok: false,
      state: current,
      error: phaseError(
        PHASE_ERROR_CODES.REWORK_EXHAUSTED,
        `返工轮数已达上限：已用 ${reworkRounds}/${MAX_REWORK_ROUNDS}，本次 review → implement 将变成第 ` +
          `${nextReworkRounds} 轮。 Fix: 停止自动返工并升级给人（reworkRounds 不前进，状态未变）。`,
        { reworkRounds, max: MAX_REWORK_ROUNDS },
      ),
    }
  }

  // 5) 成功：产出新对象，不改写入参。
  /** @type {Array<{ from: string, to: string, rework: boolean, at: string }>} */
  const history = Array.isArray(current.history) ? current.history.slice() : []
  history.push({
    from: current.phase,
    to,
    rework: isRework,
    at: new Date().toISOString(),
  })

  return {
    ok: true,
    state: {
      ...current,
      phase: to,
      reworkRounds: nextReworkRounds,
      revision: (typeof current.revision === 'number' ? current.revision : 0) + 1,
      history,
    },
    error: null,
  }
}

/**
 * 阶段状态文件路径：`<root>/.dsh/phases/<sessionKey>.json`。
 * @param {string} root
 * @param {string} sessionKey
 * @returns {string}
 */
export function phaseFile(root, sessionKey) {
  return path.join(root, '.dsh', 'phases', `${sessionKey}.json`)
}

/**
 * 解析 root；缺省回落 process.cwd()（CLI 与脚本同口径）。
 * @param {unknown} root
 * @returns {string}
 */
function resolveRoot(root) {
  if (root === undefined || root === null) return process.cwd()
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error(`root 必须是路径字符串，实际收到 ${JSON.stringify(root) ?? String(root)}。 Fix: 省略 root 用当前工作目录。`)
  }
  return path.resolve(root.trim())
}

/**
 * 读回某会话的阶段状态。
 *
 * 不存在的文件不是错误：返回 `{ state: createState({sessionKey}), missing: true }`，
 * 让 CLI / 调用方直接拿到「从 plan 开始」的可用状态，而不是先判断文件在不在。
 * 文件内容损坏时**不静默兜底**：`corrupt: true` + `error` 说明原因，state 给初值。
 *
 * @param {object} input
 * @param {string} [input.root]
 * @param {string} input.sessionKey
 * @returns {{ file: string, state: ReturnType<typeof createState>, missing: boolean, corrupt: boolean, error: null | { code: string, message: string } }}
 */
export function readPhaseState({ root, sessionKey } = {}) {
  const resolvedRoot = resolveRoot(root)
  const key = assertSessionKey(sessionKey)
  const file = phaseFile(resolvedRoot, key)

  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return { file, state: createState({ sessionKey: key }), missing: true, corrupt: false, error: null }
    }
    throw new Error(
      `读阶段状态失败：${file}（${cause instanceof Error ? cause.message : String(cause)}）。` +
        ' Fix: 检查文件权限，或用 --root 指到正确目录。',
    )
  }

  try {
    const parsed = JSON.parse(raw)
    const problem = validateState(parsed)
    if (problem) {
      return {
        file,
        state: createState({ sessionKey: key }),
        missing: false,
        corrupt: true,
        error: phaseError(problem.code, `状态文件内容非法：${problem.message}`, { file }),
      }
    }
    return { file, state: /** @type {ReturnType<typeof createState>} */ (parsed), missing: false, corrupt: false, error: null }
  } catch (cause) {
    return {
      file,
      state: createState({ sessionKey: key }),
      missing: false,
      corrupt: true,
      error: phaseError(
        PHASE_ERROR_CODES.IO_FAILED,
        `状态文件不是合法 JSON：${file}（${cause instanceof Error ? cause.message : String(cause)}）。` +
          ' Fix: 删掉该文件重新开始，或改用另一个 --session。',
        { file },
      ),
    }
  }
}

/**
 * 写入阶段状态（整文件覆盖：状态是快照，不是日志；历史在 state.history 里）。
 * @param {object} input
 * @param {string} [input.root]
 * @param {string} input.sessionKey
 * @param {unknown} input.state
 * @returns {{ file: string, state: Record<string, unknown> }}
 */
export function writePhaseState({ root, sessionKey, state } = {}) {
  const resolvedRoot = resolveRoot(root)
  const key = assertSessionKey(sessionKey)
  const problem = validateState(state)
  if (problem) {
    throw new Error(`拒绝写入非法状态：${problem.message}`)
  }
  const file = phaseFile(resolvedRoot, key)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (cause) {
    throw new Error(
      `写阶段状态失败：${file}（${cause instanceof Error ? cause.message : String(cause)}）。` +
        ' Fix: 检查目录权限/磁盘空间，或用 --root 指到可写目录。',
    )
  }
  return { file, state: /** @type {Record<string, unknown>} */ (state) }
}

/**
 * 读 + 推进 + 落盘。给 CLI 用的便捷入口（把三步拼成一次调用，避免 CLI 自己拼错顺序）。
 *
 * 读不到文件时从 plan 开始；迁移被拒时**不写盘**（绝不把失败尝试落盘成事实）。
 *
 * @param {object} input
 * @param {string} [input.root]
 * @param {string} input.sessionKey
 * @param {unknown} input.to
 * @returns {{ ok: boolean, file: string | null, state: Record<string, unknown>, error: null | Record<string, unknown> }}
 */
export function advanceSession({ root, sessionKey, to } = {}) {
  const loaded = readPhaseState({ root, sessionKey })
  if (loaded.corrupt) {
    return { ok: false, file: loaded.file, state: loaded.state, error: loaded.error }
  }
  const result = advance(loaded.state, to)
  if (!result.ok) {
    return { ok: false, file: loaded.file, state: result.state, error: result.error }
  }
  const saved = writePhaseState({ root, sessionKey, state: result.state })
  return { ok: true, file: saved.file, state: saved.state, error: null }
}
