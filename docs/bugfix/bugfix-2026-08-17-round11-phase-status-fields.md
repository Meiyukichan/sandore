# Round 11：每个收尾阶段独立 status 字段架构改进方案

> 文档日期：2026-08-17
> 状态：**方案设计（只读）**——禁止修改业务代码，仅输出文档
> 涉及路径：`packages/sandore/workflow/src/schema.ts`、`packages/sandore/microflow/src/finalize-manager.ts`、`packages/sandore/microflow/src/stage-executor.ts`、`packages/sandore/ui/src/client/DagStepNodeView.tsx`、`packages/sandore/ui/src/client/UnifiedTimeline.tsx`、`packages/sandore/ui/src/client/sandore-step-definition.ts`、`packages/sandore/workflow/src/seam.ts`

---

## 1. 现状分析

### 1.1 架构概述

收尾（finalize）分 5 个阶段，通过 `finalizeMeta.currentPhase` 标记当前阶段，再由 `phaseHistory` 记录流转历史。

| 阶段 | Phase | currentPhase 值 | Result 对象 |
|---|---|---|---|
| A - Ask Detect | Phase A | `'ask-detect'` | `askResult: FinalizeAskResult` |
| B - Finalizing | Phase B | `'finalizing'` | `assessResult: FinalizeAssessResult` |
| C - Gating | Phase C | `'gating'` | `gateResult: GateEvalResult` |
| D - Routing | Phase D | `'routing'` | `routingResult: RoutingResult` |
| E - Completed | Phase E | `'completed'` | 无独立 Result |

### 1.2 现状问题：UI 推断逻辑脆弱

**`DagStepNodeView.tsx:isPhaseDone`（L85-90）**：
```ts
function isPhaseDone(phase: string, currentPhase: string | undefined): boolean {
  const phaseIdx = PHASE_ORDER.indexOf(phase)
  const currentIdx = PHASE_ORDER.indexOf(currentPhase)
  return phaseIdx >= 0 && currentIdx >= 0 && currentIdx > phaseIdx
}
```
- **本质**：靠 `currentPhase` 的**序号**推断某个阶段是否完成——`currentPhase > targetPhase`。
- **问题**：
  1. `currentPhase` 是单值状态，只记录「当前在哪」，不记录「哪些阶段已完成」。
  2. 如果事件丢失或 currentPhase 未正确推进（如 Phase A ask 中断后 Phase B 降级），推断结果与实际不一致。
  3. 无法表达「失败」态——`isPhaseDone` 只有 true/false，无法区分 done vs failed。

**`UnifiedTimeline.tsx:PhaseBadge`（L234-274）** 用另一种近似逻辑（`phases.indexOf('completed') > phases.indexOf('finalizing')`），同样脆弱。

### 1.3 核心发现

四个 Result 对象（`askResult`/`assessResult`/`gateResult`/`routingResult`）在**进入阶段时尚不存在**，要等阶段完成才填充。例如：

- `runPhaseC` 开始时，`gateResult` 尚未构建——`evaluateGates()` 完成后才返回。
- `runPhaseB` 的 L1064-1065 提前写 `finalizeMeta = { currentPhase: 'finalizing' }`，但此时 `assessResult` 尚无内容。

**这是设计的核心难点：进入阶段时 Result 为空/不存在，如何先标 status='running'，完成后再标 status='done'？**

---

## 2. Status 生命周期设计

### 2.1 设计原则

**零推断**：UI 读 `askResult.status` / `assessResult.status` / `gateResult.status` / `routingResult.status`，值为 `'running'`/`'done'`（gateResult 额外有 `'failed'`），直接渲染 badge，不依赖 `currentPhase` 序号比较。

### 2.2 Status 枚举

```ts
// 所有阶段共用（ask/assess/routing 三值，gate 四值）
type PhaseStatus = 'running' | 'done'           // 通用
type GatePhaseStatus = 'running' | 'done' | 'failed'  // gate 专用
```

### 2.3 各阶段 Status 生命周期

