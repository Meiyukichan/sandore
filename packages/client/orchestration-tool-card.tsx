/**
 * OrchestrationToolCard：`sandore_workflow_run` / `sandore_workflow_control` 工具行里内嵌的
 * **工作流导航 UI**（用户需求：这三个工具「除了现在默认的返回外，还要有 UI，就直接用工作流
 * 导航的，风格和 dsh 默认的 workflow 一致」）。
 *
 * ## 组成
 * - 外壳 = DSH 工具卡片同族的读头：32px 行、chevron + 状态点 + 标题 + 状态/动作 chip + 进度读数，
 *   整条读头是折叠开关（`data-orchestration-toggle`，aria-expanded）；
 * - 卡体 = **复用运行页左栏的 {@link TreeNav}**（同一份 `buildRunTree` 派生、同一套
 *   `--dsw-alias-*` 令牌与 32/24px 行高、16px 逐级缩进——TreeNav 的文件头写明它就是照
 *   DSH `ui-workflow-run` 的 WorkflowRunPanel 做的），不另写一套树；
 * - 数据 = {@link ./orchestration-tool-store.ts} 按 instanceId 订阅（运行页同一条
 *   `getInstanceState` + `/sandore/events` SSE），实例推进时自动刷新。
 *
 * ## 锚点（真机断言用）
 * `[data-sandore-tool-nav]`（根）、`data-orchestration-tool`（run/control）、
 * `data-orchestration-instance`、`data-orchestration-status`、`data-orchestration-action`、
 * `[data-orchestration-toggle]`、`[data-orchestration-body]`、`[data-orchestration-progress]`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/orchestration-tool-card
 */
import { memo, useCallback, useState, useSyncExternalStore } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { TreeNav } from './TreeNav.tsx'
import {
  orchestrationInstanceSnapshot,
  subscribeOrchestrationInstance,
} from './orchestration-tool-store.ts'
import type { OrchestrationControlAction, OrchestrationToolTarget } from './orchestration-tool-model.ts'
import css from './orchestration-tool-card.module.css'

/** 实例状态 → 状态点四态（与 TreeNav 的 `dotState` 同族口径）。 */
function dotStateOf(status: string): StateDotState {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
    case 'aborted':
      return 'error'
    case 'running':
    case 'interacting':
      return 'ongoing'
    default:
      return 'warning'
  }
}

/** control 动作 chip 的文案键。 */
function actionLabelKey(action: OrchestrationControlAction): 'run.tool.action.pause' | 'run.tool.action.continue' {
  return action === 'pause' ? 'run.tool.action.pause' : 'run.tool.action.continue'
}

/**
 * 实例状态 → 读头上的**状态文字**键。
 *
 * DSH 的 WorkflowRunPanel 里状态点旁边**一定有文字**（点自身 aria-hidden），这里照办
 * （复用运行页既有的 `run.status.*` 文案族；未知状态回退「运行中」以外的中性文案）。
 */
/** 实例状态文案键（运行页 `run.status.*` 族；类型化 `t` 需要字面量联合）。 */
type OrchestrationStatusLabelKey =
  | 'run.status.pending' | 'run.status.running' | 'run.status.interacting' | 'run.status.completed'
  | 'run.status.failed' | 'run.status.aborted' | 'run.status.paused' | 'run.status.blocked'
  | 'run.status.ready'

function statusLabelKey(status: string): OrchestrationStatusLabelKey {
  switch (status) {
    case 'pending':
    case 'running':
    case 'interacting':
    case 'completed':
    case 'failed':
    case 'aborted':
    case 'paused':
    case 'blocked':
    case 'ready':
      return `run.status.${status}`
    default:
      return 'run.status.running'
  }
}

/**
 * 渲染一个工具行的导航 UI（折叠 + 实时刷新）。
 * @param props - 目标实例（`orchestrationToolTargetOf` 产物）、locale seat、可选的子会话跳转。
 * @returns 导航卡片。
 */
