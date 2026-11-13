# `~/.dsh/AGENTS.md` 与 profile 补丁的对齐清单（2026-11-13）

本文回答一个问题：**为什么要把这几处本地配置改掉，改成什么，改了之后拿什么验证。**
（共 9 处：`cordis.patch.yml` 2 处、`AGENTS.md` 7 处。）

配套的执行体是 `dsh-expert-team-kit/scripts/apply-local-config.mjs`：本文每一条「新文」都
是脚本里的一处字面替换（同一份字符串）。**脚本是唯一执行路径**，本文是它的人读版本——
两者对不上的时候以脚本为准，并修本文。

```bash
# 只打印计划，零写入（改前先看它）
node dsh-expert-team-kit/scripts/apply-local-config.mjs
# 确认无误后再写（自动备份成 <file>.bak-<YYYYMMDD-HHMMSS>）
node dsh-expert-team-kit/scripts/apply-local-config.mjs --apply
```

阅读顺序：先看「0. 为什么要改」，再逐条看「1. 逐条改法」，最后看「2. 验证」。

---

## 0. 为什么要改：文档在说一件和工具面相反的事

三条失效条款，都能在本机指认出来（不是推断）：

| 位置 | 文档怎么说 | 实际是什么 |
| --- | --- | --- |
| `AGENTS.md:48` | `dsh_code_review` **已下线**，不要再调 | 工具仍在工具面上，可以调用；走不通时报 `Cannot read properties of undefined (reading 'id')`，那是 code-review 引擎在某 profile 下没装配 |
| `AGENTS.md:60` | 起团队要用 `team_task_create` 建任务板，带 `write_scopes` / `blocked_by` | 本机工具面**没有**任务板工具；`expert_brief` 里真实字段是 `scopes` |
| `AGENTS.md:83/86` | `agent_teams_*` 是「多角色编排**默认首选**」，判据是有没有 `agent_teams_create` | 工具面上没有 `agent_teams_*`；`cordis.patch.yml:250-254` 三条官方 `disabled: true` 关着，第三方也不在 bundles 里 |

失效条款的代价不是「文字不好看」，而是**照着它做会走空**：按 `:60` 去调一个不存在的工具，
或按 `:86` 断言「首选 AgentTeams」然后交付里写错降级理由。文档与工具面相反时，读者只能
凭记忆猜哪个是真的——这正是本文要消灭的状态。

第二条要改的是同一个补丁文件里的注释：

- `cordis.patch.yml:207`：`dispatch-check` 命令写的是 `--session latest`。它在**会话 cwd**
  下执行，同一个 cwd 可能有多个会话，`latest` 会读到别的会话。
- `cordis.patch.yml:240-243`：注释写「两套都保持启用」，而 `:250-254` 三条
  `agent-team` / `tool-agent-team` / `ui-agent-team` 全是 `disabled: true`。

---

## 1. 逐条改法（原文 → 新文 → 理由）

> 行号按 **2026-11-13 13:50 的 `~/.dsh/AGENTS.md`（26251 字节）** 核对。文件会继续变长，
> 脚本因此按**文本**匹配而不是按行号匹配；行号只用于本文定位。

### 1.1 `AGENTS.md:48` — `dsh_code_review` 的真实状态

**原文**

```markdown
- **`dsh_code_review` 工具已下线**（2026-11-12 核实：code-review 插件在任何 profile 的 node_modules 与 patch 里都不存在，调它会报 `Cannot read properties of undefined (reading 'id')`）。评审统一走**专家**：`summon_expert("代码审查工程师", 任务书)`；要结构化产物就让专家写 REVIEW.md。**不要再调 `dsh_code_review` / `auto-review`**。
```

**新文**

```markdown
- **`dsh_code_review`：工具面里有，但调用不保证成功**（2026-11-13 复核：`dsh_code_review` 仍在工具面上，可以调用；走不通时报 `Cannot read properties of undefined (reading 'id')`——那是 code-review 引擎在该 profile 下没装配，不是参数错）。**能调通就用它拿结构化报告；报错就改走 `summon_expert("代码审查工程师", 任务书)`**，要落盘产物就让专家写 REVIEW.md。状态看**实际调用结果**，不要凭记忆断言「已下线」。
```

