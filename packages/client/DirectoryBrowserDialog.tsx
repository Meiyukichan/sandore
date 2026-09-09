/**
 * 目录浏览弹窗（对齐 DSH「添加项目」的 browse 目录选择，简化版）。
 *
 * 底层走 Host 目录能力（`ctx.uiWorkspace.listDirectory/createDirectory`，rc.1
 * UiWorkspaceService）——与 DSH 侧边栏「添加项目」弹窗同一后端，Linux/web 等无
 * 原生目录选择器的环境同样可用（`ctx.uiWorkspace.pickDirectory` 需要 native
 * capability，本弹窗不依赖它）。
 *
 * 交互（对齐 DSH DirectoryBrowser 核心）：打开即列出宿主主目录；左栏为当前层，
 * 单击行 = 选中并预览其子目录到右栏（双栏）；右栏单击 = 下钻一层；面包屑点击
 * 跳回任意祖先；「新建文件夹」在当前选中/层级下创建并选中新目录；隐藏条目默认
 * 不显示（footer 开关可显示）；「打开」确认选中目录（无选中 = 当前层级）。
 *
 * 路径编辑器（照 DSH crumbEditZone/pathInput）：面包屑条右侧铅笔按钮进入编辑
 * 态，种子为当前选中/当前层级 + 尾部分隔符；Enter（IME 组合期守卫）按原文提交
 * 导航（trim 只判空，空串 = 取消），Escape 或焦点离开弹窗卡片取消编辑态；
 * 失败走既有错误行。导航落地照 DSH land()：目标展示链 ≥2 时并发拉取父层级，
 * 双栏落地并在父栏高亮目标（父腿失败/超时先单栏落地，迟到成功原地升级），
 * 因此从 home 出发也能经「/」一层层向上或一步跳到根。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DirectoryBrowserDialog
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button, IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16, IconFolderOpen16,
  IconPlusOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { displayCrumbs, seedPathDraft, separatorOf, submittedPath, visibleEntries } from './directory-browser-model.ts'
import css from './DirectoryBrowserDialog.module.css'
import { ImeSafeInput } from './ime-safe-input.tsx'

/** 浏览弹窗的 browse 能力面（face 注入）。 */
export interface DirectoryBrowseFace {
  /** 列出一个目录层级（缺省 = 宿主主目录）；signal 中止被取代的扫描。 */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /** 在指定父目录下新建一个子目录。 */
  createDirectory(path: string, name: string): Promise<string>
}

/** DirectoryBrowserDialog 的 props。 */
export interface DirectoryBrowserDialogProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 弹窗可见性（宿主控制；每次打开重置到主目录）。 */
  open: boolean
  /** browse 能力面。 */
  browse: DirectoryBrowseFace
  /** 确认选中目录（选中项或当前层级）。 */
  onOpen(path: string): void
  /** 取消关闭。 */
  onClose(): void
}

/** 失败文本：优先业务 message，否则错误原文。 */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 提交型导航等待父腿的时限（照 DSH PARENT_LEG_WAIT_MS）：时限内目标与父层级
 * 作为一帧双栏落地；超时目标先单栏落地，迟到的父腿成功再原地升级为双栏。
 */
const PARENT_LEG_WAIT_MS = 200

/**
 * 目录浏览弹窗。
 * @param props - 可见性 + browse 能力 + 确认/取消回调 + locale。
 * @returns 弹窗元素（关闭时渲染 null）。
 */
