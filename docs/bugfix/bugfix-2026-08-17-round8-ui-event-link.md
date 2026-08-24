# Round 8：UI 事件链路断 — 收尾阶段中间态不显示（根因 + 修复方案）

> **日期**: 2026-08-17  
> **问题**: 收尾阶段中间态（收尾中/门禁中/判断中）UI 从未出现，只靠 5s 轮询读到最终态  
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

### 1.1 前轮修复为何无效（背景）

Round 4-7 的修复都聚焦在**引擎侧**：确保 `active.state` 在事件发出时已含中间态（onPersist 注入 + 顺序交换）。引擎侧已修复完毕（集成测试断言通过）。但 UI 侧的事件驱动链路始终是断的——**事件到不了 UI**。

### 1.2 根因：`sandore/step-phase` session append 事件被 DSH client manager 丢弃

#### 1.2.1 引擎侧事件发送路径（正常）

```
workflow-engine.ts L1987-1989 emitStepPhase
    │
    ├─ this.emitContained('sandore/step-phase', [...])   // Cordis ctx.emit（host 侧事件）
    │     └─ host 事件，不转发到 client（sandore/step-phase 不在 API_REMOTE_FORWARDED_EVENTS 白名单）
    │
    └─ session.append('sandore/step-phase', {...})       // Session append 通道
          └─ 写入宿主 session 的事件流
```

引擎侧双发无误。问题在 client 侧。

#### 1.2.2 Client 侧事件消费路径（断链）

```
Host session.append('sandore/step-phase')
    │
    ▼
Wire mux 帧 { type: 'session/event', sessionId: instanceId, event: {...} }
    │
    ▼
client index.ts L206: sessions.handleMuxEnvelope(envelope)
    │
    ▼
manager.ts L683: handleMuxEnvelope(envelope)
    │
    ├─ L751: const session = this.sessions.get(frame.sessionId)
    │
    └─ L752-785: if (session === undefined) {
                    switch (frame.type) {
                      case 'approval/requested':
                      case 'question/requested':
                      case 'session/queue':
                        // 缓存到 pendingBuffers
                        return
                      default:
                        return  ← ❌ session/event 直接丢弃！
                    }
                  }
```

**精确位置**：`D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\sessions\manager.ts` **L751-785**

当 `frame.sessionId`（宿主 session / instanceId）不在 `this.sessions` Map 中时，`session/event` 帧被直接 `return` 丢弃。

#### 1.2.3 为什么宿主 session 不在 `this.sessions` 中

`sessions` Map 只包含通过 `manager.get(sessionId)` 实例化的 session。实例化触发路径：

1. `sessions.open(id)` → `manager.select(id)` → **不实例化 session**（只设 `this.selected`）
2. `sessions.resolve(id)` → `manager.get(id)` → **实例化 session**（L272-276 创建并加入 `this.sessions`）
3. `sessions.resolve` 触发场景：`sessions.scope(id)` / `sessions.sessionOf(scope)` / `sessions.binding(id)`

**sandore UI 的实际情况**：

- `index.ts` L101: `openSession: (id) => { closeWorkflowOverlay(); remoteCtx.sessions.open(id as SessionId) }` — 只在用户点击 agent 标题时跳转会话页
- `index.ts` L117: `sessions.scope(sessionId as SessionId)` — 在 `permissions` 回调中被调用
- `RunView.tsx` L223-226: `sessionPermissionsOf(instanceId)` — RunView 渲染时调用 `sessions.scope(instanceId)`

**关键**：`sessions.scope(instanceId)` → `resolve(instanceId)` → `manager.get(instanceId)` → **session 被实例化并加入 `manager.sessions`**。

但实例化 ≠ 可接收实时事件。

#### 1.2.4 即使 session 已实例化，实时事件仍被丢弃

`session.ts` L688-693 `acceptLiveEvent`：

```typescript
private acceptLiveEvent(event: SessionEvent, view?: ToolEventView): void {
    if (this.openState === 'loading' || this.stitching) {
      this.liveBuffer.push({ event, view })
      return
    }
    if (this.openState !== 'open') return // ← ❌ cold 状态直接丢弃
```

- `manager.get(sessionId)` 创建 session 时 `openState = 'cold'`（L73）
- 只有 `session.open()`（L369-378）才会将 `openState` 转为 `'loading'` → `'open'`
- `session.open()` 只在 `followCurrent()`（L620）中被调用，而 `followCurrent` 只在 session 成为 current 时触发
- sandore 宿主 session **不是 current**（它是后台工作流的 session，用户在 overlay 中查看），所以 `open()` 从未被调用

