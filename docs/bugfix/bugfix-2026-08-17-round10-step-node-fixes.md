# Bugfix 方案：宿主会话对话流 Step 节点 3 个 UI 问题

> **日期**：2026-08-17 (Round 10)
> **范围**：sandore UI 层（`DagStepNodeView` + `sandore-step-definition`）+ sandore 引擎层（`stage-executor`）
> **约束**：禁止修改 DSH 源码；仅改 sandore 仓库

---

## 问题 1：Badge 状态判断 Bug——已完成阶段仍显示进行中态

### 1.1 用户反馈

> 「收尾和门禁都完成了，但还是显示收尾中和门禁中」

### 1.2 根因分析

**核心 Bug：`done` 判断逻辑错误**

`DagStepNodeView.tsx` L148-160（Phase B 为例）：

```typescript
const hasFinalizing = phases.includes('finalizing')
const isCurrentlyFinalizing = data.finalizePhase === 'finalizing'
if (hasFinalizing || isCurrentlyFinalizing) {
  const done = hasFinalizing && !isCurrentlyFinalizing && phases.indexOf('completed') > phases.indexOf('finalizing')
  // ...
}
```

`done` 判断要求 `phases.indexOf('completed') > phases.indexOf('finalizing')`——即 `phaseHistory` 必须包含 `'completed'` 且 `'completed'` 在 `'finalizing'` 之后。

**问题在于：`phaseHistory` 快照的语义**

查看 `finalize-manager.ts` L603-639 的 `buildFinalizeMeta`：

```typescript
const history = [...(existing?.phaseHistory ?? [])];
if (history.length === 0 || history[history.length - 1] !== currentPhase) {
  history.push(currentPhase);
}
```

`phaseHistory` 是**每次 `commitFinalize` 调用时的快照**——它记录的是到当前阶段为止的历史。当 `commitFinalize('finalizing')` 被调用时，`phaseHistory` 的快照是 `['finalizing']`（或 `['ask-detect', 'finalizing']`）。当 `commitFinalize('gating')` 被调用时，快照是 `['finalizing', 'gating']`（或 `['ask-detect', 'finalizing', 'gating']`）。

**关键**：`commitFinalize` 的 `onPhaseChange` 回调（L1190）在每次调用时**立即触发**，携带的 `details.phaseHistory` 是**该次调用时的快照**。

**事件到达时序分析**：

1. `commitFinalize('finalizing')` → `onPhaseChange(step, childId, 'finalizing', { phaseHistory: ['ask-detect', 'finalizing'] })` → Session 事件 `sandore/step-phase { phase: 'finalizing', phaseHistory: ['ask-detect', 'finalizing'] }`
2. `commitFinalize('gating')` → `onPhaseChange(step, childId, 'gating', { phaseHistory: ['ask-detect', 'finalizing', 'gating'] })` → Session 事件 `sandore/step-phase { phase: 'gating', phaseHistory: ['ask-detect', 'finalizing', 'gating'] }`
3. `commitFinalize('routing')` → `onPhaseChange(step, childId, 'routing', { phaseHistory: ['ask-detect', 'finalizing', 'gating', 'routing'] })` → Session 事件
4. `commitFinalize('completed')` → `onPhaseChange(step, childId, 'completed', { phaseHistory: ['ask-detect', 'finalizing', 'gating', 'routing', 'completed'] })` → Session 事件

`sandore-step-definition.ts` L180-189 的 `update` 处理 `step-phase` 事件：

```typescript
case 'sandore/step-phase': {
  const data = match.event.data
  return {
    ...context.state,
    finalizePhase: data.phase,
    ...(data.phaseHistory !== undefined ? { finalizePhaseHistory: data.phaseHistory } : {}),
    // ...
  }
}
```

**每个 `step-phase` 事件都会覆盖 `finalizePhase` 和 `finalizePhaseHistory`**。

**那么问题出在哪？**

当事件序列正常到达时：
- 最终 `finalizePhase = 'completed'`，`finalizePhaseHistory = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed']`
- `isCurrentlyFinalizing = false`（`data.finalizePhase !== 'finalizing'`）
- `phases.indexOf('completed') > phases.indexOf('finalizing')` = `4 > 1` = `true`
- `done = true` ✓

