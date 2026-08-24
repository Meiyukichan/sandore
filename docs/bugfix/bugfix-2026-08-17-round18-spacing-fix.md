# Round 18：UnifiedTimeline 状态行间距与左侧距离调整方案

> **日期**：2026-08-17  
> **轮次**：Round 18（基于 Round 14/17 后间距优化）  
> **反馈原文**：  
> 1. 「失败，收尾，门禁他们之间的间距又变得很小了」  
> 2. 「失败离左边的 step 有点远」

---

## 1. 问题描述

### 问题 1：状态行内元素间距过窄

Round 14 为统一「状态图标↔状态文本↔收尾/门禁/路由」间距策略，将 `.stLbl`、`.phaseBtn`、`.phaseLabel` 的左右 padding 从 `2px 6px` 改为 `2px 0`，理由是「间距完全由 `.st` 的 `gap:5px` 统一控制」。

**改动前**（Round 14 之前）：  
- `.st` 的 `gap:5px` 负责「状态图标↔状态文本」间距  
- `.stLbl`/`.phaseBtn`/`.phaseLabel` 的左右 `padding:6px` 负责「状态文本↔收尾徽标」间距  
- 总视觉间距 = gap 5px + padding 6px×2 = **17px**（偏大）

**改动后**（Round 14 之后）：  
- 所有间距由 `.st` 的 `gap:5px` 统一控制  
- 总视觉间距 = **5px**（偏小）

**用户反馈**：「失败，收尾，门禁他们之间的间距又变得很小了」——指文本徽标之间只剩 5px gap，太小。

### 问题 2：状态按钮整体离左偏远

`.stBtn`（状态按钮）到左边 step 标题（`.author/.authorLink`）的视觉距离计算：

```
agentHead gap (8px) + .st margin-left (8px) + StatusIcon (14px) + .st gap (5px) = 35px
```

**用户反馈**：「失败离左边的 step 有点远」——35px 间距偏大，用户希望更紧凑。

---

## 2. 现状根因分析

### 2.1 当前 DOM 结构（`UnifiedTimeline.tsx` L320-353）

```tsx
<div className={css.agentHead}>  {/* flex, gap:8px */}
  <span className={css.avatar}>...</span>
  <button className={css.authorLink}>{item.name}</button>
  {item.loopLabel && <span className={css.loopLabel}>{item.loopLabel}</span>}
  {item.attemptIndex > 0 && <span className={css.loopLabel}>{t('run.step.attempt')}</span>}
  {rel && <span className={css.time}>{formatTime(t, rel)}</span>}
  <button className={`${css.st} ${css.stBtn} ${statusClass(item.status)}`}>
    <StatusIcon status={item.status} />
    <span className={css.stLbl}>{t(STEP_STATUS_KEYS[item.status])}</span>
    <PhaseBadge item={item} t={t} openSession={openSession} />
  </button>
</div>
```

### 2.2 当前 CSS 规则（`timeline.module.css`）

| 选择器 | 属性 | 值 | 作用 |
|--------|------|-----|------|
| `.agentHead` | `display` | `flex` | 头部行布局 |
| `.agentHead` | `gap` | `8px` | 头部元素间距 |
| `.st` | `display` | `inline-flex` | 状态按钮内部布局 |
| `.st` | `gap` | `5px` | 状态按钮内部元素间距 |
| `.st` | `margin-left` | `8px` | 状态按钮与左侧元素间距 |
| `.stBtn` | `padding` | `2px 6px` | 状态按钮内边距 |
| `.stLbl` | `padding` | `2px 0` | 状态文本内边距 |
| `.phaseLabel` | `padding` | `2px 0` | 阶段文本内边距 |
| `.phaseBtn` | `padding` | `2px 0` | 阶段按钮内边距 |

### 2.3 问题 1 根因

