/**
 * TreeNav：执行态左栏树形导航（workflow → stage → step → result/artifact）。
 *
 * 风格照 DSH `ui-workflow-run` WorkflowRunPanel：32px run/phase 行、24px
 * member 行、细线 chevron（IconChevronRightOutline14 / Down）、16px 逐级缩进。
 * 状态一律用**左侧状态点**（chevron 后、标题前），右侧无任何文字。默认全部
 * 展开；result/artifact 叶子点击 → 打开右栏预览；running Step 可点跳子会话。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/TreeNav
 */
import { useState } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconSparkle16,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import type { RunTreeNode } from './run-view-model.ts'
import css from './tree-nav.module.css'

/** 叶子节点点击载荷（预览目标）。 */
export interface TreeLeafSelection {
  /** 叶子节点 id（供高亮匹配）。 */
  readonly leafId: string
  readonly kind: 'result' | 'artifact'
  readonly stepId: string
  readonly name: string
  readonly meta?: string | undefined
  readonly text?: string | undefined
}

/** TreeNav 接收的 props。 */
export interface TreeNavProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 树形导航数据（buildRunTree 派生）。 */
  tree: readonly RunTreeNode[]
  /** 当前预览叶子 id（高亮）。 */
  activePreviewId: string | null
  /** 点击叶子 → 打开右栏预览。 */
  onSelectLeaf(selection: TreeLeafSelection): void
  /** 跳子代理会话（Step 行）。 */
  onOpenChild(childId: string): void
}

/** 状态 → StateDotState（DagRun/Step 7+7 态统一折入四态；缺省折入 warning）。 */
function dotState(status: RunTreeNode['status']): StateDotState {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'running':
    case 'interacting':
      return 'ongoing'
    case undefined:
    case 'pending':
    case 'aborted':
    case 'paused':
    case 'blocked':
    case 'ready':
      return 'warning'
  }
}

/** 可折叠行：chevron + 状态点 + 标题 +（可选行尾按钮），点击整行展开/折叠。 */
function DisclosureRow({ node, className, headerClassName, leadingClassName, titleClassName, alwaysShowChevron, trailing, children }: {
  readonly node: RunTreeNode
  readonly className?: string | undefined
  readonly headerClassName: string | undefined
  readonly leadingClassName: string | undefined
  readonly titleClassName: string | undefined
  /**
   * 始终显示 chevron（即使暂无子节点）——step 行专用：running 的 step 尚无
   * result/artifact 叶子，若用占位符会与产物叶子视觉混淆（看起来像上一个 step 的产物）。
   */
  readonly alwaysShowChevron?: boolean | undefined
  /** 行尾元素（如 running step 的跳子会话按钮）。 */
  readonly trailing?: React.ReactNode
  readonly children?: React.ReactNode
}) {
  const hasChildren = (node.children ?? []).length > 0
  // 默认全部展开（用户要求）；workflow/stage/step 均可点击整行切换展开/折叠。
  const [open, setOpen] = useState(true)
  const expandable = hasChildren || alwaysShowChevron === true
  return (
    <div className={className} data-open={open || undefined}>
      <div
        className={headerClassName}
        data-disclosure-row
        data-expandable={expandable || undefined}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(value => !value)
          }
        }}
      >
        {/* 最左：chevron（展开变向下；无子节点且非 alwaysShowChevron 用占位保持对齐） */}
        <span className={leadingClassName}>
          {expandable
            ? (open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />)
            : <span className={css.chevronPlaceholder} />}
        </span>
        {/* 状态点（左侧，紧随 chevron） */}
        <span className={css.dotSlot}><StateDot state={dotState(node.status)} /></span>
        <span className={titleClassName}>{node.name}</span>
        {trailing}
      </div>
      {open && children}
    </div>
  )
}

/** Workflow 根行：32px、模块底色、chevron + 状态点 + 名称。 */
function WorkflowRow({ node, children }: {
  readonly node: RunTreeNode
  readonly children: React.ReactNode
}) {
  return (
    <DisclosureRow
      node={node}
      className={css.workflow}
      headerClassName={css.workflowHeader}
      leadingClassName={css.workflowLeading}
      titleClassName={css.workflowTitle}
    >
      {children}
    </DisclosureRow>
  )
}