**理论上应该正确。但用户说「还是显示收尾中和门禁中」——说明 `completed` 事件没有到达节点，或者到达时序有问题。**

**深入追查：`completeAfterFinalize` 中 `commitFinalize('completed')` 是否真正触发 `onPhaseChange`**

`stage-executor.ts` L1158-1159：
```typescript
if (hasFinalize) {
  await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'completed', routingResult !== undefined ? { routingResult } : undefined);
}
```

`hasFinalize = phaseBResult !== undefined || gateResult !== undefined`（L1137）。

**关键发现**：当 Step **没有配置门禁且没有透传变量**时，`runPhaseA` 返回 `{ kind: 'ok', assessResult: undefined, gates }`（L990），`runPhaseB` 返回 `undefined`（L1062），`runPhaseC` 返回 `{ kind: 'ok', gateResult: undefined }`（L1091）。

此时 `phaseBResult = undefined`，`gateResult = undefined`，`hasFinalize = false`。

**`commitFinalize('routing')` 和 `commitFinalize('completed')` 都不会被调用！** 这意味着：
- **没有任何 `step-phase` 事件的 `phase='completed'` 被发出**
- `finalizePhase` 停留在最后一次 `commitFinalize` 的阶段

但等等——如果 `hasFinalize=false`，那么 Phase B/C 都没有运行，也没有 `commitFinalize('finalizing')` 或 `commitFinalize('gating')` 被调用。所以 `finalizePhase` 应该是 `undefined`（没有 finalize 阶段），badge 不会显示。

**用户说「收尾和门禁都完成了」——说明确实有门禁/收尾配置，Phase B/C 确实运行了。** 那么 `hasFinalize=true`，`commitFinalize('completed')` 应该被调用。

**再查 `buildFinalizeRequest` 在 `completeAfterFinalize` 中的行为**：

`stage-executor.ts` L1136：
```typescript
const buildRequest = () => this.buildFinalizeRequest(step, executed, context, gates, state);
```

`buildFinalizeRequest`（L1192-1220）注入 `onPhaseChange`：
```typescript
...(this.options.hooks?.onPhaseChange === undefined
  ? {}
  : { onPhaseChange: this.options.hooks.onPhaseChange }),
```

**`onPhaseChange` 在 `completeAfterFinalize` 的 `buildRequest()` 中同样被注入**——所以 `commitFinalize('completed')` 确实会触发 `onPhaseChange` → `emitStepPhase`。

**那么问题一定在事件到达/匹配链路上。** 让我追查 `nodeIdOf` 的匹配：

