/**
 * WorkflowDetailFields：工作流定义详情的**受控字段表单**（点击定义直接进 DAG 后，
 * 右侧面板默认展示；选中 Stage/Step 时切换为节点配置）。
 *
 * 仅渲染 name / version / description / settings（defaultTimeout / maxConcurrentAgents）
 * 与工作流级 primary 门禁开关；字段变更经 `onChange` 直接更新宿主 `WorkflowDefinition`
 * （由 DagEditor 持有，保存/Ctrl+S 统一序列化）。不含 header 与保存按钮。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DefinitionDetail
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowDefinition } from '@deepseek-ai/dsh-sandore-workflow/schema'

import { parseOptionalNumber, trimToUndefined } from './dag-editor-model.ts'
import css from './DefinitionDetail.module.css'

/** WorkflowDetailFields 接收的 props。 */
export interface WorkflowDetailFieldsProps {
  /** 类型化翻译函数。 */
  t: TranslateNS<'sandore'>
  /** 当前编辑态定义（由宿主持有）。 */
  definition: WorkflowDefinition
  /** 字段变更回调（宿主合并更新 definition）。 */
  onChange(next: WorkflowDefinition): void
}

/** 渲染工作流详情字段表单（右侧面板默认视图）。 */
export function WorkflowDetailFields({ t, definition, onChange }: WorkflowDetailFieldsProps) {
  return (
    <div className={css.body}>
      <div className={css.sectionTitle}>{t('detail.title')}</div>
      <label className={css.field}>
        <span className={css.label}>{t('detail.name')}</span>
        <Input value={definition.name} onChange={event => { onChange({ ...definition, name: event.target.value }) }} placeholder={t('detail.name')} />
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('detail.version')}</span>
        <Input value={definition.version} onChange={event => { onChange({ ...definition, version: event.target.value }) }} placeholder={t('detail.version')} />
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('detail.description')}</span>
        <Input
          value={definition.description ?? ''}
          onChange={event => { onChange({ ...definition, description: trimToUndefined(event.target.value) }) }}
          placeholder={t('detail.description')}
        />
      </label>

      <div className={css.sectionTitle}>{t('detail.settings')}</div>
      <label className={css.field}>
        <span className={css.label}>{t('detail.defaultTimeout')}</span>
        <Input
          type="number"
          value={String(definition.settings.defaultTimeout)}
          onChange={event => { onChange({ ...definition, settings: { ...definition.settings, defaultTimeout: parseOptionalNumber(event.target.value) ?? 120 } }) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('detail.maxConcurrentAgents')}</span>
        <Input
          type="number"
          value={String(definition.settings.maxConcurrentAgents)}
          onChange={event => { onChange({ ...definition, settings: { ...definition.settings, maxConcurrentAgents: parseOptionalNumber(event.target.value) ?? 4 } }) }}
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
              onChange({ ...definition, gates: next })
            }}
          />
          <span>{t('detail.primaryGate.enabled')}</span>
        </label>
      </label>
    </div>
  )
}