Round 14 删除了 `.stLbl`/`.phaseBtn`/`.phaseLabel` 的左右 padding（从 `6px` 改为 `0`），将间距控制权完全交给 `.st` 的 `gap:5px`。但 `gap:5px` 只能控制「状态图标↔状态文本」间距，无法单独控制「状态文本↔收尾/门禁/路由」间距，导致所有元素间距统一为 5px，**视觉上过窄**。

### 2.4 问题 2 根因

`.st` 的 `margin-left:8px` + `.agentHead` 的 `gap:8px` 叠加，导致状态按钮整体离左偏远。`.stBtn` 的 `padding:2px 6px` 进一步增加了内部间距。

---

## 3. 修复方案

### 3.1 目标间距

| 间距 | 当前值 | 目标值 | 说明 |
|------|--------|--------|------|
| 状态图标↔状态文本 | 5px | 5px | 保持不变（适中） |
| 状态文本↔收尾/门禁/路由 | 5px | 10px | 折中方案（介于 5px 过小与 17px 过大之间） |
| 状态按钮整体↔左侧元素 | 35px | 24px | 减少 margin-left（从 8px 减为 4px） |

### 3.2 具体 CSS 改动

#### 改动 1：恢复 `.stLbl`/`.phaseBtn`/`.phaseLabel` 的左右 padding

**文件**：`packages/sandore/ui/src/client/timeline.module.css`

**选择器**：`.stLbl`（L284-289）

**改前**：
```css
.stLbl {
  font-size: 12px;
  /* 无左右 padding：状态行内各元素（StatusIcon/stLbl/收尾/门禁/路由）间距完全由
     .st 的 gap: 5px 控制，视觉一致。 */
  padding: 2px 0;
}
```

**改后**：
```css
.stLbl {
  font-size: 12px;
  /* 恢复左右 padding：与 .phaseBtn/.phaseLabel 对齐，增加状态文本与收尾/门禁/路由的间距 */
  padding: 2px 4px;
}
```

**理由**：  
- 恢复左右 `4px` padding（从 `0` 改为 `4px`，比原来的 `6px` 略小）  
- 状态文本与收尾/门禁/路由的视觉间距 = gap 5px + padding 4px×2 = **13px**（折中方案）

---

**选择器**：`.phaseLabel`（L158-170）

**改前**：
```css
.phaseLabel {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--sd-muted-foreground);
  border-radius: 6px;
  /* 无左右 padding：间距由 .st 的 gap 统一控制 */
  padding: 2px 0;
}
```

**改后**：
```css
.phaseLabel {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--sd-muted-foreground);
  border-radius: 6px;
  /* 恢复左右 padding：与 .stLbl 对齐，增加阶段文本与前后元素的间距 */
  padding: 2px 4px;
}
```

**理由**：  
- 与 `.stLbl` 保持一致（`2px 4px`）  
- 阶段文本与前后元素的视觉间距 = gap 5px + padding 4px×2 = **13px**（折中方案）

---

**选择器**：`.phaseBtn`（L180-196）

**改前**：
```css
.phaseBtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--sd-brand);
  border: none;
  border-radius: 6px;
  background: none;
  /* 无左右 padding：间距由 .st 的 gap 统一控制 */
  padding: 2px 0;
  cursor: pointer;
}
```

**改后**：
```css
.phaseBtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--sd-brand);
  border: none;
  border-radius: 6px;
  background: none;
  /* 恢复左右 padding：与 .stLbl 对齐，增加阶段按钮与前后元素的间距 */
  padding: 2px 4px;
  cursor: pointer;
}
```

**理由**：  
- 与 `.stLbl`、`.phaseLabel` 保持一致（`2px 4px`）  
- 阶段按钮与前后元素的视觉间距 = gap 5px + padding 4px×2 = **13px**（折中方案）

---

#### 改动 2：减少 `.st` 的 `margin-left`

**文件**：`packages/sandore/ui/src/client/timeline.module.css`