`sandore-step-definition.ts` L81-85：
```typescript
export function nodeIdOf(stepId: string, loopIteration: readonly number[] | undefined): string {
  return loopIteration === undefined || loopIteration.length === 0
    ? stepId
    : `${stepId}#${loopIteration.join('.')}`
}
```

`match` 对 `step-phase` 事件（L130-132）：
```typescript
if (event.type === 'sandore/step-phase') {
  return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'update' }
}
```

**`event.data.loopIteration`** 来自 `emitStepPhase`（workflow-engine.ts L2005）：
```typescript
{ stepId, childId, phase, name, ...(loopIteration === undefined ? {} : { loopIteration }), ...extra }
```

`loopIteration` 来自 `currentLoopIteration()`（L1214-1217）：
```typescript
const currentLoopIteration = (): number[] | undefined => {
  const path = loopManager.buildLoopIterationPath();
  return path.length > 0 ? path : undefined;
};
```

**关键问题**：在 `completeAfterFinalize` 中，`stepNavigator.resolveNextNodes(nodeId, this.buildContext(state))`（L1143）已经被调用——**这可能改变了 loopManager 的状态**（跳出循环、重置循环栈等）。如果 `resolveNextNodes` 改变了循环栈，那么后续 `commitFinalize('completed')` 触发 `onPhaseChange` 时，`currentLoopIteration()` 返回的值可能与之前的 `step-phase` 事件不同。

**但这不太可能**——`resolveNextNodes` 只是读取/评估，不应该改变 loopManager 的活跃循环栈。

**更可能的根因：conversation assembler 的 match 冲突**

`step-phase.ts` 的 `stepPhaseDefinition` 和 `sandore-step-definition.ts` 的 `sandoreStepDefinition` **都 match `sandore/step-phase` 事件**。Round 9 文档（L27-29）提到：

> `step-phase` 事件被 `stepPhaseDefinition` 独占 match，`sandoreStepDefinition` 永远不会收到它。

Round 9 修复后，两个 definition 都 match 同一事件。**但 conversation assembler 是否允许两个 definition 独立 match 同一事件？**

根据 Round 9 文档（L127-128）：
> conversation assembler 允许多个 definition 独立 match，不同 kind 产生独立 context

**这应该没问题**——两个 definition 的 kind 不同（`sandore-step` vs `sandore-step-phase`），各自独立 match。

**最终根因推断：`step-phase` 事件的 `loopIteration` 与 `step-start` 事件的 `loopIteration` 不匹配**

`step-start` 事件的 `loopIteration` 来自 `stage-executor.ts` L784：
```typescript
hooks?.onStepStart(step, childId);
```

而 `step-phase` 事件的 `loopIteration` 来自 `workflow-engine.ts` L1227：
```typescript
onPhaseChange: (step, childId, phase, details) => this.emitStepPhase(session, info, step.id, childId ?? step.id, phase, step.name ?? step.id, currentLoopIteration(), details),
```

**`currentLoopIteration()` 在 `onPhaseChange` 回调被调用时才求值**。如果此时 `loopManager` 的状态已经改变（比如 `resolveNextNodes` 已经推进了循环），那么 `currentLoopIteration()` 可能返回与 `step-start` 时不同的值。

**但这也不太可能**——`onPhaseChange` 是在 `commitFinalize` 内部同步调用的（L1190），而 `commitFinalize` 是在 `completeAfterFinalize` 的 `resolveNextNodes` 之前调用的（L1141 路由阶段，L1159 completed 阶段在 `resolveNextNodes` 之后）。

**等等——L1159 的 `commitFinalize('completed')` 确实在 `resolveNextNodes`（L1143）之后！**

```typescript
// L1140-1141: routing 阶段
if (hasFinalize) {
  await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'routing');
}
// L1143: resolveNextNodes（可能改变 loopManager 状态）
const routed = await this.options.stepNavigator.resolveNextNodes(nodeId, this.buildContext(state));
// ...
// L1158-1159: completed 阶段
if (hasFinalize) {
  await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'completed', routingResult !== undefined ? { routingResult } : undefined);
}
```

**如果 `resolveNextNodes` 改变了 loopManager 的活跃循环栈（比如跳出循环），那么 `commitFinalize('completed')` 触发的 `onPhaseChange` 中 `currentLoopIteration()` 返回的值可能与之前不同。**

但这仍然不太可能导致 match 失败——`nodeIdOf` 对 `undefined` 和空数组都返回 `stepId`（纯字符串），只有非空数组才会拼接后缀。

**最可能的根因：`completed` 事件确实到达了节点，但 `done` 判断的逻辑有边界问题**

让我重新审视 `done` 判断：

```typescript
const done = hasFinalizing && !isCurrentlyFinalizing && phases.indexOf('completed') > phases.indexOf('finalizing')
```

当 `data.finalizePhase = 'completed'` 且 `data.finalizePhaseHistory = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed']` 时：
- `hasFinalizing = true`（`phases.includes('finalizing')`）
- `isCurrentlyFinalizing = false`（`data.finalizePhase !== 'finalizing'`）
- `phases.indexOf('completed') = 4`，`phases.indexOf('finalizing') = 1`，`4 > 1 = true`
- `done = true` ✓

**这应该是正确的。除非 `phaseHistory` 没有包含 `'completed'`。**

**最终确认：`buildFinalizeMeta` 的 `phaseHistory` 快照语义**