export const OrchestrationToolCard = memo(function OrchestrationToolCard({ target, t, onOpenChild }: {
  /** 解析出的目标（工具名 + 实例 id + 可选动作）。 */
  readonly target: OrchestrationToolTarget
  /** 该行的 locale seat。 */
  readonly t: TranslateNS<'sandore'>
  /** 跳 step 子代理会话（面板未提供时该行不显示跳转按钮）。 */
  readonly onOpenChild?: ((childId: string) => void) | undefined
}) {
  const { instanceId } = target
  // 快照订阅（首个订阅者触发拉取；SSE/轮询在 store 内合并去重）。
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeOrchestrationInstance(instanceId, listener), [instanceId]),
    useCallback(() => orchestrationInstanceSnapshot(instanceId), [instanceId]),
  )
  // 默认开合照 DSH 的 WorkflowRunPanel 口径：**全完成（clean）默认折叠，推进中/异常默认展开**；
  // 手动点过之后以手动为准（不再被自动策略翻回去）。
  const [manual, setManual] = useState<boolean | undefined>(undefined)
  const nav = snapshot?.kind === 'ready' ? snapshot.nav : undefined
  const status = nav?.status ?? ''
  const clean = nav !== undefined && nav.status === 'completed' && nav.stepDone === nav.stepTotal && nav.stepTotal > 0
  const expanded = manual ?? !clean
  const toggle = useCallback((): void => { setManual(value => !(value ?? !clean)) }, [clean])
  const title = nav?.workflowName !== undefined && nav.workflowName !== ''
    ? nav.workflowName
    : t('run.title')
  const selectLeaf = useCallback((): void => {
    // 工具行内没有右栏预览位：叶子点击不改变状态（树的展开/折叠由 TreeNav 自己管）。
  }, [])

  return (
    <section
      className={css.root}
      data-sandore-tool-nav
      data-orchestration-tool={target.toolName === 'sandore_workflow_run' ? 'run' : 'control'}
      data-orchestration-instance={instanceId}
      data-orchestration-status={status === '' ? undefined : status}
      data-orchestration-action={target.action}
      data-orchestration-instance-source={target.instanceIdSource}
    >
      <button
        type="button"
        className={css.head}
        data-orchestration-toggle
        aria-expanded={expanded}
        aria-label={t('run.tool.toggle', { name: title })}
        title={t('run.tool.toggle', { name: title })}
        onClick={toggle}
      >
        <span className={css.chevron} data-orchestration-chevron aria-hidden>
          {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
        <span className={css.dot} aria-hidden><StateDot state={dotStateOf(status)} /></span>
        <span className={css.title} data-orchestration-title>{title}</span>
        {/* 与 DSH 面板一致：状态点旁**必有文字**（点自身 aria-hidden）。 */}
        {status !== '' && (
          <span className={css.statusText} data-orchestration-status-text>{t(statusLabelKey(status))}</span>
        )}
        {target.action !== undefined && (
          <span className={css.actionChip} data-orchestration-action-chip>
            {t(actionLabelKey(target.action))}
          </span>
        )}
        {nav !== undefined && (
          <span className={css.progress} data-orchestration-progress>
            {t('run.tool.progress', { done: nav.stepDone, total: nav.stepTotal })}
          </span>
        )}
      </button>
      {expanded && (
        <div className={css.body} data-orchestration-body>
          {snapshot === undefined || snapshot.kind === 'loading'
            ? <p className={css.placeholder} data-orchestration-loading>{t('run.tool.loading')}</p>
            : snapshot.kind === 'error'
              ? (
                <p className={css.error} role="alert" data-orchestration-error>
                  {t('run.tool.error', { message: snapshot.message })}
                </p>
              )
              : nav !== undefined && nav.tree.length === 0
                ? <p className={css.placeholder} data-orchestration-empty>{t('run.tool.empty')}</p>
                : nav !== undefined && (
                  <div className={css.navSlot} data-orchestration-nav>
                    <TreeNav
                      t={t}
                      tree={nav.tree}
                      activePreviewId={null}
                      onSelectLeaf={selectLeaf}
                      {...(onOpenChild === undefined ? {} : { onOpenChild })}
                      compact
                      // 读头已经写了工作流名（+ 状态 + 进度），树里再出现同名根行就是重复
                      // （用户真机缺陷：展开后第一个根节点又是 `test-workflow`）。
                      hideWorkflowRoot
                    />
                  </div>
                )}
        </div>
      )}
    </section>
  )
})
