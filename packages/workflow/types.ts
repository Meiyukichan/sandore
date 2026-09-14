/**
 * 工作流引擎的基础词汇（browser-safe 持久化类型）。
 *
 * 本文件仅包含 `type`/`interface` 声明，无运行时依赖。深层依赖类型
 * （`CommandConfig`/`InputFromItem` 等）从 `schema.ts` 收紧为真实结构
 * （接口名与 13 个基础类型不变）。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type {
  AskUserQuestionPayload,
  BranchMeta,
  CommandConfig,
  FinalizeAskResult,
  FinalizeAssessResult,
  FinalizeMeta,
  GateEvalResult,
  InputFromItem,
  OutputToItem,
  PassThroughVar,
  PendingPermissionEntry,
  PendingQuestionEntry,
  RetryRecord,
  SessionMessage,
  StepSessionMeta,
  WorkflowTaskState,
} from './schema.ts'

export type {
  AskUserQuestionPayload,
  BranchMeta,
  CommandConfig,
  FinalizeAskResult,
  FinalizeAssessResult,
  FinalizeMeta,
  GateEvalResult,
  InputFromItem,
  OutputToItem,
  PassThroughVar,
  PendingPermissionEntry,
  PendingQuestionEntry,
  RetryRecord,
  SessionMessage,
  StepSessionMeta,
  WorkflowTaskState,
}

// ── RPC wire 类型（重导出自 remote.ts，供 typert 生成物 .d.ts 引用） ────────────
//
// typert generator 要求 Remote 边界（结果/参数）类型从「公共非 root 类型子路径」
// （即 `./types`）导出；`remote.ts` 的 wire 类型原本仅从根 `.` 子路径导出，故在此
// 以 `export type` 命名重导出，`resolveSymbol` 会解析到 remote.ts 中的同一 symbol。
export type {
  WorkflowDefinitionEntry,
  InstanceSummary,
  ArtifactEntry,
  PingResponse,
  CreateDefinitionInput,
  ImportDefinitionInput,
  ImportDefinitionResult,
  UpdateDefinitionInput,
  StartInstanceInput,
  ReplyQuestionInput,
  ReplyPermissionInput,
  PauseStepInput,
  ResumeStepInput,
  PauseAllInput,
  ResumeAllInput,
  RetryStepInput,
  RevertBoundaryOption,
  ListRevertBoundariesInput,
  RecoverInstanceInput,
  RecoverOrphanedInstancesResult,
  // 三级分离：Step / Microflow 库 RPC wire 类型
  LibraryEntrySummary,
  GetStepInput,
  UpsertStepInput,
  DeleteStepInput,
  GetMicroflowInput,
  UpsertMicroflowInput,
  DeleteMicroflowInput,
  DeleteEntryResult,
} from './wire.ts'

/** 用户问答选项（对齐 DSH `AskUserQuestionOption`）。 */
export interface AskUserQuestionOption {
  /** 选项对外展示标签。 */
  label: string
  /** 可选补充说明。 */
  description?: string
}

/** 单个问题条目（对齐 DSH `AskUserQuestionItem`，`multiSelect` 为驼峰）。 */
export interface AskUserQuestionItem {
  /** 调用方提供的稳定问题 ID，回答中回显。 */
  id: string
  /** 展示给用户的问题。 */
  question: string
  /** 可选短标题/分组标签。 */
  header?: string
  /** 可选选项列表（UI 渲染为菜单）。 */
  options?: AskUserQuestionOption[]
  /** 是否允许多选；缺省单选。 */
  multiSelect?: boolean
}

/** 单个问题的回答（对齐 DSH `AskUserQuestionAnswerItem`）。 */
export interface AskUserQuestionAnswerItem {
  /** 被回答的问题 ID。 */
  id: string
  /** 选中的选项标签。 */
  selected: string[]
  /** 可选自由文本「其他」回答。 */
  custom?: string
}

/** 用户整批回答（对齐 DSH `AskUserQuestionAnswer`）。 */
export interface AskUserQuestionAnswer {
  /** 按问题 ID 组织的结构化回答。 */
  answers: AskUserQuestionAnswerItem[]
}

/** 运行中的工作流实例的身份快照（`taskId` 即实例 ID）。 */
export interface DagRunInfo {
  /** 实例 ID。 */
  taskId: string
  /** 工作流定义 ID。 */
  workflowId: string
}

/** 创建实例时选择的模型（对齐 DSH `ModelSelection`）。 */
export interface StartModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 启动一个工作流实例的请求（去 job 概念：直接绑定工作流定义）。
 *
 * **入口归一（架构决策 1）**：本请求**不再携带宿主会话 id**。恒等式在引擎内部
 * 恒成立——`hostAgent.id ≡ 宿主会话 id ≡ 实例 id（taskId）≡ 调用会话`：
 * - overlay 新建（`startInstance`）：引擎新建真实顶层会话，实例 id 即该会话 id；
 * - 已知会话拉起（`sandore_workflow_run`）：实例 id 即调用方会话 id。
 * 因此任何需要「宿主会话 id」的位置都直接读**显式字段**
 * `WorkflowTaskState.hostSessionId`（旧快照回退 `?? taskId`），不再有「复用 / 新建」两种模式。
 */