`finalize-manager.ts` L614-617：
```typescript
const history = [...(existing?.phaseHistory ?? [])];
if (history.length === 0 || history[history.length - 1] !== currentPhase) {
  history.push(currentPhase);
}
```

当 `commitFinalize('completed')` 被调用时：
- `existing` = 上一次 `commitFinalize('routing')` 写入的 `finalizeMeta`
- `existing.phaseHistory` = `['ask-detect', 'finalizing', 'gating', 'routing']`
- `history = ['ask-detect', 'finalizing', 'gating', 'routing']`
- `currentPhase = 'completed'`，`history[3] = 'routing' !== 'completed'`
- `history.push('completed')` → `['ask-detect', 'finalizing', 'gating', 'routing', 'completed']`

然后 `onPhaseChange` 回调携带 `details.phaseHistory = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed']`。

**但等等——`onPhaseChange` 的 `details` 是从 `request.executedStep.finalizeMeta` 提取的（L1183-1189）：**

```typescript
const meta = request.executedStep.finalizeMeta;
const details = meta === undefined ? undefined : {
  ...(meta.assessSessionId !== undefined ? { assessSessionId: meta.assessSessionId } : {}),
  ...(meta.gateSessionId !== undefined ? { gateSessionId: meta.gateSessionId } : {}),
  ...(meta.routingSessionId !== undefined ? { routingSessionId: meta.routingSessionId } : {}),
  ...(meta.phaseHistory !== undefined ? { phaseHistory: meta.phaseHistory } : {}),
};
```

`request.executedStep.finalizeMeta` 在 L1172 已被更新为最新值。**所以 `details.phaseHistory` 确实包含 `'completed'`。**

**结论：理论上事件链路正确，`done` 判断也正确。但用户确实看到了问题。**

**最可能的实际根因：事件丢失或时序竞态**

1. **Session append 失败**：`emitStepPhase` 中的 `safeAppend`（workflow-engine.ts L2003-2007）可能静默失败（`safeAppend` 的语义是 catch 错误不抛出）。
2. **事件到达但 conversation assembler 处理延迟**：`step-phase` 事件到达后，conversation assembler 需要重新组装视图——如果组装延迟，UI 可能显示旧状态。
3. **`step-phase` 事件的 `ignorable: true` 标记**：`safeAppend` 传入 `{ ignorable: true }`——如果 Session 的 `append` 实现对 `ignorable` 事件有特殊处理（比如丢弃），事件可能不会到达客户端。

**`ignorable: true` 是最可疑的根因。** 让我确认 DSH 的 Session append 对 ignorable 的处理。

### 1.3 确认的根因

**根因 A（主因）：`done` 判断逻辑过于严格——要求 `phaseHistory` 包含 `'completed'`**

当以下任一情况发生时，`done` 判断失败：
1. `completed` 事件的 `step-phase` 未到达节点（`safeAppend` 失败 / `ignorable` 被丢弃 / conversation assembler 未处理）
2. `phaseHistory` 快照不包含 `'completed'`（理论上不可能，但有边界情况）

**根因 B（备选）：`ignorable: true` 可能导致事件被丢弃**

`emitStepPhase` 使用 `{ ignorable: true }` 标记事件。如果 DSH Session 的 `append` 实现对 ignorable 事件有丢弃逻辑（比如 Session 已关闭/暂停时丢弃 ignorable 事件），`completed` 阶段的 `step-phase` 事件可能丢失。

### 1.4 修复方案

**方案：`done` 判断改为基于 `finalizePhase` 的阶段序号比较**

不再依赖 `phaseHistory` 包含 `'completed'`，而是直接比较 `finalizePhase` 是否已经前进到当前阶段之后：

```typescript
// 阶段顺序（与引擎 FinalizePhase 对齐）
const PHASE_ORDER = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed'] as const

function isPhaseDone(phase: string, currentPhase: string | undefined): boolean {
  if (currentPhase === undefined) return false
  const phaseIdx = PHASE_ORDER.indexOf(phase as typeof PHASE_ORDER[number])
  const currentIdx = PHASE_ORDER.indexOf(currentPhase as typeof PHASE_ORDER[number])
  return phaseIdx >= 0 && currentIdx >= 0 && currentIdx > phaseIdx
}
```

