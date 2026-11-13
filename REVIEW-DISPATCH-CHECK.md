# 独立复核：`bin/dispatch-check.mjs` 判据换锚（未提交改动）

- **评审人**：Code Reviewer（`engineering/engineering-code-reviewer`）
- **仓库**：`dsh-expert-team-kit`（branch `main`）
- **被审对象（git 未提交）**：`bin/dispatch-check.mjs`（新增 903 行）、`test/dispatch-check.test.mjs`（新增 873 行 / **37** 个用例）、`README.md`（+68 行）、`package.json`（+1 bin 条目）
- **方式**：只审不改。所有结论均来自实跑，命令与输出见附录。变异检验后已还原，`shasum` 逐字节对齐。
- **环境**：macOS arm64 / node v26.8.2 / zstd 1.5.6（`/opt/homebrew/bin/zstd`）

---

## 总体印象

先说好的部分，因为这部分做得扎实：

- **`childEdits` 确实从否决条件里拿掉了**。`judge()` 的 `dispatched` 四元组里没有 `childEdits`，它只出现在 warning 文案（`:769` / `:774`）。这是本次改动的核心诉求，代码层面达成。
- **坏输入不崩**做得干净：坏 JSON 行、空 `arguments`、缺 `file_path`、`arguments` 是对象而不是字符串、`tool/call` 缺 `data`，逐个构造后全部降级为 warning 而不抛（附录 R2）。真实日志 9465 条 `edit`/`write` 的 `arguments` **100% 是字符串且全部解析成功**，说明「对象型 arguments 导致漏计」这个担心的现网风险为零。
- **截断尾行**（日志写到一半）实测正常：3 次 edit 全部计入 + 一条「1 行不是合法 JSON」。
- **退出码契约**稳定：`--help`/`-h` = 0、未知参数/缺值 = 1、找不到会话 = 1（stdout 空、stderr 无栈）、VIOLATION = 2 且 `--json` 仍可解析；同一输入两次 `--json` 逐字节一致。
- **组装出来的数字自洽**：`files` 是父+子并集去重、`attribution` 与 `children` 对齐、人类输出不与 JSON 混淆。

**但判据换锚换过头了。** 新口径把「咨询」和「实现交出去」当成同一件事，于是本工具**自述要抓的那个失效形态**（README:「主 agent 叫了专家或子 agent 做评审，代码实现却仍自己干完」）恰好被判成 PASS。这不是理论推演——我在本机真实日志里找到 **64 个**铁证会话。

问题共 **14 条**：🔴 1 / 🟡 8 / 💭 5。

---

## 🔴 Blocker

### [B1] 把「叫了专家」当成「实现已交出」，正好放过本工具要抓的假合规

**位置**：`bin/dispatch-check.mjs:731`（`dispatched` 组装）、`:746`（VIOLATION 分支）；`README.md:216-218`（自述失效形态）、`README.md:242-245`（判定口径）

```js
// :731
const dispatched = subagents + expertCalls + briefs + catalog > 0
// :746
if (!dispatched) { /* VIOLATION */ }
```

**期望**：`VIOLATION` 表示「跨多文件的主会话改动、**且实现没有交出去**」。既然工具目的是抓「叫了专家做评审、实现仍自己干完」，那么「只叫了专家（`one-shot` 咨询会话）」必须**不构成**豁免。

**实际**：`expertCalls` / `briefs` / `catalog` 任一 `> 0` 即 PASS。三者都可以在「没有任何人写代码」的前提下取得：

| 证据种类 | 为什么不等于「实现交出去了」 |
| --- | --- |
| `expertCalls`（`summon_expert*`） | 专家是一次性咨询会话，按 `AGENTS.md` 只做阶段①（出方案/意见），不承担实现 |
| `briefs`（`expert_brief`） | 本仓工具本身是**纯函数**：`lib/brief.mjs` 只 `import { resolvePersona }`，无子进程、无网络、无写盘，只拼一段文本 |
| `catalog` | 它计的是**子会话登记事件**，子会话既可能是「写代码的 teammate」，也可能是「只出意见的专家」 |