| 阶段 | 进入触发 | running 写入点 | done/failed 写入点 | 特殊处理 |
|---|---|---|---|---|
| Phase A (ask-detect) | `runPhaseA` 调用 `assessOnly()` | `commitFinalize('ask-detect')` 时自动插入空 `askResult: { status: 'running', ... }` | ask 中断时写 `askResult: { status: 'done', hasAsk, askQuestion, ... }` | 非 ask 路径（无未解析变量 + 无门禁）不产 Result，**无 status 字段**——这是预期的，Phase A 仅在 ask 语义下有意义 |
| Phase B (finalizing) | `runPhaseB` 进入 | **`runPhaseB` 进入时立即写**（L1064-1065 已有 `finalizeMeta = { currentPhase: 'finalizing' }`，同时插入空 `assessResult: { status: 'running' }`） | `commitFinalize('finalizing')` 时写 `assessResult: { status: 'done', ... }` | fork 降级记 `errorDetail`，但 status 仍为 `'done'`（降级不等于失败） |
| Phase C (gating) | `runPhaseC` 调用 `evaluateGates()` | **`runPhaseC` 进入时立即写**（新插入 `gateResult: { status: 'running' }`） | 通过：`gateResult: { status: 'done', ... }`；失败：`gateResult: { status: 'failed', ... }` | 门禁禁用（`!hasEnabledGates`）不产 Result，无 status |
| Phase D (routing) | `completeAfterFinalize` 的 Phase D 块 | **`commitFinalize('routing')` 时自动插入空 `routingResult: { status: 'running' }`** | `commitFinalize('completed')` 时写 `routingResult: { status: 'done', ... }` | 无分支/循环时 `routingResult` 可选省略（`undefined`），此时 routing 无 badge |

### 2.4 核心设计：进入阶段时如何写 running

**方案选择：在 `buildFinalizeMeta` 中按 `currentPhase` 自动注入空 Result 快照**

`buildFinalizeMeta` 已是所有 `commitFinalize` 调用的必经路径，在此函数中，当 `currentPhase` 推进到某阶段时，若对应的 Result 尚未提供（`undefined`），自动插入一个只含 `status: 'running'` 的空对象。

```ts
function buildFinalizeMeta(existing, assessResult, gateResult, currentPhase, options) {
  // ... 现有逻辑 ...

  // ── Round 11：进入阶段时注入 running 空快照 ──
  const askResult = options?.askResult ?? (
    currentPhase === 'ask-detect' && existing?.askResult === undefined
      ? { status: 'running' as const }
      : undefined
  );

  const effectiveAssessResult = assessResult ?? (
    currentPhase === 'finalizing' && existing?.assessResult === undefined
      ? { status: 'running' as const }
      : undefined
  );

  const effectiveGateResult = gateResult ?? (
    currentPhase === 'gating' && existing?.gateResult === undefined
      ? { status: 'running' as const }
      : undefined
  );

  const effectiveRoutingResult = options?.routingResult ?? (
    currentPhase === 'routing' && existing?.routingResult === undefined
      ? { status: 'running' as const }
      : undefined
  );

  return {
    currentPhase,
    // ... 其余字段 ...
    // 写入时用 effective 版本（含 running 快照）
    ...(askResult !== undefined ? { askResult } : {}),
    ...(effectiveAssessResult !== undefined ? { assessResult: effectiveAssessResult } : {}),
    ...(effectiveGateResult !== undefined ? { gateResult: effectiveGateResult } : {}),
    ...(effectiveRoutingResult !== undefined ? { routingResult: effectiveRoutingResult } : {}),
  };
}
```

**优势**：
- 不改变 `commitFinalize` 调用方的签名——进入阶段时调用 `commitFinalize(request, undefined, undefined, 'finalizing')`（`assessResult = undefined`），`buildFinalizeMeta` 自动注入 `{ status: 'running' }`。
- 完成时调用 `commitFinalize(request, realAssessResult, undefined, 'finalizing')`，`buildFinalizeMeta` 用真实 Result（含 `status: 'done'`）覆盖之前的 running 快照。
- 一次 `buildFinalizeMeta` 调用即完成「先 running、后 done」的两步生命周期，无需在 `runPhaseX` 中显式插入空对象。

### 2.5 Phase A 非 ask 路径处理

当 `runPhaseA` 的 L989 判断 `!needsAssess && !hasGates` 直接返回时，Phase A 不产任何 Result，也不进入任何阶段——这是正确的：没有 ask 语义，就没有 ask-detect 状态。

**仅当进入 `commitFinalize('ask-detect')` 时才注入 `askResult.status = 'running'`**——触发条件就是 ask 保底通道 `hasAsk=true`，此时 Result 一定会被填充（至少含 `hasAsk: true`）。

