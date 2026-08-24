# Round 7：收尾阶段中间态同步 — 最终修复方案

> **日期**: 2026-08-17  
> **问题**: 收尾阶段中间态（finalizing/gating/routing）UI 不显示，只显示最终态（completed）  
> **状态**: 方案文档（只读分析，禁止修改业务代码）

---

## 目录

1. [根因分析（代码级验证）](#1-根因分析代码级验证)
2. [候选方案对比](#2-候选方案对比)
3. [推荐方案详细设计](#3-推荐方案详细设计)
4. [测试计划](#4-测试计划)
5. [风险评估](#5-风险评估)
6. [是否需要 DSH 配合](#6-是否需要-dsh-配合)
7. [变更清单](#7-变更清单)

---

## 1. 根因分析（代码级验证）

### 1.1 数据流全景

```
StageExecutor.runPhaseB/C/D
    │
    ├─ buildFinalizeRequest()         // 组装请求（⚠️ 不含 onPersist）
    │
    └─ finalizeManager.commitFinalize(request, ..., phase)
         │
         ├─ request.executedStep.finalizeMeta = buildFinalizeMeta(...)   // L1163：就地写入
         ├─ request.onPhaseChange?.(step, childId, phase)                // L1170：先发事件 ⚠️
         └─ await request.onPersist?.(request.executedStep)              // L1171：后持久化（undefined NO-OP）❌
```

**关键问题**：`commitFinalize` 的执行顺序是 **先 onPhaseChange（事件）后 onPersist（持久化）**，而 `onPersist` 又是 `undefined`——结果是事件发出了，但 `active.state` 里的 `executedSteps` 从未被更新。

### 1.2 根因 1：`buildFinalizeRequest` 未注入 `onPersist`

| 文件 | 行号 | 证据 |
|------|------|------|
| `stage-executor.ts` | L1185-1206 | `buildFinalizeRequest()` 构造 `FinalizeStepRequest`，注入了 `onPhaseChange`（L1202-1204），**未注入 `onPersist`** |
| `finalize-manager.ts` | L142 | `FinalizeStepRequest` 接口已声明 `onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> \| void`——类型签名就位，只需填值 |
| `finalize-manager.ts` | L1171 | `await request.onPersist?.(request.executedStep)`——`?.` 在 `undefined` 上短路，实际为 NO-OP |

### 1.3 根因 2：`active.state.executedSteps` 与 StageExecutor 的 `executedSteps` 是独立数组

| 文件 | 行号 | 证据 |
|------|------|------|
| `stage-executor.ts` | L488-490 | `initState()` 构造 `StageRunState` 时 `executedSteps: [...completedSteps]`——**拷贝**，非引用共享 |
| `workflow-engine.ts` | L1259-1269 | `onPersist` 回调通过 `findIndex + map/spread` 做 **不可变 upsert**（`active.state = { ...active.state, executedSteps: index >= 0 ? map : append }`）——`active.state` 是独立的不可变快照 |

### 1.4 根因 3：事件发出时 `active.state` 无中间态

事件链路：

```
commitFinalize → onPhaseChange → emitStepPhase → 双发 sandore/step-phase 事件
                                                          │
                                                          ▼
                                                    UI 收到事件
                                                          │
                                                          ▼
                                                    getInstanceState (remote.ts)
                                                          │
                                                          ▼
                                                    engine.getInstanceState → active.state
                                                          │
                                                          ▼
                                                    executedSteps 里该 step 的 finalizeMeta = undefined ❌
                                                    （因为 onPersist 从未执行，active.state 未更新）
```

只有到 `completeAfterFinalize` 最末尾的 `this.persist(executed, state)`（L1159）→ `options.onPersist`（L1410）→ 引擎侧 `onPersist` 回调（L1252-1276）才把终态同步进 `active.state`。

### 1.5 总结

| 根因 | 位置 | 机制 |
|------|------|------|
| `buildFinalizeRequest` 未注入 `onPersist` | `stage-executor.ts` L1185-1206 | `FinalizeStepRequest.onPersist` 字段已存在（L142），只需在构造时赋值 |
| `commitFinalize` 顺序：先事件后持久化 | `finalize-manager.ts` L1170-1171 | `onPhaseChange` 在 `onPersist` 之前执行——即使注入 `onPersist`，事件发出时 `active.state` 仍可能是旧值 |
| `active.state.executedSteps` 是独立不可变快照 | `workflow-engine.ts` L1259-1269 | `onPersist` 做不可变 upsert 重建新 `active.state` 对象 |

---

## 2. 候选方案对比

### 候选 A：注入 `onPersist` + 交换顺序（推荐 ✅）

**核心思路**：在 `buildFinalizeRequest` 注入 `onPersist` 回调（复用引擎侧已有的 upsert 逻辑），并把 `commitFinalize` 内的 `onPhaseChange` 移到 `onPersist` 之后。

**变更点**：
1. `stage-executor.ts` `buildFinalizeRequest`（L1185-1206）：注入 `onPersist` 字段
2. `finalize-manager.ts` `commitFinalize`（L1170-1171）：交换 `onPhaseChange` 和 `onPersist` 的顺序

**优点**：
- 改动最小（2 个文件，3 处改动）
- 根治：事件发出前 `active.state` 已含最新 `finalizeMeta`
- 复用已有引擎侧 `onPersist` 逻辑（L1252-1276），不引入新机制
- `FinalizeStepRequest.onPersist` 类型已就位（L142），只需填值

**缺点**：
- 每次 `commitFinalize` 都触发一次 `persistState`（从 1 次 → 4-5 次/实例生命周期），增加 I/O
- 需要确认 `onPersist` 是 async（`await request.onPersist`），不能省略 await

**性能评估**：
- `state.put` 是全量覆盖写，幂等安全
- 单次 `persistState` 是毫秒级（内存序列化 + 存储域写入）
- 收尾阶段 4 次 `commitFinalize` × ~几毫秒 = 可接受开销
- 对比原先：从「收尾全部结束才 1 次持久化」变为「每次阶段切换都持久化」，总增量 ~15ms

### 候选 B：StageExecutor 的 `executedSteps` 直接引用 `active.state.executedSteps`

**核心思路**：让 `StageRunState.executedSteps` 与 `active.state.executedSteps` 共享同一数组引用。

**变更点**：
1. `stage-executor.ts` `initState`（L461-514）：传入 `active.state.executedSteps` 引用而非拷贝
2. 引擎侧 `onPersist`（L1252-1276）：从「不可变 upsert」改为「就地 mutate + 通知」
3. 所有读 `active.state.executedSteps` 的路径：需确认不会因 mutate 而读到不一致快照

**优点**：
- 事件发出时自动读到最新（因为是同一引用）

**缺点**：
- **破坏不可变重建语义**：`active.state = { ...active.state, executedSteps: [...] }` 的 spread 语法是为了创建新快照，共享引用意味着任何时刻的 state 都是「半成品」
- 改动面大：`initState`、`onPersist`、所有读 `active.state` 的路径
- 崩溃恢复语义受损：`resumeFrom.completedSteps` 传入的数组会被 StageExecutor 的执行过程 mutate

**结论**：❌ 改动大、风险高、破坏不可变语义，不推荐。

### 候选 C：每个 `commitFinalize` 调用点前手动调 `persist`

**核心思路**：在 `runPhaseB`、`runPhaseC`、`completeAfterFinalize` 的每个 `commitFinalize` 调用点前，手动调用 `this.persist(executed, state)`。

**变更点**：
1. `stage-executor.ts` L1061 前：`await this.persist(executed, state);`
2. `stage-executor.ts` L1095 前：`await this.persist(executed, state);`
3. `stage-executor.ts` L1106 前：`await this.persist(executed, state);`
4. `stage-executor.ts` L1134 前：`await this.persist(executed, state);`
5. `stage-executor.ts` L1152 前：`await this.persist(executed, state);`

**优点**：
- 不改 `buildFinalizeRequest` 和 `commitFinalize` 接口

**缺点**：
- **分散、易漏**：5 个调用点，新增调用时容易忘记
- **语义不清**：`persist` 在 `commitFinalize` 前调用，但 `commitFinalize` 内部又调 `onPersist`（如果注入了）——重复写入
- **不解决顺序问题**：`onPhaseChange` 仍在 `onPersist` 之前（如果后续注入了 `onPersist`）

**结论**：❌ 分散、易漏、不解决顺序问题，不推荐。

### 候选 D：事件载荷携带 `finalizeMeta` 快照

**核心思路**：`sandore/step-phase` 事件载荷附带 `finalizeMeta` 快照，UI 直接用它渲染 badge。

**变更点**：
1. `workflow-engine.ts` `emitStepPhase`（L1987-1989）：载荷加 `finalizeMeta`
2. `stage-executor.ts` `buildFinalizeRequest` 的 `onPhaseChange` 签名：加 `finalizeMeta` 参数
3. `finalize-manager.ts` `commitFinalize`（L1170）：`onPhaseChange` 调用时传 `finalizeMeta`
4. UI `step-phase.ts`：从事件载荷读 `finalizeMeta` 而非 RPC

**优点**：
- UI 不依赖 RPC，事件即数据

**缺点**：
- **事件载荷膨胀**：`finalizeMeta` 含 `phaseHistory`、`assessResult`、`gateResult` 等大字段
- **UI 状态分散**：部分数据来自事件、部分来自 RPC，维护成本高
- **后续字段也需携带**：`phaseHistory`、`previousPhase` 等都得跟
- **改动面大**：事件签名、引擎、UI 三方改动

**结论**：❌ 改动面大、载荷膨胀、状态分散，不推荐。

### 候选 E（新）：仅注入 `onPersist`，不交换顺序

**核心思路**：只在 `buildFinalizeRequest` 注入 `onPersist`，保持 `commitFinalize` 内 `onPhaseChange` 在前、`onPersist` 在后的顺序。

**评估**：
- `onPhaseChange` 先执行 → 发出事件 → UI 收到事件 → 调 `getInstanceState` → 读 `active.state`
- 此时 `onPersist` 尚未执行（因为 `onPhaseChange` 是同步调用，`onPersist` 在其后 `await`）
- **UI 读到的 `active.state` 仍是旧值** ❌

**结论**：❌ 不交换顺序则注入 `onPersist` 无效，不推荐。

---

## 3. 推荐方案详细设计

### 推荐方案：候选 A（注入 `onPersist` + 交换顺序）

### 3.1 变更 1：`stage-executor.ts` `buildFinalizeRequest` 注入 `onPersist`

**文件**: `packages/sandore/microflow/src/stage-executor.ts`  
**位置**: `buildFinalizeRequest` 方法（L1185-1206）  
**改动**: 在返回的对象中添加 `onPersist` 字段

```typescript
// 当前代码（L1192-1205）：
return {
  step,
  executedStep: executed,
  ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
  context,
  ...(gates === undefined ? {} : { gates }),
  workdir: this.options.sharedState.cwd,
  passThroughVars: state.passThroughVars,
  ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
  // 收尾阶段流转钩子透传（commitFinalize 写入 currentPhase 后触发；引擎侧双发事件）。
  ...(this.options.hooks?.onPhaseChange === undefined
    ? {}
    : { onPhaseChange: this.options.hooks.onPhaseChange }),
};

// 修改后：
return {
  step,
  executedStep: executed,
  ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
  context,
  ...(gates === undefined ? {} : { gates }),
  workdir: this.options.sharedState.cwd,
  passThroughVars: state.passThroughVars,
  ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
  // 收尾阶段流转钩子透传（commitFinalize 写入 currentPhase 后触发；引擎侧双发事件）。
  ...(this.options.hooks?.onPhaseChange === undefined
    ? {}
    : { onPhaseChange: this.options.hooks.onPhaseChange }),
  // ✅ 新增：注入 onPersist，使 commitFinalize 内可触发逐阶段持久化。
  // 引擎侧 onPersist（workflow-engine.ts L1252-1276）将 executedStep upsert 进
  // active.state.executedSteps 并 persistState，保证事件发出时 active.state 已含
  // 最新 finalizeMeta（中间态立即可见）。
  ...(this.options.onPersist === undefined
    ? {}
    : {
        onPersist: async (executedStep: ExecutedStepDefault) => {
          await this.options.onPersist?.(executedStep, undefined);
        },
      }),
};
```

**说明**：
- `this.options.onPersist` 是引擎注入的 `StageExecutorOptions.onPersist`（L96），签名 `(executedStep, pendingQueue?) => Promise<void>`
- `FinalizeStepRequest.onPersist`（L142）签名 `(executedStep) => Promise<void>`——适配时传 `undefined` 作为 `pendingQueue`
- 引擎侧 `onPersist`（L1252-1276）已正确处理 `pendingQueue === undefined` 的情况（L1267 `...(pendingQueue === undefined ? {} : { pendingQueue: [...pendingQueue] })`）

### 3.2 变更 2：`finalize-manager.ts` `commitFinalize` 交换顺序

**文件**: `packages/sandore/microflow/src/finalize-manager.ts`  
**位置**: `commitFinalize` 方法（L1170-1171）  
**改动**: 先 `onPersist`（持久化同步），后 `onPhaseChange`（发事件）

```typescript
// 当前代码（L1169-1171）：
// 收尾阶段流转回调：写入 currentPhase 后透传给引擎（双发 sandore/step-phase）。
request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
await request.onPersist?.(request.executedStep);

// 修改后：
// ✅ 先持久化同步：onPersist 将 executedStep（含最新 finalizeMeta）upsert 进
// active.state.executedSteps 并 persistState，保证事件发出时 active.state 已含中间态。
await request.onPersist?.(request.executedStep);
// 再发事件：onPhaseChange 发出 sandore/step-phase，UI 收到后读 active.state 已是最新。
request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
```

**关键时序保证**：

```
commitFinalize('finalizing')
    │
    ├─ request.executedStep.finalizeMeta = { currentPhase: 'finalizing', ... }  // L1163
    ├─ await request.onPersist(executedStep)     // ✅ 同步进 active.state
    │     └─ active.state = { ...active.state, executedSteps: [upsert] }       // L1261-1266
    │     └─ await this.persistState(active)     // L1276 落盘
    └─ request.onPhaseChange(step, childId, 'finalizing')  // 发事件
          └─ emitStepPhase → 双发 sandore/step-phase
                              │
                              ▼
                         UI 收到事件 → getInstanceState → active.state → finalizeMeta = { currentPhase: 'finalizing' } ✅
```

### 3.3 不需要改的地方

| 文件/位置 | 理由 |
|-----------|------|
| `workflow-engine.ts` L1252-1276（引擎侧 `onPersist`） | 已有正确的 upsert + persistState 逻辑，无需改动 |
| `workflow-engine.ts` L1219-1225（`hooks` 构造） | `onPhaseChange` 签名和注入已就位 |
| `workflow-engine.ts` L1230-1278（StageExecutor 构造） | `onPersist` 已注入（L1252），`buildFinalizeRequest` 只需透传它 |
| `FinalizeStepRequest` 接口（L130-151） | `onPersist` 和 `onPhaseChange` 字段已声明 |
| `remote.ts`（getInstanceState 内存优先） | 上一轮修复已改内存优先，本方案确保内存有中间态可读 |

---

## 4. 测试计划

### 4.1 单元测试：`finalize-manager.spec.ts`

**测试 1：`commitFinalize` 时 `onPersist` 在 `onPhaseChange` 之前执行**

```typescript
it('commitFinalize executes onPersist before onPhaseChange (顺序保证)', async () => {
  const callOrder: string[] = [];
  const request: FinalizeStepRequest = {
    step: mockStep,
    executedStep: mockExecuted,
    context: mockContext,
    workdir: '/tmp',
    onPersist: async () => { callOrder.push('onPersist'); },
    onPhaseChange: () => { callOrder.push('onPhaseChange'); },
  };
  await manager.commitFinalize(request, undefined, undefined, 'finalizing');
  expect(callOrder).toEqual(['onPersist', 'onPhaseChange']);
});
```

**测试 2：`commitFinalize` 时 `onPersist` 同步了 `finalizeMeta` 进 `executedStep`**

```typescript
it('commitFinalize onPersist receives executedStep with updated finalizeMeta', async () => {
  let persistedStep: ExecutedStepDefault | undefined;
  const request: FinalizeStepRequest = {
    step: mockStep,
    executedStep: { ...mockExecuted, finalizeMeta: undefined },
    context: mockContext,
    workdir: '/tmp',
    onPersist: async (step) => { persistedStep = step; },
  };
  await manager.commitFinalize(request, assessResult, undefined, 'finalizing');
  expect(persistedStep?.finalizeMeta?.currentPhase).toBe('finalizing');
});
```

### 4.2 单元测试：`stage-executor.spec.ts`

**测试 3：`buildFinalizeRequest` 返回的 request 含 `onPersist` 回调**

```typescript
it('buildFinalizeRequest injects onPersist from options', async () => {
  let capturedRequest: FinalizeStepRequest | undefined;
  const finalizeManager = {
    commitFinalize: async (req: FinalizeStepRequest) => { capturedRequest = req; },
    assessOnly: async () => ({ hasAsk: false }),
    evaluateGates: async () => ({ gatesPassed: true }),
  };
  // ... 构造 StageExecutor，传入 options.onPersist
  // ... 触发 buildFinalizeRequest 路径
  expect(capturedRequest?.onPersist).toBeDefined();
  expect(typeof capturedRequest?.onPersist).toBe('function');
});
```

**测试 4：`buildFinalizeRequest` 注入的 `onPersist` 调用时触发 `options.onPersist`**

```typescript
it('buildFinalizeRequest onPersist delegates to options.onPersist', async () => {
  let optionsOnPersistCalled = false;
  const options = {
    ...mockOptions,
    onPersist: async () => { optionsOnPersistCalled = true; },
  };
  // ... 构造 StageExecutor
  // ... 触发 buildFinalizeRequest → request.onPersist(executed)
  expect(optionsOnPersistCalled).toBe(true);
});
```

### 4.3 集成测试：事件发出时 `active.state` 已含中间态

**测试 5：端到端收尾阶段中间态同步**

```typescript
it('emitStepPhase 发出时 active.state 已含最新 finalizeMeta', async () => {
  // 构造完整引擎 + mock LLM/shell
  const { engine, ctx } = await createTestEngine();
  // 启动一个含门禁的实例
  const instance = await engine.startInstance(workflowDef, input);
  // 等待收尾阶段开始
  // 监听 sandore/step-phase 事件
  const phases: string[] = [];
  ctx.on('sandore/step-phase', (info, stepId, childId, phase) => {
    phases.push(phase);
    // 关键断言：事件发出时，读 active.state 该 step 的 finalizeMeta.currentPhase 应等于 phase
    const state = engine.getInstanceState(instance.id);
    const step = state?.executedSteps.find(s => s.id === stepId);
    expect(step?.finalizeMeta?.currentPhase).toBe(phase);
  });
  // ... 等待实例完成
  expect(phases).toEqual(expect.arrayContaining(['finalizing', 'gating', 'completed']));
});
```

### 4.4 UI 手动验证

1. 启动测试实例（端口 3090）
2. 触发一个含门禁的工作流
3. 观察 UI PhaseBadge 是否依次显示：finalizing → gating → routing → completed
4. 检查浏览器 Network 面板：每次 `sandore/step-phase` 事件后 `getInstanceState` RPC 返回的 `finalizeMeta.currentPhase` 是否为最新阶段

---

## 5. 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| `onPersist` 注入导致 `completeAfterFinalize` 末尾 `persist` 重复写入 | 低 | 高 | 幂等覆盖写（`state.put` 全量覆盖），末尾 `persist` 含 `status=completed` 终态，是必要的最终写入 |
| `onPersist` 回调抛错影响 `commitFinalize` | 中 | 低 | `commitFinalize` 用 `await`，错误会向上传播；引擎侧 `onPersist`（L1276 `await this.persistState(active)`）内有 try/catch 保护 |
| 顺序交换后 `onPhaseChange` 收到的 `finalizeMeta` 可能与 `onPersist` 写入的不一致 | 低 | 极低 | `commitFinalize` 先写 `request.executedStep.finalizeMeta`（L1163），再 `onPersist`，再 `onPhaseChange`——三步在同一个同步上下文内，无竞态 |
| `pendingQueue` 传 `undefined` 导致引擎侧 `onPersist` 行为异常 | 低 | 无 | 已确认 L1267 `pendingQueue === undefined ? {} : { pendingQueue: [...] }` 正确处理 |
| 测试覆盖不足导致回归 | 中 | 低 | 4 个新增单元测试 + 1 个集成测试 + UI 手动验证 |

---

## 6. 是否需要 DSH 配合

**不需要**。所有改动都在 sandore 仓库内：

| 涉及 | 文件 | 归属 |
|------|------|------|
| `stage-executor.ts` | `packages/sandore/microflow/src/stage-executor.ts` | sandore ✅ |
| `finalize-manager.ts` | `packages/sandore/microflow/src/finalize-manager.ts` | sandore ✅ |
| 测试文件 | `packages/sandore/microflow/src/finalize-manager.spec.ts` | sandore ✅ |
| 测试文件 | `packages/sandore/microflow/src/stage-executor.spec.ts` | sandore ✅ |

引擎侧 `onPersist`（`workflow-engine.ts` L1252-1276）已就位，无需改动。`FinalizeStepRequest.onPersist` 类型（`finalize-manager.ts` L142）已就位，无需改动。

---

## 7. 变更清单

| 文件 | 类型 | 行号 | 改动描述 |
|------|------|------|----------|
| `packages/sandore/microflow/src/stage-executor.ts` | 修改 | L1192-1205 | `buildFinalizeRequest` 返回对象新增 `onPersist` 字段，委托给 `this.options.onPersist` |
| `packages/sandore/microflow/src/finalize-manager.ts` | 修改 | L1170-1171 | `commitFinalize` 内交换 `onPersist` 和 `onPhaseChange` 的执行顺序 |
| `packages/sandore/microflow/src/finalize-manager.spec.ts` | 新增 | - | 2 个测试：顺序保证 + finalizeMeta 同步验证 |
| `packages/sandore/microflow/src/stage-executor.spec.ts` | 新增 | - | 2 个测试：`buildFinalizeRequest` 注入验证 + 委托验证 |

**总改动量**：2 个业务文件（~15 行改动）+ 2 个测试文件（~40 行新增）
