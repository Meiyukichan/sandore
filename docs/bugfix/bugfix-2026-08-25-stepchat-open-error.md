# Round 25：StepChatPanel「子代理会话加载失败」根因修正与修复计划（open 一次性失败粘滞）

> **日期**：2026-08-25
> **来源**：真实 UI 现场（dev 3090 实例 3a560a3b，wfl-2dcf2ae6 test-workflow，cwd=D:\project-code\test\dsh）
> **类型**：UI 缺陷（sandore StepChatPanel 一次性 open + DSH client-runtime openState 粘滞）
> **性质**：本文档是对 `bugfix-2026-08-25-stepchat-open-error.md` 初版的**根因修正**（初版引用的
> `history()` 分流代码为旧版，与当前 DSH 源码不符，结论被实测推翻），并给出修正后的修复计划。

---

## 一、现象

用户创建 workflow 实例后，**运行中 step 下方的实时子代理消息面板**报「子代理会话加载失败」
（`run.step.chat.error`），且面板同时丢弃该子代理的实时事件流。**前面的 step 面板正常，
后面的 step 面板失败**。

实例现场：taskId=`3a560a3b-7612-4457-bbb2-f08daca4ffc0`，cwd=`D:\project-code\test\dsh`，
status=interacting，模型 minimax-cn/MiniMax-M3。executedSteps 中真实子代理
（synthetic:false, command:prompt）的 sessionMeta.childId 按执行顺序 13 个 UUID；另有
finalizeMeta 的 assess/gate/routing fork 会话（临时，评估完 dispose）。

**关键时序事实（磁盘+状态库取证，见 3.2）**：
- dev 实例（PID 7296）14:10:20 启动后**全程未重启**，14:12–14:20 的整个运行无中断。
- 工作流当前状态（`~/.dsh/storages/sandore.sqlite` 的 u_sandore_state）：**18 个执行段**，最后一
  段 `loop [1]`（childId=`8adcf6b3-3800-4638-86fa-7e207cfc57bd`）status=running、
  currentPhase=ask-detect，06:20:45 开始；其子代理 turn 在 **06:20:47.9 即 settle**（3 秒级短 turn）。
- 该 child 的会话文件（44KB，231 事件）与其余 13 个 child 的文件**全部存在且 zstd 可完整解码**。

## 二、报错链路（与初版一致的部分）

1. `packages/sandore/ui/src/client/UnifiedTimeline.tsx` L382-401：running/interacting 且
   `realSession`（childId 非空 && synthetic!==true）→ `<StepChatPanel sessionId={item.childId} />`。
2. `packages/sandore/ui/src/client/StepChatPanel.tsx`：
   - L190 `sessions.binding(sessionId)` 解析绑定；undefined → 「正在加载子代理会话…」。
   - L193-196 挂载/binding 变化时 `openSessionWindow(binding)` → cast 调用 `Session.open()`。
   - L344-357：`snapshot.openState==='error'` → 「子代理会话加载失败」。
3. DSH client-runtime `Session.open()` → `doOpen`（`packages/client/runtime/src/client/sessions/session.ts`
   L618-648）：`await this.history({maxMessages})`，`result.ok===false` 或 transport 异常 →
   `openState='error'`；且 `openState!=='open'` 时实时事件被丢弃（L693）——「报错之外无任何输出」。

## 三、根因（修正版）

### 3.1 初版根因不成立（重要更正）

初版引用 session.ts L775-782 为「`subscribedLastSeq === null ? sessions.history :
subagents.history`」，并据此断言：StepChatPanel 不导航 → `address===undefined` → 走
`subagents.history({...undefined})` → payload 缺 parentSessionId/childSessionId/mode →
schema 校验失败 → `openState='error'`。

**该引用与当前源码不符，且经 git 历史核实从未存在过**。当前 `session.ts` L774-783 的 history
分流**只看 `address`**：

```ts
private history(payload) {
  return this.address === undefined
    ? this.api.sessions.history({ sessionId: this.sessionId, ...payload })
    : this.api.subagents.history({ ...this.address, ...payload })
}
```

- git 证据：`git log -S'subscribedLastSeq'` 仅命中 a6a3807a07（"feat(gui): step1 skeleton"）
  一个提交，此后该字符串出现次数从未变化——**没有任何历史版本用 subscribedLastSeq 路由
  history**（旧版所有 history 调用点都是 `this.api.sessions.history({sessionId})` 直连，
  subscribedLastSeq 只用于 gap detection；address 路由由 a27492507d
  "feat(web): add subagent conversation transport" 引入，`git log -L` 显示仅此一版）。
  初版文档是把 gap-detection 条件（L633）误当成了路由条件。
