/**
 * DagEditor：Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存。
 *
 * 以 ui-primitives 的节点列表 + 缩进层级呈现 Stage DAG（Stage 间以竖线 + 箭头示意
 * 串行推进，不引入 React Flow/Dagre）。原始 yaml 经浏览器安全子路径
 * `@deepseek-ai/dsh-sandore-workflow/yaml` 解析为编辑态模型（`WorkflowDefinition`），
 * Step 字段（name / command 五类型 / inputFrom / outputTo / passThroughVars / gates /
 * branches / loop）编辑即改模型，YAML 预览随模型同步序列化；保存经 `save` 回调
 * （新建走 `createDefinition`、后续走 `updateYaml`），失败呈现校验错误并保留未保存内容。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/DagEditor
 */
import { useMemo, useState } from 'react'
import {
  Button, CodeBlock, DisclosureRow, IconChevronDownOutline14, IconChevronRightOutline14,
  IconPlusOutline16, IconTrashOutline16, Input, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandConfig, Gates, InputFromItem, WorkflowDefinition, WorkflowStage, WorkflowStep,
} from '@deepseek-ai/dsh-sandore-workflow/schema'
import { parseWorkflowYaml, serializeWorkflowYaml } from '@deepseek-ai/dsh-sandore-workflow/yaml'

import {
  COMMAND_TYPES, createBlankDefinition, createBranch, createCommand, createInputFromItem,
  createOutputToItem, createPassThroughVar, createStage, newId, parseOptionalNumber,
  trimToUndefined, updateCommandText, withDefinitionId, type CommandTextField, type CommandType,
} from './dag-editor-model.ts'
import { describeSaveError, type SaveDefinition } from './sandore-save.ts'
import type { SandoreKey } from './locales.ts'
import css from './DagEditor.module.css'

/** DagEditor 接收的最小业务 props：初始定义 + 保存回调 + locale。 */
export interface DagEditorProps {
  /** 类型化翻译函数（sandore 命名空间）。 */
  t: TranslateNS<'sandore'>
  /** 已有定义的原始 YAML；省略时进入新建（空白骨架）。 */
  initialYaml?: string | undefined
  /** 已有定义 id；新建时省略（首次保存后由保存回调返回并回填）。 */
  initialId?: string | undefined
  /** 保存回调：`id` 为 `undefined` 时走 `createDefinition`，否则走 `updateYaml`；返回持久化后的 id。 */
  save: SaveDefinition
}

/** 保存流程本地状态。 */
type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly message: string; readonly details: string | undefined }

/** 命令类型的本地化标签键。 */
const COMMAND_LABEL_KEYS = {
  shell: 'editor.command.shell',
  prompt: 'editor.command.prompt',
  agent: 'editor.command.agent',
  skill: 'editor.command.skill',
  mcp: 'editor.command.mcp',
} as const satisfies Record<CommandType, SandoreKey>

