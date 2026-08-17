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
  JobEntry,
  InstanceSummary,
  ArtifactEntry,
  PingResponse,
  CreateDefinitionInput,
  UpdateDefinitionInput,
  CreateJobInput,
  UpdateJobInput,
  StartInstanceInput,
  ReplyQuestionInput,
  ReplyPermissionInput,
  PauseStepInput,
  ResumeStepInput,
  PauseAllInput,
  ResumeAllInput,
  RetryStepInput,
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
  /** Job ID。 */
  jobId: string
}

/** 启动一个工作流实例的请求。 */
export interface DagStartRequest {
  /** 工作流定义 ID。 */
  workflowId: string
  /** Job ID。 */
  jobId: string
  /** 用户原始需求。 */
  originalInput: string
  /** 可选工作目录。 */
  cwd?: string
}

/** 工作流实例的运行句柄。 */
export interface DagRun {
  instanceId: string
  status: DagRunStatus
}

/** 工作流实例的生命周期状态。 */
export type DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'

/** 工作流实例的持久化状态快照。 */
export interface DagInstanceState {
  taskId: string
  jobId: string
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
  type: 'default'
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
  branchMeta?: BranchMeta
  error?: string
  pausedAt?: string
  resumedAt?: string
  resumePrompt?: string
  sessionMessages?: SessionMessage[]
  pauseEntryId?: string
  loopIteration?: number[]
  loopMeta?: BranchMeta
  retryHistory?: RetryRecord[]
  parentSessionId?: string
  output?: ContentBlock[]
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
  | { type: 'done'; completionType: 'completed'; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
  | { type: 'ask'; assessResult: FinalizeAssessResult }
  | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }

/** 工作流实例结束时的最终结果信息。 */
export interface DagResultInfo {
  taskId: string
  jobId: string
  status: 'completed' | 'failed' | 'aborted'
  error?: string
}
