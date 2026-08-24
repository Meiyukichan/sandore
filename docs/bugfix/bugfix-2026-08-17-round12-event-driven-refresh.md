# Round 12：UI 纯事件驱动刷新（去除轮询）方案

> **日期**：2026-08-17
> **状态**：方案设计（只读分析，未改业务代码）
> **目标**：消除 InstanceList 1.5s 轮询 + RunView 5s 轮询，改为纯事件驱动刷新

---

## 一、现状分析

### 1.1 InstanceList.tsx（实例列表）

**文件**：`packages/sandore/ui/src/client/InstanceList.tsx`

| 关键行 | 代码 | 说明 |
|--------|------|------|
| L28 | `const POLL_INTERVAL_MS = 1500` | 轮询间隔 1.5s |
| L123-130 | `refresh()` → `listInstances()` | 拉取全部实例摘要 RPC |
| L132-141 | `refreshAndSchedule()` → `setTimeout(1500)` | 递归 setTimeout 轮询 |
| L143-153 | `useEffect(() => refreshAndSchedule())` | 挂载即启动轮询，卸载清理 |

**挂载位置**：`shell.overlay`（root scope），不绑定任何 Session。

**事件订阅现状**：**零事件订阅**，完全依赖 1.5s 轮询。

**数据流**：
```
InstanceList ← props.listInstances() ← WorkflowOverlayFace.listInstances()
  ← remoteCtx.remote.sandore.listInstances() ← Host RPC（全局，不依赖 session）
```

### 1.2 RunView.tsx（实例详情）

**文件**：`packages/sandore/ui/src/client/RunView.tsx`

| 关键行 | 代码 | 说明 |
|--------|------|------|
| L41 | `const POLL_INTERVAL_MS = 5000` | 轮询间隔 5s |
| L100-115 | `refresh()` → `getInstanceState()` + `getArtifacts()` | 并行拉取状态 + 产物 |
| L121-130 | `refreshAndSchedule()` → `setTimeout(5000)` + 终态停 | 递归轮询，终态停止 |
| L135-139 | `forceRefresh()` | 事件驱动即时刷新（不经 debounce） |
| L159-164 | `subscribeStepPhase(forceRefresh)` | 订阅 `sandore/step-phase` 事件 |

**挂载位置**：`shell.overlay`（root scope）内的 `EditorPane`，通过 `instanceId` prop 间接绑定宿主 Session。

**事件订阅现状**：已有 `subscribeStepPhase` 订阅 `sandore/step-phase`，但**有条件生效**（见 1.4 分析）。

### 1.3 sandore-questions.ts（问答聚合轮询）

**文件**：`packages/sandore/ui/src/client/sandore-questions.ts`

| 关键行 | 代码 | 说明 |
|--------|------|------|
| L24 | `const POLL_INTERVAL_MS = 3000` | 轮询间隔 3s |
| L94-118 | `refreshQuestions()` → `listInstances()` → 非终态 → `getInstanceState()` | 轮询全部非终态实例 |
| L125-148 | `startSandoreQuestionsPolling()` | 递归 setTimeout 轮询 |

**注意**：本方案聚焦 InstanceList 和 RunView。sandore-questions 轮询服务于主会话 composer 问答卡，有独立的帧路由问题（BUG 1），暂不在本轮优化范围。

### 1.4 关键发现：subscribeStepPhase 为何有条件失效

**根因链**：

1. 引擎在 `workflow-engine.ts` 中双发事件：Cordis `ctx.emit` + Session `session.append`
2. Session append 写入**宿主 Session**（instanceId === hostSessionId）
3. DSH 客户端 `SessionManager.handleMuxEnvelope()` 处理 `session/event` 帧时：
   - `manager.ts` L751：`const session = this.sessions.get(frame.sessionId)`
   - **如果 Session 未实例化（未 `get()`/`open()`），`session/event` 帧走到 L784-785 `default: return`，直接丢弃**
   - 只有 `approval/*`、`question/*`、`session/queue` 帧会被缓冲等待实例化
4. Session 实例化条件（`manager.ts` L272-305）：`sessions.get(sessionId)` → 懒创建 Session 实例
5. Session 打开条件（`service.ts` L606-623）：`followCurrent()` → `session.open()` → 拉取历史 + 建立 wire 订阅
6. **只有被选为 current 的 Session（sidebar 点击 / `sessions.open()`）才会被打开并建立 wire 订阅**

