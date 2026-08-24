# Bugfix Round 14：UnifiedTimeline failed/completed 内容样式对齐「运行中消息渲染」

> **日期**：2026-08-17  
> **轮次**：Round 14（续 Round 13）  
> **反馈原文**：「不对！我说的失败/已完成样式是要和运行中下面的消息渲染用一个！但是errorDetail的样式不变」

---

## 1. 问题描述

Round 13 将 UnifiedTimeline 的 completed/failed 内容区改为「统一内容卡片」（`.contentCardDone` / `.contentCardError`），视觉上是**带边框+背景的卡片**。但用户要求：

1. **failed/completed 的内容渲染样式** = 运行中下面的消息渲染样式（**简洁对话流平铺，无边框无背景**）
2. **errorDetail 样式不变**（保持原 `.errorBlock` 样式）

---

## 2. 读码确认

### 2.1 errorBlock 样式确认（timeline.module.css L230-251）

```css
.errorBlock {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-left: 32px;
  margin-right: 32px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--sd-destructive) 8%, transparent);   /* 浅红背景 */
  border: 1px solid color-mix(in srgb, var(--sd-destructive) 24%, transparent); /* 红色边框 */
}

.errorText {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--sd-destructive);   /* 红色文字 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

**结论**：`errorBlock` 是**浅红背景+红色边框+红色文字**的错误块——这就是用户说「errorDetail 的样式不变」要保持的样式。

Round 13 把它改成了 `.contentCardError`（带边框的卡片），需要**恢复为 `.errorBlock` > `.errorText`**。

### 2.2 运行中消息渲染结构确认

运行中（`running` 状态）内容区有两种渲染路径：

| 条件 | 渲染组件 | 容器类 |
|------|----------|--------|
| 真实会话（`realSession=true`） | `<StepChatPanel>` | `.stepChatPanel`（`margin-left:32px; margin-right:32px; margin-top:8px`，**无边框无背景**） |
| 合成会话（有消息） | `<agentChat> + <ChatLineRow>` | `.agentChat`（`margin-left:32px; margin-right:32px; margin-top:8px`，**无边框无背景**） |
| 合成会话（无消息） | 占位文字 | `.agentBodyRun` |

**共同特征**：运行中消息渲染全部是**无边框、无背景的平铺块**，左右 `margin:32px`，顶部 `margin-top:8px`。

### 2.3 `.md` 样式确认（timeline.module.css L294-302）

```css
.md {
  margin-left: 32px;
  margin-right: 32px;
  margin-top: 6px;
  /* 无边框、无背景、无 padding */
  font-size: 14px;
  line-height: 1.625;
  color: var(--sd-foreground);
  overflow-wrap: anywhere;
}
```

**结论**：`.md` **已满足**「运行中消息渲染」的平铺样式——左右 `margin:32px` 与 `.agentChat` / `.stepChatPanel` 对齐，无边框无背景。无需新增容器类。

---

## 3. 根因

Round 13 为了与 DagStepNodeView 的「统一内容卡片」视觉对齐，给 UnifiedTimeline 的 completed/failed 内容区加了 `.contentCardDone` / `.contentCardError`（有边框+背景），但用户期望的是**和运行中一样的平铺对话流风格**（无边框无背景，直接用 `.md`）。

**误解**：Round 13 认为「统一」= 统一到 DagStepNodeView 的卡片风格，实际用户要求「统一」= completed/failed 内容与 running 的消息渲染**同风格平铺**。

---

## 4. 修复方案

### 4.1 `packages/sandore/ui/src/client/UnifiedTimeline.tsx`

#### 4.1.1 completed 分支（L393-409）—— 去掉 `contentCardDone` 包裹

**改前**：
```tsx
{item.status === 'completed' && (
  <>
    {!isPhaseDone('finalizing', item.finalizePhase) && item.outputText !== undefined && (
      <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.outputText} /></div></div>
    )}
    {isPhaseDone('finalizing', item.finalizePhase) && item.finalizeAssessResult?.compressedOutput !== undefined && (
      <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div></div>
    )}
    {isPhaseDone('finalizing', item.finalizePhase) && item.finalizeAssessResult?.compressedOutput === undefined && item.outputText !== undefined && (
      <div className={css.contentCardDone}><div className={css.md}><MarkdownText text={item.outputText} /></div></div>
    )}
  </>
)}
```

**改后**（去掉 `contentCardDone`，直接用 `.md`）：
```tsx
{item.status === 'completed' && (
  <>
    {!isPhaseDone('finalizing', item.finalizePhase) && item.outputText !== undefined && (
      <div className={css.md}><MarkdownText text={item.outputText} /></div>
    )}
    {isPhaseDone('finalizing', item.finalizePhase) && item.finalizeAssessResult?.compressedOutput !== undefined && (
      <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
    )}
    {isPhaseDone('finalizing', item.finalizePhase) && item.finalizeAssessResult?.compressedOutput === undefined && item.outputText !== undefined && (
      <div className={css.md}><MarkdownText text={item.outputText} /></div>
    )}
  </>
)}
```

**说明**：三个子分支（收尾中 output / 收尾完成 compressedOutput / 兜底 output）统一用 `.md` 平铺渲染，与运行中消息同风格。

#### 4.1.2 failed 分支（L432-448）—— errorDetail 恢复 `errorBlock`，compressedOutput 改用 `.md`

**改前**：
```tsx
{item.status === 'failed' && (
  <>
    {(item.finalizeErrorDetail ?? item.error) && (
      <div className={css.contentCardError}>{item.finalizeErrorDetail ?? item.error}</div>
    )}
    {item.finalizeAssessResult?.compressedOutput !== undefined && (
      <div className={css.contentCardDone}>
        <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
      </div>
    )}
  </>
)}
```

**改后**：
```tsx
{item.status === 'failed' && (
  <>
    {/* errorDetail：恢复原 errorBlock 样式（浅红背景+红色边框+红色文字） */}
    {(item.finalizeErrorDetail ?? item.error) && (
      <div className={css.errorBlock}>
        <span className={css.errorText}>{item.finalizeErrorDetail ?? item.error}</span>
      </div>
    )}
    {/* compressedOutput：平铺 .md（与运行中消息同风格） */}
    {item.finalizeAssessResult?.compressedOutput !== undefined && (
      <div className={css.md}><MarkdownText text={item.finalizeAssessResult.compressedOutput} /></div>
    )}
  </>
)}
```

**说明**：
- `errorDetail` 恢复为 Round 13 之前的 `.errorBlock > .errorText` 两层嵌套
- `compressedOutput` 去掉 `contentCardDone`，直接用 `.md` 平铺

### 4.2 `packages/sandore/ui/src/client/timeline.module.css`

#### 删除 `.contentCardDone .md` 覆盖规则（L466-470）

**删除**：
```css
/* 已完成态内容卡片内的 Markdown 渲染（继承 .md 的排版规则） */
.contentCardDone .md {
  margin-left: 0;
  margin-right: 0;
  margin-top: 0;
}
```

**理由**：`.contentCardDone` 已不在 UnifiedTimeline 中使用，此规则成为死代码。

#### `.contentCard` / `.contentCardDone` / `.contentCardError` 保留判断

**保留**（不删除）：
- L435-463 的 `.contentCard` / `.contentCardDone` / `.contentCardError` **保留**
- **理由**：`DagStepNodeView.tsx` 仍在使用这些类名（L316-336），只是它引用的是 `DagStepNodeView.module.css` 中的同名类（L266-291），两套 CSS Module 互不干扰。但 `.contentCardDone .md` 覆盖规则是 `timeline.module.css` 独有的，确认 UnifiedTimeline 不再引用后可安全删除。

**简化建议**（可选，非必须）：如果想彻底清理，可删除 `timeline.module.css` 中 L435-463 的 `.contentCard*` 类，因为 `DagStepNodeView.module.css` 有独立的同名定义，两者互不影响。但这不是功能性改动，风险低，优先级低。

### 4.3 改动汇总

| 文件 | 行 | 改动 | 类型 |
|------|----|------|------|
| `UnifiedTimeline.tsx` | L398 | `<div className={css.contentCardDone}><div className={css.md}>...` → `<div className={css.md}>...` | 修改 |
| `UnifiedTimeline.tsx` | L402 | 同上 | 修改 |
| `UnifiedTimeline.tsx` | L406 | 同上 | 修改 |
| `UnifiedTimeline.tsx` | L439 | `<div className={css.contentCardError}>...` → `<div className={css.errorBlock}><span className={css.errorText}>...` | 修改 |
| `UnifiedTimeline.tsx` | L443-445 | `<div className={css.contentCardDone}><div className={css.md}>...` → `<div className={css.md}>...` | 修改 |
| `timeline.module.css` | L466-470 | 删除 `.contentCardDone .md` 覆盖规则 | 删除 |

---

## 5. 最终样式对齐表

| 区域 | 容器类 | 视觉 |
|------|--------|------|
| **运行中-真实会话** | `.stepChatPanel` | 无边框无背景，`margin:32px`，平铺 |
| **运行中-合成会话** | `.agentChat` > `.agentChatScroll` | 无边框无背景，`margin:32px`，可滚动 |
| **completed 内容** | `.md`（直接） | 无边框无背景，`margin:32px`，Markdown 平铺 |
| **failed-errorDetail** | `.errorBlock` > `.errorText` | **浅红背景+红色边框+红色文字**（不变） |
| **failed-compressedOutput** | `.md`（直接） | 无边框无背景，`margin:32px`，Markdown 平铺 |

---

## 6. 测试计划

### 6.1 手动验证矩阵

| 场景 | 预期视觉 |
|------|----------|
| completed（收尾中） | 平铺 Markdown（无边框无背景），与 running 下方消息同风格 |
| completed（收尾完成，有 compressedOutput） | 同上 |
| completed（收尾完成，无 compressedOutput） | 同上 |
| failed（有 errorDetail + compressedOutput） | 红色 errorBlock + 平铺 Markdown（两者样式独立） |
| failed（仅 errorDetail） | 仅红色 errorBlock |
| running（真实会话） | StepChatPanel 对话流（不受影响） |
| running（合成会话） | agentChat 消息列表（不受影响） |

### 6.2 视觉对比

- completed 内容 ↔ running 消息区：**左右缩进一致**（`margin:32px`），**无边框无背景**
- errorDetail：**保持 Round 13 之前的红色 errorBlock 样式**
- DagStepNodeView 的 contentCard 卡片：**不受影响**（独立 CSS Module）

---

## 7. 风险评估

| 风险 | 级别 | 缓解 |
|------|------|------|
| `.md` margin 与 `.agentChat` 不完全一致（`margin-top:6px` vs `8px`） | 极低 | 6px/8px 视觉差异极小，可后续微调 |
| 删除 `.contentCardDone .md` 覆盖后残留死代码 | 无 | L435-463 的 `.contentCard*` 可选删除（DagStepNodeView 不引用此处） |
| DagStepNodeView 受影响 | 无 | 使用独立的 `DagStepNodeView.module.css`，两套 CSS Module 互不干扰 |

---

## 8. 不需要 DSH 配合

所有改动在 sandore 包内：
- `packages/sandore/ui/src/client/UnifiedTimeline.tsx`
- `packages/sandore/ui/src/client/timeline.module.css`
- 不改 DSH 任何代码、配置或主题变量

---

## 9. 参考

- Round 13 方案：`docs/bugfix/bugfix-2026-08-17-round13-unifiedtimeline-fixes.md`
- `.errorBlock` / `.errorText` 样式：`timeline.module.css` L232-251
- `.md` 样式：`timeline.module.css` L294-337
- `.agentChat` 样式：`timeline.module.css` L340-344
- `.stepChatPanel` 样式：`timeline.module.css` L412-417
- `.contentCardDone` / `.contentCardError` 样式：`timeline.module.css` L435-463
- DagStepNodeView 独立 contentCard：`DagStepNodeView.module.css` L266-291