**最终结果**：`openState === 'cold'` → `acceptLiveEvent` L693 `return` → 事件丢弃。

#### 1.2.5 两层丢弃总结

| 层 | 条件 | 位置 | 结果 |
|---|------|------|------|
| Manager 层 | `sessions.get(instanceId) === undefined` | manager.ts L751-785 | session 未实例化 → 事件丢弃 |
| Session 层 | `openState === 'cold'` | session.ts L693 | session 已实例化但未 open → 事件丢弃 |

两层都导致 `sandore/step-phase` session append 事件**到不了 UI 的 `stepPhaseDefinition`**。

#### 1.2.6 conversationEvents.register 是全局的，但 assembler 需要事件输入

- `index.ts` L48: `ctx.conversationEvents.register(stepPhaseDefinition)` — 注册到全局 `ConversationEventRegistry`
- `manager.ts` L321: 所有 session 共享同一个 `{ events: conversationEvents, views: conversationViews }` → 每个 session 的 `ConversationNodeAssembler` 共享同一份 definitions
- `conversation-assembler.ts` L370: `for (const definition of this.eventDefinitions.entries())` — 匹配时遍历所有已注册 definitions

**结论**：definitions 注册是全局的，但 **match 只在 `conversation.append({event, view})` 时触发**（session.ts L679）。如果事件到不了 `appendLive`（因 cold 状态或 session 未实例化），definition 永远不会被 match。

### 1.3 根因链总结

```
引擎 commitFinalize
    ├─ emitStepPhase → 双发 sandore/step-phase
    │     ├─ ctx.emit（host 事件，不转发到 client）     ← 无效
    │     └─ session.append → wire mux session/event 帧
    │
    ▼
DSH client manager.handleMuxEnvelope
    │
    ├─ sessions.get(instanceId) === undefined？         ← 可能（session 未实例化）
    │     └─ session/event 帧被丢弃（L784 default: return）
    │
    └─ session 存在但 openState === 'cold'？            ← 必然（非 current session）
          └─ acceptLiveEvent L693: return               ← 事件丢弃
    │
    ▼
conversation.append 从未被调用 → stepPhaseDefinition.match 从未触发
    │
    ▼
notifyStepPhase 从未执行 → RunView forceRefresh 从未被调用
    │
    ▼
UI 只靠 5s 轮询 → 收尾阶段 ~1-3s，轮询读到时已是 completed 终态
```

---

## 2. 候选方案对比

### 候选 A：RunView 主动缩短轮询间隔（收尾阶段 500ms）

**核心思路**：收尾阶段持续时间短（~1-3s），5s 轮询间隔太长。将收尾阶段（running 实例）的轮询间隔缩短到 500ms，使中间态大概率被捕捉。

**变更点**：
1. `RunView.tsx` L41: `POLL_INTERVAL_MS` 从 5000 改为动态值
2. `RunView.tsx` `refreshAndSchedule`: 根据状态选择间隔（running → 500ms，其他 → 5000ms）

**优点**：
- **最简单、最可靠**：不依赖 DSH 事件链路，不依赖 session 打开状态
- **零 DSH 依赖**：纯 sandore UI 改动
- **500ms 轮询对收尾阶段足够**：收尾阶段每个中间态持续 ~200-500ms（commitFinalize 内同步操作），500ms 轮询有 ~50-80% 概率捕捉到中间态
- **性能影响小**：running 实例少（通常 1 个），500ms 轮询 = 2 QPS，可忽略

**缺点**：
- 不是事件驱动，有概率漏过极短的中间态（<500ms）
- 与 5s 轮询相比增加 RPC 频率（但 running 实例通常只有 1 个）

**评估**：✅ 推荐作为基础方案（兜底）。

### 候选 B：UI 在 RunView 挂载时主动 resolve 宿主 session + open

**核心思路**：在 RunView 挂载时，调用 `sessions.scope(instanceId)` 确保 session 被实例化，然后手动调用 `session.open()` 使其 `openState` 变为 `'open'`，从而可以接收实时事件。

**变更点**：
1. `RunView.tsx` `useEffect`: 挂载时调用某个 API 确保 session 被 open
2. 需要 `sessions` 服务的额外 API（如 `sessions.ensureOpen(instanceId)`）

**评估**：
- `sessions.open(id)` 的语义是**切换 current**（UI 跳转到会话页），不适合后台使用
- 需要一个新的"后台 open"API，但 DSH 没有这个能力
- `session.open()` 是 private/manager-only（L464 注释），外部不能直接调
- **结论**：❌ 需要改 DSH 或 hack DSH 内部 API，不可行。

### 候选 C：事件改走 host/remote-event 全局通道

