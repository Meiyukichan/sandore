# Bug 修复计划：收尾阶段中间态 UI 显示竞态

**日期**: 2026-08-17  
**状态**: 方案已定稿（用户决策：内存第一优先级），待实施  
**严重程度**: 高（用户体验问题——中间阶段不可见，只看到最终态）

## 0. 用户最终决策（覆盖原推荐方案 B）

**`getInstanceState` 内存为第一优先级，读不到再持久化读取。**

- remote.ts `getInstanceState`（L273-276）改为：先调引擎内存读取（`ctx.sandoreEngine` 新增公开方法，读 `this.instances.get(instanceId)?.state`，ActiveInstance.state 为内存最新态，commitFinalize 修改 executedStep 引用即同步更新），`undefined`（终态清表/未在内存）再回退 `sandorePersistence.state.get(instanceId)`。
- 依据：`executed` 在 stage-executor.ts L888-890 push 进 `state.executedSteps`（同一对象引用），commitFinalize 改 `executedStep.finalizeMeta` 即内存 active.state 同步到最新阶段——内存读必然拿到阶段中间态（finalizing/gating/routing）。持久化因 `buildFinalizeRequest` 未注入 `onPersist` 只在收尾全部结束后做一次，读持久化必然落后。
- 不做原方案 B 的 onPersist 注入/顺序交换（用户否决：持久化优先不适合本场景；事件后 UI 应立即读内存最新态）。

---

## 1. 现象描述

Step 执行完成后，收尾阶段（Phase B `finalizing「收尾中」`、Phase C `gating「门禁中」`、Phase D `routing「判断中」`）**没有及时在页面上显示**。中间阶段 badge 一闪而过或完全不可见，用户只能看到最终态（`completed「已完成」` / `failed「已失败」`）。用户要求「阶段变化立即可见」。

---

## 2. 根因分析

### 2.1 完整时序链（已通过代码确认）

以 `completeAfterFinalize`（正常收尾全流程）为例：

```
step-executor
  ├─ runPhaseB()
  │   ├─ assessForked()                           // LLM 调用
  │   └─ commitFinalize('finalizing')              // stage-executor.ts L1061
  │       ├─ request.executedStep.finalizeMeta = buildFinalizeMeta(...)  // L1163 内存写入
  │       ├─ onPhaseChange?.('finalizing')         // L1170 → emitStepPhase → 双发事件 ✅
  │       └─ request.onPersist?.()                 // L1171 → undefined → NO-OP ❌
  │
  ├─ runPhaseC()
  │   ├─ evaluateGates()                           // 纯代码校验 / AI 审查
  │   └─ commitFinalize('gating')                  // stage-executor.ts L1095 (门禁失败时)
  │       ├─ request.executedStep.finalizeMeta = ... // 内存写入
  │       ├─ onPhaseChange?.('gating')             // → 双发事件 ✅
  │       └─ request.onPersist?.()                 // → NO-OP ❌
  │
  └─ completeAfterFinalize()                       // stage-executor.ts L1113
      ├─ commitFinalize('routing')                 // L1129
      │   ├─ request.executedStep.finalizeMeta = ... // 内存写入
      │   ├─ onPhaseChange?.('routing')            // → 双发事件 ✅
      │   └─ request.onPersist?.()                 // → NO-OP ❌
      ├─ resolveNextNodes()                        // L1131
      ├─ commitFinalize('completed')               // L1147
      │   ├─ request.executedStep.finalizeMeta = ... // 内存写入
      │   ├─ onPhaseChange?.('completed')          // → 双发事件 ✅
      │   └─ request.onPersist?.()                 // → NO-OP ❌
      ├─ executed.status = 'completed'             // L1151
      └─ persist(executed, state)                  // L1154 → onPersist → persistState
           └─ sandorePersistence.state.put(taskId, state)  // 此时才持久化！
```

### 2.2 根因 1：`FinalizeStepRequest.onPersist` 未注入

**文件**: `microflow/src/stage-executor.ts`  
**位置**: `buildFinalizeRequest` (L1179-1201)

```typescript
private buildFinalizeRequest(...): FinalizeStepRequest {
    return {
      step,
      executedStep: executed,
      // ... 其他字段
      ...(this.options.hooks?.onPhaseChange === undefined
        ? {}
        : { onPhaseChange: this.options.hooks.onPhaseChange }),
      // ⚠️ 没有注入 onPersist！
    };
  }
```

