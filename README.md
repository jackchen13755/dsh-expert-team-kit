# dsh-expert-team-kit

Agent Teams 任务书工具箱：**解析专家人格素材** + **生成带人格的任务书**。

这是「第 2 层：脚本」的核心库。目标是消灭每轮派活时的手工贴人格：给一个 slug 和一段任务描述，
直接产出一份能自解释、可验收、带写作用域与回报格式的任务书。

```js
import { resolvePersona } from './lib/persona.mjs'
import { buildBrief } from './lib/brief.mjs'

const persona = resolvePersona('code-reviewer')
const brief = buildBrief({
  persona,                     // 或只给 slug，内部会自己解析
  taskId: 'task-7',
  workerName: 'worker-lib',
  task: '实现 persona 解析与任务书生成',
  verify: 'node --test dsh-expert-team-kit/test/',
  scopes: ['dsh-expert-team-kit/lib/persona.mjs'],
})
```

## 分层

本包分四层，依赖方向单向向下（工具层与 CLI 层只依赖下面两层，下面两层不认识宿主）：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| L1 素材 | 本机 profile 下的专家插件 `assets/agency-agents/**/*.md` | 专家人格正文（frontmatter + Markdown），可用 `EXPERT_PERSONAS_ROOT` 换根 |
| L2 核心库 | `lib/persona.mjs`、`lib/brief.mjs` | 人格解析（slug → 人格正文）与任务书生成 |
| L3 工具层 | `lib/tool.mjs`、`lib/index.js` | `expert_brief` 工具规格（纯数据，不依赖宿主）+ 插件入口 `apply()` |
| L4 CLI | `bin/expert-brief.mjs` | 命令行：把一次派活写成一条命令，任务书打到 stdout |

`package.json` 的 `.` 入口就是 **L3 的 `lib/index.js`**（插件入口，`name` / `inject` / `apply`），
`bin` 字段把 L4 暴露成 `expert-brief` 命令。只想用某一层时，子路径入口 `./persona`、`./brief` 也在。

## 安装 / 依赖

零运行时依赖，只用 Node 内置模块（`node:fs` / `node:os` / `node:path`）。要求 Node >= 22（用 `node --test`）。

## API

### `personaRoot(overrides?) → string`

人格素材根目录，返回**绝对路径**。优先级：

1. `overrides.root`
2. 环境变量 `EXPERT_PERSONAS_ROOT`
3. 内置默认：`~/.dsh/profiles/desktop/node_modules/@jackchen13755/dsh-expert-agents/assets/agency-agents`

空串与纯空白视为「未提供」，继续看下一级（不会返回空路径）。值里支持 `~` 展开。

### 安全边界：人格文件必须落在素材根内

任务书的产物是**提示词**——人格正文会整段贴进任务书交给 worker。所以「能读到什么文件」就是一个安全边界，
不是排序细节。`resolvePersona` 用两层护栏，缺一不可：

1. **slug 段级校验**：绝对路径（`/etc/passwd`）与含 `..` 上级段的写法（`../x`、`x/../../outside/secret`）
   直接抛 `PERSONA_OUTSIDE_ROOT`，**不生成候选路径**（因此 `error.tried` 也不会带出根外路径）。
2. **真实路径包含性校验**：命中的候选文件先用 `fs.realpathSync` 解成真实路径，必须以「素材根真实路径 + 分隔符」
   为前缀。这一层挡的是**软链接逃逸**：根内一个指向根外的 `.md` 软链接，slug 本身完全干净，只有真 realpath 能拦。

关键点：挡住穿越的**不是**「文件不存在」。根外同名文件真实存在时也必须读不到——测试里专门造了这种文件来钉住。
前缀比较用「根 + 分隔符」而不是裸 `startsWith`，否则兄弟目录 `/x/root-evil` 会被当成 `/x/root` 的子路径。

### `resolvePersona(slug, options?) → { slug, path, name, description, body }`

三种 slug 写法都支持，且**解析到同一个文件**：

```js
resolvePersona('engineering-code-reviewer')  // 全名
resolvePersona('code-reviewer')              // 简名（跨 division 扫描）
resolvePersona('engineering/code-reviewer')  // division/简名
```

查找顺序：

1. 带 division 的写法先试 `<root>/<division>/<rest>.md`，再试 `<root>/<division>/<division>-<rest>.md`
   （素材有两种命名风格，两种都要吃得下）
2. 全名写法按**最长 division 前缀**拆分（`game-development-xxx` 这种 division 名本身含 `-` 也能拆对）
3. 兜底遍历所有 division，试 `<division>/<slug>.md` 与 `<division>/<division>-<slug>.md`

