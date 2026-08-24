# Round 6：收尾阶段标识显示三问题修复方案

> 日期：2026-08-17  
> 范围：sandore workflow-engine + microflow + UI  
> 目标：修复用户反馈的三个问题——显示不及时、Phase A 缺失、badge 序列错误  
> 约束：**禁止修改业务代码**，仅写方案文档

---

## 一、问题总结

| # | 问题 | 用户原话 | 现象 |
|---|------|---------|------|
| 1 | 显示不及时 | 「等了好久才出现全部标识」 | 阶段标识没有随 state 变化立即出现，等 5s 轮询或全部跑完才一起出现 |
| 2 | Phase A 缺失 | 「还是希望要有个 Phase A 的标识」 | 用户期望 Phase A 有个标识，但 `finalizePhaseKey` 返回 `undefined` |
| 3a | 缺「已门禁」 | 「已门禁（Phase C）应该有」 | Phase C 通过路径不 commitFinalize('gating')，phaseHistory 缺 gating |
| 3b | 多了一个「已完成」 | 「多了一个已完成，应该是已判断」 | PhaseBadge 在 `completed` 态额外 push 一个 `phase-completed` badge，与运行状态 badge 重复 |

---

## 二、根因分析

### 问题 3a：Phase C 通过路径不落 gating

**文件**：`packages/sandore/microflow/src/stage-executor.ts` `runPhaseC`（L1074-1103）

**机制**：`runPhaseC` 只在**门禁失败**时调用 `commitFinalize('gating')`（L1095），门禁**通过**路径直接 `return { kind: 'ok', gateResult }`（L1102），不落 gating。随后 `completeAfterFinalize` 里只有 `commitFinalize('routing')`（L1129）和 `commitFinalize('completed')`（L1147）。

**结果**：`finalizeMeta.phaseHistory` 里没有 `'gating'` → UI `PhaseBadge` 的 `phases.includes('gating')` 为 `false` → 不显示「已门禁」。

```
runPhaseC（L1074-1103）:
  if (!hasEnabledGates(gates)) return { kind: 'ok', gateResult: undefined }  // 跳过
  if (!gateResult.gatesPassed) {
    await commitFinalize(..., 'gating')   // ← 仅失败路径
    return { kind: 'failed', message }
  }
  return { kind: 'ok', gateResult }       // ← 通过路径：无 gating 落盘
```

**代码证据**：
- `packages/sandore/microflow/src/stage-executor.ts` L1083-1102：runPhaseC 方法
- `packages/sandore/microflow/src/stage-executor.ts` L1124-1157：completeAfterFinalize，只有 routing 和 completed
- `packages/sandore/microflow/src/finalize-manager.ts` L594-630：buildFinalizeMeta，phaseHistory 追加逻辑

