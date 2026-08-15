/**
 * 工作流引擎的基础词汇（browser-safe 持久化类型）。
 *
 * 本文件仅包含 `type`/`interface` 声明，无运行时依赖。深层依赖类型
 * （`CommandConfig`/`InputFromItem` 等）从 `schema.ts` 收紧为真实结构
 * （接口名与 13 个基础类型不变）。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type {
  BranchMeta,
  CommandConfig,
  FinalizeMeta,
  InputFromItem,
  OutputToItem,
  PassThroughVar,
  RetryRecord,
  SessionMessage,
  StepSessionMeta,
} from './schema.ts'

export type {
  BranchMeta,
  CommandConfig,
  FinalizeMeta,
  InputFromItem,
  OutputToItem,
  PassThroughVar,
  RetryRecord,
  SessionMessage,
  StepSessionMeta,
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

/** 等待用户回复的问答请求。 */
export interface PendingQuestion {
  stepId: string
  sessionId: string
  requestId: string
  questions: AskUserQuestionPayload
}

/** 向用户提问的载荷。 */
export interface AskUserQuestionPayload {
  questions: Array<{
    id: string
    question: string
    header?: string
    options?: Array<{
      label: string
      description?: string
    }>
    multi_select?: boolean
  }>
}

/** 等待用户决定的权限请求。 */
export interface PendingPermission {
  stepId: string
  sessionId: string
  requestId: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  tool?: string
}

/** 工作流实例结束时的最终结果信息。 */
export interface DagResultInfo {
  taskId: string
  jobId: string
  status: 'completed' | 'failed' | 'aborted'
  error?: string
}
