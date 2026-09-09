/**
 * sandore_workflow —— sandore 工作流统一管理工具（全局注册 + execute 期 gate）。
 *
 * 单个模型工具、`action` 字段区分六类操作（方案见 docs/design/workflow-manager-tool.md，
 * 决策记录 §6）：`get-def`（定义详情/列表，stage/step 分离式合并视图）、`update-def`
 * （定义编排：workflow 元数据 / stage 整节点 / step 拆段写回，step 级必传 stageId）、
 * `run`（创建实例，attachSession 默认 true 复用调用会话为 hostSessionId）、`get-state`
 * （实例状态：列表 + stage/step 定点）、`lib-list`/`lib-get`（工作流定义 / Step 库 /
 * 微流程库浏览，引用计数与删除保护同口径）。
 *
 * 注册方式对齐 `ask-tool.ts` 的全局注册前例：引擎 `[Service.init]` 经
 * {@link registerGlobalManagerTool} 在 `ctx.tools` 注册（tools 服务缺失时静默跳过）；
 * 不 import `@deepseek-ai/dsh-tools` 运行时（结构兼容 DSH `ToolDefinition` 的普通对象，
 * 接缝哲学）；parameters/output 自带规范化 JSON Schema（required 只用 object 节点
 * 字符串数组）。execute 期 gate：仅顶层主代理会话（无 parentSession）可调用。
 *
 * 定义读写以 definitions 表 yaml 为唯一事实来源：读 = `parseWorkflowYaml`；写 =
 * 对象级 patch → `serializeWorkflowYaml` → `definitions.put`（元数据同步 + 往返校验，
 * 对齐 `remote.updateYaml` 的原子性）。库表只读（浏览），不参与运行。
 * @module @meiyukichan/dsh-sandore/workflow/src/manager-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'

import { SandoreError } from './errors.ts'
import { collectLibraryReferences, toLibrarySummary } from './library-views.ts'
import type {
  DagBranch,
  MicroflowRecord,
  StageStep,
  StepRecord,
  WorkflowDefinition,
  WorkflowDefinitionRecord,
  WorkflowStage,
  WorkflowStep,
  WorkflowTaskState,
} from './schema.ts'
import { WorkflowStageSchema, WorkflowStepSchema } from './schema.ts'
import type { DagInstanceState, DagRun, DagStartRequest, StartModelSelection } from './types.ts'
import { parseWorkflowYaml, serializeWorkflowYaml } from './yaml-parser.ts'

/** 持久化层执行段类型（`WorkflowTaskState.executedSteps` 元素；可选属性含 `| undefined`，
 * 与 types.ts 手写接口在 exactOptionalPropertyTypes 下不互换，故用 schema 推导别名）。 */
type ExecutedStepRow = WorkflowTaskState['executedSteps'][number]

// ── 常量与公开 schema ─────────────────────────────────────────────────────────

/** 工具注册名（Q1 已定：sandore 前缀 + workflow 主题）。 */
export const WORKFLOW_MANAGER_TOOL_NAME = 'sandore_workflow'

/** sandore_workflow 支持的全部 action（Q2 已定：kebab 风格）。 */
export type SandoreManagerAction = 'get-def' | 'update-def' | 'run' | 'get-state' | 'lib-list' | 'lib-get'

/** get-state 摘要行的文本预览上限（字符；全文用 includeDetail 放开）。 */
const OUTPUT_PREVIEW_CHARS = 2000
/** includeDetail 时 step 会话消息的尾部条数上限。 */
const SESSION_MESSAGES_TAIL = 10
/** render 输出的字符上限（对齐 DSH 工具结果封顶习惯）。 */
const RENDER_MAX_CHARS = 20000