**核心思路**：让 `sandore/step-phase` 通过 DSH 的 `host/remote-event` 桥接转发到 client，RunView 直接订阅 `ctx.remote.$on('sandore/step-phase')`。

**评估**：
- `host/remote-event` 有白名单：`API_REMOTE_FORWARDED_EVENTS`（`D:\project-code\llm\deepseek-harness\packages\api\remotes\src\remote-events.ts` L17-29）
- `sandore/step-phase` **不在白名单中**
- 添加到白名单需要改 DSH 源码
- **结论**：❌ 需要改 DSH，不可行。

### 候选 D：engine RPC push 通知（新增专用 RPC）

**核心思路**：引擎侧新增一个轻量 RPC 端点（如 `sandore/subscribe-phase`），UI 通过 WebSocket 订阅，引擎在 phase 变化时主动推送。

**评估**：
- 引擎侧可以通过 `connection` 或自定义 WebSocket 通道推送
- 但 DSH 的 RPC 架构是 request/response 模式，没有原生的 server-push 通道
- 需要自建 WebSocket 或 SSE 通道
- **结论**：❌ 改动大、引入新基础设施，过度设计。

### 候选 E（推荐）：A + 补充 — 缩短轮询 + 事件到达后强制刷新

**核心思路**：
1. **基础**：收尾阶段轮询间隔从 5s 缩短到 500ms（候选 A）
2. **补充**：保持 `subscribeStepPhase` 订阅机制不变——如果未来 DSH 开放了事件转发能力，事件驱动可以无缝接入

**变更点**：
1. `RunView.tsx` L41: `POLL_INTERVAL_MS = 5000` → 动态间隔（running → 500ms）

**优点**：
- 最小改动（1 个文件，~5 行）
- 可靠性最高
- 保持现有事件驱动架构（step-phase.ts 不变），未来可升级
- 零 DSH 依赖

---

## 3. 推荐方案详细设计

### 推荐方案：候选 A（收尾阶段缩短轮询间隔）

### 3.1 变更：`RunView.tsx` 动态轮询间隔

**文件**: `packages/sandore/ui/src/client/RunView.tsx`  
**位置**: L41 + L121-130

**当前代码**：

```typescript
// L41:
const POLL_INTERVAL_MS = 5000

// L121-130:
const refreshAndSchedule = useCallback(async (): Promise<void> => {
    const status = await refresh()
    if (disposedRef.current || status === undefined || !isRunningStatus(status)) return
    if (timerRef.current === undefined) {
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        void refreshAndSchedule()
      }, POLL_INTERVAL_MS)
    }
  }, [refresh])
```

**修改后**：

```typescript
// L41-42:
/** 轮询间隔：运行中实例（收尾阶段需捕捉中间态）用短间隔，终态后停。 */
const POLL_INTERVAL_RUNNING_MS = 500
const POLL_INTERVAL_IDLE_MS = 5000

// L121-130:
const refreshAndSchedule = useCallback(async (): Promise<void> => {
    const status = await refresh()
    if (disposedRef.current || status === undefined || !isRunningStatus(status)) return
    if (timerRef.current === undefined) {
      // 运行中用短间隔（500ms）捕捉收尾阶段中间态；已无中间态的终态走 isRunningStatus 返回 false 自然停。
      const interval = isRunningStatus(status) ? POLL_INTERVAL_RUNNING_MS : POLL_INTERVAL_IDLE_MS
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        void refreshAndSchedule()
      }, interval)
    }
  }, [refresh])
```

**逻辑说明**：
- `isRunningStatus(status)` 返回 `true` 时（running/interacting），用 500ms 轮询
- 收尾阶段实例状态仍为 `running`（直到 `completed`），所以 500ms 轮询全程覆盖
- 当 `status` 变为 `completed`/`failed`/`aborted` 时，`isRunningStatus` 返回 `false`，轮询自然停止
- `forceRefresh`（事件驱动，L135-139）保持不变——如果未来事件链路打通，可以无缝降级

### 3.2 不需要改的地方

| 文件/位置 | 理由 |
|-----------|------|
| `step-phase.ts` | 订阅机制保持不变，未来可复用 |
| `RunView.tsx` `forceRefresh` / `subscribeStepPhase` | 保持事件驱动入口，未来可升级 |
| `workflow-engine.ts` | 引擎侧事件双发已正确 |
| DSH 源码 | 不改 |

### 3.3 可选增强：`forceRefresh` 防抖保护

当前 `forceRefresh`（L135-139）每次事件都直接 RPC。如果未来事件链路打通，连续的 `commitFinalize` 事件（finalizing → gating → routing → completed，间隔 ~100ms）会触发 4 次 RPC。可选加一个 200ms 防抖：