### 问题 3b：重复「已完成」badge

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` `PhaseBadge`（L276-286）

**机制**：当 `item.finalizePhase === 'completed'` 时，PhaseBadge 额外 push 一个 `{ key: 'phase-completed', labelKey: 'run.step.finalize.phase.completed' }` badge。这个 badge 文案是「已完成」——与 AgentMsg 头部的运行状态 badge（`step.status === 'completed'` → 「已完成」）**重复**。

**用户期望**：正好四个 badge，无多余的「已完成」。

```
// L276-286
const isCompleted = item.finalizePhase === 'completed'
if (isCompleted) {
  badges.push({
    key: 'phase-completed',
    labelKey: 'run.step.finalize.phase.completed',  // ← 「已完成」
    phase: 'completed',
    target: undefined,
    isActive: false,
  })
}
```

**代码证据**：
- `packages/sandore/ui/src/client/UnifiedTimeline.tsx` L224-313：PhaseBadge 函数
- `packages/sandore/ui/src/client/UnifiedTimeline.tsx` L352-364：AgentMsg 中状态按钮 + PhaseBadge 渲染
- `packages/sandore/ui/src/client/locales.ts` L222：`'run.step.finalize.phase.completed': '已完成'`

### 问题 1：事件驱动渲染链路未生效

**核心发现**：`sandore/step-phase` 事件通过 `session.append` 写入 DSH Session 事件流，UI 通过 `conversationEvents.register(stepPhaseDefinition)` 订阅。事件链路是：

1. **引擎侧**（workflow-engine.ts L1987-1990）：`emitStepPhase` → `session.append('sandore/step-phase', {...}, { ignorable: true })`
2. **DSH Session 侧**（session.ts L471-476）：`handleMuxEnvelope` → `case 'session/event'` → `this.acceptLiveEvent(frame.event, frame.view)`
3. **conversation-assembler 侧**（L194-215）：`append` → `matchInput` → 遍历 `eventDefinitions.entries()` → `definition.match(input.event)`
4. **step-phase.ts 定义**（L56-71）：`match` 命中 `sandore/step-phase` → `start` 触发 `notifyStepPhase()`

**链路验证**：
- `step-phaseDefinition.match` 正确匹配 `event.type === 'sandore/step-phase'`（L59）
- `step-phaseDefinition.start` 正确调用 `notifyStepPhase()`（L66）
- `RunView` 正确订阅 `subscribeStepPhase` 并调用 `refreshAndSchedule()`（L149-154）
- `conversationEvents.register(stepPhaseDefinition)` 在 `index.ts` L48 正确注册

**为什么仍然「等好久」**：

经深入分析，事件链路**是完整的**，但存在以下问题：

#### 问题 1a：Phase 事件吞没于 Session 事件流的竞态

DSH 的 `session.append` 是同步操作，事件立即到达客户端 assembler 的 `matchInput`。但 `matchInput` 调用 `notifyStepPhase()` 后，RunView 的 `refreshAndSchedule()` 触发的是 `remote.getInstanceState()` RPC。

**关键竞态**：当多个 `commitFinalize` 在同一个事件循环内同步连续调用时（routing → completed 几乎同步），每个 `commitFinalize` 都触发一次 `session.append` + `notifyStepPhase` + `refreshAndSchedule()`。但 `refreshAndSchedule()` 内部的 RPC 请求可能被 debounce 或排队：

```typescript
// RunView.tsx L149-154
useEffect(() => {
  return subscribeStepPhase(() => {
    if (disposedRef.current) return
    void refreshAndSchedule()  // ← 每次事件触发一次
  })
}, [refreshAndSchedule])
```

`refreshAndSchedule` 的实现（L105-130）：第一次调用立即执行，后续调用在 5s 内 debounce。因此当 routing → completed 在同一次事件循环内连续触发时：
- 第一次（routing）：立即执行 RPC，读到 `currentPhase='routing'`
- 第二次（completed）：被 debounce（5s 内不重复执行），等到下一次轮询才更新

**但用户说的是「等了好久才出现全部」**，而不是「routing 和 completed 一起出现」。这说明 Phase B → Phase C → Phase D → completed 的整个链路都在极短时间内完成，所有事件在用户感知上是「同时到达」的。

#### 问题 1b：Phase B 完成后极短间隔内 Phase C/D/completed 同步完成

Phase B（assessForked）有 AI 调用，耗时数秒。Phase C 门禁 primary 是纯代码，Phase D 路由也是纯代码。因此：

```
t0: commitFinalize('finalizing')  → UI 收到事件，刷新，读到 finalizing ✅
t1: commitFinalize('gating')      → 仅门禁失败时
t2: commitFinalize('routing')     → UI 收到事件，但 t0 刚刷新完，5s 内 debounce
t3: commitFinalize('completed')   → UI 收到事件，同样被 debounce
```

**根本原因**：`refreshAndSchedule` 的 5s debounce 机制导致连续事件只保留第一次，后续被丢弃。UI 读到的是 `t0` 时的 `currentPhase='finalizing'`，直到 5s 轮询到期才读到 `completed`。

**代码证据**：
- `packages/sandore/ui/src/client/RunView.tsx` L105-130：refreshAndSchedule 的 debounce 逻辑
- `packages/sandore/microflow/src/stage-executor.ts` L1128-1147：routing → completed 几乎同步
- `packages/sandore/workflow/src/workflow-engine.ts` L1987-1990：emitStepPhase 双发

#### 问题 1c：conversationEvents 通道是否真的对自定义 session 事件生效

经 DSH 源码验证，`conversationEvents` 通道**确实对自定义 session 事件生效**：

1. `session.append('sandore/step-phase', {...}, { ignorable: true })` 将事件写入 Session 事件流（session.ts L672-681）
2. 事件通过 mux 帧到达客户端 `handleMuxEnvelope`（session.ts L471-476）
3. `acceptLiveEvent` → `appendLive` → `conversation.append({ event, view })`（session.ts L679）
4. assembler 的 `matchInput` 遍历所有注册的 `eventDefinitions`（conversation-assembler.ts L370-375）
5. `stepPhaseDefinition.match` 正确命中 `sandore/step-phase`（step-phase.ts L59）
6. `start` 触发 `notifyStepPhase()`（step-phase.ts L66）

**结论**：conversationEvents 通道完整可用，问题不在事件传递，而在 `refreshAndSchedule` 的 debounce 机制。

---

## 三、修复方案

### 方案 1：事件驱动即时渲染（解决显示不及时）

#### 1.1 修改 refreshAndSchedule 的 debounce 策略

**文件**：`packages/sandore/ui/src/client/RunView.tsx`

**现状**：`refreshAndSchedule` 在首次调用后 5s 内不重复执行（L105-130）。

**方案**：对 `step-phase` 事件触发的刷新取消 debounce 限制，改为立即执行（或缩短 debounce 至 200ms）。

```typescript
// 现有实现（L105-130）
const refreshAndSchedule = useCallback(async () => {
  if (disposedRef.current) return
  await refresh()
  if (timerRef.current !== undefined) clearTimeout(timerRef.current)
  timerRef.current = window.setTimeout(() => {
    if (!disposedRef.current) void refreshAndSchedule()
  }, 5000)
}, [refresh])

