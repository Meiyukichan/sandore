# Round 17：finalizeMeta 结构精简重构

> 日期：2026-08-17
> 基线：805/35 测试全绿
> 约束：**只读分析 + 方案文档，禁止修改业务代码**
> 用户设计决策：**严格遵循**（见 §3）

---

## 目录

1. [现状根因分析](#1-现状根因分析)
2. [用户设计决策](#2-用户设计决策)
3. [重构方案](#3-重构方案)
4. [事件序列最终形态](#4-事件序列最终形态)
5. [精确改动清单](#5-精确改动清单)
6. [测试更新清单](#6-测试更新清单)
7. [风险与旧数据兼容](#7-风险与旧数据兼容)
8. [是否需要 DSH 配合](#8-是否需要-dsh-配合)

---

## 1. 现状根因分析

### 1.1 phaseHistory 重复歧义（用户要求删除）

**现状代码**（`finalize-manager.ts` L616-620）：

```typescript
const history = [...(existing?.phaseHistory ?? [])];
if (history.length === 0 || history[history.length - 1] !== currentPhase) {
  history.push(currentPhase);
}
```

**问题**：相邻去重无法防止「被隔开后的重复追加」——实测可出现 `["finalizing", "gating", "finalizing", "gating"]`。

**用户判断**：`phaseHistory` **没意义**——各阶段 Result 的 `status`（running/done/failed）本身就能表达每个阶段的状态与顺序，从 Result 就能读最新状态和 sessionId。UI 不再依赖 phaseHistory 判断阶段完成（改用 Result.status）。

**结论**：**删除 phaseHistory 字段**。

### 1.2 顶层 sessionId 冗余（用户要求删除）

**现状**：`buildFinalizeMeta`（L658-674）从各 Result 内提取 sessionId 到顶层：

```
finalizeMeta.assessSessionId ← assessResult.forkSessionId   （冗余拷贝）
finalizeMeta.gateSessionId   ← gateResult.gateSessionId     （冗余拷贝）
finalizeMeta.routingSessionId← routingResult.routingSessionId（冗余拷贝）
```

**用户判断**：sessionId 只放各阶段 Result 内（`assessResult.forkSessionId`、`gateResult.gateSessionId`、`routingResult.routingSessionId`）。顶层删除后，UI 统一读 `finalizeMeta.assessResult.forkSessionId` 等。

**结论**：**删除顶层 `assessSessionId`/`gateSessionId`/`routingSessionId`**。

### 1.3 Result status 字段不完整（用户要求统一）

**现状**：
| Result | status 字段 | 枚举 | 是否必填 |
|--------|------------|------|---------|
| `askResult` | `status` | `PhaseStatusSchema` (`running`/`done`) | optional |
| `assessResult` | `status` | `PhaseStatusSchema` (`running`/`done`) | optional |
| `gateResult` | `status` | `GatePhaseStatusSchema` (`running`/`done`/`failed`) | optional |
| `routingResult` | `status` | `PhaseStatusSchema` (`running`/`done`) | optional |

**用户判断**：所有 Result 的 `status` 应必填（进入阶段='running'、完成='done'/'failed'）。UI 直接用 status 判断阶段显示（不再 isPhaseDone 推断）。

**结论**：**将各 Result 的 `status` 从 optional 改为 required**。

### 1.4 进入阶段不立即填充真实 forkSessionId（用户要求修复）

**现状**（`stage-executor.ts` L1072-1081）：

```typescript
// runPhaseB：先 commit running 快照（assessResult=undefined → 注入空快照）
await this.options.finalizeManager.commitFinalize(request, undefined, undefined, 'finalizing');
// 然后 assessForked 创建 fork 子代理（此时才拿到真实 forkSessionId）
const phaseBResult = await this.options.finalizeManager.assessForked(request);
// 完成时 commit done
await this.options.finalizeManager.commitFinalize(request, phaseBResult, undefined, 'finalizing');
```

**问题**：running 快照 `forkSessionId` 为空串，UI「收尾中」badge 不可点击。

**用户判断**：创建 fork 子代理后立即填 `assessResult={status:'running', forkSessionId:id}`，通过 `onForkCreated` 回调上报。

**结论**：**`FinalizeAssessInput` 加 `onForkCreated` 回调**，`assessForked` 在 `forkStepSubagent` 返回 handle 后立即回调。

### 1.5 字段命名不一致（用户要求统一）

**现状**：顶层字段名 `assessSessionId` 与 Result 内 `forkSessionId` 不一致；`gateSessionId` 与 Result 内 `gateSessionId` 一致；`routingSessionId` 与 Result 内 `routingSessionId` 一致。

**用户判断**：删除顶层后天然一致——UI 统一读 `finalizeMeta.assessResult.forkSessionId` 等。

**结论**：**删除顶层冗余后，字段命名自然统一**。

---

## 2. 用户设计决策

| # | 决策 | 说明 |
|---|------|------|
| 1 | **删除 `phaseHistory` 字段** | 各阶段 Result 的 status 本身就能表达每个阶段的状态与顺序 |
| 2 | **删除顶层冗余 sessionId** | sessionId 只放各阶段 Result 内（`assessResult.forkSessionId`、`gateResult.gateSessionId`、`routingResult.routingSessionId`） |
| 3 | **Result 加 status**（部分已做） | `askResult.status`/`assessResult.status`/`gateResult.status`/`routingResult.status`，从 optional 改为 required |
| 4 | **创建时就填充 Result** | 进入阶段创建 fork 子代理后立即填 `assessResult={status:'running', forkSessionId:id}`，通过 `onForkCreated` 回调 |
| 5 | **字段命名统一** | 删除顶层后天然一致 |

---

## 3. 重构方案

### 3.1 schema.ts（`workflow/src/schema.ts`）

#### 3.1.1 FinalizeMetaSchema 删除字段

**删除**（L362, L372-376）：

```diff
  export const FinalizeMetaSchema = z.object({
    currentPhase: z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed']).optional(),
    previousPhase: z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed']).optional(),
-   phaseHistory: z.array(z.enum(['ask-detect', 'finalizing', 'gating', 'routing', 'completed'])).optional(),
    askResult: FinalizeAskResultSchema.optional(),
    assessResult: FinalizeAssessResultSchema.optional(),
    gateResult: GateEvalResultSchema.optional(),
    routingResult: RoutingResultSchema.optional(),
-   assessSessionId: z.string().optional(),
-   gateSessionId: z.string().optional(),
-   routingSessionId: z.string().optional(),
    directory: z.string().optional(),
    errorDetail: z.string().optional(),
  })
```

#### 3.1.2 各 Result status 改为 required

```diff
  // FinalizeAssessResultSchema (L272-282)
  export const FinalizeAssessResultSchema = z.object({
-   status: PhaseStatusSchema.optional(),
+   status: PhaseStatusSchema,  // required: running | done
    passThroughVars: z.record(z.string(), z.string()),
    ...
  })

  // FinalizeAskResultSchema (L290-299)
  export const FinalizeAskResultSchema = z.object({
-   status: PhaseStatusSchema.optional(),
+   status: PhaseStatusSchema,  // required: running | done
    hasAsk: z.boolean(),
    ...
  })

  // GateEvalResultSchema (L302-315)
  export const GateEvalResultSchema = z.object({
-   status: GatePhaseStatusSchema.optional(),
+   status: GatePhaseStatusSchema,  // required: running | done | failed
    gatesPassed: z.boolean(),
    ...
  })

  // RoutingResultSchema (L332-338)
  export const RoutingResultSchema = z.object({
-   status: PhaseStatusSchema.optional(),
+   status: PhaseStatusSchema,  // required: running | done
    ...
  })
```

#### 3.1.3 Zod 旧数据兼容性确认

**Zod `z.object()` 默认行为**：`strip` 模式——解析时忽略未知字段（不报错），输出时剔除。

- 旧记录含 `phaseHistory`/`assessSessionId`/`gateSessionId`/`routingSessionId` → Zod `strip` 自动忽略 → **解析不失败**
- 旧记录的 Result 含 `status: 'done'`（Round 11 已写入）→ 满足 required 约束 → **解析不失败**
- 极老记录（Round 11 前）的 Result 缺 `status` → required 约束会报错 → **需要 `.default()` 兜底或 `.optional()` 保持**

**推荐**：为兼容极老记录，`status` 保持 `.optional()` 但**代码保证必填**（所有写入点都填 status）。这是最小侵入方案——不改 schema 的 optional 约束（避免旧数据解析失败），但代码保证运行时必填。

**替代方案**：`status: PhaseStatusSchema.default('done')`——旧记录缺 status 时默认 `done`（已完成阶段的 Result 必然是 done）。但 default 会改变 `z.infer` 类型（从 `'running' | 'done' | undefined` 变为 `'running' | 'done'`），需评估影响。

**最终推荐**：**保持 optional**（schema 不改 required），代码保证必填。理由：
1. 不破坏旧数据解析
2. 代码已全面保证必填（所有 commitFinalize 路径都填 status）
3. UI 已有 fallback（`data.askStatus !== undefined ? statusDone : legacyDone`）

### 3.2 finalize-manager.ts（`microflow/src/finalize-manager.ts`）

#### 3.2.1 FinalizeAssessInput 增加 onForkCreated 回调

**L92-100**：

```diff
  export interface FinalizeAssessInput {
    readonly step: WorkflowStep;
    readonly stepSessionId?: string;
    readonly context: FinalizeStepContext;
    readonly workdir?: string;
    readonly signal?: AbortSignal;
+   /** fork 子代理创建后回调（上报真实 forkSessionId，供调用方立即 commit running + id）。 */
+   readonly onForkCreated?: (forkSessionId: string) => void;
  }
```

#### 3.2.2 FinalizeStepRequest 增加 onForkCreated 回调

**L129-163**：

```diff
  export interface FinalizeStepRequest {
    // ... 现有字段
+   /** fork 子代理创建后回调（上报真实 forkSessionId，供调用方立即 commit running + id）。 */
+   readonly onForkCreated?: (forkSessionId: string) => void;
  }
```

#### 3.2.3 FinalizeAssessor.assessForked 调用回调

**L783-843**，在 `forkStepSubagent` 返回 `handle` 后、`driveAgentRound` 前：

```diff
  const { handle } = forked;
  try {
+   // fork 创建后立即回调上报真实 forkSessionId
+   input.onForkCreated?.(handle.agent.id);
+
    const promptText = buildPhaseBFinalizePrompt(input.context, input.step.passThroughVars ?? []);
    let raw = await driveAgentRound(handle, promptText);
    ...
```

#### 3.2.4 FinalizeManager.assessForked 透传回调

**L1179-1187**：

```diff
  async assessForked(request: FinalizeStepRequest): Promise<FinalizeAssessResult> {
    return await this.assessor.assessForked({
      step: request.step,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      context: request.context,
      workdir: request.workdir,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
+     ...(request.onForkCreated === undefined ? {} : { onForkCreated: request.onForkCreated }),
    });
  }
```

#### 3.2.5 buildFinalizeMeta 删除 phaseHistory 和顶层 sessionId

**L606-677**：

```diff
  function buildFinalizeMeta(
    existing: FinalizeMeta | undefined,
    assessResult: FinalizeAssessResult | undefined,
    gateResult: GateEvalResult | undefined,
    currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
    options?: { readonly recordAssessSession?: boolean; readonly askResult?: FinalizeAskResult; readonly routingResult?: RoutingResult },
  ): FinalizeMeta {
    const previousPhase = existing?.currentPhase;
-   // phaseHistory：记录所有阶段到达历史（去重相邻相同值）。
-   const history = [...(existing?.phaseHistory ?? [])];
-   if (history.length === 0 || history[history.length - 1] !== currentPhase) {
-     history.push(currentPhase);
-   }
-
    // Round 11：进入阶段时自动注入 running 空快照
    const effectiveAskResult = options?.askResult ?? (
      currentPhase === 'ask-detect' && existing?.askResult === undefined
        ? { status: 'running' as const, hasAsk: false, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
        : undefined
    );
    const effectiveAssessResult = assessResult ?? (
      currentPhase === 'finalizing' && existing?.assessResult === undefined
        ? { status: 'running' as const, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
        : undefined
    );
    const effectiveGateResult = gateResult ?? (
      currentPhase === 'gating' && existing?.gateResult === undefined
        ? { status: 'running' as const, gatesPassed: false, gateSessionId: '', assessmentRaw: '' }
        : undefined
    );
    const effectiveRoutingResult = options?.routingResult ?? (
      currentPhase === 'routing' && existing?.routingResult === undefined
        ? { status: 'running' as const }
        : undefined
    );

    return {
      currentPhase,
      ...(previousPhase !== undefined ? { previousPhase } : {}),
-     ...(history.length > 0 ? { phaseHistory: history } : {}),
      ...(effectiveAskResult === undefined ? {} : { askResult: effectiveAskResult }),
-     ...(effectiveAssessResult === undefined
-       ? {}
-       : {
-           assessResult: effectiveAssessResult,
-           ...(options?.recordAssessSession === false
-             ? {}
-             : effectiveAssessResult.forkSessionId !== ''
-               ? { assessSessionId: effectiveAssessResult.forkSessionId }
-               : {}),
-         }),
-     ...(effectiveGateResult === undefined
-       ? {}
-       : {
-           gateResult: effectiveGateResult,
-           ...(effectiveGateResult.gateSessionId !== '' ? { gateSessionId: effectiveGateResult.gateSessionId } : {}),
-         }),
-     ...(effectiveRoutingResult === undefined ? {} : {
-       routingResult: effectiveRoutingResult,
-       ...(effectiveRoutingResult.routingSessionId !== undefined ? { routingSessionId: effectiveRoutingResult.routingSessionId } : {}),
-     }),
+     ...(effectiveAssessResult === undefined ? {} : { assessResult: effectiveAssessResult }),
+     ...(effectiveGateResult === undefined ? {} : { gateResult: effectiveGateResult }),
+     ...(effectiveRoutingResult === undefined ? {} : { routingResult: effectiveRoutingResult }),
    };
  }
```

**同时删除 `recordAssessSession` 选项**（不再需要——顶层 sessionId 已删除，`recordAssessSession` 仅用于控制顶层写入）。

#### 3.2.6 commitFinalize details 组装改为从 Result 内读

**L1225-1240**：

```diff
  const meta = request.executedStep.finalizeMeta;
  const details = meta === undefined ? undefined : {
-   ...(meta.assessSessionId !== undefined ? { assessSessionId: meta.assessSessionId } : {}),
-   ...(meta.gateSessionId !== undefined ? { gateSessionId: meta.gateSessionId } : {}),
-   ...(meta.routingSessionId !== undefined ? { routingSessionId: meta.routingSessionId } : {}),
-   ...(meta.phaseHistory !== undefined ? { phaseHistory: meta.phaseHistory } : {}),
+   // sessionId 从 Result 内读（顶层已删除）
+   ...(meta.assessResult?.forkSessionId !== undefined && meta.assessResult.forkSessionId !== ''
+     ? { assessSessionId: meta.assessResult.forkSessionId } : {}),
+   ...(meta.gateResult?.gateSessionId !== undefined && meta.gateResult.gateSessionId !== ''
+     ? { gateSessionId: meta.gateResult.gateSessionId } : {}),
+   ...(meta.routingResult?.routingSessionId !== undefined && meta.routingResult.routingSessionId !== ''
+     ? { routingSessionId: meta.routingResult.routingSessionId } : {}),
    // Round 10：仅 completed 阶段携带 compressedOutput
    ...(currentPhase === 'completed' && meta.assessResult?.compressedOutput !== undefined
      ? { compressedOutput: meta.assessResult.compressedOutput }
      : {}),
    // Round 11：透传各阶段独立 status 字段到事件载荷
    ...(meta.askResult?.status !== undefined ? { askStatus: meta.askResult.status } : {}),
    ...(meta.assessResult?.status !== undefined ? { assessStatus: meta.assessResult.status } : {}),
    ...(meta.gateResult?.status !== undefined ? { gateStatus: meta.gateResult.status } : {}),
    ...(meta.routingResult?.status !== undefined ? { routingStatus: meta.routingResult.status } : {}),
  };
```

#### 3.2.7 onPhaseChange 类型变更

**L157-162**（`FinalizeStepRequest.onPhaseChange` details 类型）：

```diff
  readonly onPhaseChange?: (
    step: WorkflowStep,
    childId: string | undefined,
    phase: FinalizePhase,
-   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; phaseHistory?: readonly string[]; compressedOutput?: string },
+   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; compressedOutput?: string; askStatus?: 'running' | 'done'; assessStatus?: 'running' | 'done'; gateStatus?: 'running' | 'done' | 'failed'; routingStatus?: 'running' | 'done' },
  ) => void;
```

**同理**（`stage-executor.ts` L83-88 `StageStepHooks.onPhaseChange` 类型）：

```diff
  readonly onPhaseChange?: (
    step: WorkflowStep,
    childId: string | undefined,
    phase: FinalizePhase,
-   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; phaseHistory?: readonly string[]; compressedOutput?: string },
+   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; compressedOutput?: string; askStatus?: 'running' | 'done'; assessStatus?: 'running' | 'done'; gateStatus?: 'running' | 'done' | 'failed'; routingStatus?: 'running' | 'done' },
  ) => void;
```

#### 3.2.8 finalizeStep 透传 onForkCreated

**L1244-1296**：

```diff
  async finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome> {
    // ...
    const phaseBResult = await this.assessor.assessForked({
      step: request.step,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      context: request.context,
      workdir: request.workdir,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
+     ...(request.onForkCreated === undefined ? {} : { onForkCreated: request.onForkCreated }),
    });
    // ...
  }
```

### 3.3 stage-executor.ts（`microflow/src/stage-executor.ts`）

#### 3.3.1 runPhaseB：onForkCreated 替代空快照 commit

**L1062-1082**：

```diff
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
    executed.finalizeMeta = { ...executed.finalizeMeta, currentPhase: 'finalizing' };
    const request = this.buildFinalizeRequest(step, executed, context, gates, state);
-   // 问题 A 修复：进入 Phase B 时先 commit running 快照
-   await this.options.finalizeManager.commitFinalize(request, undefined, undefined, 'finalizing');
-   const phaseBResult = await this.options.finalizeManager.assessForked(request);
+   // onForkCreated 回调：fork 子代理创建后立即 commit running 快照（含真实 forkSessionId）
+   const phaseBResult = await this.options.finalizeManager.assessForked({
+     ...request,
+     onForkCreated: async (forkSessionId: string) => {
+       const runningResult: FinalizeAssessResult = {
+         status: 'running',
+         passThroughVars: {},
+         forkSessionId,
+         assessmentRaw: '',
+       };
+       await this.options.finalizeManager.commitFinalize(request, runningResult, undefined, 'finalizing');
+     },
+   });
    await this.options.finalizeManager.commitFinalize(request, phaseBResult, undefined, 'finalizing');
    return phaseBResult;
  }
```

**推荐 L1078 保留与否分析**：

| 方案 | 事件序列 | 推荐 |
|------|---------|------|
| **删除 L1078**（当前方案） | `finalizing(running+id)` → `finalizing(done+id)` = 2 个事件 | ✅ **推荐** |
| 保留 L1078 + onForkCreated | `finalizing(running+空)` → `finalizing(running+id)` → `finalizing(done+id)` = 3 个事件 | ❌ 多一个无用事件 |

**理由**：删除 L1078 后，事件 [1] 从空快照变为真实 id（可点击），事件总数从 2 变为 2（running 有 id → done），无信息丢失。保留 L1078 会多一个空快照事件（running 无 id），UI 看到后立即被 onForkCreated 的 running+id 覆盖，无实际价值。

#### 3.3.2 runPhaseC：保持现状

**L1093-1130**：`runPhaseC` L1108 的 running 快照（`gateResult=undefined` → 注入 running 快照 `gateSessionId:''`）**保持不变**。

**理由**：
- Phase C 的 `evaluateGates` 内部创建 secondary gate fork 子代理，但 `runPhaseC` 在 `evaluateGates` 前就 commit running 快照
- secondary gate 是可选的（`secondary.enabled:true` 才跑），primary 纯代码校验不建子代理
- 在 `evaluateGates` 内部也加 `onForkCreated` 回调侵入性大（GateEvaluator.evaluate 内部逻辑复杂）
- **Phase C running 快照 `gateSessionId` 为空串是合理的**——门禁评估前无 fork 子代理
- UI 已有空串守卫（`badge.target !== undefined && badge.target !== ''`）

### 3.4 workflow-engine.ts（`workflow/src/workflow-engine.ts`）

#### 3.4.1 emitStepPhase details 类型对齐

**L2019-2036**（`emitStepPhase` 方法签名）：

```diff
  private emitStepPhase(
    session: Session,
    info: DagRunInfo,
    stepId: string,
    childId: string,
    phase: FinalizePhase,
    name: string,
    loopIteration?: number[],
-   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; phaseHistory?: readonly string[]; compressedOutput?: string; askStatus?: 'running' | 'done'; assessStatus?: 'running' | 'done'; gateStatus?: 'running' | 'done' | 'failed'; routingStatus?: 'running' | 'done' },
+   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; compressedOutput?: string; askStatus?: 'running' | 'done'; assessStatus?: 'running' | 'done'; gateStatus?: 'running' | 'done' | 'failed'; routingStatus?: 'running' | 'done' },
  ): void {
```

**注意**：`emitStepPhase` 只是透传 `details`，不组装数据。`details` 由 `commitFinalize` 组装（L1225-1240），所以 `workflow-engine.ts` 的改动仅是类型声明对齐。

### 3.5 seam.ts（`workflow/src/seam.ts`）

**L60-63, L85-103**：`sandore/step-phase` 事件载荷类型——**删除 `phaseHistory`，保留 `assessSessionId`/`gateSessionId`/`routingSessionId`**（事件载荷仍需携带这些值，供 UI 实时更新）。

```diff
  'sandore/step-phase'(
    info: DagRunInfo, stepId: string, childId: string, phase: FinalizePhase, name: string,
    loopIteration?: number[],
-   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; phaseHistory?: readonly string[]; compressedOutput?: string; askStatus?: 'running' | 'done'; assessStatus?: 'running' | 'done'; gateStatus?: 'running' | 'done' | 'failed'; routingStatus?: 'running' | 'done' },
+   details?: { assessSessionId?: string; gateSessionId?: string; routingSessionId?: string; compressedOutput?: string; askStatus?: 'running' | 'done'; assessStatus?: 'running' | 'done'; gateStatus?: 'running' | 'done' | 'failed'; routingStatus?: 'running' | 'done' },
  ): void;
```

**SessionEventMap 中的 `sandore/step-phase`（L85-103）**：

```diff
  'sandore/step-phase': {
    stepId: string;
    childId: string;
    phase: FinalizePhase;
    name: string;
    loopIteration?: number[];
    assessSessionId?: string;
    gateSessionId?: string;
    routingSessionId?: string;
-   phaseHistory?: readonly string[];
    compressedOutput?: string;
    askStatus?: 'running' | 'done';
    assessStatus?: 'running' | 'done';
    gateStatus?: 'running' | 'done' | 'failed';
    routingStatus?: 'running' | 'done';
  };
```

### 3.6 UI 层改动

#### 3.6.1 run-view-model.ts（`ui/src/client/run-view-model.ts`）

**L510-511, L549**：数据源切换（顶层 → Result 内）。

```diff
- finalizeAssessSessionId: step.finalizeMeta?.assessSessionId,
+ finalizeAssessSessionId: step.finalizeMeta?.assessResult?.forkSessionId,
- finalizeGateSessionId: step.finalizeMeta?.gateSessionId,
+ finalizeGateSessionId: step.finalizeMeta?.gateResult?.gateSessionId,
- finalizeRoutingSessionId: step.finalizeMeta?.routingSessionId,
+ finalizeRoutingSessionId: step.finalizeMeta?.routingResult?.routingSessionId,
```

**L550**：删除 `finalizePhaseHistory` 映射。

```diff
- finalizePhaseHistory: step.finalizeMeta?.phaseHistory,
```

**L552-555**：status 顶层便捷字段保持不变（已从 Result 内读）。

**L231-250（TimelineStepItem 类型）**：

```diff
  readonly finalizeAssessSessionId?: string | undefined    // 数据源改为 assessResult.forkSessionId
  readonly finalizeGateSessionId?: string | undefined      // 数据源改为 gateResult.gateSessionId
  readonly finalizeRoutingSessionId?: string | undefined   // 数据源改为 routingResult.routingSessionId
- readonly finalizePhaseHistory?: readonly string[] | undefined  // 删除
  readonly askStatus?: 'running' | 'done'                  // 保持
  readonly assessStatus?: 'running' | 'done'               // 保持
  readonly gateStatus?: 'running' | 'done' | 'failed'      // 保持
  readonly routingStatus?: 'running' | 'done'              // 保持
```

#### 3.6.2 sandore-step-definition.ts（`ui/src/client/sandore-step-definition.ts`）

**L45, L81**：删除 `finalizePhaseHistory` 字段。

```diff
  // SandoreStepChatData (L28-59)
  readonly SandoreStepChatData {
    ...
-   readonly finalizePhaseHistory?: readonly string[]
    readonly finalizeAssessSessionId?: string
    ...
  }

  // SandoreStepState (L69-92)
  interface SandoreStepState {
    ...
-   readonly finalizePhaseHistory?: readonly string[]
    readonly finalizeAssessSessionId?: string
    ...
  }
```

**L194-210（step-phase 事件累计逻辑）**：删除 `phaseHistory` 累计。

```diff
  case 'sandore/step-phase': {
    const data = match.event.data
    return {
      ...context.state,
      finalizePhase: data.phase,
-     ...(data.phaseHistory !== undefined ? { finalizePhaseHistory: data.phaseHistory } : {}),
      ...(data.assessSessionId !== undefined && data.assessSessionId !== '' ? { finalizeAssessSessionId: data.assessSessionId } : {}),
      ...
    }
  }
```

**L238-249（buildViewNode 投影）**：删除 `finalizePhaseHistory` 投影。

```diff
  data: {
    ...
-   ...(state.finalizePhaseHistory === undefined ? {} : { finalizePhaseHistory: state.finalizePhaseHistory }),
    ...
  }
```

#### 3.6.3 DagStepNodeView.tsx（`ui/src/client/DagStepNodeView.tsx`）

**StepPhaseBadges（L143-250）**：删除 `phaseHistory` 依赖，改用 Result.status 判断。

```diff
  function StepPhaseBadges({ data, t, openSession }: { ... }) {
    const badges: Array<{ ... }> = []

-   const phases = data.finalizePhaseHistory ?? []
-
-   // Phase A 状态
-   const hasAskDetect = phases.includes('ask-detect')
-   const isCurrentlyDetecting = data.finalizePhase === 'ask-detect'
-   if (hasAskDetect || isCurrentlyDetecting) {
-     const statusDone = data.askStatus === 'done'
-     const legacyDone = hasAskDetect && !isCurrentlyDetecting && isPhaseDone('ask-detect', data.finalizePhase)
-     const done = data.askStatus !== undefined ? statusDone : legacyDone
+   // Phase A 状态：直接用 askStatus 判断
+   if (data.askStatus !== undefined) {
+     const done = data.askStatus === 'done'
      badges.push({
        key: 'phase-a',
        labelKey: done ? 'run.step.finalize.phase.detected' : 'run.step.finalize.phase.detecting',
        phase: 'ask-detect',
        target: undefined,
-       isActive: isCurrentlyDetecting && !done,
+       isActive: !done,
        isFailed: false,
      })
    }

-   // Phase B 状态
-   const hasFinalizing = phases.includes('finalizing')
-   const isCurrentlyFinalizing = data.finalizePhase === 'finalizing'
-   if (hasFinalizing || isCurrentlyFinalizing) {
-     const statusDone = data.assessStatus === 'done'
-     const legacyDone = hasFinalizing && !isCurrentlyFinalizing && isPhaseDone('finalizing', data.finalizePhase)
-     const done = data.assessStatus !== undefined ? statusDone : legacyDone
+   // Phase B 状态：直接用 assessStatus 判断
+   if (data.assessStatus !== undefined) {
+     const done = data.assessStatus === 'done'
      badges.push({
        key: 'phase-b',
        labelKey: done ? 'run.step.finalize.phase.done' : 'run.step.finalize.phase.finalizing',
        phase: 'finalizing',
        target: data.finalizeAssessSessionId,
-       isActive: isCurrentlyFinalizing && !done,
+       isActive: !done,
        isFailed: false,
      })
    }

-   // Phase C 状态
-   const hasGating = phases.includes('gating')
-   const isCurrentlyGating = data.finalizePhase === 'gating'
-   if (hasGating || isCurrentlyGating) {
-     const statusDone = data.gateStatus === 'done'
-     const statusFailed = data.gateStatus === 'failed'
-     const legacyDone = hasGating && !isCurrentlyGating && isPhaseDone('gating', data.finalizePhase)
-     const done = data.gateStatus !== undefined ? statusDone : legacyDone
-     const failed = data.gateStatus !== undefined ? statusFailed : false
+   // Phase C 状态：直接用 gateStatus 判断
+   if (data.gateStatus !== undefined) {
+     const done = data.gateStatus === 'done'
+     const failed = data.gateStatus === 'failed'
      badges.push({
        key: 'phase-c',
        labelKey: failed ? 'run.step.finalize.phase.gate-failed'
              : done  ? 'run.step.finalize.phase.gated'
                      : 'run.step.finalize.phase.gating',
        phase: 'gating',
        target: data.finalizeGateSessionId,
-       isActive: isCurrentlyGating && !done && !failed,
+       isActive: !done && !failed,
        isFailed: failed,
      })
    }

-   // Phase D 状态
-   const hasRouting = phases.includes('routing')
-   const isCurrentlyRouting = data.finalizePhase === 'routing'
-   if (hasRouting || isCurrentlyRouting) {
-     const statusDone = data.routingStatus === 'done'
-     const legacyDone = hasRouting && !isCurrentlyRouting && isPhaseDone('routing', data.finalizePhase)
-     const done = data.routingStatus !== undefined ? statusDone : legacyDone
+   // Phase D 状态：直接用 routingStatus 判断
+   if (data.routingStatus !== undefined) {
+     const done = data.routingStatus === 'done'
      badges.push({
        key: 'phase-d',
        labelKey: done ? 'run.step.finalize.phase.routed' : 'run.step.finalize.phase.routing',
        phase: 'routing',
        target: data.finalizeRoutingSessionId,
-       isActive: isCurrentlyRouting && !done,
+       isActive: !done,
        isFailed: false,
      })
    }
```

**删除 `isPhaseDone` 函数（L77-91）**：不再需要。

**删除 `PHASE_ORDER` 常量（L80）**：不再需要。

#### 3.6.4 UnifiedTimeline.tsx（`ui/src/client/UnifiedTimeline.tsx`）

**PhaseBadge（L244-355）**：与 DagStepNodeView.tsx 同样的改动——删除 `phaseHistory` 依赖，改用 Result.status 判断。

**删除 `isPhaseDone` 函数（L221-235）和 `PHASE_ORDER` 常量（L224）**：不再需要。

#### 3.6.5 step-phase.ts（`ui/src/client/step-phase.ts`）

**L18-31（StepPhaseData 类型）**：删除 `phaseHistory`。

```diff
  export interface StepPhaseData {
    readonly stepId: string
    readonly childId: string
    readonly phase: 'ask-detect' | 'finalizing' | 'gating' | 'routing' | 'completed'
    readonly name: string
    readonly loopIteration?: readonly number[]
    readonly assessSessionId?: string
    readonly gateSessionId?: string
    readonly routingSessionId?: string
-   readonly phaseHistory?: readonly string[]
    readonly compressedOutput?: string
  }
```

### 3.7 onForkCreated 回调的降级路径处理

**`degradeFinalize`**（`finalize-manager.ts` L845-864）不创建 fork 子代理，无 `onForkCreated` 回调。

**处理**：降级路径直接返回 `done` 结果，调用方 commit `done` 时自然携带降级的 `forkSessionId`（`newSessionHandle()`）。降级路径无 `running` 中间态事件，但降级耗时极短（单次 LLM 调用），用户几乎感知不到。

---

## 4. 事件序列最终形态

### 4.1 正常路径（Phase A → B → C → D → completed）

```
[1] finalizing + assessStatus:'running'  + assessResult.forkSessionId:'uuid'  ← ★ 可点击（onForkCreated）
[2] finalizing + assessStatus:'done'     + assessResult.forkSessionId:'uuid'  ← 可点击
[3] gating    + gateStatus:'running'     + gateResult.gateSessionId:''       ← 不可点击（门禁评估前无 fork）
[4] gating    + gateStatus:'done'        + gateResult.gateSessionId:'uuid'   ← 可点击
[5] routing   + routingStatus:'running'  + routingResult 无 routingSessionId
[6] routing   + routingStatus:'done'     + routingResult.routingSessionId:'uuid'（如有路由判断）
[7] completed + compressedOutput:'...'
```

**对比改动前**：

| 事件 | 改动前 | 改动后 |
|------|--------|--------|
| finalizing running | `forkSessionId:''`（不可点击） | `forkSessionId:'uuid'`（**可点击**） |
| finalizing done | `forkSessionId:'uuid'` | 不变 |
| gating running | `gateSessionId:''` | 不变 |
| gating done | `gateSessionId:'uuid'` | 不变 |
| routing | 不变 | 不变 |
| completed | 不变 | 不变 |

### 4.2 降级路径（fork 失败 → 临时会话）

```
[1] finalizing + assessStatus:'done'  + assessResult.forkSessionId:'eval-uuid'  ← 可点击（降级路径无 running 中间态）
```

### 4.3 门禁失败路径

```
[1] finalizing + assessStatus:'running'  + assessResult.forkSessionId:'uuid'  ← 可点击
[2] finalizing + assessStatus:'done'     + assessResult.forkSessionId:'uuid'  ← 可点击
[3] gating    + gateStatus:'running'     + gateResult.gateSessionId:''       ← 不可点击
[4] gating    + gateStatus:'failed'      + gateResult.gateSessionId:'uuid'   ← 可点击
```

### 4.4 UI 阶段判断变化

| 判断 | 改动前 | 改动后 |
|------|--------|--------|
| Phase B 是否到达 | `phases.includes('finalizing')` (phaseHistory) | `data.assessStatus !== undefined` |
| Phase B 是否完成 | `isPhaseDone('finalizing', currentPhase)` 或 `assessStatus === 'done'` | `assessStatus === 'done'` |
| Phase B 是否进行中 | `isCurrentlyFinalizing && !done` | `assessStatus === 'running'` |
| Phase C 是否到达 | `phases.includes('gating')` | `data.gateStatus !== undefined` |
| Phase C 是否失败 | `gateStatus === 'failed'` | 不变 |

---

## 5. 精确改动清单

### 5.1 schema.ts（`packages/sandore/workflow/src/schema.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L362 | 删除 `phaseHistory: z.array(...).optional()` | 删除字段 |
| L372 | 删除 `assessSessionId: z.string().optional()` | 删除字段 |
| L374 | 删除 `gateSessionId: z.string().optional()` | 删除字段 |
| L376 | 删除 `routingSessionId: z.string().optional()` | 删除字段 |

**不改**：各 Result 的 `status` 保持 optional（兼容极老记录），代码保证必填。

### 5.2 finalize-manager.ts（`packages/sandore/microflow/src/finalize-manager.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L92-100 | `FinalizeAssessInput` 增加 `onForkCreated?: (forkSessionId: string) => void` | 接口扩展 |
| L129-163 | `FinalizeStepRequest` 增加 `onForkCreated?: (forkSessionId: string) => void` | 接口扩展 |
| L157-162 | `onPhaseChange` details 类型：删除 `phaseHistory` | 类型变更 |
| L616-620 | `buildFinalizeMeta` 删除 phaseHistory 逻辑 | 删除代码 |
| L647-676 | `buildFinalizeMeta` 删除顶层 sessionId 提取 | 删除代码 |
| L658 | 删除 `recordAssessSession` 选项使用 | 删除代码 |
| L806 | `assessForked` 在 `forkStepSubagent` 返回后调用 `input.onForkCreated?.(handle.agent.id)` | 回调注入 |
| L1179-1187 | `FinalizeManager.assessForked` 透传 `onForkCreated` | 透传 |
| L1226-1231 | `commitFinalize` details 组装：从 Result 内读 sessionId，删除 phaseHistory | 数据源切换 |
| L1244-1296 | `finalizeStep` 透传 `onForkCreated` | 透传 |

### 5.3 stage-executor.ts（`packages/sandore/microflow/src/stage-executor.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L83-88 | `StageStepHooks.onPhaseChange` details 类型：删除 `phaseHistory` | 类型变更 |
| L1072-1081 | `runPhaseB`：删除 L1078 空快照 commit，改为 `onForkCreated` 回调中 commit running + 真实 id | 流程重构 |

### 5.4 workflow-engine.ts（`packages/sandore/workflow/src/workflow-engine.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L2019-2036 | `emitStepPhase` details 类型：删除 `phaseHistory` | 类型对齐 |

### 5.5 seam.ts（`packages/sandore/workflow/src/seam.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L60-63 | Cordis emit 侧 details 类型：删除 `phaseHistory` | 类型变更 |
| L85-103 | SessionEventMap `sandore/step-phase`：删除 `phaseHistory` | 类型变更 |

### 5.6 run-view-model.ts（`packages/sandore/ui/src/client/run-view-model.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L245 | `TimelineStepItem` 删除 `finalizePhaseHistory` 字段 | 类型变更 |
| L510 | `finalizeAssessSessionId` 数据源：`step.finalizeMeta?.assessSessionId` → `step.finalizeMeta?.assessResult?.forkSessionId` | 数据源切换 |
| L511 | `finalizeGateSessionId` 数据源：`step.finalizeMeta?.gateSessionId` → `step.finalizeMeta?.gateResult?.gateSessionId` | 数据源切换 |
| L549 | `finalizeRoutingSessionId` 数据源：`step.finalizeMeta?.routingSessionId` → `step.finalizeMeta?.routingResult?.routingSessionId` | 数据源切换 |
| L550 | 删除 `finalizePhaseHistory: step.finalizeMeta?.phaseHistory` | 删除映射 |

### 5.7 sandore-step-definition.ts（`packages/sandore/ui/src/client/sandore-step-definition.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L45 | `SandoreStepChatData` 删除 `finalizePhaseHistory` 字段 | 类型变更 |
| L81 | `SandoreStepState` 删除 `finalizePhaseHistory` 字段 | 类型变更 |
| L199 | 事件累计逻辑：删除 `phaseHistory` 累计 | 删除代码 |
| L239 | `buildViewNode` 投影：删除 `finalizePhaseHistory` 投影 | 删除代码 |

### 5.8 DagStepNodeView.tsx（`packages/sandore/ui/src/client/DagStepNodeView.tsx`）

| 行 | 改动 | 类型 |
|----|------|------|
| L77-91 | 删除 `PHASE_ORDER` 常量和 `isPhaseDone` 函数 | 删除代码 |
| L143-250 | `StepPhaseBadges`：删除 `phaseHistory` 依赖，改用 `data.xxxStatus !== undefined` 判断阶段到达、`data.xxxStatus === 'done'` 判断完成 | 逻辑重构 |

### 5.9 UnifiedTimeline.tsx（`packages/sandore/ui/src/client/UnifiedTimeline.tsx`）

| 行 | 改动 | 类型 |
|----|------|------|
| L221-235 | 删除 `PHASE_ORDER` 常量和 `isPhaseDone` 函数 | 删除代码 |
| L244-355 | `PhaseBadge`：删除 `phaseHistory` 依赖，改用 `item.xxxStatus !== undefined` 判断阶段到达、`item.xxxStatus === 'done'` 判断完成 | 逻辑重构 |

### 5.10 step-phase.ts（`packages/sandore/ui/src/client/step-phase.ts`）

| 行 | 改动 | 类型 |
|----|------|------|
| L28 | `StepPhaseData` 删除 `phaseHistory` 字段 | 类型变更 |

---

## 6. 测试更新清单

### 6.1 schema.spec.ts

| 测试 | 改动 |
|------|------|
| `FinalizeMetaSchema` 解析测试 | 删除 `phaseHistory`/`assessSessionId`/`gateSessionId`/`routingSessionId` 断言；验证旧记录（含这些字段）解析不报错（Zod strip） |

### 6.2 finalize-manager.spec.ts

| 测试 | 改动 |
|------|------|
| `buildFinalizeMeta` 相关测试 | 删除 `phaseHistory` 断言；删除顶层 `assessSessionId`/`gateSessionId`/`routingSessionId` 断言 |
| `commitFinalize` 组装 `details` 测试 | 删除 `phaseHistory` 断言；`assessSessionId` 等断言改为从 details 内的等价字段读 |
| `onPhaseChange` 传递 `details` 测试 | `details` 类型删除 `phaseHistory`；断言对齐 |
| **新增** | `assessForked onForkCreated 回调`：验证 fork 创建后回调被调用、参数为真实 `forkSessionId` |

### 6.3 stage-executor.spec.ts

| 测试 | 改动 |
|------|------|
| Phase A 中断 / Phase B 持久化测试 | 删除 `assessSessionId` 顶层断言；改为 `assessResult.forkSessionId` 断言 |
| `assessSessionId` 相关断言 | 改为 `assessResult.forkSessionId` |
| 降级路径测试 | 同上 |
| **新增** | `runPhaseB onForkCreated`：验证 fork 创建后 commit running 快照（含真实 `forkSessionId`） |

### 6.4 workflow-engine.spec.ts

| 测试 | 改动 |
|------|------|
| `Session append 载荷携带 finalizeMeta 详情` 测试 | 事件载荷的 `assessSessionId`/`gateSessionId` 仍从 details 读（details 由 commitFinalize 从 Result 内组装），断言不变 |
| `gateSessionId`/`assessSessionId` 断言 | 改为 `gateResult.gateSessionId` / `assessResult.forkSessionId` |

### 6.5 workflow-engine-e2e.spec.ts

| 测试 | 改动 |
|------|------|
| `assessSessionId`/`gateSessionId`/`phaseHistory` 断言 | 事件载荷断言不变（details 仍携带）；持久化断言改为 `assessResult.forkSessionId` / `gateResult.gateSessionId`；删除 `phaseHistory` 断言 |

### 6.6 run-view-model.spec.ts

| 测试 | 改动 |
|------|------|
| `buildTimeline 收尾字段` 测试 | 删除 `finalizePhaseHistory` 断言；`finalizeAssessSessionId` 等改为从 Result 内读 |

### 6.7 sandore-step-definition.spec.ts

| 测试 | 改动 |
|------|------|
| `folds sandore/step-phase` 测试 | 删除 `phaseHistory` 累计断言 |
| `accumulates phase fields` 测试 | 同上 |
| `buildViewNode` 测试 | 删除 `finalizePhaseHistory` 投影断言 |

### 6.8 step-phase.spec.ts

| 测试 | 改动 |
|------|------|
| `StepPhaseData` 类型测试 | 删除 `phaseHistory` 字段 |

---

## 7. 风险与旧数据兼容

### 7.1 Zod 旧数据兼容性

| 场景 | 风险 | 缓解 |
|------|------|------|
| 旧记录含 `phaseHistory` | **无风险** | Zod `strip` 自动忽略未知字段 |
| 旧记录含 `assessSessionId`/`gateSessionId`/`routingSessionId` | **无风险** | Zod `strip` 自动忽略；UI 改从 Result 内读 |
| 极老记录（Round 11 前）Result 缺 `status` | **无风险** | `status` 保持 optional（schema 不改 required） |
| 旧 UI 读 `finalizeMeta.phaseHistory` | **无风险** | 旧 UI 不存在（本次改动同时更新 UI） |

### 7.2 事件载荷兼容性

| 场景 | 风险 | 缓解 |
|------|------|------|
| 事件载荷删除 `phaseHistory` | **低** | 旧 UI 不存在；新 UI 不读 `phaseHistory` |
| 事件载荷保留 `assessSessionId` 等 | **无** | 字段名不变，只是数据源从顶层改为 Result 内 |

### 7.3 运行时风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| `onForkCreated` 回调异步性 | **低** | 同步回调（`forkStepSubagent` 返回后立即调用） |
| Phase C `gateSessionId` 仍为空串 | **低** | UI 已有空串守卫；门禁评估前无 fork 是合理行为 |
| 降级路径无 `running` 中间态 | **低** | 降级耗时极短，用户无感知 |

### 7.4 回滚方案

- 删除的字段可通过 `buildFinalizeMeta` 重新添加
- `onForkCreated` 回调可通过删除回调参数回滚
- UI 的 `phaseHistory` 依赖可通过恢复 `isPhaseDone` 回退

---

## 8. 是否需要 DSH 配合

**不需要**。

本次改动完全在 sandore 仓库内：
- `workflow/src/schema.ts`
- `workflow/src/seam.ts`
- `microflow/src/finalize-manager.ts`
- `microflow/src/stage-executor.ts`
- `workflow/src/workflow-engine.ts`
- `ui/src/client/run-view-model.ts`
- `ui/src/client/sandore-step-definition.ts`
- `ui/src/client/DagStepNodeView.tsx`
- `ui/src/client/UnifiedTimeline.tsx`
- `ui/src/client/step-phase.ts`
- 测试文件（7 个）

DSH 源码（`deepseek-harness`）仅作只读参考，无需修改。
