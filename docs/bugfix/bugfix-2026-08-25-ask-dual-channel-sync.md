# 修复计划核实报告：ask/permission 双通道同步（场景 A 不上报宿主 + 场景 B 双向同步）

- 日期：2026-08-25
- 范围：仅核实与计划修正（**不改任何源码**；sandore 与 DSH 均只读）
- 目标文件：`packages/sandore/workflow/src/interaction-manager.ts`、`workflow-engine.ts`、`schema.ts` 等（见 §3 影响面清单）

---

## 0. 结论摘要

原需求的两条通道、两种场景经核实**全部可行**，且同步方案**不需要改 DSH 任何代码**。关键结论：

1. **DSH web userQuestions provider 完整支持 `signal.abort` 关弹窗**（`deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:1327-1334`）：abort 触发 `claimQuestion(pending, 'cancelled')` → 广播 `question/resolved`（outcome `cancelled`）→ 客户端 settle 对应 `PendingWait` → `QuestionComposer` 卸载（弹窗关闭）；同时 ask promise 以 `ASK_ABORTED` reject。**场景 B 的同步方案成立**：引擎在 composer 回答时 abort 之前传给 `userQuestions.ask` 的 signal，DSH 弹窗即自动关闭。
2. **必须引入「每次 ask 独立」的内部 AbortController**，不能直接 abort 调用方传入的 signal：引擎两处 ask 调用点传的是 `controller.signal`（实例中止信号，`workflow-engine.ts:1109/1353`）与子代理 turn 取消信号（`askFromSubagent` L898）——abort 它们会连带中止整个实例循环/子代理 turn。内部 controller 以「链式」方式继承调用方 signal（保留实例 abort/ turn 取消关弹窗的现状），再由 `finishQuestion`/`rejectQuestion`/`cancelMatching` 主动 abort 实现 composer 侧关弹窗。
3. **场景 A 判定点明确**：`startInstance` L489 `request.hostSessionId === undefined`（overlay/NewInstanceDialog 新建，UI 不传 hostSessionId，见 `NewInstanceDialog.tsx:184`）→ `reportToHost = false` → `ask()` 跳过 `userQuestions.ask`，引擎 waiter 仅由 `replyQuestion` resolve——这正是 L192「无 userQuestions 时挂起等 replyQuestion」的既有路径，**场景 A 复用该路径即可**，无需新增机制。
4. **composer 卡片关闭机制已成立**：回答后 `finishQuestion` → `syncState` → `persist([])`（`pendingInteractions` 终态化 = 持久化记录）；`sandore-questions.ts` 3s 轮询 `getInstanceState` → `partitionInteractions`（只取 `status==='pending'`）读空即收卡（另有 `removeSandoreQuestion` 乐观移除即时收卡）。**无需额外机制**。
5. **permission 目前无生产触发点**：`addPendingPermission` 全仓只有 spec 调用（`interaction-manager.spec.ts`），引擎无任何生产调用；`replyPermission` 不经过 `userQuestions.ask` 也不经过 `ctx.approval`（DSH approval 是另一条 `approval/requested` 帧通道，`api-proxy.ts:1367-1433`）。故 permission 当前**不共享 DSH 问答弹窗**，场景 A/B 的同步只作用于 question 通道；`reportToHost` 门禁保留给未来 permission 接入 DSH 通道时复用。
6. **一处计划必须修正——`reportToHost` 需持久化**：`makeInitialState` 不写 `hostSessionId`，`recoverInstance` 冷恢复 hostAgent 于 `instanceId`（L713-717）后 `buildActiveInstance` 无法得知原场景。建议在 `WorkflowTaskStateSchema` 增加可选字段 `reportToHost`（向后兼容旧快照），恢复时读回；否则恢复后实例的 ask 通道语义漂移。

---

## 1. 核实项（证据：文件:行）

### 1.1 DSH web userQuestions provider 对 `signal.abort` 的处理 —— 支持 ✅（决定同步方案可行性）

**Provider 注册点**：`deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:1314-1342`（`ctx.userQuestions.registerProvider({ ask })`，web 侧唯一真实 provider）：

