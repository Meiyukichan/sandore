/**
 * DefinitionList：编排态工作流定义列表（平铺 + 删除确认 + 三态）。
 *
 * 经 `listDefinitions()` 拉取定义并平铺渲染（名称 / 版本 / 描述 / 更新时间），
 * 定义无 workspace 归属故不分组；点击定义行经 `onOpen` 下钻 DagEditor，删除按钮
 * 弹确认框，确认后 `deleteDefinition(id)`，成功本地移除、失败呈现错误。列表呈现
 * 三态：loading / empty / error（含重试）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DefinitionList
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowDefinitionEntry } from 'dsh-sandore/remote'

import { formatTimestamp, matchesDefinitionQuery } from './panel-model.ts'
import { describeError } from './describe-error.ts'
import css from './WorkflowPanel.module.css'

/** DefinitionList 接收的普通业务 props。 */
export interface DefinitionListProps {
  /** 类型化的翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 客户端过滤关键词（匹配 name / id）。 */
  query: string
  /** 当前选中定义 id（高亮行；缺省不高亮）。 */
  activeId?: string | undefined
  /** 拉取定义列表（RPC 已解包）。 */
  listDefinitions(): Promise<WorkflowDefinitionEntry[]>
  /** 删除定义（RPC 已解包）。 */
  deleteDefinition(id: string): Promise<boolean>
  /** 点击定义行下钻 DagEditor（传入 id 与原始 yaml）。 */
  onOpen(definitionId: string, initialYaml: string): void
}

/** 定义列表加载状态（加载中 / 错误 / 就绪）。 */
type DefinitionListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly definitions: readonly WorkflowDefinitionEntry[] }

/** 删除确认对话框：展示定义名，确认后回调定义 id，删除失败内联呈现错误。 */
function DeleteConfirmModal({ target, deleting, errorMessage, t, onCancel, onConfirm }: {
  readonly target: WorkflowDefinitionEntry
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
      title={t('panel.delete.confirm.title')}
      closeLabel={t('panel.delete.confirm.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={deleting} onClick={onCancel}>{t('panel.delete.confirm.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={deleting} onClick={() => { onConfirm(target.id) }}>{t('panel.delete.confirm.submit')}</Button>
        </>
      )}
    >
      <div className={css.deleteConfirm}>
        <p className={css.deleteConfirmText}>{t('panel.delete.confirm.body', { name: target.name })}</p>
        {errorMessage !== undefined && (
          <p className={css.error} role="alert">{t('panel.delete.failed', { message: errorMessage })}</p>
        )}
      </div>
    </Modal>
  )
}

/** 渲染 DefinitionList。 */
export function DefinitionList({ t, query, activeId, listDefinitions, deleteDefinition, onOpen }: DefinitionListProps) {
  const [state, setState] = useState<DefinitionListState>({ kind: 'loading' })
  const [confirmTarget, setConfirmTarget] = useState<WorkflowDefinitionEntry | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const disposedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const definitions = await listDefinitions()
      if (!disposedRef.current) setState({ kind: 'ready', definitions })
    } catch (error) {
      if (!disposedRef.current) setState({ kind: 'error', message: describeError(error) })
    }
  }, [listDefinitions])

  // 挂载时拉取一次（定义列表无轮询）；卸载后不再 setState。
  useEffect(() => {
    disposedRef.current = false
    void refresh()
    return () => { disposedRef.current = true }
  }, [refresh])

  const runDelete = async (id: string): Promise<void> => {
    setDeleting(true)
    setDeleteError(undefined)
    try {
      await deleteDefinition(id)
      setState(current => (current.kind === 'ready'
        ? { kind: 'ready', definitions: current.definitions.filter(definition => definition.id !== id) }
        : current))
      setConfirmTarget(undefined)
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

  if (state.definitions.length === 0) {
    return (
      <div className={css.emptyBox}>
        <p className={css.empty}>{t('panel.empty.definitions')}</p>
        <p className={css.emptyHint}>{t('panel.empty.definitions.hint')}</p>
      </div>
    )
  }

  const filtered = state.definitions.filter(definition => matchesDefinitionQuery(definition, query))

  return (
    <>
      {filtered.length === 0 ? (
        <p className={css.empty}>{t('panel.empty.nomatch')}</p>
      ) : (
        <ul className={css.rows}>
          {filtered.map(definition => (
            <li key={definition.id} className={`${css.row} ${activeId === definition.id ? css.rowActive : ''}`}>
              <button type="button" className={css.rowAction} onClick={() => { onOpen(definition.id, definition.yaml) }}>
                <span className={css.rowBody}>
                  <span className={css.rowName}>{definition.name}</span>
                  <span className={css.rowCaption}>
                    {`v${definition.version}${definition.description !== undefined ? ` · ${definition.description}` : ''} · ${formatTimestamp(definition.updatedAt)}`}
                  </span>
                </span>
              </button>
              <button type="button" className={css.deleteButton} aria-label={t('panel.delete')} onClick={() => { setConfirmTarget(definition); setDeleteError(undefined) }}>
                <IconTrashOutline16 />
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirmTarget !== undefined && (
        <DeleteConfirmModal
          target={confirmTarget}
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
