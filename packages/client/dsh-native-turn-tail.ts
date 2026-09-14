/**
 * 【权宜之计 / 临时补丁】DSH 原生会话页里「空 turn 的 turn-tail 行」占位抑制。
 *
 * > ⚠️ **这不是干净实现**——本仓库硬约束「禁止修改 DSH 源码」，而这个缺陷的正确修法在
 * > DSH 侧（见下「退出条件」），所以只能由我们的 client 半往页面注入一条样式规则顶上。
 * > 一旦 DSH 上游修好，**删除本文件 + `index.ts` 里那一行装配**即可，没有其它耦合。
 *
 * ## 症状（用户真机）
 * 主代理会话页（DSH 原生会话视图）里，每个「空壳 turn」都留一行看不见内容的空白行；
 * 一次 10 步的工作流会在会话中间堆出 10 × 16px 的空白（用户报「一堆空白行」）。
 *
 * ## 根因（只读 DSH 源码得到的结论）
 * 1. 空 turn 的来源：抑制 step 结算通知走 `agent/pre-step` → `{kind:'reject'}`，而 DSH 在
 *    await pre-step **之前**就已 `append('turn/start')`（`core/agent-loop`：先写 turn/start、
 *    后 await pre-step）→ 被丢弃的消息留下 `turn/start` + `turn/end{blocked}` 的空壳 turn
 *    （DSH 的 `notifySettlement` 无条件投递、没有 quiet 开关）。**这部分我们无法在引擎侧消除**。
 * 2. 空 turn 为什么会占位：DSH `TurnTailNodeView` 在 `closing === null`（该 turn 没有收尾
 *    assistant）时写的是
 *    `return tail === null ? null : <div className={css.root}>{tail}</div>`；
 *    而 `tail = renderSlotChain('conversation.chat.turnTail', owner)` 的实现
 *    （`ui-renderer/src/client/scoped-slots.tsx` 的 `renderChainResult`）恒返回
 *    `elected ?? <>{fallback ?? null}</>` ——**一个 Fragment 永远不是 `null`**，于是
 *    `tail === null` 成了**死代码**，空 turn 照样渲染出一个空壳 `<div>`。
 * 3. 于是 DSH 自己那条「空 flex 行不吃列间距」的规则（`ChatView.module.css`：
 *    `An empty flex item must not consume the column gap.` + `.flowItem:empty { display: none }`）
 *    命中不了（该行并非 `:empty`）→ 每个空 turn 白吃一条 `--dsh-chat-flow-gap`（16px）。
 *
 * ## 本补丁做的事
 * 注入一条样式规则，只隐藏**同时满足**两个条件的 `turn-tail` 行：
 * - ① 行内**没有** `[data-turn-tail]` —— DSH 只在「该 turn 有收尾 assistant」时才挂这个标记，
 *   所以正常尾部（复制/分支/用量/用时那一行）**一律不受影响**；
 * - ② `[data-slot='conversation.chat.turnTail']` 链上**没有渲染出任何元素** —— 别的插件
 *   （如 DSH 自带的 deliverables 文件条）可能往这条链上挂内容；有内容就绝不隐藏，
 *   流式输出中的 turn（其 `closing` 也是 null）因此也安全。
 *
 * ## 退出条件（务必照做）
 * - **DSH 上游修好**（把 `TurnTailNodeView` 那条死代码改活：链上没选举出内容时返回 `null`，
 *   空行根本进不了 DOM）→ 删掉本文件与 `index.ts` 的装配行；
 * - 本规则依赖 DSH 的 DOM 标记（`data-chat-flow-kind` / `data-turn-tail` / `data-slot`）：
 *   DSH 改标记时本规则会**静默失效**（表现 = 空白行回来），不会误伤其它内容（安全失败）；
 * - 本补丁**只治页面表征**：空 turn 仍留在会话日志里（turn 计数、会话导出、其它按 turn
 *   渲染的视图仍看得到它们）。要根治得让引擎侧不再产生空 turn（需 DSH 配合放宽
 *   `notifySettlement`），或改 step 子代理的父会话归属（架构改动）。
 *
 * 取证与设计说明见 `docs/workarounds/dsh-empty-turn-tail.md`。
 * @module @meiyukichan/dsh-sandore/src/client/dsh-native-turn-tail
 */

/** 注入的 `<style>` 元素 id（测试与真机取证按它定位）。 */
export const TURN_TAIL_SUPPRESSION_ELEMENT_ID = 'dsh-sandore-workaround-empty-turn-tail'

/** 权宜之计标记值（挂在 `<style data-sandore-workaround>` 上，便于在页面里一眼认出「这是补丁」）。 */
export const TURN_TAIL_SUPPRESSION_MARKER = 'empty-turn-tail'

/**
 * 抑制规则本体（形态与用户确认的规则一致，改成多行并带注释便于真机排查）。
 *
 * 选择器两段缺一不可：只按「没有 `data-turn-tail`」隐藏会误伤流式 turn 上其它插件已渲染的
 * 链内容；只按「链上没内容」隐藏则可能在未来的 DSH 里命中非空 turn。两段都满足时，该行
 * 一定是「空 turn 且无任何内容」——隐藏它与 DSH 本意（`.flowItem:empty { display: none }`）等价。
 */
export const TURN_TAIL_SUPPRESSION_CSS = `/* dsh-sandore 权宜之计：DSH 原生会话页里「空 turn」的 turn-tail 行不占位。
   见 packages/client/dsh-native-turn-tail.ts 文件头（DSH 侧 tail===null 是死代码，
   本仓库不许改 DSH 源码 → 由本规则顶上）。DSH 上游修好后整条规则可删。 */
[data-chat-flow-kind='turn-tail']:not(:has([data-turn-tail])):not(:has([data-slot='conversation.chat.turnTail'] > *)) {
  display: none;
}
`

/**
 * 安装补丁（幂等；返回 disposer 供 `ctx.effect` 逆序清理）。
 *
 * 无 `document`（纯 Node/SSR 环境）时静默 no-op：本补丁只对浏览器页面有意义。
 * @returns 卸载函数（移除注入的 `<style>`）。
 */
export function installDshNativeTurnTailSuppression(): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  const existing = document.getElementById(TURN_TAIL_SUPPRESSION_ELEMENT_ID)
  if (existing !== null) {
    // 已被其它插件实例（或热重载残留）注入过：复用同一个元素，卸载时一并移除。
    return () => { existing.remove() }
  }
  const style = document.createElement('style')
  style.id = TURN_TAIL_SUPPRESSION_ELEMENT_ID
  // 权宜之计的显式标记：真机取证/排查时一眼能看出这是补丁而不是 DSH 自己的样式。
  style.setAttribute('data-sandore-workaround', TURN_TAIL_SUPPRESSION_MARKER)
  style.textContent = TURN_TAIL_SUPPRESSION_CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