```ts
// api-proxy.ts:1321-1340（节选）
return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
  const rpcId = RpcId(randomUUID())
  const pending: PendingQuestion = {
    rpcId, sessionId, questions: request.questions, resolve, reject,
    ...(request.signal === undefined ? {} : { signal: request.signal }),   // L1325
  }
  const onAbort = (): void => {
    claimQuestion(pending, 'cancelled')                                     // L1328 → 广播 question/resolved(cancelled)
    reject(new UserQuestionError('...aborted...', 'ASK_ABORTED'))           // L1329-1331
  }
  pending.onAbort = onAbort
  pendingQuestions.set(rpcId, pending)
  request.signal?.addEventListener('abort', onAbort, { once: true })        // L1334 ← 监听 abort
  // 推送 question/requested 帧 → mux → 客户端弹窗（L1335-1339）
})
```

- `claimQuestion`（L1303-1312）：删 pending 表项 + 移除 abort 监听 + `broadcast({ type: 'question/resolved', sessionId, questionRpcId, outcome: 'cancelled' })`。
- **服务面预检**：`packages/interaction/user-questions/src/index.ts:92-95` —— signal 已 aborted 时直接抛 `ASK_ABORTED`，不达 provider。
- **客户端收帧关弹窗**：`packages/client/runtime/src/client/sessions/session.ts:510-515` —— `question/resolved` → `this.settle(item)`（settle 对应 `question/requested` mint 的 `PendingWait`，L504-508）；`packages/client/ui-user-questions/src/client/index.ts:42-44` —— composer chain 仅在存在 pending question wait 时 claim，wait 被 settle 后 `QuestionComposer` 卸载（弹窗关闭）。
- **测试证据**：
  - `user-questions.spec.ts:72-83` —— signal 预 abort → `ask` rejects `ASK_ABORTED` 且 provider 不被调用。
  - `api-proxy-question.spec.ts` —— 回答路径：`api.respond` 后广播 `question/resolved`（L93），并校验回答形状（L88-92）。**该 spec 未直接覆盖「abort 关弹窗」**，但实现路径（L1327-1334 + session.ts settle）明确。

**结论**：abort 传给 `userQuestions.ask` 的 signal → DSH 弹窗关闭（`question/resolved` cancelled）+ ask promise 以 `ASK_ABORTED` reject。**同步方案可行**。

### 1.2 PendingPermissionEntry 产生路径 —— 无生产触发点 ⚠️

- `addPendingPermission` 全仓调用点**仅** `interaction-manager.spec.ts:120/210/222/337`；`workflow-engine.ts`、`remote.ts` 均无生产调用。引擎真实权限走 DSH `ctx.approval`（`applyPermission` → `approval.setPolicy(agent, 'ask')`，`workflow-engine.ts:577-580`；DSH approval 帧 `approval/requested` 是**独立于 question 帧**的通道，`api-proxy.ts:1367-1433`）。
- `replyPermission`（engine L821-827 → manager L246-258）是纯内部兼容路径（once/always/reject → 终态化 + syncState），**不调 `userQuestions.ask`、不调 `ctx.approval`**。
- **结论**：permission 条目当前**不共享 DSH 问答弹窗**；场景 A/B 的同步实质只作用于 question 通道。若未来把 permission 接入 DSH 通道（userQuestions 或 approval），`reportToHost` 门禁可原样复用（见 §2.6）。

### 1.3 hostSessionId 传递链与 `reportToHost` 注入点 ✅（含一处恢复语义修正）

- `startInstance`（`workflow-engine.ts:467-557`）：`hostSessionId = request.hostSessionId ?? instanceId`（L486）；**场景判定点 L489 `request.hostSessionId === undefined`** → 新建（L489-524）；否则复用（L525-540）。
- `buildActiveInstance`（L1644-1674）：`new InteractionManager({ hostAgent, userQuestions: () => ctx.get('userQuestions'), persist, emitQuestion, emitPermission, emitQuestionRejected })`（L1664-1674）——**`reportToHost` 注入点在此**。
- UI 侧：`NewInstanceDialog.tsx:184` `face.startInstance(input)` **不传 hostSessionId**（overlay 新建 = 场景 A）；`remote.ts:261` 透传 `hostSessionId`（场景 B 目前仅直接 engine/remote 调用可达）。
- **恢复语义问题（计划必须修正）**：`makeInitialState`（L223-266）不写 `hostSessionId`/`reportToHost`；`recoverInstance`（L686-757）冷恢复 hostAgent 于 `SessionId(instanceId)`（L713-717）后 `buildActiveInstance(..., snapshot)`（L725）。→ 恢复后无法从快照得知原场景。建议：
  - `WorkflowTaskStateSchema` 增可选 `reportToHost: z.boolean().optional()`（旧快照缺省 → `buildActiveInstance` 按 `state.reportToHost ?? true` 兼容历史行为）。
  - `makeInitialState` 写 `reportToHost: request.hostSessionId !== undefined`。
  - `recoverInstance` 读快照字段 → 恢复后行为一致。（注：复用关系本身恢复后已丢失——hostAgent 始终重建于 instanceId；`reportToHost=true` 时恢复后 DSH 弹窗路由到 instanceId 会话，属既有恢复语义，本修复不扩大。）

