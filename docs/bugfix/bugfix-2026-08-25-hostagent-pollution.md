# 修复计划核实报告：step 执行记录污染宿主主代理消息

- 日期：2026-08-25
- 范围：仅核实与计划修正（不改任何源码；sandore 与 DSH 均只读）
- 目标文件：`packages/sandore/workflow/src/workflow-engine.ts` 等（见影响面清单）

---

## 0. 结论摘要

原计划大方向正确：16 个 `emit*` 的 `session.append` 半边确实是宿主主代理消息污染的来源，删除半边 + `safeAppend` 合理。但经核实发现 **3 处必须修正**：

1. **`SessionAppendWithIgnorable` 类型（L30-34）不能删除**：`applyPermission`（L582）仍用它向宿主会话 append `sandbox/mode`（DSH known 事件，宿主 sandbox 折叠依赖，必须保留）。直接删类型会编译失败。替代方案：在 `applyPermission` 内联一个不带 `ignorable` 的窄断言 `(type: string, data: unknown) => unknown`，然后才可删顶层类型。
2. **计划漏掉了「宿主会话 Chat 页 sandore-step 节点」这一真实消费者**：UI 经 `conversationEvents.register(sandoreStepDefinition)`（`packages/sandore/ui/src/client/index.ts:45`）把宿主会话里的 `sandore/step-*` 事件折叠为 Chat 节点（`sandore-step-definition.ts`），`DagStepNodeView.tsx` 经 `conversation.chat.node` slot 渲染。**删除 append 后这些节点会消失**——这既是「去污染」的效果，也是宿主会话 Chat 页 step 卡片功能的移除（该功能提供 retry 操作入口）。计划必须明确：接受该功能移除（推荐，overlay RunView 已有完整执行详情），或为其提供替代数据源（不推荐，见 §7）。同时 `stepPhaseDefinition`（`step-phase.ts`）的 RunView 即时刷新通道失效——**但 SSE 通道（`/sandore/events`，基于 Cordis 事件）仍在**，RunView 刷新不受影响（双保险剩主通道）。
3. **调用处计数不准确**：计划称「30+ 处调用处」，实际是 **25 处调用点**（23 处单行 + 2 处跨行：L1039-1046 `emitStepMessage`、L1323-1331 `emitStepFailed`）。

其余核实项均通过：e2e（mock + real）数据源全部是 Cordis 事件（`ctx.on`）+ RPC（`getInstanceState`），不依赖宿主会话事件，删除 append 后 e2e 全部断言照常工作；engine 内部除 `applyPermission`（sandbox/mode，保留）外无任何宿主会话 `sandore/*` 事件读取点；崩溃恢复只读快照与子代理事件；fork seed 路径当前为空 seed（宿主主代理冻结无 turn/end），删除 append 是纯改进；ask/permission 闭环全部走 Cordis 事件 + RPC，不受影响。

---

## 1. 计划事实核对

### 1.1 16 个 emit* 函数（L2056-2179）——全部双发 ✅

`packages/sandore/workflow/src/workflow-engine.ts`，逐一确认每个函数都同时执行 `this.emitContained('sandore/...', [...])` + `this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/...', {...}, { ignorable: true }))`：

| # | 函数 | 行 | 事件名 |
|---|------|-----|--------|
| 1 | `emitStart` | 2056-2059 | `sandore/start` |
| 2 | `emitStageStart` | 2061-2064 | `sandore/stage-start` |
| 3 | `emitStageCompleted` | 2066-2069 | `sandore/stage-completed` |
| 4 | `emitStepStart` | 2071-2074 | `sandore/step-start` |
| 5 | `emitStepCompleted` | 2076-2079 | `sandore/step-completed` |
| 6 | `emitStepFailed` | 2081-2084 | `sandore/step-failed` |
| 7 | `emitStepPaused` | 2086-2093 | `sandore/step-paused` |
| 8 | `emitStepResumed` | 2095-2102 | `sandore/step-resumed` |
| 9 | `emitStepRetried` | 2104-2111 | `sandore/step-retried` |
| 10 | `emitStepMessage` | 2114-2117 | `sandore/step-message` |
| 11 | `emitStepPhase` | 2126-2141 | `sandore/step-phase` |
| 12 | `emitEnd` | 2143-2146 | `sandore/end` |
| 13 | `emitAborted` | 2148-2151 | `sandore/aborted` |
| 14 | `emitQuestion` | 2153-2160 | `sandore/question` |
| 15 | `emitPermission` | 2162-2169 | `sandore/permission` |
| 16 | `emitQuestionRejected` | 2172-2179 | `sandore/question_rejected` |