**实测（不是推演）**——筛选条件极保守：`delegationDepth === 0`（主会话）、`parentEdits > 0`、`fileCount >= 2`、`verdict === 'PASS'`、**且 `attribution.childLogsMissing === 0`（子会话日志一个不缺）**、**且 `childEdits === 0`（所有子会话合计 0 次编辑）**。也就是：日志齐全、所有被派出去的会话一个字没改、主会话自己跨多文件改完了，仍然 PASS。

**命中 64 个真实主会话**，例如：

| 会话（uuid） | parentEdits | files | subagent | 专家 | 任务书 | catalog | 子会话 edit 合计 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `session-97ba2f07` | 100 | 5 | 0 | 9 | 0 | 9 | **0** | PASS |
| `session-df677874` | 53 | 14 | 0 | 4 | 0 | 4 | **0** | PASS |
| `session-e962412f` | 53 | 14 | 0 | 3 | 0 | 5 | **0** | PASS |
| `session-9a1f0f6f` | 50 | 14 | 0 | 4 | 0 | 6 | **0** | PASS |
| `session-ebab78bb` | 10 | 8 | 0 | 2 | 0 | 2 | **0** | PASS |

（`session-ebab78bb` 就是 README 里当作「旧版误判」回归样本的那个会话 id。旧版判它 VIOLATION 是因为它把 `childEdits=0` 当否决；新版判它 PASS 是因为它叫了专家 —— **两次都没有判断「实现到底交出去没有」**。）

复现最小核（直接调 `judge()`，绕开日志）：
```
judge({ files:['/p/a.ts','/p/b.ts'], parentEdits:10, childEdits:0,
        dispatch:{subagents:0,expertCalls:1,briefs:0,catalog:0} })  →  PASS
```
即：**一次纯咨询的 `summon_expert`，就能把 10 次跨 2 文件的自我实现洗干净。**

**顺带说明可用的判别信号被浪费了**：`subagent/catalog` 的 `data` 里有 `mode` 字段，实测真实取值就是 `one-shot`（专家咨询，label 形如 `代码审查工程师` / `expert:engineering-software-architect`）与 `continuable`（可续接 teammate）。`countDispatch()` 完全没读这个字段，`catalog` 一视同仁 +1。

**建议**（择一即可，都不需要回到 `childEdits` 当否决）：
1. 把「实现交出去」的判据收窄为 `dispatch.subagents > 0`，或 catalog 中存在 `data.mode === 'continuable'` 的登记；
2. 或把咨询类证据降级为「不否决、也不豁免」的第二轴，输出 `verdict: PASS` 的同时给 `handoff: 'none' | 'advisory' | 'implementation'`，让读者（和 CI）能区分；
3. 若刻意保留现在的宽松口径，README 与 `USAGE` 必须改写「本工具要抓的失效形态」，否则用户会按旧语义读这份 PASS —— 这是当前文档与实现互相打脸的地方。

---

## 🟡 Suggestions

### [S1] `catalog` 计数零校验：一条坏事件即可把 VIOLATION 翻成 PASS

**位置**：`bin/dispatch-check.mjs:366-368`；`test/dispatch-check.test.mjs:678-708`（把该行为锁成期望）

**期望**：只有「能定位到一个子会话」的登记才算派活证据。
**实际**：只看 `event.type === 'subagent/catalog'` 就 `+1`，不校验 `data`：

```
countDispatch([{type:"subagent/catalog"}])                    → {"catalog":1}
countDispatch([{type:"subagent/catalog",data:null}])          → {"catalog":1}
```