export function DirectoryBrowserDialog({ t, open, browse, onOpen, onClose }: DirectoryBrowserDialogProps) {
  // Miller 双栏状态：当前层级 / 选中行 / 选中行的子目录层级。
  const [parent, setParent] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<DirectoryEntry | null>(null)
  const [child, setChild] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 隐藏条目开关（client 侧过滤，每次打开重置）。
  const [showHidden, setShowHidden] = useState(false)
  // 路径编辑态：null = 面包屑模式；字符串 = 正在输入的路径草稿（照 DSH pathDraft）。
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  // 新建文件夹嵌套弹窗状态。
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // 新意图取代旧意图：过期响应不再落地。
  const requestSeq = useRef(0)
  const scanController = useRef<AbortController | null>(null)
  // 打开/关闭代数：上次打开的迟到响应不得污染重开的弹窗。
  const openGeneration = useRef(0)

  /** 新意图生效：作废在途扫描并返回新序号。 */
  const supersede = useCallback((): number => {
    scanController.current?.abort()
    scanController.current = null
    return ++requestSeq.current
  }, [])

  /** 发起一次目录扫描（新 controller，可被取代）。 */
  const launchListing = useCallback((path: string | undefined): { seq: number; scan: Promise<DirectoryListing> } => {
    const seq = supersede()
    const controller = new AbortController()
    scanController.current = controller
    return { seq, scan: browse.listDirectory(path, controller.signal) }
  }, [supersede, browse])

  /** 继续一次扫描（导航的父腿）：沿用当前意图序号，不产生新序号（照 DSH continueScan）。 */
  const continueScan = useCallback((path: string): Promise<DirectoryListing> => {
    const controller = new AbortController()
    scanController.current = controller
    return browse.listDirectory(path, controller.signal)
  }, [browse])

  /**
   * 导航到某层级（面包屑 / 路径输入 / 初始 home），照 DSH land() 语义落地：
   * 目标展示链 ≥2 时以 crumbs.at(-2) 并发拉取父层级，双栏落地并在父栏高亮
   * 目标；父腿失败或超时先单栏落地，迟到的父腿成功原地升级（landed 幂等）。
   * 展示链不足 2（home 自身、文件系统根）没有父层级可并发，直接单栏。
   */
  const navigate = useCallback((path?: string) => {
    const { seq, scan } = launchListing(path)
    setLoading(true)
    setError(null)
    scan.then((target) => {
      if (seq !== requestSeq.current) return
      // 单栏落地（先到先落；双栏提交具 landed 幂等，不会二次落地）。
      let landed = false
      const landSingle = (): void => {
        if (landed || seq !== requestSeq.current) return
        landed = true
        setParent(target)
        setSelected(null)
        setChild(null)
        setLoading(false)
      }
      if (displayCrumbs(target, '').length < 2) {
        landSingle()
        return
      }
      const parentCrumb = target.crumbs.at(-2)
      // 收窄守卫：展示链 ≥2 时倒数第二环必然存在。
      if (parentCrumb === undefined) {
        landSingle()
        return
      }
      continueScan(parentCrumb.path).then((parentLevel) => {
        if (seq !== requestSeq.current) return
        // Windows 解析会保留输入大小写：按平台折叠后匹配，锚定父层级里
        // 目标的真实条目，让选中态比较成立。
        const sep = separatorOf(parentLevel.home)
        const fold = (value: string): string => (sep === '\\' ? value.toLowerCase() : value)
        const match = parentLevel.entries.find((entry: DirectoryEntry) => fold(entry.path) === fold(target.path))
        // 父窗口截断找不到目标等情形：保持单栏落地，升级不能孤儿化选区。
        if (match === undefined) {
          landSingle()
          return
        }
        landed = true
        setParent(parentLevel)
        setSelected(match)
        setChild(target)
        setLoading(false)
      }, () => {
        // 父腿失败（含被新意图中止）不上屏：目标本身列举成功，无人要求看父层。
        landSingle()
      })
      // 提交型导航限时：不被迟滞的父腿绑架，超时先落地。
      window.setTimeout(landSingle, PARENT_LEG_WAIT_MS)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
    })
  }, [launchListing, continueScan])

  /** 选中左栏一行并预览其子目录到右栏。 */
  const select = useCallback((entry: DirectoryEntry) => {
    const { seq, scan } = launchListing(entry.path)
    // 编辑态下点行 = 采纳该行并收起编辑器（照 DSH select：草稿完成使命）。
    setPathDraft(null)
    setSelected(entry)
    setChild(null)
    setLoading(true)
    setError(null)
    scan.then((next) => {
      if (seq !== requestSeq.current) return
      setChild(next)
      setLoading(false)
    }, (reason: unknown) => {
      if (seq !== requestSeq.current) return
      setLoading(false)
      setError(failureText(reason))
      // 不可读的选中项不能成为提交目标：回退到单栏。
      setSelected(null)
    })
  }, [launchListing])

  /** 右栏一行下钻：右栏升为当前层并选中该行。 */
  const advance = useCallback((entry: DirectoryEntry) => {
    if (child === null) return
    setParent(child)
    select(entry)
  }, [child, select])

  // 每次打开从主目录开始；关闭作废在途响应（含编辑态草稿）。
  useEffect(() => {
    openGeneration.current += 1
    if (open) {
      setParent(null)
      setSelected(null)
      setChild(null)
      setShowHidden(false)
      setPathDraft(null)
      navigate()
      return
    }
    supersede()
    setLoading(false)
    setError(null)
    setPathDraft(null)
    setFolderDraft(null)
    setCreateError(null)
  }, [open, navigate, supersede])

  /** 新建/打开动作的目标目录：选中项，否则当前层级。 */
  const targetPath = selected?.path ?? parent?.path ?? null

  /** 确认新建文件夹：创建后刷新当前层并选中新目录。 */
  const confirmCreate = (): void => {
    if (targetPath === null || folderDraft === null || creatingFolder) return
    const name = folderDraft
    if (name.trim() === '') return
    setCreatingFolder(true)
    setCreateError(null)
    const generation = openGeneration.current
    void browse.createDirectory(targetPath, name).then((createdPath) => {
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setFolderDraft(null)
      const { seq, scan } = launchListing(targetPath)
      setLoading(true)
      setError(null)
      scan.then((level) => {
        if (seq !== requestSeq.current) return
        setParent(level)
        setLoading(false)
        select({ name, path: createdPath, hidden: false })
      }, (reason: unknown) => {
        if (seq !== requestSeq.current) return
        setLoading(false)
        setError(failureText(reason))
      })
    }, (reason: unknown) => {
      if (generation !== openGeneration.current) return
      setCreatingFolder(false)
      setCreateError(failureText(reason))
    })
  }

  // 卸载作废一切（HMR/替换安全）。
  useEffect(() => () => {
    requestSeq.current += 1
    openGeneration.current += 1
    scanController.current?.abort()
  }, [])

  if (!open) return null

  const crumbSource = child ?? parent
  const crumbs = crumbSource === null ? [] : displayCrumbs(crumbSource, t('cwdBrowse.home'))
  const parentInert = creatingFolder || folderDraft !== null
  // 路径草稿未提交时，footer 的目标（选中/层级）相对头部已过期：提交类动作停用。
  const draftPending = pathDraft !== null
  const targetName = selected?.name
    ?? (parent === null ? '' : (displayCrumbs(parent, t('cwdBrowse.home')).at(-1)?.name ?? parent.path))

  return (
    <Modal
      open={open}
      onClose={() => { if (!parentInert) onClose() }}
      title={t('cwdBrowse.title')}
      className={css.dialog ?? ''}
      headless
    >
      {/* 路径编辑的取消监听在卡片层而非输入框（照 DSH editorScope）：焦点 Tab
          到行上后 Escape 仍要收起编辑器（而不是关掉弹窗），焦点离开卡片也要
          取消。display:flex 让 header/content/footer 保持原有布局。 */}
      <div
        className={css.editorScope}
        onKeyDown={(event) => {
          // stopPropagation 拦在 Modal 的 document 监听之前：编辑态 Escape
          // 只收起编辑器，不把整个弹窗关掉。
          if (event.key !== 'Escape' || pathDraft === null) return
          event.stopPropagation()
          setPathDraft(null)
        }}
        onBlur={(event) => {
          // 编辑中焦点离开弹窗卡片 = 放弃编辑（照 DSH）。守卫的不取消路径：
          // 窗口/标签页失焦（document 不再持有焦点）；焦点在卡片内移动
          // （Tab 到行或 footer 开关）。
          if (pathDraft === null) return
          if (!document.hasFocus()) return
          const card = event.currentTarget.closest('[role="dialog"]')
          if (card === null) return
          if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return
          setPathDraft(null)
        }}
      >
        <div className={css.header}>
          <h2 className={css.title}>{t('cwdBrowse.title')}</h2>
          <div className={css.crumbBar}>
            {pathDraft === null ? (
              <>
                <span className={css.crumbTrail} role="navigation">
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className={css.crumbSeat}>
                      {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                      <button
                        type="button"
                        className={css.crumb}
                        disabled={parentInert || loading}
                        onClick={() => { navigate(crumb.path) }}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </span>
                {/* 面包屑条右侧铅笔按钮：进入路径编辑态（照 DSH crumbEditZone
                    的铅笔入口）。home 列举失败（无层级）时仍可进入——此时输入
                    绝对路径是唯一前进路径，种子为空串。 */}
                <button
                  type="button"
                  className={css.crumbEditBtn}
                  aria-label={t('cwdBrowse.editPath')}
                  title={t('cwdBrowse.editPath')}
                  disabled={parentInert}
                  onClick={() => { setPathDraft(seedPathDraft(selected?.path ?? parent?.path, parent?.home ?? '')) }}
                >
                  <IconEditOutline16 size={14} />
                </button>
              </>
            ) : (
              /* 路径输入框（ImeSafeInput 复用 DSH Input 样式 + IME 守卫）：
                  Enter 提交、Escape 落到卡片层取消。 */
              <ImeSafeInput
                className={css.pathInput}
                value={pathDraft}
                onCommit={setPathDraft}
                autoFocus
                aria-label={t('cwdBrowse.editPath')}
                onKeyDown={(event) => {
                  // IME 组合期间的 Enter 是选词确认，isComposing 守卫不提交；
                  // trim 只判空，空串 = 取消（保持编辑态由卡片 Escape 处理，
                  // 这里只负责「有内容才导航」），Host 收到原文。
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    const submitted = submittedPath(pathDraft)
                    if (submitted !== null) {
                      setPathDraft(null)
                      navigate(submitted)
                    }
                  }
                }}
              />
            )}
          </div>
        </div>

        <div className={css.content}>
          <div className={css.millerRow}>
            {parent !== null && (
              <div className={css.column} role="list">
                {visibleEntries(parent.entries, showHidden).map((entry) => {
                  const isSelected = entry.path === selected?.path
                  return (
                    <span key={entry.path} role="listitem" className={css.rowSeat}>
                      <button
                        type="button"
                        aria-current={isSelected || undefined}
                        className={`${css.row} ${isSelected ? css.rowSelected : ''}`}
                        disabled={parentInert}
                        onClick={() => { select(entry) }}
                      >
                        {isSelected
                          ? <IconFolderOpen16 size={16} className={css.rowIconSelected} />
                          : <IconFolderClose16 size={16} className={css.rowIcon} />}
                        <span className={css.rowName}>{entry.name}</span>
                        <IconChevronRightOutline14 size={12} className={css.rowChevron} />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            {selected !== null && <span className={css.divider} />}
            {selected !== null && child !== null && (
              <div className={css.column} role="list">
                {visibleEntries(child.entries, showHidden).map((entry) => (
                  <span key={entry.path} role="listitem" className={css.rowSeat}>
                    <button
                      type="button"
                      className={css.row}
                      disabled={parentInert}
                      onClick={() => { advance(entry) }}
                    >
                      <IconFolderClose16 size={16} className={css.rowIcon} />
                      <span className={css.rowName}>{entry.name}</span>
                      <IconChevronRightOutline14 size={12} className={css.rowChevron} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          {loading && <div className={css.status} role="status">{t('cwdBrowse.loading')}</div>}
          {(parent?.truncated === true || child?.truncated === true)
            && <div className={css.status} role="status">{t('cwdBrowse.truncated')}</div>}
          {error !== null && <div className={css.error} role="alert">{error}</div>}
        </div>

        <div className={css.footerBar}>
          <Button
            variant="outline"
            icon={<IconPlusOutline16 size={14} />}
            disabled={parent === null || loading || parentInert || draftPending}
            onClick={() => { setFolderDraft(''); setCreateError(null) }}
          >
            {t('cwdBrowse.newFolder')}
          </Button>
          <button
            type="button"
            className={`${css.showHiddenToggle} ${showHidden ? css.showHiddenToggleActive : ''}`}
            aria-pressed={showHidden}
            disabled={parentInert}
            onClick={() => { setShowHidden(value => !value) }}
          >
            {t('cwdBrowse.showHidden')}
            {showHidden && <IconCheckOutline16 size={14} />}
          </button>
          <span className={css.footerGap} />
          <Button variant="outline" className={css.footerAction} disabled={parentInert} onClick={onClose}>
            {t('cwdBrowse.cancel')}
          </Button>
          <Button
            variant="primary"
            className={css.footerAction}
            disabled={targetPath === null || loading || parentInert || draftPending}
            onClick={() => { if (targetPath !== null) onOpen(targetPath) }}
          >
            {t('cwdBrowse.open')}
          </Button>
        </div>
      </div>

      {/* 嵌套新建文件夹弹窗。 */}
      <Modal
        open={folderDraft !== null}
        onClose={() => { if (!creatingFolder) setFolderDraft(null) }}
        title={t('cwdBrowse.newFolder')}
        className={css.createDialog ?? ''}
        headless
      >
        <div className={css.createBody}>
          <h3 className={css.createTitle}>{t('cwdBrowse.newFolder')}</h3>
          <p className={css.createIn}>{t('cwdBrowse.createIn', { name: targetName })}</p>
          <input
            className={css.createInput}
            value={folderDraft ?? ''}
            aria-label={t('cwdBrowse.folderName')}
            placeholder={t('cwdBrowse.untitledFolder')}
            autoFocus
            disabled={creatingFolder}
            onChange={event => { setFolderDraft(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (!creatingFolder) setFolderDraft(null)
              }
            }}
          />
          {createError !== null && <div className={css.error} role="alert">{createError}</div>}
          <div className={css.createActions}>
            <Button variant="ghost" size="sm" disabled={creatingFolder} onClick={() => { setFolderDraft(null) }}>
              {t('cwdBrowse.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={creatingFolder || (folderDraft ?? '').trim() === ''} onClick={confirmCreate}>
              {creatingFolder ? t('cwdBrowse.creating') : t('cwdBrowse.create')}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
