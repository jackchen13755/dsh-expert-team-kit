# dsh-expert-team-kit 独立代码审查（task-9 / L3 复核）

- **审查人**：worker-review
- **专家人格**：**Code Reviewer**（`~/.dsh/profiles/desktop/node_modules/@jackchen13755/dsh-expert-agents/assets/agency-agents/engineering/engineering-code-reviewer.md`，frontmatter `name: Code Reviewer`）——按其 Critical Rules 执行：逐条给位置与级别、只审不改、解释 why、不纠结风格。
- **审查对象**：`lib/persona.mjs`(552) / `lib/brief.mjs`(357) / `lib/tool.mjs`(347) / `lib/index.js`(55) / `bin/expert-brief.mjs`(265) / `test/*.test.mjs`(1213) / `package.json` / `README.md`
- **执行环境**：macOS，Node **v26.8.2**（`engines` 声明 `>=22`）
- **基线**：`node --test test/` → **57 tests / 57 pass / 0 fail**
- **本文件是唯一写入**：被测文件全部零修改，变异检验已逐一还原并逐字节校验（见 §3）

## 结论摘要

整体工程质量明显高于同类小库：错误带 `code`、报错带 `Fix:`、校验顺序固定、依赖方向有测试守着，边界输入矩阵（`undefined`/`null`/`''`/`123`/对象/数组/Symbol/BigInt）**全部**落到 `PersonaError` 而不是 `undefined.xxx`，这一点我逐项实测通过。

但有 **1 个真漏洞 + 1 个共犯**：**路径穿越没有被挡住**，能把素材根目录之外的任意 `.md` 文件当成"专家人格"整段贴进任务书（也就是贴进一个会被喂给 LLM worker 的 prompt）。而且**测试套件一条用例都锁不住这条防线**——我补上防护后 57/57 依然全绿。主会话"抽测过 5 种路径穿越写法均抛 `PERSONA_NOT_FOUND`"这个结论**在特定输入下不成立**：它只对"根目录外没有同名 `.md`"的输入成立，防御来自"文件不存在"，不是来自"路径必须在根内"。

其余 8 条 🟡 集中在 tool 边界错误码一致性、`listPersonas` 与 `resolvePersona` 契约不一致、`--list` 文档造假、`bin` 字段缺失、围栏未转义。

---

## 1. 问题清单

### 🔴 B1 路径穿越未被拦截：可读取素材根目录之外的任意 `.md`，并整段进入任务书

- **位置**：`lib/persona.mjs:399-404`（`normalizeSlug` 只处理 `./` 前缀与 `.md` 后缀，**不拒 `..`**）→ `lib/persona.mjs:209,214-215,227-228,234-235,243-244`（`path.join(root, division, `${rest}.md`)` 会**归一化掉 `..`**）
- **期望**：slug 解析结果必须落在素材根目录内；越界一律拒绝（`PERSONA_NOT_FOUND` 或专用码），`error.tried` 也不该出现根外路径。
- **实际**：`path.join` 把 `..` 吃掉，没有任何 `path.resolve(candidate).startsWith(root + sep)` 形式的包含性校验。
- **实测**（`/tmp/probe-traversal.mjs`，造 `base/root/demo/alpha.md` + `base/outside/secret.md`，后者在 root **之外**）：

  ```
  BLOCKED       slug="../../outside/secret"      code=PERSONA_NOT_FOUND
  READ-OUTSIDE  slug="x/../../outside/secret"    name="SECRET-OUTSIDE-ROOT"
                path=.../outside/secret.md   在 root 内？ false   正文含泄漏标记？ true
  READ-OUTSIDE  slug="../outside/secret"         （同上，读到根外文件）
  READ-OUTSIDE  slug="../outside/secret.md"      （同上）
  READ-OUTSIDE  slug="./../outside/secret"       （同上）
  对照          slug="../../etc/passwd"          -> PERSONA_NOT_FOUND
  对照          slug="a/../../../b"              -> PERSONA_NOT_FOUND
  ```

  5 种穿越写法里 **4 种成功越界**；被"挡住"的两种恰恰是因为目标文件不存在（`../../etc/passwd` 无 `.md` 后缀），不是因为有校验。这正是"抽测 5 种写法均 `PERSONA_NOT_FOUND`"看起来安全的原因。