// 改为：增加 forceRefresh 版本（不受 5s debounce 限制）
const forceRefresh = useCallback(async () => {
  if (disposedRef.current) return
  await refresh()
  // 不取消现有轮询，只确保本次立即执行
}, [refresh])

// step-phase 订阅使用 forceRefresh
useEffect(() => {
  return subscribeStepPhase(() => {
    if (disposedRef.current) return
    void forceRefresh()  // ← 立即刷新，不受 5s debounce
  })
}, [forceRefresh])
```

**风险**：频繁 RPC 调用（routing → completed 同步触发两次）。但 `getInstanceState` 已改为内存优先（remote.ts L277-278），单次 RPC 是毫秒级，可接受。

#### 1.2 保留 5s 轮询作为兜底

**现状**：`refreshAndSchedule` 的 5s 轮询机制保留。

**方案**：不改。5s 轮询是兜底，确保即使事件链路异常也能最终刷新。

#### 1.3 验证清单

| 验证项 | 方法 |
|-------|------|
| step-phase 事件到达 UI | 在 `notifyStepPhase` 加 `console.log`，观察事件频率 |
| forceRefresh 执行 | 在 `forceRefresh` 加 `console.log`，观察是否在事件后立即触发 |
| RPC 结果时效 | 对比 `commitFinalize('routing')` 和 UI 显示 routing 的时间差 |

---

### 方案 2：Phase A 标识设计

#### 2.1 Phase A 特殊性

Phase A（ask-detect）是临时评估会话，**用完即删**，不持久化到 state。用户现在要求「还是要有个标识」。

#### 2.2 方案：运行时显示「检测中」，完成后显示「已检测」

**设计**：

| 状态 | 文案 | 图标 | 可点击 | 说明 |
|------|------|------|-------|------|
| Phase A 进行中（`currentPhase === 'ask-detect'`） | 「检测中」 | 🔍（放大镜） | 否（无持久化会话） | `finalizeMeta.currentPhase` 为 `ask-detect` 时显示 |
| Phase A 完成（`currentPhase !== 'ask-detect'` 且 `phaseHistory` 含 `ask-detect`） | 「已检测」 | ✓（对勾） | 否 | 历史记录中有 ask-detect 时灰显 |

**代码改动**：

1. **`locales.ts`**：新增翻译键
   ```typescript
   'run.step.finalize.phase.detecting': '检测中',
   'run.step.finalize.phase.detected': '已检测',
   ```

2. **`UnifiedTimeline.tsx` `donePhaseKey`**：新增 ask-detect 分支
   ```typescript
   case 'ask-detect':
     return 'run.step.finalize.phase.detected'  // 已检测
   ```

3. **`UnifiedTimeline.tsx` `PhaseBadge`**：新增 Phase A 渲染
   ```typescript
   // Phase A 状态（在 Phase B 之前）
   const hasAskDetect = phases.includes('ask-detect')
   const isCurrentlyDetecting = item.finalizePhase === 'ask-detect'
   if (hasAskDetect || isCurrentlyDetecting) {
     const done = hasAskDetect && !isCurrentlyDetecting
     badges.push({
       key: 'phase-a',
       labelKey: done ? 'run.step.finalize.phase.detected' : 'run.step.finalize.phase.detecting',
       phase: 'ask-detect',
       target: undefined,  // Phase A 无持久化会话，不可点击
       isActive: isCurrentlyDetecting,
     })
   }
   ```

4. **`UnifiedTimeline.tsx` `finalizePhaseKey`**：返回 Phase A 的文案
   ```typescript
   case 'ask-detect':
     return 'run.step.finalize.phase.detecting'
   ```

#### 2.3 Badge 序列设计

最终 badge 序列（用户期望正好四个）：

| 位置 | Badge | 来源 | 可点击 |
|------|-------|------|-------|
| 0 | 运行状态（已完成/运行中/失败/暂停） | `step.status` | 否（状态按钮） |
| 1 | 已检测/检测中（Phase A） | `phaseHistory` 含 `ask-detect` | 否（无会话） |
| 2 | 已收尾/收尾中（Phase B） | `phaseHistory` 含 `finalizing` | 是（assessSessionId） |
| 3 | 已门禁/门禁中（Phase C） | `phaseHistory` 含 `gating` | 是（gateSessionId） |
| 4 | 已判断/判断中（Phase D） | `phaseHistory` 含 `routing` | 是（routingSessionId） |

**删除**：L276-286 的 `phase-completed` badge（问题 3b）。

---

### 方案 3：修复 badge 序列错误

#### 3.1 Phase C 通过路径补 gating 落盘（问题 3a）

**文件**：`packages/sandore/microflow/src/stage-executor.ts` `runPhaseC`（L1074-1103）

**方案**：在门禁通过路径（`gateResult.gatesPassed === true`）也调用 `commitFinalize('gating')`。

```typescript
// 现有代码（L1089-1102）
if (!gateResult.gatesPassed) {
  // ... 失败路径
  await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating');
  return { kind: 'failed', message };
}
return { kind: 'ok', gateResult };  // ← 通过路径：无 gating

