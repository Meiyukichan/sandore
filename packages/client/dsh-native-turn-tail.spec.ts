/**
 * 权宜之计「DSH 原生会话页空 turn-tail 不占位」的**契约测试**（jsdom）。
 *
 * 本补丁不改 DSH 源码、只注入一条样式规则，所以这里锁的是「注入面」而不是渲染结果：
 * 1. 元素面：`<style id=… data-sandore-workaround="empty-turn-tail">` 必须进 `<head>`，
 *    标记齐全（便于真机取证时一眼认出是补丁）；
 * 2. 规则面：选择器必须同时含两个条件——`data-chat-flow-kind='turn-tail'` +
 *    `:not(:has([data-turn-tail]))` + `:not(:has([data-slot='conversation.chat.turnTail'] > *))`，
 *    并且动作是 `display: none`（少一个条件都会误伤正常 turn-tail 或流式 turn 上的链内容）；
 * 3. DSH DOM 契约面：把**真实空行的 DOM 形状**（取自用户真机快照）与**真实正常尾部**放进
 *    文档，断言 `document.querySelectorAll` 能按规则里的两个锚点把两者区分开——即这条规则
 *    依赖的 DSH 标记（`data-chat-flow-kind` / `data-turn-tail` / `data-slot`）仍在；
 * 4. 生命周期面：重复安装不产生重复元素；disposer 移除元素（`ctx.effect` 卸载时调用）。
 *
 * 注意：jsdom 不做真实 CSS 级联/`:has()` 布局计算，所以「隐藏后不再占 16px 间距」由
 * e2e（真浏览器）负责（`e2e/m21-dsh-native-empty-turn-tail.e2e.ts`）。
 * @module @meiyukichan/dsh-sandore/src/client/dsh-native-turn-tail.spec
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  TURN_TAIL_SUPPRESSION_CSS,
  TURN_TAIL_SUPPRESSION_ELEMENT_ID,
  TURN_TAIL_SUPPRESSION_MARKER,
  installDshNativeTurnTailSuppression,
} from './dsh-native-turn-tail.ts'

/** 清场：每个用例后移除注入元素与夹具 DOM。 */
afterEach(() => {
  document.getElementById(TURN_TAIL_SUPPRESSION_ELEMENT_ID)?.remove()
  document.body.replaceChildren()
})

describe('DSH 原生会话页空 turn-tail 抑制（权宜之计）', () => {
  it('injects one marked style element into head and removes it on dispose', () => {
    const dispose = installDshNativeTurnTailSuppression()
    const style = document.getElementById(TURN_TAIL_SUPPRESSION_ELEMENT_ID)
    expect(style, '注入的 <style> 应挂在文档里').not.toBeNull()
    expect(style?.tagName).toBe('STYLE')
    // 权宜之计标记：真机排查时一眼可见「这是补丁」。
    expect(style?.getAttribute('data-sandore-workaround')).toBe(TURN_TAIL_SUPPRESSION_MARKER)
    expect(document.head.contains(style)).toBe(true)

    // 幂等：重复安装不再追加第二个元素。
    const disposeSecond = installDshNativeTurnTailSuppression()
    expect(document.querySelectorAll(`#${TURN_TAIL_SUPPRESSION_ELEMENT_ID}`)).toHaveLength(1)

    disposeSecond()
    dispose()
    expect(document.getElementById(TURN_TAIL_SUPPRESSION_ELEMENT_ID)).toBeNull()
  })

  it('rule carries both conditions and the display:none action', () => {
    const rule = TURN_TAIL_SUPPRESSION_CSS
    // 条件①：只在 turn-tail 行上生效 + 行内没有 data-turn-tail（= DSH 的 closing===null 空壳）。
    expect(rule).toContain("[data-chat-flow-kind='turn-tail']")
    expect(rule).toContain(':not(:has([data-turn-tail]))')
    // 条件②：链上没渲染任何元素（有内容绝不隐藏：deliverables / 流式 turn）。
    expect(rule).toContain(":not(:has([data-slot='conversation.chat.turnTail'] > *))")
    expect(rule).toContain('display: none')
    // 权宜之计的自我说明必须留在 CSS 里（谁看到这段样式都知道它可删）。
    expect(rule).toContain('权宜之计')
    expect(rule).toContain('DSH 上游')
    expect(rule).toContain('dsh-native-turn-tail.ts')
  })

  it('separates a real empty turn-tail row from a normal tail row by the DSH markers the rule relies on', () => {
    // 空行形状取自用户真机快照（主代理会话页 turn#2..11）：只有空壳 div + 空的 chain 宿主。
    const empty = document.createElement('div')
    empty.setAttribute('data-chat-flow-kind', 'turn-tail')
    empty.innerHTML = '<div data-slot="conversation.chat.node" style="display: contents;">'
      + '<div class="dsh-turn-tail-root"><div data-slot="conversation.chat.turnTail" style="display: contents;"></div></div>'
      + '</div>'
    // 正常尾部：带 data-turn-tail 标记 + 动作行。
    const normal = document.createElement('div')
    normal.setAttribute('data-chat-flow-kind', 'turn-tail')
    normal.innerHTML = '<div data-slot="conversation.chat.node" style="display: contents;">'
      + '<div class="dsh-turn-tail-root" data-turn-tail="12" data-actions-reveal="always">'
      + '<div class="actions"><button type="button">复制</button></div></div></div>'
    // 链上有内容（其它插件挂的块，如 deliverables）：即使没有 data-turn-tail 也不许隐藏。
    const chained = document.createElement('div')
    chained.setAttribute('data-chat-flow-kind', 'turn-tail')
    chained.innerHTML = '<div data-slot="conversation.chat.turnTail" style="display: contents;">'
      + '<div class="deliverables-chip">proposal.md</div></div>'
    document.body.append(empty, normal, chained)

    const tails = [...document.querySelectorAll("[data-chat-flow-kind='turn-tail']")]
    expect(tails).toHaveLength(3)
    // 规则里的两个锚点：① 行内没有 data-turn-tail；② chain 宿主下没有子元素。
    // 注意：jsdom 的选择器引擎不认 CSS 里那种 `[data-slot=…] > *` 相对形式（恒返回 null），
    // 所以这里用 `childElementCount` 表达同一判据；CSS 文本本身由上一个用例逐字锁定，
    // 「真浏览器里 `:has()` 是否真的隐藏了行」由 e2e 负责。
    const isSuppressedCandidate = (row: Element): boolean => {
      const chainHost = row.querySelector("[data-slot='conversation.chat.turnTail']")
      return row.querySelector('[data-turn-tail]') === null && (chainHost?.childElementCount ?? 0) === 0
    }
    expect(isSuppressedCandidate(empty), '空壳行应命中抑制条件').toBe(true)
    expect(isSuppressedCandidate(normal), '正常尾部有 data-turn-tail，不许命中').toBe(false)
    expect(isSuppressedCandidate(chained), '链上有内容，不许命中').toBe(false)
  })
})