- **经 tool 边界同样成立**（`/tmp/probe-toolroot.mjs`，正确用法 `executeExpertBrief(args, { root })`）：

  ```
  任务书是否含外部文件正文 SECRET_TOKEN_MARKER：true
  人格名：PWNED
  人格来源：/var/folders/z6/.../tr2-MeYv5d/outside/secret.md
  ```
- **为什么是 blocker**：本库的产物是**提示词**。人格正文会被整段贴进任务书交给 worker，等于把磁盘上任意 `.md` 的内容提升为模型的"专业身份"指令——既是信息泄漏（读得到的东西就能回显到 prompt），也是 prompt 注入面。同一条缺陷还会让 `error.tried` 把根外路径写进错误文本。
- **修复建议**（落点已实测有效，见 §3 变异 M3）：在 `persona.mjs:444` 收窄候选集再 `find`：
  ```js
  const inRoot = (c) => c === root || c.startsWith(root + path.sep)
  const found = tried.filter(inRoot).find(isFile)
  ```
  或在 `normalizeSlug` 里显式拒绝含 `..` 的路径段（两者可同时做；`filter` 版还能顺带保证 `error.tried` 不泄根外路径）。

### 🔴 B2 测试没锁住 B1 这条防线，且现有断言与自身措辞相反（恒真）

- **位置**：`test/persona.test.mjs:190-193`
  ```js
  assert.ok(
    error.tried.some((candidate) => candidate.startsWith(error.root)),
    '所有尝试路径都应落在素材根目录下',
  )
  ```
- **期望**：断言应真的检查"所有"候选路径在根内（`.every`），或补一条穿越用例。
- **实际**：只检查 `.some`（存在一条即通过），**message 声明的"所有"没有对应的检查**。实测一个穿越 slug：
  ```
  tried 共 4 条，其中 2 条在 root 之外：
    .../outside/nonexistent.md
    .../..-outside/nonexistent.md
  断言实际只检查 .some(...)：true
  用 .every(...) 检查会得到：false      ← 断言要保护的不变量已经破了，测试却是绿的
  ```
- **为什么按 blocker 记**：任务书明确要求——"把关键防护改坏后测试仍然全绿，本身就是 blocker（测试没锁住关键防线）"。§3 的 **M3** 用同一现象反向复现：我把**缺失的**根内校验补上，57 个用例**一个都没变红**（57/57 pass），说明整套测试对"路径必须在根内"零覆盖。**补上防护不会破坏任何现有用例，去掉它也不会被抓到** —— 这条防线目前完全裸露。

### 🟡 S1 tool 边界把"规范化后为空"的 expert 漏成 `PersonaError`，错误不带参数名、错误码不在 `TOOL_ERROR_CODES` 内