因此一条 `{"type":"subagent/catalog"}`（无 data、无 childId）就能让 `dispatched=true`，把「四项全 0 → VIOLATION」翻成 PASS；而同一条事件**不产生任何可读子会话**（`children=[]`）。`test:678` 甚至明确断言 `catalog=3 / children=0 / verdict=PASS`，等于把这个洞写成了契约。
现网实测：989 条 catalog 事件里 **0 条** `data` 为空，所以今天还没被触发；但这是闸门的单点失效面，建议改成只计带可用 `childId` 的登记（或单列 `catalogUnresolved` 且不计入 `dispatched`）。

### [S2] 坏 `.zstd` + 完好 `session.jsonl` 并存时硬失败，且错误提示不可执行

**位置**：`bin/dispatch-check.mjs:59`（`LOG_BASENAMES` 顺序）、`:202-212`（`resolveLogFile`）、`:215-233`（`decompressZstd` 直接抛）

**期望**：同目录有可读的 `session.jsonl` 时应能读到数据（README:「两种日志格式都吃」）。
**实际**：`resolveLogFile()` 只按固定顺序取第一个存在的文件，`.zstd` 永远优先；解压失败直接 `throw CliError` → **exit 1**，即使旁边就有一份完好、可解析的 `session.jsonl`。

实测（附录 CASE 1）：目录内 `session.v4.jsonl.zstd` = `not a zstd file at all`、`session.jsonl` 有 7 次 edit → `EXIT=1`，一条数据都没读。

更麻烦的是提示语本身无法执行：`确认文件没有损坏；损坏时用同目录的 session.jsonl 重试`——但没有任何选项能让 CLI 去读 `session.jsonl`（`--session`/`--cwd`/`--json`/`--help` 都不管日志格式），用户只能手动 `mv` 掉 `.zstd`。
建议：解压/读取失败时自动回退到下一个候选，或提供 `--log <file>`。

### [S3] 双格式并存时无条件取 `.zstd`，不比较 mtime → 静默给出错误结论

**位置**：`bin/dispatch-check.mjs:59` + `:202-212`

**期望**：两种形态并存时取更新的那份，或至少警告「两份不一致」。
**实际**：`.zstd` 恒优先。实测（附录 R1）：放一份**合法但过期**的 `.zstd`（1 次 edit / 1 个文件）与一份**更新**的 `session.jsonl`（7 次 edit / 7 个文件），CLI 读旧快照 → `parentEdits=1 / verdict=PASS`，而真实内容是 `VIOLATION`。
对闸门类工具，**静默 PASS** 比报错更危险。现网 1437 个日志文件全是 `.zstd`、无双格式并存样本，故列 🟡 而非 blocker。

### [S4] `--cwd` 兜底把每个会话整份解压：一次 typo 成本 8.7 秒

**位置**：`bin/dispatch-check.mjs:453-463`（`filterByCwd`）、`:440-447`（`readMetaCheap` 调 `readSessionEvents` 全量读）

**期望**：slug 不匹配时用低成本方式读元数据。
**实际**：`readMetaCheap()` 走的是完整的 `readSessionEvents()`（解压 + 全量 JSON.parse），并对**每一个**会话做一遍。实测：

| 场景 | 耗时 |
| --- | --- |
| `--cwd <本仓工作区绝对路径>`（slug 命中，零解压） | **0.32s** |
| `--cwd /tmp/definitely-not-a-workspace-xyz`（走兜底，390 个会话全解压） | **8.68s** |
| 不传 `--cwd` | 0.33s |

建议：兜底只读首行（首帧解压或流式读取），或对 `--cwd` 不匹配的场景加缓存/上限。

### [S5] 裸 uuid 子会话目录对 `--session <uuid>` 不可见

**位置**：`bin/dispatch-check.mjs:185-189`（`sessionDirsIn` 只收 `name.startsWith('session-')`）

**期望**：README 明确说子会话目录是**裸 uuid**（`README.md:296-299`），那用户自然会用 `--session <那个 uuid>` 去查。
**实际**：`listSessionDirs()` 只收 `session-*` 形态 → 裸 uuid 目录进不了候选集。实测：`--session b3d3fd97`（该目录确实存在于磁盘）→ `找不到会话 b3d3fd97`；只有传**绝对目录路径**才成功（`resolvedBy=dir`）。
现网 1249 个会话里 **859 个**是裸 uuid 目录，全部只能靠绝对路径选中。建议选择器在 uuid 匹配失败时，额外按裸 uuid 目录名兜底匹配一次。

