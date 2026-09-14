/**
 * TurnNavigator（B4a step-view 版）：右侧垂直轮次轴——照抄 DSH 0.1.2-rc.1
 * ui-chat `chat/TurnNavigator.tsx`（只读参考 deepseek-harness）。
 *
 * 视觉 1:1（几何常量/渐隐/预览卡）：`nav.frame` 内每 turn 一个等距刻度按钮
 * （mark），ladder 超出轴带时在 frame 内部滚动（scroller 无滚动条、两端
 * mask 渐隐 fade）；active/preview 刻度态（tick 加宽变色 + 键盘 focus-visible
 * 品牌色环）；hover/focus 预览卡（prompt ≤1 行 + response ≤3 行）。等距/滚动/
 * 预览坐标由内联 CSS 变量驱动（--turn-natural-position/-height、--turn-rail-inset、
 * --turn-scroll-top），常量与 rc.1 完全一致（TURN_SPACING_PX=10 等）。
 *
 * B4a 裁剪（面板上下文差异，逐条注释于 turn-rail.ts / module.css）：
 * - **unloaded**：rc.1 的刻度可能带 { kind:'unloaded', seq } 锚点（turnOutline
 *   投影 + loadThrough 翻历史）；面板无 outline/分页，轴只由 navigation.items()
 *   的 loaded 锚点组成——unloaded 类名/aria jumpLoad 键/分页 busy 态全部剪除；
 * - **busyTurn**：随 loadThrough 一并剪除（props 无 busyTurn；未来面板若接
 *   「加载更早」分页，按 rc.1 恢复 busy 脉冲与 aria-busy）；
 * - **轴带高**：rc.1 由 ConversationRoot 在滚动视口发布
 *   --dsh-conversation-viewport-height/--dsh-composer-height，frame 用
 *   calc 求 band（视口 − composer）并垂直居中；面板批 A（A3）起在同一个节点
 *   （`[data-conversation-scroll]` 的 .stepChatScroll）发布同名变量——本组件
 *   **优先读该变量**，缺失/不可解析时回退自测 parent 的 clientHeight（ResizeObserver
 *   跟随尺寸变化；首量在 layout effect 内同步，绘制前即有真实 band；量出前 CSS
 *   回退 520px）；
 * - 槽位零高 sticky：slot 浮在转录区右缘（z 7），不撑高滚动内容，与 rc.1 同。
 *
 * memo（rc.1 同款理由）：每条 turn 渲染两个宿主元素，外层视图随流式帧重渲时
 * props 必须引用稳定（items 恒等由 StepChatBody 的 stepChatSameRailItems 缓存
 * 保证；onNavigate/t 稳定），否则长会话每 commit 重建数百刻度。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/TurnNavigator
 */
import {
  memo, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type MouseEvent, type PointerEvent,
} from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepChatTurnRailItem } from './turn-rail.ts'
import css from './turn-navigator.module.css'

interface TurnNavigatorProps {
  readonly items: readonly StepChatTurnRailItem[]
  /** 当前阅读轮次（面板容器滚动采样维护；null = 未定）。 */
  readonly activeTurn: number | null
  /** 点击刻度：定位该轮锚点行（loaded 恒真；实现见 StepChatPanel.tsx）。 */
  readonly onNavigate: (item: StepChatTurnRailItem) => void
  readonly t: TranslateNS<'sandore'>
}

/** 相邻刻度的固定间距（超出轴带时在 frame 内滚动）。 */
const TURN_SPACING_PX = 10
/** 首尾刻度外的 rail 内边距（每端）。 */
const RAIL_INSET_PX = 6
/** 可滚动端 mask 渐隐带的宽度。 */
const FADE_PX = 24

type TurnPositionStyle = CSSProperties & {
  readonly '--turn-natural-position': string
}

type TurnFrameStyle = CSSProperties & {
  '--turn-natural-height': string
  '--turn-rail-inset': string
  '--turn-scroll-top': string
  '--turn-rail-band'?: string | undefined
}

