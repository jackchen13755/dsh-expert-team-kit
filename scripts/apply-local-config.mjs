#!/usr/bin/env node
/**
 * dsh-expert-team-kit / scripts/apply-local-config.mjs
 *
 * 把「本机 DSH 配置该长什么样」落成一次可复跑的应用：**默认只打印计划（零写入）**，
 * 加 `--apply` 才写盘，写前按 `<file>.bak-<时间戳>` 备份。
 *
 * 为什么是脚本而不是手工改：`~/.dsh/AGENTS.md` 与 profile 的 `cordis.patch.yml` 都是
 * 手工维护的长文件，改一次没人记得改了哪几处；下一次有人照旧记忆再改一遍，就会出现
 * 「注释说两套都启用、实际两套都关着」这种**文档与工具面相反**的状态（本脚本修的就是它）。
 * 把每处改动写成一条 **old → new** 记录，脚本就有了三件事：
 *   1) 幂等：已改过的条目报「已是目标状态」，重复跑不重复写；
 *   2) 可核验：每条打印 before / after 摘要，交付里能贴出来；
 *   3) 不静默：找不到目标就明确报「未命中」并以退出码 1 收场，绝不假装成功。
 *
 * 退出码：0 = 全部条目「将应用」或「已是目标状态」；1 = 有未命中 / IO 错误（**不写任何文件**）。
 *
 * 用法：
 *   node scripts/apply-local-config.mjs              # 只打印计划
 *   node scripts/apply-local-config.mjs --apply      # 备份后写盘
 *   node scripts/apply-local-config.mjs --home /tmp/x --profile desktop
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 管道被 `| head` 提前关掉时不要抛栈：本脚本最常见的用法就是 `... | head -40`。
 * 这不是「吞掉错误」——真正的错误仍走 stderr 与退出码。
 */
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(process.exitCode ?? 0);
});

const EXIT = Object.freeze({ PASS: 0, ERROR: 1 });

const USAGE = `用法：
  node scripts/apply-local-config.mjs [--apply] [--home <dir>] [--profile <name>] [--help]

默认**只打印计划**（零写入）。加 --apply 才写盘，写前把目标文件备份成
<file>.bak-<YYYYMMDD-HHMMSS>。

做三件事（每条都打印 before / after 摘要；找不到目标报「未命中」并退出 1）：
  1) <profile>/cordis.patch.yml：dispatch-check 命令由 --session latest 改成 --session current
  2) 同一文件里「两套都保持启用」那段注释，改成与下面三条 disabled 注释一致的实际状态
  3) ~/.dsh/AGENTS.md：按 docs/agents-md-align-2026-11-13.md 的清单逐条对齐真实工具面

选项：
  --apply            真正写入（缺省零写入）
  --home <dir>       DSH_HOME，缺省 $DSH_HOME 或 ~/.dsh（测试与多 home 场景用）
  --profile <name>   profile 名，缺省 desktop
  -h, --help         打印本用法并退出 0（优先于其它选项）

退出码：0 通过（将应用 / 已是目标状态）；1 有未命中、参数错或 IO 错误（有未命中时**一个文件都不写**）。
`;

/* ── 改动清单 ─────────────────────────────────────────────────────────
 * 每一条都是「原文 → 新文」的**字面**替换。写这条清单时守两条纪律：
 *  - 旧串必须是**完整到不会误伤**的一段（含整行/整段，不做半句替换）；
 *  - 新串里不得再原样包含旧串，否则「是否已应用」的判定永远为真，脚本会重复插入。
 *    脚本判定顺序也是先看新串（已应用）再看旧串（待应用）。
 */

/** AGENTS.md:48 —— dsh_code_review 的真实状态是「工具面里有、调用可能报错」。 */
const AGENTS_CODE_REVIEW_OLD = [
  '- **`dsh_code_review` 工具已下线**（2026-11-12 核实：code-review 插件在任何 profile 的 node_modules 与 patch 里都不存在，调它会报 `Cannot read properties of undefined (reading \'id\')`）。评审统一走**专家**：`summon_expert("代码审查工程师", 任务书)`；要结构化产物就让专家写 REVIEW.md。**不要再调 `dsh_code_review` / `auto-review`**。',
].join('\n');