- `emitContained`：L2035-2046（`ctx.events.dispatch('emit', ...)` 同步分发，Cordis 事件 → SSE → UI）。
- `safeAppend`：L2048-2054 ✅ 位置与计划一致。
- `SessionAppendWithIgnorable`：L30-34 ✅ 位置与计划一致，**但见 §1.3 修正**。
- 另有第 17 个 `emitSubagentSettled`（L462-471）：只发 `sandore/subagent-settled`（`ctx.events.dispatch`），**无双发**，不在计划范围 ✅。

### 1.2 session 参数全部是宿主会话 ✅

所有调用点传入的 `session` 均来自 `ActiveInstance.session`（`buildActiveInstance` 注入，`workflow-engine.ts:1806`），其在 `startInstance` 中确定为宿主主代理会话：
- 新建：`agents.create({ sessionId: instanceId })` 后 `ctx.sessions.get(SessionId(instanceId))`（L510-524）——**宿主会话 id = instanceId**。
- 复用：`request.hostSessionId` 的既有会话（L536-549）。
- `runInstance` 解构 `const { controller, session, hostAgent, definition } = active`（L1119），后续所有 `emitXxx(session, ...)` 都指向它；另有直接 `active.session` 的调用（L680/761/775/1110）。

结论：**16 个 emit* 的 append 半边全部写进宿主主代理会话（sessionId=instanceId 或复用会话）**，正是「宿主主代理消息污染」的来源。✅

### 1.3 修正点 1：SessionAppendWithIgnorable 不能被整个删除 ⚠️

- 类型定义 L30-34，注释（L24-29）说明其用途是「旧 harness 的 Session.append 无 `ignorable` 参数时的编译期桥」。
- 实测 sandore 链接的 `@deepseek-ai/dsh-session`（`packages/sandore/workflow/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:212`）：
  ```ts
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []): SessionEvent<T>;
  ```
  **rc.6 类型面没有 `ignorable` 第三参数**，且 `SessionEventMap`（rc.6 `types.d.ts`）里**没有 `sandbox/mode` 键**（`sandbox/mode` 只在运行时 `KNOWN_SESSION_EVENT_TYPES` 里，见 `deepseek-harness/packages/core/session/src/known-event-types.ts:43`）。
- 因此 `applyPermission`（L582）的 `(session.append as SessionAppendWithIgnorable)('sandbox/mode', { mode: spec.sandbox })` **必须保留该类型桥**（或换内联窄断言），否则编译报错。`sandbox/mode` append 是宿主 sandbox 折叠的输入（`setPermissionMode` 复用 applyPermission，L1075；spec 测试 `effectiveSandboxMode(session.events)`，workflow-engine.spec.ts:1849-1888 依赖它），**必须保留**。
- **修正方案**：删类型前，先把 `applyPermission` 的 L582 改为内联窄断言：
  ```ts
  (session.append as (type: string, data: unknown) => unknown)('sandbox/mode', { mode: spec.sandbox });
  ```
  （sandbox/mode 不需要 `ignorable`——它是 DSH known 事件；运行期真实 harness 的 append 接受 3 参，传 2 参无碍。）改完才可删除 L30-34 的类型定义。

### 1.4 调用处计数：实际 25 处（计划称 30+）⚠️

`workflow-engine.ts` 内 `this.emitXxx(session|active.session, ...)` 调用点共 **25 处**：

- 单行 23 处：L680（aborted）、L761/775/1110/1129/1346/1460/1509/1570（end）、L1210（stage-start）、L1231/1232/1233/1236（step-start/completed/failed/phase 钩子）、L1434（aborted）、L1485（stage-completed）、L1563（step-failed）、L1694/1695/1696（question/permission/question_rejected）、L1723/1724（step-paused/step-resumed）、L1801（step-retried）。
- 跨行 2 处：L1039-1046（`emitStepMessage(active.session, ...)`）、L1323-1331（`emitStepFailed(session, ...)`）。