- **位置**：`lib/tool.mjs:261-265`（`requireText` 只判非空字符串）→ `lib/persona.mjs:429-439`（`normalizeSlug` 之后才判空）
- **期望**：`tool.mjs` 文件头自述"参数的类型/必填/取值范围在**工具边界**校验一次，报错点名参数"；这类入参错误应抛 `ToolSpecError`（`param: 'expert'`，码落在 `TOOL_MISSING_PARAM`/`TOOL_INVALID_PARAM`）。
- **实际**：原始 `PersonaError` 直接穿透，`param` 为 `undefined`，`code` 为 `PERSONA_INVALID_SLUG`——调用方若按 `TOOL_*` 码分支会漏掉这一类。
- **实测**：`expert` 传 `.md` / `/` / `///` / `./` / `\` 五种写法，全部
  ```
  THROW executeExpertBrief(expert=".md") -> name=PersonaError code=PERSONA_INVALID_SLUG param=- | "slug 规范化后为空：字符串 \".md\""
  ```
  现有用例只覆盖 `undefined/''/'   '/null`（`test/tool.test.mjs:234`）与"未知 slug"，没有覆盖"非空但规范化后为空"。
- **建议**：`resolveExpert` 的 `catch` 里把 `PERSONA_INVALID_SLUG` 一并翻译成 `ToolSpecError(param: 'expert')`（目前只翻译 `NOT_FOUND`，`tool.mjs:218`），或在 `requireText` 之后补一步"规范化后非空"的边界校验。

### 🟡 S2 `listPersonas` 与 `resolvePersona` 契约不一致：列出来的 slug 可能解析失败

- **位置**：`lib/persona.mjs:537-546`（`listPersonas` 对缺 `name` 的文件不报错，返回 `name: ''`）vs `lib/persona.mjs:495-509`（`resolvePersona` 抛 `INVALID_FORMAT`）；承诺见 `README.md:92`「返回的 `slug` 可以直接喂回 `resolvePersona`」
- **实测**（临时根放 `nameless.md`：有 frontmatter 但无 name、`unclosed.md`：frontmatter 未闭合）：
  ```
  listPersonas -> nameless:name="" | unclosed:name=""
  resolvePersona(nameless) -> THROW PersonaError PERSONA_INVALID_FORMAT
  listPersonas 是否抛错: 否（resolvePersona 会抛 INVALID_FORMAT）
  ```
- **建议**：二选一——`listPersonas` 跳过（或标记 `invalid: true`）无 `name` 的文件，或 README 把承诺收窄为"仅对素材完整的人格保证可回解析"。当前实现对"枚举→回代"这种最常见的用法会在运行期炸，且 `test/persona.test.mjs:314-317`「每个人格都必须有 name」只在真实素材树上成立，掩盖了这个不一致。

### 🟡 S3 验收命令含三反引号时，任务书的 ```bash 围栏被破坏

- **位置**：`lib/brief.mjs:318-321`（`lines.push(`${fence}bash`); lines.push(verify); lines.push(fence)`，对 `verify` 内容零转义）
- **实测**（`verify: 'node --test\n```\necho 逃逸'`）：
  ```
  "## 3. 验收命令（必须自己跑一遍）\n\n```bash\nnode --test\n```\necho 逃逸\n```\n\n期望：退出码 0…"
  ```
  `echo 逃逸` 落在围栏之外，第 3 节的结构被破坏。
- **为什么值得修**：验收命令经常是多行脚本（heredoc、`node -e '...'`）；一旦包含围栏符号，生成的任务书会静默变成一份"结构错乱但看起来正常"的文档——这与 `bin/expert-brief.mjs` 文件头「歧义即失败，不猜调用方意图」的取向相反。建议把内容里的 ``` 替换成等价的转义写法（或改用 `~~~` 围栏，若包含则退化为 4 个反引号）。

### 🟡 S4 未知参数被静默忽略（与本模块自己给出的理由矛盾）

- **位置**：`lib/tool.mjs:255-285`（`executeExpertBrief` 只读白名单键，不解 `Object.keys(args)` 也不校验多余键）
- **对照**：`lib/tool.mjs:116-118` 的注释明确写「静默忽略会让调用方以为参数生效了」——但这条原则只用在"可选参数给了非字符串"上，**多余/拼错的键完全静默**。
- **实测**（我在探针里自己就踩了）：
  ```
  C2. root 误放进 args（第一个参数）会被静默忽略
    人格来源：<personas-root>/agency-agents/engineering/engineering-code-reviewer.md
    是否用了传入的 root(.../root)：false        ← 参数被丢弃，调用成功
  C3. 传入拼错参数 tavk，调用成功：true          ← 拼错键无任何提示
  ```
- **建议**：对未知键报 `TOOL_INVALID_PARAM`（或在 `parameters` 里给出 `additionalProperties: false` 语义）。至少不要让 `root` 这个"其它入口是真参数"的键被无声吞掉。

### 🟡 S5 `package.json` 没有 `bin` 字段：CLI 装上后不可用

