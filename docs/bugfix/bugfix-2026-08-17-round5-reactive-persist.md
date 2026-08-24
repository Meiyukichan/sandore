# Round 5：State 内存与数据库响应式持久化架构方案

> 日期：2026-08-17
> 范围：sandore workflow-engine + microflow stage-executor  
> 目标：将「逐点手动 `persistState`」改为「state 变化即自动写库」的响应式同步

---

## 一、现状分析

### 1.1 核心数据结构关系

```
workflow-engine.ts
├── ActiveInstance.state: WorkflowTaskState   ← 内存中的完整状态快照（L126）
├── instances: Map<string, ActiveInstance>    ← 所有运行中实例（L313）
└── persistState(active)                     ← 持久化入口（L1882-1892）
      └── persistence.saveWorkflowState(active.state)  ← 全量覆盖写入 state 表

stage-executor.ts
├── StageRunState (局部变量，L318-360)        ← Stage 内部运行状态
│   ├── executedSteps, previousOutputs, passThroughVars
│   ├── batch, nextBatch, status, errorDetail
│   ├── pendingAsk, pendingPaused, pendingResumes
│   └── pendingBetweenSteps
└── persist(executed, state) (L1403-1406)    ← onPersist 钩子回调
      └── onPersist(executed, pendingQueue)   ← 引擎注入的逐 Step 持久化回调
```

**关键关系：StageRunState 是 ActiveInstance.state 的部分映射，而非引用**

- `StageRunState` 是 `StageExecutor` 内部的局部变量（`this.runState`），与 `ActiveInstance.state` **不是同一对象引用**
- 引擎通过 `onPersist` 回调（L1252-1277）将 StageExecutor 的变更桥接回 `ActiveInstance.state`：
  - 每个 Step 完成 → `active.state.executedSteps` upsert + `pendingQueue` 写入 + `updatedAt` 更新
  - 然后调 `await this.persistState(active)` 落盘
- Stage 结束后，引擎将 `result.passThroughVars` 合并回 `active.state.passThroughVars`（L1413-1417）
- `visitCounts` 是共享引用（L1250: `visitCounts: active.state.visitCounts`），直接修改
- `activeLoopStack` / `activeLoopIterationStack` 也是共享引用（L1208）

### 1.2 workflow-engine.ts `active.state =` 赋值点与 `persistState` 配对审计

共 **26 处** `active.state =` 赋值、**27 处** `persistState` 调用。

