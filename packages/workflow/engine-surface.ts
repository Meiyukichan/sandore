/**
 * sandore 工作流引擎的实例级生命周期结构面（纯 type-only，无运行时依赖）。
 *
 * 仅声明 `SandoreEngine` 抽象类暴露给宿主/工具的实例级操作签名，作为 seam 抽象类与
 * tool 包结构面之间的「单一事实来源」，避免两份独立声明静默漂移。本文件不含任何
 * `declare module` 模块增强与运行时代码，可被 tool 包以 `import type` 安全引用。
 * @module @meiyukichan/dsh-sandore/workflow/src/engine-surface
 */
import type { AskUserQuestionAnswer, DagInstanceState, DagRun, DagStartRequest } from './types.ts';
import type { WorkflowTaskState } from './schema.ts';
import type { RecoverOrphanedInstancesResult, RevertBoundaryOption } from './wire.ts';

/** 工作流引擎实例级操作结构面（seam `SandoreEngine` 与 tool 包共享）。 */
export interface SandoreEngineSurface {
  /**
   * 启动实例（入口归一第一阶段）：新建真实顶层会话 → 绑定实例（id ≡ 会话 id）→
   * 注入协作上下文 → 返回 `{instanceId, status:'pending'}`；**不执行**工作流。
   */
  startInstance(request: DagStartRequest): Promise<DagRun>;
  /**
   * 启动实例（入口归一第二阶段 / **唯一启动入口**）：在调用方会话内拉起工作流
   * （pending 实例直接开跑，或新建绑定调用会话），返回 `{instanceId, status:'running'}`。
   *
   * `hostSessionId` 是**调用会话 id**（`sandore_workflow_run` 的调用方），不是请求字段：
   * 恒等式 `hostAgent.id ≡ 宿主会话 id ≡ instanceId ≡ 调用会话`。
   */
  runInstanceInSession(hostSessionId: string, request: DagStartRequest): Promise<DagRun>;
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
  /**
   * 重试单个 Step。
   *
   * @deprecated `mode:'revert'` 与 `revertBoundary` 按架构决策 3（回滚会话/回退点功能
   * 去掉）**不再对外提供**：新工具面 `sandore_workflow_control` 只用 `'continue'`
   * （paused 续跑现有子代理）与 `'fork'`（failed 重建子代理）两种机制，引擎按 Step
   * 状态自动选择。保留 revert 仅为兼容既有 client 呈现层（不在本次改造范围内）。
   */
  retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string, revertBoundary?: number): Promise<void>;
  /**
   * 列出某 Step 子代理会话中可用的闭合 turn 回退点候选（revert 回退点选择数据源）。
   *
   * @deprecated 见 {@link retryStep}：回退点功能已去掉，仅为兼容既有 client 保留。
   */
  listRevertBoundaries(instanceId: string, stepId: string): RevertBoundaryOption[];
  /**
   * 向运行中实例的指定 Step 子代理追加一条用户消息。
   *
   * 复用引擎的 queue 投递通道（向子代理会话追加消息并驱动它继续）：
   * requireActive + 终态守卫 → 按 stepId 反查最后活跃段并校验状态门槛
   * （仅 running/interacting；synthetic 段抛 INVALID_OPERATION——shell 合成 session
   * 无真实子代理可发消息）→ 投递 → 单发 `sandore/step-message`。
   *
   * **不写 `state.userMessages`**（用户要求：讨论页只展示 step agent 消息与主代理消息）：
   * 这条消息本身就在子代理会话里（= 该 step 面板的「step agent 消息」），投递凭据是
   * `sandore_workflow_send_message` 返回的 `data.delivered` 与 `sandore/step-message` 事件。
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
  /**
   * 读运行中实例的内存 state（收尾阶段中间态立即可见；终态清表或未在内存返回 undefined）。
   *
   * 用于 `getInstanceState` RPC 的内存优先路径：引擎 `active.state` 引用在 commitFinalize
   * 写入 currentPhase 时同步更新，事件发出时已可从内存读到中间态。
   */
  getInstanceState(instanceId: string): WorkflowTaskState | undefined;
  /** 查询实例的当前状态快照。 */
  getState(instanceId: string): DagInstanceState;
}