/** 工具 parameters（规范化 JSON Schema：required 只在 object 节点、字符串数组）。 */
export const WORKFLOW_MANAGER_PARAMETERS = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['get-def', 'update-def', 'run', 'get-state', 'lib-list', 'lib-get'],
      description:
        '操作类型：get-def=查询工作流/Stage/Step 定义（不传 workflowId 时返回定义列表）；' +
        'update-def=编辑定义节点；run=创建并启动一个工作流实例（可绑定当前会话）；' +
        'get-state=查询实例当前状态；lib-list=浏览已有 工作流/Step 库(Agent)/微流程库(Microflow)；' +
        'lib-get=读取单个库条目详情（供编排引用/借鉴）。',
    },
    workflowId: {
      type: 'string',
      description:
        '工作流定义 ID（wfl-…）。get-state 用于过滤实例列表；' +
        '涉及 Stage/Step 的定义查改必传（Stage/Step id 只在单个工作流内唯一）；run 必传。',
    },
    stageId: {
      type: 'string',
      description: 'Stage id（工作流内唯一）。get-def/get-state 定点用；update-def 定位 Step 时必传（Q4）。',
    },
    stepId: {
      type: 'string',
      description:
        'Step id（工作流内顶层定义按 id 交叉引用）。get-def/get-state 定点 Step 用（多 stage slot 命中时返回全部）；update-def 定位 Step 时须与 stageId 同传。',
    },
    fields: {
      type: 'object',
      additionalProperties: true,
      description: 'update-def 的新值（浅合并到定位节点；节点 id 不可变更；数组字段整体替换）。',
    },
    originalInput: {
      type: 'string',
      description: 'run 必填：用户原始需求（成为实例宿主会话标题/需求）。',
    },
    cwd: {
      type: 'string',
      description: 'run 用工作目录（必须为已存在目录；hostAgent 据此 attach web workspace）。缺省取调用会话的 header.cwd。',
    },
    attachSession: {
      type: 'boolean',
      description:
        'run 可选，默认 true：把当前调用会话作为本实例宿主主代理（hostSessionId 复用，工作流存活期间该会话被引擎冻结）；' +
        'false 时引擎新建独立宿主会话（与 Web UI「新建实例」一致，当前对话零副作用）。',
    },
    model: {
      type: 'object',
      additionalProperties: false,
      description: 'run 可选：本实例 L2 默认模型路由。',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
      },
    },
    permission: {
      type: 'string',
      enum: ['read-only', 'workspace-write', 'danger-full-access'],
      description: 'run 可选：实例权限预设（缺省继承宿主会话当前策略）。',
    },
    instanceId: {
      type: 'string',
      description: 'get-state 的实例 id（taskId）。缺省时返回实例摘要列表（可带 workflowId/status 过滤）。',
    },
    status: {
      type: 'string',
      description: 'get-state 列表分支的过滤：pending/running/interacting/completed/failed/aborted/paused。',
    },
    attemptIndex: {
      type: 'integer',
      description: 'get-state 定点 step 时指定执行段序号（缺省返回最新段）。',
    },
    includeDetail: {
      type: 'boolean',
      description: 'get-state 是否携带 output/会话消息等大字段（默认 false，只回摘要 + 截断预览）。',
    },
    lib: {
      type: 'string',
      enum: ['workflow', 'step', 'microflow'],
      description: 'lib-list/lib-get 的库类型：workflow=工作流定义、step=Step 库（UI「Agent 库」）、microflow=微流程库（UI「Microflow 库」）。lib-list 缺省三类全列。',
    },
    entryId: {
      type: 'string',
      description: 'lib-get 的库条目 id（steps/microflows 表记录键；与工作流 yaml 内 stage/step 节点引用的是同一个字符串 id）。',
    },
  },
}

/** 工具描述（描述即契约，对齐 tool-workflow 的 DESCRIPTION 习惯）。 */
export const WORKFLOW_MANAGER_TOOL_DESCRIPTION = [
  'Sandore workflow manager. One tool, six actions discriminated by `action`: query/edit workflow definitions, run a workflow instance, query instance state, and browse the definition/step/microflow libraries.',
  '',
  'Addressing rules (hard constraints):',
  '- Stage/Step ids are unique only inside a single workflow yaml (the same library entry id can be inlined into many workflows), so any stage/step-level operation MUST pass `workflowId`; `run` also requires it.',
  '- `update-def` at step level additionally REQUIRES `stageId` (the full step definition lives once in top-level `steps[]`; flow slots `{id, branches}` live inside stages). Reads (get-def/get-state) may omit stageId: all matching slots are returned.',
  '',
  'Actions:',
  '- get-def: no args = definition list summaries; +workflowId = full merged definition (stages flow slots × top-level step definitions, engine/UI-identical merge); +stageId / +stepId = targeted stage/step merged view + in-library hints.',
  '- update-def: workflowId only = shallow-merge top-level metadata fields (name/version/description/engine/skills/mcps/agents/settings/rules/gates); +stageId = replace that WorkflowStage node (id immutable); +stageId+stepId = replace that step (definition fields -> top-level `steps[stepId]`, branches/inputFrom -> the stage slot). Write path: patch -> serialize -> parse-validate -> put (atomic, old value kept on failure). Warnings are returned when a referenced flow slot lacks a top-level definition (such a workflow saves but fails at runtime when the step executes).',
  '- run: workflowId + originalInput required; cwd defaults to the calling session header cwd (must be an existing directory); optional model/permission. attachSession defaults to true: the calling top-level session becomes the instance host agent (hostSessionId reuse) — its questions/permissions surface here, but the session is frozen by the engine while the instance is alive; pass attachSession:false to let the engine create a dedicated host session (same as the Web UI new-instance flow). Returns {instanceId, status}; execution is fire-and-forget, poll with get-state.',
  '- get-state: no instanceId = instance summary list (filter by workflowId/status); +instanceId = full snapshot summary (stageInfos, executed step summary rows, pending interactions, current stage); +stageId / +stepId = targeted stage contract / step execution segments (latest by default, attemptIndex to pick). Large fields (output/sessionMessages) are truncated unless includeDetail.',
  '- lib-list: browse existing entries of the three libraries (default all): workflow definitions, Step library (UI: Agent 库), Microflow library (UI: Microflow 库); rows carry referencedBy counts (same criterion as delete protection).',
  '- lib-get: one library entry full record (step/microflow) + referencing workflows detail; use get-def for a workflow definition detail.',
  '',
  'Update semantics: last-write-wins (no optimistic locking) — always get-def first, then update-def against that snapshot. update-def (or deleting a definition elsewhere) never changes a running instance: each instance keeps the definition parsed at start, and terminal instances stay readable from their own state snapshots; crash-recovery of a non-terminal instance still requires the definition record.',
  '',
  'Libraries are independent snapshots: editing a library entry never changes saved workflows (and vice versa) — borrow fields via lib-get + update-def.',
].join('\n')

// ── 入参校验（zod + 运行时跨字段规则） ────────────────────────────────────────

const ModelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