### [S6] 测试全是 CLI 端到端、零直接单测 → 本次改动的核心不变量没被锁住

**位置**：`test/dispatch-check.test.mjs:382-395`（用例名自称「判据不含 childEdits」）

**期望**：如果有人把 `childEdits` 重新塞进 VIOLATION 条件（**这正是本次改动要防的回归**），测试应当变红。
**实际**：**不变红**。实测变异（附录 M2）：把 `:746` 改成 `if (!dispatched && childEdits === 0)` → **37/37 全绿**。

原因：该用例构造的场景里 `childEdits` 恒为 0；而在真实管线里 `childEdits > 0` 必然意味着有 catalog ⇒ `dispatched=true`，永远到不了 VIOLATION 分支。所以用例名承诺的东西它检测不到（结构性不可达 ≈ 等价变异体，但从「锁回归」角度仍是漏网）。
建议：加一条**直接调 `judge()`** 的单测（该函数已 `export`）：
```js
judge({ files:['/p/a.ts','/p/b.ts'], parentEdits:3, childEdits:9,
        dispatch:{subagents:0,expertCalls:0,briefs:0,catalog:0} })  // 期望 VIOLATION
```
另：`judge` / `countDispatch` / `readEditTarget` / `summarizeAttribution` / `workspaceSlugForCwd` 均已 `export` 却**无一处被直接调用**，37 个用例全部走 `spawnSync` 子进程，单条用例 30–70ms。

### [S7] 派活白名单漏了 `spawn_teammate` / `team_task_create` / `agent_teams_create`

**位置**：`bin/dispatch-check.mjs:50`（`SUBAGENT_TOOLS = ['subagent','subagent_fork']`）、`:47`、`:53`；注释 `:49` 称「`spawn_teammate` 自 0.2.2-rc.2 起并入 `subagent`」

**期望**：真实日志里出现过的派活工具名都要计入。
**实际**：现网实测存在 `spawn_teammate` **5** 次、`team_task_create` **15** 次、`agent_teams_create` **5** 次（还有 `agent_teams_add_member` 10、`agent_teams_resume` 1），一个都不在白名单 —— 也就是说注释里那条「已并入」在真实数据上不成立。
**本轮未观测到假阳性**：这些主会话同时都有 `catalog > 0`（9 个用 team 工具的主会话 catalog 分别为 5/6/8/8/18/1/9/3/10），被 `catalog` 兜住了。所以这是**潜在**假阳性，不是当前缺陷：一旦某个宿主版本不再产 `subagent/catalog`，这类会话立刻被误判 VIOLATION。而它们恰恰是 `AGENTS.md` 里「AgentTeams 优先」的默认编排形态，建议直接并入 `SUBAGENT_TOOLS`。

### [S8] 子会话被判 VIOLATION 时仍退出 2，与 README「只作归因参考」冲突

**位置**：`bin/dispatch-check.mjs:889`（`exitCode = verdict === 'VIOLATION' ? 2 : 0`）；`README.md:251-253`

**期望**：README 说子 agent 会话（`delegationDepth > 0`）「结论只作归因参考 —— 子 agent 自己改代码正是本职」。既然只是参考，CI 不该因此失败。
**实际**：退出码仍是 2，而 README 同时写明「退出码即契约，CI 只看它」。实测本机有 1 个 `session-*` 形态的子会话目录（`session-43dbf93f`，107 次 edit / 53 个文件）被判 VIOLATION 并退出 2 —— 那是它本职。
**缓解**：`--session latest`/uuid 只扫 `session-*`（见 S5），390 个可选会话里 depth>0 的只有 1 个，所以默认调用被误伤的暴露面很小（我没有观测到 164 这个数字在默认路径下可达 —— 那个数字来自全量扫描，含 859 个裸 uuid 目录）。
建议：`delegationDepth > 0` 时不用 2（例如输出 `verdict: VIOLATION` 但退出 1 或 0），或要求显式 `--allow-child` 才用 2。