- `subscribedLastSeq` 当前仅用于 gap detection（L633），全文件 4 处引用核对（L109/438/483/633）。
- `address` 只由 `manager.select`（`sessions.open`）/`selectSubagent`/持久化选中恢复写入
  `addresses` map（`manager.ts` L175/190/214）。面板本身不导航 → **无 address → 走
  `sessions.history`（普通会话历史 RPC，payload 只含 sessionId，schema 合法）**。

**实测（对本任务 14 个 child 逐一调用 dev 实例 3090 的 RPC，2026-08-25 14:3x）**：

| RPC | 结果 |
| --- | --- |
| `session.history`（含 8adcf6b3/249614d2/23fa27d4…全部 14 个 child，带 projections） | 全部 `ok:true`，事件完整 |
| `subagent.history`（parent=3a560a3b + childId + mode=continuable） | 全部 `ok:true` |
| `subagent.list`（parent 目录） | 36 个 child，全部 `mode=continuable, activity=inactive` |

即：**两条 history 路由在现网状态都成功**——初版所谓「address 缺失导致 subagents.history 缺参必
失败」在当前代码下不成立（无 address 根本不会走 subagents.history）。

### 3.2 实证事实链

1. **会话文件全部存在可读**：`~/.dsh/sessions/--D-project-code-test-dsh--/<childId>/session.jsonl.zstd`
   共 14 个 child（13 个 executedSteps + 当前 loop[1] 的 8adcf6b3）全部存在、非 0 字节、
   zstd 多帧完整解码。**排除「会话文件缺失」**。
2. **child 日志结构特殊**（8adcf6b3 解码 231 行）：`seedLength=208`——前 208 事件为**父会话
   （3a560a3b）完整已完成 turn 前缀的 fork 注入**（含父的 `sandore/step-start`×17、
   `sandore/step-phase`×93、`sandore/question`×3、turn 1-18 且 reason=**blocked** 等），
   seq 208/210 两个 `session/end-seed` 边界标记，seq 209 `subagent/descriptor`，之后是 child
   自己的 turn 19（seq 210-230，仅 ~3 秒、6 个 assistant/chunk）。即：**每个 step 子代理都是
   fork 了父会话历史的「重放 + 短 turn」结构**。
3. **child 的 turn 长短与时序**：早期 step（sce1 visit1：14:12:22–14:13:20，约 1 分钟）turn 长；
   后期 loop 迭代 turn 极短（修复问题 visit2 loop1：14:19:49–14:20:03；loop[1]：仅 ~3 秒）。
4. **UI 状态更新滞后于 child 生命周期**：executedSteps 经引擎持久化 + SSE/5s 轮询到达 UI。
   对短 turn step，UI 收到 step 记录（真实 childId）时，child 往往**已经 settle 并被 DSH
   continuation 管理器 dispose**（`subagent.list` 现测全部 activity=inactive = 仅存在于持久化、
   已从 live store 分离）。settle → session detach → host 广播 `session-removed` → **client 列表
   移除该 child**（`manager.ts` remove 分支 L1106-1107）→ `binding` 转 undefined（loading 态）。
5. **错误粘滞机制（核心缺陷）**：StepChatPanel 的 `open()` **只在挂载/binding 变化时调用一次**
   （L193-196）；`openState==='error'` 后（`session.ts` open() L369-378 只对 'open' 短路，'error'
   会再跑 doOpen，但面板**不会再次调用 open**，binding 引用稳定、effect 不再触发）→
   **任何一次瞬时 open 失败都会让该 step 面板永久显示「子代理会话加载失败」**。
   而「报错之外无实时输出」正是 openState!=='open' 丢弃 live 事件（L693）的后果。

### 3.3 「前面正常、后面失败」的确切机制

不是「会话数量/时间导致的系统性差异」，而是**生命周期窗口 + 粘滞错误的叠加**：

- 每次 step 开始：引擎 `startContinuable` 建子代理（live、attached）→ `onChildStarted` 把
  真实 childId 写进 executedSteps 并发布 → UI 挂载面板 → `open()` → 拉历史。
- **早期 step**：turn 长（数十秒~分钟），UI 挂载面板时 child 仍在 live 运行 → open 落在
  attached 读（内存）或已落盘的冷读上 → 成功（偶发瞬时失败也会在 openState='open' 后正常）。