const AGENTS_CODE_REVIEW_NEW = [
  '- **`dsh_code_review`：工具面里有，但调用不保证成功**（2026-11-13 复核：`dsh_code_review` 仍在工具面上，可以调用；走不通时报 `Cannot read properties of undefined (reading \'id\')`——那是 code-review 引擎在该 profile 下没装配，不是参数错）。**能调通就用它拿结构化报告；报错就改走 `summon_expert("代码审查工程师", 任务书)`**，要落盘产物就让专家写 REVIEW.md。状态看**实际调用结果**，不要凭记忆断言「已下线」。',
].join('\n');

/** AGENTS.md:60 —— 任务板工具在本机不存在，按真实工具面重写。 */
const AGENTS_TASKBOARD_OLD = [
  '- **够格起团队就别只派裸 subagent**（2026-11-13 加）：满足「工件 + 可机器验收 + W≥3 + 需审阅返工」时，要**建任务板**（`team_task_create` 带 `write_scopes`/`blocked_by`）再用 `subagent` 起队友、让队友自己 `claim` → `complete`。只并发起 3 个 subagent 而不用任务板，等于丢掉了所有权、依赖与写作用域冲突检测——这属于降级使用，要在交付里说明为什么不起板。',
].join('\n');

const AGENTS_TASKBOARD_NEW = [
  '- **够格起团队就别只派裸 subagent**（2026-11-13 加）：满足「工件 + 可机器验收 + W≥3 + 需审阅返工」时，用下面三件事组合，而不是裸派：',
  '  - **起队友**：`subagent`（或 `subagent_fork`）起一个带名字的席位，名字用专家标识（`code-reviewer`、`software-architect`）；',
  '  - **任务书**：`expert_brief({ expert, task, verify, scopes, worker })` 生成——人格正文、验收命令、写作用域都拼好了，把返回值整段作为 `subagent` 的 prompt；写作用域字段就是 `scopes`，本机**没有** `write_scopes` / `blocked_by` 这两个字段；',
  '  - **交接**：`node dsh-expert-team-kit/bin/handoff.mjs` 的五段（decided / rejected / risks / files / remaining），换会话时用它接前情。',
  '  **本机当前没有任务板工具**（`team_task_create` / `team_task_get` / `team_task_update` 都不在工具面上），所以没有 `claim` → `complete` 这步。代价是：所有权、依赖排序与写作用域冲突检测只能靠任务书里的 `scopes` + 交接文档维持，**降级事实要写进交付**，不能默认观众知道。',
].join('\n');

/** AGENTS.md:83 —— AgentTeams 插件那一行从「默认首选」降为「装上才用」。 */
const AGENTS_TEAMS_ROW_OLD = '| AgentTeams 插件 | `agent_teams_create` 等 `agent_teams_*` | 多角色编排**默认首选** |';

const AGENTS_TEAMS_ROW_NEW = '| AgentTeams 插件 | `agent_teams_create` 等 `agent_teams_*` | **装上才用**；本机当前未装 → 按规则降级到官方（见下） |';

/** AGENTS.md:86 —— 判据段落补上「没装怎么办」，并写明本机现状。 */
const AGENTS_TEAMS_RULE_OLD = '**判据是工具面里有没有 `agent_teams_create`，不是改配置**：有就直接用它；缺失或报不可用才降级到官方并说明原因。不要为选边去改 profile 的 `cordis.patch.yml`，也不要在两套间来回切。交付里写清用了哪套工具名。';

const AGENTS_TEAMS_RULE_NEW = '**判据是工具面里有没有 `agent_teams_create`，不是改配置**：装了就用它；**没装就按上面的规则降级到官方 `subagent` + `expert_brief` 任务书，并在交付里写明降级原因**。不要为选边去改 profile 的 `cordis.patch.yml`，也不要在两套间来回切。交付里写清用了哪套工具名。本机当前工具面**没有** `agent_teams_*`，所以默认走官方并声明降级。';

/** AGENTS.md:92 —— 删掉不可执行的 `agent_teams_create({approval:"required"})` 引用。 */
const AGENTS_APPROVAL_OLD = '- **不问拆解判据**（「能切几条」是我的活）：只问两件预算——是否要求可复核证据、急不急。成本披露点在 `agent_teams_create({approval:"required"})` 的计划屏。';

const AGENTS_APPROVAL_NEW = '- **不问拆解判据**（「能切几条」是我的活）：只问两件预算——是否要求可复核证据、急不急。成本披露点在**收尾交付**（用了哪套工具、几个席位、大致开销）；装了 AgentTeams 才有计划屏，没装就直接说明开销。';

