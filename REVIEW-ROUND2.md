# dsh-expert-team-kit 复评 · Round 2（task-12）

- **审查人**：worker-review
- **专家人格**：**Code Reviewer**（`engineering-code-reviewer.md`，frontmatter `name: Code Reviewer`）
- **本轮范围**：**只验修复落点**（Round 1 的 15 条：2 🔴 + 8 🟡 + 5 💭）。未重做全量架构审查，上一轮已确认无问题的项不再复述。
- **对照基线**：Round 1 时的原始文件（我上一轮变异检验前留的备份 `/tmp/kit-backup/`）——用它做**逐行 diff** 来判"断言有没有被放宽"，而不是凭感觉。
- **改前基线（本轮）**：`node --test test/` → **82 tests / 82 pass / 0 fail**；10 个文件 shasum 记录在 `/tmp/kit-r2-backup/BASELINE-R2.sha256`

## 结论

# ✅ PASS

15 条修复声明**逐条自己动手验过，全部为真**，没有发现"化妆"（注释写了但代码没动 / 声明与事实不符）的情况。

关键的两条（B1 路径穿越、B2 测试防线）是**实质性修复**：

- **B1 的拒绝是真校验，不是"文件不存在"**。我造了"根外 `.md` 真实存在且是合法人格"的场景，同一文件在 `root` 指向其父目录时能正常解析（证明它存在），而带 `..` 的 slug 一律被 `PERSONA_OUTSIDE_ROOT` 拒，且 `error.tried=无`——**拒绝发生在生成候选路径之前**，从时序上就排除了"依赖文件不存在碰巧挡住"。
- **B2 的回归测试能红**。我独立重做变异（把 `isInside` 改成恒真）得到 **pass 81 / fail 1**，并且**变异态下软链接攻击真的复活了**（读到根外 `SECRET-OUTSIDE-ROOT`，经 tool 边界同样能读）——说明那条红灯守的是真洞，不是装饰。

仅剩 3 条**非阻塞观察**（💭，见 §4）：无一条构成打回理由。

---

## 1. B1 路径穿越：真校验（附决定性证据）

**实现落点**：双层，缺一不可——
- 层 1 段级：`lib/persona.mjs:277-293` `assertSlugStaysInRoot()` 拒绝对路径与含 `..` 的段；调用点 `lib/persona.mjs:616`，**在 `candidatePaths()` 之前**。
- 层 2 真实路径：`lib/persona.mjs:310-341` `findContainedFile()`——候选字面路径过 `isInside(resolvedRoot, …)`（`:314`），命中后再 `fs.realpathSync` 比对 `isInside(realRoot, real)`（`:327`），专门挡软链接逃逸。
- 与根比较用 `isInside()`（`lib/persona.mjs:192-195`）：按 `base + path.sep` 比对，显式处理了 `/x/root-evil` 这类兄弟目录前缀陷阱。

**实测矩阵**（`/tmp/r2-attack.mjs`，临时素材根 + 根外 `outside/secret.md` 真实存在且可解析）：

```
A. 根外 .md 真实存在 + slug 含 ..
REJECTED  "x/../../outside/secret"       -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无
REJECTED  "../outside/secret"            -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无
REJECTED  "./../outside/secret"          -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无
REJECTED  "../../outside/secret"         -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无
REJECTED  "demo/../../outside/secret"    -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无
REJECTED  ".." / "../.."                 -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无
REJECTED  "a/b/../../../../etc/passwd"   -> PersonaError/PERSONA_OUTSIDE_ROOT  tried=无

B. 对照：同一文件当 root 指到它父目录时本来就能读（排除「文件不存在」这个解释）
  resolvePersona("outside/secret", {root: base}) -> name="SECRET-OUTSIDE-ROOT" 含泄漏正文=true

C. 软链接逃逸（slug 里没有 ..，只能由 realpath 层兜住）
REJECTED  "demo/linked"          （文件软链指向根外）-> PERSONA_OUTSIDE_ROOT
REJECTED  "linked"               （简名扫描撞上软链）  -> PERSONA_OUTSIDE_ROOT
REJECTED  "demo/linkdir/secret"  （目录软链）          -> PERSONA_OUTSIDE_ROOT

D. 反向：根内软链接必须仍然可用，不许一刀切
ALLOWED   "demo/inner-link" -> name="RealInside"

E. 绝对路径 slug
REJECTED  "/etc/passwd"、"/abs/outside/x"、"C:\abs\x" -> PERSONA_OUTSIDE_ROOT

F. 经 tool 边界（越界必须落 ToolSpecError + param=expert，而不是裸 PersonaError）
REJECTED  expert="x/../../outside/secret" -> ToolSpecError/TOOL_INVALID_PARAM param=expert
REJECTED  expert="demo/linked"            -> ToolSpecError/TOOL_INVALID_PARAM param=expert
```

