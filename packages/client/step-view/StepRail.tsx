/**
 * StepRail（discussion 右侧「每 step 一档」的轮次条）。
 *
 * 用户真机要求：discussion 里的旧「每轮」刻度（`step-view/TurnNavigator.tsx`）去掉，
 * 换成**每个 step 一项**、垂直居中贴右缘、点击定位到该 step 卡片
 * （`[data-tl-step][data-step-id]`）、滚动时当前项高亮——样式与 DSH 的轮次条一致。
 *
 * 实现方式：**复用**旧 TurnNavigator 的视觉/交互实现（那份是 DSH `ui-chat
 * chat/TurnNavigator` 的 1:1 移植：等距刻度、active 变宽变色、frame 内滚动 + 两端
 * 渐隐、hover 预览），只把「轮」换成「step」：
 * - 数据：`stepRailItemsOf(segments)`（执行顺序，零新 RPC，见 step-rail.ts）；
 * - 定位：按 `data-step-id`（重试会产生多段，故带 `#attemptIndex` 消歧）找卡片后
 *   用 `scrollTop += flowTop − 24` 落到阅读线（与 `turn-rail.ts` 同款换算）；
 * - active：滚动采样（500ms 节流 + scrollend/ResizeObserver 补样）+ 阅读线扫描
 *   （纯函数 `stepRailActiveKeyAt` / `stepRailActiveKeyOf`）。
 *
 * DOM 锚点：`[data-sandore-step-rail]`（根）/ `[data-sandore-step-rail-item]`（每档，
 * 带 `data-step-id`、`data-step-attempt`、`data-active="true"`）。单 step 时只挂零高槽位
 * （与 DSH 轮次条「一个轮不画轴」同策略）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/StepRail
 */
import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent, type PointerEvent, type RefObject,
} from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import {
  STEP_RAIL_EMPTY, sameStepRailItems, stepRailActiveKeyAt, stepRailActiveKeyOf,
  stepRailItemsOf, stepRailKeyOf, stepRailLandingTopOf, stepRailReadingLineOffsetPx,
  type StepRailItem, type StepRailReadingEntry, type StepRailSource,
} from './step-rail.ts'
import css from './step-rail.module.css'

/** 相邻刻度的固定间距（与 DSH 轮次条同值：10px）。 */
const STEP_SPACING_PX = 10
/** 首尾刻度外的 rail 内边距。 */
const RAIL_INSET_PX = 6
/** 可滚动端 mask 渐隐带宽度。 */
const FADE_PX = 24
/** 定位补偿：目标卡片 top 与滚动视口顶的距离（与轮次条同值）。 */
const LANDING_CLEARANCE_PX = 24
/** 滚动采样节流（与轮次条同值 500ms）。 */
const SAMPLE_INTERVAL_MS = 500

/** 被定位的 step 卡片锚点选择器（宿主页 step 卡片）。 */
export const STEP_RAIL_CARD_SELECTOR = '[data-tl-step][data-step-id]'

interface StepRailProps {
  /** 活跃 step 段（`RunView` 的 activeSegments；执行顺序）。 */
  readonly segments: readonly StepRailSource[]
  /** 滚动视口（`RunView` 的 `.feedScroll`）——采样与定位都以它为坐标原点。 */
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>
  readonly t: TranslateNS<'sandore'>
}

type ItemPositionStyle = CSSProperties & { readonly '--step-rail-position': string }

type FrameStyle = CSSProperties & {
  '--step-rail-natural-height': string
  '--step-rail-inset': string
  '--step-rail-scroll-top': string
  '--step-rail-band': string
}

function itemPosition(index: number): ItemPositionStyle {
  return { '--step-rail-position': `${String(index * STEP_SPACING_PX)}px` }
}

function frameStyle(count: number, scrollTop: number, bandPx: number): FrameStyle {
  return {
    '--step-rail-natural-height': `${String((count - 1) * STEP_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    '--step-rail-inset': `${String(RAIL_INSET_PX)}px`,
    '--step-rail-scroll-top': `${String(scrollTop)}px`,
    '--step-rail-band': `${String(bandPx)}px`,
  }
}

/** 卡片 key → 滚动视口内的可见条目（视觉顺序 = DOM 顺序）。
 *
 * 坐标口径：**相对滚动视口顶**（与阅读线 `getBoundingClientRect().top + offset` 同系），
 * 故每张卡的视口 top 要减掉滚动视口自身的视口 top —— 不能直接比 viewport 坐标
 * （两者都在动时相对关系才算得对）。
 */
function visibleEntriesOf(scope: HTMLElement): StepRailReadingEntry[] {
  const origin = scope.getBoundingClientRect().top
  const entries: StepRailReadingEntry[] = []
  for (const card of scope.querySelectorAll<HTMLElement>(STEP_RAIL_CARD_SELECTOR)) {
    const stepId = card.dataset.stepId ?? ''
    if (stepId === '') continue
    const attempt = Number(card.dataset.stepAttempt ?? '0')
    entries.push({
      top: card.getBoundingClientRect().top - origin,
      key: `${stepId}#${Number.isSafeInteger(attempt) ? attempt : 0}`,
    })
  }
  return entries
}