### 1.4 composer 卡片关闭机制 —— 已成立 ✅

- 轮询聚合：`sandore-questions.ts:94-118`（`listInstances` → 非终态 → `getInstanceState` → `partitionInteractions`）；`partitionInteractions` 只取 `status==='pending'`（`run-view-model.ts:125-139`）。
- 乐观移除：`sandore-questions.ts:87-92`（`removeSandoreQuestion` + mutationSeq 竞态护栏 L113）。
- 收卡：`SandoreQuestionComposer.tsx:57`（无 pending → return null）。
- 引擎侧驱动：`finishQuestion`（manager L261-271）→ `syncState`（L359-365）→ `persist(entries)`（engine L1667-1670 写入 `active.state.pendingInteractions`）→ 下一轮轮询读空 → 卡片关闭。**DSH 弹窗回答 → ask resolve → finishQuestion → 轮询自动收卡**（现状即可，无需额外机制）。

### 1.5 场景 B 同步设计 —— 可行，但 signal 必须「每次 ask 独立」⚠️

- **现状干扰源确认**：composer 回答（`replyQuestion` L204-210）→ `finishQuestion` 只 resolve 引擎 waiter（L268-270）+ 终态化条目（L261-271）——**不 settle `userQuestions.ask` 的 promise**（该 promise 由 DSH 弹窗回答或 signal abort 决定）；弹窗在回答前一直挂着。用户之后答 DSH 弹窗 → ask resolve → `finishQuestion` 幂等守卫（L262-263 条目已删 → return）——回答被丢弃，弹窗在回答前持续干扰。✅ 与任务描述一致。
- **修正设计**：
  1. `InteractionManager` 新增 `Map<requestId, AbortController>`（或挂 waiter 上）；`ask()` 内为**每次 ask** 新建内部 controller，链式继承调用方 signal（`signal.aborted` 时立即 abort；否则 `signal.addEventListener('abort', () => askController.abort(), { once: true })`），把 `askController.signal` 传给 `userQuestions.ask`。
  2. `finishQuestion`（composer 回答路径）/ `rejectQuestion`（L224-237）/ `cancelMatching`（L323-349，覆盖 `clearPendingInteractions`/`clearAll`）中 `askControllers.get(requestId)?.abort()` + 删表项 + 移除链式监听。
  3. 时序安全：`finishQuestion` 先 `waiter.resolve(answer)`（引擎继续）再 abort；abort 使 `userQuestions.ask` 以 `ASK_ABORTED` reject（微任务）→ `.then` 错误分支 `failQuestion`（L274-284）幂等守卫命中（条目已删）→ **no-op，不 reject 引擎 waiter、不冒泡 `runAndCatch`**。
  4. 每 ask 独立 controller：后续 ask 不复用同一 signal，不会误 abort。
  5. **持久化记录**：`pendingInteractions` 终态化 + persist 即「持久化记录」，composer 轮询读空即关（§1.4），无需额外机制。✅
- **禁止项**：不得直接 abort 调用方 signal（`controller.signal` L1109/1353、子代理 turn signal L898）——会中止实例/子代理。

### 1.6 场景 A 实现 —— 复用无 userQuestions 路径 ✅

- `ask()` L177-195：`deps.userQuestions()` 返回 undefined 时（L183）不调 ask，引擎 waiter 仅由 `replyQuestion` resolve——场景 A 即此路径，只是把门禁从「服务不存在」换成「`reportToHost === false`」：
  ```ts
  const userQuestions = this.deps.userQuestions();
  if (userQuestions !== undefined && this.deps.reportToHost) { ...userQuestions.ask(...) }
  ```
- 两个引擎 ask 调用点（finalize ask L1353、`askFromSubagent` L898）都走 `interactions.ask`，一处门禁全覆盖。
- **permission**：无 DSH 通道（§1.2），场景 A 无额外动作；若未来接入，`reportToHost` 门禁复用。

