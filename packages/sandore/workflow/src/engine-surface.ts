/**
 * sandore 工作流引擎的实例级生命周期结构面（纯 type-only，无运行时依赖）。
 *
 * 仅声明 `SandoreEngine` 抽象类暴露给宿主/工具的实例级操作签名，作为 seam 抽象类与
 * tool 包结构面之间的「单一事实来源」，避免两份独立声明静默漂移。本文件不含任何
 * `declare module` 模块增强与运行时代码，可被 tool 包以 `import type` 安全引用。
 * @module @deepseek-ai/dsh-sandore-workflow/src/engine-surface
 */
import type { AskUserQuestionAnswer, DagInstanceState, DagRun, DagStartRequest } from './types.ts';
import type { RecoverOrphanedInstancesResult, RevertBoundaryOption } from './wire.ts';

/** 工作流引擎实例级操作结构面（seam `SandoreEngine` 与 tool 包共享）。 */
export interface SandoreEngineSurface {
  /** 启动一个新的工作流实例。 */
  startInstance(request: DagStartRequest): Promise<DagRun>;
  /** 恢复一个已存在的工作流实例。 */
  recoverInstance(instanceId: string): Promise<DagRun>;
  /** 批量恢复孤儿实例（进程重启后内存未命中但快照非终态），返回 { recovered, errors }。 */
  recoverOrphanedInstances(): Promise<RecoverOrphanedInstancesResult>;
  /** 中止一个运行中的工作流实例。 */
  abortInstance(instanceId: string): Promise<void>;
  /** 回复一个待处理问答请求。 */
  replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void>;
  /** 拒绝一个待处理问答请求（标对应 Step failed，缺陷 26）。 */
  rejectQuestion(instanceId: string, requestId: string): Promise<void>;
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
  /** 重试单个 Step（revert 模式可选 `revertBoundary` 指定更早闭合 turn/end）。 */
  retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string, revertBoundary?: number): Promise<void>;
  /** 列出某 Step 子代理会话中可用的闭合 turn 回退点候选（revert 回退点选择数据源）。 */
  listRevertBoundaries(instanceId: string, stepId: string): RevertBoundaryOption[];
  /**
   * 向运行中实例的指定 Step 子代理追加一条用户 @mention 消息（缺陷 31）。
   *
   * 复用 DSH 宿主 `ctx.subagents.followup`（向子代理会话追加消息并取回新回复）：
   * requireActive + 终态守卫 → 按 stepId 反查最后活跃段 sessionMeta.childId →
   * synthetic===false 才 followup（synthetic 步骤抛 INVALID_OPERATION——shell
   * 合成 session 无真实子代理可发消息）→ 追加 userMessages `{kind:'message',
   * target:stepId}`（不复用 'input' 以免污染 originalInput 语义）→ persistState →
   * 双发 `sandore/step-message`。@mention 由 UI 端 @Step 选择器产出 stepId，
   * 引擎端不做文本解析。
   */
  sendStepMessage(instanceId: string, stepId: string, message: string): Promise<void>;
  /**
   * 运行中切换实例权限模式（缺陷 29）。
   *
   * 对宿主 session + hostAgent 重新应用 sandbox 模式 + 审批策略（复用
   * `applyPermission`，DSH 折叠读取，下次受限调用即生效）；终态实例拒绝。
   * 仅作用于宿主会话与切换后新委派的 Step；已运行 Step 子代理保持其委派时
   * 的权限快照（架构差异，非缺陷——见子代理快照契约测试）。
   */
  setPermissionMode(instanceId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void>;
  /** 查询实例的当前状态快照。 */
  getState(instanceId: string): DagInstanceState;
}