/** 指针 y（视口坐标）→ 档位（含滚动偏移补偿 + 端点钳制）。 */
function itemAtPointer(
  items: readonly StepRailItem[],
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): StepRailItem | undefined {
  const rect = frame.getBoundingClientRect()
  const offset = clientY - rect.top + scrollTop - RAIL_INSET_PX
  const index = Math.max(0, Math.min(items.length - 1, Math.round(offset / STEP_SPACING_PX)))
  return items[index]
}

/** frame 内部滚动状态（两端渐隐 + active 跟随同读）。 */
interface RailScrollState {
  readonly top: number
}

function railScrollTop(scroller: HTMLElement): number {
  return scroller.scrollTop
}

function StepRailRail({ segments, scrollContainerRef, t }: StepRailProps) {
  const items = useMemo(() => stepRailItemsOf(segments), [segments])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [bandPx, setBandPx] = useState<number | null>(null)
  const frameRef = useRef<HTMLElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pointerInsideRef = useRef(false)
  /** 采样节流（与轮次条同款：scroll 只登记，超时后采样一次）。 */
  const samplePendingRef = useRef(false)
  const sampleTimerRef = useRef<number | undefined>(undefined)

  const syncScrollTop = useCallback((): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const next = railScrollTop(scroller)
    setScrollTop(current => (current === next ? current : next))
  }, [])

  const sampleActive = useCallback((): void => {
    const container = scrollContainerRef.current
    if (container === null || items.length === 0) {
      setActiveKey(null)
      return
    }
    const line = container.getBoundingClientRect().top + stepRailReadingLineOffsetPx(container.clientHeight)
    const reading = stepRailActiveKeyAt(visibleEntriesOf(container), line)
    setActiveKey(current => {
      const next = stepRailActiveKeyOf(items, reading)
      return current === next ? current : next
    })
  }, [items, scrollContainerRef])

  const scheduleSample = useCallback((): void => {
    if (samplePendingRef.current) return
    samplePendingRef.current = true
    sampleTimerRef.current ??= window.setTimeout(() => {
      sampleTimerRef.current = undefined
      samplePendingRef.current = false
      sampleActive()
    }, SAMPLE_INTERVAL_MS)
  }, [sampleActive])

  // 滚动采样：scroll 节流 + scrollend 立即补 + 视口/卡片尺寸变化（流式追加、折叠展开、
  // 图片加载都没有 scroll 事件）补样，对齐轮次条的既有语义。
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container === null) return undefined
    const flush = (): void => {
      if (sampleTimerRef.current !== undefined) {
        window.clearTimeout(sampleTimerRef.current)
        sampleTimerRef.current = undefined
      }
      samplePendingRef.current = false
      sampleActive()
    }
    container.addEventListener('scroll', scheduleSample, { passive: true })
    container.addEventListener('scrollend', flush, { passive: true })
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(scheduleSample)
      observer.observe(container)
    }
    flush()
    return () => {
      container.removeEventListener('scroll', scheduleSample)
      container.removeEventListener('scrollend', flush)
      observer?.disconnect()
      if (sampleTimerRef.current !== undefined) {
        window.clearTimeout(sampleTimerRef.current)
        sampleTimerRef.current = undefined
      }
      samplePendingRef.current = false
    }
  }, [sampleActive, scheduleSample, scrollContainerRef, items.length])

  // 轴带高：量滚动视口的 clientHeight（axis 在视口内垂直居中）。
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return undefined
    const measure = (): void => {
      setBandPx(current => {
        const next = container.clientHeight
        return current === next ? current : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [scrollContainerRef])

  // 内容/刻度变化后重算帧内滚动状态（渐隐）。
  useEffect(syncScrollTop, [syncScrollTop, items.length])

  // active 档始终留在视野内（除非指针正在轴上工作）。
  useEffect(() => {
    const scroller = scrollerRef.current
    const index = items.findIndex(item => stepRailKeyOf(item) === activeKey)
    if (scroller === null || index < 0 || pointerInsideRef.current) return
    const markTop = index * STEP_SPACING_PX + RAIL_INSET_PX
    const viewTop = scroller.scrollTop
    const viewHeight = scroller.clientHeight
    if (viewHeight <= 0 || (markTop >= viewTop + FADE_PX && markTop <= viewTop + viewHeight - FADE_PX)) return
    const target = Math.max(0, markTop - viewHeight / 2)
    const reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' })
    } else {
      scroller.scrollTop = target
    }
    syncScrollTop()
  }, [activeKey, items, syncScrollTop])

  /** 点击/键盘定位：滚动视口滚到该 step 卡片（`scrollTop += flowTop − 24`）。 */
  const navigateTo = useCallback((item: StepRailItem): void => {
    const container = scrollContainerRef.current
    if (container === null) return
    const card = [...container.querySelectorAll<HTMLElement>(STEP_RAIL_CARD_SELECTOR)]
      .find(el => (el.dataset.stepId ?? '') === item.stepId
        && Number(el.dataset.stepAttempt ?? '0') === item.attemptIndex)
      ?? [...container.querySelectorAll<HTMLElement>(STEP_RAIL_CARD_SELECTOR)]
        .find(el => (el.dataset.stepId ?? '') === item.stepId)
    if (card === undefined) return
    const flowTop = card.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({
      top: stepRailLandingTopOf(container.scrollTop, flowTop, LANDING_CLEARANCE_PX),
      behavior: 'auto',
    })
    setActiveKey(stepRailKeyOf(item))
  }, [scrollContainerRef])

  // 无档只挂零高槽位（保持锚点存在，便于 e2e/诊断）。
  // **单档照常画刻度**（与 DSH 轮次条「单轮不画轴」不同）：用户口径是
  // 「每个 step 一项」，档数必须恒等于 step 数（单 step 实例也要有一档可点）。
  if (items.length === 0) return <div className={css.slot} data-sandore-step-rail data-step-rail-count={0} />

  const previewIndex = items.findIndex(item => stepRailKeyOf(item) === previewKey)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex)
  const previewAtPointer = (event: PointerEvent<HTMLElement>): void => {
    const item = itemAtPointer(items, event.currentTarget, scrollerRef.current?.scrollTop ?? 0, event.clientY)
    setPreviewKey(item === undefined ? null : stepRailKeyOf(item))
  }
  const navigateAtPointer = (event: MouseEvent<HTMLElement>): void => {
    const item = itemAtPointer(items, event.currentTarget, scrollerRef.current?.scrollTop ?? 0, event.clientY)
    if (item !== undefined) navigateTo(item)
  }
  const canScrollDown = scrollerRef.current !== null
    && scrollTop < scrollerRef.current.scrollHeight - scrollerRef.current.clientHeight - 1
  const fadeClasses = [css.scroller]
  if (scrollTop > 1) fadeClasses.push(css.fadeTop)
  if (canScrollDown) fadeClasses.push(css.fadeBottom)
  return (
    <div className={css.slot} data-sandore-step-rail data-step-rail-count={items.length}>
      <nav
        ref={frameRef}
        className={css.frame}
        style={frameStyle(items.length, scrollTop, bandPx ?? 520)}
        aria-label={t('run.step.rail.label')}
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerEnter={() => { pointerInsideRef.current = true }}
        onPointerLeave={() => {
          pointerInsideRef.current = false
          setPreviewKey(null)
        }}
      >
        <div ref={scrollerRef} className={fadeClasses.join(' ')} onScroll={syncScrollTop}>
          <div className={css.marks} style={{ height: `${String((items.length - 1) * STEP_SPACING_PX + 2 * RAIL_INSET_PX)}px` }}>
            {items.map((item, index) => {
              const key = stepRailKeyOf(item)
              const active = key === activeKey
              const showingPreview = key === previewKey
              const classes = [css.mark]
              if (active) classes.push(css.markActive)
              else if (showingPreview) classes.push(css.markPreview)
              return (
                <div key={key} className={css.markPosition} style={itemPosition(index)}>
                  <button
                    type="button"
                    className={classes.join(' ')}
                    data-sandore-step-rail-item
                    data-step-id={item.stepId}
                    data-step-attempt={String(item.attemptIndex)}
                    {...(active ? { 'data-active': 'true' } : {})}
                    aria-label={t('run.step.rail.jump', { name: item.label })}
                    aria-current={active ? 'true' : undefined}
                    onClick={(event) => {
                      event.stopPropagation()
                      navigateTo(item)
                    }}
                    onFocus={() => { setPreviewKey(key) }}
                    onBlur={() => { setPreviewKey(null) }}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div role="tooltip" className={css.preview} style={previewPosition}>
            <div className={css.previewPrompt}>{preview.label}</div>
            {preview.status !== '' && <div className={css.previewResponse}>{preview.status}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/**
 * Discussion 右侧的每-step 轮次条（memo：流式帧下 segments 引用稳定则不重建刻度）。
 */
export const StepRail = memo(StepRailRail)

/** 供单测复用的空轴常量（避免测试自己造空数组）。 */
export const STEP_RAIL_EMPTY_ITEMS = STEP_RAIL_EMPTY