### 1.7 spec 影响面 —— 大量 workflow-engine.spec 用例需要改造 ⚠️

- **交互管理器单测**（`interaction-manager.spec.ts`）：
  - `makeDeps`（L76-100）构造 `InteractionManagerOptions` 需补 `reportToHost`（新增必填字段 → 编译要求更新，全部用例经 makeDeps 一处覆盖）。
  - 现有断言（L128-156 的 ask 形状、L158-183 的持久化、L186-236 的 reply、L238-290 的 reject、L298-354 的 clear）在 `reportToHost: true` 默认下**语义不变**。
  - 需新增：场景 A（reportToHost=false → 不调 userQuestions.ask，replyQuestion resolve）；场景 B composer 先答（mock 支持 signal abort → replyQuestion 后断言 request.signal 已 abort + ask promise 以 ASK_ABORTED reject + 引擎 ask resolve composer 答案）；rejectQuestion / clearPendingInteractions / clearAll 同样 abort 弹窗。
- **引擎集成测试**（`workflow-engine.spec.ts`）——**最大影响面**：所有 ask 流程测试都以 `startInstance({...})`（**不传 hostSessionId**）启动 → 修复后为场景 A → `userQuestions.ask` 不再被调用 → `userQuestions.resolveNext` 永不触发 → 引擎 ask 挂起 → 实例永不完成 → **测试超时**。必须逐用例改：
  - L2582（resolveNext L2605 + `userQuestions.calls` 断言 L2615-2616）
  - L2676（resolveNext L2699）、L2715（resolveNext L2752/2825）
  - L2934（resolveNext L2946 + calls 断言 L2954）
  - L3017 askFromSubagent（resolveNext L3037 + agent 断言 L3045）
  - 改造方向：① 预置 `FakeAgent('host-1')` + `sessions.create('host-1')`（模式见 L1243-1245）后传 `hostSessionId: 'host-1'`，保住 DSH 通道用例（agent 断言改为 `'host-1'`）；或 ② 转场景 A 语义改用 `engine.replyQuestion` 驱动（模式见 L2639-2674）。
  - **不受影响**：L2639 replyQuestion 兼容路径（本就走 replyQuestion，且语义恰为场景 A 卡片通道）；L2859/L2902 rejectQuestion（不依赖 userQuestions 被调用，挂起 + rejectQuestion 在场景 A 同样成立）；L2981/L3006（断言 calls=0，两场景皆 0）；L1239-1301 hostSessionId 复用/冻结/校验用例（wfl-shell-only 无 ask）。
  - **需新增**：场景 B 双向同步集成用例（composer replyQuestion → DSH ask promise 以 ASK_ABORTED 收束 + 实例 completed）；场景 A 纯卡片用例（不调 userQuestions.ask + replyQuestion 驱动完成）。
- **real-e2e**（`workflow-engine-real-e2e.spec.ts`）：自动回答走 `engine.replyQuestion`（L514-534），不依赖 userQuestions.ask → 场景 A 修复后照常工作；DSH 真 harness 下 provider 存在也不再弹窗（符合预期）。无断言改动。
- **remote.spec.ts / UI spec**：`replyQuestion`/`replyPermission` 转发、`partitionInteractions` 均不涉及新字段，无改动。

---

## 2. 修正版修复计划

### 2.1 改动点清单（sandore 侧，DSH 零改动）