### 2.6 异常路径 status 处理

| 场景 | 当前行为 | 新行为 |
|---|---|---|
| Phase C 门禁失败 | `gatesPassed=false` → `executed.status='failed'` + `commitFinalize('gating')` | `gateResult.status = 'failed'`（在 `evaluateGates` 返回后、`commitFinalize` 前显式设置） |
| Phase B JSON 超限报错 | `Step failed` | `assessResult` 仍写 `status: 'done'`（降级失败不改变阶段状态），`errorDetail` 有值；Step 级 `executed.status='failed'` 独立 |
| Phase B fork 降级 | 降级临时会话，记 `errorDetail`，不失败 | `assessResult.status = 'done'`（降级成功完成评估，只是换了通道） |
| Phase D 路由判断失败 | 异常被捕获，降级处理 | `routingResult.status = 'done'`（路由结果本身就是降级/兜底值） |

---

## 3. Schema 变更清单

### 3.1 新增枚举类型

**文件**：`packages/sandore/workflow/src/schema.ts`

```ts
/** 收尾阶段独立 status 枚举（ask/assess/routing 三值）。 */
const PhaseStatusSchema = z.enum(['running', 'done'])

/** 门禁阶段 status 枚举（含失败态）。 */
const GatePhaseStatusSchema = z.enum(['running', 'done', 'failed'])
```

### 3.2 各 Result Schema 添加 status 字段

**`FinalizeAskResultSchema`（L283-290）**：
```ts
export const FinalizeAskResultSchema = z.object({
  status: PhaseStatusSchema,           // ← 新增
  hasAsk: z.boolean(),
  askQuestion: AskUserQuestionPayloadSchema.optional(),
  compressedOutput: z.string().optional(),
  passThroughVars: z.record(z.string(), z.string()),
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
})
```

**`FinalizeAssessResultSchema`（L267-275）**：
```ts
export const FinalizeAssessResultSchema = z.object({
  status: PhaseStatusSchema,           // ← 新增
  passThroughVars: z.record(z.string(), z.string()),
  askQuestion: AskUserQuestionPayloadSchema.optional(),
  compressedOutput: z.string().optional(),
  errorDetail: z.string().optional(),
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
})
```

**`GateEvalResultSchema`（L293-304）**：
```ts
export const GateEvalResultSchema = z.object({
  status: GatePhaseStatusSchema,       // ← 新增（含 'failed'）
  gatesPassed: z.boolean(),
  primaryPassed: z.boolean().optional(),
  secondaryPassed: z.boolean().optional(),
  gateDetails: z.object({...}).optional(),
  errorDetail: z.string().optional(),
  gateSessionId: z.string(),
  assessmentRaw: z.string(),
})
```

**`RoutingResultSchema`（L321-325）**：
```ts
export const RoutingResultSchema = z.object({
  status: PhaseStatusSchema,           // ← 新增
  branchMeta: BranchMetaSchema.optional(),
  loopMeta: BranchMetaSchema.optional(),
  routingSessionId: z.string().optional(),
})
```

### 3.3 FinalizeMeta 保持不变

`FinalizeMeta` 的 `askResult`/`assessResult`/`gateResult`/`routingResult` 字段类型不变（它们引用上述 Schema，status 字段内嵌于各 Result 内）。`currentPhase`/`previousPhase`/`phaseHistory` **保留**（用于展示阶段流转顺序，不用于推断完成状态）。

---

## 4. 引擎改动清单

### 4.1 `finalize-manager.ts` 改动

**文件**：`packages/sandore/microflow/src/finalize-manager.ts`

#### 4.1.1 `buildFinalizeMeta`（L607-642）

- **改动**：添加 status 自动注入逻辑（见 §2.4 代码示例）。
- **影响范围**：所有 `commitFinalize` 调用方自动受益，无需逐一修改。

#### 4.1.2 `FinalizeAssessor.assess` 返回值

- **位置**：L699+（`assess` 方法返回 `AssessParsed`）
- **改动**：`AssessParsed` 接口无需加 `status`（它不含 `forkSessionId`），但 `assessOnly`（L1130 附近）返回值构造 `FinalizeAskResult` 时需加 `status: 'done'`（ask 判定完成）。