`name` / `description` 取自文件头部 frontmatter（`---` 包裹的 `name:` / `description:`）。
**不引入 yaml 依赖**，用正则解析，只支持单行标量（多行折叠、嵌套结构不解析）——人格素材的
`name` / `description` / `color` / `emoji` / `vibe` 都是单行，够用且启动不留负担。

`body` 是 frontmatter 之后的正文，已经：去掉首尾空白、把 CRLF 归一成 LF（行尾差异不算内容差异）。

frontmatter 必须紧贴文件开头（只容忍 BOM）。开头但**未闭合**的 `---` 与「根本没有 frontmatter」
是两种病：前者报「frontmatter 未闭合，请补闭合的 `---`」，后者才报「缺 name」——按错的 Fix 去补字段永远修不好。
`parsePersonaFile` 直接暴露 `unterminated` 字段，便于上层程序化判定。

宽容的输入变体：误带的 `.md` 后缀、`./` 前缀、首尾空白都会先规范化再解析。

### `PersonaError`

`resolvePersona` 的所有失败都抛 `PersonaError`（`extends Error`），带 `code` 与结构化上下文：

| `code` | 触发条件 | message 里给了什么 |
| --- | --- | --- |
| `PERSONA_INVALID_SLUG` | `undefined` / `null` / `''` / 纯空白 / 数字 / 布尔 / 对象 / 数组 / Symbol | 实际收到的值与类型 + 三种合法写法 |
| `PERSONA_ROOT_MISSING` | 素材根目录不存在或不可读 | 是哪个目录 + `EXPERT_PERSONAS_ROOT` / `{ root }` 两条修法 |
| `PERSONA_NOT_FOUND` | 所有候选路径都不存在 | **试过的每个路径**（超过 14 个时明确写「另有 N 个」）+ 最多 3 个相近建议 |
| `PERSONA_READ_FAILED` | 文件存在但读不出来 | 文件路径 + 底层原因 + 权限修法 |
| `PERSONA_OUTSIDE_ROOT` | slug 是绝对路径 / 含 `..` 段 / 候选的真实路径越出素材根（软链接逃逸） | 越界原因 + 素材根与真实路径 + 三条修法 |
| `PERSONA_INVALID_FORMAT` | 有文件但缺 frontmatter `name`，或 frontmatter **未闭合** | 文件路径 + 对应的一种模板（未闭合时直接说「补上闭合的 `---`」，不会误报成缺 name） |

附加字段：`error.tried`（完整候选路径）、`error.suggestions`（未知 slug 的建议，<= 3）、`error.root`。

建议分三档，前一档有命中就不往后走：① 前缀相近（互为前缀或公共前缀 >= 3 字符）
② 词元相近 ③ 都没有时给字母序前 3 个。**保证不为空**——「没有建议」本身也是一种不可操作的报错。

### `listPersonas(options?) → { slug, division, path, name, description }[]`

枚举所有可用人格（编程接口；错误提示里的候选也来自同一套逻辑）。

**返回的 `slug` 保证可以直接喂回 `resolvePersona` 并落到同一个文件**——这是本函数最容易被写歪的地方：
简名可能指偏（`specialized/prompt-engineer.md` 的简名 `prompt-engineer` 会先命中
`engineering/engineering-prompt-engineer.md`），所以无法用简名自证唯一时会自动退回 `division/base` 形式。

结构不合法的文件（缺 `name`、frontmatter 未闭合、读不出）**不会**混进可回解析的列表，
而是记在返回数组的 `.invalid` 属性上（不会静默丢弃）：

```js
const personas = listPersonas()
personas.length          // 可安全回解析的人格
personas.invalid         // [{ slug, division, path, reason, code }]
```

> 注：当前 CLI **没有** `--list` 选项（`expert-brief --help` 是唯一权威选项清单）。要列人格请用本函数。

### `buildBrief(input) → string`

`input` 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `task` | ✅ | 任务正文。缺失/空 → 抛 `Error`，message 点名 `task` |
| `verify` | ✅ | 验收命令。缺失/空 → 抛 `Error`，message 点名 `verify` |
| `persona` | 二选一 | `resolvePersona` 的返回值（对象，`body` 必须非空） |
| `slug` | 二选一 | 人格标识，内部调 `resolvePersona` |
| `scopes` | | 写作用域，字符串或字符串数组；未提供 / `[]` / `''` / 纯空白都渲染成「无」（数组里的空项仍然报错） |
| `taskId` | | 缺省 `（未指定 task id）` |
| `workerName` | | 缺省 `worker` |
| `reportLines` | | 数字（行数）或字符串数组（自定义行标签），缺省 4 行 |
| `root` | | 透传给 `resolvePersona` 的素材根目录（测试/多环境用） |