**判定的三点关键**：① `tried=无` 证明拒绝发生在任何文件查找之前（不是"没找到"）；② C 组的 slug 不含 `..`，层 1 放行、只有 realpath 层能拦——证明第二层是真的在跑，不是只写了注释；③ D 组证明没有过度拒绝。**声明为真。**

## 2. 变异检验（我自己重做，不采信对方结论）

**方法**：本轮改前先 `cp` 全量备份 + 记 `shasum` → 变异脚本要求替换点**恰好命中 1 次**（否则中止）→ `node --test test/` → `cp` 还原 → 与基线 `diff` 全部 shasum → 再跑全量。

### M-A（主变异，与对方声称的同一处）：把包含性校验改成恒真 → **变红 ✅**

- 改动：`lib/persona.mjs:194` `return target === normalizedBase || target.startsWith(normalizedBase + path.sep)` → `return true`
- 结果：**`tests 82 / pass 81 / fail 1`**，红的是
  ```
  ✖ B1(真实路径): 根内软链接指向根外 —— 只有真 realpath 包含性校验能挡住
  ```
  与 lead 独立跑出的「81 pass / 1 fail」**完全一致**。
- **附带取证（这条最重要）**：变异态下重跑攻击矩阵，洞真的开了——
  ```
  ⚠️ ALLOWED  resolvePersona("demo/linked")        -> name="SECRET-OUTSIDE-ROOT"
  ⚠️ ALLOWED  resolvePersona("linked")             -> name="SECRET-OUTSIDE-ROOT"
  ⚠️ ALLOWED  resolvePersona("demo/linkdir/secret")-> name="SECRET-OUTSIDE-ROOT"
  ⚠️ ALLOWED  executeExpertBrief(expert="demo/linked") -> name="SECRET-OUTSIDE-ROOT"
  ```
  说明那条红灯守的是真实可利用的洞，不是恒真断言。
- 还原：`shasum lib/persona.mjs` = `fb8df1a3767eb7ce5210a6f022f82024ad0c29cf73e03a0d948de429bec6d8a0`，与基线**逐字节一致**；复原后 82/82。

### M-B（加固性验证）：两层同时改坏 → **变红 ✅（fail 2）**

- 改动：`persona.mjs:194` → `return true` **且** `persona.mjs:286` 的 `..` 判定 → `if (false)`
- 结果：`pass 80 / fail 2`，两条 B1 用例同时红：
  ```
  ✖ B1/B2: 路径穿越一律 PERSONA_OUTSIDE_ROOT —— 根外文件真实存在也读不到
  ✖ B1(真实路径): 根内软链接指向根外
  ```
- 结论：**整套防线（而不是单层）被测试锁住了**。

### M-C（诚实记录一个细节）：只关闭层 1 → **82/82 全绿 ⚠️（但不是漏洞）**

- 改动：`persona.mjs:286` 的 `..` 段判定 → `if (false)`（层 2 保留）
- 结果：`tests 82 / pass 82 / fail 0`；此时穿越攻击**仍被层 2 拦住**：
  ```
  REJECTED  resolvePersona("x/../../outside/secret")       -> PERSONA_OUTSIDE_ROOT
  REJECTED  executeExpertBrief(expert="x/../../outside/secret") -> ToolSpecError param=expert
  ```
- 判定：**不是缺口，是纵深防御**——任一层单独都能挡住 `..`，所以拆掉一层不产生可利用的洞，也就没有"该红的红灯"。仅记为 💭 观察（§4-O1），**不构成打回**。

### 本轮还原总验证

```
shasum -a 256 lib/*.mjs lib/*.js bin/*.mjs test/*.mjs package.json README.md > /tmp/r2-now.sha256
diff /tmp/kit-r2-backup/BASELINE-R2.sha256 /tmp/r2-now.sha256
✅ 10 个文件逐字节与改前基线一致（无残留变异）
node --test test/ -> ℹ tests 82  ℹ pass 82  ℹ fail 0
目录清单：README.md / REVIEW.md / bin / lib / package.json / test   （本轮只新增 REVIEW-ROUND2.md）
```