#### 4.1.3 `FinalizeAssessor.assessForked` 返回值

- **位置**：L1140（`assessForked` 方法）
- **改动**：返回的 `FinalizeAssessResult` 需带 `status: 'done'`。在 `assessForked` 内部组装返回对象时加上。

#### 4.1.4 `GateEvaluator.evaluateGates` 返回值

- **位置**：约 L900-1100（`evaluateGates` 方法）
- **改动**：
  - 通过时返回 `{ status: 'done', gatesPassed: true, ... }`。
  - 失败时返回 `{ status: 'failed', gatesPassed: false, ... }`。

#### 4.1.5 `commitFinalize` 的 Phase D 路由结果处理

- **位置**：L1168-1198（`commitFinalize` 方法）
- **改动**：`options.routingResult` 在 `buildFinalizeMeta` 中自动获得 `status: 'done'`（caller 传入时已是完整对象）。`buildFinalizeMeta` 需在 `currentPhase === 'completed'` 时为已有 `routingResult` 注入 `status: 'done'`（如果尚未有）。

#### 4.1.6 `finalizeStep` 兼容入口

- **位置**：L1200-1252
- **改动**：`commitFinalize` 调用链不变（`buildFinalizeMeta` 自动注入 status），但 `finalizeStep` 内部构造 `FinalizeAskResult` 的地方需加 `status: 'done'`。

### 4.2 `stage-executor.ts` 改动

**文件**：`packages/sandore/microflow/src/stage-executor.ts`

#### 4.2.1 `runPhaseA`（L980-1029）

- **改动**：构造 `askResult`（L1001-1008）时加 `status: 'done'`：
  ```ts
  const askResult: FinalizeAskResult = {
    status: 'done',
    hasAsk: assessResult.hasAsk,
    // ...
  };
  ```
- 非 ask 路径（L989）无变化。

#### 4.2.2 `runPhaseB`（L1054-1070）

- **改动**：L1064-1065 已有 `finalizeMeta = { currentPhase: 'finalizing' }`。`buildFinalizeMeta` 自动注入 `assessResult.status = 'running'`，无需额外修改。完成时 `assessForked` 返回的对象已含 `status: 'done'`，`commitFinalize` 覆盖。

#### 4.2.3 `runPhaseC`（L1081-1115）

- **改动**：
  - 进入时（L1094 后）需显式注入 `gateResult: { status: 'running' }` 到 `finalizeMeta`，在 `evaluateGates` 执行前持久化一次——否则 `evaluateGates` 耗时期间 UI 看不到 running。
  - 或者更简洁：在 `evaluateGates` 调用前先 `commitFinalize(request, assessResult, undefined, 'gating')`（`buildFinalizeMeta` 自动注入 `gateResult: { status: 'running' }`），然后 `evaluateGates` 返回后再次 `commitFinalize` 写终态。
  - 通过/失败分别对应 `status: 'done'` / `status: 'failed'`（由 `evaluateGates` 返回值自带）。

#### 4.2.4 `completeAfterFinalize`（L1125-1159）

- **改动**：L1141 的 `commitFinalize('routing')` 由 `buildFinalizeMeta` 自动注入 `routingResult: { status: 'running' }`。L1159 的 `commitFinalize('completed')` 时，`routingResult` 已有 `status: 'done'`（在 L1145-1151 构造时加上）。

### 4.3 `seam.ts` 事件载荷改动

**文件**：`packages/sandore/workflow/src/seam.ts`

- **L85-98**：`'sandore/step-phase'` 事件载荷增加各阶段 status 字段：
  ```ts
  'sandore/step-phase': {
    // ... 现有字段 ...
    askStatus?: 'running' | 'done';
    assessStatus?: 'running' | 'done';
    gateStatus?: 'running' | 'done' | 'failed';
    routingStatus?: 'running' | 'done';
  };
  ```
- **L60-64**：引擎侧 `emit` 调用需透传这些字段。

### 4.4 `workflow-engine.ts` 事件发射改动

**文件**：`packages/sandore/workflow/src/workflow-engine.ts`

- **L1996 附近**：`onPhaseChange` 回调实现需从 `finalizeMeta` 读取各 Result 的 `status` 并透传到事件载荷。

---

## 5. UI 改动清单

### 5.1 `DagStepNodeView.tsx`

