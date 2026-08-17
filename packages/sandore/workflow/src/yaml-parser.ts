/**
 * 工作流 YAML 的 V1/V2 双格式解析与序列化（浏览器安全）。
 *
 * `parseWorkflowYaml` 用 `yaml` 包的 `parseDocument(text, { prettyErrors: true })`
 * 解析（语法错误抛 `WorkflowYamlError('YAML_PARSE')`），检测 V1（`stages[].scenarios[]`）
 * 并自动 `convertLegacyToV2()` 转两级 `stages[].steps[]`，再走 `WorkflowDefinitionSchema`
 * 验证（失败抛 `WorkflowYamlError('DEFINITION_INVALID', { cause })`），最后做 `next`
 * 引用完整性校验。`serializeWorkflowYaml` 序列化结果可被再次解析且深层相等。
 * @module @deepseek-ai/dsh-sandore-workflow/src/yaml-parser
 */
import { parseDocument, stringify, type YAMLError } from 'yaml'

import { WorkflowYamlError } from './yaml-error.ts'
import { WorkflowDefinitionSchema, type DagBranch, type DagLoop, type WorkflowDefinition } from './schema.ts'

/** V1 旧 `PromptConfig` 类型名 → V2 `CommandConfig` 类型名的映射。 */
const PROMPT_TYPE_TO_COMMAND_TYPE: Record<string, string> = {
  Bash: 'shell',
  PromptTemplate: 'prompt',
  AgentTemplate: 'agent',
  SkillTemplate: 'skill',
  McpTemplate: 'mcp',
}

/** 将旧 `PromptConfig` 类型名映射为 V2 命令类型名（未知类型回退为 `prompt`）。 */
function promptToCommandType(type: string): string {
  return PROMPT_TYPE_TO_COMMAND_TYPE[type] ?? 'prompt'
}

/** 收窄任意值为 `Record<string, unknown>`。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 渲染单个 YAML 语法错误，附行列信息。 */
function describeYamlError(error: YAMLError): string {
  const position = error.linePos?.[0]
  const where = position === undefined ? '' : ` at line ${String(position.line)}, column ${String(position.col)}`
  return `${error.code}${where}`
}

/** 渲染任意抛出的值为可读消息（诊断用，永不按消息路由）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 将 V1 的单个 Task 转为 V2 Step（`prompt`（旧 `PromptConfig`）→ `command`）。 */
function convertTaskToStep(task: unknown): Record<string, unknown> {
  if (!isRecord(task)) {
    throw new WorkflowYamlError('V1 task must be an object', 'DEFINITION_INVALID')
  }
  const { prompt, ...rest } = task
  if (isRecord(prompt)) {
    const type = typeof prompt.type === 'string' ? prompt.type : ''
    return { ...rest, command: { type: promptToCommandType(type), value: prompt.value } }
  }
  return { ...rest }
}

/**
 * 将单个 Stage 的 `scenarios[]` 展平为 `steps[]`：同一 Scenario 内相邻 Task 依次接
 * `branches: [{ next }]`（tsk-a→tsk-b→tsk-c），Scenario 的 `next` 落到其最后一个
 * Step（指向下一 Scenario 的首个 Task）。显式 `branches` 不被覆盖。
 */
function convertStage(stage: Record<string, unknown>): Record<string, unknown> {
  const scenarios = stage.scenarios
  if (!Array.isArray(scenarios)) return stage

  const steps: unknown[] = []
  const scenarioSteps = new Map<string, unknown[]>()
  for (const scenario of scenarios) {
    if (!isRecord(scenario)) continue
    const tasks = Array.isArray(scenario.tasks) ? scenario.tasks : []
    const converted = tasks.map(convertTaskToStep)
    // 同一 Scenario 内相邻 Task 依次设 branches（线性链）。
    for (let index = 0; index + 1 < converted.length; index++) {
      const current = converted[index]
      const following = converted[index + 1]
      if (current === undefined || following === undefined) continue
      if (current.branches === undefined) current.branches = [{ next: following.id }]
    }
    scenarioSteps.set(String(scenario.id), converted)
    steps.push(...converted)
  }

  // Scenario.next 指向下一个 Scenario：解析为其首个 Task（Step），落到当前 Scenario 的最后一个 Step。
  for (const scenario of scenarios) {
    if (!isRecord(scenario)) continue
    const next = scenario.next
    if (typeof next !== 'string') continue
    const own = scenarioSteps.get(String(scenario.id))
    const target = scenarioSteps.get(next)
    if (own === undefined || own.length === 0 || target === undefined || target.length === 0) continue
    const last = own[own.length - 1]
    const firstTarget = target[0]
    if (isRecord(last) && isRecord(firstTarget) && last.branches === undefined) {
      last.branches = [{ next: firstTarget.id }]
    }
  }

  const rest: Record<string, unknown> = Object.fromEntries(
    Object.entries(stage).filter(([key]) => key !== 'scenarios'),
  )
  return { ...rest, steps }
}

/**
 * 检测 V1 三级结构（`stages[].scenarios[]`）并自动转换为 V2 两级结构
 * （`stages[].steps[]`）。同一 Stage 同时含 `steps[]` 与 `scenarios[]` 视为混合格式，
 * 抛 `WorkflowYamlError('DEFINITION_INVALID')`。
 */
export function convertLegacyToV2(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const stages = raw.stages
  if (!Array.isArray(stages)) return raw

  let hasScenarios = false
  for (const stage of stages) {
    if (!isRecord(stage)) continue
    const hasSteps = Array.isArray(stage.steps)
    const hasScen = Array.isArray(stage.scenarios)
    if (hasSteps && hasScen) {
      throw new WorkflowYamlError(`stage '${String(stage.id)}' mixes 'steps' and 'scenarios'`, 'DEFINITION_INVALID')
    }
    if (hasScen) hasScenarios = true
  }
  if (!hasScenarios) return raw

  return { ...raw, stages: stages.map(stage => (isRecord(stage) ? convertStage(stage) : stage)) }
}

