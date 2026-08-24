# Bugfix 方案：宿主会话对话流 Step 节点缺少收尾阶段 Badge

> **日期**：2026-08-17 (Round 9)
> **范围**：sandore UI 层（对话流 `DagStepNodeView`）+ sandore 数据层（`sandore-step-definition`）
> **约束**：禁止修改 DSH 源码；仅改 sandore 仓库

---

## 1. 根因分析

### 1.1 问题现象

宿主会话对话流中，`sandore-step` 节点标题右侧只显示 `StateDot` + 名称 + 循环标签 + `status` 文本（running/completed/failed/paused），**完全没有收尾阶段 badge**（Phase A 已检测 / Phase B 已收尾 / Phase C 已门禁 / Phase D 已判断 + 各中间态）。

### 1.2 根因定位

**三层断裂**：

| 层 | 问题 | 文件:行号 |
|---|---|---|
| **事件载荷** | `sandore/step-phase` SessionEventMap 载荷只有 `{ stepId, childId, phase, name, loopIteration }`——**没有 `finalizeMeta` 详情**（assessSessionId / gateSessionId / routingSessionId / phaseHistory 等） | `seam.ts:74` |
| **数据折叠** | `sandoreStepDefinition.match` 只匹配 6 个 `step-*` 事件（start/completed/failed/paused/resumed/retried），**不匹配 `sandore/step-phase`**；`SandoreStepState` / `SandoreStepChatData` **完全没有 finalizeMeta 相关字段** | `sandore-step-definition.ts:99-110`（match），`:18-41`（data），`:50-61`（state） |
| **视图渲染** | `DagStepNodeView` header 只渲染 `StateDot` + 名称 + loopLabel + status 文本，**没有阶段 badge 渲染逻辑** | `DagStepNodeView.tsx:127-145` |

**关键发现**：

1. **`stepPhaseDefinition` 是状态-only 定义**（`step-phase.ts:56-71`）：`kind: 'sandore-step-phase'`，无 `target`/`buildViewNode`，只在 `start` 回调里 `notifyStepPhase()` 通知 RunView 刷新——**它不产生任何 Chat 节点，也不更新 sandore-step 节点数据**。

2. **两个 definition 各自独立**：`sandore-step-definition.ts` 和 `step-phase.ts` 分别注册到 `conversationEvents`（`index.ts:45,48`），**互相不感知**。`step-phase` 事件被 `stepPhaseDefinition` 独占 match，`sandoreStepDefinition` 永远不会收到它。

3. **`step-completed` 事件不携带 finalizeMeta**：`seam.ts:68` 定义的载荷是 `{ stepId, childId, output, name, loopIteration }`——无 finalize 相关字段。引擎侧 `workflow-engine.ts:1939` 也是同样载荷。`finalizeMeta` 只存在于引擎内存 state 的 `executedSteps[].finalizeMeta`，通过 `getInstanceState` RPC 才能获取。

4. **`sandore/step-phase` 事件载荷同样不携带 finalizeMeta 详情**：只有 `phase` 字符串和基本信息（`seam.ts:74`），不含 `assessSessionId`/`gateSessionId`/`routingSessionId`/`phaseHistory`。

### 1.3 对比：RunView overlay 为什么能显示阶段 badge

`run-view-model.ts:502-531` 从 `DagInstanceState.executedSteps[].finalizeMeta` 完整投影所有 finalize 字段到 `TimelineStepItem`——这是因为 RunView 通过 `getInstanceState` RPC 获取完整 state（含 finalizeMeta），**不依赖 Session 事件流**。对话流 step 节点走的是 Session 事件折叠路径（conversation assembler），数据源完全不同。

---

## 2. 方案对比

### 方案 X：sandore-step 节点数据扩展 + DagStepNodeView 渲染 badge

**核心思路**：让 `sandore-step-definition` 也消费 `sandore/step-phase` 事件，累计阶段状态到节点数据；`DagStepNodeView` 渲染阶段 badge。

**数据流**：
```
sandore/step-phase 事件
  → sandoreStepDefinition.match 命中（新增 match 条件）
  → sandoreStepDefinition.update 合并阶段数据到 SandoreStepState
  → buildViewNode 投影到 SandoreStepChatData
  → DagStepNodeView 渲染 PhaseBadge
```

