/**
 * CommandEditor：五类型命令（shell/prompt/agent/skill/mcp）编辑，供 Step command 与
 * 分支 condition / 循环 breakCondition 复用。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/CommandEditor
 */
import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandConfig } from 'dsh-sandore/schema'

import { COMMAND_TYPES, createCommand, updateCommandText, type CommandTextField, type CommandType } from './dag-editor-model.ts'
import type { SandoreKey } from './locales.ts'
import css from './DagEditor.module.css'

/** 命令类型的本地化标签键。 */
export const COMMAND_LABEL_KEYS = {
  shell: 'editor.command.shell',
  prompt: 'editor.command.prompt',
  agent: 'editor.command.agent',
  skill: 'editor.command.skill',
  mcp: 'editor.command.mcp',
} as const satisfies Record<CommandType, SandoreKey>

/** 渲染命令编辑（类型选择 + 对应 value 字段）。`types` 可限定可选类型（如条件判断仅 bash/prompt）。 */
export function CommandEditor({ command, onChange, t, types }: {
  readonly command: CommandConfig
  readonly onChange: (command: CommandConfig) => void
  readonly t: TranslateNS<'sandore'>
  /** 允许选择的命令类型；缺省为全部五类型。 */
  readonly types?: readonly CommandType[] | undefined
}) {
  const available = types ?? COMMAND_TYPES
  const update = (field: CommandTextField) => (value: string): void => { onChange(updateCommandText(command, field, value)) }
  return (
    <div className={css.command}>
      <div className={css.commandTypes} role="group" aria-label={t('editor.step.command')}>
        {available.map(type => (
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
