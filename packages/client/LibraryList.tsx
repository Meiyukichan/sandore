/**
 * LibraryList：编排态左列表的库分区内容（三级分离 plan §6.1）。
 *
 * 经 `listSteps`/`listMicroflows` 拉取库条目摘要并平铺渲染（名称 + 类型徽标 +
 * 被引用数 + 更新时间）；点击条目行经 `onOpen` 打开 YAML 编辑弹窗；删除按钮弹确认
 * 框，被工作流引用的条目删除被 Host 以 `REFERENCED` 拒绝、错误内联呈现。三态：
 * loading / empty / error（含重试）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/LibraryList
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LibraryEntrySummary } from '@meiyukichan/dsh-sandore/remote'

import { formatTimestamp } from './panel-model.ts'
import { describeError } from './describe-error.ts'
import type { LibraryKind } from './LibraryEditModal.tsx'
import css from './WorkflowPanel.module.css'

/** LibraryList 接收的 props。 */
export interface LibraryListProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 库种类（决定数据源与徽标文案）。 */
  kind: LibraryKind
  /** 客户端过滤关键词（匹配 name / id）。 */
  query: string
  /** 拉取库条目摘要列表（RPC 已解包）。 */
  listEntries(): Promise<LibraryEntrySummary[]>
  /** 删除库条目（RPC 已解包；被引用时 Host 抛 REFERENCED）。 */
  deleteEntry(id: string): Promise<boolean>
  /** 点击条目行 → 打开 YAML 编辑弹窗。 */
  onOpen(entryId: string): void
}

/** 库列表加载状态（加载中 / 错误 / 就绪）。 */
type LibraryListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly entries: readonly LibraryEntrySummary[] }

/** 删除确认对话框：被引用条目删除失败的错误内联呈现。 */
function DeleteConfirmModal({ target, kind, deleting, errorMessage, t, onCancel, onConfirm }: {
  readonly target: LibraryEntrySummary
  readonly kind: LibraryKind
  readonly deleting: boolean
  readonly errorMessage: string | undefined
  readonly t: TranslateNS<'sandore'>
  readonly onCancel: () => void
  readonly onConfirm: (id: string) => void
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={kind === 'agent' ? t('library.delete.confirm.title.agent') : t('library.delete.confirm.title.microflow')}
      closeLabel={t('panel.delete.confirm.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={deleting} onClick={onCancel}>{t('panel.delete.confirm.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={deleting} onClick={() => { onConfirm(target.id) }}>{t('panel.delete.confirm.submit')}</Button>
        </>
      )}
    >
      <div className={css.deleteConfirm}>
        <p className={css.deleteConfirmText}>{t('library.delete.confirm.body', { name: target.name })}</p>
        {errorMessage !== undefined && (
          <p className={css.error} role="alert">{t('library.delete.failed', { message: errorMessage })}</p>
        )}
      </div>
    </Modal>
  )
}

/** 渲染库条目列表（Agent 库 / Microflow 库分区共用）。 */
export function LibraryList({ t, kind, query, listEntries, deleteEntry, onOpen }: LibraryListProps) {
  const [state, setState] = useState<LibraryListState>({ kind: 'loading' })
  const [confirmTarget, setConfirmTarget] = useState<LibraryEntrySummary | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)
  const disposedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const entries = await listEntries()
      if (!disposedRef.current) setState({ kind: 'ready', entries })
    } catch (error) {
      if (!disposedRef.current) setState({ kind: 'error', message: describeError(error) })
    }
  }, [listEntries])

  // 挂载时拉取一次；卸载后不再 setState。
  useEffect(() => {
    disposedRef.current = false
    void refresh()
    return () => { disposedRef.current = true }
  }, [refresh])

  const runDelete = async (id: string): Promise<void> => {
    setDeleting(true)
    setDeleteError(undefined)
    try {
      await deleteEntry(id)
      setState(current => (current.kind === 'ready'
        ? { kind: 'ready', entries: current.entries.filter(entry => entry.id !== id) }
        : current))
      setConfirmTarget(undefined)
    } catch (error) {
      // 被引用（REFERENCED）等删除失败：内联呈现错误，弹窗保持打开。
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

  if (state.entries.length === 0) {
    return (
      <div className={css.emptyBox}>
        <p className={css.empty}>{kind === 'agent' ? t('library.empty.steps') : t('library.empty.microflows')}</p>
        <p className={css.emptyHint}>{kind === 'agent' ? t('library.empty.steps.hint') : t('library.empty.microflows.hint')}</p>
      </div>
    )
  }

  const needle = query.toLowerCase()
  const filtered = state.entries.filter(entry =>
    query === '' || entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle))

  return (
    <>
      {filtered.length === 0 ? (
        <p className={css.empty}>{t('panel.empty.nomatch')}</p>
      ) : (
        <ul className={css.rows}>
          {filtered.map(entry => (
            <li key={entry.id} className={css.row}>
              <button type="button" className={css.rowAction} onClick={() => { onOpen(entry.id) }}>
                <span className={css.rowBody}>
                  <span className={css.rowName}>{entry.name}</span>
                  <span className={css.rowCaption}>
                    {`${t('library.referencedBy', { count: entry.referencedBy })} · ${formatTimestamp(entry.updatedAt)}`}
                  </span>
                </span>
                <span className={css.rowStatus}>
                  {kind === 'agent' ? t('library.badge.agent') : t('library.badge.microflow')}
                </span>
              </button>
              <button
                type="button"
                className={css.deleteButton}
                aria-label={t('panel.delete')}
                onClick={() => { setConfirmTarget(entry); setDeleteError(undefined) }}
              >
                <IconTrashOutline16 />
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirmTarget !== undefined && (
        <DeleteConfirmModal
          target={confirmTarget}
          kind={kind}
          deleting={deleting}
          errorMessage={deleteError}
          t={t}
          onCancel={() => { if (!deleting) setConfirmTarget(undefined) }}
          onConfirm={id => { void runDelete(id) }}
        />
      )}
    </>
  )
}