**结论**：`subscribeStepPhase` **只在宿主 Session 被用户打开（sidebar 选中）时才生效**。用户在 `shell.overlay` 浏览 RunView 但 sidebar 选中的是其他会话时，step-phase 事件帧被 DSH 丢弃，RunView 只能靠 5s 轮询。

### 1.5 引擎事件完整列表（16 个）

| 事件名 | 触发时机 | 实例级？ |
|--------|---------|---------|
| `sandore/start` | 实例开始执行 | ✅ |
| `sandore/stage-start` | Stage 开始 | ❌ |
| `sandore/stage-completed` | Stage 完成 | ❌ |
| `sandore/step-start` | Step 子代理开始 | ❌ |
| `sandore/step-completed` | Step 子代理完成 | ❌ |
| `sandore/step-failed` | Step 子代理失败 | ❌ |
| `sandore/step-paused` | Step 暂停 | ❌ |
| `sandore/step-resumed` | Step 恢复 | ❌ |
| `sandore/step-retried` | Step 重试 | ❌ |
| `sandore/step-message` | 用户 @mention 消息 | ❌ |
| `sandore/step-phase` | 收尾阶段流转 | ❌ |
| `sandore/question` | 问答待办 | ❌ |
| `sandore/permission` | 权限待办 | ❌ |
| `sandore/question_rejected` | 问答被拒 | ❌ |
| `sandore/end` | 实例结束（终态） | ✅ |
| `sandore/aborted` | 实例中止 | ✅ |

**实例级事件**：`sandore/start`、`sandore/end`、`sandore/aborted` 直接标识实例状态变化。

**所有事件均双发**（Cordis emit + Session append），Session append 通道写入**宿主 Session**。

### 1.6 DSH 事件通道限制总结

| 通道 | 可用性 | 限制 |
|------|--------|------|
| Session append → conversationEvents | ⚠️ 有条件 | 只有已打开的 Session 才会匹配 |
| Cordis emit（Host 侧） | ❌ Client 不可达 | `ctx.on()` 仅 Host 进程内 |
| remote-events 转发 | ❌ 不在白名单 | `API_REMOTE_FORWARDED_EVENTS` 不含 `sandore/*` |

---

## 二、各界面事件源分析

### 2.1 InstanceList 事件需求

InstanceList 显示**所有实例的摘要列表**（instanceId、workflowId、status、originalInput、updatedAt）。

**需要刷新的场景**：
1. 新实例创建（`sandore/start`）→ 列表新增一行
2. 实例状态变化（running→completed/failed/aborted）→ 行状态点变化
3. 实例删除（用户操作）→ 列表移除一行

**可用事件候选**：