**理由**：原文把「某 profile 下引擎没装配」写成了「工具已下线」，于是有工具时也判它不能用；
更糟的是它教人**凭记忆**下结论。新文保留可操作的两条路（能调就用 / 报错走专家），并把判据
换成「实际调用结果」——这是可复跑的，不是记忆。

### 1.2 `AGENTS.md:60` — 任务板工具不存在，换成真实三件事

**原文**

```markdown
- **够格起团队就别只派裸 subagent**（2026-11-13 加）：满足「工件 + 可机器验收 + W≥3 + 需审阅返工」时，要**建任务板**（`team_task_create` 带 `write_scopes`/`blocked_by`）再用 `subagent` 起队友、让队友自己 `claim` → `complete`。只并发起 3 个 subagent 而不用任务板，等于丢掉了所有权、依赖与写作用域冲突检测——这属于降级使用，要在交付里说明为什么不起板。
```

**新文**

```markdown
- **够格起团队就别只派裸 subagent**（2026-11-13 加）：满足「工件 + 可机器验收 + W≥3 + 需审阅返工」时，用下面三件事组合，而不是裸派：
  - **起队友**：`subagent`（或 `subagent_fork`）起一个带名字的席位，名字用专家标识（`code-reviewer`、`software-architect`）；
  - **任务书**：`expert_brief({ expert, task, verify, scopes, worker })` 生成——人格正文、验收命令、写作用域都拼好了，把返回值整段作为 `subagent` 的 prompt；写作用域字段就是 `scopes`，本机**没有** `write_scopes` / `blocked_by` 这两个字段；
  - **交接**：`node dsh-expert-team-kit/bin/handoff.mjs` 的五段（decided / rejected / risks / files / remaining），换会话时用它接前情。
  **本机当前没有任务板工具**（`team_task_create` / `team_task_get` / `team_task_update` 都不在工具面上），所以没有 `claim` → `complete` 这步。代价是：所有权、依赖排序与写作用域冲突检测只能靠任务书里的 `scopes` + 交接文档维持，**降级事实要写进交付**，不能默认观众知道。
```

**理由**：`team_task_create` / `write_scopes` / `blocked_by` 在本机不存在，照原文执行一定卡住；
`expert_brief` 的写作用域字段真实名字是 `scopes`。新文把「建板 + claim/complete」替换成
**本机真能跑的三件事**（`subagent` + `expert_brief` 任务书 + 交接五段），并明确写出降级代价——
原来那套要解决的所有权/依赖/写作用域冲突，现在由 `scopes` 声明与交接文档兜着，**这是降级，
必须说明**，而不是假装能力还在。

### 1.3 `AGENTS.md:83` — AgentTeams 那一行：默认首选 → 装上才用

**原文**

```markdown
| AgentTeams 插件 | `agent_teams_create` 等 `agent_teams_*` | 多角色编排**默认首选** |
```

**新文**

```markdown
| AgentTeams 插件 | `agent_teams_create` 等 `agent_teams_*` | **装上才用**；本机当前未装 → 按规则降级到官方（见下） |
```

**理由**：表格的「定位」列是给读者一眼定档用的。写「默认首选」而工具面上没有，读者会先试着
调 `agent_teams_create`、失败、再猜为什么。改成「装上才用 + 本机当前未装」后，同一句话就
说明了**现状**和**降级方向**。

### 1.4 `AGENTS.md:86` — 判据段：补上「没装怎么办」

**原文**

```markdown
**判据是工具面里有没有 `agent_teams_create`，不是改配置**：有就直接用它；缺失或报不可用才降级到官方并说明原因。不要为选边去改 profile 的 `cordis.patch.yml`，也不要在两套间来回切。交付里写清用了哪套工具名。
```

**新文**

```markdown
**判据是工具面里有没有 `agent_teams_create`，不是改配置**：装了就用它；**没装就按上面的规则降级到官方 `subagent` + `expert_brief` 任务书，并在交付里写明降级原因**。不要为选边去改 profile 的 `cordis.patch.yml`，也不要在两套间来回切。交付里写清用了哪套工具名。本机当前工具面**没有** `agent_teams_*`，所以默认走官方并声明降级。
```

