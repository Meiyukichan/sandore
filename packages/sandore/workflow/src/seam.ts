/**
 * sandore 工作流引擎的 capability seam。
 *
 * 定义 `ctx.sandoreEngine` 抽象接口（`SandoreEngine extends Service`）、
 * 14 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）
 * 与空 Provider 桩（`SandoreEngineStub`）。真实执行逻辑见 `workflow-engine.ts`。
 * @module @deepseek-ai/dsh-sandore-workflow/src/seam
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  DagResultInfo,
  DagRun,
  DagRunInfo,
  DagStartRequest,
  DagInstanceState,
  PendingPermissionEntry,
  PendingQuestionEntry,
  StageContract,
} from './types.ts';
import type { SandoreEngineSurface } from './engine-surface.ts';
import type { RecoverOrphanedInstancesResult, RevertBoundaryOption } from './wire.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandoreEngine: SandoreEngine;
    userQuestions: UserQuestions;
  }

  interface Events {
    'sandore/start'(info: DagRunInfo): void;
    'sandore/stage-start'(info: DagRunInfo, stageId: string): void;
    'sandore/stage-completed'(info: DagRunInfo, stageId: string, contract: StageContract): void;
    'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void;
    'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[], name: string, loopIteration?: number[]): void;
    'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, error: string, name: string, loopIteration?: number[]): void;
    'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void;
    'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, resumePrompt: string | undefined, name: string, loopIteration?: number[]): void;
    'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string, name: string, loopIteration?: number[]): void;
    'sandore/step-message'(info: DagRunInfo, stepId: string, childId: string, message: string, name: string): void;
    'sandore/question'(info: DagRunInfo, question: PendingQuestionEntry): void;
    'sandore/permission'(info: DagRunInfo, permission: PendingPermissionEntry): void;
    'sandore/question_rejected'(info: DagRunInfo, question: PendingQuestionEntry): void;
    'sandore/end'(info: DagRunInfo, result: DagResultInfo): void;
    'sandore/aborted'(info: DagRunInfo): void;
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'sandore/start': { taskId: string; workflowId: string };
    'sandore/stage-start': { taskId: string; stageId: string };
    'sandore/stage-completed': { taskId: string; stageId: string; stageContract: StageContract };
    'sandore/step-start': { stepId: string; childId: string; name: string; loopIteration?: number[] };
    'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[]; name: string; loopIteration?: number[] };
    'sandore/step-failed': { stepId: string; childId: string; error: string; name: string; loopIteration?: number[] };
    'sandore/step-paused': { stepId: string; childId: string; name: string; loopIteration?: number[] };
    'sandore/step-resumed': { stepId: string; childId: string; resumePrompt?: string; name: string; loopIteration?: number[] };
    'sandore/step-retried': { stepId: string; mode: string; name: string; loopIteration?: number[] };
    'sandore/step-message': { stepId: string; childId: string; message: string; name: string };
    'sandore/question': { question: PendingQuestionEntry };
    'sandore/permission': { permission: PendingPermissionEntry };
    'sandore/question_rejected': { question: PendingQuestionEntry };
    'sandore/end': { taskId: string; result: DagResultInfo };
    'sandore/aborted': { taskId: string };
  }
}

/**
 * 工作流引擎的 Service Definition。
 *
 * Service 层只暴露实例级操作（start/recover/abort/reply/pause/resume/retry/getState），
 * 定义/Job 的 CRUD 与实例讨论/产物查询放在 Host RPC 层（见 `remote.ts`）。
 */
export abstract class SandoreEngine extends Service implements SandoreEngineSurface {
  constructor(ctx: Context) {
    super(ctx, 'sandoreEngine');
  }

  /** 启动一个新的工作流实例。 */
  abstract startInstance(request: DagStartRequest): Promise<DagRun>;
  /** 恢复一个已存在的工作流实例。 */
  abstract recoverInstance(instanceId: string): Promise<DagRun>;
  /** 批量恢复孤儿实例（进程重启后内存未命中但快照非终态），返回 { recovered, errors }。 */
  abstract recoverOrphanedInstances(): Promise<RecoverOrphanedInstancesResult>;
  /** 中止一个运行中的工作流实例。 */
  abstract abortInstance(instanceId: string): Promise<void>;

  /** 回复一个待处理问答请求。 */
  abstract replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void>;
  /** 拒绝一个待处理问答请求（标对应 Step failed，缺陷 26）。 */
  abstract rejectQuestion(instanceId: string, requestId: string): Promise<void>;
  /** 回复一个待处理权限请求。 */
  abstract replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;

