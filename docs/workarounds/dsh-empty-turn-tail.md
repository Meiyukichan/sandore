# 权宜之计：DSH 原生会话页「空 turn 的 turn-tail 行」不占位

> **性质：临时补丁（workaround），不是干净实现。**
> 本仓库硬约束「**禁止修改 DSH 源码**」，而这个缺陷的正确修法在 DSH 侧，所以当前由
> `dsh-sandore` 的 client 半往页面注入一条样式规则顶上。**DSH 上游修好后请删除本补丁**
> （删除清单见文末「退出条件」）。

## 症状（用户真机）

主代理会话页（**DSH 原生**会话视图，不是我们自己的运行页卡片）里，每个「空壳 turn」都留下
一条看不见内容的空白行；一次 10 步的工作流会在会话中间堆出 10 × 16px 的空白
（用户原话：「主代理会话里一堆空白行」「这样的空白行还是有」）。

真机取证（`e2e/.artifacts/dsh-native-empty-turn-tail.txt`，M21 用例产出）：

```
盘面 turn 总数=5 空 turn 数=3（turn#2,#3,#4，end=blocked）
DOM turn-tail 行=5 其中空行=3 可见的正常尾部=2
规则生效：空行 display=none h=0
停用规则：空行 display=block ×3
间距（上一可见行底 → 下一可见行顶）：规则生效=16px，停用后=64px（= 16 + 16×3）→ 每行原本白吃一条列间距
```

## 根因链（只读 DSH 源码得到的结论）

1. **空 turn 从哪来**：抑制 Step 结算通知走 `agent/pre-step` 返回 `{kind:'reject'}`；而 DSH 在
   await pre-step **之前**就已 `append('turn/start')`，被丢弃的消息于是留下
   `turn/start` + `turn/end{blocked}` 的**空壳 turn**。DSH 的 `notifySettlement` 对
   continuable 子代理**无条件投递**结算通知（没有 quiet 开关），引擎侧无法阻止。
   → 空 turn 个数 == 被 park 的通知个数（本例 3 个 step 子代理 → 3 个空 turn）。
2. **空 turn 为什么会占位**：DSH `TurnTailNodeView`（`packages/client/ui-chat/src/client/chat/`）
   在 `closing === null`（该 turn 没有收尾 assistant）时写的是
   `return tail === null ? null : <div className={css.root}>{tail}</div>`。
   而 `tail = renderSlotChain('conversation.chat.turnTail', owner)` 的实现
   （`packages/client/ui-renderer/src/client/scoped-slots.tsx` 的 `renderChainResult`）恒返回
   `elected ?? <>{opts?.fallback ?? null}</>` —— **Fragment 永远不是 `null`**，于是
   `tail === null` 成了**死代码**，空 turn 照样渲染出一个空壳 `<div>`。
3. **于是 DSH 自己的规则命中不了**：`ChatView.module.css` 里那条
   「An empty flex item must not consume the column gap.」+`.flowItem:empty { display: none }`
   要求该行真的是 CSS 的 `:empty`；空壳 `<div>` 让行非空 → 每个空 turn 白吃一条
   `--dsh-chat-flow-gap`（16px）。

## 本补丁（`packages/client/dsh-native-turn-tail.ts`）

往 `<head>` 注入**一条**样式规则（带标记 `<style id="dsh-sandore-workaround-empty-turn-tail"
data-sandore-workaround="empty-turn-tail">`，一眼可认出是补丁）：

```css
[data-chat-flow-kind='turn-tail']:not(:has([data-turn-tail])):not(:has([data-slot='conversation.chat.turnTail'] > *)) {
  display: none;
}
```

两个条件缺一不可：

- ① 行内**没有** `[data-turn-tail]`：DSH 只在「该 turn 有收尾 assistant」时挂这个标记 →
  正常的尾部动作行（复制/分支/用量/用时）**一律不受影响**；
- ② `[data-slot='conversation.chat.turnTail']` 链上**没渲染出元素**：其它插件（如 DSH 自带的
  deliverables 文件条）可能往这条链上挂内容；有内容就绝不隐藏 → 流式输出中的 turn
  （`closing` 也是 null）也安全。

装配点：`packages/client/index.ts` 的 `apply()` 第一行
`ctx.effect(() => installDshNativeTurnTailSuppression(), 'ui-sandore: workaround empty turn-tail')`。

## 为什么这做法「不干净」（已知局限，别当常规实现看）

- **依赖 DSH 的 DOM 标记**（`data-chat-flow-kind` / `data-turn-tail` / `data-slot`）。DSH 改标记时
  本规则会**静默失效**——表现只是「空白行回来」，不会误伤其它内容（安全失败，但也不会报错）。
- **只治页面表征**：空 turn 仍留在会话日志里（turn 计数、会话导出、其它按 turn 渲染的视图
  依旧看得到）。要根治得让引擎侧不再产生空 turn，需要 DSH 配合（放宽 `notifySettlement`），
  或改 Step 子代理的父会话归属（架构改动，会破坏「实例绑定真实会话」的现有形态）。
- **不是「我们自己的视图」的替代**：我们自己的时间线（运行页/step 面板）本就在渲染侧抑制
  空 turn 的 turn-tail（`step-view/step-row-data.ts` 的 `stepChatTurnsWithContentOf`），
  与本补丁是两条独立路径（两条都由 M19 / M21 覆盖）。
- 页面里插全局样式本身是一种侵入：因此规则缩到最窄（两个条件 + 只作用于一个 flow kind），
  且带显式标记与注释。

## 退出条件（DSH 上游修好之后照做）

1. **正确修法在 DSH 侧**：把 `TurnTailNodeView` 的死代码改活——链上没选举出内容时返回
   `null`（空行就不会进 DOM，DSH 自己的 `.flowItem:empty` 规则随即生效）。
2. 上游到位后删除：`packages/client/dsh-native-turn-tail.ts`、
   `packages/client/dsh-native-turn-tail.spec.ts`、
   `packages/client/index.ts` 里那一行装配与对应 import、
   `e2e/m21-dsh-native-empty-turn-tail.e2e.ts`、本文件。
3. 删除后回归：`e2e/m19-empty-turn-tail.e2e.ts`（我们自己的视图）必须仍然通过。

## 覆盖（测试与取证）

| 层 | 文件 | 锁什么 |
| --- | --- | --- |
| 单元（jsdom） | `packages/client/dsh-native-turn-tail.spec.ts` | 注入面（元素 id / 标记 / 幂等 / disposer）、规则文本（两个条件 + `display:none`）、DSH DOM 契约（空壳行 vs 正常尾部 vs 链上有内容三者的区分） |
| 真机（Playwright） | `e2e/m21-dsh-native-empty-turn-tail.e2e.ts` | 在**DSH 原生会话页**上：规则已注入；空行 `display:none` 且高度 0；空行数 == 盘面空 turn 数；正常尾部照常可见；**停用规则后间距 16 → 64px（= 16 + 16×3）**、恢复后回到 16 |
| 真机（Playwright） | `e2e/m19-empty-turn-tail.e2e.ts` | 我们自己的主代理卡片里没有空白行（另一条路径，防回归） |