/** AGENTS.md:104 —— 第二段路径 (c) 不能引用本机不存在的工具。 */
const AGENTS_SECOND_STAGE_OLD = '- `summon_experts` 只返回纯文本，**拿不到子会话 id 去续接**，第二段三条路：(a) 再发一次 `summon_experts` 并把上段结论摘要带进任务书（专家看不到上一轮）；(b) 用 `subagent`（返回 id，`send_message` 可续接）；(c) 用 `agent_teams_create` 做成任务 DAG（实现那条挂 `inScope` + `verify`）。';

const AGENTS_SECOND_STAGE_NEW = '- `summon_experts` 只返回纯文本，**拿不到子会话 id 去续接**，第二段三条路：(a) 再发一次 `summon_experts` 并把上段结论摘要带进任务书（专家看不到上一轮）；(b) 用 `subagent`（返回 id，`send_message` 可续接）——**本机默认这条**；(c) 装了 AgentTeams 才用它做成任务 DAG（实现那条挂 `inScope` + `verify`），没装就用 (b) 逐个派并按交接五段收口。';

/** AGENTS.md 新增小节 —— 门禁会话标识与交接命令：写清「怎么跑」，不只是「叫什么」。 */
const AGENTS_GATE_SECTION_ANCHOR = '## 收尾自证（硬要求）';

const AGENTS_GATE_SECTION = `## 门禁会话与交接（2026-11-13 加）

- **门禁命令要用 \`--session current\`**：\`completion-ledger\` 的独立验收（Oracle）在**会话 cwd** 下执行命令，
  同一个 cwd 可能有多个会话，按 \`--session latest\` 会读到别的会话。插件在跑验收时会把
  \`DSH_SESSION_ID=<当前会话 id>\` 透传给子进程，所以 \`dispatch-check\` 这类要读会话日志的命令
  应写 \`--session current\`（读该环境变量），而不是 \`--session latest\`。
- **交接要跑 \`node dsh-expert-team-kit/bin/handoff.mjs check\`**：五段（decided / rejected / risks / files /
  remaining）缺一段或空一段退出码就是 2，可以直接挂进收尾脚本；\`init\` 生成模板，\`append\` 追加。
- 本机配置的对齐脚本：\`node dsh-expert-team-kit/scripts/apply-local-config.mjs\`（默认只打印计划，
  \`--apply\` 才写，写前备份成 \`<file>.bak-<时间戳>\`）。改法清单见
  \`dsh-expert-team-kit/docs/agents-md-align-2026-11-13.md\`。

`;

/** cordis.patch.yml:207 —— 门禁命令的会话选择器。 */
const PATCH_SESSION_OLD = 'node /Users/zhe.chen/Desktop/dsh/github/dsh-expert-team-kit/bin/dispatch-check.mjs --session latest';

const PATCH_SESSION_NEW = 'node /Users/zhe.chen/Desktop/dsh/github/dsh-expert-team-kit/bin/dispatch-check.mjs --session current';

/**
 * cordis.patch.yml:240-243 —— 注释与 249-255 行的实际状态相反。
 *
 * 旧段说「规则上首选 AgentTeams，官方只作兜底，因此两套都保持启用」；实际是三条
 * `#- id: agent-team ... #  disabled: true` 把官方关着，第三方也不在 bundles 里。
 */
const PATCH_COMMENT_OLD = [
  '# ===== 2026-10-13 团队实现：两套并存（优先级由规则定，不靠这里切换）=====',
  '# 结论：官方 Agent Teams 三件套与第三方 @nanmicoder/dsh-agent-teams（agent_teams_*）',
  '# 并存；**规则上首选 AgentTeams（`agent_teams_create`），官方只作兜底**（2026-10-13',
  '# 用户要求），因此两套都保持启用。',
].join('\n');

const PATCH_COMMENT_NEW = [
  '# ===== 团队实现状态（2026-11-13 更正 2026-10-13 的首选结论）=====',
  '# 更正原因：原注释说「官方与第三方并存、因此都启用」，与下面的实际状态相反——',
  '# 官方三件套被本段末尾三条 `disabled: true`（agent-team / tool-agent-team /',
  '# ui-agent-team）关着，第三方 @nanmicoder/dsh-agent-teams 也不在 profile 的',
  '# dsh.profile.bundles 里（未装配）。所以**当前两套都没启用**：本机工具面上没有',
  '# `agent_teams_*`，多角色协作走官方 `subagent` + `expert_brief` 任务书 + 交接五段',
  '# （见 ~/.dsh/AGENTS.md 的派发规程）。',
  '# 要启用哪一套：官方 → 注释掉下面三条 `disabled: true`；第三方 → 把',
  '# @nanmicoder/dsh-agent-teams 加进 profile 的 bundles。只改一处，不要两套混开。',
].join('\n');