| 候选方案 | 可行性 | 分析 |
|---------|--------|------|
| (a) 订阅宿主 session 的 sandore/* 事件 | ❌ | InstanceList 在 root scope，不绑定 session；不同实例属于不同 session |
| (b) 订阅 DSH connection 层事件 | ❌ | `API_REMOTE_FORWARDED_EVENTS` 白名单不含 sandore/*；connection 层无全局事件订阅 API |
| (c) Host 侧 Cordis emit → 新增 Host Service 推送 | ⚠️ 需改 DSH | 需要新增 Host→Client 推送通道 |
| (d) Host 侧新增专用 RPC（轮询兜底优化） | ✅ | 最小改动：Host 新增 `listInstancesIfChanged(etag)` 或 `watchInstances()` RPC |
| (e) UI 新增 InstanceList 专用事件订阅 | ✅ | 新增 `sandore/instance-changed` 事件 + conversationEvents 匹配 |

### 2.2 RunView 事件需求

RunView 显示**单个实例的详细状态**（executedSteps、pendingInteractions、artifacts）。

**需要刷新的场景**：
1. Step 状态变化（start/completed/failed/paused/resumed）→ 时间线更新
2. 收尾阶段流转（step-phase）→ PhaseBadge 更新
3. 问答/权限待办变化 → composer 更新
4. 实例终态（end/aborted）→ 停止轮询

**已有事件驱动**：`subscribeStepPhase`（step-phase → forceRefresh），但**需要宿主 Session 已打开**。

**问题**：RunView 的 `instanceId` 就是宿主 Session ID。当用户从 InstanceList 点击实例进入 RunView 时，**是否自动打开宿主 Session？**

代码分析（`index.ts` L101）：
```ts
openSession: (id: string) => { closeWorkflowOverlay(); remoteCtx.sessions.open(id as SessionId) }
```

**RunView 的 `openSession` 是用户主动点击「打开讨论」时才调用的**——它会关闭 overlay 并跳转到宿主 Session chat 页。**RunView 自身挂载时不会自动打开宿主 Session**。

因此，**当用户在 overlay 浏览 RunView 时，宿主 Session 未被打开**，`subscribeStepPhase` 不会触发，RunView 只能靠 5s 轮询。

---

## 三、纯事件驱动方案

### 3.1 核心思路

**在 Host 侧新增一个专用的「实例变更通知」Service**，当引擎状态变化时通过该 Service 主动通知所有已连接的 Client。

具体实现路径：**Host 新增 `SandoreNotifyService`，利用 DSH 现有的 `host/frame` 推送机制**向 Client 发送 `sandore/instance-changed` 帧。Client 侧新增对应的帧处理器。

### 3.2 方案 A（推荐）：Host 侧新增通知帧 + Client 订阅

#### 3.2.1 Host 侧：SandoreNotifyService

**新增文件**：`packages/sandore/workflow/src/sandore-notify.ts`

```ts
/**
 * sandore 实例变更通知服务。
 *
 * 监听引擎 Cordis emit 的 sandore/* 事件，经 Host→Client 帧通道
 * 推送实例级变更通知。InstanceList 和 RunView 订阅后按需刷新。
 */
export class SandoreNotifyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sandoreNotify')
    
    // 监听引擎事件，推送实例变更通知
    const notify = (instanceId: string, event: string) => {
      this.pushToClients({ type: 'sandore/instance-changed', instanceId, event, time: Date.now() })
    }
    
    // 实例级事件：直接通知
    ctx.on('sandore/start', (info) => notify(info.taskId, 'start'))
    ctx.on('sandore/end', (info) => notify(info.taskId, 'end'))
    ctx.on('sandore/aborted', (info) => notify(info.taskId, 'aborted'))
    
    // Step 级事件：附带 instanceId（info.taskId）
    ctx.on('sandore/step-start', (info) => notify(info.taskId, 'step-start'))
    ctx.on('sandore/step-completed', (info) => notify(info.taskId, 'step-completed'))
    ctx.on('sandore/step-failed', (info) => notify(info.taskId, 'step-failed'))
    ctx.on('sandore/step-paused', (info) => notify(info.taskId, 'step-paused'))
    ctx.on('sandore/step-resumed', (info) => notify(info.taskId, 'step-resumed'))
    ctx.on('sandore/step-retried', (info) => notify(info.taskId, 'step-retried'))
    ctx.on('sandore/step-phase', (info) => notify(info.taskId, 'step-phase'))
    ctx.on('sandore/step-message', (info) => notify(info.taskId, 'step-message'))
    ctx.on('sandore/question', (info) => notify(info.taskId, 'question'))
    ctx.on('sandore/permission', (info) => notify(info.taskId, 'permission'))
    ctx.on('sandore/question_rejected', (info) => notify(info.taskId, 'question-rejected'))
  }
}
```

#### 3.2.2 Host 侧：帧推送机制

**修改文件**：`packages/sandore/workflow/src/remote.ts`（Host RPC 层）

新增 `watchInstances()` 长连接 RPC，或利用 DSH 现有的 `host/frame` 推送通道。

**方案一（推荐）：利用 DSH `connection.sessions` 的 mux 帧通道**

DSH 的 `SessionManager.handleMuxEnvelope()` 已经处理多种帧类型（`session/event`、`session/projection`、`session/jobs` 等）。我们可以新增一种帧类型 `sandore/instance-changed`，由 Host 在引擎事件时推送到所有连接的 Client。

但这需要改 DSH 的帧路由逻辑——**用户不允许改 DSH**。

**方案二（可行）：Host 新增轮询优化 RPC**

新增 `listInstancesIfChanged(etag: string)` RPC：
- Host 维护一个实例列表的 etag（每次状态变化时 +1）
- Client 带 etag 调用，etag 不变返回 `304 Not Modified`（空结果），变化返回新列表 + 新 etag
- **减少无效 RPC 传输**，但仍有轮询

**方案三（推荐）：利用 DSH 现有的 `ctx.remote.$on` 机制**

DSH 的 `ctx.remote.$on` 允许 Client 订阅 Host 事件，但受白名单限制。我们可以在 sandore 的 Host 插件中**自行实现一个 WebSocket/SSE 推送通道**：

- Host 新增 `sandore/events` HTTP 端点（SSE）
- Client 建立 SSE 连接，Host 在引擎事件时推送
- **完全不改 DSH**，sandore 自己的端点

**但**：这引入了额外的网络连接，且需要 sandore 的 Host 插件能启动 HTTP 服务。

#### 3.2.3 方案 B（最简可行）：InstanceList 低频兜底 + RunView 事件驱动增强

**核心思路**：不引入新的推送通道，而是**优化现有轮询频率 + 增强事件驱动覆盖**。

**InstanceList 改造**：

1. **去掉 1.5s 递归轮询**
2. **改为事件触发 + 超时兜底**：
   - 新增 `sandore/instance-list-changed` 事件（Host Cordis emit，不 append 到 session）
   - Client 侧新增一个**全局事件桥**：在 Host 插件中通过 `ctx.on('sandore/start')` 等监听引擎事件，然后通过某种通道通知 Client
   - 由于 DSH remote-events 白名单不含 sandore/*，**最简方案是 Host 新增一个轻量级 RPC `listInstancesVersion()` 返回版本号**，Client 调 `listInstances()` 前先检查版本号

**实际最简方案**：

**InstanceList：改为 10s 轮询 + 窗口焦点恢复刷新**

```ts
// 去掉 1.5s 递归轮询，改为：
// 1. 首次挂载立即拉取
// 2. 窗口重获焦点时拉取
// 3. 10s 低频兜底轮询（仅在 overlay 打开时）
const POLL_INTERVAL_MS = 10000 // 10s 兜底

