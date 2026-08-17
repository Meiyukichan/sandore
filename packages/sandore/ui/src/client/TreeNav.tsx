/**
 * TreeNav：执行态左栏树形导航（workflow → stage → step → result/artifact 叶子）。
 *
 * DSH DisclosureRow 风格：chevron + 状态点 + 缩进 + 折叠。todo 态 Stage/Step 默认
 * 折叠；result/artifact 叶子点击 → `onSelectLeaf` 打开右栏预览；Step 行有子代理
 * 会话时 hover 显示 ↗ 跳转按钮。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/TreeNav
 */
import { useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** 跳子代理会话（Step 行 ↗）。 */
  onOpenChild(childId: string): void
}

/** 状态 → StateDotState（DagRun/Step 7+7 态统一折入四态；缺省折入 warning）。 */
function treeDotState(status: RunTreeNode['status']): StateDotState {
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

/** 单行渲染（含子节点递归）。 */
function TreeRow({ node, depth, activePreviewId, onSelectLeaf, onOpenChild, t }: {
  readonly node: RunTreeNode
  readonly depth: number
  readonly activePreviewId: string | null
  readonly onSelectLeaf: (selection: TreeLeafSelection) => void
  readonly onOpenChild: (childId: string) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const children = node.children ?? []
  const hasChildren = children.length > 0
  // 默认折叠：未开始（ready/blocked）与已完成（completed）的 Stage/Step 收起；
  // 运行中/待交互/失败/暂停展开；workflow 根与叶子不折叠。
  const [collapsed, setCollapsed] = useState(
    (node.type === 'stage' || node.type === 'step')
      ? (node.status !== 'running' && node.status !== 'interacting' && node.status !== 'failed' && node.status !== 'paused')
      : false,
  )

  if (node.type === 'result' || node.type === 'artifact') {
    const active = activePreviewId === node.id
    return (
      <div
        className={`${css.leaf} ${active ? css.leafActive : ''}`}
        style={{ paddingLeft: 8 + depth * 16 + 16 }}
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
        <span className={css.leafIcon}>{node.type === 'result' ? '📝' : '📄'}</span>
        <span className={css.leafLabel}>{node.name === '' ? t('run.result') : node.name}</span>
        {node.meta !== undefined && <span className={css.leafMeta}>{node.meta}</span>}
      </div>
    )
  }

  const status = node.type === 'workflow' || node.type === 'stage' || node.type === 'step' ? node.status : undefined
  return (
    <div className={`${css.node} ${collapsed ? css.nodeCollapsed : ''}`}>
      <div
        className={css.row}
        style={{ paddingLeft: 8 + depth * 16 }}
        data-tree-row
        onClick={() => { if (hasChildren) setCollapsed(value => !value) }}
      >
        <span className={css.chevron}>{hasChildren ? '▼' : ''}</span>
        <StateDot state={treeDotState(status)} />
        <span className={css.label}>{node.name}</span>
        {node.type === 'step' && node.childId !== undefined && (
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
        )}
      </div>
      {hasChildren && !collapsed && (
        <div className={css.children}>
          {children.map(child => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activePreviewId={activePreviewId}
              onSelectLeaf={onSelectLeaf}
              onOpenChild={onOpenChild}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 渲染树形导航。 */
export function TreeNav({ t, tree, activePreviewId, onSelectLeaf, onOpenChild }: TreeNavProps) {
  return (
    <nav className={css.root} aria-label={t('run.nav')} data-sandore-tree-nav>
      <div className={css.header}>
        <span className={css.title}>{t('run.nav')}</span>
      </div>
      <div className={css.body}>
        {tree.map(node => (
          <TreeRow
            key={node.id}
            node={node}
            depth={0}
            activePreviewId={activePreviewId}
            onSelectLeaf={onSelectLeaf}
            onOpenChild={onOpenChild}
            t={t}
          />
        ))}
      </div>
    </nav>
  )
}
