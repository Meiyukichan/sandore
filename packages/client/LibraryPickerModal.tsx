/**
 * LibraryPickerModal：从库绑定条目的选择弹窗（三级分离 plan §6.3 / §6.4）。
 *
 * 详情面板「绑定」下拉与「+ 添加 Stage/Step → 从库绑定」共用：列出库条目摘要
 * （搜索过滤），选中后拉取完整记录并回调 `onPick`（由调用方执行绑定展开）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/LibraryPickerModal
 */
import { useEffect, useRef, useState } from 'react'
import { Button, IconSearchOutline16, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LibraryEntrySummary, MicroflowRecord, StepRecord } from '@meiyukichan/dsh-sandore/remote'

import { formatTimestamp } from './panel-model.ts'
import { describeError } from './describe-error.ts'
import type { LibraryKind } from './LibraryEditModal.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import css from './DagEditor.module.css'

/** LibraryPickerModal 接收的 props。 */
export interface LibraryPickerModalProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 库种类。 */
  kind: LibraryKind
  /** 业务 face（list/get 已解包）。 */
  face: WorkflowOverlayFace
  /** 关闭弹窗。 */
  onClose(): void
  /** 选中条目（完整记录已拉取）。 */
  onPick(record: StepRecord | MicroflowRecord): void
}

/** 渲染库绑定选择弹窗（列表 + 搜索 + 点击绑定）。 */
export function LibraryPickerModal({ t, kind, face, onClose, onPick }: LibraryPickerModalProps) {
  const [entries, setEntries] = useState<LibraryEntrySummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState(false)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    const load = async (): Promise<void> => {
      try {
        const list = kind === 'agent' ? await face.listSteps() : await face.listMicroflows()
        if (!disposedRef.current) setEntries(list)
      } catch (loadError) {
        if (!disposedRef.current) setError(describeError(loadError))
      }
    }
    void load()
    return () => { disposedRef.current = true }
  }, [kind, face])

  /** 选中条目：拉取完整记录后回调（拉取失败内联错误，弹窗保持打开）。 */
  const pick = async (entryId: string): Promise<void> => {
    setPicking(true)
    setError(undefined)
    try {
      const record = kind === 'agent' ? await face.getStep(entryId) : await face.getMicroflow(entryId)
      onPick(record)
    } catch (pickError) {
      setError(describeError(pickError))
    } finally {
      setPicking(false)
    }
  }

  const needle = query.toLowerCase()
  const filtered = (entries ?? []).filter(entry =>
    query === '' || entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle))

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'agent' ? t('picker.title.step') : t('picker.title.microflow')}
      closeLabel={t('add.create.cancel')}
      className={css.pickerModal ?? ''}
    >
      <div className={css.pickerDialog}>
        <Input
          icon={<IconSearchOutline16 />}
          value={query}
          onChange={event => { setQuery(event.target.value) }}
          placeholder={t('picker.search')}
          aria-label={t('picker.search')}
        />
        {error !== undefined && <p className={css.pickerError} role="alert">{error}</p>}
        <div className={css.pickerList}>
          {entries === undefined ? (
            <p className={css.pickerEmpty}>{t('panel.loading')}</p>
          ) : entries.length === 0 ? (
            <p className={css.pickerEmpty}>{t('picker.empty')}</p>
          ) : filtered.length === 0 ? (
            <p className={css.pickerEmpty}>{t('panel.empty.nomatch')}</p>
          ) : (
            filtered.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={css.pickerRow}
                disabled={picking}
                onClick={() => { void pick(entry.id) }}
              >
                <span className={css.pickerRowName}>{entry.name}</span>
                <span className={css.pickerRowMeta}>
                  {`${t('library.referencedBy', { count: entry.referencedBy })} · ${formatTimestamp(entry.updatedAt)}`}
                </span>
              </button>
            ))
          )}
        </div>
        <div className={css.importFooter}>
          <Button variant="ghost" size="sm" disabled={picking} onClick={onClose}>{t('add.create.cancel')}</Button>
        </div>
      </div>
    </Modal>
  )
}