`FinalizeStepRequest` 接口声明了 `onPersist` 回调（`finalize-manager.ts` L142），但 `buildFinalizeRequest` **从未注入它**。因此 `commitFinalize` 中的 `await request.onPersist?.(request.executedStep)`（L1171）实际是 **undefined 短路**——`?.` 操作符在 `undefined` 上不执行任何操作。

### 2.3 根因 2：事件先发、持久化后做

**文件**: `microflow/src/finalize-manager.ts`  
**位置**: `commitFinalize` (L1170-1171)

```typescript
async commitFinalize(...): Promise<void> {
    request.executedStep.finalizeMeta = buildFinalizeMeta(...);  // L1163 内存写入
    // ...
    request.onPhaseChange?.(request.step, ..., currentPhase);    // L1170 先发事件
    await request.onPersist?.(request.executedStep);             // L1171 后持久化（实际 NO-OP）
}
```

即使 `onPersist` 有效，**事件也在持久化之前发出**。这是一个设计选择的副产品——`onPhaseChange` 的原始设计意图是通知「阶段已变更」，但没有保证「变更已持久化」。

### 2.4 根因 3：真正持久化延迟到所有阶段完成后

**文件**: `microflow/src/stage-executor.ts`  
**位置**: `completeAfterFinalize` (L1154)

```typescript
// P3 completed 持久化（含终态 finalizeMeta）。
await this.persist(executed, state);  // L1154 —— 所有阶段完成后才持久化！
```

中间阶段（`finalizing`、`gating`、`routing`）的状态变更只存在于 **StageExecutor 内存中的 `executed` 对象**，只有到 `completed` 阶段完成后才通过 `persist()` → `onPersist()` → `persistState()` → `saveWorkflowState()` → `state.put()` 落盘。

### 2.5 根因 4：UI 读的是持久化层，不是引擎内存

**文件**: `workflow/src/remote.ts`  
**位置**: `getInstanceState` (L273-276) → `requireInstanceState` (L465-471)

```typescript
private requireInstanceState(instanceId: string): WorkflowTaskState {
    const state = this.ctx.sandorePersistence.state.get(instanceId);  // 读 KvTable
    if (state === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    return state;
}
```

**关键**: `KvTable.get()` 是 **同步内存读**（`dsh-storage-domain` 文档明确写 "Read one record, synchronously from memory"），但 `KvTable.put()` 是 **异步写链**：先写后端持久化 → 然后更新内存 → 然后发事件。在 `put` 完成之前，`get` 读到的是 **旧值**。

### 2.6 根因 5：轮询兜底捕捉不到毫秒级中间态

**文件**: `ui/src/client/RunView.tsx`  
**位置**: `refreshAndSchedule` (L121-130)

```typescript
const refreshAndSchedule = useCallback(async (): Promise<void> => {
    const status = await refresh()
    if (disposedRef.current || status === undefined || !isRunningStatus(status)) return  // L123 终态停轮询
    if (timerRef.current === undefined) {
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        void refreshAndSchedule()
      }, POLL_INTERVAL_MS)  // L128 = 5000ms
    }
}, [refresh])
```

- `POLL_INTERVAL_MS = 5000`（L41），收尾阶段在毫秒级完成（finalizing → gating → routing → completed），5s 轮询根本捕捉不到中间态
- `if (!isRunningStatus(status)) return`（L123）：若某次轮询读到终态（completed/failed），立即停止轮询

### 2.7 事件推送通道工作正常

**文件**: `ui/src/client/step-phase.ts` (L56-68) + `ui/src/client/RunView.tsx` (L149-154)

```typescript
// step-phase.ts
export const stepPhaseDefinition: ConversationNodeDefinition<Record<string, never>> = {
  kind: 'sandore-step-phase',
  match: (event) => {
    if (event.type !== 'sandore/step-phase') return null
    return { id: `${event.data.stepId}#${event.data.phase}@${event.seq}`, role: 'start' }
  },
  start: (_context, match) => {
    notifyStepPhase()  // 同步通知所有订阅者
    return {}
  },
  // ...
}