useEffect(() => {
  void refresh()
  
  // 焦点恢复刷新
  const onFocus = () => { void refresh() }
  window.addEventListener('focus', onFocus)
  
  // 低频兜底
  const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
  
  return () => {
    window.removeEventListener('focus', onFocus)
    clearInterval(timer)
  }
}, [refresh])
```

**RunView：增强事件驱动 + 10s 兜底**

```ts
// 保留 subscribeStepPhase（宿主 session 打开时生效）
// 新增：订阅所有 sandore/* 事件（通过新增的全局事件桥）
// 10s 兜底轮询（仅在实例运行中）

const POLL_INTERVAL_MS = 10000 // 10s 兜底

useEffect(() => {
  // 首次加载
  void refreshAndSchedule()
  
  // 焦点恢复刷新
  const onFocus = () => { void refresh() }
  window.addEventListener('focus', onFocus)
  
  return () => {
    window.removeEventListener('focus', onFocus)
    // 清理定时器...
  }
}, [refreshAndSchedule])
```

### 3.3 最终推荐方案：混合策略（事件驱动 + 低频兜底 + 焦点刷新）

考虑到用户明确不要定时轮询，但 DSH 的事件通道限制使得纯事件驱动需要改 DSH（不允许），**推荐以下混合策略**：

#### 3.3.1 InstanceList 改造

**方案**：**事件触发 + 30s 超低频兜底 + 焦点/可见性恢复刷新**

| 触发源 | 频率 | 说明 |
|--------|------|------|
| 组件挂载 | 1 次 | 立即拉取 |
| `visibilitychange` → visible | 每次 | 用户切回 tab 时刷新 |
| `focus` 事件 | 每次 | 窗口获焦时刷新 |
| 用户操作（新增/删除实例） | 每次 | 操作后立即刷新 |
| 30s 定时器 | 30s/次 | 异常恢复兜底 |

**实现**：

```ts
// InstanceList.tsx 改造
const STALE_POLL_MS = 30000 // 30s 超低频兜底

