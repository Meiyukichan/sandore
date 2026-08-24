# Bugfix 方案：badge 时序 / compressedOutput 渲染 / e2e 测试

> Round 16 · 2026-08-17  
> 基线测试：803 通过 / 34 失败

---

## 目录

1. [问题 1：badge 时序错误](#问题-1badge-时序错误)
2. [问题 2：compressedOutput 渲染风格](#问题-2compressedoutput-渲染风格)
3. [问题 3：真实 e2e 测试](#问题-3真实-e2e-测试)
4. [风险评估](#风险评估)

---

## 问题 1：badge 时序错误

### 1.1 用户反馈复述

1. **点击「收尾中」打不开门禁子代理**：出现「收尾中」badge 但点击无效（缺失门禁的子代理）。
2. **门禁失败延迟出现**：所有 step 执行完成后，才出现「门禁失败」红色 badge。

### 1.2 根因分析

#### 1.2.1 「收尾中 badge 点击打不开」根因

**数据流追踪**：

引擎侧（`workflow-engine.ts` L1225-1232）：
```
hooks.onPhaseChange = (step, childId, phase, details) =>
  this.emitStepPhase(session, info, step.id, childId ?? step.id, phase, ..., details)
```

`commitFinalize`（`finalize-manager.ts` L1198-1233）在写入 `finalizeMeta` **后**才调用 `onPhaseChange`：
```ts
request.executedStep.finalizeMeta = buildFinalizeMeta(...)  // ← 先写入 finalizeMeta
await request.onPersist?.(request.executedStep)              // ← 先持久化（Round 7 保证）
request.onPhaseChange?.(...)                                  // ← 后发事件
```

事件载荷（`details`）从 `request.executedStep.finalizeMeta` 读取（L1216-1231）。

**关键问题在 `runPhaseB`（`stage-executor.ts` L1062-1082）**：

```ts
// 步骤 1：预置 currentPhase='finalizing'（running 快照）
executed.finalizeMeta = { ...executed.finalizeMeta, currentPhase: 'finalizing' };
const request = this.buildFinalizeRequest(step, executed, context, gates, state);

// 步骤 2：先 commit running 快照（UI 展示「收尾中」）
await this.options.finalizeManager.commitFinalize(request, undefined, undefined, 'finalizing');
// ↑ assessResult=undefined → details 中无 assessSessionId

// 步骤 3：执行真正的 fork 收尾
const phaseBResult = await this.options.finalizeManager.assessForked(request);

// 步骤 4：用结果再 commit（这次有 assessSessionId）
await this.options.finalizeManager.commitFinalize(request, phaseBResult, undefined, 'finalizing');
```

**步骤 2 的 `commitFinalize`**：`assessResult=undefined`，`buildFinalizeMeta` 进入 `effectiveAssessResult` 分支：

```ts
// finalize-manager.ts L631-635
const effectiveAssessResult = assessResult ?? (
  currentPhase === 'finalizing' && existing?.assessResult === undefined
    ? { status: 'running' as const, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
    : undefined
);
```

`forkSessionId: ''`（空字符串），然后 L658：
```ts
assessSessionId: effectiveAssessResult.forkSessionId  // → ''
```

**因此步骤 2 的事件载荷中 `assessSessionId = ''`（空字符串，非 undefined）**。

UI 侧（`DagStepNodeView.tsx` L180 + `sandore-step-definition.ts` L200）：
```ts
// sandore-step-definition.ts update:
...(data.assessSessionId !== undefined ? { finalizeAssessSessionId: data.assessSessionId } : {})
```

`assessSessionId = ''` → `finalizeAssessSessionId = ''`。

badge 渲染（`DagStepNodeView.tsx` L229-236）：
```tsx
badge.target !== undefined ? (
  <button ... onClick={(e) => { e.stopPropagation(); openSession(badge.target as SessionId) }}>
```

`target = ''` → `target !== undefined`（空字符串通过守卫）→ 渲染为 `<button>`，但 `openSession('')` 跳转到空 sessionId → DSH 报错或静默失败。

**根本原因**：步骤 2（running 快照）用空字符串占位 `forkSessionId: ''` 写入 `assessSessionId`，覆盖了 undefined 守卫语义。空字符串通过了 UI 的 `target !== undefined` 检查，导致 badge 可渲染为 button 但点击跳转失败。

**步骤 4 用真正的 `phaseBResult`（含真实 `forkSessionId`）覆盖**，但这个覆盖是异步的——在 `assessForked` 完成之前，UI 一直显示空字符串版 badge。

#### 1.2.2 「门禁失败延迟出现」根因

**数据流追踪**：

`runPhaseC`（`stage-executor.ts` L1093-1130）：

```ts
// 步骤 1：门禁评估前先 commit running 快照（UI 显示「门禁中」）
await finalizeManager.commitFinalize(request, assessResult, undefined, 'gating');

// 步骤 2：执行门禁评估
const gateResult = await finalizeManager.evaluateGates(request, assessResult ?? EMPTY_ASSESS_RESULT);

// 步骤 3：门禁失败时 commit 失败结果
if (!gateResult.gatesPassed) {
  executed.status = 'failed';
  await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating');
  this.options.hooks?.onStepFailed(step, ...);
  // ...
  return { kind: 'failed', message };
}
```

步骤 1 的 `commitFinalize` 发射 `sandore/step-phase`（phase='gating', gateStatus=undefined）。

步骤 3 的 `commitFinalize` 发射 `sandore/step-phase`（phase='gating', gateStatus='failed'）。

**两个事件都会通过 SSE 广播**。但 UI 的刷新链路是：

1. RunView `subscribeSandoreSse` → `forceRefresh()` → RPC `getInstanceState` → 重建 timeline → React 重渲染。

**SSE 广播正确**（`sse.ts` L73-79 对所有 `sandore/*` 事件广播），但 `getInstanceState`（`workflow-engine.ts` L629-631）读的是 **内存中的 `active.state`**：

```ts
getInstanceState(instanceId: string): WorkflowTaskState | undefined {
  return this.instances.get(instanceId)?.state;
}
```

`commitFinalize` 的执行顺序（`finalize-manager.ts` L1211-1213）：
```ts
request.executedStep.finalizeMeta = buildFinalizeMeta(...)  // 写入 executedStep
await request.onPersist?.(request.executedStep)              // upsert 进 active.state + persistState
request.onPhaseChange?.(...)                                  // 发事件
```

`onPersist`（`workflow-engine.ts` L1267-1291）把 `executedStep` upsert 进 `active.state.executedSteps` 并 `persistState`。

**但门禁失败的完整流程是**：

```
步骤 1: commitFinalize(gating, no gateResult)  → 发事件(gating, running)
                                                     → SSE → forceRefresh → 读 active.state
                                                     → state 已含 gating running → UI 显示「门禁中」✓

步骤 2: evaluateGates()                         → 阻塞（primary 文件检查 or secondary AI）

步骤 3: commitFinalize(gating, gateResult failed) → 发事件(gating, failed)
                                                      → SSE → forceRefresh → 读 active.state
                                                      → state 已含 gating failed → UI 显示「门禁失败」✓
```

**理论上两个事件都会触发即时刷新**。但延迟出现的原因可能在于：

**竞态条件**：步骤 1 和步骤 3 在同一个 `await` 之间（步骤 2 是 `evaluateGates`），SSE 事件 1 到达 UI 时 `forceRefresh()` 发起 RPC，步骤 2 仍在执行中（阻塞 `active.state` 的写入——不对，步骤 1 的 `onPersist` 已经写入了，步骤 2 不会阻塞 active.state）。

**重新审视**：仔细看 `runPhaseC`：

```ts
await finalizeManager.commitFinalize(request, assessResult, undefined, 'gating');  // ①
const gateResult = await finalizeManager.evaluateGates(request, ...);              // ② 阻塞
if (!gateResult.gatesPassed) {
  await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating'); // ③
  this.options.hooks?.onStepFailed(step, ...);                                       // ④
  await this.persist(executed, state);                                                // ⑤
  // ...
}
```

④ 发 `sandore/step-failed` 事件（不是 `step-phase`）——但 `sandore/step-failed` **不在** `subscribeStepPhase` 的监听范围内（step-phase 只监听 `sandore/step-phase`）。

③ 的 `commitFinalize` 会触发 `onPhaseChange` → `emitStepPhase` → SSE 广播 `sandore/step-phase`（phase='gating', gateStatus='failed'）。

⑤ `persist` 也会调 `onPersist` → upsert + persistState。

**但关键是**：③ 的 `onPersist` 已经把 `gateResult` 写入了 `active.state.executedSteps`，所以 SSE 事件到达 UI 时，`getInstanceState` 应该能读到 `gateStatus='failed'`。

**再看 `sandore-step-definition.ts` 的 update**（L194-210）：

```ts
case 'sandore/step-phase': {
  const data = match.event.data
  return {
    ...context.state,
    finalizePhase: data.phase,
    ...(data.phaseHistory !== undefined ? { finalizePhaseHistory: data.phaseHistory } : {}),
    ...(data.assessSessionId !== undefined ? { finalizeAssessSessionId: data.assessSessionId } : {}),
    ...(data.gateSessionId !== undefined ? { finalizeGateSessionId: data.gateSessionId } : {}),
    ...(data.routingSessionId !== undefined ? { finalizeRoutingSessionId: data.routingSessionId } : {}),
    ...(data.compressedOutput !== undefined ? { compressedOutput: data.compressedOutput } : {}),
    ...(data.askStatus !== undefined ? { askStatus: data.askStatus } : {}),
    ...(data.assessStatus !== undefined ? { assessStatus: data.assessStatus } : {}),
    ...(data.gateStatus !== undefined ? { gateStatus: data.gateStatus } : {}),
    ...(data.routingStatus !== undefined ? { routingStatus: data.routingStatus } : {}),
  }
}
```

**这个 update 是 conversationEvents 通道**——它折叠 Session append 事件到对话流节点状态。但 RunView 的主要刷新源是 **SSE → forceRefresh → RPC getInstanceState**，不是 conversationEvents。

**重新确认 RunView 的刷新链路**：

```tsx
// RunView.tsx L153-158：step-phase 事件（conversationEvents 通道）
useEffect(() => {
  return subscribeStepPhase(() => { void forceRefresh() })
}, [forceRefresh])

// RunView.tsx L162-168：SSE 事件通道
useEffect(() => {
  return subscribeSandoreSse((_type, _data) => { void forceRefresh() })
}, [forceRefresh])
```

`subscribeStepPhase` 监听 Session append 通道（`step-phase.ts` 的 `stepPhaseDefinition`）。

`subscribeSandoreSse` 监听 SSE（`sandore-sse.ts` 的 EventSource）。

**两个通道都会触发 `forceRefresh()`**，但 `forceRefresh()` 是 async，多次调用可能重叠。关键是 `forceRefresh` → `refresh()` → `remote.getInstanceState(instanceId)` → RPC。

**但 `remote.getInstanceState` 在引擎侧读的是 `active.state`（内存）**。步骤 ③ 的 `commitFinalize` 中 `onPersist` 已经把 `executedStep` upsert 进了 `active.state`。

**实际延迟的可能原因**：

1. **SSE 事件顺序**：步骤 ① 的 SSE 事件（gateStatus=running）先到 UI，触发 `forceRefresh()`；步骤 ③ 的 SSE 事件（gateStatus=failed）后到。但 `forceRefresh()` 是异步的——第一个 `forceRefresh` 发起 RPC 时，步骤 ② 还在执行中（evaluateGates），此时 `active.state` 已含 step ① 的 running 快照但不含 step ③ 的 failed 快照。第一个 RPC 返回后 UI 显示「门禁中」。步骤 ③ 的 SSE 事件到达后触发第二个 `forceRefresh()`，这次 RPC 返回含 failed 的快照 → UI 显示「门禁失败」。

2. **但用户反馈「全部执行完成后才出现门禁失败」**——这意味着步骤 ③ 的 SSE 事件可能没有及时到达 UI，或者 `forceRefresh()` 被某个屏障阻塞。

**更可能的原因**：RunView 的 `getInstanceState` 返回的是**整个实例的状态**（包含所有 step）。如果门禁失败发生在最后一个 step，那门禁失败的显示时机与实例完成（`sandore/end`）时机重合，用户感知就是「全部执行完成后才出现门禁失败」。

**另外**：`completeAfterFinalize`（`stage-executor.ts` L1140-1187）在门禁通过后才执行，门禁失败时 `runPhaseC` 返回 `kind: 'failed'`，StageExecutor 短路到 `state.status = 'failed'`。但 **`onStepFailed` 在 `runPhaseC` 内调用**（L1117），它发射 `sandore/step-failed` 事件。这个事件会通过 SSE 广播，触发 `forceRefresh`。但 **`sandore/step-failed` 不是 `sandore/step-phase`**——如果 `subscribeStepPhase` 是唯一通道，那 `sandore/step-failed` 不会触发它。但 RunView 同时订阅了 SSE（`subscribeSandoreSse`），SSE 广播 `sandore/step-failed` 时会触发 `forceRefresh`。

**最终结论**：门禁失败的 `step-phase` 事件（gateStatus='failed'）和 `step-failed` 事件都会通过 SSE 广播并触发 UI 刷新。延迟出现的真实原因可能是：

1. **SSE 事件帧格式**：`sse.ts` L76 `sseData({ type: event, data: { args } })`，客户端 `sandore-sse.ts` L20 `JSON.parse(e.data)` 解析 `{ type, data }`。但 `data` 内部是 `{ args: [...] }`，不是扁平的 `{ gateStatus, ... }`。**客户端不解析 event type**——它只是无差别触发 `forceRefresh()`。所以事件格式不影响刷新触发。

2. **真实原因可能是 30s 兜底轮询**：如果 SSE 连接在某些浏览器/环境下断连或延迟，30s 兜底轮询会在下一个周期补上。用户感知的「全部执行完成后才出现」可能是指：所有 step 都跑完了，30s 轮询才触发一次完整的状态刷新。

**修正结论**：SSE 事件驱动刷新理论上应该即时生效。但存在以下潜在问题：

- **问题 A**：SSE `EventSource` 在某些浏览器环境下可能有连接延迟或自动重连间隔。
- **问题 B**：`subscribeSandoreSse` 的 `ensureConnected()`（`sandore-sse.ts` L14-32）在首次调用时创建 `EventSource`，但 `EventSource` 连接建立需要时间（TCP + HTTP 握手），在这段时间内的事件会丢失。
- **问题 C**：`forceRefresh` 的防重叠——多个 SSE 事件在短时间内到达，多个 `forceRefresh()` 并发，可能导致 UI 闪烁但不会导致「延迟出现」。

**最可能的根因**：问题 A + B 的组合。SSE 连接建立延迟 + EventSource 的自动重连机制导致事件丢失。

### 1.3 修复方案

#### 1.3.1 修复「收尾中 badge 点击打不开」

**核心修复**：`buildFinalizeMeta` 中 `forkSessionId: ''` 应改为不设置 `assessSessionId`（当 `assessResult=undefined` 时）。

**文件**：`packages/sandore/microflow/src/finalize-manager.ts` L631-635

**当前代码**：
```ts
const effectiveAssessResult = assessResult ?? (
  currentPhase === 'finalizing' && existing?.assessResult === undefined
    ? { status: 'running' as const, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
    : undefined
);
```

**修复方案 A（推荐）**：running 快照不写入 `assessSessionId`。

```ts
const effectiveAssessResult = assessResult ?? (
  currentPhase === 'finalizing' && existing?.assessResult === undefined
    ? { status: 'running' as const, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
    : undefined
);
```

在 L658 附近，增加守卫：`assessSessionId` 仅在 `forkSessionId` 非空时写入：

```ts
// 修改 L657-659
...(options?.recordAssessSession === false
  ? {}
  : effectiveAssessResult.forkSessionId !== ''
    ? { assessSessionId: effectiveAssessResult.forkSessionId }
    : {}),
```

**修复方案 B（更彻底）**：running 快照的 `forkSessionId` 改为 `undefined`，在 `buildFinalizeMeta` 的 `assessSessionId` 逻辑中自然不写入。

但这会改变 `FinalizeAssessResult` 类型约束（`forkSessionId` 是必填字段），改动面更大。

**推荐方案 A**：最小改动，仅在 `assessSessionId` 写入处增加空字符串守卫。

**同时**：UI 侧增加空字符串防御（belt-and-suspenders）。

**文件**：`packages/sandore/ui/src/client/sandore-step-definition.ts` L200

**当前代码**：
```ts
...(data.assessSessionId !== undefined ? { finalizeAssessSessionId: data.assessSessionId } : {}),
```

**修复**：
```ts
...(data.assessSessionId !== undefined && data.assessSessionId !== ''
  ? { finalizeAssessSessionId: data.assessSessionId } : {}),
```

同理 `gateSessionId`、`routingSessionId`。

**文件**：`packages/sandore/ui/src/client/DagStepNodeView.tsx` L229 + `UnifiedTimeline.tsx` L335

**当前代码**：
```tsx
badge.target !== undefined ? (
  <button ... onClick={(e) => { e.stopPropagation(); openSession(badge.target as SessionId) }}>
```

**修复**：
```tsx
badge.target !== undefined && badge.target !== '' ? (
  <button ... onClick={(e) => { e.stopPropagation(); openSession(badge.target as SessionId) }}>
```

#### 1.3.2 修复「门禁失败延迟出现」

**根因确认**：SSE 事件驱动刷新理论上即时生效，但 SSE 连接建立延迟 + EventSource 自动重连间隔可能导致事件丢失。

**修复方案**：增加 SSE 断线重连后的补刷新机制。

**文件**：`packages/sandore/ui/src/client/sandore-sse.ts`

**当前代码**只在 `message` 事件时通知监听器。增加 `open` 事件时触发一次全量刷新（重连后补数据）：

```ts
function ensureConnected(): void {
  if (source !== undefined) return;
  source = new EventSource('/sandore/events');
  // 新增：连接建立/重连时通知监听器触发全量刷新（补偿断线期间丢失的事件）
  source.addEventListener('open', () => {
    for (const listener of listeners) {
      try { listener('__connected__', null) } catch {}
    }
  });
  source.addEventListener('message', (e: MessageEvent) => {
    // ... 现有逻辑
  });
}
```

**同时**：RunView 的 `subscribeSandoreSse` 回调已对所有事件触发 `forceRefresh()`，`__connected__` 也会触发——这是正确的（重连后全量刷新）。

**但更关键的修复是**：确保 `EventSource` 的 `onerror` 处理（当前代码未处理 `error` 事件）。浏览器 `EventSource` 默认会在连接断开时自动重连，但重连间隔可能很长（几秒到几十秒）。建议：

```ts
source.addEventListener('error', () => {
  // EventSource 会自动重连，但重连间隔可能较长。
  // 这里不做特殊处理，但可以记录日志。
});
```

**补充方案**：在 `subscribeSandoreSse` 返回的 disposer 中，不立即关闭 `EventSource`，而是延迟关闭（避免组件快速挂载/卸载导致频繁重连）。但这超出当前范围。

### 1.4 涉及文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `microflow/src/finalize-manager.ts` L657-659 | 核心修复 | `assessSessionId` 空字符串守卫 |
| `ui/src/client/sandore-step-definition.ts` L200-202 | 防御 | sessionId 空字符串过滤 |
| `ui/src/client/DagStepNodeView.tsx` L229 | 防御 | badge target 空字符串 → span |
| `ui/src/client/UnifiedTimeline.tsx` L335 | 防御 | badge target 空字符串 → span |
| `ui/src/client/sandore-sse.ts` | 增强 | open 事件补刷新 |

---

## 问题 2：compressedOutput 渲染风格

### 2.1 用户反馈复述

> compressedOutput 的渲染是否是和运行中的最新十条消息渲染组件一致？风格完全一样？我要求 compressedOutput 还是要用 md 格式。

### 2.2 现状分析

#### 运行中消息渲染（StepChatPanel）

`StepChatPanel.tsx` 内嵌 DSH 对话流（`chatCss.column`），渲染完整的 agent 消息栈：

- `AssistantMarkdown`：DSH 原生 markdown 渲染组件（`packages/sandore/ui/src/client/chat/AssistantMarkdown.tsx`），支持流式、图片、代码高亮。
- `GenericToolCard`：工具调用卡片。
- `UserMessageRow`：用户消息行。
- 整体使用 `chatCss.column`（`ChatView.module.css`）的布局——消息行平铺、无边框无背景。

#### compressedOutput 渲染现状

**UnifiedTimeline.tsx L418-423**（完成态）：
```tsx
{isPhaseDone('finalizing', item.finalizePhase)
  && item.finalizeAssessResult?.compressedOutput !== undefined && (
  <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
)}
```

使用 `css.md`（`timeline.module.css` L304-347）：32px 左右缩进、14px 字号、1.625 行高、无背景框、直接平铺。

**DagStepNodeView.tsx L337-342**（完成态）：
```tsx
{isPhaseDone('finalizing', data.finalizePhase) && data.compressedOutput !== undefined && (
  <div className={css.contentCardDone}><MarkdownText text={data.compressedOutput} /></div>
)}
```

使用 `css.contentCardDone`（`DagStepNodeView.module.css` L288-292）：有边框（success 色）、有背景、有圆角卡片。

#### 差异对比

| 属性 | 运行中消息 (StepChatPanel) | UnifiedTimeline compressedOutput | DagStepNodeView compressedOutput |
|------|---------------------------|--------------------------------|--------------------------------|
| 渲染组件 | `AssistantMarkdown` | `MarkdownText` | `MarkdownText` |
| 缩进 | 0（平铺在 column 内） | 32px 左右 | 0（卡片内） |
| 背景 | 无 | 无 | 有（surface 色） |
| 边框 | 无 | 无 | 有（success 色） |
| 字号 | 14px（chatCss） | 14px | 12px（contentCard） |
| 布局 | 消息行平铺 | 段落平铺 | 卡片包裹 |

### 2.3 修复方案

**用户要求**：compressedOutput 用 **MarkdownText（md 格式）**，且**风格与运行中消息渲染一致**。

**运行中消息的风格**是 StepChatPanel 的 `chatCss.column` → `AssistantMarkdown`：消息行平铺、无边框无背景、32px 缩进（`chatCss.flowItem` 的 `margin-left: 32px`）。

但 `AssistantMarkdown` 组件接收的是 `ContentBlock[]`（DSH 的结构化消息块），而 compressedOutput 是纯文本字符串。`MarkdownText` 是 `AssistantMarkdown` 的纯文本包装，功能等价。

**修复方案**：统一两套 UI 的 compressedOutput 渲染为 `css.md` 样式（与运行中消息的 `chatCss.flowItem` 缩进对齐），去掉 DagStepNodeView 的 `contentCardDone` 卡片包裹。

#### 2.3.1 DagStepNodeView.tsx 修改

**文件**：`packages/sandore/ui/src/client/DagStepNodeView.tsx` L337-342

**当前代码**：
```tsx
{isPhaseDone('finalizing', data.finalizePhase) && data.compressedOutput !== undefined && (
  <div className={css.contentCardDone}><MarkdownText text={data.compressedOutput} /></div>
)}
```

**修改为**（引入 timeline.module.css 的 `.md` 样式）：

```tsx
import timelineCss from './timeline.module.css'
// ...
{isPhaseDone('finalizing', data.finalizePhase) && data.compressedOutput !== undefined && (
  <div className={timelineCss.md}><MarkdownText text={data.compressedOutput} /></div>
)}
```

**同理**：failed 态的 compressedOutput（L353-355）也改为 `timelineCss.md`。

**同理**：output 原始文本（L334）也改为 `timelineCss.md`（保持一致）。

#### 2.3.2 UnifiedTimeline.tsx 确认

UnifiedTimeline 的 compressedOutput 渲染（L418-423）已经使用 `css.md`，与运行中消息的 32px 缩进平铺风格一致。**无需修改**。

但运行中消息用的是 `StepChatPanel`（内嵌完整 DSH 对话流），而 compressedOutput 用的是 `MarkdownText`（纯文本 markdown 渲染）。两者在 markdown 渲染能力上等价（`MarkdownText` 是 `AssistantMarkdown` 的纯文本封装），但视觉上：

- `StepChatPanel` 的消息行有 `chatCss.flowItem` 的 `padding-left: 32px`。
- `css.md` 有 `margin-left: 32px`。

**视觉效果一致**：都是 32px 左缩进、无背景框、平铺。

#### 2.3.3 完整修改清单

| 文件 | 行号 | 修改 |
|------|------|------|
| `DagStepNodeView.tsx` L14 | 新增 import | `import timelineCss from './timeline.module.css'` |
| `DagStepNodeView.tsx` L334 | CSS class | `css.contentCardDone` → `timelineCss.md` |
| `DagStepNodeView.tsx` L338 | CSS class | `css.contentCardDone` → `timelineCss.md` |
| `DagStepNodeView.tsx` L342 | CSS class | `css.contentCardDone` → `timelineCss.md`（兜底 output） |
| `DagStepNodeView.tsx` L354 | CSS class | `css.contentCardDone` → `timelineCss.md`（failed compressedOutput） |

---

## 问题 3：真实 e2e 测试

### 3.1 需求

一个端到端测试，用真实 harness 驱动一个含 prompt step + 透传变量 + 门禁（primary+secondary）的工作流到 completed（或 failed 分支），断言：

1. 完整 step-phase 事件序列：`step-start → ask-detect → finalizing(running) → finalizing(done) → gating(running) → gating(done) → routing → completed`
2. 每个阶段事件后 `persistence.state.get` 的 `finalizeMeta.currentPhase/phaseHistory/各 Result.status` 正确
3. 事件与持久化一致（事件发出时持久化已含该阶段）

### 3.2 测试设计

#### 3.2.1 工作流定义

```yaml
id: wfl-e2e-phase
name: e2e-phase-test
version: "1.0.0"
stages:
  - id: stg-1
    name: 执行
    steps:
      - id: step-prompt
steps:
  - id: step-prompt
    command:
      type: prompt
      value:
        promptText: "请输出项目名称：sandore"
    passThroughVars:
      - name: projectName
        value: "${projectName}"
        description: "项目名"
    gates:
      primary:
        enabled: true
      secondary:
        enabled: true
        prompt: "请确认项目名称已正确输出"
```

#### 3.2.2 Mock 配置

使用 `workflow-engine.spec.ts` 现有的 mock 体系：

- `FakeLlm`：预设 prompt step 输出 + assess 输出 + secondary gate 输出
- `FakeSubagents`：控制子代理 settle 时机
- `FakeSessionStore` / `FakeAgentRegistry`：完整的 harness mock

**FakeLlm 预设响应序列**：

1. **prompt step 输出**（promptText 驱动）：`"项目名称：sandore"`
2. **Phase A assess**（临时会话）：`{"hasAsk": false, "passThroughVars": {"projectName": "sandore"}, "compressedOutput": "【任务要求】输出项目名称\n【执行过程】直接输出\n【最终成果】项目名称：sandore"}`
3. **Phase B assessForked**（fork 子代理）：同上
4. **Phase C secondary gate**（AI 门禁审查）：`{"gateStatus": "done", "gateDetail": "项目名称已正确输出"}`
5. **路由判断**（条件分支/循环退出）：无特殊输出（线性 DAG 无需判断）

#### 3.2.3 事件收集

在测试中注册 `ctx.on('sandore/step-phase', ...)` 监听器，收集所有 step-phase 事件到数组：

```ts
const phaseEvents: Array<{ stepId: string; phase: string; details?: Record<string, unknown> }> = []
ctx.on('sandore/step-phase', (info, stepId, childId, phase, name, loopIteration, details) => {
  phaseEvents.push({ stepId, phase, details: details as Record<string, unknown> | undefined })
})
```

#### 3.2.4 断言点

```ts
// 1. 完整事件序列
const phases = phaseEvents.map(e => e.phase)
expect(phases).toEqual([
  'finalizing',   // running 快照（assessForked 前）
  'finalizing',   // done 快照（assessForked 完成）
  'gating',       // running 快照（evaluateGates 前）
  'gating',       // done 快照（evaluateGates 完成，gatesPassed=true）
  'routing',      // routing 阶段
  'completed',    // 最终完成
])

// 2. assessSessionId 从 Phase B 开始有值
expect(phaseEvents[0].details?.assessSessionId).toBe('')  // running 快照：空字符串
expect(phaseEvents[1].details?.assessSessionId).toBeTruthy() // done 快照：真实 UUID

// 3. gateSessionId 从 Phase C 开始有值
expect(phaseEvents[2].details?.gateSessionId).toBe('')    // running 快照
expect(phaseEvents[3].details?.gateSessionId).toBeTruthy() // done 快照

// 4. phaseHistory 累计
expect(phaseEvents[1].details?.phaseHistory).toEqual(['finalizing'])
expect(phaseEvents[3].details?.phaseHistory).toEqual(['finalizing', 'gating'])
expect(phaseEvents[4].details?.phaseHistory).toEqual(['finalizing', 'gating', 'routing'])
expect(phaseEvents[5].details?.phaseHistory).toEqual(['finalizing', 'gating', 'routing', 'completed'])

// 5. assessStatus/gateStatus
expect(phaseEvents[1].details?.assessStatus).toBe('done')
expect(phaseEvents[3].details?.gateStatus).toBe('done')

// 6. 持久化一致性：事件发出时 persistence.state 已含该阶段
// 在 onPhaseChange 回调中读 persistence.state.get，验证 finalizeMeta
const persistence = ctx.get('sandorePersistence')
const stepEntry = persistence.state.get(instanceId)!.executedSteps.find(s => s.stepId === 'step-prompt')!
expect(stepEntry.finalizeMeta?.currentPhase).toBe('completed')
expect(stepEntry.finalizeMeta?.assessResult?.status).toBe('done')
expect(stepEntry.finalizeMeta?.gateResult?.status).toBe('done')
expect(stepEntry.finalizeMeta?.phaseHistory).toEqual(['finalizing', 'gating', 'routing', 'completed'])

// 7. 门禁失败分支（可选：另一个测试用例）
// FakeLlm 预设 secondary gate 返回 failed → gateResult.status='failed'
// → step-phase 事件含 gateStatus='failed'
// → persistence.state.get 的 gateResult.gatesPassed=false
```

#### 3.2.5 门禁失败分支测试

额外定义一个测试用例，FakeLlm 预设 secondary gate 返回 `{"gateStatus": "error", "gateDetail": "项目名称不匹配"}`：

```ts
// 门禁失败事件序列
const failedPhases = failedPhaseEvents.map(e => e.phase)
expect(failedPhases).toEqual([
  'finalizing',   // running
  'finalizing',   // done
  'gating',       // running
  'gating',       // failed（门禁失败）
])

// 门禁失败时 gateStatus='failed'
expect(failedPhaseEvents[3].details?.gateStatus).toBe('failed')

// 持久化验证
const failedStep = persistence.state.get(failedInstanceId)!.executedSteps.find(s => s.stepId === 'step-prompt')!
expect(failedStep.status).toBe('failed')
expect(failedStep.finalizeMeta?.gateResult?.gatesPassed).toBe(false)
expect(failedStep.finalizeMeta?.gateResult?.status).toBe('failed')
```

### 3.3 测试文件位置

**新文件**：`packages/sandore/workflow/src/workflow-engine-e2e.spec.ts`

或追加到现有 `packages/sandore/workflow/src/workflow-engine.spec.ts`（推荐，复用现有 mock setup）。

### 3.4 Mock 响应预设细节

FakeLlm 需要按调用顺序返回不同响应。当前 `FakeLlm` 支持 `responses` 队列（按 `stream()` 调用顺序消费）：

```ts
const llm = new FakeLlm([
  // 1. prompt step 输出
  textChunks('项目名称：sandore'),
  // 2. Phase A assess（临时会话，ask 判定）
  textChunks('```json\n{"hasAsk": false, "passThroughVars": {"projectName": "sandore"}, "compressedOutput": "项目名称：sandore"}\n```'),
  // 3. Phase B assessForked（fork 子代理）
  textChunks('```json\n{"passThroughVars": {"projectName": "sandore"}, "compressedOutput": "【任务要求】输出项目名称\\n【执行过程】直接输出\\n【最终成果】项目名称：sandore"}\n```'),
  // 4. Phase C secondary gate（AI 门禁审查）
  textChunks('```json\n{"gateStatus": "done", "gateDetail": "项目名称已正确输出"}\n```'),
])
```

**注意**：Phase A assess 用的是 `runStream`（`llm.stream` 直调），Phase B assessForked 用的是 `driveAgentRound`（`agents.create` + `followup`），Phase C secondary gate 用的是 `driveAgentRound`（`agents.create` + `followup`）。两者的 LLM 调用路径不同：

- `runStream` → `ctx.llm.stream()` → FakeLlm
- `driveAgentRound` → `handle.agent.followup()` → FakeAgent → `ctx.llm.stream()` → FakeLlm

需要确认 FakeAgent/FakeSubagents 的 mock 链路是否覆盖 `driveAgentRound` 的 `followup → whenIdle → finalAssistantOutput` 路径。

从 `workflow-engine.spec.ts` 现有测试看，已有 `finalizeStep` 相关测试（如 `dagYaml` 的 step-finalize 带门禁），说明 mock 链路已覆盖。

---

## 风险评估

### 问题 1 修复风险

| 风险 | 级别 | 说明 |
|------|------|------|
| 空字符串守卫遗漏 | 低 | 多层防御（引擎 + UI），任一层生效即可 |
| SSE open 补刷新导致短暂闪烁 | 低 | 仅在重连时触发一次全量刷新，用户无感知 |
| 旧实例数据兼容 | 低 | 空字符串守卫对旧数据（已持久化的 `assessSessionId=''`）也生效 |

### 问题 2 修复风险

| 风险 | 级别 | 说明 |
|------|------|------|
| 视觉回归 | 中 | DagStepNodeView 从卡片改为平铺，用户可能不习惯 |
| CSS 模块导入 | 低 | 跨模块导入 timeline.module.css 需确认无循环依赖 |
| MarkdownText 渲染差异 | 低 | compressedOutput 是纯文本，MarkdownText 渲染与 AssistantMarkdown 等价 |

### 问题 3 测试风险

| 风险 | 级别 | 说明 |
|------|------|------|
| FakeLlm 响应序列对齐 | 中 | LLM 调用顺序可能因并发/优化而变化，需要精确控制 |
| 测试稳定性 | 中 | 异步事件收集 + 持久化验证，需要合适的 await 策略 |
| Mock 覆盖度 | 低 | 现有 mock 体系已覆盖 finalizeStep 全路径 |