// RunView.tsx
useEffect(() => {
    return subscribeStepPhase(() => {
      if (disposedRef.current) return
      void refreshAndSchedule()  // 收到事件 → 立即刷新
    })
}, [refreshAndSchedule])
```

`session.append` 是 **同步操作**（DSH `Session.append` 实现中 `this.log.push(event)` + 同步触发 observers）。事件通过 `conversationEvents` 通道同步到达客户端 → `step-phase.ts` 的 `start` handler 同步调用 `notifyStepPhase()` → RunView 的 `refreshAndSchedule()` 立即触发。

**事件通道本身工作正常**——问题在于事件到达时，**持久化层还没更新**。

### 2.8 竞态总结

```
时间轴：
  t0: commitFinalize('finalizing')
      ├─ 内存 executed.finalizeMeta.currentPhase = 'finalizing'  ✅
      ├─ emitStepPhase('finalizing')  → 事件发出  ✅
      └─ onPersist = undefined → NO-OP
  
  t1: UI 收到 'finalizing' 事件 → refreshAndSchedule()
      └─ getInstanceState() → state.get(instanceId)
         └─ 读到的 executedSteps[N].finalizeMeta.currentPhase 仍是 'running' 或上一阶段  ❌
            （因为 persistState 还没执行，KvTable 内存缓存还是旧值）
  
  t2: ... (后续阶段同理)
  
  t3: commitFinalize('completed')
      └─ 同上
  
  t4: persist(executed, state)   ← 此时才持久化！
      └─ state.put(taskId, state)
         ├─ 写后端（异步）
         └─ 更新内存（put 完成后）
  
  t5: 下一次 5s 轮询（如果还在跑）
      └─ getInstanceState() → 读到终态  →  UI 显示最终态  ✅
         （但中间阶段已错过）
```

---

## 3. 候选方案对比

### 方案 A：事件后 UI 延迟重试（hack 方案）

**原理**: step-phase 事件到达后，UI 不立即 RPC，短延迟（50-100ms）后重试 1-2 次读到最新持久化。

**改动**:
- `ui/src/client/RunView.tsx`：`subscribeStepPhase` 回调中加 `setTimeout` 延迟 + 重试循环

**优点**: 改动极小，仅 UI 侧  
**缺点**: 
- Hack 感重，延迟时间依赖经验值
- 无法保证 100% 命中（如果 LLM 响应极快，持久化可能在重试窗口内完成；也可能不）
- 引入了不确定性和时序耦合
- 违背「事件 = 状态已变更通知」的语义

**推荐**: ❌ 不推荐（治标不治本，增加不确定性）

### 方案 B：引擎侧事件移到持久化之后（推荐）

**原理**: 在 `commitFinalize` 中，将 `onPhaseChange` 回调移到 `onPersist` 之后触发，保证事件到达时持久化已完成。

**改动**:
1. **`microflow/src/finalize-manager.ts` L1170-1171**：交换顺序

   ```typescript
   // 改前：
   request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
   await request.onPersist?.(request.executedStep);
   
   // 改后：
   await request.onPersist?.(request.executedStep);
   request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
   ```

2. **`microflow/src/stage-executor.ts` `buildFinalizeRequest`**：注入 `onPersist` 回调，使其在 `commitFinalize` 内就能触发 `persistState`（而非延迟到 `completeAfterFinalize` 的末尾统一 `persist`）。

   ```typescript
   // 在 buildFinalizeRequest 中注入 onPersist
   onPersist: async (executedStep) => {
     // 通过回调通知 StageExecutor 的 persist 方法
     await this.options.onPersist?.(executedStep as ExecutedStepDefault);
   },
   ```

**优点**:
- 改动小（核心改动 ~10 行）
- 语义正确：事件是「阶段已变更**并已持久化**」的通知
- 不需要 UI 侧 hack
- 每个阶段事件触发时，持久化已保证完成
- UI 收到事件 → RPC 读持久化 → 必然读到最新 state

**缺点**:
- `commitFinalize` 每次调用都会触发一次 `persistState`（之前只在 `completeAfterFinalize` 末尾统一一次），增加了持久化频率
- 需要确保 `onPersist` 注入不会导致 `completeAfterFinalize` 末尾的 `persist` 产生重复写入（幂等性验证）

**风险评估**:
- `persistState` 调用 `saveWorkflowState`（全量覆盖 `state.put(taskId, state)`），幂等安全
- 每次 `commitFinalize` 的 `onPersist` 只写入当前 `executed` 的 `finalizeMeta` 更新，`active.state` 中的 `executedSteps` 数组通过 `onPersist` 回调（L1240-1264）正确 upsert
- 最后 `completeAfterFinalize` 末尾的 `persist(executed, state)` 再写一次（含 `completed` 状态），幂等覆盖

**推荐**: ✅ **主推方案**（改动最小、语义最正确）

### 方案 C：remote 层增加引擎内存读取路径

**原理**: `getInstanceState` 除了读持久化层，还尝试读引擎内存中的 `active.state`（实时最新状态），持久化作为 fallback。

**改动**:
1. **`workflow/src/workflow-engine.ts`**：暴露 `getActiveState(instanceId)` 方法
2. **`workflow/src/remote.ts` `getInstanceState`**：优先从引擎内存读，fallback 到持久化

   ```typescript
   getInstanceState(instanceId: string): WorkflowTaskState {
     // 优先读引擎内存（实时最新）
     const live = this.ctx.sandoreEngine.getActiveState?.(instanceId);
     if (live !== undefined) return live;
     // fallback 到持久化
     return this.requireInstanceState(instanceId);
   }
   ```

**优点**:
- UI 总是读到最新内存态
- 不改变事件/持久化时序
- 对引擎的侵入最小

**缺点**:
- 引擎 `ActiveInstance` 是内部状态，暴露它违反封装（`active.state` 是可变引用）
- 内存态和持久化态可能有不一致窗口（如果引擎刚更新内存但还没 persist）
- 需要处理实例不在内存时的 fallback（崩溃恢复场景、已停止的实例）
- `ActiveInstance` 包含非序列化字段（lifecycle manager、session 引用等），暴露整个对象可能泄漏内部引用
- 引入了两套数据源的维护成本

**推荐**: ⚠️ 可作为增强方案（方案 B+C 组合），但单独使用有封装风险

### 方案 D：UI 事件后短轮询窗口

**原理**: 收到 step-phase 事件后进入 200-300ms 的密集轮询（如 4 次 50ms），读到稳定最新态后恢复正常轮询。

**改动**:
- `ui/src/client/RunView.tsx`：增加密集轮询逻辑

**优点**: 不改引擎侧  
**缺点**: 
- 和方案 A 类似的 hack 感
- 增加了 RPC 调用次数
- 无法保证读到中间态（如果 300ms 内完成全部收尾，密集轮询读到的可能直接是终态）

**推荐**: ❌ 不推荐

---

## 4. 推荐方案

### **方案 B（引擎侧 onPhaseChange 移到 onPersist 之后）+ 微调**

#### 4.1 核心改动

**文件 1**: `packages/sandore/microflow/src/finalize-manager.ts`  
**位置**: `commitFinalize` (L1170-1171)

```typescript
// 改前（L1169-1171）：
    // 收尾阶段流转回调：写入 currentPhase 后透传给引擎（双发 sandore/step-phase）。
    request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
    await request.onPersist?.(request.executedStep);