计划「30+ 处」不准确，按 25 处执行。另有 16 处函数签名里的 `session: Session` 参数 + 16 处函数体 `safeAppend` 行。

---

## 2. e2e 事件收集器数据源（关键）——全部基于 Cordis 事件，删除 append 不影响 ✅

`packages/sandore/workflow/src/workflow-engine-real-e2e.spec.ts`：

- **collector（L469-495）**：`for (const eventName of SANDBORE_EVENT_NAMES) { onSandore(bootedCtx, eventName, ...) }`，其中 `onSandore`（L132-134）是 `ctx.on` 的 string 重载——**订阅 Cordis 事件**（由 `emitContained` 的 `ctx.events.dispatch('emit')` 触发）。收集结果存 `collectedEvents`（L328、L473）。
- **[e2e] 打印（L487-492）**：在同一个 `onSandore` 回调内，`console.log` 每步事件——**同为 Cordis 事件**。
- **等待 end（L562-569）**：`onSandore(ctx, 'sandore/end', ...)` —— Cordis 事件 ✅。
- **自动回答 question（L514-534）**：`onSandore(ctx, 'sandore/question', ...)` —— Cordis 事件 ✅。
- **数据源（L573-578）**：`engine.getInstanceState(instanceId)`（RPC，快照）+ `collectedEvents.filter(e => e.taskId === instanceId)`。
- **断言（L611/L798-853 等）**：全部基于 `myEvents`（Cordis 事件投影）与 `state`（RPC 快照），逐条核对：
  - L611-614 事件序（start 首/end 末/无 aborted/end 恰一次）→ Cordis 事件 ✅
  - L669-685 step-phase 序列 → Cordis 事件 ✅
  - L783-816 事件-状态对账（step-start/retried/completed 计数）→ Cordis 事件 ✅
  - L817-833 failed 段对账 → Cordis 事件 ✅
  - L834-847 stage 对账 → Cordis 事件 ✅
  - L849-868 ask 闭环（question 事件 + 终态 pending）→ Cordis 事件 + RPC ✅

**结论：real-e2e 零依赖宿主会话事件，删除 append 后 e2e 断言全部照常工作。** mock e2e（`workflow-engine-e2e.spec.ts`）同样只用 `ctx.on`（L117/L131 等），无宿主会话事件断言 ✅。

---

## 3. sandore UI 是否读宿主会话事件——**有真实消费者（关键发现）** ⚠️

### 3.1 两个 conversationEvents 定义消费宿主会话事件流

`packages/sandore/ui/src/client/index.ts:43-48`：
```ts
ctx.conversationEvents.register(sandoreStepDefinition)
ctx.conversationEvents.register(stepPhaseDefinition)
```
`conversationEvents`（DSH client-runtime）的 assembler 是 **Session 拥有、消费会话事件流**（`deepseek-harness/packages/client/runtime/src/client/sessions/conversation-assembler.ts`：`append(input)`/`replaceWindow(entries)` 的输入是 `ConversationEventInput { event, view }`，由 wire history rows / live 事件推送而来——`session.ts:787-788` `conversationInput(entry)`；live 事件来自 `acceptLiveEvent` → `appendLive`）。**它不是 Cordis 事件通道**。

因此：
- **`sandoreStepDefinition`**（`sandore-step-definition.ts:101-205`，kind `sandore-step`、target `chat`）：把宿主会话事件流里的 `sandore/step-start|completed|failed|paused|resumed|retried|phase` 折叠为 **Chat 节点**；`DagStepNodeView.tsx` 经 `conversation.chat.node` slot（index.ts:161-178）渲染，并提供 `retryStep` / `listRevertBoundaries` 操作入口。
  - **删除 append 后：宿主会话 Chat 页不再显示 sandore-step 节点**——这是「宿主主代理消息污染」在 UI 侧的消除（用户诉求），同时意味着该刻意实现的 Chat 卡片功能（含 retry 入口）移除。
