# Round 17：finalizeMeta 数据结构重构 + 收尾中 badge 可点击

> 日期：2026-08-17
> 基线：805/35 测试全绿
> 约束：**只读分析 + 方案文档，禁止修改业务代码**

---

## 目录

1. [问题概览](#1-问题概览)
2. [根因复核](#2-根因复核)
3. [统一设计](#3-统一设计)
4. [精确改动清单](#4-精确改动清单)
5. [事件序列最终形态](#5-事件序列最终形态)
6. [测试更新清单](#6-测试更新清单)
7. [风险与兼容](#7-风险与兼容)
8. [是否需要 DSH 配合](#8-是否需要-dsh-配合)

---

## 1. 问题概览

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 1 | `phaseHistory` 重复歧义 | `buildFinalizeMeta` 仅做**相邻去重**（`history[last] !== currentPhase`），同阶段被其他阶段隔开后可再次追加 | UI 展示 `["finalizing", "gating", "finalizing", "gating"]`，语义错误 |
| 2 | `assessSessionId`/`gateSessionId`/`routingSessionId` 顶层冗余 | `buildFinalizeMeta` 从各 Result 内提取到顶层，schema + 事件载荷 + UI 三处重复存储 | 数据不一致风险；schema 膨胀 |
| 3 | 进入阶段不填充真实 `forkSessionId` | running 快照注入 `forkSessionId: ''`（空串），真实 id 在 `assessForked` 完成后才写入 | UI 「收尾中」badge 无真实 sessionId 可点 |
| 4 | 收尾中 badge 不可点击 | `runPhaseB` 先 commit running 快照（`assessResult=undefined`，无 `forkSessionId`）→ `assessForked` 才创建 fork 子代理 → 完成才 commit done（有 `forkSessionId`） | 「收尾中」阶段 target 为空，无法点击 |

---

## 2. 根因复核

### 2.1 phaseHistory 重复歧义（问题 1）

**现状代码**（`finalize-manager.ts` L616-620）：

```typescript
const history = [...(existing?.phaseHistory ?? [])];
if (history.length === 0 || history[history.length - 1] !== currentPhase) {
  history.push(currentPhase);
}
```

**复核结论**：用户实测 `"phaseHistory": ["finalizing", "gating", "finalizing", "gating"]` 完全可复现。

**触发路径**：
1. `commitFinalize(..., 'finalizing')` → `phaseHistory = ['finalizing']`
2. `commitFinalize(..., 'gating')` → `phaseHistory = ['finalizing', 'gating']`
3. `commitFinalize(..., 'finalizing')`（幂等重写 / completed 阶段覆盖） → 相邻去重通过（`history[1]='gating' !== 'finalizing'`），**再次追加**
4. `commitFinalize(..., 'gating')`（completed 阶段覆盖） → 相邻去重通过，**再次追加**

最终 `phaseHistory = ['finalizing', 'gating', 'finalizing', 'gating']`。

**核心缺陷**：相邻去重无法防止「被隔开后的重复追加」。

### 2.2 顶层 sessionId 冗余（问题 2）

**现状代码**（`finalize-manager.ts` L647-676）：

```typescript
return {
  currentPhase,
  ...(previousPhase !== undefined ? { previousPhase } : {}),
  ...(history.length > 0 ? { phaseHistory: history } : {}),
  // Phase B → assessResult
  ...(effectiveAssessResult === undefined
    ? {}
    : {
        assessResult: effectiveAssessResult,
        ...(options?.recordAssessSession === false
          ? {}
          : effectiveAssessResult.forkSessionId !== ''
            ? { assessSessionId: effectiveAssessResult.forkSessionId }  // ← 顶层冗余
            : {}),
      }),
  // Phase C → gateResult
  ...(effectiveGateResult === undefined
    ? {}
    : {
        gateResult: effectiveGateResult,
        ...(effectiveGateResult.gateSessionId !== '' ? { gateSessionId: effectiveGateResult.gateSessionId } : {}),  // ← 顶层冗余
      }),
  // Phase D → routingResult
  ...(effectiveRoutingResult === undefined ? {} : {
    routingResult: effectiveRoutingResult,
    ...(effectiveRoutingResult.routingSessionId !== undefined ? { routingSessionId: effectiveRoutingResult.routingSessionId } : {}),  // ← 顶层冗余
  }),
};
```

**schema 定义**（`schema.ts` L372-376）：

```typescript
assessSessionId: z.string().optional(),
gateSessionId: z.string().optional(),
routingSessionId: z.string().optional(),
```

**复核结论**：顶层字段确实是 `assessResult.forkSessionId` / `gateResult.gateSessionId` / `routingResult.routingSessionId` 的**冗余拷贝**。

**数据一致性风险**：
- `buildFinalizeMeta` 每次调用都重新从 Result 内提取到顶层，保证当前一致性
- 但 schema 允许顶层和 Result 内不同值（无 cross-field validation）
- UI 同时读两处（`finalizeAssessSessionId` 读顶层，`assessStatus` 读 Result），增加出错概率

### 2.3 进入阶段不填充真实 sessionId（问题 3）

**现状代码**（`finalize-manager.ts` L631-634）：

```typescript
const effectiveAssessResult = assessResult ?? (
  currentPhase === 'finalizing' && existing?.assessResult === undefined
    ? { status: 'running' as const, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
    : undefined
);
```

**复核结论**：running 快照注入时 `forkSessionId: ''`（空串），因为此时 `assessForked` 尚未执行、真实 fork 子代理尚未创建。

**同理**：
- `askResult.forkSessionId` 也是 `''`（L628）
- `gateResult.gateSessionId` 也是 `''`（L638）

**影响**：
- 顶层 `assessSessionId` 提取守卫 `effectiveAssessResult.forkSessionId !== ''`（L660）会跳过，顶层不写入空串（Round 16 修复 1a）
- 但 `assessResult` 内部的 `forkSessionId` 仍是空串，UI 从 Result 内读时仍为空

### 2.4 收尾中 badge 不可点击（问题 4）

**现状流程**（`stage-executor.ts` L1062-1082）：

```typescript
private async runPhaseB(...) {
  // 1. 预置内存赋值
  executed.finalizeMeta = { ...executed.finalizeMeta, currentPhase: 'finalizing' };
  // 2. commit running 快照（assessResult=undefined → 注入空快照 forkSessionId:''）
  await this.options.finalizeManager.commitFinalize(request, undefined, undefined, 'finalizing');
  // 3. assessForked 创建 fork 子代理（此时才拿到真实 forkSessionId）
  const phaseBResult = await this.options.finalizeManager.assessForked(request);
  // 4. commit done（phaseBResult 含真实 forkSessionId）
  await this.options.finalizeManager.commitFinalize(request, phaseBResult, undefined, 'finalizing');
  return phaseBResult;
}
```

**事件序列**：
1. `finalizing` + `assessStatus:'running'` + `assessResult.forkSessionId:''`（**不可点击**）
2. `finalizing` + `assessStatus:'done'` + `assessResult.forkSessionId:'real-uuid'`（可点击）

**UI 读取**（`DagStepNodeView.tsx` L181）：

```typescript
target: data.finalizeAssessSessionId,  // 来自 finalizeMeta.assessSessionId
```

**复核结论**：Step 2 之前，`finalizeAssessSessionId` 为空/undefined，badge 不可点击。用户期望：「收尾中」badge 在 fork 子代理创建后即可点击。

---

## 3. 统一设计

### 3.1 设计决策总览

| 决策点 | 推荐方案 | 理由 |
|--------|----------|------|
| phaseHistory 去重方式 | **全局去重**（`!history.includes(currentPhase)`） | 彻底消除重复；phaseHistory 记录的是「哪些阶段曾到达」而非「到达顺序」（顺序由 currentPhase/previousPhase 表达） |
| 顶层 sessionId | **删除顶层冗余字段** | 用户倾向删除；UI/事件全部改从 Result 内读；schema optional 兼容旧记录 |
| running 快照时机 | **onForkCreated 回调** | 进入阶段不 commit running 快照（避免空 sessionId 事件），改为 fork 创建后一次 commit（running + 真实 id） |
| ask-detect 在 phaseHistory 中的重复 | **仅出现一次** | ask-detect 是阶段标记，多次 ask 轮次不改变「到达过 ask-detect」的事实 |
| completed 在 phaseHistory 中 | **仅出现一次** | 终态，全局去重自然保证 |

### 3.2 phaseHistory 全局去重

**新逻辑**（`finalize-manager.ts` L616-620 替换）：

```typescript
// phaseHistory：记录所有阶段到达历史（全局去重——每阶段最多一次）。
const history = [...(existing?.phaseHistory ?? [])];
if (!history.includes(currentPhase)) {
  history.push(currentPhase);
}
```

**语义变化**：
- **旧**：`phaseHistory` 是「到达顺序序列」（可含重复）
- **新**：`phaseHistory` 是「到达阶段集合」（有序、无重复）

**影响评估**：
- UI（`UnifiedTimeline.tsx` L251-255、`DagStepNodeView.tsx` L150）用 `phases.includes('xxx')` 判断阶段是否到达 → **无影响**
- UI badge 渲染顺序由 `phases` 数组顺序决定 → **全局去重保持插入顺序，无影响**
- 测试断言 `phaseHistory` 内容 → 需更新（去除重复）

**completed 阶段特殊性**：全局去重后 `completed` 只出现一次，语义更清晰。

**ask-detect 多次轮次**：如果 ask → 用户回答 → 再次 ask（同一 Step），`phaseHistory` 中 `ask-detect` 只出现一次。这符合语义——「到达过 ask-detect 阶段」只需记录一次。

### 3.3 顶层 sessionId 删除

**删除字段**（`schema.ts` L372-376）：

```diff
- assessSessionId: z.string().optional(),
- gateSessionId: z.string().optional(),
- routingSessionId: z.string().optional(),
```

**UI 改从 Result 内读**（`run-view-model.ts` L510-511, L549）：

```diff
- finalizeAssessSessionId: step.finalizeMeta?.assessSessionId,
+ finalizeAssessSessionId: step.finalizeMeta?.assessResult?.forkSessionId,
- finalizeGateSessionId: step.finalizeMeta?.gateSessionId,
+ finalizeGateSessionId: step.finalizeMeta?.gateResult?.gateSessionId,
- finalizeRoutingSessionId: step.finalizeMeta?.routingSessionId,
+ finalizeRoutingSessionId: step.finalizeMeta?.routingResult?.routingSessionId,
```

**事件载荷改从 Result 内读**（`finalize-manager.ts` L1226-1229）：

```diff
  const details = meta === undefined ? undefined : {
-   ...(meta.assessSessionId !== undefined ? { assessSessionId: meta.assessSessionId } : {}),
-   ...(meta.gateSessionId !== undefined ? { gateSessionId: meta.gateSessionId } : {}),
-   ...(meta.routingSessionId !== undefined ? { routingSessionId: meta.routingSessionId } : {}),
+   ...(meta.assessResult?.forkSessionId !== undefined && meta.assessResult.forkSessionId !== ''
+     ? { assessSessionId: meta.assessResult.forkSessionId } : {}),
+   ...(meta.gateResult?.gateSessionId !== undefined && meta.gateResult.gateSessionId !== ''
+     ? { gateSessionId: meta.gateResult.gateSessionId } : {}),
+   ...(meta.routingResult?.routingSessionId !== undefined && meta.routingResult.routingSessionId !== ''
+     ? { routingSessionId: meta.routingResult.routingSessionId } : {}),
    ...
  };
```

**`buildFinalizeMeta` 删除顶层提取**（`finalize-manager.ts` L654-674）：

```diff
  return {
    currentPhase,
    ...(previousPhase !== undefined ? { previousPhase } : {}),
    ...(history.length > 0 ? { phaseHistory: history } : {}),
    ...(effectiveAskResult === undefined ? {} : { askResult: effectiveAskResult }),
-   ...(effectiveAssessResult === undefined
-     ? {}
-     : {
-         assessResult: effectiveAssessResult,
-         ...(options?.recordAssessSession === false
-           ? {}
-           : effectiveAssessResult.forkSessionId !== ''
-             ? { assessSessionId: effectiveAssessResult.forkSessionId }
-             : {}),
-       }),
+   ...(effectiveAssessResult === undefined ? {} : { assessResult: effectiveAssessResult }),
-   ...(effectiveGateResult === undefined
-     ? {}
-     : {
-         gateResult: effectiveGateResult,
-         ...(effectiveGateResult.gateSessionId !== '' ? { gateSessionId: effectiveGateResult.gateSessionId } : {}),
-       }),
+   ...(effectiveGateResult === undefined ? {} : { gateResult: effectiveGateResult }),
    ...(effectiveRoutingResult === undefined ? {} : {
      routingResult: effectiveRoutingResult,
-     ...(effectiveRoutingResult.routingSessionId !== undefined ? { routingSessionId: effectiveRoutingResult.routingSessionId } : {}),
    }),
  };
```

**旧数据兼容**：
- `FinalizeMetaSchema` 删除三个顶层字段后，旧记录中的 `assessSessionId`/`gateSessionId`/`routingSessionId` 会被 Zod `strip`（默认行为）忽略
- UI 改从 Result 内读，旧记录的 Result 内已有这些字段（Round 3+ 始终写入）
- **无需数据迁移**：旧记录的 Result 内字段完整，顶层冗余删除后 UI 自动切换数据源

### 3.4 onForkCreated 回调（问题 3 + 4 统一方案）

**核心思路**：`assessForked` 创建 fork 子代理后，通过回调上报真实 `forkSessionId`，调用方立即 commit running + 真实 id。

#### 3.4.1 接口变更

**`FinalizeAssessInput` 增加回调**（`finalize-manager.ts` L92-100）：

```typescript
export interface FinalizeAssessInput {
  readonly step: WorkflowStep;
  readonly stepSessionId?: string;
  readonly context: FinalizeStepContext;
  readonly workdir?: string;
  readonly signal?: AbortSignal;
  /** fork 子代理创建后回调（上报真实 forkSessionId，供调用方立即 commit running + id）。 */
  readonly onForkCreated?: (forkSessionId: string) => void;
}
```

#### 3.4.2 assessForked 实现

**`FinalizeAssessor.assessForked`**（`finalize-manager.ts` L783-843）在 `forkStepSubagent` 返回后、`driveAgentRound` 前调用回调：

```typescript
async assessForked(input: FinalizeAssessInput): Promise<FinalizeAssessResult> {
  // ...
  const forked = await forkStepSubagent(this.ctx, input.stepSessionId, { /* ... */ });
  if (forked === undefined) {
    return this.degradeFinalize(input, '...');
  }
  const { handle } = forked;
  try {
    // ★ 新增：fork 创建后立即回调上报真实 forkSessionId
    input.onForkCreated?.(handle.agent.id);

    const promptText = buildPhaseBFinalizePrompt(input.context, input.step.passThroughVars ?? []);
    let raw = await driveAgentRound(handle, promptText);
    // ...
  } finally {
    await handle.dispose();
  }
}
```

#### 3.4.3 FinalizeManager.assessForked 透传回调

**`FinalizeManager.assessForked`**（`finalize-manager.ts` L1179-1187）透传 `onForkCreated`：

```typescript
async assessForked(request: FinalizeStepRequest): Promise<FinalizeAssessResult> {
  return await this.assessor.assessForked({
    step: request.step,
    ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
    context: request.context,
    workdir: request.workdir,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onForkCreated === undefined ? {} : { onForkCreated: request.onForkCreated }),
  });
}
```

#### 3.4.4 FinalizeStepRequest 增加回调

**`FinalizeStepRequest`**（`finalize-manager.ts` L129-163）增加 `onForkCreated`：

```typescript
export interface FinalizeStepRequest {
  // ... 现有字段
  /** fork 子代理创建后回调（上报真实 forkSessionId，供调用方立即 commit running + id）。 */
  readonly onForkCreated?: (forkSessionId: string) => void;
}
```

#### 3.4.5 StageExecutor.runPhaseB 使用回调

**`stage-executor.ts` L1062-1082** 改为：

```typescript
private async runPhaseB(
  step: WorkflowStep,
  executed: ExecutedStepDefault,
  context: FinalizeStepContext,
  gates: Gates | undefined,
  state: StageRunState,
): Promise<FinalizeAssessResult | undefined> {
  if (!hasUnresolvedPassThroughVars(step) && !hasEnabledGates(gates)) {
    return undefined;
  }
  // 预置 currentPhase='finalizing'（内存赋值，非 commit）
  executed.finalizeMeta = { ...executed.finalizeMeta, currentPhase: 'finalizing' };
  const request = this.buildFinalizeRequest(step, executed, context, gates, state);

  // ★ 改动：不在进入时 commit running 快照（避免空 sessionId 事件）
  // 改为 onForkCreated 回调中 commit（running + 真实 forkSessionId）

  const phaseBResult = await this.options.finalizeManager.assessForked({
    ...request,
    onForkCreated: async (forkSessionId: string) => {
      // fork 子代理创建后立即 commit running 快照（含真实 forkSessionId）
      const runningResult: FinalizeAssessResult = {
        status: 'running',
        passThroughVars: {},
        forkSessionId,
        assessmentRaw: '',
      };
      await this.options.finalizeManager.commitFinalize(request, runningResult, undefined, 'finalizing');
    },
  });

  // 完成时 commit done
  await this.options.finalizeManager.commitFinalize(request, phaseBResult, undefined, 'finalizing');
  return phaseBResult;
}
```

**关键变化**：
- 删除 L1078 的 `commitFinalize(request, undefined, undefined, 'finalizing')`（空快照）
- 改为 `onForkCreated` 回调中 commit（`running` + 真实 `forkSessionId`）
- 完成时仍 commit `done`（`phaseBResult` 含完整结果）

#### 3.4.6 降级路径处理

**`degradeFinalize`**（`finalize-manager.ts` L845-864）不创建 fork 子代理，无 `onForkCreated` 回调。

**处理**：降级路径直接返回 `done` 结果，调用方 commit `done` 时自然携带降级的 `forkSessionId`（`newSessionHandle()`）。

**但**：降级路径无 `running` 中间态事件。评估：
- 降级路径耗时极短（单次 LLM 调用），UI 几乎看不到 `running` 状态
- 即使看到，`done` 事件立即覆盖，用户体验无感知
- **结论**：降级路径不需要 `onForkCreated` 回调，保持现状

#### 3.4.7 FinalizeManager.finalizeStep 编排入口

**`finalizeStep`**（`finalize-manager.ts` L1244-1296）是 `runPhaseB` 的替代入口（兼容模式）。

**改动**：同样支持 `onForkCreated` 回调，透传给 `assessForked`。

```typescript
async finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome> {
  // ...
  const phaseBResult = await this.assessor.assessForked({
    step: request.step,
    ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
    context: request.context,
    workdir: request.workdir,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onForkCreated === undefined ? {} : { onForkCreated: request.onForkCreated }),
  });
  await this.commitFinalize(request, phaseBResult, undefined, 'finalizing');
  // ...
}
```

---

## 4. 精确改动清单

### 4.1 schema.ts（`workflow/src/schema.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L372 | 删除 `assessSessionId: z.string().optional()` | 删除字段 |
| L374 | 删除 `gateSessionId: z.string().optional()` | 删除字段 |
| L376 | 删除 `routingSessionId: z.string().optional()` | 删除字段 |

### 4.2 finalize-manager.ts（`microflow/src/finalize-manager.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L92-100 | `FinalizeAssessInput` 增加 `onForkCreated?: (forkSessionId: string) => void` | 接口扩展 |
| L129-163 | `FinalizeStepRequest` 增加 `onForkCreated?: (forkSessionId: string) => void` | 接口扩展 |
| L157-162 | `onPhaseChange` details 类型：删除 `assessSessionId`/`gateSessionId`/`routingSessionId`，改为从 Result 内读 | 类型变更 |
| L616-620 | `buildFinalizeMeta` phaseHistory 去重改为 `!history.includes(currentPhase)` | 逻辑修复 |
| L647-676 | `buildFinalizeMeta` 删除顶层 `assessSessionId`/`gateSessionId`/`routingSessionId` 提取 | 删除冗余 |
| L783-843 | `FinalizeAssessor.assessForked` 在 `forkStepSubagent` 返回后调用 `input.onForkCreated?.(handle.agent.id)` | 回调注入 |
| L1179-1187 | `FinalizeManager.assessForked` 透传 `onForkCreated` | 透传 |
| L1226-1231 | `commitFinalize` details 组装：从 `meta.assessResult?.forkSessionId` / `meta.gateResult?.gateSessionId` / `meta.routingResult?.routingSessionId` 读取 | 数据源切换 |
| L1244-1296 | `finalizeStep` 透传 `onForkCreated` 给 `assessForked` | 透传 |

### 4.3 stage-executor.ts（`microflow/src/stage-executor.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L1072-1081 | `runPhaseB`：删除 L1078 的空快照 commit，改为 `onForkCreated` 回调中 commit running + 真实 id | 流程重构 |

### 4.4 workflow-engine.ts（`workflow/src/workflow-engine.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L2027 | `emitStepPhase` details 类型：删除 `assessSessionId`/`gateSessionId`/`routingSessionId`，事件载荷改为从 details 内的等价字段读（details 已由 commitFinalize 组装好） | 类型对齐 |

**注意**：`workflow-engine.ts` 的 `emitStepPhase` 只是透传 `details`，不组装数据。`details` 由 `commitFinalize` 组装（L1226-1231），所以 `workflow-engine.ts` 的改动仅是类型声明对齐，运行时逻辑不变。

### 4.5 seam.ts（`workflow/src/seam.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L92-94 | `sandore/step-phase` 载荷：保留 `assessSessionId`/`gateSessionId`/`routingSessionId`（事件载荷仍需携带，供 UI 读取） | **不改** |

**理由**：事件载荷的 `assessSessionId` 等字段是 UI 实时更新的数据源（`sandore-step-definition.ts` L200-202 从事件载荷累计到节点状态）。删除顶层 finalizeMeta 字段后，事件载荷仍需携带这些值（改从 Result 内读取后组装到 details）。

### 4.6 run-view-model.ts（`ui/src/client/run-view-model.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L510 | `finalizeAssessSessionId: step.finalizeMeta?.assessSessionId` → `step.finalizeMeta?.assessResult?.forkSessionId` | 数据源切换 |
| L511 | `finalizeGateSessionId: step.finalizeMeta?.gateSessionId` → `step.finalizeMeta?.gateResult?.gateSessionId` | 数据源切换 |
| L549 | `finalizeRoutingSessionId: step.finalizeMeta?.routingSessionId` → `step.finalizeMeta?.routingResult?.routingSessionId` | 数据源切换 |

### 4.7 sandore-step-definition.ts（`ui/src/client/sandore-step-definition.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L200-202 | 事件载荷累计逻辑不变（事件载荷仍携带 `assessSessionId` 等字段） | **不改** |

### 4.8 DagStepNodeView.tsx / UnifiedTimeline.tsx

**不改**：badge 渲染逻辑读取 `data.finalizeAssessSessionId`（来自 `run-view-model.ts` 映射），数据源切换在 `run-view-model.ts` 完成。

### 4.9 step-phase.ts（`ui/src/client/step-phase.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L25-27 | `assessSessionId`/`gateSessionId`/`routingSessionId` 保留（事件载荷类型） | **不改** |

---

## 5. 事件序列最终形态

### 5.1 正常路径（Phase A → B → C → D → completed）

**改动前**（当前）：

```
[1] finalizing + assessStatus:'running'  + assessResult.forkSessionId:''     ← 不可点击
[2] finalizing + assessStatus:'done'     + assessResult.forkSessionId:'uuid'  ← 可点击
[3] gating    + gateStatus:'running'     + gateResult.gateSessionId:''       ← 不可点击
[4] gating    + gateStatus:'done'        + gateResult.gateSessionId:'uuid'   ← 可点击
[5] routing   + routingStatus:'running'  + routingResult 无 routingSessionId
[6] completed + compressedOutput:'...'
```

**改动后**（推荐）：

```
[1] finalizing + assessStatus:'running'  + assessResult.forkSessionId:'uuid'  ← ★ 可点击（onForkCreated）
[2] finalizing + assessStatus:'done'     + assessResult.forkSessionId:'uuid'  ← 可点击
[3] gating    + gateStatus:'running'     + gateResult.gateSessionId:'uuid'   ← 可点击（evaluateGates 前）
[4] gating    + gateStatus:'done'        + gateResult.gateSessionId:'uuid'   ← 可点击
[5] routing   + routingStatus:'running'  + routingResult 无 routingSessionId
[6] completed + compressedOutput:'...'
```

**关键变化**：
- 事件 [1] 从「不可点击」变为「可点击」（`onForkCreated` 回调在 fork 创建后立即 commit）
- 事件总数不变（仍 6 个）
- 事件 [3]（gating running）的 `gateSessionId` 仍为空串（`evaluateGates` 前无 fork），但 Phase C 的 running 快照在 `runPhaseC` L1107 commit，此时 `gateResult` 尚未创建 → 仍为空串

**Phase C 的 gateSessionId 问题**：
- Phase C 的 `evaluateGates` 内部创建 secondary gate fork 子代理（`forkStepSubagent`），但 `runPhaseC` 在 `evaluateGates` 前就 commit running 快照
- **评估**：Phase C 的 running 快照 `gateSessionId` 为空串是合理的——门禁评估前无 fork 子代理
- 如果需要 Phase C 的 running 快照也有真实 `gateSessionId`，需要在 `evaluateGates` 内部也加 `onForkCreated` 回调（但 secondary gate 是可选的，primary 纯代码校验不建子代理）
- **推荐**：Phase C 保持现状（running 快照无 `gateSessionId`），Phase B 的 `onForkCreated` 是主要改动点

### 5.2 降级路径（fork 失败 → 临时会话）

```
[1] finalizing + assessStatus:'done'  + assessResult.forkSessionId:'eval-uuid'  ← 可点击（降级路径无 running 中间态）
```

降级路径无 `onForkCreated` 回调（不创建 fork 子代理），直接 commit `done`。用户几乎感知不到。

### 5.3 门禁失败路径

```
[1] finalizing + assessStatus:'running'  + assessResult.forkSessionId:'uuid'  ← 可点击
[2] finalizing + assessStatus:'done'     + assessResult.forkSessionId:'uuid'  ← 可点击
[3] gating    + gateStatus:'running'     + gateResult.gateSessionId:''       ← 不可点击
[4] gating    + gateStatus:'failed'      + gateResult.gateSessionId:'uuid'   ← 可点击
```

---

## 6. 测试更新清单

### 6.1 finalize-manager.spec.ts

| 测试 | 改动 |
|------|------|
| L1319 `records a complete finalizeMeta` | 删除 `assessSessionId`/`gateSessionId` 顶层断言；改为 `assessResult.forkSessionId` / `gateResult.gateSessionId` 断言 |
| L1533 `commitFinalize 组装 finalizeMeta` | 同上 |
| L1594 `commitFinalize onPhaseChange 传递 details` | `details` 类型删除 `assessSessionId`/`gateSessionId`/`routingSessionId`；断言改为从 details 内的等价字段读（details 由 commitFinalize 从 Result 内组装） |
| L1695 `Phase A ask 保底中断` | 删除 `assessSessionId` 顶层断言；验证 `assessResult` 无 `forkSessionId`（Phase A 临时会话） |
| **新增** | `assessForked onForkCreated 回调`：验证 fork 创建后回调被调用、参数为真实 `forkSessionId` |
| **新增** | `buildFinalizeMeta phaseHistory 全局去重`：验证同阶段多次 commit 不重复追加 |

### 6.2 stage-executor.spec.ts

| 测试 | 改动 |
|------|------|
| L875-888 Phase A 中断 / Phase B 持久化 | 删除 `assessSessionId` 顶层断言；改为 `assessResult.forkSessionId` 断言 |
| L984 `assessSessionId` | 同上 |
| L1039 降级路径 | 同上 |
| **新增** | `runPhaseB onForkCreated`：验证 fork 创建后 commit running 快照（含真实 `forkSessionId`） |

### 6.3 workflow-engine.spec.ts

| 测试 | 改动 |
|------|------|
| L2789-2823 `Session append 载荷携带 finalizeMeta 详情` | 事件载荷的 `assessSessionId`/`gateSessionId` 仍从 details 读（details 由 commitFinalize 从 Result 内组装），断言不变 |
| L4265-4266 `gateSessionId` | 改为 `gateResult.gateSessionId` 断言 |
| L4375-4378 `assessSessionId` | 改为 `assessResult.forkSessionId` 断言 |

### 6.4 workflow-engine-e2e.spec.ts

| 测试 | 改动 |
|------|------|
| L201-215 `assessSessionId`/`gateSessionId`/`phaseHistory` | 事件载荷断言不变（details 仍携带）；持久化断言改为 `assessResult.forkSessionId` / `gateResult.gateSessionId` |
| L211-215 `phaseHistory 累计` | 更新为全局去重后的预期值（无重复） |

### 6.5 run-view-model.spec.ts

| 测试 | 改动 |
|------|------|
| L282-330 `buildTimeline 收尾字段` | 删除 `assessSessionId`/`gateSessionId` 顶层字段；改为 `assessResult.forkSessionId` / `gateResult.gateSessionId` |
| L332-375 `propagates finalizeMeta.currentPhase=completed` | 同上 |
| L374-425 其他测试 | 同上 |

### 6.6 sandore-step-definition.spec.ts

| 测试 | 改动 |
|------|------|
| L237-251 `folds sandore/step-phase` | 事件载荷仍携带 `assessSessionId`，断言不变 |
| L253-271 `accumulates phase fields` | 同上 |
| L360-376 `buildViewNode` | 同上 |

---

## 7. 风险与兼容

### 7.1 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 删除顶层字段后旧记录兼容 | **低** | Zod `strip` 忽略未知字段；UI 改从 Result 内读；旧记录 Result 内字段完整 |
| phaseHistory 全局去重后测试断言 | **低** | 更新测试预期值（去除重复） |
| onForkCreated 回调异步性 | **低** | `onForkCreated` 是同步回调（`forkStepSubagent` 返回后立即调用），不涉及异步竞态 |
| Phase C gateSessionId 仍为空串 | **低** | Phase C running 快照无 `gateSessionId` 是合理行为（门禁评估前无 fork）；UI 已有空串守卫 |
| 事件载荷 `assessSessionId` 等字段来源变化 | **低** | 事件载荷字段名不变，只是数据源从顶层改为 Result 内（`commitFinalize` details 组装逻辑变更） |

### 7.2 兼容性

- **向后兼容**：旧记录的 `finalizeMeta` 含顶层 `assessSessionId` 等字段 → Zod `strip` 忽略 → UI 从 Result 内读 → 无影响
- **向前不兼容**：新代码写入的 `finalizeMeta` 不含顶层字段 → 旧 UI 读 `finalizeMeta.assessSessionId` 为 undefined → badge 不可点击
  - **缓解**：旧 UI 不存在（本次改动同时更新 UI），不存在向前兼容问题

### 7.3 回滚方案

- 删除的顶层字段可通过 `buildFinalizeMeta` 重新添加（恢复 L654-674 的提取逻辑）
- phaseHistory 去重可通过恢复相邻去重逻辑回滚
- onForkCreated 回调可通过删除回调参数回滚

---

## 8. 是否需要 DSH 配合

**不需要**。

本次改动完全在 sandore 仓库内：
- `workflow/src/schema.ts`（schema 定义）
- `microflow/src/finalize-manager.ts`（核心逻辑）
- `microflow/src/stage-executor.ts`（调用方）
- `workflow/src/workflow-engine.ts`（事件透传）
- `ui/src/client/run-view-model.ts`（UI 映射）
- 测试文件

DSH 源码（`deepseek-harness`）仅作只读参考，无需修改。