**理由**：原文的判据本身没错，缺的是**判据的另一半**——「工具面里没有」时该做什么。补上
「没装就降级 + 在交付里写原因」，把判据变成两条都能执行的分支；并写明本机现状（没有
`agent_teams_*`），省掉读者自己去工具面里找。

### 1.5 `AGENTS.md:92` — 删掉不可执行的 `agent_teams_create({approval:"required"})`

**原文**

```markdown
- **不问拆解判据**（「能切几条」是我的活）：只问两件预算——是否要求可复核证据、急不急。成本披露点在 `agent_teams_create({approval:"required"})` 的计划屏。
```

**新文**

```markdown
- **不问拆解判据**（「能切几条」是我的活）：只问两件预算——是否要求可复核证据、急不急。成本披露点在**收尾交付**（用了哪套工具、几个席位、大致开销）；装了 AgentTeams 才有计划屏，没装就直接说明开销。
```

**理由**：`agent_teams_create({approval:"required"})` 在本机不可执行，读者照它去找「计划屏」
会落空。成本披露**不依赖任何工具**：交付里写清用了哪套工具、几个席位、大致开销即可，
所以把披露点改成「收尾交付」，并说明计划屏是装了才有。

### 1.6 `AGENTS.md:104` — 阶段② 路径 (c)：标注「装了才用」

**原文**

```markdown
- `summon_experts` 只返回纯文本，**拿不到子会话 id 去续接**，第二段三条路：(a) 再发一次 `summon_experts` 并把上段结论摘要带进任务书（专家看不到上一轮）；(b) 用 `subagent`（返回 id，`send_message` 可续接）；(c) 用 `agent_teams_create` 做成任务 DAG（实现那条挂 `inScope` + `verify`）。
```

**新文**

```markdown
- `summon_experts` 只返回纯文本，**拿不到子会话 id 去续接**，第二段三条路：(a) 再发一次 `summon_experts` 并把上段结论摘要带进任务书（专家看不到上一轮）；(b) 用 `subagent`（返回 id，`send_message` 可续接）——**本机默认这条**；(c) 装了 AgentTeams 才用它做成任务 DAG（实现那条挂 `inScope` + `verify`），没装就用 (b) 逐个派并按交接五段收口。
```

**理由**：三条路里 (c) 不可执行，但 (a)(b) 是能跑的。把「本机默认这条」直接标在 (b) 上，
读者不用自己比较哪条可用；(c) 保留但注明前提，并为「没装」补上替代做法（`subagent` + 五段交接），
这样三条路在任何 profile 下都有可执行答案。

### 1.7 新增小节「门禁会话与交接」

**插入位置**：`## 收尾自证（硬要求）` 之前（把该标题整行替换成「新小节 + 该标题」，标题本身保留）。

**新文**（脚本里的替换是「下面整段」替换「原锚点行 `## 收尾自证（硬要求）`」——所以这段的
**最后一行就是那个锚点标题本身**，它被原样留在后面）

```markdown
## 门禁会话与交接（2026-11-13 加）

- **门禁命令要用 `--session current`**：`completion-ledger` 的独立验收（Oracle）在**会话 cwd** 下执行命令，
  同一个 cwd 可能有多个会话，按 `--session latest` 会读到别的会话。插件在跑验收时会把
  `DSH_SESSION_ID=<当前会话 id>` 透传给子进程，所以 `dispatch-check` 这类要读会话日志的命令
  应写 `--session current`（读该环境变量），而不是 `--session latest`。
- **交接要跑 `node dsh-expert-team-kit/bin/handoff.mjs check`**：五段（decided / rejected / risks / files /
  remaining）缺一段或空一段退出码就是 2，可以直接挂进收尾脚本；`init` 生成模板，`append` 追加。
- 本机配置的对齐脚本：`node dsh-expert-team-kit/scripts/apply-local-config.mjs`（默认只打印计划，
  `--apply` 才写，写前备份成 `<file>.bak-<时间戳>`）。改法清单见
  `dsh-expert-team-kit/docs/agents-md-align-2026-11-13.md`。

## 收尾自证（硬要求）
```