/** 工具入参（先 zod 结构校验，再 {@link assertArgsRules} 跨字段规则）。 */
export const ManagerToolArgsSchema = z.object({
  action: z.enum(['get-def', 'update-def', 'run', 'get-state', 'lib-list', 'lib-get']),
  workflowId: z.string().optional(),
  stageId: z.string().optional(),
  stepId: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  originalInput: z.string().optional(),
  cwd: z.string().optional(),
  attachSession: z.boolean().optional(),
  model: ModelSelectionSchema.optional(),
  permission: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  instanceId: z.string().optional(),
  status: z.string().optional(),
  attemptIndex: z.number().int().nonnegative().optional(),
  includeDetail: z.boolean().optional(),
  lib: z.enum(['workflow', 'step', 'microflow']).optional(),
  entryId: z.string().optional(),
})

export type ManagerToolArgs = z.infer<typeof ManagerToolArgsSchema>

/**
 * 跨字段硬约束（Q4 / §1.3）：
 * ① 定义寻址类 action（get-def/update-def）涉及 stage/step 时必传 workflowId
 * （get-state 按 instanceId 定点，不适用）；② update-def 定位 step 必传 stageId；
 * ③ run 必传 originalInput；④ lib-get 必须 lib∈{step,microflow} 且带 entryId。
 */
function assertArgsRules(args: ManagerToolArgs): void {
  if (args.action !== 'get-state' && (args.stageId !== undefined || args.stepId !== undefined) && args.workflowId === undefined) {
    throw new SandoreError('stage/step 级定义操作必须携带 workflowId（stage/step id 只在单个工作流内唯一；get-state 用 instanceId 定点）', 'INVALID_OPERATION')
  }
  if (args.action === 'update-def' && args.stepId !== undefined && args.stageId === undefined) {
    throw new SandoreError('update-def 的 step 级定位必须携带 stageId（顶层定义单份、流控位按 stage 定位）', 'INVALID_OPERATION')
  }
  if (args.action === 'run') {
    if (args.workflowId === undefined) throw new SandoreError('run 必须携带 workflowId', 'INVALID_OPERATION')
    if (args.originalInput === undefined) throw new SandoreError('run 必须携带 originalInput（用户原始需求）', 'INVALID_OPERATION')
  }
  if (args.action === 'update-def' && args.workflowId === undefined) {
    throw new SandoreError('update-def 必须携带 workflowId', 'INVALID_OPERATION')
  }
  if (args.action === 'lib-get') {
    if (args.lib === 'workflow' || args.lib === undefined) {
      throw new SandoreError("lib-get 需要 lib ∈ {'step','microflow'}（workflow 定义详情请用 action='get-def'）", 'INVALID_OPERATION')
    }
    if (args.entryId === undefined) throw new SandoreError('lib-get 必须携带 entryId', 'INVALID_OPERATION')
  }
}

// ── 执行上下文与 host seam（最小结构面，engine 结构满足） ─────────────────────

/** 工具执行上下文最小面（DSH 工具注册表注入；结构兼容 dsh Agent/Session）。 */
export interface SandoreManagerToolExec {
  readonly agent?: {
    readonly session?: {
      readonly id?: string
      readonly header?: {
        readonly cwd?: string
        readonly parentSession?: string
      }
    }
  }
  readonly signal?: AbortSignal
}

/** KvTable 最小面（`@deepseek-ai/dsh-storage-domain` KvTable 的用到的子集）。 */
export interface TableView<V> {
  get(key: string): V | undefined
  entries(): Iterable<[string, V]>
  put(key: string, value: V): Promise<void>
}

/** sandorePersistence 的最小面（engine 侧 `ctx.get('sandorePersistence')` 包装）。 */
export interface SandoreManagerPersistenceSeam {
  readonly definitions: TableView<WorkflowDefinitionRecord>
  readonly steps: TableView<StepRecord>
  readonly microflows: TableView<MicroflowRecord>
  readonly state: TableView<WorkflowTaskState>
  writeDefinitionToLibraries(definition: WorkflowDefinition): Promise<void>
}

/** 工具宿主 seam（engine 公开方法 + persistence 访问器；全部只调公开面）。 */
export interface SandoreManagerToolHost {
  startInstance(request: DagStartRequest): Promise<DagRun>
  getState(instanceId: string): DagInstanceState
  getInstanceState(instanceId: string): WorkflowTaskState | undefined
  persistence(): SandoreManagerPersistenceSeam | undefined
}

/** 工具统一结果信封（沿用 packages/tool 的 SandoreToolResult 思路，放宽 data）。 */
export interface SandoreManagerToolResult {
  ok: boolean
  action?: SandoreManagerAction
  data?: unknown
  reason?: string
  error?: { code: string; message: string }
  warnings?: string[]
}

/** 从任意抛出值提取摘要（结构判定，不 import 运行时）。 */
function summarizeError(err: unknown): { code: string; message: string } {
  if (!(err instanceof Error)) {
    return { code: 'UNKNOWN', message: String(err) }
  }
  const code = 'code' in err && typeof err.code === 'string' ? err.code : 'UNKNOWN'
  return { code, message: err.message }
}

/**
 * 错误信封（engine 抛出的 `SandoreError` 摘要透传）。zod 问题按阶段映射：
 * 入参结构问题（args 未解析成功）→ `INVALID_OPERATION`；节点校验问题（action 已定）
 * → `DEFINITION_INVALID`（与 yaml 往返校验同码）。
 */
function errorEnvelope(action: SandoreManagerAction | undefined, err: unknown): SandoreManagerToolResult {
  if (err instanceof z.ZodError) {
    const message = err.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
    return {
      ok: false,
      ...(action === undefined ? {} : { action }),
      reason: message,
      error: { code: action === undefined ? 'INVALID_OPERATION' : 'DEFINITION_INVALID', message },
    }
  }
  const summary = summarizeError(err)
  return { ok: false, ...(action === undefined ? {} : { action }), reason: summary.message, error: summary }
}