/** 具有 DAG 流控字段的节点（Stage 与 Step 共用）。 */
interface FlowNode {
  id: string
  branches?: DagBranch[] | undefined
}

/**
 * 校验节点 ID 引用完整性：
 * - `branches[].next`、`branches[].loop.next`、`branches[].loop.exitTo` 引用的节点 ID 均存在；
 * - `inputFrom[].path` 的 `stageId[.stepId[.outputToId]]` 前两段（Stage/Step 节点 ID）存在。
 * 不满足时抛 `WorkflowYamlError('DEFINITION_INVALID')`。
 */
function validateReferences(definition: WorkflowDefinition): void {
  // Stage/Step id 唯一性：重复 id 会让 DAG 导航与编辑按 id 命中多个节点。
  const seenStageIds = new Set<string>()
  for (const stage of definition.stages) {
    if (seenStageIds.has(stage.id)) {
      throw new WorkflowYamlError(`duplicate stage id '${stage.id}'`, 'DEFINITION_INVALID')
    }
    seenStageIds.add(stage.id)
  }

  const seenStepPositionIds = new Set<string>()
  for (const stage of definition.stages) {
    for (const step of stage.steps) {
      if (seenStepPositionIds.has(step.id)) {
        throw new WorkflowYamlError(`duplicate step id '${step.id}'`, 'DEFINITION_INVALID')
      }
      seenStepPositionIds.add(step.id)
    }
  }

  const seenStepDefinitionIds = new Set<string>()
  for (const step of definition.steps ?? []) {
    if (seenStepDefinitionIds.has(step.id)) {
      throw new WorkflowYamlError(`duplicate step id '${step.id}'`, 'DEFINITION_INVALID')
    }
    seenStepDefinitionIds.add(step.id)
  }

  const stageIds = new Set(definition.stages.map(stage => stage.id))
  const stepIds = new Set<string>()
  for (const step of definition.steps ?? []) stepIds.add(step.id)
  for (const stage of definition.stages) {
    for (const step of stage.steps) stepIds.add(step.id)
  }
  const nodeIds = new Set<string>([...stageIds, ...stepIds])

  const checkTarget = (target: string | undefined, where: string): void => {
    if (target !== undefined && !nodeIds.has(target)) {
      throw new WorkflowYamlError(`${where} references missing node '${target}'`, 'DEFINITION_INVALID')
    }
  }
  const checkNode = (node: FlowNode, kind: string): void => {
    for (const branch of node.branches ?? []) {
      checkTarget(branch.next, `${kind} '${node.id}'.branches.next`)
      if (branch.loop !== undefined) {
        checkTarget(branch.loop.next, `${kind} '${node.id}'.branches.loop.next`)
        checkTarget(branch.loop.exitTo, `${kind} '${node.id}'.branches.loop.exitTo`)
      }
    }
  }

  for (const stage of definition.stages) {
    checkNode(stage, 'stage')
    for (const step of stage.steps) checkNode(step, 'step')
  }
  for (const step of definition.steps ?? []) checkNode(step, 'step')

  const allSteps = [...(definition.steps ?? []), ...definition.stages.flatMap(stage => stage.steps)]
  for (const step of allSteps) {
    for (const input of step.inputFrom ?? []) {
      const path = input.path
      // 契约引用（`${stage.xxx.artifact}`）与缺失的 path 不参与节点校验。
      if (path === undefined || path.startsWith('${')) continue
      const [stageId, stepId] = path.split('.')
      if (stageId !== undefined && !stageIds.has(stageId)) {
        throw new WorkflowYamlError(`step '${step.id}'.inputFrom references missing stage '${stageId}'`, 'DEFINITION_INVALID')
      }
      if (stepId !== undefined && !stepIds.has(stepId)) {
        throw new WorkflowYamlError(`step '${step.id}'.inputFrom references missing step '${stepId}'`, 'DEFINITION_INVALID')
      }
    }
  }
}

/**
 * 解析工作流 YAML 文本为 `WorkflowDefinition`。
 *
 * 流程：YAML 语法解析（错误 → `YAML_PARSE`）→ V1 自动转换 → Zod 验证（失败 →
 * `DEFINITION_INVALID`，`cause` 挂原始 `ZodError`）→ `next` 引用完整性校验。
 * @param text - YAML 文本（V1 三级或 V2 两级格式）。
 * @returns 验证通过的 `WorkflowDefinition`。
 */
export function parseWorkflowYaml(text: string): WorkflowDefinition {
  const document = parseDocument(text, { prettyErrors: true })
  if (document.errors.length > 0) {
    const detail = document.errors.map(describeYamlError).join('; ')
    throw new WorkflowYamlError(`invalid YAML: ${detail}`, 'YAML_PARSE')
  }

  const data = convertLegacyToV2(document.toJS())
  let definition: WorkflowDefinition
  try {
    definition = WorkflowDefinitionSchema.parse(data)
  } catch (error) {
    throw new WorkflowYamlError(`invalid workflow definition: ${describeError(error)}`, 'DEFINITION_INVALID', { cause: error })
  }
  validateReferences(definition)
  return definition
}

/**
 * 序列化 `WorkflowDefinition` 为 YAML 文本（DagEditor 保存 / round-trip 测试用）。
 * 序列化结果可被 {@link parseWorkflowYaml} 再次解析且深层相等。
 * @param definition - 规范化后的工作流定义。
 * @returns YAML 文本。
 */
export function serializeWorkflowYaml(definition: WorkflowDefinition): string {
  return stringify(definition)
}