**需要改动**：
1. `seam.ts`（SessionEventMap）：`sandore/step-phase` 载荷**扩展**，增加 `finalizeMeta` 详情（assessSessionId / gateSessionId / routingSessionId / phaseHistory）
2. `workflow-engine.ts`（emitStepPhase）：事件 payload 携带扩展字段
3. `sandore-step-definition.ts`：SandoreStepState / SandoreStepChatData 增加 finalize 字段；match 增加 `sandore/step-phase`；update 处理阶段事件
4. `DagStepNodeView.tsx` + `.module.css`：渲染 PhaseBadge（可复用 UnifiedTimeline 的 PhaseBadge 逻辑）

**优点**：
- 事件驱动，即时更新，无轮询
- 数据自洽，节点数据完整
- badge 可点击跳转子代理会话（有 sessionId）

**缺点**：
- 需要改 seam.ts 载荷（跨模块变更）
- 需要改引擎 emitStepPhase（workflow-engine.ts）
- `stepPhaseDefinition` 和 `sandoreStepDefinition` 都会 match `sandore/step-phase`，需确认 conversation assembler 允许多个 definition 匹配同一事件

**风险**：
- ⚠️ 需确认 conversation assembler 的 match 语义：一个事件能否被多个 definition match？如果只能一个，需调整注册策略。

### 方案 Y：DagStepNodeView 组件内拉取 finalizeMeta

**核心思路**：节点渲染时通过注入的 `remote` 调 `getInstanceState` 拉取 finalizeMeta。

**需要改动**：
1. `DagStepNodeView` 注入 `getInstanceState` 方法
2. 组件内 useEffect 调用拉取，缓存结果

**优点**：
- 不改事件载荷和 definition

**缺点**：
- 事件驱动不便，需轮询或事件触发拉取
- 每个节点组件独立拉取，N 个节点 = N 次 RPC
- 中间态延迟（事件到达 → 轮询拉取 → 渲染）

**不推荐**：延迟高、资源浪费。

### 方案 Z：仅显示阶段文本（不可点击）

**核心思路**：`sandore/step-phase` 事件载荷扩展 phaseHistory（不含 sessionId），节点只显示阶段文本标签。

**需要改动**：
1. `seam.ts`：载荷增加 `phaseHistory` 数组（不含 sessionId）
2. `workflow-engine.ts`：emitStepPhase 携带 phaseHistory
3. `sandore-step-definition.ts`：扩展节点数据
4. `DagStepNodeView.tsx`：渲染纯文本标签（不可点击）

**优点**：
- 改动量小
- 风险低

**缺点**：
- badge 不可点击，无法跳转查看阶段子代理会话
- 用户体验不完整

---

## 3. 推荐方案：方案 X（完整版）

**理由**：
1. 对话流 step 节点是用户最常看的 UI，必须完整展示收尾阶段
2. badge 可点击跳转是核心用户体验（查看评估/门禁/路由判断过程）
3. 事件驱动保证即时性，与 RunView overlay 的 5s 轮询形成对比优势

### 3.1 详细改动计划

#### 3.1.1 `seam.ts`（SessionEventMap 扩展）

**文件**：`packages/sandore/workflow/src/seam.ts`

**改动**：`sandore/step-phase` SessionEventMap 载荷扩展：

```typescript
// 当前（L74）：
'sandore/step-phase': { stepId: string; childId: string; phase: FinalizePhase; name: string; loopIteration?: number[] };

// 改为：
'sandore/step-phase': {
  stepId: string;
  childId: string;
  phase: FinalizePhase;
  name: string;
  loopIteration?: number[];
  // 新增：阶段详情（供对话流 step 节点渲染可点击 badge）
  phaseHistory?: FinalizePhase[];
  assessSessionId?: string;
  gateSessionId?: string;
  routingSessionId?: string;
};
```

**同步改动**：Cordis `Events` 声明（L53）也需对齐扩展参数。

#### 3.1.2 `workflow-engine.ts`（emitStepPhase 扩展）

**文件**：`packages/sandore/workflow/src/workflow-engine.ts`

**改动**：`emitStepPhase` 方法（L1987-1989）从 `active.state.executedSteps` 提取 finalizeMeta 详情：