---

## 💭 Nits

### [N1] 注释里的判定 ④ 在代码中不存在
`bin/dispatch-check.mjs:715` 写着「④ 其它（理论上到不了，保底）→ PASS + warning」，但 `judge()` 函数体只有 **4 个** `return {`（①②③-violation③-pass），没有第四类返回。穷举 192 组输入（`parentEdits ∈ {0,1,5}` × `fileCount ∈ {0,1,2,7}` × 四个 dispatch 维度 ∈ {0,1} × `childEdits ∈ {0,9}`）只出现 `PASS` / `VIOLATION`。这与 `AGENTS.md`「注释与代码对账，指不出的就是装饰性注释」直接冲突，建议删掉 ④。

### [N2] VIOLATION 文案只列三项，漏了 catalog
`bin/dispatch-check.mjs:747`：`（subagent/专家/任务书均为 0）`，但真实条件是**四项**全 0（`subagent + 专家 + 任务书 + 子会话登记`）。README:243 与注释 `:714` 都写「四项全 0」，只有这句用户可见的文案是三项；`test:170-174` 还把这个短文案用正则锁住了。建议文案补齐「子会话登记」。

### [N3] `subagents` 旧字段与 `dispatch.catalog` 是两个数，README 却当成同一个
`bin/dispatch-check.mjs:652`：`subagents: catalogs.length`（只计带 `childId` 的登记），而 `dispatch.catalog` 计**全部** catalog 事件（`:367`）。`README.md:240` 把 `subagents` 描述为「子会话登记数」。实测在 `test:678` 场景下 `dispatch.catalog=3` 而 `subagents=0` —— 同一「登记数」出现 3 和 0 两个值。建议 README 明确 `subagents` = 「能解析出 childId 的登记数」。

### [N4] `--json` 出错时 stdout 为空，README 未说明
`README.md:262` 说「`--json` 只输出一份 JSON（带 verdict/...）」。实测出错时（`--session nosuch --json`）`EXIT=1` 且 **stdout 0 字节**，JSON 完全没有。脚本消费方若直接 `JSON.parse(stdout)` 会炸。建议在 README 补一句「出错时只写 stderr，stdout 为空」。

### [N5] 「120 个用例」这个说法与文件对不上
`test/dispatch-check.test.mjs` 实测 **37** 个用例；本仓 `test/` 合计才 120 个（`brief` / `persona` / `tool` / `dispatch-check` 四个文件）。交付说明若称该文件 120 个用例，计数口径错了。

---

## 已核实无误的项（不构成问题，仅留证）

1. **VIOLATION 真实条件确不含 `childEdits`**：`:731` 的 `dispatched` 只由 `subagents/expertCalls/briefs/catalog` 组成；`childEdits` 仅出现在 `:769`（PASS 文案）与 `:774`（「少于主会话」提示），**无否决权**。硬约束满足。
2. **判定优先级与注释 ①②③ 一致**；② 的单文件豁免用 `fileCount <= 1`，且 `parentEdits > 0` 时 `fileCount` 不可能为 0（每个可解析 edit 必带 `file_path`），② 不会吞掉本该判违规的情形。
3. **「四项全 0 → VIOLATION」有能变红的用例**：变异 M1（条件改恒假）→ 9 条红，见附录。核心分支不是恒真。
4. **读取层健壮性逐项实测通过**：坏 JSON 行、空 `arguments`、缺 `file_path`、`file_path` 为空串/非字符串、`arguments` 是 JSON `null`/数组/对象、`tool/call` 缺 `data`、`subagent/catalog` 缺 `data`/`data:null`/`childId:''` —— 全部不崩、不虚高 `parentEdits`、各记一条 warning（附录 R2 六条 warning 实测）。
5. **截断尾行**正常：3 次 edit 全部计入 + `主会话日志有 1 行不是合法 JSON，已跳过`。
6. **两种日志形态都能读**：`.zstd` 走 `zstd -dc`（附录 zstd 用例 EXIT=2 正确判违规）；未压缩 `session.v4.jsonl` 走 `readFileSync`（EXIT=0）。本机 1437 个真实 zstd 日志 **1437 个全部解压成功、0 失败**。
7. **CLI 契约**：`--help`=0、`-h`=0、`--nope`=1、`--session`（缺值）=1、空会话根=1、VIOLATION=2；VIOLATION 时 `--json` 仍完整可解析且字段齐全；两次调用逐字节一致；前缀歧义走 `resolvedBy: 'prefix-ambiguous'` 并追加可操作 warning。
8. **变异还原逐字节一致**：`shasum -a 256` = `3b582e59c99da83a601451fe10c7374b13a3b9a6ee63b1c93690405342aa2ffc`，与变异前基线相同；`git status` 无新增改动。