| # | 文件:位置 | 改动 | 说明 |
|---|-----------|------|------|
| 1 | `workflow/src/interaction-manager.ts` L35-48 | `InteractionManagerOptions` 增 `reportToHost: boolean` | 场景门禁 |
| 2 | `workflow/src/interaction-manager.ts` L147-195 | `ask()`：新增 `askControllers: Map<requestId, AbortController>`；每次 ask 新建内部 controller + 链式继承调用方 signal；仅 `reportToHost===true` 且 userQuestions 存在时调 `userQuestions.ask({..., signal: askController.signal})` | 场景 A 跳过 + 场景 B 可关闭 |
| 3 | `workflow/src/interaction-manager.ts` L261-271 | `finishQuestion`：resolve waiter 后 `askControllers.get(requestId)?.abort()` + 删表项 + 移除链式监听 | composer 回答 → 关 DSH 弹窗 |
| 4 | `workflow/src/interaction-manager.ts` L224-237 | `rejectQuestion`：同 abort | composer 拒绝 → 关弹窗 |
| 5 | `workflow/src/interaction-manager.ts` L323-349 | `cancelMatching`：对每条 question 条目 abort 其 askController | pause/retry/clearAll 关弹窗 |
| 6 | `workflow/src/interaction-manager.ts` L274-284 | `failQuestion`：清理 askController 表项（不 abort，信号已触发） | 防泄漏 |
| 7 | `workflow/src/schema.ts` L474-510 | `WorkflowTaskStateSchema` 增 `reportToHost: z.boolean().optional()` | 恢复语义持久化（向后兼容旧快照） |
| 8 | `workflow/src/workflow-engine.ts` L223-266 | `makeInitialState` 写 `reportToHost: request.hostSessionId !== undefined` | 场景判定落快照 |
| 9 | `workflow/src/workflow-engine.ts` L1664-1674 | `buildActiveInstance` 传 `reportToHost: state.reportToHost ?? true` | 注入 + 旧快照缺省兼容历史（true） |

### 2.2 实现细节与顺序

1. **先落 schema/持久化**（#7/#8/#9）：不依赖运行时逻辑，独立可测。
2. **再改 InteractionManager**（#1-#6）：核心逻辑，配单测先行（TDD）。
3. **最后改 engine 测试**（§1.7 改造清单）+ 新增场景 A/B 用例。

### 2.3 关键正确性要点

- **abort 不得落在调用方 signal 上**：内部 controller 链式继承（实例 abort / 子代理 turn 取消 → 弹窗关闭的现状保留）；composer 回答只 abort 内部 controller。
- **顺序**：`finishQuestion` 先 resolve 引擎 waiter 再 abort——abort 的 `ASK_ABORTED` reject 落在微任务，`failQuestion` 幂等守卫（条目已删）吞掉，**不 reject 引擎 waiter、不冒泡 runAndCatch**。
- **幂等**：`askControllers` 表项随终态化删除；重复 abort no-op。
- **每 ask 独立 controller**：后续 ask 不受前次 abort 影响。
- **场景 A 无 askController**：abort no-op，无副作用。

### 2.4 验证步骤

1. `pnpm vitest packages/sandore/workflow/src/interaction-manager.spec.ts`（新增用例：场景 A 不调 ask / 场景 B composer 先答 abort / rejectQuestion abort / clear abort）。
2. `pnpm vitest packages/sandore/workflow/src/workflow-engine.spec.ts`（改造后全绿；重点：L2582/L2676/L2715/L2934/L3017 由 hostSessionId 或 replyQuestion 驱动后通过）。
3. `pnpm vitest packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts`（可选，需真实 DSH boot）。
4. 手动（3090 dev 实例）：
   - **场景 A**：workflow overlay 新建实例 → 触发 ask → 主会话 composer 出问答卡、**DSH 无 question 弹窗**；composer 回答 → 引擎续跑、卡片消失。
   - **场景 B**：传 hostSessionId 启动（直接 engine/remote 调用或未来 UI 入口）→ composer 卡 + DSH 弹窗**同时出现**；composer 回答 → DSH 弹窗**自动关闭**（`question/resolved` cancelled）；反向（先答 DSH 弹窗）→ composer 卡 3s 内轮询收卡。
   - 回归：实例 abort / pause / retry 时挂着的 DSH 弹窗照常关闭（链式信号保留）。

---

## 3. 影响面清单（改动文件 + spec 断言）

### 3.1 源码改动（sandore，4 文件）

- `packages/sandore/workflow/src/interaction-manager.ts`（Options 新字段 + ask/reply/reject/cancel 的 signal 管理）
- `packages/sandore/workflow/src/schema.ts`（`reportToHost` 可选字段）
- `packages/sandore/workflow/src/workflow-engine.ts`（makeInitialState 写字段 + buildActiveInstance 注入）
- （无 UI 改动：composer 卡片关闭已由轮询 + persist 驱动；`seam.ts` Stub 无需改——reportToHost 是 InteractionManager 内部 dep，非 Service API）

### 3.2 测试改动（3 文件）

- `packages/sandore/workflow/src/interaction-manager.spec.ts`：
  - `makeDeps` 补 `reportToHost`（编译必需）。
  - 新增用例（§1.7）；现有用例默认 true 语义不变。