| # | 行号 | 赋值内容 | persistState | 状态 | 备注 |
|---|------|---------|-------------|------|------|
| 1 | 560 | (startInstance 初始落盘) | L560 `void` | ✅ | fire-and-forget，无赋值前缀 |
| 2 | 673 | `status: 'aborted'` | L674 `await` | ✅ | abortInstance 终态 |
| 3 | 753 | `status: 'failed'` | L754 `await` | ✅ | recoverInstance catch 分支 |
| 4 | 767 | `status: 'failed'` | L768 `await` | ✅ | recoverResult.hasFailure |
| 5 | 783 | `status: 'running'` | L784 `await` | ✅ | recoverInstance 重跑 |
| 6 | 1019-1032 | `userMessages: [...]` | L1033 `await` | ✅ | sendStepMessage |
| 7 | 1073 | `permission: mode` | L1074 `await` | ✅ | setPermissionMode |
| 8 | 1099 | `status: 'failed'` | L1100 `await` | ✅ | runAndCatch catch |
| 9 | 1122 | `status: 'running'` | L1123 `await` | ✅ | runInstance 首次 |
| 10 | 1197 | markStageStatus (间接赋值) | L1198 `await` | ✅ | Stage 开始 |
| 11 | 1261-1269 | onPersist 内赋值 | L1276 `await` | ✅ | 逐 Step 持久化 |
| 12 | 1288 | `status: 'interacting'` | L1289 `await` | ✅ | ask 中断 |
| 13 | 1316-1325 | executedSteps map + `status: 'failed'` | L1326 `await` | ✅ | 无 ask 载荷异常 |
| 14 | 1361-1374 | `userMessages: [answer]` | L1375 `await` | ✅ | ask 回答写入 |
| 15 | 1405 | `status: 'aborted'` | L1406 `await` | ✅ | aborted 兜底 |
| 16 | 1413-1417 | `passThroughVars` 合并 | ❌ 无直接 persist | ⚠️ | Stage 结束后合并，交由后续 persist |
| 17 | 1422-1427 | `status: 'failed'` + stageContracts | L1428 `await` | ✅ | Stage failed |
| 18 | 1441-1446 | stageContracts + currentStageId | L1447 `await` | ✅ | Stage completed |
| 19 | 1461 | `status: 'completed'` | L1462 `await` | ✅ | 工作流完成 |
| 20 | 1469-1472 | markStageStatus (间接) | 无 | ⚠️ | 仅 stageInfos，下一 persistState 自然覆盖 |
| 21 | 1507-1515 | executedSteps map (failed) | L1516 `await` | ✅ | handleRejectedQuestion |
| 22 | 1522 | `status: 'failed'` | L1523 `await` | ✅ | handleRejectedQuestion |
| 23 | 1554-1557 | sessionMeta update (childId) | L1560 `await` | ✅ | onChildStarted |
| 24 | 1600 | `pendingInteractions` | L1601 `void` | ✅ | InteractionManager persist |
| 25 | 1621 | `active.state = next` (commitState) | L1622 `void` | ✅ | LifecycleManager commitState |
| 26 | 1625-1629 | `userMessages` (appendUserMessage) | L1630 `void` | ✅ | LifecycleManager |
| 27 | 1639 | `active.state = next` (commitState) | L1640 `void` | ✅ | RecoveryManager commitState |
| 28 | 1643-1648 | `userMessages` (appendUserMessage) | L1648 `void` | ✅ | RecoveryManager |

**遗漏点：**

| # | 位置 | 问题 | 风险 |
|---|------|------|------|
| ⚠️1 | L1413-1417 | `passThroughVars` 合并后无直接 persistState | 低：紧接着 L1428 或 L1447 或 L1462 会持久化，但若在这之间崩溃则丢失最新 passThroughVars |
| ⚠️2 | L1469-1472 | `markStageStatus` 无直接 persistState | 低：同一函数内很快有 persistState 调用 |
| ⚠️3 | L1600/1622/1630/1640/1648 | 5 处 `void this.persistState(active)` fire-and-forget | 中：不等写库完成即继续执行，崩溃窗口内可能丢失 pendingInteractions/userMessages |

**冗余点：无。** 所有 persistState 调用都有对应的 state 变更。

### 1.3 stage-executor.ts State 字段变更点与 onPersist 覆盖审计

共 **35 处** `state.xxx =` 赋值、**11 处** `this.persist()` 调用。

#### 1.3.1 经 onPersist 桥接回 `ActiveInstance.state` 并落库的字段

`onPersist` 回调（L1252-1277）只桥接以下字段：
- `executedSteps`（upsert by id）
- `pendingQueue`（snapshot batch + nextBatch）
- `updatedAt`

**这些字段经 onPersist 落库：**
- `executedSteps` 的所有 push/update（L740, L786, L827, L841, L889, L1294）
- `previousOutputs` 不经 onPersist 落库（StageRunState 局部变量，Stage 结束时通过 `result` 返回引擎）

#### 1.3.2 **不经** onPersist 落库、仅在 Stage 结束时才落的字段