/** 渲染 Step 命令类型选择与 value 字段编辑。 */
function CommandEditor({ command, onChange, t }: {
  readonly command: CommandConfig
  readonly onChange: (command: CommandConfig) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const update = (field: CommandTextField) => (value: string): void => { onChange(updateCommandText(command, field, value)) }
  return (
    <div className={css.command}>
      <div className={css.commandTypes} role="group" aria-label={t('editor.step.command')}>
        {COMMAND_TYPES.map(type => (
          <Pill key={type} active={command.type === type} onClick={() => { onChange(createCommand(type)) }}>
            {t(COMMAND_LABEL_KEYS[type])}
          </Pill>
        ))}
      </div>
      <div className={css.commandValue}>
        {command.type === 'shell' && (
          <Input value={command.value.command} onChange={event => { update('command')(event.target.value) }} placeholder={t('editor.field.command')} />
        )}
        {command.type === 'prompt' && (
          <>
            <Input value={command.value.promptText} onChange={event => { update('promptText')(event.target.value) }} placeholder={t('editor.field.promptText')} />
            <Input value={command.value.providerId ?? ''} onChange={event => { update('providerId')(event.target.value) }} placeholder={t('editor.field.providerId')} />
            <Input value={command.value.modelId ?? ''} onChange={event => { update('modelId')(event.target.value) }} placeholder={t('editor.field.modelId')} />
          </>
        )}
        {command.type === 'agent' && (
          <>
            <Input value={command.value.promptText} onChange={event => { update('promptText')(event.target.value) }} placeholder={t('editor.field.promptText')} />
            <Input value={command.value.agentParamsTemplate ?? ''} onChange={event => { update('agentParamsTemplate')(event.target.value) }} placeholder={t('editor.field.agentParamsTemplate')} />
            <Input value={command.value.providerId ?? ''} onChange={event => { update('providerId')(event.target.value) }} placeholder={t('editor.field.providerId')} />
            <Input value={command.value.modelId ?? ''} onChange={event => { update('modelId')(event.target.value) }} placeholder={t('editor.field.modelId')} />
          </>
        )}
        {command.type === 'skill' && (
          <>
            <Input value={command.value.promptText} onChange={event => { update('promptText')(event.target.value) }} placeholder={t('editor.field.promptText')} />
            <Input value={command.value.providerId ?? ''} onChange={event => { update('providerId')(event.target.value) }} placeholder={t('editor.field.providerId')} />
          </>
        )}
        {command.type === 'mcp' && (
          <Input value={command.value.promptText} onChange={event => { update('promptText')(event.target.value) }} placeholder={t('editor.field.promptText')} />
        )}
      </div>
    </div>
  )
}

/** 折叠小节标题。 */
function SectionLabel({ children }: { readonly children: string }) {
  return <div className={css.sectionLabel}>{children}</div>
}

/** 单个映射条目（inputFrom/outputTo 的 `{id, path, regex}`）编辑行。 */
function MappingRow({ item, onChange, onRemove, t }: {
  readonly item: InputFromItem
  readonly onChange: (item: InputFromItem) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  return (
    <div className={css.itemRow}>
      <Input value={item.id} onChange={event => { onChange({ ...item, id: event.target.value }) }} placeholder={t('editor.field.id')} />
      <Input value={item.path ?? ''} onChange={event => { onChange({ ...item, path: trimToUndefined(event.target.value) }) }} placeholder={t('editor.field.path')} />
      <Input value={item.regex ?? ''} onChange={event => { onChange({ ...item, regex: trimToUndefined(event.target.value) }) }} placeholder={t('editor.field.regex')} />
      <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemove} aria-label={t('editor.remove.item')} />
    </div>
  )
}

/** Step 完整字段编辑器。 */
function StepEditor({ step, onChange, onRemove, t }: {
  readonly step: WorkflowStep
  readonly onChange: (step: WorkflowStep) => void
  readonly onRemove: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  const inputFrom = step.inputFrom ?? []
  const outputTo = step.outputTo ?? []
  const passThroughVars = step.passThroughVars ?? []
  const branches = step.branches ?? []

  return (
    <div className={css.step}>
      <div className={css.stepHead}>
        <Input
          value={step.name ?? ''}
          onChange={event => { onChange({ ...step, name: trimToUndefined(event.target.value) }) }}
          placeholder={t('editor.step.name')}
          aria-label={t('editor.step.name')}
        />
        <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemove} aria-label={t('editor.remove.item')} />
      </div>

      {step.command === undefined ? (
        <Button variant="outline" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, command: createCommand('shell') }) }}>
          {t('editor.step.command')}
        </Button>
      ) : (
        <CommandEditor command={step.command} onChange={command => { onChange({ ...step, command }) }} t={t} />
      )}

      <SectionLabel>{t('editor.section.inputFrom')}</SectionLabel>
      {inputFrom.map((item, index) => (
        <MappingRow
          key={index}
          item={item}
          onChange={next => { onChange({ ...step, inputFrom: inputFrom.map((current, i) => (i === index ? next : current)) }) }}
          onRemove={() => { onChange({ ...step, inputFrom: inputFrom.filter((_, i) => i !== index) }) }}
          t={t}
        />
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, inputFrom: [...inputFrom, createInputFromItem()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.outputTo')}</SectionLabel>
      {outputTo.map((item, index) => (
        <MappingRow
          key={index}
          item={item}
          onChange={next => { onChange({ ...step, outputTo: outputTo.map((current, i) => (i === index ? next : current)) }) }}
          onRemove={() => { onChange({ ...step, outputTo: outputTo.filter((_, i) => i !== index) }) }}
          t={t}
        />
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, outputTo: [...outputTo, createOutputToItem()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.passThroughVars')}</SectionLabel>
      {passThroughVars.map((variable, index) => (
        <div key={index} className={css.itemRow}>
          <Input value={variable.name} onChange={event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, name: event.target.value } : v)) }) }} placeholder={t('editor.field.name')} />
          <Input value={variable.value} onChange={event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, value: event.target.value } : v)) }) }} placeholder={t('editor.field.value')} />
          <Input value={variable.description} onChange={event => { onChange({ ...step, passThroughVars: passThroughVars.map((v, i) => (i === index ? { ...v, description: event.target.value } : v)) }) }} placeholder={t('editor.field.description')} />
          <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={() => { onChange({ ...step, passThroughVars: passThroughVars.filter((_, i) => i !== index) }) }} aria-label={t('editor.remove.item')} />
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, passThroughVars: [...passThroughVars, createPassThroughVar()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.gates')}</SectionLabel>
      <GatesEditor gates={step.gates} onChange={gates => { onChange({ ...step, gates }) }} t={t} />

      <SectionLabel>{t('editor.section.branches')}</SectionLabel>
      {branches.map((branch, index) => (
        <div key={index} className={css.itemRow}>
          <Input value={branch.expectation ?? ''} onChange={event => { onChange({ ...step, branches: branches.map((b, i) => (i === index ? { ...b, expectation: trimToUndefined(event.target.value) } : b)) }) }} placeholder={t('editor.field.expectation')} />
          <Input value={branch.next} onChange={event => { onChange({ ...step, branches: branches.map((b, i) => (i === index ? { ...b, next: event.target.value } : b)) }) }} placeholder={t('editor.field.next')} />
          <Input value={branch.label ?? ''} onChange={event => { onChange({ ...step, branches: branches.map((b, i) => (i === index ? { ...b, label: trimToUndefined(event.target.value) } : b)) }) }} placeholder={t('editor.field.label')} />
          <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={() => { onChange({ ...step, branches: branches.filter((_, i) => i !== index) }) }} aria-label={t('editor.remove.item')} />
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={() => { onChange({ ...step, branches: [...branches, createBranch()] }) }}>
        {t('editor.add.item')}
      </Button>

      <SectionLabel>{t('editor.section.loop')}</SectionLabel>
      <LoopEditor loop={step.loop} onChange={loop => { onChange({ ...step, loop }) }} t={t} />
    </div>
  )
}

/** gates 编辑（maxRetries/maxTokens/need_confirm）。 */
function GatesEditor({ gates, onChange, t }: {
  readonly gates: Gates | undefined
  readonly onChange: (gates: Gates | undefined) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const current = gates ?? {}
  return (
    <div className={css.gates}>
      <Input
        type="number"
        value={current.maxRetries ?? ''}
        onChange={event => { onChange({ ...current, maxRetries: parseOptionalNumber(event.target.value) }) }}
        placeholder={t('editor.field.maxRetries')}
      />
      <Input
        type="number"
        value={current.maxTokens ?? ''}
        onChange={event => { onChange({ ...current, maxTokens: parseOptionalNumber(event.target.value) }) }}
        placeholder={t('editor.field.maxTokens')}
      />
      <label className={css.checkbox}>
        <input
          type="checkbox"
          checked={current.need_confirm ?? false}
          onChange={event => { onChange({ ...current, need_confirm: event.target.checked }) }}
        />
        <span>{t('editor.field.needConfirm')}</span>
      </label>
    </div>
  )
}

/** loop 编辑（maxIterations/breakExpectation/next/exitTo）。 */
function LoopEditor({ loop, onChange, t }: {
  readonly loop: WorkflowStep['loop']
  readonly onChange: (loop: WorkflowStep['loop']) => void
  readonly t: TranslateNS<'sandore'>
}) {
  const current = loop ?? { maxIterations: 1 }
  return (
    <div className={css.loop}>
      <Input
        type="number"
        value={String(current.maxIterations)}
        onChange={event => { onChange({ ...current, maxIterations: parseOptionalNumber(event.target.value) ?? 1 }) }}
        placeholder={t('editor.field.maxIterations')}
        aria-label={t('editor.field.maxIterations')}
      />
      <Input value={current.breakExpectation ?? ''} onChange={event => { onChange({ ...current, breakExpectation: trimToUndefined(event.target.value) }) }} placeholder={t('editor.field.breakExpectation')} />
      <Input value={current.next ?? ''} onChange={event => { onChange({ ...current, next: trimToUndefined(event.target.value) }) }} placeholder={t('editor.field.next')} />
      <Input value={current.exitTo ?? ''} onChange={event => { onChange({ ...current, exitTo: trimToUndefined(event.target.value) }) }} placeholder={t('editor.field.exitTo')} />
    </div>
  )
}

/** Stage 节点：DisclosureRow 折叠（名称 + Step 数）+ 展开 Step 列表。 */
function StageNode({ stage, expanded, onToggle, onAddStep, onUpdateStage, onRemoveStage, t }: {
  readonly stage: WorkflowStage
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onAddStep: () => void
  readonly onUpdateStage: (stage: WorkflowStage) => void
  readonly onRemoveStage: () => void
  readonly t: TranslateNS<'sandore'>
}) {
  return (
    <DisclosureRow
      icon={<IconChevronRightOutline14 />}
      title={stage.name}
      open={expanded}
      expandable
      onToggle={onToggle}
      expandOnRowClick
      previewChevron={false}
      rowClassName={css.stageHeader}
      collapsedContent={<span className={css.stepCount}>{t('editor.steps.count', { count: stage.steps.length })}</span>}
    >
      <div className={css.steps}>
        {stage.steps.length === 0 ? (
          <span className={css.empty}>{t('editor.steps.empty')}</span>
        ) : (
          stage.steps.map(step => (
            <StepEditor
              key={step.id}
              step={step}
              onChange={next => { onUpdateStage({ ...stage, steps: stage.steps.map(s => (s.id === step.id ? next : s)) }) }}
              onRemove={() => { onUpdateStage({ ...stage, steps: stage.steps.filter(s => s.id !== step.id) }) }}
              t={t}
            />
          ))
        )}
        <div className={css.stepActions}>
          <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={onAddStep}>
            {t('editor.step.add')}
          </Button>
          <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} onClick={onRemoveStage}>
            {t('editor.remove.item')}
          </Button>
        </div>
      </div>
    </DisclosureRow>
  )
}

/** 渲染 DagEditor。 */
export function DagEditor({ t, initialYaml, initialId, save }: DagEditorProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(() =>
    initialYaml === undefined ? createBlankDefinition() : parseWorkflowYaml(initialYaml))
  const [id, setId] = useState<string | undefined>(initialId)
  const [expandedStageId, setExpandedStageId] = useState<string | undefined>(undefined)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })

  const preview = useMemo(() => serializeWorkflowYaml(definition), [definition])

  const patchStages = (patch: (stages: WorkflowStage[]) => WorkflowStage[]): void => {
    setDefinition(current => ({ ...current, stages: patch(current.stages) }))
  }

  const updateStage = (stageId: string, next: WorkflowStage): void => {
    patchStages(stages => stages.map(stage => (stage.id === stageId ? next : stage)))
  }

  const toggleStage = (stageId: string): void => {
    setExpandedStageId(current => (current === stageId ? undefined : stageId))
  }

  const addStage = (): void => {
    patchStages(stages => {
      const count = stages.length
      return [...stages, createStage(`阶段 ${count + 1}`)]
    })
  }

  const addStep = (stageId: string): void => {
    patchStages(stages => stages.map(stage => (stage.id !== stageId ? stage : { ...stage, steps: [...stage.steps, { id: newId('step') }] })))
  }

  const removeStage = (stageId: string): void => {
    patchStages(stages => stages.filter(stage => stage.id !== stageId))
  }

  const runSave = async (): Promise<void> => {
    setSaveState({ kind: 'pending' })
    try {
      const savedId = await save(id, serializeWorkflowYaml(definition))
      setId(savedId)
      // 回填保存后的真实 id 进编辑态模型，使 YAML 预览基线反映已保存内容。
      setDefinition(current => withDefinitionId(current, savedId))
      setSaveState({ kind: 'ok' })
    } catch (error) {
      const { message, details } = describeSaveError(error)
      setSaveState({ kind: 'error', message, details })
    }
  }

  return (
    <section className={css.editor} aria-label={t('editor.title')} data-sandore-dag-editor>
      <header className={css.header}>
        <span className={css.title}>{t('editor.title')}</span>
        <Button size="sm" variant="primary" disabled={saveState.kind === 'pending'} onClick={() => { void runSave() }}>
          {saveState.kind === 'pending' ? t('editor.saving') : t('editor.save')}
        </Button>
      </header>

      {saveState.kind === 'ok' && (
        <p className={css.success} role="status">{t('editor.save.success')}</p>
      )}
      {saveState.kind === 'error' && (
        <p className={css.error} role="alert">
          {saveState.details === undefined
            ? t('editor.save.failed', { message: saveState.message })
            : t('editor.save.failed', { message: `${saveState.message} — ${saveState.details}` })}
        </p>
      )}

      <div className={css.body}>
        <div className={css.dag}>
          {definition.stages.map((stage, index) => (
            <div key={stage.id} className={css.nodeWrap}>
              <StageNode
                stage={stage}
                expanded={expandedStageId === stage.id}
                onToggle={() => { toggleStage(stage.id) }}
                onAddStep={() => { addStep(stage.id) }}
                onUpdateStage={next => { updateStage(stage.id, next) }}
                onRemoveStage={() => { removeStage(stage.id) }}
                t={t}
              />
              {index < definition.stages.length - 1 && (
                <div className={css.connector} aria-hidden>
                  <IconChevronDownOutline14 />
                </div>
              )}
            </div>
          ))}
          <Button variant="outline" size="sm" icon={<IconPlusOutline16 />} onClick={addStage}>
            {t('editor.stage.add')}
          </Button>
        </div>

        <div className={css.preview}>
          <SectionLabel>{t('editor.preview')}</SectionLabel>
          <CodeBlock code={preview} lang="yaml" copyLabel={t('editor.preview')} />
        </div>
      </div>
    </section>
  )
}