/**
 * 全部改动条目。
 *
 * `file` 是 `'patch'` 或 `'agents'` 的逻辑名，由 {@link resolveTargets} 映射成真实路径；
 * 这样测试与多 home 场景只换根目录，不用改清单。
 */
export const EDITS = Object.freeze([
  {
    id: 'patch-session-current',
    file: 'patch',
    title: 'cordis.patch.yml：dispatch-check 的会话选择器 latest → current',
    old: PATCH_SESSION_OLD,
    new: PATCH_SESSION_NEW,
  },
  {
    id: 'patch-team-comment',
    file: 'patch',
    title: 'cordis.patch.yml：「两套都保持启用」注释 → 与三条 disabled 一致的实际状态',
    old: PATCH_COMMENT_OLD,
    new: PATCH_COMMENT_NEW,
  },
  {
    id: 'agents-code-review',
    file: 'agents',
    title: 'AGENTS.md:48 dsh_code_review：由「已下线」改为「工具面里有、调用可能报错」',
    old: AGENTS_CODE_REVIEW_OLD,
    new: AGENTS_CODE_REVIEW_NEW,
  },
  {
    id: 'agents-taskboard',
    file: 'agents',
    title: 'AGENTS.md:60 删掉 team_task_create / write_scopes / blocked_by，改为 subagent + expert_brief + 交接五段',
    old: AGENTS_TASKBOARD_OLD,
    new: AGENTS_TASKBOARD_NEW,
  },
  {
    id: 'agents-teams-row',
    file: 'agents',
    title: 'AGENTS.md:83 AgentTeams 那一行：默认首选 → 装上才用（本机未装）',
    old: AGENTS_TEAMS_ROW_OLD,
    new: AGENTS_TEAMS_ROW_NEW,
  },
  {
    id: 'agents-teams-rule',
    file: 'agents',
    title: 'AGENTS.md:86 判据段：补上「没装就降级」与本机现状',
    old: AGENTS_TEAMS_RULE_OLD,
    new: AGENTS_TEAMS_RULE_NEW,
  },
  {
    id: 'agents-approval',
    file: 'agents',
    title: 'AGENTS.md:92 删掉不可执行的 agent_teams_create({approval:"required"}) 引用',
    old: AGENTS_APPROVAL_OLD,
    new: AGENTS_APPROVAL_NEW,
  },
  {
    id: 'agents-second-stage',
    file: 'agents',
    title: 'AGENTS.md:104 阶段②路径 (c)：agent_teams 标注为「装了才用」',
    old: AGENTS_SECOND_STAGE_OLD,
    new: AGENTS_SECOND_STAGE_NEW,
  },
  {
    id: 'agents-gate-section',
    file: 'agents',
    title: 'AGENTS.md：新增「门禁会话与交接」小节（--session current / handoff check / 本脚本）',
    // 插入型条目：把锚点整行替换成「新小节 + 锚点」，锚点本身保留。
    old: AGENTS_GATE_SECTION_ANCHOR,
    new: `${AGENTS_GATE_SECTION}${AGENTS_GATE_SECTION_ANCHOR}`,
  },
]);

/* ── 路径解析 ───────────────────────────────────────────────────────── */

/**
 * 把逻辑文件名映射成真实路径。
 *
 * 只在这里拼路径：`--home` / `--profile` 影响的是**根目录**，不是清单内容，
 * 因此清单在任何 home 下都照旧可用（测试用临时 home 跑，不会碰到真实 ~/.dsh）。
 */
export function resolveTargets({ home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), profile = 'desktop' } = {}) {
  return {
    agents: path.join(home, 'AGENTS.md'),
    patch: path.join(home, 'profiles', profile, 'cordis.patch.yml'),
  };
}