| 字段 | 变更行号 | 持久化时机 | 风险 |
|------|---------|-----------|------|
| `state.status` | L446, L658, L661, L789, L828, L844, L1012, L1098, L1156, L1279, L1295, L1309 | Stage 结束时引擎 L1428/1447/1462 | **高**：Stage 内 status='failed'/'paused'/'interacting' 变更不立即落库，崩溃恢复无法知道 Stage 内部中间态 |
| `state.errorDetail` | L790, L845, L1099, L1280, L1310 | 同上 | **高**：失败原因不随 status 落库 |
| `state.batch` | L442, L594, L623, L664 | 不落库（局部调度状态） | 低：通过 pendingQueue 间接落库 |
| `state.nextBatch` | L595, L665 | 不落库 | 低：同上 |
| `state.pendingAsk` | L1011, L1332 | 不落库 | **中**：ask 断点信息不落库，崩溃恢复需要靠 executedSteps 的 finalizeMeta='ask-detect' 间接恢复 |
| `state.pendingPaused` | L829, L1212, L1296 | 不落库 | **中**：paused 断点信息不落库 |
| `state.pendingResumes` | L1240 | 不落库 | 低：resume 断点从 executedSteps 重建 |
| `state.pendingBetweenSteps` | L437 | 不落库 | 低：between-steps 从 executedSteps 重建 |
| `state.passThroughVars` | (只读) | Stage 结束后引擎合并 L1413 | 低 |
| `state.previousOutputs` | L1143 | 不落库（局部变量） | 低：从 executedSteps 重建 |

**关键发现：stage-executor 的 `state.status` 变更（failed/paused/interacting）不随每次变更落库，只在 Stage 结束时由引擎 persistState 落。这意味着：**

1. Stage 内 Step 失败（`state.status = 'failed'`）→ 但库中状态仍为 running → 崩溃恢复可能误判
2. Stage 内 ask 中断（`state.status = 'interacting'`）→ 库中无此态 → 崩溃恢复后 UI 不显示 ask
3. Stage 内 pause（`state.status = 'paused'`）→ 库中无此态 → 崩溃恢复丢失暂停状态

### 1.4 persistState 幂等性/并发性分析

```typescript
// workflow-engine.ts L1882-1892
private async persistState(active: ActiveInstance): Promise<void> {
  const persistence = this.persistence();
  if (persistence === undefined) return;
  try {
    await persistence.saveWorkflowState(active.state);
  } catch (error) {
    this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
  }
}
```

```typescript
// persistence.ts L54-56
async saveWorkflowState(state: WorkflowTaskState): Promise<void> {
  await this.state.put(state.taskId, state);
}
```

**幂等性：✅ 安全。** `saveWorkflowState` 是全量覆盖（`put(key, value)`），多次调用只写最后一次的值。  
**并发安全性：⚠️ 有序但有覆盖窗口。**

### 1.5 KvTable.put 语义（DSH dsh-storage-domain）

```typescript
// DSH domain.ts L307-313
put(key: K, value: V): Promise<void> {
  return this.host.enqueue(async () => {
    await this.host.unit.putRecord(this.tableName, key, value)
    this.records.set(key, value)  // 先写后端，再更新内存缓存
    this.emitPut(key, value)
  })
}

// enqueue 串行队列 L263-270
private enqueue<T>(job: () => Promise<T>): Promise<T> {
  if (this.disposing) return Promise.reject(...)
  const result = this.chain.then(job)  // 串行链：前一个完成才执行下一个
  this.chain = result.then(noop, noop)
  return result
}
```

**关键语义：**
1. **串行队列**：同一表的 put 操作串行执行（enqueue chain），不会并行写入
2. **先写后读**：先 `putRecord`（持久化），再 `records.set`（内存缓存），保证持久化成功后缓存才更新
3. **覆盖策略**：后写覆盖前写（last-write-wins），无版本号/冲突检测
4. **异步**：put 返回 Promise，写入是异步的
5. **内存缓存**：`get()` 读内存缓存（L287-290），put 后内存缓存立即更新

**并发写入场景：**
- 快速连续调用 `persistState`：由于 enqueue 串行队列，写入不会乱序，但会**写放大**（每次写入完整 state 快照）
- `void persistState(active)` fire-and-forget：不等完成即继续，下次 `active.state` 可能已变，但当前 put 排队中的仍是旧值 → enqueue 保证顺序，最终一致性成立

### 1.6 崩溃恢复语义

当前崩溃恢复依赖 `state` 表中的快照：
- `recoverInstance`（L691）从 `persistence.state.get(instanceId)` 读快照
- 快照中的 `executedSteps` + `pendingQueue` 用于重建执行位置
- `status` 字段用于判断是否终态