---

## 未执行

- **Windows / 无 zstd 环境**：本机有 zstd 1.5.6，`zstd` 缺失路径只通过测试里的 `PATH` 劫持（`test:849-873`）间接覆盖，我未在真缺少 zstd 的机器上跑。
- **DSH 未来版本的 catalog 契约**：只能按现网 989 条 `subagent/catalog` 事件、158 组 `(name,label,mode)` 样本推断；无法验证下个宿主版本是否仍产该事件。
- **跨平台路径（Windows 盘符/反斜杠）的 slug 推导**：`workspaceSlugForCwd` 只在 macOS 路径上实测。

---

## 附录：实测命令与输出（可重跑）

### M1 变异检验①：把 VIOLATION 条件改成恒假 → **变红**
```bash
cd dsh-expert-team-kit
cp bin/dispatch-check.mjs /tmp/dc.backup.mjs
perl -0pi -e 's/  if \(!dispatched\) \{/  if (false \&\& !dispatched) {/' bin/dispatch-check.mjs
node --test test/dispatch-check.test.mjs        # → tests 37 / pass 28 / fail 9
cp /tmp/dc.backup.mjs bin/dispatch-check.mjs
shasum -a 256 bin/dispatch-check.mjs
```
变红的 9 条（均为 VIOLATION 相关）：
```
✖ VIOLATION：父会话 7 文件 10 次 edit、本轮完全没派活 → 退出码 2
✖ 判据不含 childEdits：子会话无日志时 VIOLATION 只由「派活四项全 0」触发
✖ 子 agent 会话：delegationDepth / origin 会进报告（判定仍按契约走，不受层级影响）
✖ 主会话（delegationDepth=0）的同一场景：结论与层级解耦，仍判 VIOLATION
✖ 坏 arguments 与正常调用混合：正常的照算，坏的跳过（不虚高 parentEdits）
✖ --session 支持 latest（取最近一次会话）
✖ --cwd 只在匹配的 workspace 里找会话（slug 掉开头斜杠的规则）
✖ 人类输出：违规时派活证据行全 0（一眼看出为什么判违规）
✖ zstd 会话日志（session.v4.jsonl.zstd）走 zstd -dc 解压路径
```
还原后：`3b582e59c99da83a601451fe10c7374b13a3b9a6ee63b1c93690405342aa2ffc`，`37/37 pass`。

### M2 变异检验②：把 `childEdits` 塞回 VIOLATION 条件 → **不变红（S6 的依据）**
```bash
perl -0pi -e 's/  if \(!dispatched\) \{/  if (!dispatched \&\& childEdits === 0) {/' bin/dispatch-check.mjs
node --test test/dispatch-check.test.mjs        # → tests 37 / pass 37 / fail 0  ← 回归未被拦住
```

