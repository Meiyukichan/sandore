/**
 * DefinitionDetail：工作流定义详情（点击定义后右侧默认显示）。
 *
 * 编辑 name / version / description / settings（defaultTimeout / maxConcurrentAgents），
 * 保存走 `save`（新建 `createDefinition`、后续 `updateYaml`），保存后回填 id 与最新
 * YAML（供「进入编排」的 DagEditor 重新解析）。「进入编排」经 `onEnterEdit` 切两层 DAG。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DefinitionDetail
 */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowDefinition } from '@deepseek-ai/dsh-sandore-workflow/schema'
import { parseWorkflowYaml, serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml'

import { createBlankDefinition, parseOptionalNumber, trimToUndefined, withDefinitionId } from './dag-editor-model.ts'
import { describeSaveError, type SaveDefinition } from './sandore-save.ts'
import css from './DefinitionDetail.module.css'

/** DefinitionDetail 接收的 props。 */
export interface DefinitionDetailProps {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 已有定义 YAML；省略 = 新建。 */
  initialYaml?: string | undefined
  /** 已有定义 id；省略 = 新建。 */
  initialId?: string | undefined
  /** 保存回调（新建 createDefinition / 后续 updateYaml）。 */
  save: SaveDefinition
  /** 保存成功（携带最新 YAML），供宿主刷新列表与选中态。 */
  onSaved?(yaml: string): void
  /** 进入编排（切两层 DAG）。 */
  onEnterEdit(): void
}

/** 保存状态。 */
type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly message: string; readonly details: string | undefined }

/** 渲染定义详情。 */
export function DefinitionDetail({ t, initialYaml, initialId, save, onSaved, onEnterEdit }: DefinitionDetailProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(() =>
    initialYaml === undefined ? createBlankDefinition() : parseWorkflowYaml(initialYaml))
  const [id, setId] = useState<string | undefined>(initialId)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })

  const runSave = async (): Promise<void> => {
    setSaveState({ kind: 'pending' })
    try {
      const savedId = await save(id, serializeWorkflowYaml(definition))
      setId(savedId)
      const saved = withDefinitionId(definition, savedId)
      setDefinition(saved)
      onSaved?.(serializeWorkflowYaml(saved))
      setSaveState({ kind: 'ok' })
    } catch (error) {
      const { message, details } = describeSaveError(error)
      setSaveState({ kind: 'error', message, details })
    }
  }

  return (
    <section className={css.detail} aria-label={t('detail.title')} data-sandore-definition-detail>
      <header className={css.header}>
        <span className={css.title}>{t('detail.title')}</span>
        <span className={css.spacer} />
        <Button size="sm" variant="outline" onClick={onEnterEdit}>{t('detail.edit')}</Button>
        <Button size="sm" variant="primary" disabled={saveState.kind === 'pending'} onClick={() => { void runSave() }}>
          {saveState.kind === 'pending' ? t('editor.saving') : t('editor.save')}
        </Button>
      </header>

      {saveState.kind === 'ok' && <p className={css.success} role="status">{t('editor.save.success')}</p>}
      {saveState.kind === 'error' && (
        <p className={css.error} role="alert">
          {saveState.details === undefined
            ? t('editor.save.failed', { message: saveState.message })
            : t('editor.save.failed', { message: `${saveState.message} — ${saveState.details}` })}
        </p>
      )}

      <div className={css.body}>
        <label className={css.field}>
          <span className={css.label}>{t('detail.name')}</span>
          <Input value={definition.name} onChange={event => { setDefinition(current => ({ ...current, name: event.target.value })) }} placeholder={t('detail.name')} />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('detail.version')}</span>
          <Input value={definition.version} onChange={event => { setDefinition(current => ({ ...current, version: event.target.value })) }} placeholder={t('detail.version')} />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('detail.description')}</span>
          <Input
            value={definition.description ?? ''}
            onChange={event => { setDefinition(current => ({ ...current, description: trimToUndefined(event.target.value) })) }}
            placeholder={t('detail.description')}
          />
        </label>

        <div className={css.sectionTitle}>{t('detail.settings')}</div>
        <label className={css.field}>
          <span className={css.label}>{t('detail.defaultTimeout')}</span>
          <Input
            type="number"
            value={String(definition.settings.defaultTimeout)}
            onChange={event => { setDefinition(current => ({ ...current, settings: { ...current.settings, defaultTimeout: parseOptionalNumber(event.target.value) ?? 120 } })) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('detail.maxConcurrentAgents')}</span>
          <Input
            type="number"
            value={String(definition.settings.maxConcurrentAgents)}
            onChange={event => { setDefinition(current => ({ ...current, settings: { ...current.settings, maxConcurrentAgents: parseOptionalNumber(event.target.value) ?? 4 } })) }}
          />
        </label>

        {/* 工作流级 primary 门禁（引擎 finalize-manager 消费；Step/Stage 级仅 secondary）。 */}
        <label className={css.field}>
          <span className={css.label}>{t('detail.primaryGate')}</span>
          <label className={css.checkbox}>
            <input
              type="checkbox"
              checked={definition.gates?.primary?.enabled ?? false}
              onChange={event => {
                const next = { ...(definition.gates ?? {}), primary: { enabled: event.target.checked } }
                setDefinition(current => ({ ...current, gates: next }))
              }}
            />
            <span>{t('detail.primaryGate.enabled')}</span>
          </label>
        </label>
      </div>
    </section>
  )
}