**文件**：`packages/sandore/ui/src/client/DagStepNodeView.tsx`

#### 5.1.1 删除 `isPhaseDone` 函数（L85-90）

- 该函数被完全取代，删除。

#### 5.1.2 `StepPhaseBadges` 组件（L141-204）重写

重写为直接读 status 字段：

```tsx
function StepPhaseBadges({ data, t, openSession }) {
  const badges = []

  // Phase A：读 askResult.status
  if (data.askStatus !== undefined) {
    const done = data.askStatus === 'done'
    badges.push({
      key: 'phase-a',
      labelKey: done ? 'run.step.finalize.phase.detected' : 'run.step.finalize.phase.detecting',
      phase: 'ask-detect',
      target: undefined,
      isActive: !done,
    })
  }

  // Phase B：读 assessResult.status
  if (data.assessStatus !== undefined) {
    const done = data.assessStatus === 'done'
    badges.push({
      key: 'phase-b',
      labelKey: done ? 'run.step.finalize.phase.done' : 'run.step.finalize.phase.finalizing',
      phase: 'finalizing',
      target: data.finalizeAssessSessionId,
      isActive: !done,
    })
  }

  // Phase C：读 gateResult.status（含 failed）
  if (data.gateStatus !== undefined) {
    const done = data.gateStatus === 'done'
    const failed = data.gateStatus === 'failed'
    badges.push({
      key: 'phase-c',
      labelKey: failed ? 'run.step.finalize.phase.gate-failed'
            : done  ? 'run.step.finalize.phase.gated'
                    : 'run.step.finalize.phase.gating',
      phase: 'gating',
      target: data.finalizeGateSessionId,
      isActive: !done && !failed,
    })
  }

  // Phase D：读 routingResult.status
  if (data.routingStatus !== undefined) {
    const done = data.routingStatus === 'done'
    badges.push({
      key: 'phase-d',
      labelKey: done ? 'run.step.finalize.phase.routed' : 'run.step.finalize.phase.routing',
      phase: 'routing',
      target: data.finalizeRoutingSessionId,
      isActive: !done,
    })
  }

  // ... 渲染逻辑不变 ...
}
```

#### 5.1.3 输出区逻辑（L315-323）

- L315 的 `!isPhaseDone('finalizing', data.finalizePhase)` 替换为 `data.assessStatus !== 'done'`。
- L319 的 `isPhaseDone('finalizing', data.finalizePhase)` 替换为 `data.assessStatus === 'done'`。
- L323 同上。