/** execute 期 gate（Q7 已定）：仅顶层主代理会话（无 parentSession）可调用。 */
function assertCallerIsTopLevel(exec: SandoreManagerToolExec): void {
  const agent = exec.agent
  if (agent === undefined || agent.session === undefined) {
    throw new SandoreError('sandore_workflow 仅可由顶层主代理会话调用（exec.agent 缺失）', 'INVALID_OPERATION')
  }
  if (agent.session.header?.parentSession !== undefined) {
    throw new SandoreError('sandore_workflow 仅可由顶层主代理会话调用（当前调用方是委派子代理）', 'INVALID_OPERATION')
  }
}

/** execute 统一入口：zod 结构校验 → gate → 跨字段规则 → 分发；任何抛错转错误信封。 */
export async function executeManagerTool(
  host: SandoreManagerToolHost,
  raw: unknown,
  exec: SandoreManagerToolExec,
): Promise<SandoreManagerToolResult> {
  let action: SandoreManagerAction | undefined
  try {
    const args = ManagerToolArgsSchema.parse(raw)
    action = args.action
    assertCallerIsTopLevel(exec)
    assertArgsRules(args)
    switch (args.action) {
      case 'get-def':
        return { ok: true, action, data: await doGetDef(host, args) }
      case 'update-def':
        return await doUpdateDef(host, args)
      case 'run':
        return { ok: true, action, data: await doRun(host, args, exec) }
      case 'get-state':
        return { ok: true, action, data: await doGetState(host, args) }
      case 'lib-list':
        return { ok: true, action, data: await doListLibraries(host, args) }
      case 'lib-get':
        return { ok: true, action, data: await doGetLibraryEntry(host, args) }
    }
  } catch (err) {
    return errorEnvelope(action, err)
  }
}

// ── 分离式合并视图（对齐 client mergedStepsOf / engine 1918-1923） ────────────

/** 合并视图 Step（流控位 branches × 顶层完整定义）。 */
export type MergedStepView = WorkflowStep & { branches?: DagBranch[] }

/** 分离式合并：slot 流控位 × 顶层完整定义（顶层缺失退回 `{ id }` 骨架，运行期同款退化）。 */
export function mergedStepView(definition: WorkflowDefinition, slot: StageStep): MergedStepView {
  const full = definition.steps?.find(step => step.id === slot.id)
  return { ...(full ?? { id: slot.id }), ...(slot.branches === undefined ? {} : { branches: slot.branches }) }
}

/** 定点 Stage 的合并视图；不存在抛 `NODE_NOT_FOUND`。 */
export function mergedStageView(definition: WorkflowDefinition, stageId: string): { stage: WorkflowStage; steps: MergedStepView[] } {
  const stage = definition.stages.find(candidate => candidate.id === stageId)
  if (stage === undefined) {
    throw new SandoreError(`stage '${stageId}' not found in workflow '${definition.id}'`, 'NODE_NOT_FOUND')
  }
  return { stage, steps: stage.steps.map(slot => mergedStepView(definition, slot)) }
}

/** stepId 在各 stage 流控位中的出现点（编辑定位/读取展示用）。 */
export function findStepSlots(definition: WorkflowDefinition, stepId: string): Array<{ stageId: string; slot: StageStep }> {
  const slots: Array<{ stageId: string; slot: StageStep }> = []
  for (const stage of definition.stages) {
    for (const slot of stage.steps) {
      if (slot.id === stepId) slots.push({ stageId: stage.id, slot })
    }
  }
  return slots
}

// ── persistence / 定义装载辅助 ────────────────────────────────────────────────

function requirePersistence(host: SandoreManagerToolHost): SandoreManagerPersistenceSeam {
  const persistence = host.persistence()
  if (persistence === undefined) {
    throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION')
  }
  return persistence
}

function requireDefinitionRecord(persistence: SandoreManagerPersistenceSeam, workflowId: string): WorkflowDefinitionRecord {
  const record = persistence.definitions.get(workflowId)
  if (record === undefined) {
    throw new SandoreError(`definition '${workflowId}' not found`, 'NODE_NOT_FOUND')
  }
  return record
}

function loadDefinition(persistence: SandoreManagerPersistenceSeam, workflowId: string): { record: WorkflowDefinitionRecord; definition: WorkflowDefinition } {
  const record = requireDefinitionRecord(persistence, workflowId)
  return { record, definition: parseWorkflowYaml(record.yaml) }
}

/** 统计定义规模（stage 数 + 顶层 step 定义数；坏 yaml 由调用方 catch）。 */
function definitionCounts(definition: WorkflowDefinition): { stageCount: number; stepCount: number } {
  return { stageCount: definition.stages.length, stepCount: definition.steps?.length ?? 0 }
}

/** 库提示（inLibrary 展示用）：present = 库表存在同 id 条目（快照）；附条目 name/updatedAt。 */
function libraryHint(
  table: { get(key: string): { name: string; updatedAt: string } | undefined },
  id: string,
): { present: boolean; name?: string; libraryUpdatedAt?: string } {
  const record = table.get(id)
  if (record === undefined) return { present: false }
  return { present: true, name: record.name, libraryUpdatedAt: record.updatedAt }
}

// ── get-def ───────────────────────────────────────────────────────────────────

