/**
 * DagEditor 的编辑态模型纯函数（无 React 依赖，可单测）。
 *
 * 定义经 `@deepseek-ai/dsh-sandore-workflow/yaml`（浏览器安全子路径）解析/序列化，
 * 编辑态模型即 `WorkflowDefinition`。此处提供新建骨架与五类型 command 工厂，
 * 供组件初始化与 Step 字段编辑复用，避免在 JSX 中散落结构常量。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/dag-editor-model
 */
import type {
  CommandConfig, DagBranch, InputFromItem, OutputToItem, PassThroughVar, WorkflowDefinition, WorkflowStage,
} from '@deepseek-ai/dsh-sandore-workflow/schema'

/** 五类型命令判别字段（对齐 `CommandConfig` discriminated union）。 */
export type CommandType = CommandConfig['type']

/** 全部五类型命令判别字段（编辑表单下拉项）。 */
export const COMMAND_TYPES: readonly CommandType[] = ['shell', 'prompt', 'agent', 'skill', 'mcp']

/** 生成带前缀的唯一 id（`{prefix}-{uuid}`），供 Stage/Step/ipt/opt 节点复用。 */
export function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

/** 构造一个新的空 Stage 节点（唯一 `stg-{uuid}` id + 空 steps）。 */
export function createStage(name: string): WorkflowStage {
  return { id: newId('stg'), name, steps: [] }
}

/** 构造一个新的输入绑定项（唯一 `ipt-{uuid}` id）。 */
export function createInputFromItem(): InputFromItem {
  return { id: newId('ipt') }
}

/** 构造一个新的输出绑定项（唯一 `opt-{uuid}` id）。 */
export function createOutputToItem(): OutputToItem {
  return { id: newId('opt') }
}

/** 构造一个空的透传变量项（`name`/`value`/`description` 待填）。 */
export function createPassThroughVar(): PassThroughVar {
  return { name: '', value: '', description: '' }
}

/** 构造一个空的分支项（`next` 待填）。 */
export function createBranch(): DagBranch {
  return { next: '' }
}

/** 去掉首尾空白，空串归 `undefined`（用于可选字段清除）。 */
export function trimToUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 解析可选的数字输入：空串/非法值归 `undefined`。 */
export function parseOptionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** 可编辑的命令文本字段（按类型收窄到 value 内的字段）。 */
export type CommandTextField = 'command' | 'promptText' | 'agentParamsTemplate' | 'providerId' | 'modelId'

/** 更新某类型命令的单个文本字段，返回新命令（可选字段空串 → 清除）。 */
export function updateCommandText(command: CommandConfig, field: CommandTextField, value: string): CommandConfig {
  const optional = trimToUndefined(value)
  switch (command.type) {
    case 'shell':
      return field === 'command' ? { type: 'shell', value: { command: value } } : command
    case 'prompt':
      if (field === 'promptText') return { type: 'prompt', value: { ...command.value, promptText: value } }
      if (field === 'providerId') return { type: 'prompt', value: { ...command.value, providerId: optional } }
      if (field === 'modelId') return { type: 'prompt', value: { ...command.value, modelId: optional } }
      return command
    case 'agent':
      if (field === 'promptText') return { type: 'agent', value: { ...command.value, promptText: value } }
      if (field === 'agentParamsTemplate') return { type: 'agent', value: { ...command.value, agentParamsTemplate: optional } }
      if (field === 'providerId') return { type: 'agent', value: { ...command.value, providerId: optional } }
      if (field === 'modelId') return { type: 'agent', value: { ...command.value, modelId: optional } }
      return command
    case 'skill':
      if (field === 'promptText') return { type: 'skill', value: { ...command.value, promptText: value } }
      if (field === 'providerId') return { type: 'skill', value: { ...command.value, providerId: optional } }
      return command
    case 'mcp':
      return field === 'promptText' ? { type: 'mcp', value: { promptText: value } } : command
  }
}

/**
 * 将保存后的真实 id 回填进定义模型（新建哨兵 `wfl-new` → `wfl-{uuid}`），
 * 使 YAML 预览基线反映已保存内容。
 * @param definition - 当前编辑态定义模型。
 * @param id - 保存回调返回的持久化 id。
 * @returns id 已更新的定义模型（其余字段不变）。
 */
export function withDefinitionId(definition: WorkflowDefinition, id: string): WorkflowDefinition {
  return { ...definition, id }
}

/**
 * 构造某类型的最小合法命令（值为空串，待用户填写）。
 * @param type - 命令类型。
 * @returns 该类型的空命令配置。
 */
export function createCommand(type: CommandType): CommandConfig {
  switch (type) {
    case 'shell':
      return { type: 'shell', value: { command: '' } }
    case 'prompt':
      return { type: 'prompt', value: { promptText: '' } }
    case 'agent':
      return { type: 'agent', value: { promptText: '' } }
    case 'skill':
      return { type: 'skill', value: { promptText: '' } }
    case 'mcp':
      return { type: 'mcp', value: { promptText: '' } }
  }
}

/** 新建定义的默认 id（首次保存由 Host `createDefinition` 生成 `wfl-{uuid}` 记录键）。 */
export const NEW_DEFINITION_ID = 'wfl-new'

/**
 * 构造最小合法定义骨架（单个空 Stage），供「新建定义」进入空白 DagEditor。
 *
 * `skills`/`mcps`/`agents`/`settings` 显式给出默认值以对齐 `WorkflowDefinitionSchema`
 * 的 `.default()` 输出类型；`serializeWorkflowYaml` → `parseWorkflowYaml` 可深层相等往返。
 * @param id - 定义 id（新建默认 `wfl-new`）。
 * @returns 最小合法定义。
 */
export function createBlankDefinition(id: string = NEW_DEFINITION_ID): WorkflowDefinition {
  return {
    id,
    name: '未命名工作流',
    version: '1.0.0',
    skills: [],
    mcps: [],
    agents: [],
    settings: { defaultTimeout: 120, maxConcurrentAgents: 4 },
    stages: [{ id: 'stg-1', name: '阶段 1', steps: [] }],
  }
}