`StepPhaseBadges` 中的 `done` 判断改为：

```typescript
// Phase B
const done = hasFinalizing && !isCurrentlyFinalizing && isPhaseDone('finalizing', data.finalizePhase)

// Phase C
const done = hasGating && !isCurrentlyGating && isPhaseDone('gating', data.finalizePhase)

// Phase D
const done = hasRouting && !isCurrentlyRouting && isPhaseDone('routing', data.finalizePhase)
```

**优点**：
- 不依赖 `phaseHistory` 的完整性
- `finalizePhase` 由每个 `step-phase` 事件覆盖，即使中间事件丢失，最终状态仍正确
- 逻辑简洁，语义清晰

**需要修改的文件**：
- `packages/sandore/ui/src/client/DagStepNodeView.tsx`：L125-215 `StepPhaseBadges` 组件

---

## 问题 2：失败/已完成样式与收尾中样式不对齐

### 2.1 用户反馈

> 「失败或者已完成的样式，和后面的收尾中不一样，要对齐」

### 2.2 根因分析

**现状**：
- Badge 使用 DSH 风格（`phaseBtn`/`phaseDone`/`phaseActive` + `PhaseIcon` SVG）——L192-214
- `completed` 状态的内容区使用 `<div className={css.output}>`（L295-296）——纯 padding + MarkdownText
- `failed` 状态的内容区使用 `<div className={css.error}>`（L298-299）——红框 + 等宽字体 + pre-wrap

**样式差异**：
- Badge 区域：统一的 pill 形状、图标 + 文字、颜色编码（绿色完成/蓝色进行中）
- 内容区域：`output` 无边框无背景，`error` 有红框红底——两者视觉风格完全不同
- 用户期望：失败/已完成的内容区域应该与收尾中的 badge 风格对齐（统一的卡片式展示）

### 2.3 修复方案

**方案：统一内容区域样式为卡片式展示**

参考 DSH 的 `StateDot` + `Pill` 风格，内容区域统一使用带边框的卡片：

```css
/* 统一内容卡片 */
.contentCard {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-primary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

/* 已完成态内容卡片 */
.contentCardDone {
  composes: contentCard;
  border-color: var(--sd-success);
  color: var(--dsw-alias-label-primary);
}

/* 失败态内容卡片 */
.contentCardError {
  composes: contentCard;
  border-color: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
  font-family: var(--dsh-font-mono, monospace);
  white-space: pre-wrap;
}
```

**需要修改的文件**：
- `packages/sandore/ui/src/client/DagStepNodeView.module.css`：新增 `.contentCardDone` / `.contentCardError`
- `packages/sandore/ui/src/client/DagStepNodeView.tsx`：L295-300 使用新样式类

---

## 问题 3：内容展示规则错误

### 3.1 用户反馈

> 「step 下面只能显示：errordetail 或者是运行时消息，或者是 compressedOutput。但是你的失败显示的是：errordetail+全部滚动消息【而且还是旧的样式，不是现在的 dsh 风格】，然后应该显示的是 errordetail+compressedOutput。其实应该是这样：step 执行完成，到收尾中，这段时间显示的是 output，在收尾完成后显示的都该是 compressedOutput」

### 3.2 根因分析

**用户期望的展示规则**：

| 阶段 | 显示内容 |
|---|---|
| step 执行完成 → 收尾中 | `output`（step-completed 的原始 output） |
| 收尾完成后（finalizePhase 已过 finalizing） | `compressedOutput`（Phase B 压缩摘要） |
| 失败 | `errorDetail` + `compressedOutput` |

**现状**：

`sandore-step-definition.ts` L154-159：
```typescript
case 'sandore/step-completed': {
  const output: SandoreTextBlock[] = []
  for (const block of match.event.data.output) {
    if (block.type === 'text') output.push({ type: 'text', text: block.text })
  }
  return { ...context.state, status: 'completed', output, ...realChildIdOf(context.state, match.event.data.childId) }
}
```