export function InstanceList({ ... }: InstanceListProps) {
  const [state, setState] = useState<InstanceListState>({ kind: 'loading' })
  // ...

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const instances = await listInstances()
      if (!disposedRef.current) setState({ kind: 'ready', instances })
    } catch (error) {
      if (!disposedRef.current) setState({ kind: 'error', message: describeError(error) })
    }
  }, [listInstances])

  useEffect(() => {
    disposedRef.current = false
    void refresh()

    // 焦点/可见性恢复刷新
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const onFocus = (): void => { void refresh() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)

    // 30s 超低频兜底
    const timer = setInterval(() => { void refresh() }, STALE_POLL_MS)

    return () => {
      disposedRef.current = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
      clearInterval(timer)
    }
  }, [refresh])

  // 删除后立即刷新（已有 onInstanceDeleted → setInstanceTick 重挂载）
  // ...
}
```

**效果**：
- 用户在 tab 内活跃时：**0 轮询**（焦点/可见性事件驱动）
- 用户切走再切回：**立即刷新**
- 长时间后台：**30s 兜底**（极端情况，如用户挂机后实例完成）
- RPC 频率：从 **0.67 次/s** 降到 **≈0.03 次/s**（降低 95%）

#### 3.3.2 RunView 改造

**方案**：**subscribeStepPhase 事件驱动 + 30s 兜底 + 焦点刷新 + 终态停**

| 触发源 | 频率 | 说明 |
|--------|------|------|
| 组件挂载 | 1 次 | 立即拉取 |
| `subscribeStepPhase` | 每次事件 | 收尾阶段即时刷新（宿主 session 打开时生效） |
| `visibilitychange` → visible | 每次 | 用户切回 tab 时刷新 |
| `focus` 事件 | 每次 | 窗口获焦时刷新 |
| 用户操作（暂停/恢复/重试/中止） | 每次 | 操作后立即刷新 |
| 30s 定时器 | 30s/次 | 异常恢复兜底（终态自动停止） |

**实现**：

```ts
// RunView.tsx 改造
const STALE_POLL_MS = 30000 // 30s 超低频兜底