**当前问题：** Stage-executor 内部的 status/errorDetail/pendingAsk 等字段不落库，崩溃恢复后只能靠 `executedSteps` 中的 `finalizeMeta.currentPhase` 间接推断。

---

## 二、候选方案对比

### 候选 a：Proxy 包装 state（深度响应式）

**思路：** 用 `Proxy` 拦截 `active.state` 的所有 set 操作，变更后自动触发 persistState。

```typescript
// 伪代码
const handler = {
  set(target, prop, value) {
    target[prop] = value;
    scheduleDebouncedPersist(active);
    return true;
  }
};
active.state = new Proxy(initialState, handler);
```

**问题：**
1. **整体替换失效**：当前代码大量使用 `active.state = { ...active.state, xxx }`（整体替换），Proxy 包在旧对象上，新对象无 Proxy → 变更丢失
2. **嵌套对象拦截复杂**：`executedSteps.push(...)`、`stageInfos.map(...)` 等深层变更需要递归 Proxy
3. **性能开销**：每次属性访问都经过 Proxy trap，高频读操作（`state.status`、`state.executedSteps` 等）性能下降
4. **无法区分读写意图**：`state.executedSteps.map(...)` 既读又产生新数组赋值，难以精确控制
5. **StageRunState 无法覆盖**：stage-executor 内部的 `state.xxx =` 赋值是局部变量，Proxy 无法拦截

**评估：改动面小（只改 active.state 初始化），但实际无法覆盖整体替换和 stage-executor 内部变更。**

### 候选 b：统一 commitState 方法（显式响应式）

**思路：** 把所有 `active.state = {...}` 改为 `this.commitState(active, next)`（内部赋值 + 触发持久化），stage-executor 的 state 变更同样统一走注入的 commitState。

**优点：**
- 显式、可控、无魔法
- 每个变更点一目了然

**问题：**
1. **改动面巨大**：workflow-engine 26 处 + stage-executor 35 处 = **61 处**需修改
2. **遗漏风险高**：任何遗漏的直接赋值都会导致内存-数据库不一致
3. **stage-executor 耦合引擎**：stage-executor 当前不感知 persistState，需注入 commitState → 架构耦合
4. **写放大严重**：每次微小变更（如 `state.batch = []`）都触发全量写库

**评估：理论上最干净，但改动面过大、遗漏风险高。**

### 候选 c：微任务批处理 + 版本号（推荐）

**思路：** 结合 Proxy 拦截（覆盖整体替换）和微任务合并（防写放大），用版本号防乱序。

**核心设计：**

```typescript
class ReactiveState<T extends object> {
  private version = 0;
  private pendingPersist: Promise<void> | null = null;
  private latestState: T;
  private persistFn: (state: T) => Promise<void>;
  private scheduled = false;

  constructor(initial: T, persistFn: (state: T) => Promise<void>) {
    this.latestState = initial;
    this.persistFn = persistFn;
  }

  get state(): T {
    return this.latestState;
  }

  set state(next: T) {
    this.latestState = next;
    this.schedulePersist();
  }

  // 批量更新（单次赋值内多个字段变更只触发一次写库）
  update(fn: (current: T) => T): void {
    this.latestState = fn(this.latestState);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.scheduled) return;  // 已调度，跳过
    this.scheduled = true;
    // 微任务合并：同一事件循环内的多次变更只写最后一次
    queueMicrotask(() => {
      this.scheduled = false;
      const version = ++this.version;
      const snapshot = this.latestState;
      this.persistFn(snapshot).then(() => {
        // 写入完成，检查是否有更新版本
        if (this.version > version) {
          // 有更新，重新调度
          this.schedulePersist();
        }
      });
    });
  }
}
```

**关键改进点：**

1. **整体替换覆盖**：`active.state = { ... }` 通过 setter 拦截，无需修改赋值语法
2. **微任务合并**：同一事件循环内多次赋值只触发一次写库（防写放大）
3. **版本号防乱序**：写入完成后检查版本号，有更新则重新调度
4. **Stage-executor 覆盖**：通过注入 `commitState` 回调，stage-executor 内部的 status/errorDetail 变更也能触发写库