```typescript
private emitStepPhase(session: Session, info: DagRunInfo, stepId: string, childId: string, phase: FinalizePhase, name: string, loopIteration?: number[]): void {
  // 从 active state 提取 finalizeMeta 详情
  const active = this.activeInstances.get(info.taskId)
  const step = active?.state.executedSteps.find(s => s.id === stepId)
  const meta = step?.finalizeMeta

  const extra = {
    ...(meta?.phaseHistory !== undefined ? { phaseHistory: meta.phaseHistory } : {}),
    ...(meta?.assessSessionId !== undefined ? { assessSessionId: meta.assessSessionId } : {}),
    ...(meta?.gateSessionId !== undefined ? { gateSessionId: meta.gateSessionId } : {}),
    ...(meta?.routingSessionId !== undefined ? { routingSessionId: meta.routingSessionId } : {}),
  }

  this.emitContained('sandore/step-phase', [info, stepId, childId, phase, name, ...(loopIteration === undefined ? [] : [loopIteration])])
  this.safeAppend(() => (session.append as SessionAppendWithIgnorable)(
    'sandore/step-phase',
    { stepId, childId, phase, name, ...(loopIteration === undefined ? {} : { loopIteration }), ...extra },
    { ignorable: true }
  ))
}
```

**关键**：根据 `finalize-manager.ts` 的 `commitFinalize` 时序（L1163-1170），`finalizeMeta` 在 `onPhaseChange` 回调前已写入 `active.state`（L1170 注释），所以 `emitStepPhase` 执行时 `active.state` 已含最新 finalizeMeta。

#### 3.1.3 `sandore-step-definition.ts`（数据模型扩展）

**文件**：`packages/sandore/ui/src/client/sandore-step-definition.ts`

**改动 1**：`SandoreStepChatData` 增加 finalize 字段：

```typescript
export interface SandoreStepChatData {
  // ... 现有字段 ...
  // 新增：收尾阶段信息
  /** 当前收尾阶段（ask-detect/finalizing/gating/routing/completed）。 */
  readonly finalizePhase?: string
  /** 收尾阶段流转历史（phaseHistory）。 */
  readonly finalizePhaseHistory?: readonly string[]
  /** Phase B 收尾评估 fork 会话 id（可点击打开）。 */
  readonly finalizeAssessSessionId?: string
  /** Phase C 门禁 fork 会话 id（可点击打开）。 */
  readonly finalizeGateSessionId?: string
  /** Phase D 路由判断 fork 会话 id（可点击打开）。 */
  readonly finalizeRoutingSessionId?: string
}
```

**改动 2**：`SandoreStepState` 增加对应字段：

```typescript
interface SandoreStepState {
  // ... 现有字段 ...
  readonly finalizePhase?: string
  readonly finalizePhaseHistory?: readonly string[]
  readonly finalizeAssessSessionId?: string
  readonly finalizeGateSessionId?: string
  readonly finalizeRoutingSessionId?: string
}
```

**改动 3**：`match` 增加 `sandore/step-phase` 匹配：

```typescript
match: (event) => {
  if (event.type === 'sandore/step-start') {
    return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'start' }
  }
  if (event.type === 'sandore/step-completed'
    || event.type === 'sandore/step-failed'
    || event.type === 'sandore/step-paused'
    || event.type === 'sandore/step-resumed'
    || event.type === 'sandore/step-retried') {
    return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'update' }
  }
  // 新增：匹配 step-phase 事件，更新阶段数据
  if (event.type === 'sandore/step-phase') {
    return { id: nodeIdOf(event.data.stepId, event.data.loopIteration), role: 'update' }
  }
  return null
},
```

**改动 4**：`update` 增加 `sandore/step-phase` 分支：

```typescript
update: (context, match) => {
  switch (match.event.type) {
    // ... 现有 case ...
    case 'sandore/step-phase': {
      const data = match.event.data
      return {
        ...context.state,
        finalizePhase: data.phase,
        ...(data.phaseHistory !== undefined ? { finalizePhaseHistory: data.phaseHistory } : {}),
        ...(data.assessSessionId !== undefined ? { finalizeAssessSessionId: data.assessSessionId } : {}),
        ...(data.gateSessionId !== undefined ? { finalizeGateSessionId: data.gateSessionId } : {}),
        ...(data.routingSessionId !== undefined ? { finalizeRoutingSessionId: data.routingSessionId } : {}),
      }
    }
    default:
      return context.state
  }
},
```

