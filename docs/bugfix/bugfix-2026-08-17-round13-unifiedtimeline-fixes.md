# Bugfix Round 13：UnifiedTimeline 3 个 UI 问题修复方案

> 日期：2026-08-17
> 状态：方案文档（只读分析 + 修复设计，**禁止修改业务代码**）
> 影响文件：
> - `packages/sandore/ui/src/client/UnifiedTimeline.tsx`（主修复）
> - `packages/sandore/ui/src/client/timeline.module.css`（样式补充）
> - `packages/sandore/ui/src/client/run-view-model.ts`（公共函数导出）
> - `packages/sandore/ui/src/client/run-view-model.spec.ts`（新增测试）

---

## 1. 问题 1：PhaseBadge done 判断失效

### 1.1 根因分析

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx`
**位置**：`PhaseBadge` 组件，L251-291

**旧逻辑**（Phase B 为例，L255）：
```ts
const done = hasFinalizing && !isCurrentlyFinalizing && phases.indexOf('completed') > phases.indexOf('finalizing')
```

**机制**：`done` 依赖 `phaseHistory` 数组中同时包含 `'finalizing'` 和 `'completed'`，且 `'completed'` 的索引 > `'finalizing'` 的索引。这意味着：

1. **Phase C/D 失败时 `phaseHistory` 不含 `'completed'`**：如果 Step 在 gating 阶段失败（门禁不通过），`finalizePhase` 停在 `'gating'`，`phaseHistory` 可能为 `['ask-detect', 'finalizing', 'gating']`——**不含 `'completed'`**。此时 `phases.indexOf('completed')` 返回 `-1`，条件永远为 `false`，**Phase B 的 badge 会显示「收尾中」而非「已收尾」**。
2. **PhaseHistory 事件丢失**：如果中间阶段的 phaseHistory 事件因网络/轮询丢失，`phases` 数组可能不完整，导致 done 判断不准。
3. **Phase D（routing）同理**：L283 的 `phases.indexOf('completed') > phases.indexOf('routing')` 有同样问题。

**Phase A（L241）**：`done = hasAskDetect && !isCurrentlyDetecting`——不依赖 `'completed'`，语义正确但可统一为 `isPhaseDone`。

**对比 DagStepNodeView（round10 已修复）**：
```ts
// DagStepNodeView.tsx L78-90
const PHASE_ORDER = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed'] as const
function isPhaseDone(phase: string, currentPhase: string | undefined): boolean {
  if (currentPhase === undefined) return false
  const phaseIdx = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number])
  const currentIdx = PHASE_ORDER.indexOf(currentPhase as (typeof PHASE_ORDER)[number])
  return phaseIdx >= 0 && currentIdx >= 0 && currentIdx > phaseIdx
}
```

核心区别：`isPhaseDone` 比较 `finalizePhase`（当前阶段）与目标阶段的**序号关系**，不依赖 `phaseHistory` 是否包含 `'completed'`。只要 `currentPhase` 已推进到目标阶段之后（如 `currentPhase='gating'` > `'finalizing'`），该阶段即判定为 done。

### 1.2 修复方案

#### 方案 A（推荐）：复制 isPhaseDone 到 UnifiedTimeline.tsx，注明来源

**理由**：
- DagStepNodeView 和 UnifiedTimeline 是独立组件，运行在不同 Slot 中
- 抽公共函数到 `run-view-model.ts` 会增加模块耦合，且 `isPhaseDone` 是纯 UI 展示逻辑（非数据转换）
- DagStepNodeView 已经在 round10 注释了「复制自 UnifiedTimeline PhaseIcon」——本次反过来复制，保持对称
- 最小改动原则：不改公共模块，不影响其他消费者

**改动**：`UnifiedTimeline.tsx`

1. **在 L220 之前（`donePhaseKey` 之后、`PhaseBadge` 之前）添加 `PHASE_ORDER` 和 `isPhaseDone`**：

```ts
// ── Round 13：阶段完成判断（复制自 DagStepNodeView.tsx round10 实现，基于 finalizePhase 序号） ──

/** 收尾阶段顺序（与引擎 FinalizePhase 对齐）。 */
const PHASE_ORDER = ['ask-detect', 'finalizing', 'gating', 'routing', 'completed'] as const