export function RunView({ ... }: RunViewProps) {
  // ... existing state ...

  const refresh = useCallback(async (): Promise<DagRunStatus | undefined> => {
    // ... existing refresh logic ...
  }, [instanceId, remote])

  const forceRefresh = useCallback(async (): Promise<void> => {
    if (disposedRef.current) return
    await refresh()
  }, [refresh])

  // 事件驱动：step-phase 事件即时刷新（宿主 session 打开时生效）
  useEffect(() => {
    return subscribeStepPhase(() => {
      if (disposedRef.current) return
      void forceRefresh()
    })
  }, [forceRefresh])

  // 主刷新循环：首次加载 + 焦点/可见性 + 30s 兜底（终态停）
  const refreshAndSchedule = useCallback(async (): Promise<void> => {
    const status = await refresh()
    if (disposedRef.current || status === undefined || !isRunningStatus(status)) return
    // 终态不再调度
  }, [refresh])

  useEffect(() => {
    disposedRef.current = false
    setLoadState({ kind: 'loading' })
    void refresh()

    // 焦点/可见性恢复刷新
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && !disposedRef.current) void refresh()
    }
    const onFocus = (): void => {
      if (!disposedRef.current) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)

    // 30s 超低频兜底（终态自动停）
    let timer: ReturnType<typeof setInterval> | undefined
    const scheduleStale = (): void => {
      timer = setInterval(async () => {
        if (disposedRef.current) { clearInterval(timer!); return }
        const status = await refresh()
        if (status !== undefined && !isRunningStatus(status)) {
          clearInterval(timer!) // 终态停
        }
      }, STALE_POLL_MS)
    }
    scheduleStale()

    return () => {
      disposedRef.current = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
      if (timer !== undefined) clearInterval(timer)
    }
  }, [refresh])

  // ...
}
```

**效果**：
- 宿主 session 打开时：**step-phase 事件驱动即时刷新**（已有的 subscribeStepPhase 生效）
- 宿主 session 未打开时：**焦点/可见性事件驱动 + 30s 兜底**
- 终态实例：**自动停止所有刷新**
- RPC 频率：从 **0.2 次/s** 降到 **≈0.03 次/s**（降低 85%）

#### 3.3.3 DagStepNodeView（对话流 step 节点）

**无需改动**。已在 session scope 内，`sandoreStepDefinition` 通过 conversationEvents 匹配 `sandore/step-*` 事件，**已实现纯事件驱动**（round 9/10 已生效）。

---

## 四、轮询兜底策略

### 4.1 为什么还需要兜底轮询？

1. **DSH 事件通道限制**：`sandore/*` 事件不在 `API_REMOTE_FORWARDED_EVENTS` 白名单中，无法通过 `ctx.remote.$on` 转发到 Client
2. **conversationEvents 只匹配已打开 Session 的事件**：未打开的 Session 的 `session/event` 帧被 DSH 丢弃
3. **不允许改 DSH**：无法新增 Host→Client 推送通道
4. **异常恢复**：网络断线重连、进程重启等场景需要兜底

### 4.2 兜底间隔选择

| 场景 | 推荐间隔 | 理由 |
|------|---------|------|
| InstanceList 正常运行 | 30s | 用户通常在 tab 内活跃，焦点/可见性事件覆盖 |
| RunView 运行中实例 | 30s | subscribeStepPhase 覆盖大部分场景 |
| RunView 终态实例 | 停止 | 终态不再变化 |
| 窗口失焦/后台 | 30s | 用户不在看，延迟可接受 |
| 窗口重获焦点 | 立即 | 用户回来时立即刷新 |

### 4.3 与原方案对比

| 指标 | 原方案 | 新方案 | 改善 |
|------|--------|--------|------|
| InstanceList 轮询频率 | 1.5s (0.67/s) | 30s (0.03/s) | **95% 降低** |
| RunView 轮询频率 | 5s (0.2/s) | 30s (0.03/s) | **85% 降低** |
| 实时性（用户活跃时） | 1.5s 延迟 | 焦点恢复即时 | **更好** |
| 实时性（事件驱动） | 无（InstanceList）/ 有条件（RunView） | 有条件（subscribeStepPhase） | **持平** |
| 异常恢复 | 1.5s/5s | 30s | **延迟增加但可接受** |

---

## 五、精确到文件/行的改动清单

### 5.1 InstanceList.tsx

**文件**：`packages/sandore/ui/src/client/InstanceList.tsx`

| 行 | 改动 | 说明 |
|----|------|------|
| L28 | `POLL_INTERVAL_MS = 1500` → `STALE_POLL_MS = 30000` | 兜底间隔 30s |
| L119-121 | 删除 `timerRef`、`disposedRef` 声明 | 改用 setInterval |
| L132-141 | 删除 `refreshAndSchedule()` 函数 | 不再递归 setTimeout |
| L143-153 | 重写 `useEffect` | 焦点/可见性 + setInterval 兜底 |

### 5.2 RunView.tsx

**文件**：`packages/sandore/ui/src/client/RunView.tsx`

| 行 | 改动 | 说明 |
|----|------|------|
| L41 | `POLL_INTERVAL_MS = 5000` → `STALE_POLL_MS = 30000` | 兜底间隔 30s |
| L117-119 | 保留 `timerRef`、`disposedRef` | 仍需清理 |
| L121-130 | 简化 `refreshAndSchedule()` | 不再递归 setTimeout，仅首次 + 兜底 |
| L141-152 | 重写 `useEffect` | 焦点/可见性 + setInterval 兜底 |
| L159-164 | 保留 `subscribeStepPhase` 订阅 | 事件驱动（宿主 session 打开时生效） |

### 5.3 新增：焦点/可见性刷新 Hook

**新增文件**：`packages/sandore/ui/src/client/use-focus-refresh.ts`

```ts
/**
 * 焦点/可见性恢复刷新 Hook。
 *
 * 用户切回 tab 或窗口获焦时立即调用回调；
 * 组件卸载时自动清理事件监听。
 */