**理由**：这两件事**已经存在但没写在规则里**——门禁怎么拿到「当前会话」（`DSH_SESSION_ID`）、
交接怎么跑（`handoff.mjs check` 的退出码）。缺了这节，读者知道「要跑门禁」却不知道参数该写
什么，于是继续用 `--session latest` 读到别的会话。新增小节是**加内容**，不删任何既有条款。

### 1.8 `cordis.patch.yml:207` — `--session latest` → `--session current`

**原文**

```yaml
              command: node /Users/zhe.chen/Desktop/dsh/github/dsh-expert-team-kit/bin/dispatch-check.mjs --session latest
```

**新文**

```yaml
              command: node /Users/zhe.chen/Desktop/dsh/github/dsh-expert-team-kit/bin/dispatch-check.mjs --session current
```

**理由**：这条命令由 `completion-ledger` 的 Oracle 在**会话 cwd** 下执行。同一个 cwd 下可以有
多个会话，`--session latest` 按 mtime 取最新，读到别人是常态而不是边界；`--session current`
读 `DSH_SESSION_ID`（插件已透传，见 `dsh-completion-ledger/lib/index.js` 的 `oracleSessionEnv`
与 `lib/oracle.js` 的 `opts.env`）。

> **依赖（必须一起生效）**：`--session current` 要求 `dispatch-check` 支持读 `DSH_SESSION_ID`。
> 工作区当前版本**已支持**（`--session current` / `--session-env <变量名>`，见
> `bin/dispatch-check.mjs` 的 `current` 分支），实测：
>
> ```bash
> DSH_SESSION_ID=209fe43d-a5c1-46c7-85bf-6420507ffdfb \
>   node dsh-expert-team-kit/bin/dispatch-check.mjs --session current
> # → 选会话：按环境变量里的会话 id（--session current / 缺省行为），退出码 0
> env -u DSH_SESSION_ID node dsh-expert-team-kit/bin/dispatch-check.mjs --session current
> # → 取不到当前会话 id：环境变量 DSH_SESSION_ID 未设置或为空，退出码 1（不会静默退回 latest）
> ```
>
> 所以先确认本机 `dispatch-check` 已带这个分支，再改 `cordis.patch.yml`；两者不同批上线时，
> Oracle 会把「取不到会话 id」判成验收未通过（这条依赖见文末风险 1）。

### 1.9 `cordis.patch.yml:240-243` — 注释与实际状态一致

**原文**

```yaml
# ===== 2026-10-13 团队实现：两套并存（优先级由规则定，不靠这里切换）=====
# 结论：官方 Agent Teams 三件套与第三方 @nanmicoder/dsh-agent-teams（agent_teams_*）
# 并存；**规则上首选 AgentTeams（`agent_teams_create`），官方只作兜底**（2026-10-13
# 用户要求），因此两套都保持启用。
```

**新文**

```yaml
# ===== 团队实现状态（2026-11-13 更正 2026-10-13 的首选结论）=====
# 更正原因：原注释说「官方与第三方并存、因此都启用」，与下面的实际状态相反——
# 官方三件套被本段末尾三条 `disabled: true`（agent-team / tool-agent-team /
# ui-agent-team）关着，第三方 @nanmicoder/dsh-agent-teams 也不在 profile 的
# dsh.profile.bundles 里（未装配）。所以**当前两套都没启用**：本机工具面上没有
# `agent_teams_*`，多角色协作走官方 `subagent` + `expert_brief` 任务书 + 交接五段
# （见 ~/.dsh/AGENTS.md 的派发规程）。
# 要启用哪一套：官方 → 注释掉下面三条 `disabled: true`；第三方 → 把
# @nanmicoder/dsh-agent-teams 加进 profile 的 bundles。只改一处，不要两套混开。
```

**理由**：注释与紧随其后的三条 `disabled: true` 直接矛盾，而**注释通常被当成事实**读。新文
只做两件事：陈述实际状态（两套都没启用），给出两种启用方式。原文的「不要两套混开」判断
保留（这与 `AGENTS.md` 的「不要在两套间来回切」一致），删掉的是与事实相反的「都保持启用」。

---

## 2. 验证：怎么知道改对了

**命令（本机 cwd `~/Desktop/dsh/github`）**

