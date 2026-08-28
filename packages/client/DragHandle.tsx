/**
 * 拖拽分隔条（照搬 DSH AppFrame 的 DragHandle 模式：pointer capture + rAF 节流）。
 *
 * `onDrag(dx)` 在每次指针移动的下一帧回调一次累计位移；pointerup/pointercancel
 * 释放捕获并做最后一次回调。拖动期间给元素加 `dragging` class 供样式高亮。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DragHandle
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * 为元素挂接拖拽监听（约 40 行，同 AppFrame.makeDragHandle 语义）。
 * @param el - 分隔条元素。
 * @param onDrag - 位移回调（px，正值向右）。
 * @returns 移除监听的 disposer。
 */
export function attachDragHandle(el: HTMLElement, onDrag: (dx: number) => void): () => void {
  let frame: number | null = null
  let latest = 0
  let last = 0

  const move = (e: PointerEvent): void => {
    if (!el.hasPointerCapture(e.pointerId)) return
    latest = e.clientX
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null
        onDrag(latest - last)
        last = latest
      })
    }
  }

  const end = (e: PointerEvent): void => {
    if (!el.hasPointerCapture(e.pointerId)) return
    el.releasePointerCapture(e.pointerId)
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    if (latest !== last) {
      onDrag(latest - last)
      last = latest
    }
    el.classList.remove('dragging')
  }

  const down = (e: PointerEvent): void => {
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    latest = e.clientX
    last = e.clientX
    el.classList.add('dragging')
  }

  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
  }
}

/** React 拖拽分隔条组件：渲染 7px 分隔条并挂接拖拽。 */
export function DragHandle({ onDrag, side, className }: {
  /** 拖拽位移回调（px）。 */
  onDrag(dx: number): void
  /** 语义标记（data-side，供样式/测试区分）。 */
  side: string
  /** 附加 class。 */
  className?: string | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onDragRef = useRef(onDrag)
  onDragRef.current = onDrag

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    return attachDragHandle(el, (dx) => { onDragRef.current(dx) })
  }, [])

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // 阻止默认行为，避免文本选择/拖拽干扰（attachDragHandle 内部也 preventDefault）。
    e.preventDefault()
  }

  return <div ref={ref} className={className} data-drag-handle data-side={side} onPointerDown={handlePointerDown} aria-hidden />
}