export interface DagStartRequest {
  /** 工作流定义 ID。 */
  workflowId: string
  /** 用户原始需求。 */
  originalInput: string
  /**
   * 必填工作目录：hostAgent 据此 attach 到对应的 web workspace（未命中任何已登记
   * workspace 的路径抛 `INVALID_OPERATION`）。
   */
  cwd: string
  /** 创建实例时选择的模型（作为该实例 L2 默认模型路由）。 */
  model?: StartModelSelection
  /** 创建实例时选择的权限预设（read-only / workspace-write / danger-full-access）。 */
  permission?: string
}

/** 工作流实例的生命周期状态。 */
export type DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'

/** 工作流实例的运行句柄（`hostAgent.id ≡ 宿主会话 id ≡ instanceId`，见 {@link DagStartRequest}）。 */
export interface DagRun {
  instanceId: string
  status: DagRunStatus
}

/** 工作流实例的持久化状态快照。 */
export interface DagInstanceState {
  taskId: string
  /**
   * 宿主主代理会话 id（该实例的宿主会话；恒等于 `taskId`）。
   *
   * 显式字段（2026-09 起）：消费面不必再依赖"taskId 即宿主会话"的约定。旧快照
   * 没有该字段时读取回退 `taskId`（`hostSessionId ?? taskId`）。
   */
  hostSessionId: string
  workflowId: string
  status: DagRunStatus
  originalInput: string
  currentStageId: string
  executedSteps: ExecutedStepDefault[]
  stageInfos: StageInfo[]
  pendingQueue: string[]
  createdAt: string
  updatedAt: string
}

/** 已执行 Step 的默认实现快照。 */
export interface ExecutedStepDefault {
  id: string
  stepId?: string
  stageId: string
  name: string
  status: StepStatus
  command?: CommandConfig
  inputFrom?: InputFromItem[]
  outputTo?: OutputToItem[]
  passThroughVars?: PassThroughVar[]
  sessionMeta?: StepSessionMeta
  finalizeMeta?: FinalizeMeta
  visitCount: number
  /** 本执行段开始时间（ISO；统一时间轴排序键，与 schema 同步）。 */
  createdAt?: string
  /** 执行段序号（同 stepId 第几次执行段；0-based，缺省 0 = 首次执行）。 */
  attemptIndex?: number
  /** Step 开始执行的时间（ISO；引擎写入，供 UI 展示相对时间）。 */
  startedAt?: string
  /** Step 最近一次状态变更的时间（ISO；running 后每次转态更新，供 UI 展示相对时间）。 */
  updatedAt?: string
  branchMeta?: BranchMeta
  error?: string
  pausedAt?: string
  // 注意：**没有 `sessionMessages`**——该字段曾是 state 最大冗余（占 41%–54%），
  // 现改为 `getInstanceState` RPC 读取时从 step 子代理会话按需回填
  // （`SandoreEngine.hydrateStateMessages`）。这里保留声明仅为类型面兼容历史调用方。
  /** **仅内存/读取期**：由 `hydrateStateMessages` 从子代理会话现算，不持久化。 */
  sessionMessages?: SessionMessage[]
  pauseEntryId?: string
  loopIteration?: number[]
  loopMeta?: BranchMeta
  retryHistory?: RetryRecord[]
  parentSessionId?: string
  output?: ContentBlock[]
  /** Round 26：本执行段实际产物文件（进程绝对路径；step 完成收尾时收集写入，与 schema 同步）。 */
  artifacts?: string[]
}

/** 工作流 DAG 中单个 Stage 的状态快照。 */
export interface StageInfo {
  id: string
  name: string
  status: StepStatus
}

/** 单个 Step 或 Stage 的执行状态。 */
export type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'

/** Stage 完成时对外暴露的产物契约。 */
export interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus
  artifacts: Array<{
    stepId: string
    outputToId: string
    files: string[]
    returnPrompt?: string
  }>
  passThroughVars: Record<string, {
    value: string
    description: string
    refresh?: boolean
  }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}

/** pending 交互条目状态。 */
export type PendingInteractionStatus = 'pending' | 'replied' | 'rejected'

/** 收尾最终结果（done/ask/error 三态联合）。 */
export type FinalizeOutcome =
  | { type: 'done'; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
  | { type: 'ask'; assessResult: FinalizeAskResult }
  | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }

/** 工作流实例结束时的最终结果信息。 */
export interface DagResultInfo {
  taskId: string
  status: 'completed' | 'failed' | 'aborted'
  error?: string
}