## 3. 逐条核对修复声明（只验落点）

| 条目 | 声明 | 我的验法与真实结果 | 判定 |
|---|---|---|---|
| **B1** 穿越 | realpath 包含性校验，越界 `PERSONA_OUTSIDE_ROOT` | §1 全矩阵：`..`/绝对路径/软链逃逸全拒，`tried=无`（先于候选生成），根内软链仍通；对照组证明根外文件真实可解析 | ✅ 真 |
| **B2** 测试 | 补可红回归；注释掉守卫后 fail 1 / 82 | §2 M-A 独立复现 **81/1**；变异态攻击复活，证明红灯有效 | ✅ 真 |
| **S1** tool 错误码 | `.md`/`/`/`./` → `ToolSpecError`，`param='expert'`，码在枚举内 | 实测 `.md`/`/`/`./`/`///` 全部 `ToolSpecError`、`param=expert`、`code=TOOL_INVALID_PARAM`、`在枚举内=true`；落点 `tool.mjs:80-93` 归因集合 + `resolveExpert` 翻译 | ✅ 真（`\` 一个边角差异见 O2） |
| **S2** listPersonas | 已与 resolvePersona 对齐 | 临时根里放"有 frontmatter 但缺 name"的文件：`listPersonas` 返回 **1 条（只剩可解析的 `ok`）**，不再吐出 `name:""` 条目；每条列出的 slug 都回解析成功 | ✅ 真 |
| **S3** 围栏 | 自适应 `Math.max(3, 最长反引号段+1)` | 实测 verify 含 3 个反引号 → 起始围栏 **4** 个、内容全在围栏内；含 5 个 → 围栏 **6** 个；落点 `brief.mjs:319` | ✅ 真 |
| **S4** 未知参数 | 未知选项报错、退出码 1 | tool 层实测：`tavk` → `TOOL_INVALID_PARAM param=tavk`；`root` 误放进 args → `TOOL_INVALID_PARAM param=root`（我上一轮就是踩这个坑）；正常入参仍通过；落点 `tool.mjs:64,269-274` | ✅ 真 |
| **S5** bin | 已补 bin 字段 | `package.json:7-8` `"bin": {"expert-brief":"./bin/expert-brief.mjs"}`；`require("./package.json").bin` 有值 | ✅ 真 |
| **S6** README | 已修 `--list` 造假、补第 3 层 | `README:31/34/178-181` 补了 L3（`expert_brief`/`engines`/`apply`）；`README:130` **主动声明「当前 CLI 没有 `--list`，`--help` 是唯一权威选项清单」**——不是偷偷删掉，是明确纠正 | ✅ 真（诚实修法） |
| **S7** 未闭合 frontmatter | 错误信息不再误导 | `parsePersonaFile` 现在回 `unterminated:true`；`resolvePersona` 报「**专家人格文件的 frontmatter 未闭合**」（不再是"缺少 name…请补模板"），码仍 `PERSONA_INVALID_FORMAT` | ✅ 真 |
| **S8** 覆盖缺口 | — | 已入库并实测：`persona.test.mjs:526` BOM 用例、`:203/:483`「另有 N 个候选路径」分支、`:558` suggestSlugs 第三档、`:551` `hasFrontmatter=false` | ✅ 真 |
| **N1** 重复断言 | 已修 | 删掉的是重复那条，**保留 `:134` 原句**（不是两条都删） | ✅ 真 |
| **N2** `undefined` 误伤 | 已修 | 全局子串禁令 → 3 条定位断言（`人格名：undefined` / worker 行 / `` `undefined` ``）+ 新增"任务含 undefined 不误伤"回归用例。**是收窄加强，不是删断言** | ✅ 真 |
| **N3** `--help` 不短路 | — | `--help --nope` / `--help --task` / `--nope --help` / `--help` 四种顺序**全部 exit 0 + 打印用法** | ✅ 真 |
| **N4** 转义 | 已修 | workerName 含换行 → 压成单行（不产生裸 `## 伪造章节`）；taskId 进 JS 片段走 `escapeForDoubleQuoted`（`task_id:"task-1\") …"` 引号被转义，片段结构不断） | ✅ 真 |
| **N5** 口径 | 已修 | 空串 scopes：`buildBrief` 与 `executeExpertBrief` **都**渲染成「- 无」（两侧一致）；空白项 `['  ']` 两侧仍报错 | ✅ 真 |