async function doGetDef(host: SandoreManagerToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host)
  if (args.workflowId === undefined) {
    const rows: Array<Record<string, unknown>> = []
    for (const [workflowId, record] of persistence.definitions.entries()) {
      try {
        const definition = parseWorkflowYaml(record.yaml)
        rows.push({
          workflowId,
          name: record.name,
          version: record.version,
          ...(record.description === undefined ? {} : { description: record.description }),
          ...definitionCounts(definition),
          updatedAt: record.updatedAt,
        })
      } catch {
        rows.push({ workflowId, name: record.name, version: record.version, parseError: true, updatedAt: record.updatedAt })
      }
    }
    return { definitions: rows }
  }

  const { record, definition } = loadDefinition(persistence, args.workflowId)
  if (args.stageId !== undefined) {
    const { stage, steps } = mergedStageView(definition, args.stageId)
    return {
      workflowId: args.workflowId,
      stage: { ...stage, steps },
      inLibrary: libraryHint(persistence.microflows, stage.id),
    }
  }
  if (args.stepId !== undefined) {
    const slots = findStepSlots(definition, args.stepId)
    if (slots.length === 0) {
      throw new SandoreError(`step '${args.stepId}' not found in workflow '${args.workflowId}'`, 'NODE_NOT_FOUND')
    }
    return {
      workflowId: args.workflowId,
      stepId: args.stepId,
      occurrences: slots.map(({ stageId, slot }) => ({ stageId, step: mergedStepView(definition, slot) })),
      inLibrary: libraryHint(persistence.steps, args.stepId),
    }
  }
  return {
    workflowId: args.workflowId,
    name: record.name,
    version: record.version,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...definitionCounts(definition),
    updatedAt: record.updatedAt,
    stages: definition.stages.map(stage => ({
      id: stage.id,
      name: stage.name,
      ...(stage.branches === undefined ? {} : { branches: stage.branches }),
      steps: stage.steps.map(slot => mergedStepView(definition, slot)),
    })),
    stepDefinitions: definition.steps ?? [],
    libraryHints: {
      stages: definition.stages.map(stage => ({ id: stage.id, ...libraryHint(persistence.microflows, stage.id) })),
      steps: (definition.steps ?? []).map(step => ({ id: step.id, ...libraryHint(persistence.steps, step.id) })),
    },
  }
}

// ── update-def ────────────────────────────────────────────────────────────────

/** update-def 允许浅合并的 workflow 顶层元数据字段（结构性字段 stages/steps 除外）。 */
const WORKFLOW_META_KEYS = new Set(['name', 'version', 'description', 'engine', 'skills', 'mcps', 'agents', 'settings', 'rules', 'gates'])

/** 浅合并 fields 到目标对象（仅拷贝 fields 中显式提供的键；返回新对象）。 */
function shallowMerge(target: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(fields)) {
    merged[key] = value
  }
  return merged
}

/**
 * 落盘与元数据同步（对齐 remote.updateYaml：serialize → parse 往返校验 → put →
 * writeDefinitionToLibraries；校验失败抛错且记录保持旧值）。
 */
async function persistDefinitionUpdate(persistence: SandoreManagerPersistenceSeam, workflowId: string, definition: WorkflowDefinition): Promise<void> {
  const existing = requireDefinitionRecord(persistence, workflowId)
  const yaml = serializeWorkflowYaml(definition)
  const reparsed = parseWorkflowYaml(yaml) // 往返校验（YAML_PARSE/DEFINITION_INVALID 在写前抛出）
  const now = new Date().toISOString()
  await persistence.definitions.put(workflowId, {
    yaml,
    name: reparsed.name,
    version: reparsed.version,
    ...(reparsed.description === undefined ? {} : { description: reparsed.description }),
    createdAt: existing.createdAt,
    updatedAt: now,
  })
  await persistence.writeDefinitionToLibraries(reparsed)
}

/** 计算保存后警告：被引用的流控位缺顶层定义 / step 定义缺 command（能保存但运行到才报错）。 */
function definitionWarnings(definition: WorkflowDefinition): string[] {
  const warnings: string[] = []
  const defined = new Set((definition.steps ?? []).map(step => step.id))
  const missing = new Set<string>()
  for (const stage of definition.stages) {
    for (const slot of stage.steps) {
      if (!defined.has(slot.id)) missing.add(slot.id)
    }
  }
  if (missing.size > 0) {
    warnings.push(`以下 Step 只在 Stage 流控位出现、缺少顶层完整定义（运行到时会失败）：${[...missing].sort().join(', ')}`)
  }
  const noCommand = (definition.steps ?? []).filter(step => step.command === undefined).map(step => step.id)
  if (noCommand.length > 0) {
    warnings.push(`以下 Step 定义没有 command（执行到时会失败）：${noCommand.sort().join(', ')}`)
  }
  return warnings
}