- **位置**：`package.json:6-13`（只有 `main`/`exports`；`files` 收了 `bin`，但没有 `"bin"` 映射）
- **实测**：`node -e 'console.log(require("./package.json").bin)'` → `undefined`；而 `node bin/expert-brief.mjs …` 可正常跑（文件有 shebang，`package.json:14-18` 的 `files` 也带上了它）。
- **影响**：`npx dsh-expert-team-kit` / `npm i -g` 后都拿不到 `expert-brief` 命令；`bin/` 只是被"打包"了但不能被执行。建议补：
  ```json
  "bin": { "expert-brief": "./bin/expert-brief.mjs" }
  ```

### 🟡 S6 README 与实现不符，且完全没覆盖第 3 层

- **位置**：`README.md:92`、`README.md:30`、以及全文缺章节
- **实测**：`--list` 并不存在——
  ```
  --- --list ---
  exit=1 stdout_len=0 stderr=未知选项：--list 可用选项：--expert / --task / --task-file / --verify / --scope / --task-id / --worker / --help
  ```
  而 `README.md:92` 写「枚举所有可用人格（供 CLI 的 `--list` 与错误提示复用）」。
- **另**：`README.md:30`「`package.json` 的 `.` 入口（`lib/index.js`）与 `bin/` 由 CLI 层实现，不在本目录的两个模块里」已过期——`lib/index.js` 就在 `lib/` 下，且是本包的实际入口。`grep -nE 'expert_brief|buildToolSpec|executeExpertBrief|--expert|bin/expert-brief|apply\(|--list|index\.js|tool\.mjs' README.md` **只命中 30、92 两行**：`lib/tool.mjs`、`lib/index.js`、`expert_brief` 工具、CLI 用法、`inject`/`apply` 约定全部无文档。
- **建议**：要么补第 3 层章节（工具名/6 个参数/CLI 选项与退出码/`apply` 契约），要么把 README 标题的"两个模块"改成完整的四层说明；`--list` 实现或从 README 删掉。

### 🟡 S7 frontmatter 未闭合时报"缺少 name"，误导排查方向

- **位置**：`lib/persona.mjs:360-392`（`parsePersonaFile` 只回 `hasFrontmatter` 布尔，不区分"没有"与"未闭合"）→ `lib/persona.mjs:495-509`
- **实测**：`unclosed.md` 内容为 `---\nname: X\ndescription: y\n\n# Body\n`（缺闭合 `---`）→
  ```
  THROW resolvePersona(unclosed) -> PersonaError PERSONA_INVALID_FORMAT
  错误首行: 专家人格文件缺少 frontmatter 的 name 字段：/var/.../demo/unclosed.md
  ```
  文件明明有 `name: X`，报错却说"缺 name，请在文件头部补上 frontmatter 模板"——按这个 Fix 照做不会修好（真问题是补一个 `---`）。
- **建议**：`parsePersonaFile` 区分两种情形（例如原文以 `---` 开头但无闭合 → 抛 / 附加 `unterminated: true`），让 message 直接说"frontmatter 未闭合"。

### 🟡 S8 测试覆盖缺口（B1 之外）

- **位置**：`test/persona.test.mjs`、`test/brief.test.mjs`
- **实测依据**（§3 变异 M4）：去掉 `persona.mjs:361` 的 `.replace(/^\uFEFF/, '')` 后 **57/57 仍全绿**，说明 BOM 输入零覆盖（变异下 `\uFEFF---\nname: …` → `hasFrontmatter=false / name=undefined`）。
- 同样未被锁住的还有：`hasFrontmatter=false` 分支的返回值（`parsePersonaFile` 直接调用）、`MAX_TRIED_IN_MESSAGE` 截断后的 `… 另有 N 个候选路径` 分支（`persona.mjs:460`）、`suggestSlugs` 的第三档兜底（`persona.mjs:348`，`knownSlugs.slice(0,3)`）、"首行前有空行 + `---`"（实测 `hasFrontmatter=false`，frontmatter 被当成正文）。
- **建议**：至少补一条 `..` 穿越用例（见 B2）+ 一条 BOM 用例；这两个是"造一条就红"的最小集合。

### 💭 N1 `test/persona.test.mjs:134-135` 同一断言重复两遍

