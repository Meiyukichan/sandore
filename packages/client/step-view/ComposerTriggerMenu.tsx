/**
 * ComposerTriggerMenu.tsx（批 B3）：step 面板 composer 的触发词候选浮层（`@step` 等）。
 *
 * 视觉/结构/DOM 逐条对齐 DSH 0.1.2-rc.1 `ui-input-trigger/src/client/MenuView.tsx`
 * （只读参考 deepseek-harness；**不 import 其运行时**，只复用 ui-primitives 的图标，
 * 与 ComposerBar 的自绘壳同源）：
 * - DOM：`<div data-trigger-menu>`（外层，真实高度由内联/样式上限约束）→ 可选面包屑
 *   `<nav>` → `<div role="listbox">` → 每个 source 一组；候选行是 `<button role="option">`，
 *   小节标题与分组标题是 `role="presentation"`；
 * - 交互：候选行用 **mousedown**（combobox 模式：编辑器不失焦）+ `preventDefault` 选中；
 *   行上 `mousemove`（不是 mouseenter）驱动共享高亮；菜单外 pointerdown 关闭
 *   （面板 composer 卡内的点击不算外点）；
 * - 高亮：唯一来源是控制器的 `highlight`（键盘 ↑↓ 与指针共用），DOM 用
 *   `aria-selected` + `.active` 表达；键盘移动后主动把活动行滚进视野
 *   （焦点始终在编辑器里，浏览器不会自动滚）；
 * - 关闭：`state.open === false` → 渲染 null（与 DSH 同：浮层常挂、内容按需）；
 *   连续两次渲染都无可见行（全空组）→ 同样渲染 null（DSH 由 reducer 关菜单，
 *   这里只是渲染侧的兜底）。
 *
 * 额外锚点 `data-step-composer-menu`：给 sandore 自己的 e2e/定位用（DSH 同款
 * `data-trigger-menu` 保留，便于断言与宿主菜单同一族）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/ComposerTriggerMenu
 */
