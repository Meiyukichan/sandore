/**
 * InstanceList：默认态工作流实例列表（按工作区分组 + 3s 轮询 + 三态）。
 *
 * 经 `listInstances()` 拉取实例摘要，`useWorkspaces` 的 `WorkspaceView[].sessionIds`
 * 成员表把实例按归属分组（instanceId 命中即归组，未命中归「未分组」）；打开期间
 * 每 3s 递归 setTimeout 刷新（组件卸载即清理停止）。列表呈现三态：loading（加载中）、
 * empty（空态引导）、error（RPC 失败提示 + 重试）。点击实例行经 `onOpen` 下钻 RunView；
 * 每行删除按钮弹确认框，确认后 `deleteInstance(instanceId)`（state 表行级删除），
 * 成功本地移除、失败内联呈现错误。
 * 分组派生与关键词过滤抽至 `panel-model.ts`（纯函数，可单测）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/InstanceList
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconTrashOutline16, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { InstanceSummary } from '@deepseek-ai/dsh-sandore-workflow/remote'

import { deriveGroups, formatTimestamp, matchesInstanceQuery } from './panel-model.ts'
import { describeError } from './describe-error.ts'
import { runDotState } from './run-view-model.ts'
import type { DagRunStatus } from './run-view-model.ts'
import type { SandoreKey } from './locales.ts'
import css from './WorkflowPanel.module.css'

/** 实例列表轮询间隔（毫秒）：1.5s 平衡及时性与 RPC 频率。 */
const POLL_INTERVAL_MS = 1500

/** 7 态实例生命周期状态词汇（用于把 wire 侧 string 安全收窄为 DagRunStatus）。 */
const DAG_RUN_STATUSES: readonly string[] = ['pending', 'running', 'interacting', 'completed', 'failed', 'aborted', 'paused']

/** 实例生命周期状态 → 本地化标签键（7 态，与 RunView 对齐）。 */
const STATUS_KEYS: Readonly<Record<DagRunStatus, SandoreKey>> = {
  pending: 'run.status.pending',
  running: 'run.status.running',
  interacting: 'run.status.interacting',
  completed: 'run.status.completed',
  failed: 'run.status.failed',
  aborted: 'run.status.aborted',
  paused: 'run.status.paused',
}

/** InstanceList 接收的普通业务 props。 */
export interface InstanceListProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 工作区成员表（WorkspaceView[].sessionIds 为会话账号）。 */
  workspaces: readonly WorkspaceView[]
  /** 客户端过滤关键词（匹配 instanceId / workflowId）。 */
  query: string
  /** 当前选中实例 id（高亮行；缺省不高亮）。 */
  activeId?: string | undefined
  /** 拉取实例摘要（RPC 已解包）。 */
  listInstances(): Promise<InstanceSummary[]>
  /** 删除实例（RPC 已解包；state 表行级删除）。 */
  deleteInstance(instanceId: string): Promise<boolean>
  /** 删除成功后回调（宿主重挂载列表，立即刷新；不必等轮询）。 */
  onInstanceDeleted?(): void
  /** 点击实例行下钻 RunView。 */
  onOpen(instanceId: string): void
}

/** 实例列表加载状态（加载中 / 错误 / 就绪）。 */
type InstanceListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly instances: readonly InstanceSummary[] }

/** 收窄 wire 侧 status 字符串为 7 态枚举（生成物拍平为 string，Host 实际返回 7 态）。 */
function isDagRunStatus(status: string): status is DagRunStatus {
  return DAG_RUN_STATUSES.includes(status)
}

/** 7 态 status 字符串 → StateDotState（未知状态折入 warning，避免空状态点）。 */
function instanceDotState(status: string): StateDotState {
  return isDagRunStatus(status) ? runDotState(status) : 'warning'
}

/** 删除实例确认对话框：展示实例 id，确认后回调 instanceId，删除失败内联呈现错误。 */
function DeleteInstanceModal({ target, deleting, errorMessage, t, onCancel, onConfirm }: {
  readonly target: InstanceSummary
  readonly deleting: boolean
  readonly errorMessage: string | undefined
  readonly t: TranslateNS<'sandore'>
  readonly onCancel: () => void
  readonly onConfirm: (instanceId: string) => void
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('panel.delete.instance.confirm.title')}
      closeLabel={t('panel.delete.instance.confirm.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={deleting} onClick={onCancel}>{t('panel.delete.instance.confirm.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={deleting} onClick={() => { onConfirm(target.instanceId) }}>{t('panel.delete.instance.confirm.submit')}</Button>
        </>
      )}
    >
      <div className={css.deleteConfirm}>
        <p className={css.deleteConfirmText}>{t('panel.delete.instance.confirm.body', { id: target.instanceId })}</p>
        {errorMessage !== undefined && (
          <p className={css.error} role="alert">{t('panel.delete.instance.failed', { message: errorMessage })}</p>
        )}
      </div>
    </Modal>
  )
}

