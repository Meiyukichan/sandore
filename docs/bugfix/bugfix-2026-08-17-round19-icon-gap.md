# Round 19：状态行「图标↔文本」间距不一致修复方案

> **日期**：2026-08-17  
> **轮次**：Round 19（基于 Round 18 后间距微调）  
> **反馈原文**：  
> 「失败和它前面的图标间距又变大了，和后面的收尾门禁他们与自己图标的间距不一样」

---

## 1. 问题描述

Round 18 恢复了 `.stLbl`、`.phaseBtn`、`.phaseLabel` 的左右 padding（`2px 4px`），成功将「状态文本↔收尾/门禁/路由」间距调整为 13px（用户确认的折中值）。

但引入了一个新的不一致：
- **状态图标 → 「失败」文本**：间距 = 9px（`.st` gap 5px + `.stLbl` padding-left 4px）
- **PhaseIcon → 徽标文本**（如收尾/门禁/路由内部）：间距 = 3px（`.phaseBtn`/`.phaseLabel` 内部 gap 3px）

用户反馈：「图标↔文本」间距在状态图标和阶段徽标之间不一致，视觉上不协调。

---

## 2. 现状根因分析

### 2.1 当前 DOM 结构（`UnifiedTimeline.tsx` L341-352）

```tsx
<button className={`${css.st} ${css.stBtn} ${statusClass(item.status)}`}>
  <StatusIcon status={item.status} />        {/* 14x14 SVG */}
  <span className={css.stLbl}>{t(STEP_STATUS_KEYS[item.status])}</span>  {/* 如「失败」 */}
  <PhaseBadge item={item} t={t} openSession={openSession} />
</button>
```

PhaseBadge 内部渲染（`UnifiedTimeline.tsx` L278-301）：

```tsx
{/* 可点击版 */}
<button className={css.phaseBtn}>
  <PhaseIcon phase={badge.phase} />          {/* 12x12 SVG */}
  <span>{t(badge.labelKey)}</span>
</button>
{/* 不可点击版 */}
<span className={css.phaseLabel}>
  <PhaseIcon phase={badge.phase} />          {/* 12x12 SVG */}
  <span>{t(badge.labelKey)}</span>
</span>
```

### 2.2 当前 CSS 规则（`timeline.module.css`，Round 18 修改后）

| 选择器 | 属性 | 当前值 | 作用 |
|--------|------|--------|------|
| `.st` | `display` | `inline-flex` | 状态行内部 flex 布局 |
| `.st` | `gap` | `5px` | 状态行子元素（StatusIcon / .stLbl / PhaseBadge）间距 |
| `.stLbl` | `padding` | `2px 4px` | 状态文本内边距（Round 18 恢复） |
| `.phaseLabel` | `gap` | `3px` | 徽标内部（PhaseIcon ↔ 文本）间距 |
| `.phaseLabel` | `padding` | `2px 4px` | 徽标内边距 |
| `.phaseBtn` | `gap` | `3px` | 徽标按钮内部（PhaseIcon ↔ 文本）间距 |
| `.phaseBtn` | `padding` | `2px 4px` | 徽标按钮内边距 |

### 2.3 根因

`.stLbl` 的 `padding-left: 4px` 在 `.st` 的 `gap: 5px` 基础上额外增加了 StatusIcon→「失败」文本的距离（5px + 4px = 9px），而 `.phaseBtn`/`.phaseLabel` 内部的 PhaseIcon→文本距离仅由自身 `gap: 3px` 控制。

两个间距的计算路径不同：
- **StatusIcon → 「失败」**：`.st` gap(5px) + `.stLbl` padding-left(4px) = **9px**
- **PhaseIcon → 徽标文本**：`.phaseBtn`/`.phaseLabel` gap(3px) = **3px**

---

## 3. 修复方案

### 3.1 设计目标