- **后期 step**（loop 迭代）：turn 极短（3–10 秒），UI 轮询/SSE 送达 step 记录时 child 往往已
  settle/dispose，open 更易撞上「创建→settle→dispose→写盘」过渡窗口内的瞬时失败
  （如 dispose 竞态、写盘中的冷读、transport 抖动）。一旦失败 → openState='error' **永久卡死**，
  面板再也不会自愈，表现为「后面的 step 全部失败」。
- 叠加因素：父会话 catalog 随运行累积到 36+ 个子代理，`subagents.history`（用户点击 step 标题
  → `sessions.open(childId)` → address 配置后面板走此路由）每次调用要做整棵 catalog 枚举
  （现测 1.3s，运行中冷 cache 时更慢），进一步拉大面板请求与 child 生命周期的碰撞窗口。

### 3.4 排除项（本次诊断再次确认）

| 检查项 | 结果 |
| --- | --- |
| child 会话文件存在/可读（14 个 child） | 全部存在，zstd 完整 |
| header（cwd/parentSession/origin=subagent/seedLength） | 全部正确 |
| `session.history` 全量实测 | 全部 ok（含 projections 折叠） |
| `subagent.history`/`subagent.list` 实测 | 全部 ok（catalog 36 行 healthy） |
| workspace scope（方向 5） | 排除：jsonl 后端 `list()` 扫全部 project 目录，`ctx.sessions` 为全局 store，非 per-workspace |
| dev 实例重启 | 排除：PID 7296 14:10:20 启动后未重启 |
| 会话文件缺失（方向 3） | 排除：14 个 main child 全在；仅 gate fork 会话（69d9d034/c6bdff48 等）无目录，但非 StepChatPanel 目标 |

## 四、修复方案

### 方案 A（推荐）：StepChatPanel 弹性化 —— 失败重试 + 错误可见 + binding 重解析（sandore 侧，不改 DSH）

改动文件：`packages/sandore/ui/src/client/StepChatPanel.tsx`

1. **open 失败重试**（消除粘滞）：面板持有 session 快照订阅（StepChatBody 已订阅）；当
   `snapshot.openState === 'error'` 时，启动**有界退避重试**（如 1s → 3s → 10s 封顶，或监听
   `sessions.list` 变化 / child running 状态翻转时重试）重新调用 `Session.open()`。
   `Session.open()` 对 'error' 态会重新执行 doOpen（`session.ts` L369-378），瞬时失败可自愈；
   重试幂等，失败继续留在 error 占位。实现上建议把 open 触发从「挂载一次」改为
   「订阅快照 + 状态机」：`openState==='cold'|'loading'` 不重复调、`'error'` 退避重调、
   `'open'` 停止。
2. **错误可见**：error 占位展示 `snapshot.openError`（code/message），让下次现场能直接拿到
   确切错误码（本轮受限于浏览器不可达，未能拿到 mount 时的原始 error；展示后即可精确定位）。
3. **binding 重解析**（修复「settle 后 child 被 session-removed → 永久 loading」的另一半缺陷）：
   `binding === undefined` 且 childId 存在时，尝试 `sessions.refresh()`（重拉 session.list，
   host 列表包含持久化 cold 会话）或订阅列表变化重算 binding，使被移除的 cold child 重新可绑定。
   注意与 DSH ChatView 的「removed 会话保留 resident 冻结视图」语义对齐，避免空转。