/**
 * 判断 `phase` 是否已完成：当 `currentPhase` 的序号 > `phase` 的序号时，
 * 说明已经推进到该阶段之后（无论事件是否丢失）。
 */
function isPhaseDone(phase: string, currentPhase: string | undefined): boolean {
  if (currentPhase === undefined) return false
  const phaseIdx = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number])
  const currentIdx = PHASE_ORDER.indexOf(currentPhase as (typeof PHASE_ORDER)[number])
  return phaseIdx >= 0 && currentIdx >= 0 && currentIdx > phaseIdx
}
```

2. **替换 PhaseBadge 中 4 处 done 判断**：

| 行号 | 旧代码 | 新代码 |
|------|--------|--------|
| L241 | `const done = hasAskDetect && !isCurrentlyDetecting` | `const done = hasAskDetect && !isCurrentlyDetecting && isPhaseDone('ask-detect', item.finalizePhase)` |
| L255 | `const done = hasFinalizing && !isCurrentlyFinalizing && phases.indexOf('completed') > phases.indexOf('finalizing')` | `const done = hasFinalizing && !isCurrentlyFinalizing && isPhaseDone('finalizing', item.finalizePhase)` |
| L269 | `const done = hasGating && !isCurrentlyGating && phases.indexOf('completed') > phases.indexOf('gating')` | `const done = hasGating && !isCurrentlyGating && isPhaseDone('gating', item.finalizePhase)` |
| L283 | `const done = hasRouting && !isCurrentlyRouting && phases.indexOf('completed') > phases.indexOf('routing')` | `const done = hasRouting && !isCurrentlyRouting && isPhaseDone('routing', item.finalizePhase)` |

3. **更新 PhaseBadge 组件注释**（L221-226）：注明 round13 修复。

#### 方案 B（备选）：抽公共函数到 run-view-model.ts

将 `PHASE_ORDER` 和 `isPhaseDone` 导出到 `run-view-model.ts`，DagStepNodeView 和 UnifiedTimeline 都从公共模块导入。需要同时改 DagStepNodeView 的导入路径。

**不推荐原因**：DagStepNodeView round10 已稳定运行，改动会引入回归风险。

---

## 2. 问题 2：失败/已完成样式不对齐

### 2.1 根因分析

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` + `timeline.module.css`

**现状**：

| 状态 | 容器 | 样式类 | 视觉 |
|------|------|--------|------|
| completed | `div.css.md` | `.md` | 无背景框，直接平铺 Markdown 文本 |
| failed（errorDetail） | `div.css.errorBlock` > `span.css.errorText` | `.errorBlock` + `.errorText` | 红色背景 + 红色边框 + 红色文字（L232-251） |
| failed（消息列表） | `div.css.agentLastList` > `div.css.agentLastScroll` | `.agentLastList` + `.agentLastScroll` | 无背景框，直接平铺 ChatLineRow |

**对比 DagStepNodeView（round10 已修复）**：

| 状态 | 样式类 | 视觉 |
|------|--------|------|
| completed | `.contentCardDone`（`composes: .contentCard`） | 浅色卡片 + `var(--sd-success)` 绿色边框 |
| failed（error） | `.contentCardError`（`composes: .contentCard`） | 浅色卡片 + 红色边框 + mono 字体 + pre-wrap |
| failed（compressedOutput） | `.contentCardDone` | 同 completed 卡片 |

**差异**：
1. UnifiedTimeline 的 `.md` 无边框无背景——与 badge 的胶囊风格脱节
2. UnifiedTimeline 的 `.errorBlock` 是旧式红底红字——与 badge 的 `phaseDone` 绿色 / `phaseActive` 蓝色色系不对齐
3. DagStepNodeView 使用统一的 `.contentCard` 基础类 + 状态变体，视觉一致

### 2.2 修复方案

#### 2.2.1 timeline.module.css 新增内容卡片样式

在 `timeline.module.css` 末尾（L431 之后）添加：

