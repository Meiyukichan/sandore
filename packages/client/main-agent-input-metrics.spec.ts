/**
 * main-agent-input-metrics.spec：运行视图**宽度基准**（以 step 消息列为准）的纯函数单测。
 *
 * 真机反馈：「输入框的宽度有点太长了，你应该看下每个 step 下面的消息为中心让输入框对齐，
 * 然后左右比这个消息宽上一些就行」——故基准是**消息列的内容宽**（`clientWidth` 去掉左右内距），
 * 输入卡/接管卡 = 该值 + 24px 且同轴心。本 spec 钉死这条规则（含边界与容错）。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  CARD_OVERHANG_PX,
  MSG_WIDTH_VAR,
  messageContentWidthOf,
  publishMessageColumnWidth,
} from './main-agent-input-metrics.ts'

/** 最小元素桩：`clientWidth` 可控；内外距由 jsdom 的 computed style 提供。 */
function columnStub(clientWidth: number, padding: string): HTMLElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true })
  element.style.padding = padding
  return element
}

/** 变量宿主桩（记录 set/remove）。 */
function hostStub(): { element: HTMLElement; set: Map<string, string>; removed: string[] } {
  const set = new Map<string, string>()
  const removed: string[] = []
  const element = {
    style: {
      setProperty: (name: string, value: string) => { set.set(name, value) },
      removeProperty: (name: string) => { removed.push(name) },
    },
  } as unknown as HTMLElement
  return { element, set, removed }
}

describe('宽度基准：以 step 消息列的内容宽为准', () => {
  it('keeps the variable name and the 24px overhang (12px each side)', () => {
    expect(MSG_WIDTH_VAR).toBe('--sandore-msg-content-width')
    expect(CARD_OVERHANG_PX).toBe(24)
  })

  it('measures the column CONTENT width (clientWidth minus horizontal padding)', () => {
    // 列的左右内距各 24px（运行视图 `.column` 的实际值）→ 内容宽 = clientWidth - 48。
    expect(messageContentWidthOf(columnStub(768, '24px'))).toBe(720)
    expect(messageContentWidthOf(columnStub(600, '0px'))).toBe(600)
    // 非布局环境（宽度 0）→ 0（调用方据此移除变量、退回 CSS 兜底）。
    expect(messageContentWidthOf(columnStub(0, '24px'))).toBe(0)
  })

  it('publishes the measured width and removes the variable when unmeasurable', () => {
    const host = hostStub()
    publishMessageColumnWidth(host.element, columnStub(768, '24px'))
    expect(host.set.get(MSG_WIDTH_VAR)).toBe('720px')
    // 重新测量（列宽变化）→ 覆盖为最新值（ResizeObserver 每次回调都会走到这里）。
    publishMessageColumnWidth(host.element, columnStub(700, '24px'))
    expect(host.set.get(MSG_WIDTH_VAR)).toBe('652px')
    // 列消失（卸载）→ 移除变量。
    publishMessageColumnWidth(host.element, null)
    expect(host.removed).toContain(MSG_WIDTH_VAR)
    // 宿主缺失 → 静默无操作（绝不抛）。
    expect(() => { publishMessageColumnWidth(null, columnStub(768, '24px')) }).not.toThrow()
  })

  it('ignores a zero-width column instead of publishing a bogus base', () => {
    const host = hostStub()
    // 未布局（display:none / 初始帧）→ 不发布 0px（否则卡片会被算成 24px 宽）。
    publishMessageColumnWidth(host.element, columnStub(0, '24px'))
    expect(host.set.has(MSG_WIDTH_VAR)).toBe(false)
    expect(host.removed).toContain(MSG_WIDTH_VAR)
  })
})