- `packages/sandore/workflow/src/workflow-engine.spec.ts`：
  - 改：L2582、L2676、L2715、L2934、L3017（传 hostSessionId 或转 replyQuestion）。
  - 断言改：L2615-2616（`userQuestions.calls[0].agent.id` → `'host-1'` 或改场景 A 断言 0 次）、L2954（calls=3 需 hostSessionId 场景）、L3045（agent.id → `'host-1'`）。
  - 新增：场景 A 纯卡片、场景 B 双向同步。
- `packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts`：无断言改动（自动回答走 replyQuestion）。

### 3.3 DSH 侧

- **零改动**。只读确认：`user-questions/src/index.ts`（ask L92-140，无 respond/取消 API）、`apiproxy/src/api-proxy.ts`（provider L1314-1342 signal abort 支持）、`client/runtime/src/client/sessions/session.ts`（L510-515 settle）、`ui-user-questions`（composer claim L42-44）。

---

## 4. 实施记录（2026-08-25，用户确认「按计划实施」）

1. **schema.ts**：`WorkflowTaskStateSchema` 加可选 `reportToHost: z.boolean().optional()`（旧快照缺省 true 兼容）。
2. **interaction-manager.ts**：
   - `InteractionManagerOptions` 加 `readonly reportToHost: boolean`；
   - `ask()`：门禁改为 `userQuestions !== undefined && this.deps.reportToHost`（场景 A 不上报宿主，挂起等 replyQuestion）；**每次 ask 独立 AbortController**（`questionAborts` Map，链式继承调用方 signal，promise 结算后清理）；
   - `finishQuestion` / `rejectQuestion` / `cancelMatching`：终态化后**主动 abort 该次 DSH 弹窗 signal**（场景 B 同步——composer 回答/拒绝/清理后宿主弹窗 `question/resolved` 自动关闭；abort 触发的 `failQuestion` 幂等守卫吞掉，不 reject 引擎 waiter）。
3. **workflow-engine.ts**：`makeInitialState` 写 `reportToHost: request.hostSessionId !== undefined`（崩溃恢复后仍知场景）；`buildActiveInstance` 注入 `reportToHost: state.reportToHost ?? true`。
4. **spec**：
   - interaction-manager.spec：`makeDeps` 补 `reportToHost`（默认 true）；新增场景 A（不上报、replyQuestion 驱动）与场景 B（replyQuestion 后 DSH signal aborted）用例；
   - workflow-engine.spec：5 个依赖 `userQuestions.resolveNext` 的 ask 用例（registers-pending / ask-mid / phase-flow / reject-question-emit / max-ask-rounds）改传 `hostSessionId: 'host-1'`（预置 FakeAgent('host-1') + sessions.create）；askFromSubagent 用例同步改（parentSession='host-1'、agent.id 断言）；宿主会话去污染反转断言改查 `sessions.get('host-1')`；「中间态同步」用例补 host-1 预置。
5. **验证**：typecheck ✅ / build ✅ / **795 tests + 1 skipped 全绿** ✅；dev 实例（3090）已重启生效。
6. **（追加）移除全局问答卡注册（2026-08-25 用户实测场景 A 宿主页仍出现「宿主弹窗」）**：
   - **根因**：`SandoreQuestionComposer` 注册在 `conversation.composer` slot——该 slot 挂在**所有会话页**（含宿主主代理页），且不归属 overlay 的 RunView；引擎侧 `reportToHost: false` 已正确（实例 `0e6033fc` state 实证 `reportToHost=false`、status=interacting、pending question），但宿主主代理页的 sandore 问答卡即用户看到的「宿主弹窗」（无 RunView 样式）。
   - **改动**：`ui/src/client/index.ts` 移除 `selectSandoreQuestion`、composer slot 注册与 questions-polling effect 及 `SandoreQuestionComposer`/`sandore-questions` import；删除死代码 `SandoreQuestionComposer.tsx`、`sandore-questions.ts`（仅互相引用）。**问答交互只保留 overlay RunView 内 QuestionCard（DiscussionInput 组件，有样式）。**
   - **验证**：UI typecheck ✅；完整链（typecheck+build+795 tests）✅；dev 实例（3090）重启生效。用户需强刷（Ctrl+F5）后复验场景 A：overlay 新建实例触发 ask → 仅 overlay 内 QuestionCard，宿主主代理页不再出现任何问答卡。
