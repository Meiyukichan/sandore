/**
 * 运行视图的**宽度基准**：以「step 消息列」为准，输入框与接管卡只比它宽一点。
 *
 * 真机反馈（逐字）：
 * > 「输入框的宽度有点太长了，你应该看下每个 step 下面的消息为中心让输入框对齐，
 * >  然后左右比这个消息宽上一些就行」
 *
 * 上一版照抄了 DSH 中心列的共享宽度轴（`clamp(680px, 列宽 × 0.64, 920px)`、卡 = 内容宽 + 32px）——
 * 那是 **DSH 对话列**的规则，搬到运行视图里偏宽（真机实测 712px 就是过宽的证据）。现在改成：
 * 1. 量出运行视图里**消息列的内容宽**（`.column` 的 `clientWidth` 减去左右内距 = step 卡片/消息
 *    实际占用的宽度），发布为 `--sandore-msg-content-width`（px）；
 * 2. 输入卡与 ask/permission 接管卡都用 `calc(该值 + 24px)` 并 `margin-inline: auto`
 *    ——**同轴心**（都在同一个居中列里），左右各比消息宽 12px。
 *
 * 视觉细节（圆角 22px / elevation-soft 阴影 / 内距 / 34px 发送钮 / 下拉样式）仍逐值照抄 DSH，
 * 只是**宽度与居中基准**换成了运行视图自己的消息列。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/run-view-metrics
 */
import { useCallback, useRef } from 'react'

/** 发布到宿主元素上的宽度基准变量名（输入卡与接管卡共用）。 */
export const MSG_WIDTH_VAR = '--sandore-msg-content-width'
/** 输入卡/接管卡相对消息内容宽的外扩量（px）：左右各 12px。 */
export const CARD_OVERHANG_PX = 24

/**
 * 计算消息列的**内容宽**（`clientWidth` 去掉左右内距）。
 *
 * 用 `clientWidth`（不是 `getBoundingClientRect`）的理由：它是布局宽度的整数近似，滚动条
 * 不会让数值抖动；内距从 computed style 读，避免把列的内距硬编码进本模块。
 * @param column - 消息列元素。
 * @returns 内容宽 px（非布局环境 / 宽度为 0 时返回 0）。
 */
export function messageContentWidthOf(column: HTMLElement): number {
  const style = getComputedStyle(column)
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
  const inner = column.clientWidth - (Number.isFinite(padding) ? padding : 0)
  return inner > 0 ? Math.round(inner) : 0
}

/**
 * 把消息列内容宽发布到宿主元素（输入卡与接管卡读它）。
 * @param host - 承载变量的元素（运行视图的对话列）。
 * @param column - 消息列元素；null / 宽度为 0 → 移除变量（退回 CSS 兜底）。
 */
export function publishMessageColumnWidth(host: HTMLElement | null, column: HTMLElement | null): void {
  if (host === null) return
  if (column === null) {
    host.style.removeProperty(MSG_WIDTH_VAR)
    return
  }
  const width = messageContentWidthOf(column)
  if (width <= 0) {
    host.style.removeProperty(MSG_WIDTH_VAR)
    return
  }
  host.style.setProperty(MSG_WIDTH_VAR, `${width}px`)
}

/**
 * 回调 ref 工厂：给**消息列**挂观察（宽度变化即重新发布到宿主元素）。
 *
 * 返回的 ref 回调身份稳定；无 `ResizeObserver` 的环境（jsdom）只发布一次初值，不抛错。
 * @param hostRef - 现取宿主元素（对话列）的 ref（宿主可能晚于消息列出现）。
 * @returns 传给消息列 `ref` 的回调。
 */
export function useMessageColumnWidthPublisher(
  hostRef: { readonly current: HTMLElement | null },
): (column: HTMLElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null)
  return useCallback((column: HTMLElement | null): void => {
    observer.current?.disconnect()
    observer.current = null
    publishMessageColumnWidth(hostRef.current, column)
    if (column === null || typeof ResizeObserver === 'undefined') return
    observer.current = new ResizeObserver(() => { publishMessageColumnWidth(hostRef.current, column) })
    observer.current.observe(column)
  }, [hostRef])
}