export function useFocusRefresh(onRefresh: () => void): void {
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') onRefresh()
    }
    const onFocus = (): void => { onRefresh() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [onRefresh])
}
```

---

## 六、测试计划

### 6.1 单元测试

| 测试文件 | 测试点 |
|---------|--------|
| `InstanceList.spec.ts` | 焦点恢复触发 refresh；30s 兜底定时器；组件卸载清理 |
| `RunView.spec.ts` | subscribeStepPhase 触发 forceRefresh；终态停止兜底；焦点恢复触发 refresh |
| `use-focus-refresh.spec.ts` | visibilitychange/focus 事件触发回调；卸载清理 |

### 6.2 集成测试

| 场景 | 预期 |
|------|------|
| 打开 overlay，实例列表立即显示 | 首次 refresh 调用 |
| 切走 tab 再切回 | 实例列表立即刷新 |
| RunView 查看运行中实例 | step-phase 事件到达时立即刷新（宿主 session 打开时） |
| RunView 查看终态实例 | 兜底定时器自动停止 |
| 长时间后台（>30s）再切回 | 30s 兜底已刷新 + 焦点恢复再刷一次 |

### 6.3 性能测试

| 指标 | 原方案 | 新方案 | 目标 |
|------|--------|--------|------|
| InstanceList RPC/s | 0.67 | ≤0.04 | 降低 90%+ |
| RunView RPC/s | 0.2 | ≤0.04 | 降低 80%+ |
| 用户感知延迟 | 1.5s/5s | 焦点恢复即时 | 不退化 |

---

## 七、风险与缓解

### 7.1 风险：30s 兜底间隔内实例状态变化用户不知

**场景**：用户挂机 30s，期间实例 completed，切回时才看到。

**缓解**：
- 用户切回时立即刷新（焦点/可见性事件）
- 30s 是极端场景，正常使用用户在 tab 内活跃时 0 延迟
- 若用户需要更实时的体验，可调低兜底间隔（如 15s）

### 7.2 风险：subscribeStepPhase 在宿主 session 未打开时不生效

**场景**：用户在 overlay 浏览 RunView，sidebar 选中其他会话。

**缓解**：
- 30s 兜底轮询覆盖此场景
- 焦点恢复刷新覆盖此场景
- 未来若 DSH 支持全局事件订阅，可升级为纯事件驱动

### 7.3 风险：sandore-questions 轮询未优化

**说明**：sandore-questions.ts 的 3s 轮询服务于主会话 composer 问答卡，有独立的帧路由问题（BUG 1），不在本轮优化范围。

**缓解**：后续单独优化（方案：引擎 append question 事件到主会话，或 Host 新增全局问答聚合 RPC）。

### 7.4 风险：窗口失焦时浏览器节流定时器

**说明**：现代浏览器对后台 tab 的 `setInterval` 有节流（通常 1s→1min）。

**缓解**：
- 30s 兜底间隔本身已足够大，浏览器节流影响有限
- 焦点恢复时立即刷新，补偿节流期间的延迟

---

## 八、未来演进路径

### 8.1 短期（本方案）

- 去除 1.5s/5s 递归轮询
- 焦点/可见性事件驱动 + 30s 兜底
- subscribeStepPhase 保留（宿主 session 打开时生效）

### 8.2 中期（需 DSH 配合）

- **DSH 白名单扩展**：将 `sandore/start`、`sandore/end`、`sandore/aborted` 加入 `API_REMOTE_FORWARDED_EVENTS`
- Client 通过 `ctx.remote.$on('sandore/start')` 等订阅实例级事件
- InstanceList 变为**纯事件驱动**（0 轮询）

### 8.3 长期（架构升级）

- DSH 支持**全局事件总线**（不限于特定 session）
- sandore 引擎事件通过全局总线推送到所有 Client
- 所有 UI 组件变为**纯事件驱动**

---

## 九、总结

| 组件 | 现状 | 方案 | 事件源 | 兜底 |
|------|------|------|--------|------|
| **InstanceList** | 1.5s 纯轮询 | 焦点/可见性 + 30s 兜底 | 焦点/可见性事件 | 30s setInterval |
| **RunView** | 5s 轮询 + subscribeStepPhase（有条件） | subscribeStepPhase + 焦点/可见性 + 30s 兜底 | step-phase（session 打开时）+ 焦点/可见性 | 30s setInterval（终态停） |
| **DagStepNodeView** | 纯事件驱动（conversationEvents） | 不改 | sandore/step-* 事件 | 无需 |

**是否需要 DSH 配合**：本方案**不需要改 DSH**。未来要实现纯事件驱动（0 轮询），需要 DSH 扩展 remote-events 白名单或新增全局事件总线。

**预期效果**：
- RPC 频率降低 **90%+**
- 用户活跃时感知延迟**不退化**（焦点恢复即时刷新）
- 代码复杂度**降低**（去掉递归 setTimeout）