- **`stepPhaseDefinition`**（`step-phase.ts:56-71`，kind `sandore-step-phase`，无 target）：`match` 命中 `sandore/step-phase` → `start` 触发模块级通知 → RunView `subscribeStepPhase`（RunView.tsx:153-158）立即刷新。
  - **删除 append 后此通道失效**；但 RunView 还有 **SSE 通道**（RunView.tsx:162-168 `subscribeSandoreSse`）——`/sandore/events`（`workflow/src/sse.ts`）订阅的是 **Cordis 事件**（`ctx.on(eventName)`，sse.ts:98-100），由 `emitContained` 半边驱动。**SSE 是主刷新源，删除 append 后 RunView 刷新仍即时**（step-phase 通道只是「双保险」，RunView.tsx:161 注释明言）。

### 3.2 UI 其它会话读取点——均不依赖宿主会话 sandore/* 事件 ✅

- `open-discussion.ts`：`createOpenDiscussion` 只是 `sessions.open(instanceId)` 跳转宿主会话页（L27-31），不读事件。
- `remote.ts`：纯 RPC 封装（`unwrap` / `SandoreRemoteError`）。
- `RunView.tsx` 主数据源：`remote.getInstanceState(instanceId)` + `getArtifacts`（L103-118，RPC）✅。
- `InstanceList.tsx`：`listInstances` RPC + SSE 刷新（L122-152）✅。
- `StepChatPanel.tsx`：`sessions.binding(childId)` 订阅**子代理**会话快照（L78-81、L200），非宿主会话 ✅。
- `sandore-questions.ts`：RPC 轮询 `getInstanceState` 聚合 pending question（L95-118），非会话事件 ✅。
- `index.ts` 权限投影：`sessions.sessionOf(scope)` 读 `projections.permissions`（L121-135），与 sandore/* 无关（依赖 `sandbox/mode`，保留）✅。

### 3.3 结论

UI 对宿主会话 `sandore/*` 事件的消费**只有 conversationEvents 两个注册**。删除 append 后：
- 宿主会话 Chat 页 sandore-step 节点消失（污染消除，功能移除）。
- RunView 即时刷新由 SSE 完全覆盖。
- `sandoreStepDefinition` / `stepPhaseDefinition` 变为永不命中的死注册——建议同步移除注册（index.ts:45、48）与 `conversation.chat.node` slot（index.ts:161-178），否则保留无意义空定义；`DagStepNodeView.tsx` 若仅服务于该 slot 也一并停用。

---

## 4. engine 内部读宿主会话事件的点——除 sandbox/mode 外无其它 ✅

- `applyPermission`（L575-594）：append `sandbox/mode`（**保留**）+ `approval.setPolicy`。
- `setPermissionMode`（L1064-1080）：复用 applyPermission（保留）。
- `recoverInstance`（L696-747）：`ctx.agents.resume` 冷恢复宿主主代理 + `ctx.sessions.get(SessionId(instanceId))` 取会话对象（L728）——**读的是会话本体，不是 sandore/* 事件**；崩溃恢复的业务状态完全来自 sandore 持久化快照（`persistence.state.get`，L708）+ `recovery.recover()`（只遍历快照 executedSteps，followup 子代理——`recovery-manager.ts:349-378`）✅。
- `getStepSessionEvents` / `forkSession` / `getSession`（L1159-1176、1183-1198、1761-1800）：读的是**子代理**会话事件（childId），用于 finalize/retry 的 fork seed，与宿主会话 sandore/* 无关 ✅。
- `L728/L1661` 等 `ctx.sessions.get`：读会话存在性/子代理事件，非宿主 sandore/* ✅。
- `step-runner.ts` / `stage-executor.ts` / `finalize-manager.ts`：只读子代理 `child.session.events`（`finalAssistantOutput`、`collectSessionMessages`）✅。

### 4.1 fork seed 路径——当前为空 seed，删除 append 是改进 ✅

DSH `fork` provider（`deepseek-harness/packages/subagent/subagent-fork-in-process/src/index.ts:48-54,83-89`）：
```ts
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  const events = parent.session.events
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  return events.slice(0, lastEnd.seq + 1)
}
```
sandore Step 子代理经 `subagents.startContinuable({ provider: 'fork', parent: 宿主主代理 })`（`step-runner.ts:474-487`）。宿主主代理工作流期间**被冻结**（park-parent，`frozenHostAgents`，L564/L741），**从不执行模型 turn → 宿主会话无 `turn/end` → `completedTurnPrefix` 返回 [] → 子代理 fresh、seed 为空**。

结论：
- **当前**：宿主会话的 sandore/* 事件并不会进入子代理 seed（无闭合 turn）——删除 append 不改变当前子代理上下文。
- **潜在通道**：若未来宿主主代理在含 sandore/* 事件的会话上产生过 turn（如工作流结束后解冻、用户续聊产生 turn/end，再 fork 子代理），`completedTurnPrefix` 会把全部 sandore/* 事件带进子代理 seed（子代理日志/持久化/会话页出现噪音）。**删除 append 后此潜在污染通道一并消除——纯改进** ✅。
- mock 侧佐证：`subagents.spec.ts:164-177`（FakeSessionStore fork 测试）演示了「源会话含 sandore/start、step-start → fork 携带这些事件」的机制；该测试是独立 mock 单元测试，不受删除影响（它自造数据）。

### 4.2 崩溃恢复——不读宿主事件 ✅

见 §4 的 recoverInstance 分析：恢复完全基于 sandore 持久化快照 + 子代理 followup 冷恢复。宿主会话 sandore/* 事件（若保留）只会增大宿主会话持久化体积，删除后恢复逻辑零改动。

---

## 5. ask / permission 闭环——全部走 Cordis 事件 + RPC，删除 append 后闭环完好 ✅

- `emitQuestion`/`emitPermission`/`emitQuestionRejected` 的 **Cordis 半边**（`emitContained`）是闭环数据通道：
  - e2e 自动回答：`onSandore(ctx, 'sandore/question', ...)`（real-e2e L514-534）→ Cordis 事件 ✅
  - UI 弹窗：`sandore-questions.ts` **RPC 轮询** `getInstanceState` 聚合 pendingInteractions（L95-118）→ 不依赖会话事件 ✅
  - composer 条目：`SandoreQuestionComposer` 读 `getSandoreQuestions()`（store）✅
- **engine 内部无任何 `ctx.on('sandore/question')` 监听器**（grep 全仓确认）；`replyQuestion`/`rejectQuestion`/`replyPermission` 是 RPC → `interactionManager.replyQuestion`（内存 Map）→ 不读宿主事件 ✅。
- `InteractionManager` 的 `emitQuestion` 回调在 `buildActiveInstance` 中绑定（L1694-1696），`emitContained` 同步分发，回答链路（`userQuestions.ask` → waiter → `replyQuestion` resolve）不经过宿主会话 ✅。

**结论：删除 3 个 ask/permission 相关 emit* 的 append 半边，ask 闭环完好。**（interaction-manager.spec.ts:254-255 只断言 `emitQuestionRejected` mock 被调用——Cordis 半边，不受影响。）

---

## 6. 会因删除 append 而失败的 spec 断言清单（含改法）

grep 全仓 `sessions.get(...)?.events` + `sandore/` 与 `.events.some/map`，共 6 处断言直接失败（另有 `effectiveSandboxMode` 3 处为 `sandbox/mode`，**不失败**）：

| # | 文件:行 | 当前断言 | 删除 append 后 | 改法 |
|---|---------|----------|----------------|------|
| 1 | `workflow-engine.spec.ts:1488-1499` | `session?.events.map(e => e.type)` 全等 `['sandore/start', ... 10 项 ...]`（「事件双发：宿主 Session 记录同序事件」） | 宿主会话 events 不再含 sandore/*（仅可能含 sandbox/mode 等） | 改为**方向反转断言**：`expect(session?.events.some(e => e.type.startsWith('sandore/'))).toBe(false)`，并加注释「宿主会话不再承载 sandore/* 事件（去污染）；Cordis 事件断言见 L1473-1484 records」。 |
| 2 | `workflow-engine.spec.ts:2788` | `sessions.get(run.instanceId)?.events.some(e => e.type === 'sandore/step-phase')` toBe true（「双发 sandore/step-phase」） | 恒 false | 删除该行（Cordis 半边断言在 L2771-2785 records 已覆盖）；或改为 `toBe(false)` 断言「不再 append 到宿主会话」。**推荐删除**（L2771-2785 已断言 phase 事件载荷）。 |
| 3 | `workflow-engine.spec.ts:3261` | `.events.some(e => e.type === 'sandore/step-retried')` toBe true（「双发」） | 恒 false | 删除该行（L3245/L3259 `retried` 数组已断言 Cordis 半边）。 |
| 4 | `workflow-engine.spec.ts:3987` | `.events.some(e => e.type === 'sandore/step-message')` toBe true | 恒 false | 删除该行（L3982-3986 `messageEvents` 已断言 Cordis 半边）。 |
| 5 | `workflow-engine.spec.ts:4033` | 同 4（`step-message`） | 恒 false | 删除该行（L4032 `messageEvents` 已断言）。 |
| 6 | `lifecycle-manager.spec.ts:251` | `session?.events.some(e => e.type === 'sandore/step-paused')` toBe true（「双发」） | 恒 false | 删除该行（L244-249 records 已断言 Cordis 半边载荷）。 |

**不失败的断言（保留）**：
- `workflow-engine.spec.ts:1880/1888/1936/1944` `effectiveSandboxMode(session.events)` —— `sandbox/mode` append 保留 ✅。
- `workflow-engine.spec.ts:1236` `sessionTitle.calls[0]?.session` toBe sessions.get(...) —— 会话对象引用，非事件 ✅。
- `host-agent.spec.ts:77/90` `sessions.get('inst-1')` 存在性 ✅。
- `subagents.spec.ts:164-177` fork mock 单元测试（自造数据）✅。
- `interaction-manager.spec.ts:254-255` emitQuestionRejected mock 断言（Cordis 半边）✅。
- `sandore-step-definition.spec.ts` / `step-phase.spec.ts`：纯 definition 单元测试（构造事件信封），**若保留死注册则仍通过**；若按 §3.3 移除注册文件，则相应 spec 一并删除/停用。
- real/mock e2e：见 §2，全部不受影响 ✅。

---

## 7. 其它风险

### 7.1 `sandore/end` / `sandore/start` 的 append 消费者——无 ✅
- UI：`sandoreStepDefinition` 只 match step-*（不含 start/end）；`stepPhaseDefinition` 只 match step-phase；DSH 未知事件 fallback（`ui-conversation/src/client/conversation-nodes/fallback.ts`）只 match **surface 事件**（`isAppendSurfaceEvent` 只认 `user/message`/`assistant/message`/`tool/result`，`deepseek-harness/packages/core/session/src/surface.ts:15-19,51-55`）——`sandore/start`/`end` 非 surface，**不渲染任何节点**。
- SSE：走 Cordis 事件（sse.ts `ctx.on`），与 append 无关。
- 引擎/DSH 侧：无消费点。
- **结论：可安全删除。**

### 7.2 宿主会话 sandore/* 事件与 checkpoint / 投影 / 搜索索引——无依赖 ✅
- `session-checkpoint-policy`：按 turn 边界 flush 持久化（`deepseek-harness/packages/session/session-checkpoint-policy`），不按事件类型选择；sandore/* 若存在只会随日志一起落盘，删除后日志更小，checkpoint 逻辑零依赖。
- 投影（`projections.permissions`）：读 `sandbox/mode`（保留）✅。
- 搜索索引（`session-query-sqlite`）：索引 surface 消息（`deriveEventMessage` 派生），sandore/* 非 surface **本就不进索引**，删除无影响 ✅。
- 会话事件 → LLM 上下文：`deriveEventMessage`（`surface.ts:83-114`）只对 surface 三型派生消息，sandore/* 永远不进入模型可见 surface——**「污染宿主主代理消息」是 UI 展示 + 日志膨胀问题，不是模型上下文注入问题**；删除 append 消除 UI 污染与日志膨胀 ✅。

### 7.3 `ignorable: true` 语义确认 ✅
`deepseek-harness/packages/session/session-persistence/src/coordinator.ts:1061-1066` `assertEventsSupported`：持久化重建时，事件类型不在 `KNOWN_SESSION_EVENT_TYPES`（`known-event-types.ts:19-68`，sandore/* 不在其中）且未标记 `ignorable: true` → **拒绝解释整个日志**。`ignorable` 只影响持久化层容错（允许未知事件跳过），**不影响会话渲染/UI、不影响 conversationEvents、不影响 surface**。删除 append 后该问题随事件消失（宿主会话不再含 out-of-repo 事件，未来旧 harness 重建日志也不会被拒）。

### 7.4 决策项：宿主会话 Chat 页 sandore-step 节点（计划未覆盖）⚠️
`sandoreStepDefinition` + `DagStepNodeView`（含 retryStep 操作入口）是 sandore 刻意实现的「宿主会话 Chat 页 step 卡片」功能（index.ts:43-48 注释「不依赖 remote.sandore」）。删除 append 直接移除该功能。
- **推荐**：接受移除（宿主会话保持干净 = 用户诉求；执行详情在 overlay RunView 完整呈现，retry 操作也在 RunView 可用）。
- **替代方案**（若需保留 Chat 卡片）：改为在 client 端订阅 SSE（`/sandore/events`，Cordis 事件）自行折叠渲染，或保留 append 仅对非 step-* 事件。**不推荐**：SSE 是全局广播、无 seq/顺序语义，重建折叠状态需要额外设计；且与「去污染」目标相悖。
- **计划必须**：明确上述取舍，并同步处理死注册（§3.3）。

---

## 8. 修正版修复计划

### 改动点（全部在 sandore 工作区；DSH 零改动）

**A. `packages/sandore/workflow/src/workflow-engine.ts`**
1. `applyPermission` L582：改为内联窄断言（先于删类型执行）：
   ```ts
   (session.append as (type: string, data: unknown) => unknown)('sandbox/mode', { mode: spec.sandbox });
   ```
2. 删除 16 个 `emit*` 函数体中的 `this.safeAppend(...)` 行（L2058/2063/2068/2073/2078/2083/2092/2101/2110/2116/2136-2140/2145/2150/2159/2168/2178）。
3. 删除 16 个 `emit*` 函数签名中的 `session: Session,` 参数（L2056/2061/2066/2071/2076/2081/2086/2095/2104/2114/2126-2128/2143/2148/2153/2162/2172）——`emitStepPaused`/`emitStepResumed`/`emitStepRetried`/`emitQuestion`/`emitPermission`/`emitQuestionRejected` 的 `active` 参数变为首参。
4. 删除 25 处调用点的 `session`/`active.session` 实参（23 处单行 + 跨行 L1039-1040、L1323-1324），同步调整缩进与换行。
5. 删除 `safeAppend` 方法（L2048-2054）。
6. 删除 `SessionAppendWithIgnorable` 类型（L30-34）及其注释（L24-29）；同步检查 `Session` 类型 import（L18）是否仍被使用（applyPermission 签名仍用 `Session`）。
7. 更新文件头注释（L10-11「双发 `sandore/*` 事件（`ctx.emit` + 宿主 Session `append`）」→ 改为「单发 `sandore/*` 事件（`ctx.emit` → SSE → UI）」）；更新 `emitStepMessage`（L2113）与 `emitStepPhase`（L2119-2125）的「双发」注释。
8. `buildActiveInstance`（L1694-1696/1723-1724/1801）与 `runInstance`（L1119 `const { controller, session, ... }` 中 `session` 若仅剩 applyPermission 用途则保留，若无处用则从解构移除——注意 L1075 `applyPermission(active.session, ...)` 仍需要）。

**B. `packages/sandore/ui/src/client/index.ts`（去污染配套）**
9. 删除 `ctx.conversationEvents.register(sandoreStepDefinition)`（L45）与 `ctx.conversationEvents.register(stepPhaseDefinition)`（L48）——避免死注册（若保留死注册无害，但建议清理）。
10. 删除 `conversation.chat.node` slot 注册（L161-178，DagStepNodeView）——若步骤 9 执行则此 slot 永远无输入。
11. 删除相应 import（`sandoreStepDefinition`、`stepPhaseDefinition`、`DagStepNodeView`）与 `RunView.tsx` 的 `subscribeStepPhase` 订阅（L153-158；SSE 已覆盖）。

**C. spec 适配**
12. `workflow-engine.spec.ts`：L1488-1499 改为方向反转断言（§6 #1）；删除 L2788、L3261、L3987、L4033（§6 #2-5）。
13. `lifecycle-manager.spec.ts`：删除 L251（§6 #6）。
14. 若执行 B-9/10/11：删除 `sandore-step-definition.spec.ts`、`step-phase.spec.ts`（若 definition 文件移除）或保留纯单测（定义仍在则测试仍过）。

**D. 可选清理（建议）**
15. `workflow-engine.ts` 顶层注释（L5-13）与 `sse.ts` 注释同步；`seam.ts` 的 SessionEventMap 合并（L69-94）可保留（类型声明无害，供 UI 定义 match 类型；若 UI definition 移除则一并删）。

### 验证步骤
1. `pnpm --filter @deepseek-ai/dsh-sandore-workflow exec vitest run`（或按 AGENTS.md 的工作区测试命令）跑全量单测——预期：workflow-engine.spec / lifecycle-manager.spec 通过（适配后）；e2e mock（`workflow-engine-e2e.spec.ts`）通过；interaction/subagents/host-agent 等不回归。
2. `pnpm --filter @deepseek-ai/dsh-client-ui-sandore exec vitest run` 跑 UI 单测（若保留 definition 文件则其 spec 仍过；若移除则相应 spec 删除）。
3. TypeScript 编译检查：确认删类型后 `applyPermission` 用内联窄断言编译通过、无残留 `SessionAppendWithIgnorable` 引用。
4. dev 实例手动验证（3090 端口，`--patch D:\project-code\llm\sandore\cordis.yml`）：跑一个工作流，确认（a）宿主会话（instanceId）Chat 页无 sandore-step 卡片、（b）overlay RunView 执行详情/刷新/ask 弹窗/收尾阶段流转即时更新（SSE 通道）、（c）`/sandore/events` SSE 仍广播全部事件、（d）`setPermissionMode` 切换后权限折叠生效（sandbox/mode 保留）。
5. real-e2e（可选，需密钥）：`workflow-engine-real-e2e.spec.ts` 全绿（证明删除 append 不影响真实链路）。

### 不做的
- 不修改 DSH 源码（`deepseek-harness` 只读）。
- 不创建分支（AGENTS.md：直接 main 开发）。
- 不动 `sandbox/mode` append（L582）与 `approval.setPolicy`。

---

## 9. 实施记录（2026-08-25，用户确认「按修正版计划实施」）

已按修正版计划落地：

1. **workflow-engine.ts**：16 个 `emit*` 删除 `session.append` 半边与 `session` 参数；`applyPermission` 改内联窄断言（sandbox/mode 保留）；删除 `safeAppend` 方法与 `SessionAppendWithIgnorable` 类型；25 处调用点去 `session` 实参；`handleRejectedQuestion` 去 `session` 参数；`runInstance` 解构去 `session`；文件头与「双发」注释全部改「单发」。
2. **UI 去污染配套**：`index.ts` 删除 `conversationEvents.register(sandoreStepDefinition/stepPhaseDefinition)`、`conversation.chat.node` slot（DagStepNodeView）与相应 import，`inject` 去掉 `conversationEvents`；`RunView.tsx` 删除 `subscribeStepPhase` 订阅（SSE 为唯一即时刷新源）；删除 `sandore-step-definition.ts`/`step-phase.ts`/`DagStepNodeView.tsx`（+ css）及其 2 个 spec（宿主会话 Chat 页 sandore-step 卡片随去污染移除，retry 入口仍在 overlay RunView）。
3. **spec 适配**：`workflow-engine.spec.ts` L1486-1499 改方向反转断言（宿主会话不再含 sandore/*）、L2777-2778 反转、删除 L3250-3252/L3971-3977/L4021-4022 的宿主会话断言；`lifecycle-manager.spec.ts` L244-251 删除宿主会话断言。
4. **验证**：typecheck ✅ / build ✅ / **790 tests + 1 skipped 全绿** ✅（净减 41 个测试 = 删除的 Chat 卡片定义与 step-phase spec）；dev 实例（3090）已重启生效。