/** Stage 行：32px、无底、缩进；chevron + 状态点 + 名称。 */
function StageRow({ node, children }: {
  readonly node: RunTreeNode
  readonly children: React.ReactNode
}) {
  return (
    <DisclosureRow
      node={node}
      className={css.stage}
      headerClassName={css.stageHeader}
      leadingClassName={css.stageLeading}
      titleClassName={css.stageTitle}
    >
      {children}
    </DisclosureRow>
  )
}

/** Step 行：24px、chevron + 状态点 + 名称 +（running 跳子会话按钮），叶子随展开。 */
function StepRow({ node, onOpenChild, t, children }: {
  readonly node: RunTreeNode
  readonly onOpenChild: (childId: string) => void
  readonly t: TranslateNS<'sandore'>
  readonly children?: React.ReactNode
}) {
  const navigable = node.status === 'running' && node.childId !== undefined
  return (
    <DisclosureRow
      node={node}
      headerClassName={css.memberHeader}
      leadingClassName={css.memberLeading}
      titleClassName={css.memberLabel}
      // step 行始终显示 chevron：running 段尚无 result/artifact 叶子，占位符会让它
      // 看起来像产物叶子（与上一个 step 的产物混淆）。
      alwaysShowChevron
      trailing={navigable ? (
        <button
          type="button"
          className={css.jump}
          title={t('step.open', { name: node.name })}
          aria-label={t('step.open', { name: node.name })}
          onClick={event => {
            event.stopPropagation()
            onOpenChild(node.childId as string)
          }}
        >
          ↗
        </button>
      ) : undefined}
    >
      {children}
    </DisclosureRow>
  )
}

/** 文件类型分类（按 basename 扩展名）。 */
type FileKind = 'markdown' | 'image' | 'code' | 'data' | 'doc' | 'archive' | 'other'

/** 按扩展名归类文件类型（未知扩展名 → other）。 */
function fileKindOf(name: string): FileKind {
  const base = name.toLowerCase()
  const dot = base.lastIndexOf('.')
  const ext = dot === -1 ? '' : base.slice(dot + 1)
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image'
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'sh', 'ps1', 'vue'].includes(ext)) return 'code'
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'csv'].includes(ext)) return 'data'
  if (['txt', 'doc', 'docx', 'pdf', 'rst'].includes(ext)) return 'doc'
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'archive'
  return 'other'
}

/** VSCode 风格类型色（文件轮廓保持灰色 currentColor，内部符号用类型色）。 */
function kindColorOf(name: string, kind: FileKind): string {
  const base = name.toLowerCase()
  if (kind === 'code') {
    if (base.endsWith('.ts') || base.endsWith('.tsx') || base.endsWith('.mts')) return '#3178c6'
    if (base.endsWith('.js') || base.endsWith('.jsx') || base.endsWith('.mjs')) return '#f1e05a'
    if (base.endsWith('.py')) return '#3572a5'
    if (base.endsWith('.go')) return '#00add8'
    if (base.endsWith('.rs')) return '#dea584'
    if (base.endsWith('.css')) return '#563d7c'
    if (base.endsWith('.html') || base.endsWith('.vue')) return base.endsWith('.vue') ? '#41b883' : '#e34c26'
    if (base.endsWith('.sh') || base.endsWith('.ps1') || base.endsWith('.bash')) return '#89e051'
    if (base.endsWith('.java')) return '#b07219'
    if (base.endsWith('.c') || base.endsWith('.cpp') || base.endsWith('.h')) return '#555555'
    return '#3572a5'
  }
  if (kind === 'data') {
    if (base.endsWith('.yaml') || base.endsWith('.yml')) return '#cb171e'
    if (base.endsWith('.xml')) return '#e37933'
    return '#cbcb41'
  }
  switch (kind) {
    case 'markdown': return '#519aba'
    case 'image': return '#e37933'
    case 'archive': return '#af8743'
    case 'doc': return '#848484'
    default: return '#848484'
  }
}

/** 文件类型图标：VSCode 语言徽标风格——已知类型 = 彩色圆角徽标 + 白色符号（无文件框）；
 *  未知类型（other）= 灰色文件轮廓（VSCode 未知文件样式）。 */