```css
/* ── Round 13：统一内容卡片（与 badge 颜色体系对齐，复制自 DagStepNodeView.module.css） ── */

.contentCard {
  margin-left: 32px;
  margin-right: 32px;
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid var(--sd-border);
  border-radius: 8px;
  background: var(--sd-surface);
  font-size: 14px;
  line-height: 1.625;
  overflow-wrap: anywhere;
}

/* 已完成态内容卡片（与 phaseDone 同色系） */
.contentCardDone {
  composes: contentCard;
  border-color: color-mix(in srgb, var(--sd-success) 40%, transparent);
  color: var(--sd-foreground);
}

/* 失败态内容卡片（与 phaseDone error 色系对齐） */
.contentCardError {
  composes: contentCard;
  border-color: color-mix(in srgb, var(--sd-destructive) 40%, transparent);
  color: var(--sd-destructive);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
}

/* 已完成态内容卡片内的 Markdown 渲染（继承 .md 的排版规则） */
.contentCardDone .md {
  margin-left: 0;
  margin-right: 0;
  margin-top: 0;
}
```

**说明**：
- 使用 `var(--sd-*)` CSS 变量（UnifiedTimeline 用 `--sd-*`，DagStepNodeView 用 `--dsw-alias-*`）保持一致
- `.contentCard` 左右 margin 32px 对齐 `.md` / `.errorBlock` 的缩进
- `.contentCardDone` 边框用 `color-mix` 柔化，不刺眼——与 `.phaseDone` 的 `var(--sd-success)` 色系呼应但更淡
- `.contentCardError` 同理用 `--sd-destructive` 柔化版

#### 2.2.2 UnifiedTimeline.tsx 替换容器类

**completed 分支**（L377-385）：

```tsx
// 旧：div.css.md
// 新：div.css.contentCardDone > div.css.md（内部保留 .md 排版）
```

改为：
```tsx
{item.status === 'completed' && (
  item.finalizeAssessResult?.compressedOutput !== undefined
    ? <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div></div>
    : item.finalizeAssessResult?.assessmentRaw !== undefined
      ? <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.finalizeAssessResult.assessmentRaw} /></div></div>
      : item.outputText !== undefined && <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.outputText} /></div></div>
)}
```

**failed 分支**（L412-428）——与问题 3 一起修改，见下节。

---

## 3. 问题 3：failed 分支内容展示规则

### 3.1 根因分析

**文件**：`packages/sandore/ui/src/client/UnifiedTimeline.tsx`，L412-428

**现状**：
```tsx
{item.status === 'failed' && (
  <>
    {(item.finalizeErrorDetail ?? item.error) && (
      <div className={css.errorBlock}>
        <span className={css.errorText}>{item.finalizeErrorDetail ?? item.error}</span>
      </div>
    )}
    {item.messages !== undefined && item.messages.length > 0 && (
      <div className={css.agentLastList}>
        <div className={css.agentLastScroll}>
          {item.messages.slice(-10).map((line, index) => (
            <ChatLineRow key={index} line={line} />
          ))}
        </div>
      </div>
    )}
  </>
)}
```

**问题**：
1. **展示了滚动消息列表**（`agentLastList`）——用户不要滚动消息，要 `errorDetail + compressedOutput`
2. **没有展示 compressedOutput**——failed 场景下 Phase B 可能已完成（如门禁失败），`finalizeAssessResult.compressedOutput` 已生成但未展示

### 3.2 数据可用性分析（run-view-model.ts L507-514）

```ts
finalizeAssessResult: step.finalizeMeta?.assessResult !== undefined
  ? {
      assessmentRaw: step.finalizeMeta.assessResult.assessmentRaw,
      ...(step.finalizeMeta.assessResult.compressedOutput !== undefined
        ? { compressedOutput: step.finalizeMeta.assessResult.compressedOutput }
        : {}),
    }
  : undefined,
```

**结论**：
- `finalizeAssessResult` 仅在 `finalizeMeta.assessResult` 存在时才有值
- `compressedOutput` 是 `assessResult` 的可选字段（Phase B 生成）
- **门禁失败场景**：Phase B 已跑完（`assessResult` 存在，可能有 `compressedOutput`），Phase C 失败 → `step.status='failed'`，此时 `finalizeAssessResult?.compressedOutput` **有值可用**
- **Phase B 之前失败场景**（如 running 阶段 agent 报错）：无 `assessResult`，`finalizeAssessResult` 为 `undefined`，无 `compressedOutput`
- **结论**：`compressedOutput` 在部分 failed 场景存在，需做可选判断

### 3.3 用户要求的展示规则

```
failed 状态 = errorDetail + compressedOutput（若有）
  - 有 compressedOutput：errorDetail 卡片 + compressedOutput 卡片
  - 无 compressedOutput：仅 errorDetail 卡片（不展示滚动消息）
```

