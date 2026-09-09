/**
 * CommandEditor：五类型命令（shell/prompt/agent/skill/mcp）编辑，供 Step command 与
 * 分支 condition / 循环 breakCondition 复用。
 *
 * 三级分离 plan §6.5 修复项 3：prompt/agent/skill/mcp 的提示词输入框从单行改为
 * 多行 textarea（`ImeSafeTextarea`，可大段输入）；其余短字段用 `ImeSafeInput`
 * （composition 守卫，中文可输入）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/CommandEditor
 */
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandConfig } from '@meiyukichan/dsh-sandore/schema'

import { COMMAND_TYPES, createCommand, updateCommandText, type CommandTextField, type CommandType } from './dag-editor-model.ts'
import { ImeSafeInput, ImeSafeTextarea } from './ime-safe-input.tsx'
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
          <ImeSafeInput className={css.compactInput ?? ''} value={command.value.command} onCommit={update('command')} placeholder={t('editor.field.command')} />
        )}
        {command.type === 'prompt' && (
          <>
            <ImeSafeTextarea value={command.value.promptText} onCommit={update('promptText')} placeholder={t('editor.field.promptText')} aria-label={t('editor.field.promptText')} />
            <ImeSafeInput className={css.compactInput ?? ''} value={command.value.providerId ?? ''} onCommit={update('providerId')} placeholder={t('editor.field.providerId')} />
            <ImeSafeInput className={css.compactInput ?? ''} value={command.value.modelId ?? ''} onCommit={update('modelId')} placeholder={t('editor.field.modelId')} />
          </>
        )}
        {command.type === 'agent' && (
          <>
            <ImeSafeTextarea value={command.value.promptText} onCommit={update('promptText')} placeholder={t('editor.field.promptText')} aria-label={t('editor.field.promptText')} />
            <ImeSafeInput className={css.compactInput ?? ''} value={command.value.agentParamsTemplate ?? ''} onCommit={update('agentParamsTemplate')} placeholder={t('editor.field.agentParamsTemplate')} />
            <ImeSafeInput className={css.compactInput ?? ''} value={command.value.providerId ?? ''} onCommit={update('providerId')} placeholder={t('editor.field.providerId')} />
            <ImeSafeInput className={css.compactInput ?? ''} value={command.value.modelId ?? ''} onCommit={update('modelId')} placeholder={t('editor.field.modelId')} />
          </>
        )}
        {command.type === 'skill' && (
          <>
            <ImeSafeTextarea value={command.value.promptText} onCommit={update('promptText')} placeholder={t('editor.field.promptText')} aria-label={t('editor.field.promptText')} />
            <ImeSafeInput className={css.compactInput ?? ''} value={command.value.providerId ?? ''} onCommit={update('providerId')} placeholder={t('editor.field.providerId')} />
          </>
        )}
        {command.type === 'mcp' && (
          <ImeSafeTextarea value={command.value.promptText} onCommit={update('promptText')} placeholder={t('editor.field.promptText')} aria-label={t('editor.field.promptText')} />
        )}
      </div>
    </div>
  )
}