```typescript
// 可选：防抖 forceRefresh（当前不改，事件链路打通后再加）
const forceRefreshDebounced = useMemo(() => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void forceRefresh()
    }, 200)
  }
}, [forceRefresh])
```

**当前不实施**——因为事件链路本身就不通，防抖无意义。

---

## 4. 测试计划

### 4.1 单元测试：`run-view-model.ts`（现有测试已覆盖 `isRunningStatus`）

无需新增——`isRunningStatus` 的行为已在现有测试中覆盖。

### 4.2 UI 手动验证

1. 启动测试实例（端口 3090）
2. 触发一个含门禁的工作流
3. 观察 RunView 的轮询行为：
   - 运行中：Network 面板应显示 ~500ms 间隔的 `getInstanceState` RPC
   - 终态后：轮询停止
4. 观察 PhaseBadge 是否有更高概率显示中间态：
   - 由于 500ms 轮询，中间态有 ~50-80% 概率被捕捉到
   - 最终态 `completed` 一定可见

### 4.3 对比验证

| 指标 | Round 7（5s 轮询） | Round 8（500ms 轮询） |
|------|-------------------|---------------------|
| 中间态可见概率 | ~0%（收尾阶段 <5s） | ~50-80% |
| RPC 频率（运行中） | 0.2 QPS | 2 QPS |
| 终态延迟 | ≤5s | ≤500ms |
| 代码改动 | 引擎 2 文件 | UI 1 文件 |

---

## 5. 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 500ms 轮询增加 RPC 开销 | 低 | 高 | running 实例通常只有 1 个，2 QPS 可忽略；终态后自动停 |
| 收尾阶段极短中间态（<500ms）仍被漏过 | 低 | 中 | finalizing → gating 间隔 ~100-200ms，500ms 轮询有 ~50% 概率捕捉；最终态一定可见 |
| 用户在多 tab 打开时轮询叠加 | 低 | 低 | 每个 tab 独立轮询，但 running 实例只 1 个，总 QPS = 2 × tab 数 |
| 未来事件链路打通后忘记移除短轮询 | 低 | 低 | 代码注释标注「事件驱动可降级」，`forceRefresh` 入口保留 |

---

## 6. 是否需要 DSH 配合

**不需要**。所有改动都在 sandore 仓库内：

| 涉及 | 文件 | 归属 |
|------|------|------|
| `RunView.tsx` | `packages/sandore/ui/src/client/RunView.tsx` | sandore ✅ |

**DSH 侧的限制说明**（供未来参考）：

| 限制 | 位置 | 影响 |
|------|------|------|
| `session/event` 帧在 session 未实例化时被丢弃 | manager.ts L751-785 | sandore 宿主 session 的 append 事件无法到达 UI |
| `acceptLiveEvent` 在 `openState === 'cold'` 时丢弃事件 | session.ts L693 | 即使 session 已实例化，非 current session 的事件也被丢弃 |
| `sessions.open` 的语义是切换 current（UI 跳转） | service.ts L372-374 | 无法"后台 open" session 来接收事件 |
| `host/remote-event` 白名单不含 sandore 事件 | remote-events.ts L17-29 | `ctx.emit` 事件无法转发到 client |

---

## 7. 变更清单

| 文件 | 类型 | 行号 | 改动描述 |
|------|------|------|----------|
| `packages/sandore/ui/src/client/RunView.tsx` | 修改 | L41 | `POLL_INTERVAL_MS = 5000` → `POLL_INTERVAL_RUNNING_MS = 500` + `POLL_INTERVAL_IDLE_MS = 5000` |
| `packages/sandore/ui/src/client/RunView.tsx` | 修改 | L121-130 | `refreshAndSchedule` 内根据 `isRunningStatus(status)` 选择轮询间隔 |

**总改动量**：1 个文件（~5 行改动）

---

## 附录：未来升级路径

当 DSH 开放以下任一能力时，可升级为事件驱动：

1. **DSH 开放"后台 open"API**（`sessions.openBackground(id)` — 不切 current 但 open session window）→ 宿主 session 可接收事件 → `stepPhaseDefinition` 自动生效
2. **DSH 扩展 `host/remote-event` 白名单**（添加 `sandore/step-phase`）→ `ctx.emit` 事件通过 `ctx.remote.$on` 到达 client → RunView 直接订阅
3. **DSH 支持"未实例化 session 的事件 buffer"**（manager.ts L758-785 扩展 `session/event` 的 buffer 逻辑）→ session 实例化后自动重放

当前方案（500ms 轮询）在这些能力开放前足够可靠。