/** 一行摘要：多行文本压成单行并截断，避免计划输出被长段落淹没。 */
function summarize(text, limit = 110) {
  const oneLine = String(text ?? '').replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/**
 * 计算一条改动在给定文件内容下的状态。
 *
 * 顺序很重要：**先看新串**。插入型条目的新串包含旧串（小节 + 锚点），若先看旧串，
 * 已应用的条目会被判成「待应用」并被重复插入。
 *
 * @returns {{state:'apply'|'already'|'miss', note:string}}
 */
export function editState(content, edit) {
  if (typeof content !== 'string') return { state: 'miss', note: '目标文件内容不可用' };
  if (edit.new !== '' && content.includes(edit.new)) return { state: 'already', note: '已是目标状态' };
  if (content.includes(edit.old)) return { state: 'apply', note: '命中原文，将替换' };
  return { state: 'miss', note: '未命中：原文与目标文本都不在文件里' };
}

/** 在内存里应用一条改动（只替换第一处，避免误伤重复行）。 */
function applyEdit(content, edit) {
  const at = content.indexOf(edit.old);
  if (at < 0) return content;
  return `${content.slice(0, at)}${edit.new}${content.slice(at + edit.old.length)}`;
}

/* ── 计划 ───────────────────────────────────────────────────────────── */

/**
 * 生成计划（**纯读**：不写文件、不建备份、不动 mtime）。
 *
 * @returns {{ok:boolean, files:Array<{file:string, path:string, edits:Array, willWrite:boolean}>,
 *   misses:number, pending:number, already:number, errors:string[]}}
 */
export function buildPlan({ home, profile } = {}) {
  const paths = resolveTargets({ home, profile });
  const errors = [];
  const grouped = new Map();
  for (const edit of EDITS) {
    if (!grouped.has(edit.file)) grouped.set(edit.file, []);
    grouped.get(edit.file).push(edit);
  }

  const files = [];
  let misses = 0;
  let pending = 0;
  let already = 0;

  for (const [logical, edits] of grouped) {
    const filePath = paths[logical];
    let content = null;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      errors.push(`读不到 ${filePath}：${err?.code ?? err?.name ?? '未知错误'}（用 --home <dir> 指向正确的 DSH_HOME）`);
    }
    const results = [];
    for (const edit of edits) {
      const state = editState(content, edit);
      if (state.state === 'miss' && content === null) {
        // 文件读不到时不再逐条重复报「未命中」的理由，只记一条，避免噪声掩盖真正的问题。
        results.push({ ...edit, state: 'miss', note: state.note });
        misses += 1;
        continue;
      }
      if (state.state === 'miss') misses += 1;
      if (state.state === 'apply') pending += 1;
      if (state.state === 'already') already += 1;
      results.push({ ...edit, state: state.state, note: state.note });
    }
    const willWrite = results.some((r) => r.state === 'apply');
    files.push({ logical, file: filePath, edits: results, willWrite, exists: content !== null });
  }

  return { ok: misses === 0 && errors.length === 0, files, misses, pending, already, errors, paths };
}

/* ── 渲染 ───────────────────────────────────────────────────────────── */

const MARK = { apply: '[将应用]', already: '[已就绪]', miss: '[未命中]' };

/** 把计划渲染成人类可读文本（默认输出）。 */
export function renderPlan(plan, { apply = false } = {}) {
  const lines = [];
  lines.push(`本地配置对齐计划（${apply ? '将写盘' : '演练：零写入'}）`);
  lines.push(`  待应用 ${plan.pending} 条 · 已就绪 ${plan.already} 条 · 未命中 ${plan.misses} 条`);
  lines.push('');

  for (const file of plan.files) {
    lines.push(`${file.exists ? '' : '（文件不存在）'}${file.file}`);
    if (!file.exists) {
      // 文件读不到时逐条展开「找不到旧串」纯属噪声：原因只有一个（路径不对），
      // 所以只给一条可操作的结论 + 受影响的条目 id。
      lines.push(`  [未命中] 文件读不到，本文件 ${file.edits.length} 条改动全部无法判定`);
      lines.push(`      受影响: ${file.edits.map((e) => e.id).join(', ')}`);
      lines.push('      下一步: 用 --home <dir> 确认 DSH_HOME（profile 名同理），确认文件存在后重跑');
      lines.push('');
      continue;
    }
    for (const edit of file.edits) {
      lines.push(`  ${MARK[edit.state]} ${edit.id} — ${edit.title}`);
      if (edit.state === 'apply') {
        lines.push(`      before: ${summarize(edit.old)}`);
        lines.push(`      after : ${summarize(edit.new)}`);
      } else if (edit.state === 'already') {
        lines.push(`      ${edit.note}：${summarize(edit.new)}`);
      } else {
        // 「未命中」必须可操作：说清找的是什么、下一步怎么做。
        lines.push(`      ${edit.note}`);
        lines.push(`      找过  : ${summarize(edit.old)}`);
        lines.push(`      下一步: 用 --home <dir> 确认 DSH_HOME，或按 docs/agents-md-align-2026-11-13.md 手工核对这条`);
      }
    }
    lines.push('');
  }

  if (plan.errors.length > 0) {
    for (const e of plan.errors) lines.push(`错误：${e}`);
    lines.push('');
  }
  if (plan.misses > 0) {
    lines.push('有未命中 → **不写任何文件**（部分应用比不应用更难查）。先按上面的「下一步」核对。');
  } else if (!apply) {
    lines.push('以上是演练结果，未写任何文件。加 --apply 才写盘（写前备份 <file>.bak-<时间戳>）。');
  }
  return lines.join('\n');
}