async function doUpdateDef(host: SandoreManagerToolHost, args: ManagerToolArgs): Promise<SandoreManagerToolResult> {
  const persistence = requirePersistence(host)
  const workflowId = args.workflowId!
  const { definition } = loadDefinition(persistence, workflowId)
  const fields = args.fields ?? {}
  const warnings: string[] = []

  if (args.stepId !== undefined) {
    // Q4：step 级必传 stageId（assertArgsRules 已校验），定位 stage + 流控位。
    const stageId = args.stageId!
    const stage = definition.stages.find(candidate => candidate.id === stageId)
    if (stage === undefined) {
      throw new SandoreError(`stage '${stageId}' not found in workflow '${workflowId}'`, 'NODE_NOT_FOUND')
    }
    const slotIndex = stage.steps.findIndex(slot => slot.id === args.stepId)
    if (slotIndex < 0) {
      const candidates = findStepSlots(definition, args.stepId).map(slot => slot.stageId)
      throw new SandoreError(
        candidates.length === 0
          ? `step '${args.stepId}' not found in workflow '${workflowId}'`
          : `stage '${stageId}' has no slot for step '${args.stepId}'（该 step 出现在 stage：${candidates.join(', ')}）`,
        'NODE_NOT_FOUND',
      )
    }
    if (fields.id !== undefined && fields.id !== args.stepId) {
      throw new SandoreError('step id 不可变更（如需换 id 请删除旧 slot 后新增）', 'INVALID_OPERATION')
    }
    // 拆两段写回：纯定义字段 → 顶层 definition.steps[stepId]；branches/inputFrom → 流控位。
    const { branches, inputFrom, ...definitionFields } = fields as Record<string, unknown>
    const existingDef = definition.steps?.find(step => step.id === args.stepId)
    const mergedDef = WorkflowStepSchema.parse(shallowMerge(existingDef ?? { id: args.stepId }, definitionFields))
    const steps = [...(definition.steps ?? []).filter(step => step.id !== args.stepId), mergedDef]
    const next: WorkflowDefinition = {
      ...definition,
      steps,
      stages: definition.stages.map(candidate =>
        candidate.id !== stageId
          ? candidate
          : {
              ...candidate,
              steps: candidate.steps.map((slot, index) =>
                index !== slotIndex
                  ? slot
                  : {
                      ...slot,
                      ...(branches === undefined ? {} : { branches: branches as StageStep['branches'] }),
                      ...(inputFrom === undefined ? {} : { inputFrom: inputFrom as StageStep['inputFrom'] }),
                    },
              ),
            },
      ),
    }
    await persistDefinitionUpdate(persistence, workflowId, next)
    warnings.push(...definitionWarnings(next))
    return { ok: true, action: 'update-def', data: { workflowId, updated: 'step', stageId, stepId: args.stepId }, ...(warnings.length === 0 ? {} : { warnings }) }
  }

  if (args.stageId !== undefined) {
    const stageId = args.stageId
    const stageIndex = definition.stages.findIndex(candidate => candidate.id === stageId)
    if (stageIndex < 0) {
      throw new SandoreError(`stage '${stageId}' not found in workflow '${workflowId}'`, 'NODE_NOT_FOUND')
    }
    if (fields.id !== undefined && fields.id !== stageId) {
      throw new SandoreError('stage id 不可变更（stage id 是流控引用键）', 'INVALID_OPERATION')
    }
    const mergedStage = WorkflowStageSchema.parse(shallowMerge(definition.stages[stageIndex] as unknown as Record<string, unknown>, fields))
    const next: WorkflowDefinition = {
      ...definition,
      stages: definition.stages.map((candidate, index) => (index === stageIndex ? mergedStage : candidate)),
    }
    await persistDefinitionUpdate(persistence, workflowId, next)
    warnings.push(...definitionWarnings(next))
    return { ok: true, action: 'update-def', data: { workflowId, updated: 'stage', stageId }, ...(warnings.length === 0 ? {} : { warnings }) }
  }

  // workflow 元数据浅合并（结构性字段忽略并提示）。
  const ignored = Object.keys(fields).filter(key => !WORKFLOW_META_KEYS.has(key))
  const next: WorkflowDefinition = { ...definition, ...(Object.fromEntries(Object.entries(fields).filter(([key]) => WORKFLOW_META_KEYS.has(key))) as Partial<WorkflowDefinition>) }
  await persistDefinitionUpdate(persistence, workflowId, next)
  if (ignored.length > 0) {
    warnings.push(`字段 ${ignored.join(', ')} 属于结构字段，未随元数据更新修改（stage/step 结构请带 stageId/stepId 定位修改）`)
  }
  return { ok: true, action: 'update-def', data: { workflowId, updated: 'workflow' }, ...(warnings.length === 0 ? {} : { warnings }) }
}

// ── run ───────────────────────────────────────────────────────────────────────

async function doRun(host: SandoreManagerToolHost, args: ManagerToolArgs, exec: SandoreManagerToolExec): Promise<DagRun> {
  const session = exec.agent?.session
  const callerSessionId = session?.id
  const cwd = args.cwd ?? session?.header?.cwd
  if (cwd === undefined || cwd === '') {
    throw new SandoreError('run 需要 cwd（显式传入，或从带 header.cwd 的顶层会话调用）', 'INVALID_OPERATION')
  }
  const model: StartModelSelection | undefined = args.model === undefined
    ? undefined
    : {
        provider: args.model.provider,
        model: args.model.model,
        ...(args.model.reasoningEffort === undefined ? {} : { reasoningEffort: args.model.reasoningEffort }),
      }
  const request: DagStartRequest = {
    workflowId: args.workflowId!,
    originalInput: args.originalInput!,
    cwd,
    ...(model === undefined ? {} : { model }),
    ...(args.permission === undefined ? {} : { permission: args.permission }),
    ...(args.attachSession !== false && callerSessionId !== undefined ? { hostSessionId: callerSessionId } : {}),
  }
  return await host.startInstance(request)
}

// ── get-state ─────────────────────────────────────────────────────────────────

/** 截断文本到上限（附截断标记）。 */
function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false }
}