| 间距 | 目标值 | 约束 |
|------|--------|------|
| 状态图标↔状态文本 | **5px** | 与 PhaseIcon↔徽标文本一致 |
| PhaseIcon↔徽标文本 | **5px** | 与状态图标↔状态文本一致 |
| 「失败」↔「收尾」 | **13px** | Round 18 用户已确认，不动 |
| 「收尾」↔「门禁」 | **13px** | 同上 |
| 「门禁」↔「路由」 | **13px** | 同上 |

### 3.2 具体 CSS 改动

#### 改动 1：`.stLbl` 去掉 padding-left

**文件**：`packages/sandore/ui/src/client/timeline.module.css` L284-288

**改前**：
```css
.stLbl {
  font-size: 12px;
  /* 左右 4px padding 与 .phaseLabel/.phaseBtn 对齐，使文本徽标间视觉间距约 13px */
  padding: 2px 4px;
}
```

**改后**：
```css
.stLbl {
  font-size: 12px;
  /* padding-left: 0：左侧间距交给 .st gap，使 StatusIcon↔「失败」= 5px；
     padding-right: 4px 保留：.stLbl↔下一个 .st 子元素间距 = gap 5px + padding-right 4px = 9px；
     再加上下一个徽标的 padding-left 4px = 13px（与 Round 18 一致）。 */
  padding: 2px 4px 2px 0;
}
```

**效果**：
- StatusIcon → 「失败」文本 = `.st` gap 5px + `.stLbl` padding-left 0px = **5px** ✅

---

#### 改动 2：`.phaseBtn` 内部 gap 3px → 5px

**文件**：`packages/sandore/ui/src/client/timeline.module.css` L180-196

**改前**：
```css
.phaseBtn {
  /* ... 其他属性不变 ... */
  gap: 3px;
  /* 左右 4px padding 与 .stLbl/.phaseLabel 对齐，使文本徽标间视觉间距约 13px */
  padding: 2px 4px;
  /* ... */
}
```

**改后**：
```css
.phaseBtn {
  /* ... 其他属性不变 ... */
  gap: 5px;
  /* 左右 4px padding 与 .stLbl/.phaseLabel 对齐，使文本徽标间视觉间距约 13px */
  padding: 2px 4px;
  /* ... */
}
```

**效果**：
- PhaseIcon → 徽标文本 = **5px** ✅（与 StatusIcon→「失败」一致）

---

#### 改动 3：`.phaseLabel` 内部 gap 3px → 5px

**文件**：`packages/sandore/ui/src/client/timeline.module.css` L158-170

**改前**：
```css
.phaseLabel {
  /* ... 其他属性不变 ... */
  gap: 3px;
  /* 左右 4px padding 与 .stLbl/.phaseBtn 对齐，使文本徽标间视觉间距约 13px */
  padding: 2px 4px;
  /* ... */
}
```

**改后**：
```css
.phaseLabel {
  /* ... 其他属性不变 ... */
  gap: 5px;
  /* 左右 4px padding 与 .stLbl/.phaseBtn 对齐，使文本徽标间视觉间距约 13px */
  padding: 2px 4px;
  /* ... */
}
```

**效果**：
- PhaseIcon → 徽标文本 = **5px** ✅（与 StatusIcon→「失败」一致）

---

### 3.3 改动汇总

| 文件 | 选择器 | 属性 | 改前值 | 改后值 |
|------|--------|------|--------|--------|
| `timeline.module.css` | `.stLbl` | `padding` | `2px 4px` | `2px 4px 2px 0` |
| `timeline.module.css` | `.phaseBtn` | `gap` | `3px` | `5px` |
| `timeline.module.css` | `.phaseLabel` | `gap` | `3px` | `5px` |

---

## 4. 验证矩阵

### 4.1 最终间距数值