```js
assert.ok(!persona.name.includes(':'), `name 不能把 frontmatter 的 key 泄漏进来：${persona.name}`)
assert.ok(!persona.name.includes(':'), 'name 不应包含冒号')
```
完全相同的检查写了两次，第二条无增量信息（像是复制粘贴残留）。

### 💭 N2 `!text.includes('undefined')` 会误报合法的任务文本

- **位置**：`test/tool.test.mjs:174`（与 `test/brief.test.mjs:293` 同类）
- **实测**：`task: '检查 undefined 与 null 的处理'` → 任务书里当然含 `undefined`。该断言真正想验的是"缺省值没被渲染成 `undefined` 字样"，但实现成了全局子串禁令，一旦任务的正文提到 `undefined` 就会假失败。
- **建议**：收窄到 `（未指定 task id）`/`worker` 那几行做断言，或断言 `!text.includes('人格名：undefined')` 之类的具体位置。

### 💭 N3 `--help` 不短路，与 USAGE 措辞不一致

- **位置**：`bin/expert-brief.mjs:84-157`（`parseArgv` 边解析边抛）、`bin/expert-brief.mjs:39-40`（USAGE 写「`-h, --help` 打印本用法并退出」）
- **实测**：`--help --nope` → exit 1（`未知选项：--nope`）；`--help --task`（缺值）→ exit 1。而 `--help --expert code-reviewer` → exit 0。
- 文件头把"歧义即失败"作为设计取向，所以这可能是有意的；但 USAGE 的"打印本用法并退出"读起来是无条件退出。建议统一措辞（改成"仅在没有其它错误时打印用法并退出"）或在解析前先扫一遍 `--help`。

### 💭 N4 `taskId` / `workerName` 未经转义直接插进指令行

- **位置**：`lib/brief.mjs:280`、`lib/brief.mjs:343-347`（`team_task_get({task_id:"${taskId}"})` 等）
- **实际**：`taskId` 含 `"` 或换行会破坏生成的 JS 片段结构；`workerName` 含换行会打断"你是 …"那一行。
- **说明**：这两个字段来自调用方（主会话），不属于不可信输入，因此我只记 nit；但既然 `verify` 的围栏问题（S3）值得修，这里同一类问题顺手处理成本很低。

### 💭 N5 同一份"空 scopes"在两个层的报错口径不同

- **位置**：`lib/brief.mjs:98-124` vs `lib/tool.mjs:150-153`
- **实测**：`buildBrief({ scopes: '' })` → `BRIEF_INVALID_SCOPES` + `scopes[0]`；`executeExpertBrief({ scopes: '' })` → `TOOL_MISSING_PARAM` + `param: 'scopes'`。
- 同一输入两套名字/两套码，调用方无法用同一段逻辑处理。建议两边统一成"空串视同未提供"（`brief.mjs:101` 的 `['']` 包装是多余的一跳）。

---

## 2. 已核对且**没有**问题的项（附实测证据，按任务书 8 个重点项）