/** ContentBlock[] 的文本预览（拼接 text 块后截断）。 */
function outputPreview(output: ExecutedStepRow['output'], maxChars: number): { text: string; truncated: boolean } | undefined {
  if (output === undefined) return undefined
  const text = output
    .map((block: unknown) => (block !== null && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter((part: string) => part !== '')
    .join('\n')
  return truncateText(text, maxChars)
}

/** executedSteps 摘要行。 */
function stepSummaryRow(step: ExecutedStepRow): Record<string, unknown> {
  return {
    stageId: step.stageId,
    stepId: step.stepId ?? step.id,
    name: step.name,
    status: step.status,
    ...(step.attemptIndex === undefined ? {} : { attemptIndex: step.attemptIndex }),
    ...(step.loopIteration === undefined ? {} : { loopIteration: step.loopIteration }),
    ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    ...(step.updatedAt === undefined ? {} : { updatedAt: step.updatedAt }),
    ...(step.error === undefined ? {} : { error: step.error }),
    ...(step.sessionMeta === undefined ? {} : { childSessionId: step.sessionMeta.childId }),
    ...(step.finalizeMeta?.currentPhase === undefined ? {} : { phase: step.finalizeMeta.currentPhase }),
  }
}

/** 执行段比较（createdAt + attemptIndex 键序，取最新段用）。 */
function segmentNewerThan(candidate: ExecutedStepRow, baseline: ExecutedStepRow | undefined): boolean {
  if (baseline === undefined) return true
  const candidateKey = `${candidate.createdAt ?? ''}#${candidate.attemptIndex ?? 0}`
  const baselineKey = `${baseline.createdAt ?? ''}#${baseline.attemptIndex ?? 0}`
  return candidateKey >= baselineKey
}

async function doGetState(host: SandoreManagerToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host)
  if (args.instanceId === undefined) {
    const rows: Array<Record<string, unknown>> = []
    for (const [instanceId, state] of persistence.state.entries()) {
      if (args.workflowId !== undefined && state.workflowId !== args.workflowId) continue
      if (args.status !== undefined && state.status !== args.status) continue
      rows.push({
        instanceId,
        workflowId: state.workflowId,
        originalInput: state.originalInput,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      })
    }
    return { instances: rows }
  }

  const instanceId = args.instanceId
  // 内存优先（收尾中间态立即可见）→ 持久化兜底（对齐 remote.getInstanceState RPC 语义）。
  const state = host.getInstanceState(instanceId) ?? persistence.state.get(instanceId)
  if (state === undefined) {
    throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND')
  }
  const includeDetail = args.includeDetail === true

  if (args.stepId !== undefined) {
    const stepId = args.stepId
    let segments = state.executedSteps.filter(step => (step.stepId ?? step.id) === stepId)
    if (args.stageId !== undefined) segments = segments.filter(step => step.stageId === args.stageId)
    if (segments.length === 0) {
      throw new SandoreError(`step '${stepId}' has no executed segments in instance '${instanceId}'`, 'NODE_NOT_FOUND')
    }
    let latest: ExecutedStepRow | undefined
    for (const segment of segments) {
      if (segmentNewerThan(segment, latest)) latest = segment
    }
    if (args.attemptIndex !== undefined) {
      const picked = segments.find(segment => (segment.attemptIndex ?? 0) === args.attemptIndex)
      if (picked === undefined) {
        throw new SandoreError(`step '${stepId}' has no segment with attemptIndex ${args.attemptIndex} in instance '${instanceId}'`, 'NODE_NOT_FOUND')
      }
      latest = picked
    }
    const step = latest!
    const preview = outputPreview(step.output, OUTPUT_PREVIEW_CHARS)
    return {
      instanceId,
      workflowId: state.workflowId,
      stepId,
      segmentCount: segments.length,
      segments: segments.map(row => stepSummaryRow(row)),
      latest: {
        ...stepSummaryRow(step),
        ...(includeDetail && step.output !== undefined
          ? { output: step.output }
          : preview === undefined ? {} : { outputPreview: preview }),
        ...(step.artifacts === undefined ? {} : { artifacts: step.artifacts }),
        ...(step.sessionMessages === undefined ? {}
          : includeDetail
            ? { sessionMessages: step.sessionMessages.slice(-SESSION_MESSAGES_TAIL) }
            : { sessionMessagesCount: step.sessionMessages.length }),
        ...(step.finalizeMeta === undefined ? {} : { finalizeMeta: step.finalizeMeta }),
        ...(step.sessionMeta === undefined ? {} : { sessionMeta: step.sessionMeta }),
        ...(step.parentSessionId === undefined ? {} : { parentSessionId: step.parentSessionId }),
        ...(step.branchMeta === undefined ? {} : { branchMeta: step.branchMeta }),
        ...(step.loopMeta === undefined ? {} : { loopMeta: step.loopMeta }),
        ...(step.retryHistory === undefined ? {} : { retryHistory: step.retryHistory }),
        ...(step.pausedAt === undefined ? {} : { pausedAt: step.pausedAt }),
      },
    }
  }

  if (args.stageId !== undefined) {
    const stageId = args.stageId
    const stageInfo = state.stageInfos.find(info => info.id === stageId)
    if (stageInfo === undefined) {
      throw new SandoreError(`stage '${stageId}' not found in instance '${instanceId}'`, 'NODE_NOT_FOUND')
    }
    const contract = state.stageContracts[stageId]
    return {
      instanceId,
      workflowId: state.workflowId,
      stage: stageInfo,
      ...(contract === undefined ? {} : { contract }),
      executedSteps: state.executedSteps.filter(step => step.stageId === stageId).map(row => stepSummaryRow(row)),
    }
  }

  return {
    instanceId,
    workflowId: state.workflowId,
    ...(state.workflowName === undefined ? {} : { workflowName: state.workflowName }),
    status: state.status,
    originalInput: state.originalInput,
    currentStageId: state.currentStageId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    stageInfos: state.stageInfos,
    executedSteps: state.executedSteps.map(row => stepSummaryRow(row)),
    pendingQueue: state.pendingQueue,
    pendingInteractions: state.pendingInteractions
      .filter(entry => entry.status === 'pending')
      .map(entry => ({ id: entry.id, kind: entry.kind, stageId: entry.stageId, stepId: entry.stepId, requestId: entry.requestId })),
    ...(state.userMessages === undefined ? {} : { userMessages: state.userMessages.slice(-SESSION_MESSAGES_TAIL) }),
  }
}

// ── lib-list / lib-get ────────────────────────────────────────────────────────

async function doListLibraries(host: SandoreManagerToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host)
  const refs = collectLibraryReferences(persistence.definitions)
  const kinds: Array<'workflow' | 'step' | 'microflow'> =
    args.lib === undefined ? ['workflow', 'step', 'microflow'] : [args.lib]
  const result: Array<Record<string, unknown>> = []
  for (const kind of kinds) {
    if (kind === 'workflow') {
      const entries: Array<Record<string, unknown>> = []
      for (const [workflowId, record] of persistence.definitions.entries()) {
        try {
          const definition = parseWorkflowYaml(record.yaml)
          entries.push({
            id: workflowId,
            name: record.name,
            version: record.version,
            ...(record.description === undefined ? {} : { description: record.description }),
            ...definitionCounts(definition),
            updatedAt: record.updatedAt,
          })
        } catch {
          entries.push({ id: workflowId, name: record.name, version: record.version, parseError: true, updatedAt: record.updatedAt })
        }
      }
      result.push({ kind, entries })
      continue
    }
    const table = kind === 'step' ? persistence.steps : persistence.microflows
    const refsMap = kind === 'step' ? refs.stepRefs : refs.microflowRefs
    const entries = []
    for (const [id, record] of table.entries()) {
      entries.push(toLibrarySummary(id, record, refsMap))
    }
    result.push({ kind, entries })
  }
  return { libraries: result }
}