import { Fragment, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import {
  stepComposerMenuCrumbNavsOf,
  stepComposerMenuRowsOf,
  type StepComposerMenuCrumbLike,
  type StepComposerMenuStateLike,
  type StepComposerTriggerControllerLike,
} from './composer-trigger-menu.ts'
import {
  BROWSE_GLYPH_PATHS,
  FOLDER_GLYPH_PATH,
  FOLDER_GLYPH_TRANSFORM,
  SESSION_GLYPH_PATH,
} from './reference-glyph-data.ts'
import css from './composer-trigger-menu.module.css'

/** 无面包屑面的稳定空值（避免每次渲染换引用 → useSyncExternalStore 抖动）。 */
const EMPTY_HEADERS: ReadonlyMap<string, readonly StepComposerMenuCrumbLike[]> = new Map()
/** 无可观察面时的空订阅（headers 缺省）。 */
const NO_SUBSCRIBE = (): (() => void) => () => undefined

/** 浮层 props。 */
export interface ComposerTriggerMenuProps {
  /** 该会话的触发词控制器（`stepComposerTriggerOf(sessionId)`；缺失时上层不渲染本组件）。 */
  readonly controller: StepComposerTriggerControllerLike
  /** 面板字典（加载中/列表 aria/面包屑一族）。 */
  readonly t: TranslateNS<'sandore'>
  /**
   * 分组标题翻译（缺省 = 原名）。
   *
   * 分组名是**其它插件**的 source 名（`@file`/`@skill`/…），其文案在 DSH 的
   * `slash.menu` 命名空间里；装配处把该命名空间的翻译函数注入（见 client/index.ts），
   * 缺失时回退原名——与 DSH 未注册键的行为一致。
   */
  readonly titleOf?: ((source: string) => string) | undefined
}

/**
 * 渲染候选浮层。
 * @param props - 控制器 + 字典 + 分组标题翻译。
 * @returns 浮层元素；菜单关闭或无可见行时为 null。
 */
export function ComposerTriggerMenu({ controller, t, titleOf }: ComposerTriggerMenuProps): ReactNode {
  const menu = controller.menu
  const state = useSyncExternalStore(
    useCallback(listener => menu.subscribe(listener), [menu]),
    useCallback(() => menu.getSnapshot(), [menu]),
    useCallback((): StepComposerMenuStateLike => ({ open: false, groups: [], highlight: null }), []),
  )
  const headers = controller.headers
  const crumbs = useSyncExternalStore(
    headers === undefined ? NO_SUBSCRIBE : useCallback(listener => headers.subscribe(listener), [headers]),
    headers === undefined ? () => EMPTY_HEADERS : useCallback(() => headers.getSnapshot(), [headers]),
    () => EMPTY_HEADERS,
  )
  const listRef = useRef<HTMLDivElement | null>(null)

  const open = state.open
  // 焦点留在编辑器里（combobox 模式），浏览器不会替我们把活动行滚进视野——这里补。
  const activeId = state.highlight === null
    ? null
    : rowsActiveId(state)
  useEffect(() => {
    if (activeId === null) return
    const target = document.getElementById(activeId)
    // jsdom（单测）没有 scrollIntoView；真实浏览器有。
    if (target !== null && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' })
    }
  }, [activeId])

  // 外点关闭：菜单外且 composer 卡外的 pointerdown 才 dismiss（点输入框/发送钮不关）。
  const dismiss = controller.dismiss
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (listRef.current?.contains(target) === true) return
      const card = listRef.current?.closest('[data-step-chat-composer]')
      if (card?.contains(target) === true) return
      dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open, dismiss])

  if (!open) return null
  const rows = stepComposerMenuRowsOf(state, titleOf)
  const navs = stepComposerMenuCrumbNavsOf(state, crumbs)
  if (rows.length === 0 && navs.length === 0) return null

  const pick = controller.pick
  const hover = controller.hover
  const pickCrumb = controller.pickCrumb

  return (
    <div ref={listRef} className={css.menu} data-trigger-menu="" data-step-composer-menu="">
      {navs.map(nav => (
        <nav key={`crumb-${nav.source}`} className={css.crumbs} aria-label={t('step.mention.menu.crumbsAria')}>
          {nav.crumbs.map((crumb, index) => (
            <Fragment key={`${String(index)}-${crumb.value}`}>
              {index > 0 && <span className={css.crumbSeparator} aria-hidden><ChevronGlyph /></span>}
              <button
                type="button"
                className={crumb.current === true ? `${css.crumb} ${css.crumbCurrent}` : css.crumb}
                aria-current={crumb.current === true ? 'location' : undefined}
                disabled={crumb.current === true}
                // mousedown 而非 click：编辑器保持焦点（与候选行同款）。
                onMouseDown={(event) => {
                  event.preventDefault()
                  pickCrumb?.(nav.source, index)
                }}
              >
                {crumb.label}
              </button>
            </Fragment>
          ))}
        </nav>
      ))}
      <div
        className={css.viewport}
        role="listbox"
        aria-label={t('step.mention.menu.suggestionsAria')}
        aria-activedescendant={activeId ?? undefined}
      >
        {rows.map((row) => {
          if (row.kind === 'group-title') {
            return (
              <div key={`group-${row.source}`} className={css.groupTitle} role="presentation" data-source={row.source}>
                {row.label}
              </div>
            )
          }
          if (row.kind === 'skeleton') {
            return (
              <div key={`skeleton-${row.source}`} role="status" aria-label={t('step.mention.menu.loading')} data-source={row.source}>
                <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '32%' }} /></div>
                <div className={css.skeletonRow}><span className={css.skeletonBar} style={{ width: '48%' }} /></div>
              </div>
            )
          }
          return (
            <Fragment key={row.id}>
              {row.sectionTitle === undefined
                ? null
                : <div className={css.sectionTitle} role="presentation">{row.sectionTitle}</div>}
              <button
                id={row.id}
                type="button"
                role="option"
                aria-selected={row.active}
                className={row.active ? `${css.item} ${css.active}` : css.item}
                data-trigger-option={row.item.name}
                data-source={row.source}
                // mousedown：阻止默认以保住编辑器焦点，且选中发生在任何 blur 清理之前。
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(row.source, row.index)
                }}
                // mousemove 而非 mouseenter：真实指针移动才抢高亮（键盘滚动列表时
                // 停在原地的指针不该把高亮抢回去）。
                onMouseMove={row.active ? undefined : () => { hover(row.source, row.index) }}
              >
                {row.item.icon === undefined
                  ? null
                  : (
                    <span className={css.itemIcon} aria-hidden>
                      <ReferenceGlyph kind={row.item.icon} />
                    </span>
                  )}
                <span className={css.itemName}>{row.item.name}</span>
                {row.item.description === undefined
                  ? null
                  : <span className={css.itemDescription}>{row.item.description}</span>}
                {row.item.drill === true
                  ? (
                    <span className={css.trailing}>
                      <span className={css.drillHintText} aria-hidden>{t('step.mention.menu.drillHint')}</span>
                      <kbd className={css.drillHint} aria-hidden>{t('step.mention.menu.drillKey')}</kbd>
                      <span
                        role="button"
                        aria-label={t('step.mention.menu.drillAria')}
                        className={css.drill}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          pick(row.source, row.index, 'drill')
                        }}
                      >
                        <ChevronGlyph />
                      </span>
                    </span>
                  )
                  : null}
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 候选行前置的引用图标（DSH `ReferenceIcon` 的三个域：file / folder / session）。
 *
 * 字形 `d` 从 ui-primitives 的发布产物**逐字拷贝**（见 reference-glyph-data.ts 的
 * 来源与理由）——视觉与 DSH 一致，但不 import 其运行时（该包发布产物顶层 import
 * `*.module.css`，vitest 直接加载会整文件失败；输入条路径也不该为此多背依赖）。
 * @param props - 引用域（`@step` 用 'session'，与 ui-reference 的会话引用同族）。
 * @returns 16px 当前色字形。
 */
function ReferenceGlyph({ kind }: { readonly kind: 'file' | 'folder' | 'session' }): ReactNode {
  if (kind === 'folder') {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden>
        <path transform={FOLDER_GLYPH_TRANSFORM} d={FOLDER_GLYPH_PATH} fill="currentColor" />
      </svg>
    )
  }
  if (kind === 'file') {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden>
        {BROWSE_GLYPH_PATHS.map(path => <path key={path} d={path} fill="currentColor" />)}
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden>
      <path d={SESSION_GLYPH_PATH} fill="currentColor" />
    </svg>
  )
}

/** 活动行的 DOM id（aria-activedescendant 目标）。 */
function rowsActiveId(state: StepComposerMenuStateLike): string | null {
  const highlight = state.highlight
  if (highlight === null) return null
  return `dsh-slash-option-${highlight.source}-${highlight.index}`
}

/**
 * 下钻行的箭头字形（DSH 用 ui-primitives 的 IconChevronRightOutline14；此处内联同一
 * 几何的 14px 右向 chevron，避免为本行多引一个图标依赖）。
 * @returns chevron svg。
 */
function ChevronGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
      <path
        d="M5.2 2.6 9.6 7l-4.4 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