// 改为
if (!gateResult.gatesPassed) {
  // ... 失败路径（不变）
  await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating');
  return { kind: 'failed', message };
}
// ✅ 门禁通过：也落 gating（记录门禁通过事实，UI 显示「已门禁」）
await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating');
return { kind: 'ok', gateResult };
```

**影响**：
- `finalizeMeta.phaseHistory` 会包含 `'gating'` → UI 显示「已门禁」badge
- `finalizeMeta.gateResult` 会记录门禁结果（`gatesPassed: true`）
- `finalizeMeta.gateSessionId` 会记录门禁会话 id（可选，取决于 gateResult 是否有 gateSessionId）

**风险**：低。`commitFinalize` 是幂等的（buildFinalizeMeta 的 phaseHistory 去重相邻相同值），多次调用不会产生副作用。

#### 3.2 删除多余的「已完成」badge（问题 3b）

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` `PhaseBadge`（L276-286）

**方案**：删除 L276-286 的 `phase-completed` badge 渲染。

```typescript
// 删除这段代码（L276-286）
// 全部完成态（currentPhase === 'completed'）
const isCompleted = item.finalizePhase === 'completed'
if (isCompleted) {
  badges.push({
    key: 'phase-completed',
    labelKey: 'run.step.finalize.phase.completed',
    phase: 'completed',
    target: undefined,
    isActive: false,
  })
}
```

**理由**：运行状态 badge（`step.status === 'completed'` → 「已完成」）已表达「全部完成」语义，不需要额外的 `phase-completed` badge。

---

## 四、与 Round 5 的协同关系

### 4.1 两个方案的关系

| 维度 | Round 5（响应式持久化） | Round 6（阶段标识显示） |
|------|----------------------|----------------------|
| 关注点 | state 变化 → 自动写库 | state 变化 → UI 即时渲染 |
| 机制 | Proxy/脏标记/自动 persistState | 事件驱动 + forceRefresh |
| 数据流 | 内存 state → 数据库 | 内存 state → session.append → conversationEvents → UI |

**共同目标**：「state 变化即触发事件」——Round 5 解决「写库」，Round 6 解决「渲染」。

### 4.2 实施顺序建议

**推荐：Round 6 先行，Round 5 后续**

| 顺序 | 方案 | 理由 |
|------|------|------|
| 1 | **Round 6**：Phase C 补 gating + 删除多余 badge + forceRefresh | 修复用户可见的三个问题，改动量小（3 文件），风险低 |
| 2 | **Round 5**：响应式持久化 | 架构性改动（Proxy/脏标记），涉及引擎 + 持久化层，改动量大，需充分测试 |

**理由**：
- Round 6 是「用户可见 bug 修复」，优先级高
- Round 5 是「架构优化」，可在 Round 6 验证通过后再做
- Round 5 的响应式持久化与 Round 6 的事件驱动渲染是正交的，可独立实施

### 4.3 协同点

如果 Round 5 先做响应式持久化，Round 6 的 `forceRefresh` 可以简化：
- Round 5 确保 `commitFinalize` 后 `active.state` 立即更新（内存引用）
- Round 6 的 `forceRefresh` 读 `getInstanceState` 已是内存优先，无需改

如果 Round 6 先做 `forceRefresh`，Round 5 的持久化改动不影响 UI 渲染：
- UI 通过 `session.append` 事件驱动刷新，不依赖数据库状态

