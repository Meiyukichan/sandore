/**
 * LibraryEditModal：Step / Microflow 库条目的 YAML 编辑弹窗（三级分离 plan §6.2）。
 *
 * 复用导入弹窗的 Modal+textarea 模式：YAML 文本区（粘贴/编辑）+ 元数据
 * （name/version）+ 保存（upsert，解析失败内联错误）。已有条目打开时经
 * `getStep`/`getMicroflow` 拉取并序列化为 YAML 填充；新建（entryId 缺省）为空白。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/LibraryEditModal
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  parseMicroflowYaml, parseStepYaml, serializeMicroflowYaml, serializeStepYaml,
} from '@meiyukichan/dsh-sandore/yaml'

import { describeError } from './describe-error.ts'
import { ImeSafeInput } from './ime-safe-input.tsx'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import css from './DagEditor.module.css'

/** 库条目种类：`agent` = Step 库（UI 名「Agent」）、`microflow` = Microflow 库。 */
export type LibraryKind = 'agent' | 'microflow'

/** LibraryEditModal 接收的 props。 */
export interface LibraryEditModalProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 库种类。 */
  kind: LibraryKind
  /** 待编辑条目 id；缺省 = 新建（空白 YAML）。 */
  entryId?: string | undefined
  /** 业务 face（get/upsert 已解包）。 */
  face: WorkflowOverlayFace
  /** 关闭弹窗。 */
  onClose(): void
  /** 保存成功（携带保存后的条目名，供外层提示）。 */
  onSaved(name: string): void
}

/** 渲染库条目 YAML 编辑弹窗（粘贴/编辑 → upsert）。 */
export function LibraryEditModal({ t, kind, entryId, face, onClose, onSaved }: LibraryEditModalProps) {
  const [yaml, setYaml] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [loaded, setLoaded] = useState(entryId === undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const disposedRef = useRef(false)

  // 打开已有条目：拉取记录并序列化为 YAML 填充（名称/版本同步到元数据输入框）。
  useEffect(() => {
    if (entryId === undefined) return
    disposedRef.current = false
    const load = async (): Promise<void> => {
      try {
        if (kind === 'agent') {
          const record = await face.getStep(entryId)
          if (disposedRef.current) return
          setYaml(serializeStepYaml(record))
          setName(record.name)
          setVersion(record.version ?? '')
        } else {
          const record = await face.getMicroflow(entryId)
          if (disposedRef.current) return
          setYaml(serializeMicroflowYaml(record))
          setName(record.name)
          setVersion(record.version ?? '')
        }
        setLoaded(true)
      } catch (loadError) {
        if (disposedRef.current) return
        setError(describeError(loadError))
        setLoaded(true)
      }
    }
    void load()
    return () => { disposedRef.current = true }
  }, [entryId, kind, face])

  /** 保存：本地解析（失败内联错误）→ 合并元数据 → 序列化 → upsert。 */
  const save = async (): Promise<void> => {
    setError(undefined)
    const mergedVersion = version.trim() === '' ? undefined : version.trim()
    setBusy(true)
    try {
      if (kind === 'agent') {
        const parsed = parseStepYaml(yaml)
        // 名称输入框为空时回退 YAML 内 name（Host 仍会以 zod min(1) 拒绝空名）。
        const mergedName = name.trim() === '' ? parsed.name : name.trim()
        const merged = { ...parsed, name: mergedName, ...(mergedVersion === undefined ? {} : { version: mergedVersion }) }
        const saved = await face.upsertStep(serializeStepYaml(merged))
        onSaved(saved.name)
      } else {
        const parsed = parseMicroflowYaml(yaml)
        const mergedName = name.trim() === '' ? parsed.name : name.trim()
        const merged = { ...parsed, name: mergedName, ...(mergedVersion === undefined ? {} : { version: mergedVersion }) }
        const saved = await face.upsertMicroflow(serializeMicroflowYaml(merged))
        onSaved(saved.name)
      }
    } catch (error) {
      // 解析失败（YAML_PARSE/DEFINITION_INVALID）与查重/网络错误统一内联呈现。
      setError(t('library.edit.failed', { message: describeError(error) }))
    } finally {
      setBusy(false)
    }
  }

  const title = entryId === undefined
    ? t('library.edit.new')
    : (kind === 'agent' ? t('library.edit.title.agent') : t('library.edit.title.microflow'))

  return (
    <Modal open onClose={onClose} title={title} closeLabel={t('library.edit.cancel')} className={css.importModal ?? ''}>
      <div className={css.importDialog}>
        <div className={css.libraryMetaRow}>
          <label className={css.libraryMetaField}>
            <span className={css.libraryMetaLabel}>{t('library.edit.name')}</span>
            <ImeSafeInput value={name} onCommit={setName} placeholder={t('library.edit.name')} aria-label={t('library.edit.name')} />
          </label>
          <label className={css.libraryMetaField}>
            <span className={css.libraryMetaLabel}>{t('library.edit.version')}</span>
            <ImeSafeInput value={version} onCommit={setVersion} placeholder={t('library.edit.version')} aria-label={t('library.edit.version')} />
          </label>
        </div>
        <textarea
          className={css.importTextarea}
          value={yaml}
          onChange={event => { setYaml(event.target.value) }}
          placeholder={kind === 'agent' ? t('library.edit.placeholder.agent') : t('library.edit.placeholder.microflow')}
          spellCheck={false}
          disabled={busy || !loaded}
        />
        {error !== undefined && (
          <p className={css.error} role="alert">{error}</p>
        )}
        <div className={css.importFooter}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t('library.edit.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !loaded || yaml.trim() === ''}
            onClick={() => { void save() }}
          >
            {busy ? t('library.edit.saving') : t('library.edit.save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