```bash
node dsh-expert-team-kit/scripts/apply-local-config.mjs                       # 演练，应零写入
node dsh-expert-team-kit/scripts/apply-local-config.mjs --apply               # 写入（备份 <file>.bak-<ts>）
node dsh-expert-team-kit/scripts/apply-local-config.mjs                       # 再跑：应为「已就绪 9 条 / 未命中 0」
```

**期望输出（关键行）**

| 时机 | 期望 |
| --- | --- |
| 首次演练 | `待应用 9 条 · 已就绪 0 条 · 未命中 0 条`，退出码 0，文件 mtime 不变 |
| `--apply` | 每个文件一行 `已写入 …（备份 …bak-<ts>；改动 N 条）`，退出码 0 |
| 再次演练 | `待应用 0 条 · 已就绪 9 条 · 未命中 0 条`（幂等） |
| 目标文本被手改过 | `未命中 1 条`，打印「找过 / 下一步」，退出码 1，**一个文件都不写** |

**零写入自证（可复跑）**

```bash
stat -f '%m %N' ~/.dsh/AGENTS.md ~/.dsh/profiles/desktop/cordis.patch.yml   # 记下
node dsh-expert-team-kit/scripts/apply-local-config.mjs > /dev/null          # 演练
stat -f '%m %N' ~/.dsh/AGENTS.md ~/.dsh/profiles/desktop/cordis.patch.yml   # 必须与上面完全一致
```

**本文与脚本的同步自检（可复跑，应打印 `DOC<->SCRIPT IN SYNC (9 edits)`）**

```bash
cd ~/Desktop/dsh/github/dsh-expert-team-kit && node -e "
const fs=require('fs');
const doc=fs.readFileSync('docs/agents-md-align-2026-11-13.md','utf8');
import('./scripts/apply-local-config.mjs').then(m=>{
  let bad=0;
  for(const e of m.EDITS){
    const hasOld=doc.includes(e.old), hasNew=doc.includes(e.new);
    if(!hasOld||!hasNew){bad++;console.log('DRIFT',e.id,'old:',hasOld,'new:',hasNew);}
  }
  console.log(bad===0?'DOC<->SCRIPT IN SYNC ('+m.EDITS.length+' edits)':'DRIFT '+bad);
});"
```

**失败时怎么办**

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| `未命中`，退出码 1 | 原文不在文件里（被手改过 / 版本不同）且目标文本也不在 | 按本文对应小节的「原文」手工核对；确认后把脚本里的字面串更新成当前文本 |
| `已就绪` 但你要撤销 | 已应用 | `cp <file>.bak-<ts> <file>`（备份与原文同字节） |
| 写了但工具面没变化 | 改的是 `~/.dsh` 的文件，**需要重启宿主/重开会话**才重新装配配置 | 重启后按校验行复查 |

---

## 3. 改动的风险（如实列出）

1. **`--session current` 依赖 `dispatch-check` 支持 `DSH_SESSION_ID`**（见 1.8 的依赖块）。
   工作区当前版本已支持；若谁回退了这个分支，`dispatch-check` 会 exit 1「取不到当前会话 id」，
   被 Oracle 判成验收未通过。**改 `cordis.patch.yml` 前先跑一次上文那条实测命令。**
2. **写的是用户级 `~/.dsh`**：`AGENTS.md` 影响所有项目会话，`cordis.patch.yml` 影响 desktop
   profile 的全部插件装配。本脚本因此默认演练、只在 `--apply` 时写、且写前备份；有未命中时
   **一个文件都不写**（部分应用比不应用更难查）。
3. **备份名精度到秒**：同一秒内重复 `--apply` 会追加 `-2`、`-3`，不覆盖上一份备份（覆盖备份
   等于把回滚点换成已改过的内容）。
4. **本文与脚本会漂移**：两处字面串是同一份内容的两个副本。改一处必须同改另一处，验证方式是
   `node dsh-expert-team-kit/scripts/apply-local-config.mjs` 打印的 `before:` 与本文「原文」逐字一致。
5. **`agent_teams_*` 的结论是 2026-11-13 13:50 的快照**：工具面会变。若哪天装了 AgentTeams，
   1.3 / 1.4 的新文需要再次更新——判据仍是「工具面里有没有 `agent_teams_create`」，不要靠本文。