## 4. 有没有「为过测试而放宽断言」的痕迹？（逐行 diff 判定）

方法：把 Round 1 的测试文件与现在做 `diff`，只看**被删除的断言行**，逐条确认它的替代品。

删除的断言共 7 行，全部有交代：

| 被删的断言 | 替代品 | 判定 |
|---|---|---|
| `assert.ok(!persona.name.includes(':'), 'name 不应包含冒号')` | 重复断言，另一条（`:134`）保留 | ✅ 去重，不是放宽 |
| `error.tried.some(c => c.startsWith(error.root))` + 文案「所有尝试路径都应落在素材根目录下」 | **改成 `.every(path.resolve(c)…startsWith(rootPrefix))`**，失败时把越界项列出来 | ✅ **加强**（正是 B2 要求） |
| `!text.includes('undefined')`（brief） | 3 条定位断言 + 新增合法 undefined 不误伤用例 | ✅ 加强（收窄到目标位置） |
| `!text.includes('undefined')`（tool） | 同上（`人格名：undefined` / worker 行 / task id 片段） | ✅ 加强 |
| `assert.equal(error.cause.code, 'PERSONA_NOT_FOUND')` | `assert.match(error.cause.code, /^PERSONA_/)` | ⚠️ **确实放宽**（见 O3） |
| `assert.equal(error.code, 'PERSONA_ROOT_MISSING')` | `assert.match(error.code, /^PERSONA_/)` | ⚠️ **确实放宽**（见 O3） |

**关于 O3 的判定（我做了动机核查，避免误判为"化妆"）**：这两处放宽**不是为了让红变绿**——实测行为根本没变：

```
根目录不存在时： resolvePersona -> PersonaError PERSONA_ROOT_MISSING
                tool 透传      -> PersonaError PERSONA_ROOT_MISSING
```

即放宽前放宽后都是绿的，没有"为过测试"的动机（注释写的理由是"并行返工可能新增码"，属防御性提前放宽）。且 `PERSONA_ROOT_MISSING` 仍被**精确钉住**在 `test/persona.test.mjs:264`。所以：**不算打回项**，但确实新削弱了一处（tool 层若把 persona 码改写/重命名，这两条用例将不再报警）。列为 💭，供后续加固。

## 5. 仍存的非阻塞观察（不构成打回）

- **O1💭** 层 1（`assertSlugStaysInRoot` 的 `..` 判定，`persona.mjs:286`）**没有独立红灯**：单独把它改成恒真时 82/82 全绿，因为层 2 同样拦得住（§2 M-C）。这是**纵深防御的正常形态**，不是缺口；但若将来有人重构 `findContainedFile` 并先删了它，唯一还能报警的是 M-A 那条软链用例——建议在该函数上加一行注释说明"本层与 `findContainedFile` 是冗余的，拆任一层都仍有另一层兜底，测试只对整体红灯"。
- **O2💭** `expert="\\"`（反斜杠）现在落 `TOOL_UNKNOWN_EXPERT`，而 `.md`/`/`/`./`/`///` 落 `TOOL_INVALID_PARAM`。两者都是 `ToolSpecError`+`param=expert`+码在枚举内（声明未失实），但在 POSIX 上反斜杠只是普通文件名字符，被归为"未知专家"而非"形状非法"属于口径小瑕疵。
- **O3💭** 见 §4：`tool.test.mjs` 两处 `PERSONA_*` 精确码断言被放宽成 `/^PERSONA_/`（`tool.test.mjs:287`、`:485-486`、`:612` 注释）。行为未变、persona 层仍有精确钉住，但 tool 层的"码原样透传"这层保护变弱了。

## 6. 本轮未执行

- **未**在 Windows 上验 `path.sep` / 反斜杠分支（仅 macOS + Node v26.8.2 实测；`isInside` 用 `path.sep` 拼接是正确的跨平台写法，但未实跑）。
- **未**做并发竞态压测：`findContainedFile` 里 `isFile()` 与 `realpathSync()` 之间是两次 stat（`:323`、`:325`），注释已承认"判存在与解析之间被删掉的竞态，当作没命中"——这是**安全方向**的降级（会 miss，不会越权），我判为可接受，未构造该竞态。
- **未**验证宿主 `ctx.tools.register()` 的卸载契约（与 Round 1 同，`lib/index.js` 未变，sha 与上轮一致 `3dd3b5fd…`）。