**关键**：**不展示 `item.messages` 滚动消息列表**（L419-428 的 `agentLastList` 整体移除）。

### 3.4 修复方案

**UnifiedTimeline.tsx L412-428 替换为**：

```tsx
{item.status === 'failed' && (
  <>
    {/* errorDetail 卡片 */}
    {(item.finalizeErrorDetail ?? item.error) && (
      <div className={css.contentCardError}>{item.finalizeErrorDetail ?? item.error}</div>
    )}
    {/* compressedOutput 卡片（Phase B 已完成时有值） */}
    {item.finalizeAssessResult?.compressedOutput !== undefined && (
      <div className={css.contentCardDone}>
        <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
      </div>
    )}
  </>
)}
```

**变化**：
1. 移除 `.errorBlock` > `.errorText` 两层嵌套，改为单层 `.contentCardError`（与 DagStepNodeView 对齐）
2. 移除 `.agentLastList` 滚动消息列表（L419-428 整体删除）
3. 新增 `compressedOutput` 卡片（与 completed 分支相同优先级）

### 3.5 completed 分支确认

**现状**（L377-385）已完成 compressedOutput 优先逻辑：
```tsx
item.finalizeAssessResult?.compressedOutput !== undefined
  ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
  : item.finalizeAssessResult?.assessmentRaw !== undefined
    ? <div className={css.md}><MarkdownText text={item.finalizeAssessResult.assessmentRaw} /></div>
    : item.outputText !== undefined && <div className={css.md}><MarkdownText text={item.outputText} /></div>
```

**符合用户要求**：收尾完成后显示 `compressedOutput`。

**但需增加阶段判断**（对齐 DagStepNodeView 的逻辑）：

用户要求更精细的规则：
- step 完成 → 收尾中（`finalizePhase` 未过 `finalizing`）：显示 **output**
- 收尾完成后：显示 **compressedOutput**

**现状问题**：completed 分支只看 `compressedOutput` 是否存在，不看 `finalizePhase`。如果 `assessResult` 提前生成但 `finalizePhase` 还在 `'finalizing'`（理论上不太可能，但防御性设计），会错误显示 `compressedOutput`。

**建议修改**：completed 分支增加 `isPhaseDone('finalizing', ...)` 守卫：

```tsx
{item.status === 'completed' && (
  <>
    {/* 收尾完成前：显示原始 output */}
    {!isPhaseDone('finalizing', item.finalizePhase) && item.outputText !== undefined && (
      <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.outputText} /></div></div>
    )}
    {/* 收尾完成后：显示 compressedOutput */}
    {isPhaseDone('finalizing', item.finalizePhase) && item.finalizeAssessResult?.compressedOutput !== undefined && (
      <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div></div>
    )}
    {/* 兜底：收尾已完成但无 compressedOutput 时仍显示 output */}
    {isPhaseDone('finalizing', item.finalizePhase) && item.finalizeAssessResult?.compressedOutput === undefined && item.outputText !== undefined && (
      <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.outputText} /></div></div>
    )}
  </>
)}
```

---

## 4. 完整改动清单

### 4.1 `UnifiedTimeline.tsx`（6 处改动）

| # | 位置 | 改动 | 类型 |
|---|------|------|------|
| 1 | L220 之前 | 新增 `PHASE_ORDER` + `isPhaseDone` 函数（复制自 DagStepNodeView） | 新增 |
| 2 | L241 | Phase A done 判断加 `isPhaseDone('ask-detect', item.finalizePhase)` | 修改 |
| 3 | L255 | Phase B done 判断改用 `isPhaseDone('finalizing', item.finalizePhase)` | 修改 |
| 4 | L269 | Phase C done 判断改用 `isPhaseDone('gating', item.finalizePhase)` | 修改 |
| 5 | L283 | Phase D done 判断改用 `isPhaseDone('routing', item.finalizePhase)` | 修改 |
| 6 | L377-385 | completed 分支改为 `contentCardDone` 卡片 + `isPhaseDone` 守卫 | 修改 |
| 7 | L412-428 | failed 分支改为 `contentCardError` + `compressedOutput`，移除 `agentLastList` | 修改 |

### 4.2 `timeline.module.css`（1 处改动）