| 重点项 | 结论 | 证据 |
|---|---|---|
| 1. `resolvePersona` 边界输入 | ✅ 全部落 `PersonaError`，无一处 `TypeError` | `undefined/null/''/'   '/123/{toString(){}}/Symbol/[]/true/10n/函数` 11 种输入逐一实测，全部 `PersonaError PERSONA_INVALID_SLUG`，message 含实际值+类型+三种合法写法+`Fix:`；`{toString(){}}` 得到 `[object Object]` 未触发自定义 `toString` 崩溃 |
| 1'. 错误信息有"试过哪些路径"与建议 | ✅ | `PERSONA_NOT_FOUND` 的 message 列出候选路径（>14 条时给"… 另有 N 个候选路径，见 error.tried"），并给 ≤3 条建议；`error.tried/suggestions/root` 字段齐全 |
| 3. frontmatter 解析（除 S7 外） | ✅ | `description` 含冒号**不截断**（`"Reviewer: reviews code, like a mentor"` 完整保留）；正文含 `---` 分隔线时 body 正确保留为 `"上段\n\n---\n\n下段"`；`name:` 空 / `name:    ` 均抛 `INVALID_FORMAT`；无 frontmatter → `hasFrontmatter=false`（解析层不抛，由 `resolvePersona` 抛）；CRLF、引号、`color: #4F46E5` 均正确 |
| 4. `buildBrief` 字段缺失/类型 | ✅（除 N5） | `task`/`verify` 为 `''`、`'  '`、`null`、`123` 全部抛 `BRIEF_MISSING_FIELD` 并点名字段；`scopes` 传 `123`/`Set`/`['  ']` 抛 `BRIEF_INVALID_SCOPES`；`reportLines` 传 `0/-3/1.5/NaN` 全部抛 `BRIEF_INVALID_REPORT_LINES`（**不会产生空回报格式**，这是变异 M2 的对照组）；`reportLines: []` → 缺省 4 行；`buildBrief()`/`null`/`'str'`/`[]` 均安全抛错 |
| 5. tool spec 契约 | ✅（除 S1/S4） | 二次调用**逐字节相同**（`r1.text === r2.text` 为 `true`）；不修改入参对象（调用前后 `JSON.stringify(args)` 不变）；返回严格 `{ content:[{type:'text',text}] }`，`Object.keys(result) === ['content']`；`buildToolSpec()` 每次返回新对象且 `parameters` 不共享；`name` 恒为 `expert_brief` |
| 6. CLI 组合与退出码 | ✅（除 N3/S6） | `--task`+`--task-file` 同给 → exit 1、stdout 空、stderr 点名两者；都不给 → exit 1 且列 `--task 或 --task-file`；文件不存在 → `ENOENT` + Fix；**目录** → `EISDIR` 被兜住；`/dev/null` → `CLI_TASK_FILE_EMPTY`；`--scope a/b --scope c/d` 逐条生效；`--scope=a/b` 生效；`--scope ""` → exit 1 点名 `scopes[0]`；位置参数 → exit 1 点名"位置参数"；未知选项 → exit 1 点名选项。成功路径 stdout 只有任务书、stderr 为空、退出码 0 |
| 7. 插件入口 | ✅ | `lib/index.js` 无任何 `@deepseek-ai/*` / `cordis` 依赖（测试用正则守着，我也独立读源码确认）；`apply` 在 `ctx`/`ctx.tools`/`ctx.tools.register` 缺失或非函数时**抛可读错误而非静默跳过**（`lib/index.js:42-52`），`undefined/null/{}/{tools:{}}/{tools:{register:'nope'}}` 全部落到同一错误信息 |

**另外确认无误**：`bin/expert-brief.mjs` 的 `--task-file` 读文件失败与空文件分两个码、错误带底层 `error.code`；CLI 成功时 `stdout` 以 `\n` 结尾（可直接重定向）；5 步流程与回报格式的渲染与 `reportLines` 语义一致（`reportLines: 6` 实测输出 4 行缺省 + 2 行"补充说明"）。

## 3. 变异检验结果（含还原验证方式）

**方法**：`cp` 全量备份到 `/tmp/kit-backup/` 并记录 `shasum -a 256` 基线 → 用脚本做**恰好命中 1 次**的字符串替换（命中数 ≠ 1 直接中止）→ `node --test test/` → `cp` 还原 → 与基线 shasum 逐文件 `diff` → 关键行 `grep` 复核 → 再跑一次全量测试。

### M1 — 删掉 slug 校验（让 `PersonaError` 退化为崩溃）：**变红 ✅**

- 改动：`lib/persona.mjs:415` `if (!isNonEmptyString(slug)) {` → `if (false) {`
- 结果：`tests 57 / pass 56 / fail 1`
  ```
  ✖ resolvePersona: 非字符串 / 空串 / 空白 / 非法类型一律抛 PersonaError
  ℹ tests 57  ℹ pass 56  ℹ fail 1
  ```
- 结论：重点项 1 的守卫**被有效锁定**。

### M2 — 删掉 `reportLines >= 1` 守卫：**变红 ✅**

- 改动：`lib/brief.mjs:142` 去掉 `|| reportLines < 1`
- 结果：`tests 57 / pass 56 / fail 1`，红的是 `buildBrief: reportLines / scopes 非法输入抛可操作错误`；变异态下 `reportLines: 0` 实际产出空回报格式：
  ```
  "## 6. 回报格式（严格 0 行，不要其它内容）\n\n"
  ```