### CASE 1 坏 `.zstd` + 完好 `session.jsonl` → 硬失败（S2）
```bash
printf 'not a zstd file at all' > "$D/session.v4.jsonl.zstd"   # 旁边有 7 次 edit 的 session.jsonl
node bin/dispatch-check.mjs --session "$D" --json
# → EXIT=1
# stderr: 解压失败：...不是可读的 zstd 文件（zstd 退出码 1：unsupported format）
#         确认文件没有损坏；损坏时用同目录的 session.jsonl 重试
```

### CASE 2 截断尾行（日志正在写入）→ 正常降级
```bash
# 3 条完整 edit + 1 条半截 '{"type":"tool/call","data":{"name":"edit","arguments":"{\"file_pa'
# → EXIT=2, parentEdits=3, fileCount=3
# warning: 主会话日志有 1 行不是合法 JSON，已跳过
```

### CASE 3 截断的 `.zstd`（压缩帧没写完）→ 硬失败 exit 1
```
zstd: ... /session.v4.jsonl.zstd : Read error (39) : premature end
EXIT=1
```
（现网缓解：1437 个真实 zstd 日志全部可完整解压，未观察到截断帧。）

### R1 过期 `.zstd` 压过更新的 `session.jsonl` → 静默错判（S3）
```bash
# .zstd = 1 次 edit（合法但旧）；session.jsonl = 7 次 edit（更新，mtime 2030 年）
node bin/dispatch-check.mjs --session "$D" --json
# → parentEdits=1 fileCount=1 verdict=PASS      （真实内容应为 VIOLATION）
```

### R2 坏 `arguments` 六连（真实 CLI 端到端）→ 全部降级、不崩
```json
{"name":"edit","arguments":"{坏"}
{"name":"edit","arguments":""}
{"name":"edit","arguments":"{\"old_string\":\"a\"}"}
{"name":"edit","arguments":{"file_path":"/p/obj.ts"}}     ← arguments 是对象而非字符串
{"name":"edit"}                                          ← arguments undefined
not json at all ###                                      ← 整行不是 JSON
```
```
parentEdits=0 fileCount=0 verdict=PASS   EXIT=0
! 主会话日志有 1 行不是合法 JSON，已跳过
! 主会话有一次 edit 调用无法解析（arguments 不是合法 JSON（Expected property name or '}' ...）），已跳过，不计入统计
! 主会话有一次 edit 调用无法解析（arguments 是空字符串），已跳过，不计入统计
! 主会话有一次 edit 调用无法解析（缺少 file_path），已跳过，不计入统计
! 主会话有一次 edit 调用无法解析（arguments 不是字符串（object）），已跳过，不计入统计
! 主会话有一次 edit 调用无法解析（arguments 不是字符串（undefined）），已跳过，不计入统计
```

### R3 真实日志口径校验
```bash
# (A) edit/write 的 arguments 形态
edit/write 调用总数: 9465 | arguments 是字符串: 9465 | 其它类型: [] | readEditTarget 成功: 9465 | 失败: 0
# (B) 派活证据来源（主会话、parentEdits>0、fileCount>=2，共 190 个；其中 50 个 VIOLATION、140 个 PASS）
PASS 140 个里：有 subagent 调用 20、有专家调用 126、有 catalog 140、有任务书 0
# (C) 铁证假阴性（S/B1）
子会话日志全在 且 子会话 edit 合计 0 且 主会话跨>=2文件自己改完 且 判 PASS → 64 个
```

### R4 判定按会话层级分布（全量 1249 个会话，含裸 uuid 目录）
```
depth=0 n=313 VIOLATION=50   PASS=263
depth=1 n=918 VIOLATION=164  PASS=754
depth=2 n=14  VIOLATION=0    PASS=14
depth=3 n=2   VIOLATION=0    PASS=2
depth=4 n=2   VIOLATION=0    PASS=2
```
注：`--session latest`/uuid 只能选中 `session-*` 形态（390 个），其中 depth>0 仅 1 个 —— 所以 depth=1 的 164 个 VIOLATION 在**默认调用路径下不可达**，S8 的风险按小暴露面计。