| 间距 | 计算路径 | 最终值 | 状态 |
|------|----------|--------|------|
| **StatusIcon↔「失败」** | `.st` gap(5px) + `.stLbl` padding-left(0px) | **5px** | ✅ 改前 9px |
| **PhaseIcon↔「收尾」文本** | `.phaseBtn` gap(5px) | **5px** | ✅ 改前 3px |
| **PhaseIcon↔「门禁」文本** | `.phaseBtn` gap(5px) | **5px** | ✅ 改前 3px |
| **PhaseIcon↔「路由」文本** | `.phaseLabel` gap(5px) | **5px** | ✅ 改前 3px |
| **PhaseIcon↔「已检测」文本** | `.phaseLabel` gap(5px) | **5px** | ✅ 改前 3px |
| **「失败」↔「收尾」** | `.stLbl` padding-right(4px) + `.st` gap(5px) + `.phaseBtn` padding-left(4px) | **13px** | ✅ 不变 |
| **「收尾」↔「门禁」** | `.phaseBtn` padding-right(4px) + `.st` gap(5px) + `.phaseBtn` padding-left(4px) | **13px** | ✅ 不变 |
| **「门禁」↔「路由」** | `.phaseBtn` padding-right(4px) + `.st` gap(5px) + `.phaseLabel` padding-left(4px) | **13px** | ✅ 不变 |

### 4.2 一致性确认

| 对比项 | 改前 | 改后 | 结论 |
|--------|------|------|------|
| StatusIcon↔文本 vs PhaseIcon↔文本 | 9px vs 3px ❌ | 5px vs 5px ✅ | **一致** |
| 文本↔文本间距（相邻徽标间） | 13px | 13px | **不变** |

---

## 5. 副作用检查

### 5.1 SVG 尺寸规则

- `.st svg`：`width: 14px; height: 14px;`（L278-282）——不受 gap 改动影响 ✅
- `.phaseBtn svg`：`width: 12px; height: 12px;`（L198-202）——不受 gap 改动影响 ✅
- `.phaseLabel svg`：`width: 12px; height: 12px;`（L172-176）——不受 gap 改动影响 ✅

### 5.2 Hover 样式

- `.phaseBtn:hover`：仅设置 `text-decoration: underline` 和 `text-underline-offset`（L204-208）——不受 gap 改动影响 ✅
- `.stBtn`：无 hover 规则（L152-153 注释说明）——不受影响 ✅

### 5.3 其他受影响元素

- `.phaseActive`、`.phaseDone`、`.phaseFailed`：仅设置颜色（L210+），不涉及间距 ✅
- `.stInfo`、`.stSuccess`、`.stWarning`、`.stDestructive`：仅设置颜色（L290-293），不涉及间距 ✅
- `.stBtn` padding `2px 6px`：控制按钮整体内边距，与子元素 gap 无关 ✅

### 5.4 结论

本方案仅调整 3 个 CSS 属性值（`.stLbl` padding-left、`.phaseBtn` gap、`.phaseLabel` gap），不涉及任何新增规则或结构调整，对 hover、颜色、SVG 尺寸、按钮内边距等无副作用。

---

## 6. 不需要 DSH 配合

所有改动在 sandore 包内：
- `packages/sandore/ui/src/client/timeline.module.css`
- 不改 DSH 任何代码、配置或主题变量

---

## 7. 参考

- Round 18 方案：`docs/bugfix/bugfix-2026-08-17-round18-spacing-fix.md`
- `.st` 样式：`timeline.module.css` L134-140
- `.stLbl` 样式：`timeline.module.css` L284-288
- `.phaseLabel` 样式：`timeline.module.css` L158-170
- `.phaseBtn` 样式：`timeline.module.css` L180-202
- `UnifiedTimeline.tsx` 头部结构：L340-353
- `UnifiedTimeline.tsx` PhaseBadge 渲染：L278-301
- `UnifiedTimeline.tsx` StatusIcon 定义：L71-105
- `UnifiedTimeline.tsx` PhaseIcon 定义：L161-201