/** 渲染 InstanceList。 */
export function InstanceList({ t, workspaces, query, activeId, listInstances, deleteInstance, onInstanceDeleted, onOpen }: InstanceListProps) {
  const [state, setState] = useState<InstanceListState>({ kind: 'loading' })
  const [confirmTarget, setConfirmTarget] = useState<InstanceSummary | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  // 轮询定时器与卸载标记：打开期间每 3s 刷新一次，卸载/收起面板即清理停止。
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const disposedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const instances = await listInstances()
      if (!disposedRef.current) setState({ kind: 'ready', instances })
    } catch (error) {
      if (!disposedRef.current) setState({ kind: 'error', message: describeError(error) })
    }
  }, [listInstances])

  const refreshAndSchedule = useCallback(async (): Promise<void> => {
    await refresh()
    if (disposedRef.current) return
    if (timerRef.current === undefined) {
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        void refreshAndSchedule()
      }, POLL_INTERVAL_MS)
    }
  }, [refresh])

  useEffect(() => {
    disposedRef.current = false
    void refreshAndSchedule()
    return () => {
      disposedRef.current = true
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [refreshAndSchedule])

  /** 删除实例：调 `deleteInstance`（state 表行级删除），成功本地移除、失败内联呈现。 */
  const runDelete = async (instanceId: string): Promise<void> => {
    setDeleting(true)
    setDeleteError(undefined)
    try {
      await deleteInstance(instanceId)
      setState(current => (current.kind === 'ready'
        ? { kind: 'ready', instances: current.instances.filter(instance => instance.instanceId !== instanceId) }
        : current))
      setConfirmTarget(undefined)
      onInstanceDeleted?.()
    } catch (error) {
      setDeleteError(describeError(error))
    } finally {
      setDeleting(false)
    }
  }

  if (state.kind === 'loading') {
    return <p className={css.empty}>{t('panel.loading')}</p>
  }

  if (state.kind === 'error') {
    return (
      <div className={css.errorBox}>
        <p className={css.error} role="alert">{t('panel.error', { message: state.message })}</p>
        <Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('panel.retry')}</Button>
      </div>
    )
  }

  if (state.instances.length === 0) {
    return (
      <div className={css.emptyBox}>
        <p className={css.empty}>{t('panel.empty.instances')}</p>
        <p className={css.emptyHint}>{t('panel.empty.instances.hint')}</p>
      </div>
    )
  }

  const filtered = state.instances.filter(instance => matchesInstanceQuery(instance, query))
  const groups = deriveGroups(filtered, workspaces, t('panel.ungrouped'))

  if (groups.length === 0) {
    return <p className={css.empty}>{t('panel.empty.nomatch')}</p>
  }

  return (
    <>
      <div className={css.listGroups}>
        {groups.map(group => (
          <section key={group.key} className={css.groupSection}>
            <h3 className={css.group}>{group.title}</h3>
            <ul className={css.rows}>
              {group.instances.map(instance => (
                <li key={instance.instanceId} className={css.row}>
                  <button
                    type="button"
                    className={`${css.rowAction} ${activeId === instance.instanceId ? css.rowActive : ''}`}
                    onClick={() => { onOpen(instance.instanceId) }}
                  >
                    <StateDot state={instanceDotState(instance.status)} />
                    <span className={css.rowBody}>
                      <span className={css.rowName} title={instance.originalInput}>{instance.originalInput}</span>
                      <span className={css.rowCaption}>{`${instance.workflowId} · ${formatTimestamp(instance.updatedAt)}`}</span>
                    </span>
                    <span className={css.rowStatus}>
                      {isDagRunStatus(instance.status) ? t(STATUS_KEYS[instance.status]) : instance.status}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={css.deleteButton}
                    aria-label={t('panel.delete.instance')}
                    onClick={() => { setConfirmTarget(instance); setDeleteError(undefined) }}
                  >
                    <IconTrashOutline16 />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {confirmTarget !== undefined && (
        <DeleteInstanceModal
          target={confirmTarget}
          deleting={deleting}
          errorMessage={deleteError}
          t={t}
          onCancel={() => { if (!deleting) setConfirmTarget(undefined) }}
          onConfirm={instanceId => { void runDelete(instanceId) }}
        />
      )}
    </>
  )
}