**改动 5**：`buildViewNode` 投影新增字段：

```typescript
buildViewNode: (context): ChatConversationViewNode | null => {
  // ... 现有逻辑 ...
  return {
    // ... 现有字段 ...
    data: {
      // ... 现有字段 ...
      // 新增：finalize 字段
      ...(state.finalizePhase === undefined ? {} : { finalizePhase: state.finalizePhase }),
      ...(state.finalizePhaseHistory === undefined ? {} : { finalizePhaseHistory: state.finalizePhaseHistory }),
      ...(state.finalizeAssessSessionId === undefined ? {} : { finalizeAssessSessionId: state.finalizeAssessSessionId }),
      ...(state.finalizeGateSessionId === undefined ? {} : { finalizeGateSessionId: state.finalizeGateSessionId }),
      ...(state.finalizeRoutingSessionId === undefined ? {} : { finalizeRoutingSessionId: state.finalizeRoutingSessionId }),
    },
  }
},
```

#### 3.1.4 `DagStepNodeView.tsx`（渲染 PhaseBadge）

**文件**：`packages/sandore/ui/src/client/DagStepNodeView.tsx`

**改动**：header 区域在 `loopLabel` 和 `status` 之间插入 PhaseBadge 序列。

从 `UnifiedTimeline.tsx` 的 `PhaseBadge` 组件（L227-321）提取核心逻辑，适配为 `DagStepNodeView` 内联组件或独立工具函数。

```tsx
// header 结构改为：
<header className={css.header} data-step-status={data.status}>
  <StateDot state={dotState(data.status)} />
  {navigable ? (
    <button ...>{data.name}</button>
  ) : (
    <span className={css.nameStatic}>{data.name}</span>
  )}
  {data.loopLabel !== undefined && <span className={css.loopLabel}>{data.loopLabel}</span>}
  {/* 新增：收尾阶段 badge 序列 */}
  <StepPhaseBadges data={data} t={t} openSession={openSession} />
  <span className={css.status}>{t(STATUS_KEYS[data.status])}</span>
</header>
```

`StepPhaseBadges` 组件复用 `UnifiedTimeline.tsx` PhaseBadge 的逻辑（phaseHistory → badges 数组 → 渲染），但数据源从 `TimelineStepItem` 改为 `SandoreStepChatData`。

#### 3.1.5 `DagStepNodeView.module.css`（样式）

**文件**：`packages/sandore/ui/src/client/DagStepNodeView.module.css`

**新增**：PhaseBadge 相关样式（从 `UnifiedTimeline.module.css` 复制或提取公共样式）。

#### 3.1.6 `locales.ts`（复用现有翻译键）

**无需改动**：PhaseBadge 使用的翻译键（`run.step.finalize.phase.*`）已在 `locales.ts:215-224, 611-620` 定义。

### 3.2 关键风险与应对

#### 风险 1：conversation assembler 多 definition match ✅ 已确认安全

**结论**：conversation assembler 允许多个 definition 独立 match 同一事件（L370 遍历所有 definition，不同 kind 产生独立 context）。`stepPhaseDefinition`（kind `sandore-step-phase`）和 `sandoreStepDefinition`（kind `sandore-step`）各自 match `sandore/step-phase` 不冲突。无需调整。

#### 风险 2：事件载荷扩展的向后兼容

**问题**：已有实例的 Session 中，历史 `sandore/step-phase` 事件不含新字段。

**应对**：`SandoreStepState` 新字段全部 optional，`update` 中用 `=== undefined` 判断后省略——历史事件不会崩溃，只是不显示 badge（与当前行为一致）。

#### 风险 3：`step-phase` 事件早于 `step-start`

**问题**：理论上 `step-phase`（ask-detect）可能在 `step-start` 之前到达（极罕见场景）。

**应对**：`sandoreStepDefinition.update` 在 `context.state` 为 undefined 时需防御（conversation assembler 保证 start 先于 update，但需确认）。

### 3.3 不需要 DSH 配合的点

- ✅ SessionEventMap 声明合并（`declare module`）——sandore 自己的 seam.ts
- ✅ conversationEvents.register / match / update / buildViewNode——sandore 自己的 definition
- ✅ DagStepNodeView 渲染——sandore 自己的 UI 组件
- ✅ emitStepPhase 载荷扩展——sandore 自己的 workflow-engine