---

## 五、测试计划

### 5.1 问题 3a 测试（Phase C 补 gating）

| 测试 | 文件 | 描述 |
|------|------|------|
| `finalize-manager.spec.ts` | 现有 | `commitFinalize` 调用顺序验证（含 gating 通过路径） |
| `stage-executor.spec.ts` | 新增 | `runPhaseC` 门禁通过路径验证：`phaseHistory` 含 `'gating'` |
| `workflow-engine.spec.ts` | 现有 | 收尾四阶段集成测试：验证 `phaseHistory` 内容 |

### 5.2 问题 3b 测试（删除多余 badge）

| 测试 | 文件 | 描述 |
|------|------|------|
| `UnifiedTimeline.spec.tsx` | 新增 | `PhaseBadge` 渲染测试：completed 态不渲染 `phase-completed` |
| `run-view-model.spec.ts` | 现有 | `buildTimeline` 映射测试：`finalizePhaseHistory` 字段 |

### 5.3 问题 1 测试（forceRefresh）

| 测试 | 文件 | 描述 |
|------|------|------|
| 手动测试 | - | 创建实例 → 观察 Phase B → C → D → completed 的 badge 出现时机 |
| E2E | - | 收尾四阶段集成：验证 badge 在每个 commitFinalize 后立即出现 |

### 5.4 问题 2 测试（Phase A 标识）

| 测试 | 文件 | 描述 |
|------|------|------|
| `UnifiedTimeline.spec.tsx` | 新增 | `PhaseBadge` 渲染测试：ask-detect 态显示「检测中」，完成后显示「已检测」 |
| 手动测试 | - | 创建含 ask 的步骤 → 观察「检测中」badge → ask 完成后观察「已检测」 |

---

## 六、风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| Phase C 补 gating 增加 `commitFinalize` 调用频率 | 低 | `buildFinalizeMeta` 的 phaseHistory 已去重相邻相同值，幂等安全 |
| forceRefresh 导致频繁 RPC | 低 | `getInstanceState` 内存优先，单次毫秒级；5s 轮询保留兜底 |
| 删除 `phase-completed` badge 后用户不理解「已完成」语义 | 低 | 运行状态 badge 已表达「全部完成」，注释说明 |
| Phase A 标识增加 UI 复杂度 | 低 | Phase A badge 不可点击（无会话），仅文字展示 |

---

## 七、改动清单

| 文件 | 改动 | 问题 |
|------|------|------|
| `packages/sandore/microflow/src/stage-executor.ts` | `runPhaseC` 门禁通过路径补 `commitFinalize('gating')` | 3a |
| `packages/sandore/ui/src/client/UnifiedTimeline.tsx` | 删除 L276-286 的 `phase-completed` badge | 3b |
| `packages/sandore/ui/src/client/UnifiedTimeline.tsx` | `PhaseBadge` 新增 Phase A 渲染（ask-detect/detecting） | 2 |
| `packages/sandore/ui/src/client/UnifiedTimeline.tsx` | `finalizePhaseKey` 新增 ask-detect 分支 | 2 |
| `packages/sandore/ui/src/client/UnifiedTimeline.tsx` | `donePhaseKey` 新增 ask-detect 分支 | 2 |
| `packages/sandore/ui/src/client/locales.ts` | 新增 `run.step.finalize.phase.detecting` / `run.step.finalize.phase.detected` | 2 |
| `packages/sandore/ui/src/client/RunView.tsx` | 新增 `forceRefresh` 版本（不受 5s debounce 限制） | 1 |

**共 3 个文件，约 30 行代码改动。**

---

## 八、总结

| 问题 | 根因 | 方案 | 复杂度 |
|------|------|------|--------|
| 显示不及时 | `refreshAndSchedule` 的 5s debounce 丢弃连续事件 | `forceRefresh` 不受 debounce 限制 | 低 |
| Phase A 缺失 | `finalizePhaseKey` 返回 `undefined`，PhaseBadge 不渲染 | 新增 Phase A 渲染逻辑 | 低 |
| 缺「已门禁」 | Phase C 通过路径不 `commitFinalize('gating')` | 补 `commitFinalize('gating')` | 低 |
| 多了一个「已完成」 | PhaseBadge 额外 push `phase-completed` | 删除该 badge | 低 |

**实施顺序**：Round 6（本次）→ Round 5（响应式持久化）

---

*文档完成于 2026-08-17，基于 DSH 源码 `D:\project-code\llm\deepseek-harness` 和 sandore 源码 `D:\project-code\llm\sandore` 的代码分析。*