### 5.2 `UnifiedTimeline.tsx`

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx`

#### 5.2.1 `PhaseBadge` 组件（L227-284）重写

与 DagStepNodeView 同逻辑，读 `item.askStatus`/`item.assessStatus`/`item.gateStatus`/`item.routingStatus`，删除 `phases.indexOf('completed') > phases.indexOf('finalizing')` 推断。

### 5.3 `sandore-step-definition.ts`

**文件**：`packages/sandore/ui/src/client/sandore-step-definition.ts`

#### 5.3.1 `SandoreStepChatData` 接口（L28-54）

新增字段：
```ts
readonly askStatus?: 'running' | 'done'
readonly assessStatus?: 'running' | 'done'
readonly gateStatus?: 'running' | 'done' | 'failed'
readonly routingStatus?: 'running' | 'done'
```

#### 5.3.2 `SandoreStepState` 接口（L64-82）

新增字段：
```ts
readonly askStatus?: 'running' | 'done'
readonly assessStatus?: 'running' | 'done'
readonly gateStatus?: 'running' | 'done' | 'failed'
readonly routingStatus?: 'running' | 'done'
```

#### 5.3.3 `sandoreStepDefinition.update`（L184-196，`sandore/step-phase` case）

累计 status 字段：
```ts
case 'sandore/step-phase': {
  const data = match.event.data
  return {
    ...context.state,
    finalizePhase: data.phase,
    // ... 现有字段 ...
    ...(data.askStatus !== undefined ? { askStatus: data.askStatus } : {}),
    ...(data.assessStatus !== undefined ? { assessStatus: data.assessStatus } : {}),
    ...(data.gateStatus !== undefined ? { gateStatus: data.gateStatus } : {}),
    ...(data.routingStatus !== undefined ? { routingStatus: data.routingStatus } : {}),
  }
}
```

#### 5.3.4 `buildViewNode`（L222-229）

投影新字段到 `SandoreStepChatData`。

---

## 6. 测试计划

### 6.1 单元测试（schema 层）

**文件**：`packages/sandore/workflow/src/schema.spec.ts`

- [ ] `FinalizeAskResultSchema` 接受 `status: 'running'` 和 `status: 'done'`，拒绝 `'failed'`。
- [ ] `FinalizeAssessResultSchema` 接受 `status: 'running'` 和 `status: 'done'`。
- [ ] `GateEvalResultSchema` 接受 `status: 'running'`/`'done'`/`'failed'`。
- [ ] `RoutingResultSchema` 接受 `status: 'running'` 和 `status: 'done'`。
- [ ] `FinalizeMetaSchema` 在 `askResult.status='running'` + `currentPhase='ask-detect'` 时正常解析。

### 6.2 单元测试（finalize-manager 层）

**文件**：`packages/sandore/microflow/src/finalize-manager.spec.ts`（或同级测试文件）

- [ ] `buildFinalizeMeta` 在 `currentPhase='finalizing'` + `assessResult=undefined` 时自动注入 `{ status: 'running' }`。
- [ ] `buildFinalizeMeta` 在 `currentPhase='finalizing'` + `assessResult={status:'done',...}` 时用真实 Result 覆盖。
- [ ] `commitFinalize('gating')` + 无 gateResult 时注入 `gateResult: { status: 'running' }`。
- [ ] `commitFinalize('completed')` + routingResult 已有时写 `routingResult.status='done'`。

### 6.3 集成测试

- [ ] 完整 Phase A→B→C→D→E 流程：验证各 Result 的 status 从 `running` 到 `done` 的转换。
- [ ] Phase C 门禁失败：验证 `gateResult.status='failed'`，UI badge 显示失败态。
- [ ] Phase A ask 中断：验证 `askResult.status='done'`（ask 判定完成，不是阶段失败）。
- [ ] 零 AI 路径（无变量+无门禁）：验证无任何 Result/status 字段。
- [ ] Phase B fork 降级：验证 `assessResult.status='done'` + `errorDetail` 有值。

### 6.4 UI 测试

- [ ] `StepPhaseBadges` 在 `askStatus='running'` 时显示「检测中」badge。
- [ ] `StepPhaseBadges` 在 `askStatus='done'` 时显示「已检测」badge。
- [ ] `StepPhaseBadges` 在 `gateStatus='failed'` 时显示失败态 badge。
- [ ] 删除 `isPhaseDone` 后 UI 无报错，所有 badge 正常渲染。

---

## 7. 兼容策略

### 7.1 保留 `currentPhase`/`phaseHistory`

- `currentPhase` 和 `phaseHistory` **不删除**——它们记录阶段流转顺序（用于 UI 时间线排序、阶段到达顺序展示），但不再用于「是否完成」的推断。
- `isPhaseDone` 函数在迁移完成后删除，但 `PHASE_ORDER` 常量保留（UI 仍可能用它排序 badge）。

### 7.2 Schema 兼容

- **向后兼容**：新 schema 的 `status` 字段是**新增必填字段**。旧数据（无 `status`）在 zod 解析时会失败。
- **迁移方案**：
  1. **短期（开发期）**：schema 强制要求 `status`，旧数据直接拒绝——开发环境可接受。
  2. **长期（生产平滑）**：将 `status` 改为 `.optional()` 或 `.default('done')`，读到旧数据时按现有 `isPhaseDone` 逻辑回退推断。
  3. **推荐**：开发期用强制必填，上线前改为 `.default('done')` 兼容存量数据。

### 7.3 事件载荷兼容

- `sandore/step-phase` 事件新增 `askStatus`/`assessStatus`/`gateStatus`/`routingStatus` 字段，均为 `optional`——旧客户端忽略，新客户端读取。
- `SandoreStepChatData` 新增的 4 个 status 字段也是 `optional`——旧节点无值时回退到现有 `finalizePhase` + `phaseHistory` 推断（保留一个轻量回退逻辑，迁移完成后删除）。

### 7.4 渐进替代路径

**Phase 1**（本次实现）：
- 新增 status 字段，`buildFinalizeMeta` 自动注入。
- UI 同时读 status 和 `isPhaseDone`（status 优先，`isPhaseDone` 兜底）。
- 部署后观察 status 字段覆盖率。

**Phase 2**（后续清理）：
- 确认所有路径都正确写入 status 后，删除 `isPhaseDone` 和回退逻辑。
- 删除 `PHASE_ORDER` 常量（如果不再需要排序）。

---

## 8. 风险评估

### 8.1 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| schema 不兼容（旧数据无 status 字段） | **中** | 用 `.default('done')` 兼容存量 |
| Phase A 非 ask 路径无 status（UI 显示缺失） | **低** | 这是预期行为，UI 检查 `askStatus !== undefined` 才渲染 badge |
| `buildFinalizeMeta` 注入逻辑增加复杂度 | **低** | 纯函数，可充分单测 |
| 事件载荷增加 4 个字段 | **低** | optional 字段，不影响旧客户端 |
| Phase C 需要额外一次 `commitFinalize` 注入 running（性能开销） | **低** | 一次额外持久化，sub-ms 级别 |

### 8.2 不改动 DSH

本方案**完全在 sandore 包内**，不涉及 `D:\project-code\llm\deepseek-harness` 的任何文件。

---

## 9. 收益 vs 成本分析

### 9.1 收益

1. **UI 零推断**：badge 判断从「序号比较」改为「直接读字段」，逻辑透明、无歧义。
2. **语义清晰**：每个 Result 自描述「我在哪」（running/done/failed），不依赖外部状态推导。
3. **支持异常态**：`gateResult.status='failed'` 直接表达门禁失败，无需从 `gatesPassed=false` + `errorDetail` 反推。
4. **事件丢失容忍**：status 是 Result 的属性，随 finalizeMeta 持久化——即使 `sandore/step-phase` 事件丢失，轮询仍能读到正确 status。
5. **代码可维护性**：删除 `isPhaseDone` 和两处不同的推断逻辑，统一为一种读取模式。

### 9.2 成本

1. **Schema 变更**：4 个 Result 加必填字段，存量数据需兼容处理（`.default()`）。
2. **引擎改动面**：`buildFinalizeMeta` + `assessForked` + `evaluateGates` + `runPhaseX` 各处需加 `status`。
3. **事件载荷扩展**：`sandore/step-phase` 新增 4 个字段，`seam.ts` + `workflow-engine.ts` 需同步。
4. **UI 改动**：`DagStepNodeView` + `UnifiedTimeline` + `sandore-step-definition` 三处重写 badge 逻辑。
5. **测试**：需新增约 10-15 个测试用例。

### 9.3 结论

**值得做**。收益显著（语义正确性 + UI 可维护性 + 异常态支持），成本可控（改动面明确、不涉及 DSH），且提供了渐进迁移路径（`.default('done')` 兼容 + 两阶段迁移）。

---

## 10. 改动文件汇总

| 文件 | 改动类型 | 改动内容 |
|---|---|---|
| `packages/sandore/workflow/src/schema.ts` | Schema | 4 个 Result 加 `status` 字段 + 2 个新枚举 |
| `packages/sandore/microflow/src/finalize-manager.ts` | 引擎 | `buildFinalizeMeta` 注入 running 快照 + `assessForked`/`evaluateGates` 返回值加 status |
| `packages/sandore/microflow/src/stage-executor.ts` | 引擎 | `runPhaseA` 构造 askResult 加 status + `runPhaseC` 进入前注入 running |
| `packages/sandore/workflow/src/seam.ts` | 事件 | `sandore/step-phase` 载荷加 4 个 status 字段 |
| `packages/sandore/workflow/src/workflow-engine.ts` | 引擎 | `onPhaseChange` 回调透传 status |
| `packages/sandore/ui/src/client/DagStepNodeView.tsx` | UI | 删除 `isPhaseDone` + 重写 `StepPhaseBadges` |
| `packages/sandore/ui/src/client/UnifiedTimeline.tsx` | UI | 重写 `PhaseBadge` |
| `packages/sandore/ui/src/client/sandore-step-definition.ts` | UI | 接口加 status 字段 + update/buildViewNode 投影 |
| `packages/sandore/workflow/src/schema.spec.ts` | 测试 | 新增 schema 验证用例 |
| `packages/sandore/microflow/src/finalize-manager.spec.ts` | 测试 | 新增 `buildFinalizeMeta` 注入用例 |