**评估：改动面适中（初始化 + stage-executor 注入），无遗漏风险，写放大可控。**

---

## 三、推荐方案：微任务批处理 + 版本号（候选 c 变体）

### 3.1 核心设计

```typescript
// 新增：packages/sandore/workflow/src/reactive-state.ts

/**
 * 响应式状态包装器。
 *
 * 拦截 `state = next` 赋值，自动触发微任务批处理持久化。
 * 同一事件循环内多次赋值只写最后一次（防写放大）。
 * 版本号保证写入顺序：写入完成后若有更新则重新调度。
 */
export class ReactiveState<T extends object> {
  private version = 0;
  private scheduled = false;
  private latest: T;

  constructor(
    initial: T,
    private readonly persist: (state: T) => Promise<void>,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.latest = initial;
  }

  /** 读取当前状态（同步，零开销）。 */
  get current(): T {
    return this.latest;
  }

  /** 替换状态并调度持久化（微任务合并）。 */
  set current(next: T) {
    this.latest = next;
    this.schedule();
  }

  /** 批量更新（函数式，避免中间态暴露）。 */
  update(fn: (current: T) => T): void {
    this.latest = fn(this.latest);
    this.schedule();
  }

  /** 立即持久化（用于终态落盘等关键路径，不等微任务）。 */
  async flush(): Promise<void> {
    await this.persist(this.latest);
  }

  /** 强制调度（即使无变更也写一次，用于初始化）。 */
  forcePersist(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const version = ++this.version;
      const snapshot = this.latest;
      this.persist(snapshot).catch(error => {
        this.onError?.(error);
      }).then(() => {
        // 写入完成后检查是否有更新版本
        if (this.version > version) {
          this.schedule();
        }
      });
    });
  }
}
```

### 3.2 workflow-engine.ts 改造

#### 3.2.1 ActiveInstance 结构变更

```typescript
// 改造前（L126）
interface ActiveInstance {
  // ...
  state: WorkflowTaskState;
  // ...
}

// 改造后
interface ActiveInstance {
  // ...
  reactiveState: ReactiveState<WorkflowTaskState>;  // 新增
  // state 保留为 getter（兼容性）
  get state(): WorkflowTaskState;
  set state(next: WorkflowTaskState);
  // ...
}
```

#### 3.2.2 buildActiveInstance 改造（L1588-1699）

```typescript
// 改造前
active = {
  // ...
  state,
  // ...
};

// 改造后
const reactiveState = new ReactiveState(
  state,
  async (snapshot) => {
    const persistence = this.persistence();
    if (persistence === undefined) return;
    await persistence.saveWorkflowState(snapshot);
  },
  (error) => {
    this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
  },
);
active = {
  // ...
  reactiveState,
  // state 通过 Object.defineProperty 或 Proxy 实现 getter/setter
  // ...
};
// 或者用 defineProperty：
Object.defineProperty(active, 'state', {
  get: () => reactiveState.current,
  set: (next) => { reactiveState.current = next; },
  enumerable: true,
  configurable: true,
});
```

#### 3.2.3 persistState 方法改造（L1882-1892）

```typescript
// 改造前
private async persistState(active: ActiveInstance): Promise<void> {
  const persistence = this.persistence();
  if (persistence === undefined) return;
  try {
    await persistence.saveWorkflowState(active.state);
  } catch (error) {
    this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
  }
}

// 改造后：保留方法签名（兼容现有调用），内部委托 ReactiveState
private async persistState(active: ActiveInstance): Promise<void> {
  // 直接触发调度（微任务合并会自动去重）
  active.reactiveState.forcePersist();
  // 等待当前写入完成（保证关键路径落盘）
  // 注意：这里不能直接 await，因为 forcePersist 只是调度
  // 需要改为 flush 语义
}

// 更好的方案：关键路径用 flush，非关键路径用 reactiveState.current = xxx 自动调度
private async persistState(active: ActiveInstance): Promise<void> {
  await active.reactiveState.flush();
}
```