**选择器**：`.st`（L134-140）

**改前**：
```css
.st {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 8px;
  white-space: nowrap;
}
```

**改后**：
```css
.st {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 4px;
  white-space: nowrap;
}
```

**理由**：  
- 减少状态按钮与左侧元素的间距（从 `8px` 减为 `4px`）  
- 状态按钮整体离左距离 = agentHead gap 8px + .st margin-left 4px + StatusIcon 14px + .st gap 5px = **31px**（比原来的 35px 减少 4px）

---

### 3.3 改动汇总

| 文件 | 选择器 | 属性 | 改前值 | 改后值 | 效果 |
|------|--------|------|--------|--------|------|
| `timeline.module.css` | `.stLbl` | `padding` | `2px 0` | `2px 4px` | 状态文本与收尾/门禁/路由间距从 5px 增加到 13px |
| `timeline.module.css` | `.phaseLabel` | `padding` | `2px 0` | `2px 4px` | 阶段文本与前后元素间距从 5px 增加到 13px |
| `timeline.module.css` | `.phaseBtn` | `padding` | `2px 0` | `2px 4px` | 阶段按钮与前后元素间距从 5px 增加到 13px |
| `timeline.module.css` | `.st` | `margin-left` | `8px` | `4px` | 状态按钮整体离左距离从 35px 减少到 31px |

---

## 4. 验证步骤

### 4.1 手动验证矩阵

| 场景 | 预期视觉 |
|------|----------|
| **状态图标↔状态文本**（如「✓ 失败」） | 间距 = gap 5px（不变） |
| **状态文本↔收尾徽标**（如「失败 ↔ 收尾中」） | 间距 = gap 5px + padding 4px×2 = 13px（折中方案） |
| **收尾徽标↔门禁徽标**（如「收尾中 ↔ 门禁中」） | 间距 = gap 5px + padding 4px×2 = 13px（折中方案） |
| **门禁徽标↔路由徽标**（如「门禁中 ↔ 判断中」） | 间距 = gap 5px + padding 4px×2 = 13px（折中方案） |
| **状态按钮整体↔左侧元素** | 间距 = agentHead gap 8px + .st margin-left 4px + StatusIcon 14px + .st gap 5px = 31px |

### 4.2 视觉对比

| 元素 | 改动前 | 改动后 |
|------|--------|--------|
| 状态图标↔状态文本 | 5px | 5px |
| 状态文本↔收尾/门禁/路由 | 5px | 13px |
| 状态按钮整体↔左侧元素 | 35px | 31px |

---

## 5. 风险评估

| 风险 | 级别 | 缓解 |
|------|------|------|
| 恢复 padding 后状态按钮内部间距变化 | 低 | `.stBtn` 的 `padding:2px 6px` 保持不变，只影响子元素 |
| `.stLbl`/`.phaseBtn`/`.phaseLabel` 的 padding 增加后，状态按钮整体宽度增加 | 低 | 状态按钮宽度增加约 8px（padding 4px×2），对布局影响极小 |
| `.st` 的 `margin-left` 减少后，状态按钮整体左移 | 低 | 左移 4px，对布局影响极小 |

---

## 6. 不需要 DSH 配合

所有改动在 sandore 包内：
- `packages/sandore/ui/src/client/timeline.module.css`
- 不改 DSH 任何代码、配置或主题变量

---

## 7. 参考

- Round 14 方案：`docs/bugfix/bugfix-2026-08-17-round14-timeline-style-align.md`
- `.st` 样式：`timeline.module.css` L134-140
- `.stBtn` 样式：`timeline.module.css` L143-150
- `.stLbl` 样式：`timeline.module.css` L284-289
- `.phaseLabel` 样式：`timeline.module.css` L158-170
- `.phaseBtn` 样式：`timeline.module.css` L180-202
- `UnifiedTimeline.tsx` 头部结构：L320-353