/* ── 写盘 ───────────────────────────────────────────────────────────── */

/** `YYYYMMDD-HHMMSS`（本地时间，与 ~/.dsh 下既有 .bak-* 命名一致，可直接排序）。 */
export function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 执行写盘：每个**真的要改**的文件先备份，再整体写入。
 *
 * 备份名 `<file>.bak-<ts>`；同一秒内重复跑时追加 `-2`、`-3`，避免覆盖掉上一份备份
 *（覆盖备份等于把「回滚点」换成「已经改过的内容」，比没有备份更糟）。
 */
export function executePlan(plan, { now = new Date() } = {}) {
  const ts = stamp(now);
  const written = [];
  for (const file of plan.files) {
    if (!file.willWrite) continue;
    let content = fs.readFileSync(file.file, 'utf8');
    for (const edit of file.edits) {
      if (edit.state !== 'apply') continue;
      content = applyEdit(content, edit);
    }
    let backup = `${file.file}.bak-${ts}`;
    for (let n = 2; fs.existsSync(backup); n += 1) backup = `${file.file}.bak-${ts}-${n}`;
    fs.copyFileSync(file.file, backup);
    fs.writeFileSync(file.file, content, 'utf8');
    written.push({ file: file.file, backup, edits: file.edits.filter((e) => e.state === 'apply').map((e) => e.id) });
  }
  return written;
}

/* ── CLI ────────────────────────────────────────────────────────────── */

/**
 * 解析参数。`--help` 优先于一切（与同仓库其它 CLI 一致）：想看用法时不该先被参数错误打断。
 */
export function parseArgs(argv) {
  const opts = { apply: false, home: null, profile: 'desktop', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ...opts, help: true };
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    if (arg === '--home' || arg === '--profile') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        const err = new Error(`${arg} 缺少取值（例：${arg} ${arg === '--home' ? '/Users/me/.dsh' : 'desktop'}）；跑 --help 看用法`);
        err.exitCode = EXIT.ERROR;
        throw err;
      }
      opts[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--home=') || arg.startsWith('--profile=')) {
      const [flag, ...rest] = arg.split('=');
      opts[flag.slice(2)] = rest.join('=');
      continue;
    }
    const err = new Error(`未知参数 ${arg}；可用参数只有 --apply / --home / --profile / --help，跑 --help 看用法`);
    err.exitCode = EXIT.ERROR;
    throw err;
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`apply-local-config: ${err.message}\n`);
    return (process.exitCode = err.exitCode || EXIT.ERROR);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return (process.exitCode = EXIT.PASS);
  }

  const plan = buildPlan({ home: opts.home ?? undefined, profile: opts.profile });
  process.stdout.write(`${renderPlan(plan, { apply: opts.apply })}\n`);

  if (!plan.ok) {
    // 有未命中 / 读不到文件：一个比特都不写，把问题交给用户核对。
    process.stderr.write('未写入任何文件（计划不完整）。\n');
    return (process.exitCode = EXIT.ERROR);
  }

  if (opts.apply) {
    const written = executePlan(plan);
    if (written.length === 0) {
      process.stdout.write('没有需要写入的改动（全部已是目标状态）。\n');
    } else {
      for (const w of written) process.stdout.write(`已写入 ${w.file}（备份 ${path.basename(w.backup)}；改动 ${w.edits.length} 条）\n`);
    }
  }
  return (process.exitCode = EXIT.PASS);
}

// 只在被直接执行时跑 main；被 import 时（测试）保持纯函数。
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) main(process.argv.slice(2));