生成的任务书**依次**包含：

1. worker 名 + task id（第一行）
2. 「你的专家人格」：人格名、描述、来源路径
3. **人格正文整段**（原样，不截断、不改写）
4. 「人格裁剪」：保留方法论（DX 优先、错误信息可操作、边界输入全覆盖、接口即契约），
   忽略与本任务无关的技术栈偏好
5. 任务正文
6. 验收命令（bash 代码块 + 「不许跳过失败用例、不许放宽断言」）
7. 写作用域逐条列出（空数组写「无」）
8. 5 步流程：`team_task_get` 记 revision → `claim` → 干活 → 自跑验收 → `complete`
9. 回报格式：`严格 N 行` + 逐行标签（缺省 4 行：人格名 / 改动文件 / 退出码+pass-fail / status+revision）

`reportLines` 语义：

- 未提供 / `[]` / `''` / 纯空白 → 缺省 4 行
- 数字 N → 取缺省前 N 行；N > 4 时补「补充说明」行
- 字符串数组 → 原样作为行标签
- 其它 / 非正整数 / 数组里混空串 → 抛 `Error`（`code: BRIEF_INVALID_REPORT_LINES`）

生成内容的结构安全（否则会产出一份「看起来正常但结构错了」的任务书）：

- **围栏自动加长**：`verify` 里若出现三反引号（多行脚本、`node -e '...'` 很常见），
  验收代码块的围栏会自动升级到「内容里最长反引号串 + 1」，内容不会被挤到围栏外。命令内容一个字不改。
- **注入转义**：`taskId` 会同时出现在散文与生成的 `team_task_update({task_id:"…"})` 片段里，
  后者做双引号/反斜杠/换行转义，`workerName` 压成单行——否则 id 里一个引号就能把指令片段截断。

校验顺序固定为 **task → verify → persona → scopes → reportLines**：
最常见的错误（忘了写验收命令）最先报，不会先白读一遍文件系统。

## 第 3 层：工具（`expert_brief`）

`lib/tool.mjs` 导出 `TOOL_NAME = 'expert_brief'` 的工具规格（纯数据，不 import 宿主），
`lib/index.js` 是插件入口（`name` / `inject: ['tools']` / `apply(ctx)`）。工具层在**边界**上把入参校验一次，
报错点名参数（`param`），不让它下沉成 brief 的「缺 task」或 persona 的路径报错。

参数（与 CLI 选项同名，snake_case）：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `expert` | ✅ | 专家 slug，三种写法均可 |
| `task` | ✅ | 任务内容与边界输入 |
| `verify` | ✅ | 验收命令 |
| `scopes` | | 允许修改的文件前缀，数组，可多条 |
| `task_id` | | 任务板 id，任务书流程与回报第 4 行会引用 |
| `worker` | | 队友名，默认 `worker` |

> 具体错误码（`TOOL_*`）与 `parameters` 的完整 schema 以 `lib/tool.mjs` 为准，本 README 不复制一份会漂移的副本。

## 第 4 层：CLI（`expert-brief`）

```bash
expert-brief --expert code-reviewer \
  --task "审查 lib/tool.mjs" \
  --verify "node --test dsh-expert-team-kit/test/" \
  --scope dsh-expert-team-kit/lib/tool.mjs \
  --task-id task-8 --worker worker-tool
# 等价（需要从文件读任务）：--task-file ./task.md
```

- 成功：任务书打到 **stdout**（以换行结尾，可直接重定向），退出码 **0**。
- 失败：原因打到 **stderr**（含底层 `error.code` 与 `Fix:`），退出码 **1**。
- `--task` 与 `--task-file` 二选一，同给报错。
- `--help` / `-h` 优先于其它选项（即使别的参数有错也只打印用法，退出 0）。
- 选项清单以 `expert-brief --help` 为准。

## 改动归属自检（`dispatch-check`）

与上面四层**互相独立**的一个诊断 CLI：读 DSH 会话日志，回答「本轮的 `edit`/`write` 到底是谁执行的」。

要解决的失效形态是**假合规**：主 agent 叫了专家做评审，代码实现却仍自己干完。
交付说明里只写「用了哪些专家」看不出这一层，只能从会话日志的事实事后核对。