// 改后：
    // 先持久化（保证事件到达时 UI 可读到最新 state），再发事件通知。
    await request.onPersist?.(request.executedStep);
    // 收尾阶段流转回调：写入 currentPhase 后透传给引擎（双发 sandore/step-phase）。
    request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
```

**文件 2**: `packages/sandore/microflow/src/stage-executor.ts`  
**位置**: `buildFinalizeRequest` (L1179-1201)

在返回的对象中注入 `onPersist` 回调：

```typescript
private buildFinalizeRequest(
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
  ): FinalizeStepRequest {
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
      // ✅ 新增：注入 onPersist，使 commitFinalize 内可触发逐阶段持久化
      onPersist: async (executedStep) => {
        await this.options.onPersist?.(executedStep as ExecutedStepDefault, undefined);
      },
    };
  }
```

#### 4.2 改动后时序

```
step-executor
  ├─ runPhaseB()
  │   └─ commitFinalize('finalizing')
  │       ├─ executed.finalizeMeta = buildFinalizeMeta(...)
  │       ├─ onPersist(executed) → persistState(active) → state.put() → 内存更新 ✅
  │       └─ onPhaseChange('finalizing') → emitStepPhase → 事件发出 ✅
  │           └─ UI 收到事件 → getInstanceState → 读到 finalizing ✅
  │
  ├─ runPhaseC()
  │   └─ commitFinalize('gating')
  │       ├─ onPersist(executed) → persistState → 内存更新 ✅
  │       └─ onPhaseChange('gating') → 事件发出 ✅
  │           └─ UI 读到 gating ✅
  │
  └─ completeAfterFinalize()
      ├─ commitFinalize('routing')
      │   ├─ onPersist(executed) → persistState → 内存更新 ✅
      │   └─ onPhaseChange('routing') → 事件发出 ✅
      │       └─ UI 读到 routing ✅
      ├─ resolveNextNodes()
      ├─ commitFinalize('completed')
      │   ├─ onPersist(executed) → persistState → 内存更新 ✅
      │   └─ onPhaseChange('completed') → 事件发出 ✅
      │       └─ UI 读到 completed ✅
      ├─ executed.status = 'completed'
      └─ persist(executed, state)  // 末尾再次持久化（幂等覆盖，含 status=completed）