async function doGetLibraryEntry(host: SandoreManagerToolHost, args: ManagerToolArgs): Promise<unknown> {
  const persistence = requirePersistence(host)
  const kind = args.lib as 'step' | 'microflow'
  const entryId = args.entryId!
  const table = kind === 'step' ? persistence.steps : persistence.microflows
  const record = table.get(entryId)
  if (record === undefined) {
    const uiName = kind === 'step' ? 'Agent 库' : 'Microflow 库'
    throw new SandoreError(`${kind} 库条目 '${entryId}' not found（${uiName}）`, 'NODE_NOT_FOUND')
  }
  const refs = collectLibraryReferences(persistence.definitions)
  const refsMap = kind === 'step' ? refs.stepRefs : refs.microflowRefs
  const owners = [...(refsMap.get(entryId) ?? new Set<string>())].sort()
  return {
    kind,
    entry: record,
    referencedBy: owners.map(workflowId => ({
      workflowId,
      name: persistence.definitions.get(workflowId)?.name ?? '',
    })),
  }
}

// ── 注册（对齐 registerGlobalAskTool 的降级哲学） ─────────────────────────────

/**
 * 在引擎 ctx（全局层）注册 `sandore_workflow` 工具。
 *
 * `tools` 服务缺失（最小桩部署/测试 ctx）时静默跳过（返回空 disposer）。工具可见于
 * 全部会话；execute 期 gate 拒绝非顶层调用方（Q7）。
 * @param ctx - 引擎上下文（`ctx.get('tools')` 取全局工具注册表）。
 * @param host - 工具宿主 seam（engine 公开方法 + persistence 访问器）。
 * @returns 注册的 disposer（随插件生命周期撤销；tools 缺失时为空 disposer）。
 */
export function registerGlobalManagerTool(ctx: Context, host: SandoreManagerToolHost): () => void {
  const tools = (ctx as { get(name: string): unknown }).get('tools') as
    | { register(tool: unknown): () => void }
    | undefined
  if (tools === undefined) {
    // 无全局工具注册表（最小桩部署）：跳过注册，不阻塞引擎启动。
    return () => {}
  }
  return tools.register({
    name: WORKFLOW_MANAGER_TOOL_NAME,
    description: WORKFLOW_MANAGER_TOOL_DESCRIPTION,
    parameters: WORKFLOW_MANAGER_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          // 成功载荷恒为 object 根（envelope data 全为对象；错误时缺省）。
          // 注：注册表 assertSupportedJsonSchema 只支持基础类型子集（不支持 'json'），
          // 故此处收紧为 object。
          data: { type: 'object' },
          reason: { type: 'string' },
          error: { type: 'object' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const text = JSON.stringify(value, null, 2) ?? ''
        return [{ type: 'text', text: truncateText(text, RENDER_MAX_CHARS).text + (text.length > RENDER_MAX_CHARS ? '\n… [truncated]' : '') }]
      },
    },
    execute: (args: unknown, exec: unknown) => executeManagerTool(host, args, exec as SandoreManagerToolExec),
  })
}