#### 3.2.4 关键路径改造（需要确保落盘的场景）

以下场景需要 `await flush()` 而非微任务调度：

| 场景 | 行号 | 改造方式 |
|------|------|---------|
| 终态落盘（completed/failed/aborted） | L674, L754, L768, L784, L1100, L1428, L1447, L1462, L1516, L1523 | `await active.reactiveState.flush()` |
| 崩溃恢复关键快照 | L742, L1123, L1198 | `await active.reactiveState.flush()` |
| onChildStarted（真实 childId 落盘） | L1560 | `await active.reactiveState.flush()` |

其他场景（fire-and-forget 的 `void this.persistState(active)`）改为：
```typescript
// 改造前
void this.persistState(active);

// 改造后：直接赋值，ReactiveState 自动调度微任务持久化
active.state = { ...active.state, pendingInteractions: entries, updatedAt: now() };
// 无需显式调用 persistState，setter 已触发
```

#### 3.2.5 markStageStatus 改造（L1468-1473）

```typescript
// 改造前
private markStageStatus(active: ActiveInstance, stageId: string, status: StepStatus): void {
  active.state = {
    ...active.state,
    stageInfos: active.state.stageInfos.map(item => (item.id === stageId ? { ...item, status } : item)),
  };
}

// 改造后：直接赋值，ReactiveState 自动调度
private markStageStatus(active: ActiveInstance, stageId: string, status: StepStatus): void {
  active.state = {
    ...active.state,
    stageInfos: active.state.stageInfos.map(item => (item.id === stageId ? { ...item, status } : item)),
  };
  // 无需显式 persistState，setter 已触发
}
```

### 3.3 stage-executor.ts 改造

#### 3.3.1 注入 commitState 回调

```typescript
// stage-executor.ts StageExecutorOptions 新增
export interface StageExecutorOptions {
  // ... 现有字段 ...
  /** 响应式状态提交（替代直接修改 state.xxx）。
   *  stage-executor 内部的 status/errorDetail/pendingAsk 等字段变更
   *  通过此回调桥接回引擎的 ReactiveState，触发自动持久化。 */
  readonly commitState?: (patch: Partial<StageRunState>) => void;
}
```

#### 3.3.2 Stage-executor 内部 state 变更改造

```typescript
// 改造前（示例：L789-790）
state.status = 'failed';
state.errorDetail = message;

// 改造后
state.status = 'failed';
state.errorDetail = message;
this.options.commitState?.({ status: 'failed', errorDetail: message });
```

**需要改造的变更点（35 处 → 分类处理）：**

1. **status/errorDetail 变更（需要桥接到 ActiveInstance.state）**：
   - L789-790, L828-829, L844-845, L1011-1012, L1098-1099, L1156, L1279-1280, L1295-1296, L1309-1310

2. **batch/nextBatch/batchIndex 变更（纯调度状态，不需要桥接）**：
   - L442-443, L594-596, L623-624, L664-665

3. **pendingAsk/pendingPaused/pendingResumes（断点状态，不需要桥接，从 executedSteps 重建）**：
   - L1011, L1212, L1240, L1332

4. **pendingBetweenSteps（不需要桥接）**：
   - L437

**关键设计：stage-executor 的 commitState 只桥接 `status` 和 `errorDetail` 到 ActiveInstance.state，其他字段（batch/nextBatch/pendingAsk 等）保持局部。**

#### 3.3.3 onPersist 回调改造（L1252-1277）

```typescript
// 改造前
onPersist: async (executed, pendingQueue) => {
  active.state = {
    ...active.state,
    executedSteps: /* upsert */,
    ...(pendingQueue === undefined ? {} : { pendingQueue: [...pendingQueue] }),
    updatedAt: now(),
  };
  await this.persistState(active);
},

// 改造后：直接赋值，ReactiveState 自动调度微任务持久化
onPersist: async (executed, pendingQueue) => {
  active.state = {
    ...active.state,
    executedSteps: /* upsert */,
    ...(pendingQueue === undefined ? {} : { pendingQueue: [...pendingQueue] }),
    updatedAt: now(),
  };
  // 无需显式 persistState，setter 已触发
  // 但这里需要确保 executedSteps 落盘（崩溃恢复关键）
  // 用 flush 而非微任务调度
  await active.reactiveState.flush();
},
```