`step-completed` 事件载荷只有 `output`（`seam.ts` L79），**没有 `compressedOutput`**。

`DagStepNodeView.tsx` L295-300：
```typescript
{data.status === 'completed' && data.output !== undefined && data.output.length > 0 && (
  <div className={css.output}><MarkdownText text={outputText(data.output)} /></div>
)}
{data.status === 'failed' && data.error !== undefined && (
  <div className={css.error} role="alert">{data.error}</div>
)}
```

**问题**：
1. **没有 `compressedOutput` 字段**：`SandoreStepChatData` 和 `SandoreStepState` 都没有 `compressedOutput`
2. **`completed` 态显示 `output`**：应该根据 `finalizePhase` 决定显示 `output` 还是 `compressedOutput`
3. **`failed` 态只显示 `error`**：应该显示 `errorDetail` + `compressedOutput`
4. **`compressedOutput` 数据来源缺失**：`step-completed` 事件不携带 `compressedOutput`，`step-phase` 事件也不携带

### 3.3 `compressedOutput` 数据来源追踪

`compressedOutput` 产生于 Phase B 收尾处理（`finalize-manager.ts` L786-787）：
```typescript
return {
  passThroughVars: parsed.passThroughVars,
  compressedOutput: parsed.compressedOutput,
  forkSessionId: handle.agent.id,
  assessmentRaw: raw,
};
```

存储在 `finalizeMeta.assessResult.compressedOutput`（`finalize-manager.ts` L625-629）：
```typescript
...(assessResult === undefined
  ? {}
  : {
      assessResult,
      ...(options?.recordAssessSession === false ? {} : { assessSessionId: assessResult.forkSessionId }),
    }),
```

`assessResult` 是 `FinalizeAssessResult` 类型，包含 `compressedOutput` 字段。

**数据位置**：`executedStep.finalizeMeta.assessResult.compressedOutput`

**获取路径选择**：

| 路径 | 优点 | 缺点 |
|---|---|---|
| A. `step-phase` 事件载荷携带 `compressedOutput` | 事件驱动，即时更新 | 载荷膨胀；`compressedOutput` 可能很长 |
| B. `step-completed` 事件载荷补充 `compressedOutput` | 一次性携带 | 但 `compressedOutput` 在收尾阶段才产生，`step-completed` 在收尾前发出 |
| C. 新增事件 `sandore/step-finalized` 携带 `compressedOutput` | 语义清晰 | 新增事件类型 |
| D. UI 经 RPC 拉取（`getInstanceState`） | 不改事件载荷 | 需要新增注入；轮询延迟 |
| E. `step-phase` 事件载荷携带 `compressedOutput`（仅 `completed` 阶段） | 精准，只在终态携带 | 载荷可能较大 |

**推荐方案 E**：在 `step-phase` 事件的 `completed` 阶段携带 `compressedOutput`。

**理由**：
1. `compressedOutput` 在 Phase B 产生，Phase B 的 `commitFinalize('finalizing')` 时已存入 `finalizeMeta.assessResult.compressedOutput`
2. `commitFinalize('completed')` 时 `finalizeMeta` 已包含完整信息
3. `onPhaseChange` 回调已有 `details` 参数，扩展携带 `compressedOutput` 侵入最小
4. 只在 `completed` 阶段携带，避免中间阶段载荷膨胀

### 3.4 修复方案

#### 3.4.1 数据层：`sandore-step-definition.ts`

**新增字段**：

```typescript
// SandoreStepState 新增
readonly compressedOutput?: string

// SandoreStepChatData 新增
/** Phase B 收尾压缩摘要（finalizePhase 已过 finalizing 后显示）。 */
readonly compressedOutput?: string
```

**`update` 处理 `step-phase` 事件**（L180-189）扩展：