function FileTypeGlyph({ name }: { readonly name: string }) {
  const kind = fileKindOf(name)
  if (kind === 'other') {
    return (
      <svg width="14" height="14" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <path d="M3 1h4.5L10 3.5V10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M7.5 1v2.5H10" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      </svg>
    )
  }
  const color = kindColorOf(name, kind)
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="1" y="1" width="10" height="10" rx="2.5" fill={color} />
      {kind === 'image' && <path d="M4 8l1.3-1.5 1.2 1.3.9-1L8.6 8H4Z" stroke="#fff" strokeWidth="1.1" strokeLinejoin="round" />}
      {kind === 'code' && <path d="M4.5 5.2 3.2 6.4l1.3 1.2M7.5 5.2 8.8 6.4 7.5 7.6" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'data' && <path d="M5 5c-.5.3-.8.8-.8 1.6 0 .8.3 1.3.8 1.6M7 5c.5.3.8.8.8 1.6 0 .8-.3 1.3-.8 1.6" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />}
      {kind === 'doc' && <path d="M4 5.4h4M4 7.2h3" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />}
      {kind === 'markdown' && <path d="M4.2 4.9v3.2L6 6.7l1.8 1.4V4.9" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'archive' && <path d="M3.8 8.4h4.4" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />}
    </svg>
  )
}

/** 叶子（result/artifact）：图标与 step 状态点同列对齐，点击打开右栏预览。 */
function LeafRow({ node, activePreviewId, onSelectLeaf, t }: {
  readonly node: RunTreeNode
  readonly activePreviewId: string | null
  readonly onSelectLeaf: (selection: TreeLeafSelection) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const active = activePreviewId === node.id
  return (
    <button
      type="button"
      className={`${css.leafRow} ${active ? css.leafActive : ''}`}
      data-tree-leaf
      onClick={() => {
        onSelectLeaf({
          leafId: node.id,
          kind: node.type === 'result' ? 'result' : 'artifact',
          stepId: node.stepId ?? '',
          name: node.name === '' ? t('run.result') : node.name,
          meta: node.meta,
          text: node.text,
        })
      }}
    >
      <span className={css.leafIcon}>
        {node.type === 'result' ? <IconSparkle16 /> : <FileTypeGlyph name={node.name} />}
      </span>
      <span className={css.leafLabel}>{node.name === '' ? t('run.result') : node.name}</span>
      {node.meta !== undefined && <span className={css.leafMeta}>{node.meta}</span>}
    </button>
  )
}

/** 递归渲染：workflow → stage → step → 叶子。 */
function RenderNode({ node, depth, activePreviewId, onSelectLeaf, onOpenChild, t }: {
  readonly node: RunTreeNode
  readonly depth: number
  readonly activePreviewId: string | null
  readonly onSelectLeaf: (selection: TreeLeafSelection) => void
  readonly onOpenChild: (childId: string) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const children = node.children ?? []
  if (node.type === 'workflow') {
    return (
      <WorkflowRow node={node}>
        <div className={css.stageList}>
          {children.map(child => (
            <RenderNode key={child.id} node={child} depth={depth + 1} activePreviewId={activePreviewId} onSelectLeaf={onSelectLeaf} onOpenChild={onOpenChild} t={t} />
          ))}
        </div>
      </WorkflowRow>
    )
  }
  if (node.type === 'stage') {
    return (
      <StageRow node={node}>
        <div className={css.memberList}>
          {children.map(child => (
            <RenderNode key={child.id} node={child} depth={depth + 1} activePreviewId={activePreviewId} onSelectLeaf={onSelectLeaf} onOpenChild={onOpenChild} t={t} />
          ))}
        </div>
      </StageRow>
    )
  }
  if (node.type === 'step') {
    const leaves = children
    return (
      <StepRow node={node} onOpenChild={onOpenChild} t={t}>
        {leaves.length > 0 && (
          <div className={css.leafList}>
            {leaves.map(leaf => (
              <LeafRow key={leaf.id} node={leaf} activePreviewId={activePreviewId} onSelectLeaf={onSelectLeaf} t={t} />
            ))}
          </div>
        )}
      </StepRow>
    )
  }
  return null
}

/** 渲染树形导航（照 DSH WorkflowRunPanel；左上角标题 + 树身顶部留白）。 */
export function TreeNav({ t, tree, activePreviewId, onSelectLeaf, onOpenChild }: TreeNavProps) {
  return (
    <nav className={css.root} aria-label={t('run.nav')} data-sandore-tree-nav>
      <div className={css.titleBar}>
        <span className={css.title}>{t('run.nav')}</span>
      </div>
      <div className={css.scroll}>
        <div className={css.body}>
          {tree.map(node => (
            <RenderNode key={node.id} node={node} depth={0} activePreviewId={activePreviewId} onSelectLeaf={onSelectLeaf} onOpenChild={onOpenChild} t={t} />
          ))}
        </div>
      </div>
    </nav>
  )
}