改动文件（辅助）：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` 无需改（面板内部处理）。

**风险**：低。重试/刷新均为幂等只读操作；不改变 history 路由（保持 address undefined →
`sessions.history`，对 live/cold 都可用），**不再引入初版方案 A 的 `configureSubagent`
（那会把面板导向 catalog 依赖的 `subagents.history`，且依赖父会话 live，反而更脆）**。

### 方案 B（补充硬化）：引擎侧时序——确认子代理完全建立后再发布真实 childId

改动文件：`packages/sandore/workflow/src/workflow-engine.ts` `onChildStarted`（L1588-1605）。

`startContinuable` 返回后，等子代理首个 turn 事件已落盘（或 descriptor 已持久化确认）再更新
`sessionMeta.childId` 并发布，缩小「UI 拿到 childId 时 child 尚未就绪/已 settle」的窗口。
**风险**：增加 step 启动延迟（毫秒级）；且无法根治「短 turn + UI 轮询滞后」导致的
settle 后挂载——真正兜底必须靠方案 A 的重试。故作为 A 的补充而非替代。

### 方案 C（DSH 侧，记录但不改）

`packages/host/apiproxy/src/api-proxy.ts`：`session.history` 的 `projectionsFor`（L786-790）目前
**非 fail-soft**（与 `listProjectionsFor` L802-812、`subagentHistoryProjections` L833-843 不一致），
投影折叠或 presenter 解析的一次异常会整页返回 `internal`，直接打红面板。建议对齐 fail-soft
（异常时返回 undefined block，页面照常服务）。属 DSH 源码改动，需上游评审，本轮不改。

### 方案 D（configureSubagent 方案——已评估，否决）

**提议**：StepChatPanel 挂载时从 list summary 取 `parentId` → `sessions.refreshSubagents(parentId)`
（公开 API）→ 从 `subagentsByParent` catalog 取 mode → cast 调
`session.configureSubagent({parentSessionId, childSessionId, mode}, parentAvailable)` → 再 open
（失败则靠 configureSubagent 触发的 resync 恢复）。

**否决理由**：

1. **前提错误（致命）**：该方案建立在「address 缺失 → subagents.history 缺参 → 失败」的前提上，
   而该前提已被 3.1 证伪——当前代码 address undefined 走的是**可用的** `sessions.history`
   （实测 14 个 child 全 ok，live/cold 均可用，无 catalog 依赖）。配置 address 反而把面板路由
   切换到 `subagents.history`：每次调用先做父 catalog 整树枚举（`catalogChild` →
   `listChildren`，现测 36 child 约 1.3s），并要求 catalogChild 校验通过（child 在 catalog 且
   mode 匹配）。这是**把一条稳健路径换成一条更脆、更慢的路径**，方向反了。
2. **@internal 依赖 + resync 副作用**：`configureSubagent`（`session.ts` L544-552）在具体类
   Session 上，不在公开契约 `SessionFace`/`ISession`，需 cast（面板对 `open()` 已有同款 cast，
   但 open 是只读幂等触发）。更严重的是其副作用：address 变化且 `openState!=='cold'` 时
   **触发 `resync()`**（L550）——resync 会 `openGeneration++`、openState 置 'cold'、清空窗口并
   **用新 address 重新 open**（L420-441）。若这步 subagents.history 重开失败（catalog 瞬时未
   就绪等），等于**亲手把一个已成功打开的面板打成 error**；即使成功也会闪一次 loading。
3. **竞态**：`refreshSubagents` 是异步 RPC，await 期间 child 可能 settle/dispose（catalog 条目
   翻转为 inactive）——configureSubagent 仍会成功，但后续 open 依赖「child 恰好出现在 catalog
   且 mode 匹配」，把结果系于一次外部枚举的一致性好坏。父会话非 live（工作流终态）虽不致命
   （listChildren 走持久化 corpus，parentAvailable 只是 hint），但同样是**不必要的新依赖**。
4. **语义副作用**：配置 address 后 `snapshot.subagent` 非 null（L753-755），Session 被客户端
   当作「子代理路由会话」处理，面板并不需要该身份。
5. **更优路径**：面板本来就该保持 address undefined 走 `sessions.history`；真正的三个缺陷
   （open 一次性、error 粘滞、binding 丢失）全部可用**公开面**修复（见方案 A 的
   `session.open()` 重试 / `sessions.refresh()` / `snapshot.openError` 展示），无需触碰 @internal。

## 五、验证

1. 单测：StepChatPanel 新增「open 失败 → 退避重试 → 成功恢复」与「binding 移除 → refresh
   重解析」用例（`packages/sandore/ui/src/client/` 下新增/修正 spec）；`pnpm test` 全绿。
2. `pnpm typecheck` / `pnpm build` 通过。
3. 重启 dev（3090）→ 创建相同 workflow（或复用 3a560a3b 现场）→ 观察：
   - 短 turn 的 loop 迭代 step 若首次 open 失败，面板应在数秒内自愈并显示实时消息；
   - 所有 step 运行中面板正常显示；step 完成后显示收尾压缩输出；failed/paused 可读历史。
4. 回归：首个 step（ask 交互）、循环回跳 step、并行 step（parallel1 合成会话不渲染面板）、
   嵌套循环 step、用户点击 step 标题跳 DSH 子代理页后返回均正常。
5. 若方案 A 步骤 2（错误可见）落地：复现一次失败，把 error 占位中的 code/message 记录回传，
   用于最终锁定 mount 时瞬时错误的确切类型（预计为 `session-not-found`/`internal`/transport 之一）。