**潜在 DSH 依赖**：如果 conversation assembler 不允许多个 definition match 同一事件，需要确认 DSH 行为。但这属于调查确认，不是修改 DSH。

---

## 4. 测试计划

### 4.1 单元测试

| 测试文件 | 测试用例 |
|---|---|
| `sandore-step-definition.spec.ts` | ① `match` 命中 `sandore/step-phase` 返回正确 id/role |
| | ② `update` 合并 `sandore/step-phase` 载荷到 state（含 phaseHistory/sessionId） |
| | ③ `update` 处理历史事件（无新字段）不崩溃 |
| | ④ `buildViewNode` 投影 finalize 字段到 data |
| `workflow-engine.spec.ts` | ⑤ `emitStepPhase` 发出的 Session 事件含扩展字段（assessSessionId 等） |
| | ⑥ 事件发出时 `active.state` 已含最新 finalizeMeta（现有测试 L2799 强化） |

### 4.2 集成测试

| 场景 | 验证点 |
|---|---|
| 工作流执行 → Step 收尾 → 对话流 step 节点 | 标题右侧依次出现「已检测」「已收尾」「已门禁」「已判断」badge |
| 收尾中间态（Phase B 进行中） | badge 显示「收尾中」样式（活跃态） |
| badge 点击 | 跳转对应子代理会话（assessSessionId/gateSessionId/routingSessionId） |
| Phase A badge | 不可点击（无持久化会话） |
| 门禁失败 | Phase C badge 显示「已门禁」+ step status 变为 failed |

### 4.3 回归测试

| 场景 | 验证点 |
|---|---|
| RunView overlay 阶段 badge | 不受影响（数据源不变：getInstanceState → finalizeMeta） |
| 无收尾阶段的 step（shell 步骤） | 不显示任何 badge（finalizePhase 为 undefined） |
| 循环迭代 step | badge 与 loopLabel 共存，phaseHistory 按 stepId+loopIteration 累计 |

---

## 5. 改动文件清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `packages/sandore/workflow/src/seam.ts` | 修改 | SessionEventMap + Events 声明扩展 |
| `packages/sandore/workflow/src/workflow-engine.ts` | 修改 | emitStepPhase 载荷扩展 |
| `packages/sandore/ui/src/client/sandore-step-definition.ts` | 修改 | 数据模型 + match + update + buildViewNode |
| `packages/sandore/ui/src/client/DagStepNodeView.tsx` | 修改 | 新增 StepPhaseBadges 渲染 |
| `packages/sandore/ui/src/client/DagStepNodeView.module.css` | 修改 | 新增 phase badge 样式 |
| `packages/sandore/ui/src/client/sandore-step-definition.spec.ts` | 修改 | 新增测试用例 |
| `packages/sandore/workflow/src/workflow-engine.spec.ts` | 修改 | 强化 emitStepPhase 测试 |

---

## 6. 实施优先级

1. **P0**：`seam.ts` 载荷扩展（其他改动依赖此）
2. **P0**：`workflow-engine.ts` emitStepPhase 扩展
3. **P0**：`sandore-step-definition.ts` 数据模型 + 折叠逻辑
4. **P0**：`DagStepNodeView.tsx` 渲染 PhaseBadge
5. **P1**：`DagStepNodeView.module.css` 样式
6. **P1**：单元测试补充
7. **P2**：集成测试验证

---

## 7. 附录：conversation assembler 多 definition match 行为（已确认 ✅）

**结论**：conversation assembler **允许多个 definition 独立 match 同一事件**。

**证据**（DSH 源码 `conversation-assembler.ts`）：
- L370: `for (const definition of this.eventDefinitions.entries())` — 遍历**所有**注册 definition
- L371: 每个 definition 独立调用 `definition.match(input.event)`
- L393: context key = `conversationContextKey(definition.kind, id)` — 不同 kind 产生不同 context
- L395-396: "received more than one start Match" 只在**同一 context**（同 kind + 同 id）收到两次 start 时抛出

**结论**：`stepPhaseDefinition`（kind `sandore-step-phase`）和 `sandoreStepDefinition`（kind `sandore-step`）各自 match `sandore/step-phase` 事件时，会创建**独立的 context**，互不冲突。方案 X 直接可行，无需调整。