```

#### 4.3 副作用分析

| 副作用 | 影响 | 评估 |
|--------|------|------|
| 每个 `commitFinalize` 都触发 `persistState` | 增加持久化频率（从 1 次 → 4 次） | ✅ 可接受：`state.put` 是全量覆盖写，幂等安全；单次写入是毫秒级 |
| `completeAfterFinalize` 末尾 `persist` 仍会执行 | 重复写入 | ✅ 幂等：覆盖写保证一致性 |
| `onPersist` 回调中的 `pendingQueue` 传 `undefined` | `onPersist(executed, undefined)` | ✅ 安全：引擎侧 L1255 `pendingQueue === undefined ? {} : { pendingQueue: [...] }` 正确处理 |
| `gating` 失败路径的 `persist`（L1097）在 `commitFinalize('gating')` 之后 | 两次 `persistState` 连续调用 | ✅ 安全：第二次覆盖第一次（status=failed） |

---

## 5. 测试计划

### 5.1 单元测试

1. **`finalize-manager.spec.ts`**：`commitFinalize` 调用顺序验证
   - Mock `onPersist` 和 `onPhaseChange`，验证 `onPersist` 先于 `onPhaseChange` 被调用
   - 验证 `onPersist` 在 `onPhaseChange` 之前完成（await 语义）

2. **`stage-executor.spec.ts`**：`buildFinalizeRequest` 注入 `onPersist`
   - 验证 `buildFinalizeRequest` 返回的 request 含 `onPersist` 回调
   - 验证调用 `request.onPersist(executed)` 会触发 `options.onPersist`

### 5.2 集成测试

3. **端到端时序验证**：
   - 启动一个工作流实例
   - 在 `onPersist` 和 `onPhaseChange` 回调中加 spy
   - 验证每个收尾阶段的 `onPersist` 在 `onPhaseChange` 之前完成
   - 验证事件发出时 `sandorePersistence.state.get(taskId)` 已包含最新的 `finalizeMeta.currentPhase`

### 5.3 手动测试

4. **UI 验证**：
   - 启动 dev 实例（端口 3090）
   - 执行一个含门禁 + 路由的工作流
   - 观察 Timeline 中 PhaseBadge 是否按序显示：`收尾中` → `门禁中` → `判断中` → `已完成`
   - 验证每个阶段 badge 至少持续可见 200ms（不会一闪而过）

---

## 6. 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 持久化频率增加导致性能下降 | 低 | `state.put` 是内存 Map 写入 + 异步后端持久化，单次毫秒级；4 次 vs 1 次差异可忽略 |
| `onPersist` 注入导致 `completeAfterFinalize` 末尾 `persist` 行为变化 | 低 | 幂等覆盖写；末尾 `persist` 包含 `status=completed` 的最终状态，是必要的最终写入 |
| `gating` 失败路径的双重 `persistState` | 低 | 幂等覆盖；第二次写入的 `status=failed` 覆盖第一次的 `running` |
| `onPersist` 回调抛错影响 `commitFinalize` | 中 | `commitFinalize` 用 `await`，错误会向上传播；需确保引擎侧 `onPersist` 实现有 try/catch（已确认 L1264 `await this.persistState(active)` 内有 try/catch） |

---

## 7. 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `packages/sandore/microflow/src/finalize-manager.ts` | 顺序调整 | L1170-1171：`onPersist` 移到 `onPhaseChange` 之前 |
| `packages/sandore/microflow/src/stage-executor.ts` | 新增注入 | `buildFinalizeRequest` 返回对象中注入 `onPersist` 回调 |
| `packages/sandore/microflow/tests/finalize-manager.spec.ts` | 新增测试 | `commitFinalize` 调用顺序验证 |
| `packages/sandore/microflow/tests/stage-executor.spec.ts` | 新增测试 | `buildFinalizeRequest` 注入验证 |

**预计改动行数**: ~15 行业务代码 + ~30 行测试代码
