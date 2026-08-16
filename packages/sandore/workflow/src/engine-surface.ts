/**
 * sandore 工作流引擎的实例级生命周期结构面（纯 type-only，无运行时依赖）。
 *
 * 仅声明 `SandoreEngine` 抽象类暴露给宿主/工具的实例级操作签名，作为 seam 抽象类与
 * tool 包结构面之间的「单一事实来源」，避免两份独立声明静默漂移。本文件不含任何
 * `declare module` 模块增强与运行时代码，可被 tool 包以 `import type` 安全引用。
 * @module @deepseek-ai/dsh-sandore-workflow/src/engine-surface
 */
import type { AskUserQuestionAnswer, DagInstanceState, DagRun, DagStartRequest } from './types.ts';

/** 工作流引擎实例级操作结构面（seam `SandoreEngine` 与 tool 包共享）。 */
export interface SandoreEngineSurface {
  /** 启动一个新的工作流实例。 */
  startInstance(request: DagStartRequest): Promise<DagRun>;
  /** 恢复一个已存在的工作流实例。 */
  recoverInstance(instanceId: string): Promise<DagRun>;
  /** 中止一个运行中的工作流实例。 */
  abortInstance(instanceId: string): Promise<void>;
  /** 回复一个待处理问答请求。 */
  replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void>;
  /** 回复一个待处理权限请求。 */
  replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;
  /** 暂停单个 Step。 */
  pauseStep(instanceId: string, stepId: string): Promise<void>;
  /** 恢复单个 Step（可选附带恢复提示词）。 */
  resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;
  /** 暂停实例内所有 Step。 */
  pauseAllSteps(instanceId: string): Promise<void>;
  /** 恢复实例内所有 Step（可选附带恢复提示词）。 */
  resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;
  /** 重试单个 Step。 */
  retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>;
  /** 查询实例的当前状态快照。 */
  getState(instanceId: string): DagInstanceState;
}