```typescript
case 'sandore/step-phase': {
  const data = match.event.data
  return {
    ...context.state,
    finalizePhase: data.phase,
    ...(data.phaseHistory !== undefined ? { finalizePhaseHistory: data.phaseHistory } : {}),
    ...(data.assessSessionId !== undefined ? { finalizeAssessSessionId: data.assessSessionId } : {}),
    ...(data.gateSessionId !== undefined ? { finalizeGateSessionId: data.gateSessionId } : {}),
    ...(data.routingSessionId !== undefined ? { finalizeRoutingSessionId: data.routingSessionId } : {}),
    // 新增：compressedOutput（仅 completed 阶段事件携带）
    ...(data.compressedOutput !== undefined ? { compressedOutput: data.compressedOutput } : {}),
  }
}
```

**`buildViewNode` 投影**（L196-224）扩展：

```typescript
...(state.compressedOutput === undefined ? {} : { compressedOutput: state.compressedOutput }),
```

#### 3.4.2 事件层：`seam.ts` + `workflow-engine.ts`

**`seam.ts` SessionEventMap**（L85-96）扩展：

```typescript
'sandore/step-phase': {
  stepId: string;
  childId: string;
  phase: FinalizePhase;
  name: string;
  loopIteration?: number[];
  assessSessionId?: string;
  gateSessionId?: string;
  routingSessionId?: string;
  phaseHistory?: readonly string[];
  // 新增：Phase B 压缩摘要（仅 completed 阶段携带）
  compressedOutput?: string;
};
```

**`seam.ts` Cordis Events**（L60-64）同步扩展 `details` 参数。

**`workflow-engine.ts` `emitStepPhase`**（L1991-2008）扩展 `details` 参数类型。

**`finalize-manager.ts` `commitFinalize`**（L1183-1190）扩展 `details` 组装：

```typescript
const details = meta === undefined ? undefined : {
  ...(meta.assessSessionId !== undefined ? { assessSessionId: meta.assessSessionId } : {}),
  ...(meta.gateSessionId !== undefined ? { gateSessionId: meta.gateSessionId } : {}),
  ...(meta.routingSessionId !== undefined ? { routingSessionId: meta.routingSessionId } : {}),
  ...(meta.phaseHistory !== undefined ? { phaseHistory: meta.phaseHistory } : {}),
  // 新增：仅 completed 阶段携带 compressedOutput
  ...(currentPhase === 'completed' && meta.assessResult?.compressedOutput !== undefined
    ? { compressedOutput: meta.assessResult.compressedOutput }
    : {}),
};
```

**`stage-executor.ts` `StageStepHooks.onPhaseChange`**（L83-88）扩展 `details` 类型：

```typescript
readonly onPhaseChange?: (
  step: WorkflowStep,
  childId: string | undefined,
  phase: FinalizePhase,
  details?: {
    assessSessionId?: string;
    gateSessionId?: string;
    routingSessionId?: string;
    phaseHistory?: readonly string[];
    compressedOutput?: string;  // 新增
  },
) => void;
```

#### 3.4.3 视图层：`DagStepNodeView.tsx`

**展示规则**（L295-303）改为：

```typescript
{/* 内容区域：根据 finalizePhase 决定显示 output 还是 compressedOutput */}
{data.status === 'completed' && (
  <>
    {/* 收尾完成前（finalizePhase 未到 completed）：显示原始 output */}
    {data.finalizePhase !== 'completed' && data.output !== undefined && data.output.length > 0 && (
      <div className={css.contentCardDone}><MarkdownText text={outputText(data.output)} /></div>
    )}
    {/* 收尾完成后（finalizePhase = completed）：显示 compressedOutput */}
    {data.finalizePhase === 'completed' && data.compressedOutput !== undefined && (
      <div className={css.contentCardDone}><MarkdownText text={data.compressedOutput} /></div>
    )}
    {/* 兜底：无 compressedOutput 时仍显示 output */}
    {data.finalizePhase === 'completed' && data.compressedOutput === undefined && data.output !== undefined && data.output.length > 0 && (
      <div className={css.contentCardDone}><MarkdownText text={outputText(data.output)} /></div>
    )}
  </>
)}
{data.status === 'failed' && (
  <>
    {/* errorDetail */}
    {data.error !== undefined && (
      <div className={css.contentCardError} role="alert">{data.error}</div>
    )}
    {/* compressedOutput（如果有） */}
    {data.compressedOutput !== undefined && (
      <div className={css.contentCardDone}><MarkdownText text={data.compressedOutput} /></div>
    )}
  </>
)}
```