所以判据的锚点是「**有没有派过实现队友**」，而不是「有没有叫过人」：

- `summon_expert` / `summon_experts` / `summon_expert_team` 是**一次性咨询**，不写代码；
- `expert_brief` 是**纯函数**（只生成任务书文本，不写盘）；
- `subagent/catalog` 只是「子会话登记」，而且**包含咨询专家** —— 实测 `summon_expert` 起的
  `agent-*` 与 `subagent` 起的 `worker-*` 在 catalog 里**全是 `mode: "continuable"`**，该字段
  区分不了咨询与实现（日志里另有 `mode: "normal" / "workspace-write" / …`，那是**沙箱模式**，
  与子会话无关）。

这三项一律只当**咨询证据**：照常计数、进文案，但**不构成豁免**。把它们算进放行条件，「叫了专家
评审、实现自己全干完」就会判 PASS —— 那正是本工具要抓的形态。

```bash
dispatch-check                                  # 最近一次会话
dispatch-check --session <uuid>                 # 指定会话（支持 uuid 前缀）
dispatch-check --session <会话目录> --json      # 直接给目录，输出 JSON
dispatch-check --cwd /path/to/project           # 只在这个 workspace 里找
```

统计口径：

| 字段 | 含义 |
| --- | --- |
| `files` | 父会话 + 所有子会话里 `edit`/`write` 涉及的 `file_path` 去重集合 |
| `parentEdits` | 父会话中 `edit` + `write` 的次数 |
| `childEdits` | 所有子会话中 `edit` + `write` 的次数之和（**只作归因参考，不参与判定**） |
| `dispatch.subagents` | 父会话中 `subagent` + `subagent_fork` 的次数 —— **唯一有资格当「派过实现」的证据** |
| `dispatch.expertCalls` | 父会话中 `summon_expert` / `summon_experts` / `summon_expert_team` 的次数 —— **咨询证据**，不构成豁免 |
| `dispatch.briefs` | 父会话中 `expert_brief`（任务书）的次数 —— **咨询证据**（纯函数），不构成豁免 |
| `dispatch.catalog` | 父会话中 `subagent/catalog`（子会话登记）事件数 —— 仅展示；**含咨询专家**，不构成豁免 |
| `attribution` | `{childLogsFound, childLogsMissing, confidence}`：子会话日志找到几个、缺几个、归因精度 |
| `experts` / `subagents` | 旧字段（分别是专家调用数与子会话登记数），新代码请读 `dispatch.*` |

判定（从上到下，命中即停）：

- **PASS**：① `parentEdits === 0`（主会话没改）；② `files.length <= 1`（单文件豁免）；
  ③ 跨多个文件且主会话改过，但 `dispatch.subagents > 0`（**真派过实现队友**）。
- **VIOLATION**：跨 `>= 2` 个文件的主会话改动 `> 0` 次，且 `dispatch.subagents === 0`。
  文案分两种情况，读者一眼能分清：
  - 只叫过咨询（`expertCalls + briefs + catalog > 0`）→
    「本轮只叫了 K 次专家/生成 J 份任务书，但没有任何实现队友（subagent 0 次）——『叫了评审，实现仍自己干』」；
  - 一项都没有 → 「本轮没有任何派活记录」。
- 其余情况（理论到不了）：PASS + warning。

> **VIOLATION 条件只依赖 `dispatch.subagents` 一个计数。** `childEdits` / `expertCalls` / `briefs` /
> `catalog` 都不得出现在放行条件里：前者日志大多不落盘（拿它否决会误杀真交付），后三者是
> **咨询证据**（拿它放行会让「叫了专家评审、实现自己全干完」蒙混过关）。

> 判定针对**主会话**。会话本身是子 agent 会话时（`session.delegationDepth > 0`，如直接
> `--session <某个 session-* 子会话目录>`），报告里会标出 `delegationDepth` / `origin`，此时
> 结论只作归因参考 —— 子 agent 自己改代码正是本职。

> **`childEdits` 没有否决权，也没有豁免权。** 实测子会话日志大多不落盘（某机器上派了 12 个子
> agent、磁盘只有 1 个子会话目录；另一个会话派了 2 个、0 个落盘），拿它当否决判据会把「723 行
> 代码确实由子 agent 写」误判成「子 agent 改 0 次」。所以判据换成**父日志里必然存在的实现队友
> 计数**（`dispatch.subagents`）；子会话日志缺失只降 `attribution.confidence`（`high` / `low`），
> 不改变 verdict。

`attribution.confidence` 的取值：