  /** 暂停单个 Step。 */
  abstract pauseStep(instanceId: string, stepId: string): Promise<void>;
  /** 恢复单个 Step（可选附带恢复提示词）。 */
  abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;
  /** 暂停实例内所有 Step。 */
  abstract pauseAllSteps(instanceId: string): Promise<void>;
  /** 恢复实例内所有 Step（可选附带恢复提示词）。 */
  abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;
  /** 重试单个 Step（revert 模式可选 `revertBoundary` 指定更早闭合 turn/end）。 */
  abstract retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string, revertBoundary?: number): Promise<void>;
  /** 列出某 Step 子代理会话中可用的闭合 turn 回退点候选（revert 回退点选择数据源）。 */
  abstract listRevertBoundaries(instanceId: string, stepId: string): RevertBoundaryOption[];

  /**
   * 向运行中实例的指定 Step 子代理追加一条用户 @mention 消息（缺陷 31）。
   *
   * 复用 DSH 宿主 `ctx.subagents.followup`（向子代理会话追加消息并取回新回复）：
   * requireActive + 终态守卫 → 按 stepId 反查最后活跃段 sessionMeta.childId →
   * synthetic===false 才 followup（synthetic 步骤抛 INVALID_OPERATION）→ 追加
   * userMessages `{kind:'message', target:stepId}` → persistState → 双发
   * `sandore/step-message`。@mention 由 UI 端 @Step 选择器产出 stepId，引擎端
   * 不做文本解析。
   */
  abstract sendStepMessage(instanceId: string, stepId: string, message: string): Promise<void>;

  /**
   * 运行中切换实例权限模式（缺陷 29）：对宿主 session + hostAgent 重新应用
   * sandbox 模式 + 审批策略，下次受限调用即生效。终态实例拒绝。
   */
  abstract setPermissionMode(instanceId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void>;

  /** 查询实例的当前状态快照。 */
  abstract getState(instanceId: string): DagInstanceState;
}

/** `ctx.userQuestions.ask` 的入参（questions + 可选活代理/取消）。 */
export interface UserQuestionsRequest {
  readonly questions: AskUserQuestionItem[];
  readonly agent?: Agent;
  readonly signal?: AbortSignal;
}

/** `ctx.userQuestions` 能力接缝：以活代理身份发起原生问答卡片。 */
export interface UserQuestions {
  ask(request: UserQuestionsRequest): Promise<AskUserQuestionAnswer>;
}

/** Provider 桩的配置。 */
export interface SandoreConfig {
  /** 单个 Step 的默认超时（毫秒）。 */
  defaultTimeoutMs?: number;
  /** 最大并发 Step 数（0 表示不限制）。 */
  maxConcurrentSteps?: number;
  /** prompt Step 缺省模型回退的默认 provider（成对配置才用）。 */
  defaultProvider?: string;
  /** prompt Step 缺省模型回退的默认 model（成对配置才用）。 */
  defaultModel?: string;
}

/**
 * 空 Provider 桩。
 *
 * 仅声明依赖注入与配置 schema；12 个方法抛 `not implemented`。
 * 真实执行逻辑在 `SandoreEngineRuntime`（`workflow-engine.ts`）。
 */
export class SandoreEngineStub extends SandoreEngine {
  static Config: z<SandoreConfig> = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    // 缺陷 10：maxConcurrentSteps 默认 4（合理并发上限），0=不限。
    maxConcurrentSteps: z.natural().default(4),
    defaultProvider: z.string(),
    defaultModel: z.string(),
  });

  static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions', 'sessionTitle'];

  startInstance(request: DagStartRequest): Promise<DagRun> {
    throw new Error('SandoreEngineStub.startInstance is not implemented');
  }

  recoverInstance(instanceId: string): Promise<DagRun> {
    throw new Error('SandoreEngineStub.recoverInstance is not implemented');
  }

  recoverOrphanedInstances(): Promise<RecoverOrphanedInstancesResult> {
    throw new Error('SandoreEngineStub.recoverOrphanedInstances is not implemented');
  }

  abortInstance(instanceId: string): Promise<void> {
    throw new Error('SandoreEngineStub.abortInstance is not implemented');
  }

  replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void> {
    throw new Error('SandoreEngineStub.replyQuestion is not implemented');
  }

  rejectQuestion(instanceId: string, requestId: string): Promise<void> {
    throw new Error('SandoreEngineStub.rejectQuestion is not implemented');
  }

  replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    throw new Error('SandoreEngineStub.replyPermission is not implemented');
  }

  pauseStep(instanceId: string, stepId: string): Promise<void> {
    throw new Error('SandoreEngineStub.pauseStep is not implemented');
  }

  resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void> {
    throw new Error('SandoreEngineStub.resumeStep is not implemented');
  }

  pauseAllSteps(instanceId: string): Promise<void> {
    throw new Error('SandoreEngineStub.pauseAllSteps is not implemented');
  }

  resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void> {
    throw new Error('SandoreEngineStub.resumeAllSteps is not implemented');
  }

  retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string, _revertBoundary?: number): Promise<void> {
    throw new Error('SandoreEngineStub.retryStep is not implemented');
  }

  listRevertBoundaries(_instanceId: string, _stepId: string): RevertBoundaryOption[] {
    throw new Error('SandoreEngineStub.listRevertBoundaries is not implemented');
  }

  sendStepMessage(_instanceId: string, _stepId: string, _message: string): Promise<void> {
    throw new Error('SandoreEngineStub.sendStepMessage is not implemented');
  }

  setPermissionMode(_instanceId: string, _mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> {
    throw new Error('SandoreEngineStub.setPermissionMode is not implemented');
  }

  getState(instanceId: string): DagInstanceState {
    throw new Error('SandoreEngineStub.getState is not implemented');
  }
}