function itemPosition(index: number): TurnPositionStyle {
  return { '--turn-natural-position': `${String(index * TURN_SPACING_PX)}px` }
}

/** frame 几何（自然高/首尾内边距/内部滚动偏移 + 可选实测 band）。 */
function frameStyle(count: number, scrollTop: number, bandPx: number | null): TurnFrameStyle {
  const style: TurnFrameStyle = {
    '--turn-natural-height': `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    '--turn-rail-inset': `${String(RAIL_INSET_PX)}px`,
    '--turn-scroll-top': `${String(scrollTop)}px`,
  }
  if (bandPx !== null) style['--turn-rail-band'] = `${String(bandPx)}px`
  return style
}

/** 指针 y（视口坐标）→ 刻度项（含滚动偏移补偿 + 端点钳制；rc.1 itemAtPointer）。 */
function itemAtPointer(
  items: readonly StepChatTurnRailItem[],
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): StepChatTurnRailItem | undefined {
  const rect = frame.getBoundingClientRect()
  const offset = clientY - rect.top + scrollTop - RAIL_INSET_PX
  const index = Math.max(0, Math.min(items.length - 1, Math.round(offset / TURN_SPACING_PX)))
  return items[index]
}

/** frame 内部滚动状态（mask 渐隐 + 跟随逻辑同读；rc.1 RailScrollState）。 */
interface RailScrollState {
  readonly top: number
  readonly canScrollUp: boolean
  readonly canScrollDown: boolean
}

const RAIL_AT_REST: RailScrollState = { top: 0, canScrollUp: false, canScrollDown: false }

function railScrollState(scroller: HTMLElement): RailScrollState {
  const top = scroller.scrollTop
  return {
    top,
    canScrollUp: top > 1,
    canScrollDown: top < scroller.scrollHeight - scroller.clientHeight - 1,
  }
}

function sameRailScrollState(left: RailScrollState, right: RailScrollState): boolean {
  return left.top === right.top
    && left.canScrollUp === right.canScrollUp
    && left.canScrollDown === right.canScrollDown
}

function TurnNavigatorRail({ items, activeTurn, onNavigate, t }: TurnNavigatorProps) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null)
  const [scrollState, setScrollState] = useState<RailScrollState>(RAIL_AT_REST)
  // 轴带高（面板滚动视口 clientHeight 实测；null = 首帧未量出，CSS 回退 520px）。
  const [bandPx, setBandPx] = useState<number | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  /** 指针在 rail 上工作时，跟随滚动不得把轴移到手底下。 */
  const pointerInsideRef = useRef(false)
  const previewId = useId()

  const syncScrollState = (): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const next = railScrollState(scroller)
    setScrollState(current => sameRailScrollState(current, next) ? current : next)
  }

  // band 取值：**优先**读面板滚动视口上的 `--dsh-conversation-viewport-height`
  // （批 A（A3）起由 StepChatBody 在 `[data-conversation-scroll]` 上发布，与 rc.1
  // ConversationRoot 的发布位置/变量名完全一致）；变量缺失或不可解析（面板未发布、
  // 宿主树外、旧版本面板）→ 回退自测 parent（= .stepChatScroll）的 clientHeight。
  // 两种来源都要跟随尺寸变化（面板打开/内容跨 max-height 阈值时视口高会变），
  // 故保留 ResizeObserver；首量在 layout effect 内同步完成，绘制前即有真实 band。
  useLayoutEffect(() => {
    const slot = slotRef.current
    const scrollport = slot?.parentElement ?? null
    if (scrollport === null) return
    const measure = (): void => {
      setBandPx(current => {
        const published = Number.parseFloat(
          window.getComputedStyle(scrollport).getPropertyValue('--dsh-conversation-viewport-height'),
        )
        // 只在「宿主确实发布了合法正值」时采用——0/NaN 视为未发布（自测值更可信：
        // 隐藏态视口高本就是 0，两者等价）。
        const next = Number.isFinite(published) && published > 0
          ? published
          : scrollport.clientHeight
        return next === current ? current : next
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(scrollport)
    return () => { observer.disconnect() }
  }, [])

  // 首尾渐隐的触发源：frame 尺寸变化（内容跨轴带阈值）没有 scroll 事件；
  // 刻度数变化也移动内容高度——两个方向都重算一次。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(syncScrollState)
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [])
  useEffect(syncScrollState, [items.length])

  // Keep the active mark visible: centre it whenever it leaves the scrollport,
  // unless the reader's pointer is working the rail.
  useEffect(() => {
    const scroller = scrollerRef.current
    const index = items.findIndex(item => item.turn === activeTurn)
    if (scroller === null || index < 0 || pointerInsideRef.current) return
    const markTop = index * TURN_SPACING_PX + RAIL_INSET_PX
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
    syncScrollState()
  }, [activeTurn, items])

  // 单轮不显示轴：槽位照常挂载（band 自测等 hooks 不依赖刻度存在），零高不占布局。
  if (items.length < 2) return <div ref={slotRef} className={css.slot} />

  const previewIndex = items.findIndex(item => item.turn === previewTurn)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex)
  const previewAtPointer = (event: PointerEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0
    setPreviewTurn(itemAtPointer(items, event.currentTarget, scrollTop, event.clientY)?.turn ?? null)
  }
  const navigateAtPointer = (event: MouseEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0
    const item = itemAtPointer(items, event.currentTarget, scrollTop, event.clientY)
    if (item !== undefined) onNavigate(item)
  }
  const fadeClasses = [css.scroller]
  if (scrollState.canScrollUp) fadeClasses.push(css.fadeTop)
  if (scrollState.canScrollDown) fadeClasses.push(css.fadeBottom)
  return (
    <div ref={slotRef} className={css.slot}>
      <nav
        className={css.frame}
        style={frameStyle(items.length, scrollState.top, bandPx)}
        aria-label={t('chat.turnNavigation.label')}
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerEnter={() => { pointerInsideRef.current = true }}
        onPointerLeave={() => {
          pointerInsideRef.current = false
          setPreviewTurn(null)
        }}
      >
        <div
          ref={scrollerRef}
          className={fadeClasses.join(' ')}
          onScroll={() => { syncScrollState() }}
        >
          <div className={css.marks}>
            {items.map((item, index) => {
              const active = item.turn === activeTurn
              const showingPreview = item.turn === previewTurn
              const classes = [css.mark]
              if (active) classes.push(css.markActive)
              else if (showingPreview) classes.push(css.markPreview)
              return (
                <div key={item.turn} className={css.markPosition} style={itemPosition(index)}>
                  {/* B4a loaded-only：锚点恒为 loaded → 恒用 jump 键（rc.1 的
                      jumpLoad 随 unloaded 剪除）。 */}
                  <button
                    type="button"
                    className={classes.join(' ')}
                    aria-label={t('chat.turnNavigation.jump', { turn: item.turn })}
                    aria-current={active ? 'true' : undefined}
                    aria-describedby={showingPreview ? previewId : undefined}
                    onClick={(event) => {
                      event.stopPropagation()
                      onNavigate(item)
                    }}
                    onFocus={() => { setPreviewTurn(item.turn) }}
                    onBlur={() => { setPreviewTurn(null) }}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div id={previewId} role="tooltip" className={css.preview} style={previewPosition}>
            <div className={css.previewPrompt}>
              {preview.prompt || t('chat.turnNavigation.turn', { turn: preview.turn })}
            </div>
            {preview.response !== '' && <div className={css.previewResponse}>{preview.response}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/**
 * Fixed-pitch rail of every loaded Turn with hover/focus previews. Overflow
 * scrolls inside the frame, gradient fades mark each scrollable end, and the
 * active mark keeps itself in view while the pointer is elsewhere.
 *
 * Memoized because it renders two host elements per Turn while the enclosing
 * view re-renders on every streaming delta: without the guard a long session
 * rebuilds hundreds of marks per commit for a rail that only changes when a
 * Turn is added, removed, or becomes active.
 */
export const TurnNavigator = memo(TurnNavigatorRail)