| # | 位置 | 改动 | 类型 |
|---|------|------|------|
| 1 | L431 末尾 | 新增 `.contentCard` / `.contentCardDone` / `.contentCardError` | 新增 |

### 4.3 `run-view-model.ts`（无改动）

公共数据层无需改动。`finalizeAssessResult` 已正确映射 `compressedOutput`。

### 4.4 `run-view-model.spec.ts`（建议新增测试）

```ts
describe('isPhaseDone', () => {
  // 若 isPhaseDone 抽到公共模块，此处测试；否则在组件级别验证。
})
```

**注意**：`isPhaseDone` 是 UnifiedTimeline 内部函数，无法直接从 spec 文件导入。测试方案：
- **方案 A**：在 UnifiedTimeline 组件测试中覆盖（需 React 测试环境）
- **方案 B**：将 `isPhaseDone` 导出到 `run-view-model.ts`（与方案 1B 一致，需权衡）

**建议**：不单独为此抽公共模块，依赖集成测试验证。

---

## 5. 测试计划

### 5.1 手动测试矩阵

| 场景 | PhaseBadge 预期 | 内容区预期 |
|------|----------------|-----------|
| running（无收尾） | 无 badge | 无内容 |
| completed（收尾完成，有 compressedOutput） | Phase B「已收尾」绿色 | `contentCardDone` + compressedOutput |
| completed（收尾完成，无 compressedOutput） | Phase B「已收尾」绿色 | `contentCardDone` + output |
| completed（收尾中，Phase B 进行中） | Phase B「收尾中」蓝色 | `contentCardDone` + output |
| failed（门禁失败，Phase B 已完成） | Phase B「已收尾」绿色 + Phase C「已门禁」绿色 | `contentCardError` + errorDetail + `contentCardDone` + compressedOutput |
| failed（Phase B 之前失败） | 无 Phase B badge | `contentCardError` + errorDetail（无 compressedOutput） |
| failed（门禁失败，Phase B 进行中） | Phase B「收尾中」蓝色 | `contentCardError` + errorDetail（无 compressedOutput） |

### 5.2 边界 case

1. **`phaseHistory` 缺失**：`finalizePhaseHistory` 为 `undefined` → `phases=[]` → 无 badge 渲染（正确）
2. **`finalizePhase` 为 `undefined`**：`isPhaseDone` 返回 `false` → 不显示「已收尾」（正确）
3. **`compressedOutput` 为空字符串**：`!== undefined` 为 `true`，会渲染空卡片——建议改为 `!== undefined && compressedOutput !== ''`（防御性）

---

## 6. 风险评估

### 6.1 风险点

| 风险 | 级别 | 缓解 |
|------|------|------|
| `.contentCardDone` 内嵌 `.md` 双层 margin 叠加 | 低 | `.contentCardDone .md` 覆盖 margin 为 0 |
| `isPhaseDone` 行为与 DagStepNodeView 不一致 | 极低 | 代码完全相同（复制），逻辑确定性 |
| 移除 `agentLastList` 后 failed 无消息上下文 | 中 | 用户明确要求「不要滚动消息」；如需上下文可从 `compressedOutput` 获取 |
| `.contentCard` 在暗色主题下的对比度 | 低 | 使用 `var(--sd-*)` 变量，由 DSH 主题系统保证 |

### 6.2 不需要 DSH 配合

所有改动在 sandore 包内完成：
- `UnifiedTimeline.tsx`：sandore 客户端 UI 组件
- `timeline.module.css`：sandore 样式模块
- 不改 DSH 任何代码、配置或主题变量

### 6.3 回滚方案

本次改动为纯前端 UI 层，回滚只需 `git revert` 对应 commit。

---

## 7. 参考

- DagStepNodeView round10 修复：`packages/sandore/ui/src/client/DagStepNodeView.tsx` L76-90
- DagStepNodeView 内容卡片样式：`packages/sandore/ui/src/client/DagStepNodeView.module.css` L264-291
- TimelineStepItem 数据结构：`packages/sandore/ui/src/client/run-view-model.ts` L211-257
- buildTimeline 字段映射：`packages/sandore/ui/src/client/run-view-model.ts` L492-538
- UnifiedTimeline 现状：`packages/sandore/ui/src/client/UnifiedTimeline.tsx` L227-321（PhaseBadge）、L377-428（内容区）