### 3.4 InteractionManager / LifecycleManager / RecoveryManager 改造

这三个管理器通过回调注入的方式读写 state：

```typescript
// buildActiveInstance 中的注入（L1596-1667）
const interactions = new InteractionManager({
  // ...
  persist: (entries) => {
    active.state = { ...active.state, pendingInteractions: entries, updatedAt: now() };
    // 改造后：无需显式 persistState
  },
  // ...
});
const lifecycle = new LifecycleManager({
  // ...
  commitState: (next) => {
    active.state = next;
    // 改造后：无需显式 persistState
  },
  // ...
});
```

**改造方式：移除回调中的 `void this.persistState(active)`，直接赋值即可。**

### 3.5 写放大控制策略

| 场景 | 变更频率 | 策略 |
|------|---------|------|
| Stage 内 status 变更 | 低（每个 Stage 最多几次） | 微任务合并 |
| executedSteps upsert | 中（每个 Step 完成一次） | onPersist 内 flush（关键路径） |
| batch/nextBatch 变更 | 高（每个 Step 处理前后） | 不桥接（局部变量） |
| 终态落盘 | 低（每个实例一次） | flush（关键路径） |
| 用户交互（ask/permission） | 低 | 微任务合并 |

**预估写入频率：**
- 改造前：~30 次手动 persistState + ~15 次 onPersist = ~45 次/实例生命周期
- 改造后：~20 次 flush（关键路径）+ ~25 次微任务合并 = ~45 次/实例生命周期（总量不变，但分布更均匀）

### 3.6 崩溃恢复语义

**改造后崩溃恢复优势：**

1. Stage 内 status 变更（failed/paused/interacting）随微任务落库 → 崩溃恢复可直接读到
2. errorDetail 随 status 落库 → 崩溃恢复可显示错误原因
3. pendingAsk/pendingPaused 仍从 executedSteps 重建（不桥接）

**崩溃窗口：**
- 微任务调度窗口（queueMicrotask 回调执行前）：此窗口内崩溃丢失最新 state
- 但此窗口极短（同一事件循环内），且关键路径（终态/onPersist）用 flush 保证落盘

**中间态问题：**
- 微任务合并可能写入中间态（如 status 先设 'running' 再设 'failed'，合并后只写 'failed'）
- 这是**期望行为**：中间态不需要持久化，只有最终态需要

### 3.7 与现有 onPersist 逐 Step 落库的共存

**改造后架构：**

```
Stage-executor 内部变更
├── executedSteps push/update → onPersist 桥接 → ActiveInstance.state → flush（关键路径）
├── status/errorDetail 变更 → commitState 回调 → ActiveInstance.state → 微任务调度
└── batch/nextBatch 变更 → 不桥接（局部变量，通过 pendingQueue 间接落库）

workflow-engine 引擎级变更
└── active.state = {...} → ReactiveState setter → 微任务调度
```

**onPersist 仍保留**：逐 Step 持久化是崩溃恢复的关键，不能改为微任务调度。

---

## 四、实施计划

### Phase 1：ReactiveState 基础设施（新增文件）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1.1 | `packages/sandore/workflow/src/reactive-state.ts` | ReactiveState 类实现 |
| 1.2 | `packages/sandore/workflow/src/reactive-state.spec.ts` | 单元测试 |

### Phase 2：workflow-engine 改造

| 步骤 | 文件 | 内容 | 改动量 |
|------|------|------|--------|
| 2.1 | `workflow-engine.ts` | ActiveInstance 结构变更（reactiveState + state getter/setter） | ~30 行 |
| 2.2 | `workflow-engine.ts` | buildActiveInstance 改造（ReactiveState 初始化 + defineProperty） | ~20 行 |
| 2.3 | `workflow-engine.ts` | persistState 方法改造（委托 flush） | ~10 行 |
| 2.4 | `workflow-engine.ts` | 关键路径改为 flush（~10 处 await persistState） | ~10 行 |
| 2.5 | `workflow-engine.ts` | 非关键路径移除显式 persistState（~15 处 void persistState） | ~15 行 |
| 2.6 | `workflow-engine.ts` | InteractionManager/LifecycleManager/RecoveryManager 回调改造 | ~15 行 |