---

## 完整改动清单

### 文件改动

| 文件 | 改动类型 | 改动内容 |
|---|---|---|
| `packages/sandore/ui/src/client/DagStepNodeView.tsx` | 修改 | ① `StepPhaseBadges` done 判断改为 `isPhaseDone` ② 内容区域展示规则重构 ③ 使用统一样式类 |
| `packages/sandore/ui/src/client/DagStepNodeView.module.css` | 修改 | 新增 `.contentCardDone` / `.contentCardError` 统一卡片样式 |
| `packages/sandore/ui/src/client/sandore-step-definition.ts` | 修改 | ① `SandoreStepState` / `SandoreStepChatData` 新增 `compressedOutput` 字段 ② `update` 处理 `step-phase` 事件时提取 `compressedOutput` ③ `buildViewNode` 投影 `compressedOutput` |
| `packages/sandore/ui/src/client/step-phase.ts` | 修改 | `StepPhaseData` 新增 `compressedOutput` 字段 |
| `packages/sandore/workflow/src/seam.ts` | 修改 | `sandore/step-phase` SessionEventMap + Cordis Events 扩展 `compressedOutput` |
| `packages/sandore/microflow/src/finalize-manager.ts` | 修改 | `commitFinalize` 的 `details` 组装新增 `compressedOutput`（仅 `completed` 阶段） |
| `packages/sandore/microflow/src/stage-executor.ts` | 修改 | `StageStepHooks.onPhaseChange` 类型扩展 `compressedOutput` |
| `packages/sandore/workflow/src/workflow-engine.ts` | 修改 | `emitStepPhase` 参数类型扩展 `compressedOutput` |

### 不需要修改 DSH

所有改动都在 sandore 仓库内完成。DSH 的 Session append、conversation assembler、Slot 渲染等基础设施不需要改动。

---

## 测试计划

### 单元测试

1. **`sandore-step-definition.spec.ts`**：
   - 测试 `step-phase` 事件携带 `compressedOutput` 时正确写入状态
   - 测试 `buildViewNode` 正确投影 `compressedOutput`

2. **`step-phase.spec.ts`**：
   - 测试 `StepPhaseData` 包含 `compressedOutput` 字段

3. **`DagStepNodeView` 测试**：
   - 测试 `isPhaseDone` 函数对各阶段的正确判断
   - 测试 `completed` 态 + `finalizePhase='completed'` 时显示 `compressedOutput`
   - 测试 `completed` 态 + `finalizePhase='finalizing'` 时显示 `output`
   - 测试 `failed` 态显示 `errorDetail` + `compressedOutput`

### 集成测试

1. **端到端流程**：
   - 启动 dev 实例（port 3090）
   - 执行一个有门禁配置的工作流
   - 验证 step 节点 badge 正确显示各阶段状态
   - 验证收尾完成后显示 `compressedOutput`
   - 验证失败时显示 `errorDetail` + `compressedOutput`

2. **边界情况**：
   - 无门禁/无透传变量的 Step（`hasFinalize=false`）：不应显示 badge，`completed` 态显示 `output`
   - 仅 primary 门禁（无 secondary）：badge 正确显示
   - ask 中断 → 回复 → 续跑：badge 正确流转

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| `compressedOutput` 载荷过大导致 Session append 性能问题 | 低 | 中 | 仅 `completed` 阶段携带；Phase B 的压缩摘要通常较短 |
| `isPhaseDone` 判断与引擎 `FinalizePhase` 枚举不同步 | 低 | 低 | `PHASE_ORDER` 常量与 `FinalizePhase` 类型对齐，编译期检查 |
| `step-phase` 事件 `compressedOutput` 字段未到达（`safeAppend` 失败） | 低 | 中 | 兜底：无 `compressedOutput` 时仍显示 `output` |
| conversation assembler 对新增字段的处理 | 低 | 低 | 字段为可选，不影响现有逻辑 |