- 结论：重点项 4 的"不得产生空回报格式"**被有效锁定**。

### M3 — 补上**缺失的**路径包含性校验：**57/57 全绿 ⚠️（这就是 B2）**

- 改动：`lib/persona.mjs:444` `const found = tried.find(isFile)` → `const found = tried.filter((c) => c === root || c.startsWith(root + path.sep)).find(isFile)`
- 结果：**`tests 57 / pass 57 / fail 0` —— 一条用例都没红**
- 同变异下重跑穿越探针（证明这就是正确修复落点）：
  ```
  BLOCKED slug="../../outside/secret"      code=PERSONA_NOT_FOUND
  BLOCKED slug="x/../../outside/secret"    code=PERSONA_NOT_FOUND
  BLOCKED slug="../outside/secret"         code=PERSONA_NOT_FOUND
  BLOCKED slug="../outside/secret.md"      code=PERSONA_NOT_FOUND
  BLOCKED slug="./../outside/secret"       code=PERSONA_NOT_FOUND
  ```
- **结论**：防护加上去能把 5 种穿越全挡死，但**测试套件对它零感知**——加不加都是 57/57。按任务书判据，这是 **🔴 blocker**（测试没锁住关键防线），已记入 B2。

### M4 — 删掉 BOM 剥离：**57/57 全绿 ⚠️（覆盖缺口，记 S8）**

- 改动：`lib/persona.mjs:361` `String(raw).replace(/^\uFEFF/, '')` → `String(raw)`
- 结果：`tests 57 / pass 57 / fail 0`；变异态下 `\uFEFF---\nname: BOM Name\n---\n\n正文\n` →
  ```
  hasFrontmatter= false name= undefined
  ```
- 结论：BOM 输入零覆盖（严重度低于 M3，因为后果是报格式错而非越权读取）。

### 还原验证（硬要求，已全部执行）

1. `cp /tmp/kit-backup/<file>` 逐文件覆盖回原路径（含 `test/` 整目录备份）。
2. 全量校验和对比：
   ```
   shasum -a 256 lib/*.mjs lib/*.js bin/*.mjs test/*.mjs package.json > /tmp/now.sha256
   diff /tmp/kit-backup/BASELINE.sha256 /tmp/now.sha256
   ✅ 全部 9 个文件逐字节与基线一致（无残留变异）
   ```
3. 关键行 `grep` 复核（与基线行号一致）：
   ```
   415:  if (!isNonEmptyString(slug)) {
   444:  const found = tried.find(isFile)
   142:    if (!Number.isInteger(reportLines) || reportLines < 1) {
   361:  const text = String(raw).replace(/^\uFEFF/, '')
   ```
4. 复原后全量测试：`ℹ tests 57  ℹ pass 57  ℹ fail 0`。
5. 目录清单与原状一致（`README.md / bin / lib / package.json / test` + 本 REVIEW.md），被测文件零改动。

## 4. 未执行 / 未取证（不隐瞒）

- **未**验证宿主侧 `ctx.tools.register()` 的卸载/生命周期契约（`lib/index.js:54` 丢弃了 `register` 的返回值，若宿主不在 `ctx` effect 内自动追踪，插件卸载后工具可能残留）。这需要读 `@deepseek-ai/dsh-tools` 与 cordis 的注册语义，超出本次审查范围，**未取证故不列为问题**。
- **未**在 Windows 上验证 `path.sep` / `\` 相关分支（当前仅 macOS 实测；`normalizeSlug` 处理了 `[/\\]+`，`expandHome` 对 `~\` 也做了判断，但只做了静态阅读）。
- **未**做性能/大素材树基准（`listPersonas` 每次全量 `readdir + readFileSync`，无缓存；在 100+ 人格的素材树上单次约几十毫秒，未压测）。
- 所有引用的探针脚本位于 `/tmp/`，**不在仓库内**；本文件已内联其关键输出，可据此重放。
