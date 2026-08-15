/**
 * sandore 工作流引擎的 capability seam。
 *
 * 定义 `ctx.sandoreEngine` 抽象接口（`SandoreEngine extends Service`）、
 * 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）
 * 与空 Provider 桩（`SandoreEngineStub`）。Task 1 不做真实引擎执行逻辑。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'

import type {
  DagResultInfo,
  DagRun,
  DagRunInfo,
  DagStartRequest,
  DagInstanceState,
  PendingPermission,
  PendingQuestion,
  StageContract,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandoreEngine: SandoreEngine
  }

  interface Events {
    'sandore/start'(info: DagRunInfo): void
    'sandore/stage-start'(info: DagRunInfo, stageId: string): void
    'sandore/stage-completed'(info: DagRunInfo, stageId: string, contract: StageContract): void
    'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string): void
    'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void
    'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, error: string): void
    'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string): void
    'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, resumePrompt?: string): void
    'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string): void
    'sandore/question'(info: DagRunInfo, question: PendingQuestion): void
    'sandore/permission'(info: DagRunInfo, permission: PendingPermission): void
    'sandore/end'(info: DagRunInfo, result: DagResultInfo): void
    'sandore/aborted'(info: DagRunInfo): void
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'sandore/start': { taskId: string; workflowId: string; jobId: string }
    'sandore/stage-start': { taskId: string; stageId: string }
    'sandore/stage-completed': { taskId: string; stageId: string; stageContract: StageContract }
    'sandore/step-start': { stepId: string; childId: string }
    'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[] }
    'sandore/step-failed': { stepId: string; childId: string; error: string }
    'sandore/step-paused': { stepId: string; childId: string }
    'sandore/step-resumed': { stepId: string; childId: string; resumePrompt?: string }
    'sandore/step-retried': { stepId: string; mode: string }
    'sandore/question': { question: PendingQuestion }
    'sandore/permission': { permission: PendingPermission }
    'sandore/end': { taskId: string; jobId: string; result: DagResultInfo }
    'sandore/aborted': { taskId: string }
  }
}

/**
 * 工作流引擎的 Service Definition。
 *
 * Service 层只暴露实例级操作（start/recover/abort/reply/pause/resume/retry/getState），
 * 定义/Job 的 CRUD 与实例讨论/产物查询放在 Host RPC 层（见 `remote.ts`）。
 */
export abstract class SandoreEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sandoreEngine')
  }

  /** 启动一个新的工作流实例。 */
  abstract startInstance(request: DagStartRequest): DagRun
  /** 恢复一个已存在的工作流实例。 */
  abstract recoverInstance(instanceId: string): Promise<DagRun>
  /** 中止一个运行中的工作流实例。 */
  abstract abortInstance(instanceId: string): Promise<void>

  /** 回复一个待处理问答请求。 */
  abstract replyQuestion(instanceId: string, requestId: string, answers: unknown): Promise<void>
  /** 回复一个待处理权限请求。 */
  abstract replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>

  /** 暂停单个 Step。 */
  abstract pauseStep(instanceId: string, stepId: string): Promise<void>
  /** 恢复单个 Step（可选附带恢复提示词）。 */
  abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>
  /** 暂停实例内所有 Step。 */
  abstract pauseAllSteps(instanceId: string): Promise<void>
  /** 恢复实例内所有 Step（可选附带恢复提示词）。 */
  abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>
  /** 重试单个 Step。 */
  abstract retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>

  /** 查询实例的当前状态快照。 */
  abstract getState(instanceId: string): DagInstanceState
}

/** Provider 桩的配置。 */
export interface SandoreConfig {
  /** 单个 Step 的默认超时（毫秒）。 */
  defaultTimeoutMs?: number
  /** 最大并发 Step 数（0 表示不限制）。 */
  maxConcurrentSteps?: number
}

/**
 * 空 Provider 桩。
 *
 * 作为插件默认导出，仅声明依赖注入与配置 schema；11 个方法抛 `not implemented`，
 * 真实执行逻辑在 Task 2/3 填充。
 */
export default class SandoreEngineStub extends SandoreEngine {
  static Config: z<SandoreConfig> = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    maxConcurrentSteps: z.natural().default(0),
  })

  static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']

  startInstance(request: DagStartRequest): DagRun {
    throw new Error('SandoreEngineStub.startInstance is not implemented')
  }

  recoverInstance(instanceId: string): Promise<DagRun> {
    throw new Error('SandoreEngineStub.recoverInstance is not implemented')
  }

  abortInstance(instanceId: string): Promise<void> {
    throw new Error('SandoreEngineStub.abortInstance is not implemented')
  }

  replyQuestion(instanceId: string, requestId: string, answers: unknown): Promise<void> {
    throw new Error('SandoreEngineStub.replyQuestion is not implemented')
  }

  replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    throw new Error('SandoreEngineStub.replyPermission is not implemented')
  }

  pauseStep(instanceId: string, stepId: string): Promise<void> {
    throw new Error('SandoreEngineStub.pauseStep is not implemented')
  }

  resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void> {
    throw new Error('SandoreEngineStub.resumeStep is not implemented')
  }

  pauseAllSteps(instanceId: string): Promise<void> {
    throw new Error('SandoreEngineStub.pauseAllSteps is not implemented')
  }

  resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void> {
    throw new Error('SandoreEngineStub.resumeAllSteps is not implemented')
  }

  retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void> {
    throw new Error('SandoreEngineStub.retryStep is not implemented')
  }

  getState(instanceId: string): DagInstanceState {
    throw new Error('SandoreEngineStub.getState is not implemented')
  }
}