### Phase 3：stage-executor 改造

| 步骤 | 文件 | 内容 | 改动量 |
|------|------|------|--------|
| 3.1 | `stage-executor.ts` | StageExecutorOptions 新增 commitState 回调 | ~5 行 |
| 3.2 | `stage-executor.ts` | status/errorDetail 变更点注入 commitState（~9 处） | ~20 行 |
| 3.3 | `stage-executor.ts` | onPersist 内改为 flush | ~5 行 |
| 3.4 | `workflow-engine.ts` | 构造 StageExecutor 时注入 commitState 回调 | ~15 行 |

### Phase 4：测试

| 步骤 | 文件 | 内容 |
|------|------|------|
| 4.1 | `reactive-state.spec.ts` | ReactiveState 单元测试（微任务合并、版本号、flush） |
| 4.2 | `workflow-engine.spec.ts` | 响应式持久化集成测试（状态变更自动落盘、崩溃恢复） |
| 4.3 | `stage-executor.spec.ts` | commitState 回调测试 |

**总改动量估算：~150 行新增 + ~100 行修改**

---

## 五、风险与回滚

### 5.1 风险点

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 微任务合并导致关键路径落盘延迟 | 崩溃恢复可能丢失最新 state | 关键路径用 flush（await），非关键路径用微任务 |
| Object.defineProperty 兼容性 | 某些 Proxy/Reflect API 可能受影响 | 测试覆盖 |
| stage-executor commitState 遗漏 | 部分 status 变更不落库 | 代码审查 + 测试覆盖 |
| 写放大未完全消除 | 微任务合并可能多次写入同一快照 | 版本号检查：写入完成后若 version 未变则跳过 |
| 与现有 onPersist 竞态 | executedSteps 和 status 可能不一致 | onPersist 内用 flush，保证 executedSteps 先落 |

### 5.2 回滚方案

1. **代码回滚**：ReactiveState 是新增文件，workflow-engine 改动可 revert
2. **数据兼容**：state 表 schema 无变更，旧数据可直接读取
3. **渐进式发布**：先实现 ReactiveState + workflow-engine 改造，stage-executor 改造作为独立 Phase

### 5.3 DSH 侧配合需求

**无需 DSH 配合。** 所有改动在 sandore 侧完成：
- ReactiveState 是纯 sandore 组件
- KvTable.put 语义已满足需求（串行队列、先写后读）
- 无需修改 DSH 存储层

---

## 六、附录：完整变更清单

### A. 新增文件

- `packages/sandore/workflow/src/reactive-state.ts` — ReactiveState 类
- `packages/sandore/workflow/src/reactive-state.spec.ts` — 单元测试

### B. 修改文件

- `packages/sandore/workflow/src/workflow-engine.ts` — ActiveInstance 结构 + buildActiveInstance + persistState + 关键路径/非关键路径改造
- `packages/sandore/microflow/src/stage-executor.ts` — StageExecutorOptions + commitState 注入 + onPersist 改造
- `packages/sandore/workflow/src/workflow-engine.spec.ts` — 集成测试
- `packages/sandore/microflow/src/stage-executor.spec.ts` — commitState 测试

### C. 不修改文件

- DSH 源码（`D:\project-code\llm\deepseek-harness`）— 只读参考
- `packages/sandore/workflow/src/persistence.ts` — 无变更（saveWorkflowState 保持全量覆盖）
- `packages/sandore/workflow/src/interaction-manager.ts` — 无变更（回调注入已改造）
- `packages/sandore/workflow/src/lifecycle-manager.ts` — 无变更（回调注入已改造）
- `packages/sandore/workflow/src/recovery-manager.ts` — 无变更（回调注入已改造）