- `high`：子会话日志全找到；或本轮压根没起子会话（没有需要归因的东西）。
- `low`：有 `subagent/catalog` 登记但日志缺失，或调过 `subagent` 却没有 catalog 登记 ——
  此时 `childEdits` 只可能偏小，warnings 会写明「派过活但子会话日志不可用，无法核实执行占比」。

退出码即契约，CI 只看它：`0` = PASS、`2` = 违规、`1` = 出错（找不到会话 / 参数错 / 日志不可读）。
`--help` 打印用法并退出 `0`；`--json` 只输出一份 JSON（带 `verdict` / `files` / `parentEdits` /
`childEdits` / `dispatch` / `attribution` / `warnings` 等字段）。人类输出把计数**分成两行**
（判定只看第一行，第二行全是咨询证据，混成一行会让人误以为叫专家也算派活）：

```text
实现队友  subagent N
咨询证据  专家 M / 任务书 K / 子会话登记 J
```

随后是一行 `归因精度`（`high` / `low`）与子会话明细。

两个实现事实值得知道：

- **子会话要单独读，且目录名有两种形态**：父日志里只有 `subagent/catalog`（登记 `childId`），
  子 agent 的 `tool/call` 记在**同 workspace** 下的兄弟目录：老布局 `session-<childId>`、
  新布局直接是 `<childId>`（实测父会话是 `session-*`、子会话是裸 uuid）。两种都找不到才算
  「日志缺失」。漏读它就等于「队友改了也是 0 次」。
- **两种日志格式都吃**：真实日志是 `session.v4.jsonl.zstd`，用 `zstd -dc` 子进程解压（需要本机有
  `zstd`）；没有压缩文件时读普通 `session.jsonl`。后者是测试与二次分发用的路径，所以测试不依赖真机数据。
- `tool/call` 的 `arguments` 是**字符串**，要二次 `JSON.parse`；坏 JSON / 空串 / 缺 `file_path`
  一律跳过并写进 `warnings`，不让一次坏事件把整份报告打成异常。
- 会话根可用 `DSH_SESSIONS_DIR` 覆盖（缺省 `~/.dsh/sessions`），测试与多 `DSH_HOME` 场景用。

## 错误处理约定

- 人格问题一律 `PersonaError`（`code` 可分支），任务书参数问题抛 `Error`（同样带 `code`，
  `BRIEF_MISSING_FIELD` / `BRIEF_NO_PERSONA` / `BRIEF_INVALID_PERSONA` / `BRIEF_INVALID_SCOPES` /
  `BRIEF_INVALID_REPORT_LINES`）。
- 所有错误 message 都带 `Fix:` 段：说清原因 + 下一步怎么做，绝不让调用方拿到 `undefined` 再崩在
  `undefined.xxx`。

## 测试

```bash
node --test dsh-expert-team-kit/test/
```

覆盖的边界：三种 slug 同文件、未知 slug 带建议、`undefined`/`null`/`''`/纯空白/`123`/对象/数组/Symbol、
根目录缺失、缺 frontmatter、缺 `name`、CRLF 与引号、BOM、`~` 展开、环境变量与 overrides 的优先级、
`.md` 后缀与 `./` 前缀、`task`/`verify` 缺失、空 `scopes`、自定义 `reportLines`、
人格正文整段与章节顺序、纯函数稳定性。

安全与回归专项：

- **路径穿越**：11 种穿越写法（`x/../../outside/secret`、`../x`、`/etc/passwd`、绝对路径…）全部 `PERSONA_OUTSIDE_ROOT`，
  且根外目标文件在磁盘上**真实存在**（否则「挡住了」可能只是因为文件不存在）。
- **软链接逃逸**：根内 `demo/evil.md -> 根外/secret.md`，slug 完全干净，靠 `realpathSync` 包含性校验拦下。
- **可红性**：把包含性校验注释掉，上面两条用例必须变红；还原后回绿。这是这套测试的验收方式本身
  （「补上校验也全绿、去掉校验也全绿」等于没测）。
- `error.tried` 用 `.every` 断言全部落在根内（历史上这里写成 `.some`，恒真）。
- 未闭合 frontmatter 报「未闭合」而非「缺 name」；`listPersonas` 的每一项都能回解析到同一文件。

## 隐私

本仓库不含任何内部项目名、内网地址或凭据。人格素材来自本机 profile 下的公开专家插件，
默认路径可用 `EXPERT_PERSONAS_ROOT` 覆盖，代码里没有任何硬编码的密钥或私有路径。
