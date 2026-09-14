/**
 * sandore 工作流引擎运行时（Stage 级线性主循环）。
 *
 * `SandoreEngineRuntime` 继承 {@link SandoreEngine}：`startInstance` 异步完成
 * 读定义 → parse → 生成 instanceId → 初始化 pending 快照 → `ctx.agents.create`
 * 创建宿主主代理（setup 注册 8 个 `sandore_*` 工具）→ fire-and-forget
 * `execute`；`execute` 以 Stage 级线性主循环编排（每 Stage 新建 microflow `StepNavigator`
 * 承担 Step 级路由/循环，`StageExecutor` 执行 Stage 内 Step → 收集 StageContract →
 * `tryAdvanceStage` 评估 Stage `branch.condition`（基于 StageContract）选下一 Stage）。每次状态
 * 变化 `persistState` 并单发 `sandore/*` 事件（`ctx.emit` → SSE → UI；Round 25 起
 * 不再 append 到宿主会话，宿主会话保持工作流级编排身份）；每个 Step 完成后经
 * `onPersist` 钩子立即追加到 `state.executedSteps` 并持久化；`childId = 真实子代理会话
 * id`（2026-09-09 起无合成占位：先 `launchSubagent`/startContinuable 拿到真实 UUID 才
 * 发 step-start 并写入 sessionMeta；shell 无 childId）合成 sessionMeta。
 * @module @meiyukichan/dsh-sandore/workflow/src/workflow-engine
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
// 加载 @deepseek-ai/dsh-session-title 的 Cordis 面声明（使 `ctx.sessionTitle` 类型可用）。
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title';
import z from '@deepseek-ai/schemastery';

/**
 * `ctx.workspaceRegistry` 服务的最小面（由引擎 get 后窄断言使用，签名对齐 DSH
 * `WorkspaceRegistry.resolveByPath` / `WorkspaceRegistry.create`，不 import DSH
 * workspace 包类型——保持 browser-safe 接缝哲学，与 AgentPresetsSeam 同区）。
 */
interface WorkspaceRegistrySeam {
  /** 按规范目录路径解析已登记的 workspace（无此路径的 workspace 时返回 undefined）。 */
  resolveByPath(path: string): Promise<WorkspaceSeam | undefined>;
  /** 登记一个目录为 workspace（DSH 侧先 realpathNormalize + stat 验证目录存在）。 */
  create(path: string): Promise<WorkspaceSeam>;
}

/** DSH `Workspace` 实体的最小面（签名对齐 `Workspace.attachSession`）。 */
interface WorkspaceSeam {
  /** 把会话挂到该 workspace 的成员账（DSH 侧校验会话 header cwd 与该 workspace 路径一致）。 */
  attachSession(sessionId: SessionId): Promise<void>;
}

import { WorkflowDagNavigator } from './dag-navigator.ts';
import { SandoreError } from './errors.ts';
import { ReactiveState } from './reactive-state.ts';
import { createHostAgentSetup, resolveHostAgentOptions } from './host-agent.ts';
import type {
  AgentDefaultModelSeam,
  AgentPresetsSeam,
  HostModelSelectionDeps,
  SessionProjectionsSeam,
} from './host-agent.ts';
import { registerGlobalAskTool } from './ask-tool.ts';
import { registerGlobalWorkflowTools } from './host-tools.ts';
import { buildHostContextInjection, hostContextSource } from './host-context.ts';
import { hostWakeupDiag } from './wakeup-diag.ts';
import type { HostWakeupBatchEntry, HostWakeupRecord } from './wakeup-diag.ts';
import type { SandoreManagerPersistenceSeam } from './manager-tool.ts';
import { createChildPromptDelivery } from './subagent-delivery.ts';
import { InteractionManager, buildAnswerText, isRejectedAnswer } from './interaction-manager.ts';
import { LifecycleManager } from './lifecycle-manager.ts';
import type { SandorePersistence } from './persistence.ts';
import { RecoveryManager } from './recovery-manager.ts';
import { listClosedTurnBoundaries, synthesizeChildId } from './recovery-manager.ts';
import type { RecoverResult, RetryMode } from './recovery-manager.ts';
import type { WorkflowDefinition, WorkflowStep, WorkflowTaskState, WorkflowStage } from './schema.ts';
import type { FinalizePhase } from './schema.ts';
import { SandoreEngine } from './seam.ts';
import type { SandoreConfig } from './seam.ts';
import { registerSandoreSse } from './sse.ts';
import type { RevertBoundaryOption } from './wire.ts';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionPayload,
  DagResultInfo,
  DagRun,
  DagRunInfo,
  DagStartRequest,
  DagInstanceState,
  ExecutedStepDefault,
  PendingPermissionEntry,
  PendingQuestionEntry,
  StageContract,
  StepStatus,
} from './types.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

import { FinalizeManager } from '../microflow/finalize-manager';
import { createConcurrencyLimiter } from '../microflow/concurrency-limiter';
import type { ConcurrencyLimiter } from '../microflow/concurrency-limiter';
import { StageExecutor, previousOutputsFromExecutedSteps } from '../microflow/stage-executor';
import type { StageExecutorResume, StageStepHooks } from '../microflow/stage-executor';
import { StepNavigator } from '../microflow/step-navigator';
import type { StepRunnerConfig } from '../microflow/step-runner';
import type { Agent, AgentHandle, ChildPromptDelivery, CreateAgentOptions, MessageId, SessionEvent, SubagentSettlement, SubagentStopReason } from '../microflow/subagents';
import { collectSessionMessages } from '../microflow/subagents';
import { delegatedChildSetup } from '../microflow/fork-session';
import { ensureSubagentDescriptor } from './subagent-identity';

/**
 * `agent/pre-step` 事件的最小结构面（sandore 不 import `@deepseek-ai/dsh-agent` 类型，
 * 以结构类型声明对齐 DSH `PreStepDecision` / pre-step payload）。DSH 在 agent scope 以
 * waterfall 模式分发该事件：`agent` 为提出步骤的 subject，`next()` 委托下游监听链。
 */
interface HostAgentPreStepPayload {
  readonly agent: { readonly id: SessionId };
  readonly messages: readonly PreStepMessage[];
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

/**
 * `agent/pre-step` 载荷中单条消息的最小面（只读 `source.kind` 做来源过滤）。
 *
 * 结构对齐 DSH `UserMessage`（`createUserMessage` 产物的 `source` 为可合并扩展的
 * `MessageSource` 判别联合；`kind` 回答「谁产出的」）。
 */
interface PreStepMessage {
  readonly source?: { readonly kind?: string; readonly [key: string]: unknown };
}

/** `agent/pre-step` 的决策：reject 关闭该 turn（无 step、不产生模型调用）或 enter 消息批次。 */
type HostAgentPreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: readonly unknown[] };

/** `agent/pre-step` 的 `next` 委托：调用则进入下游监听链/内建行为。 */
type HostAgentPreStepNext = () => Promise<HostAgentPreStepDecision>;

/**
 * `hydrateStateMessages` 每段最多回填的消息行数（**与移除前持久化时的截断一致**：
 * step-runner 当年写 state 时取 `slice(-10)`）。避免 RPC 响应被长会话撑大。
 */
const HYDRATED_MESSAGES_LIMIT = 10;

/**
 * DSH `session/event` 载荷中单条事件的最小面（只读 `type` 与 `turn/end` 的 reason）。
 *
 * 结构对齐 DSH `SessionEvent`（`turn/end` 的 `data.reason` 为 `TurnEndReason`：
 * `{kind:'completed'|'blocked'|'aborted'|'error'|'max-tokens'|'interrupted'}`，
 * `aborted` 携带 `reason: AgentCancelCause`）。
 */
interface HostSessionEventLike {
  readonly type: string;
  readonly data?: { readonly reason?: { readonly kind?: string; readonly reason?: { readonly kind?: string } } };
}

/** 运行中的实例（控制器 + 宿主 Session + 宿主主代理 + 定义 + 状态快照 + 交互管理器）。 */
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly hostAgent: Agent;
  readonly definition: WorkflowDefinition;
  readonly interactions: InteractionManager;
  readonly lifecycle: LifecycleManager;
  readonly recovery: RecoveryManager;
  readonly reactiveState: ReactiveState<WorkflowTaskState>;
  state: WorkflowTaskState;
  /**
   * resume 请求标志（补充 37 SessionIdleWaiter 扩展）：按 stepId 维度维护。
   * resumeStep(stepId) 触发时记录该 stepId；主循环 paused 等待时按 stepId 消费。
   * '*' key 表示 resumeAllSteps（唤醒全部）。
   */
  resumeRequested: Set<string>;
  /**
   * 主循环 paused 等待 resume 的 waiter 集合（补充 37 SessionIdleWaiter 扩展）：
   * Map<stepId | '*', resolve[]>。resumeStep(stepId) 只唤醒目标 stepId 的 waiter，
   * resumeAllSteps 唤醒全部（'*' key + 遍历所有 key）。
   */
  resumeWaiters: Map<string, Array<() => void>>;
  /**
   * settle 终态缓冲（对齐 DSH `subagent/end`）：Map<childId, settlement>。
   *
   * DSH 适配层/mock 发射 `sandore/subagent-settled` 时，buildActiveInstance 注册的
   * 单一监听器把 settlement 存入此缓冲并唤醒挂起 awaiter。`awaitSubagentSettlement`
   * 先查缓冲（命中即消费返回，解决 settle 早于 awaiter 注册的竞态——如 resume 测试
   * 在 `await engine.resumeStep` 前调用 settleChild），否则注册 per-childId resolver。
   */
  settlementBuffer: Map<string, SubagentSettlement>;
  /** per-childId settle awaiter resolver（awaitSubagentSettlement 挂起时注册，监听器唤醒）。 */
  settlementResolvers: Map<string, (settlement: SubagentSettlement) => void>;
  /**
   * 中止广播一次性标记（{@link markAborted} 专用）。
   *
   * 同一次中止只允许广播一次 `sandore/aborted`：`abortInstance` 与主循环 aborted
   * 兜底分支天然交错（被 kill 的 Step 失败回写会把内存态打回 failed，使兜底守卫
   * 误判「尚未落态」），故两条路径都查本标记——谁先到谁广播，后到者只补落态。
   */
  abortedBroadcast: boolean;
  /**
   * 本实例 `sandore/subagent-settled` 监听器的 disposer（{@link buildActiveInstance} 注册）。
   *
   * 入口归一后**同一个会话 id 可以先后承载多个实例**（终态后再 run 复用同一槽位），
   * 故替换 ActiveInstance 时必须先撤销旧监听器，否则每次重跑都会多留一个监听器。
   */
  disposeSettlementListener: () => void;
}

/** 实例终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted']);

/**
 * 可接收 @mention 消息的 Step 段状态（P3：与工具描述同口径，两条投递路径共用）。
 *
 * 与 `lifecycle-manager` 的可暂停集合一致：只有 **running/interacting** 的段背后
 * 才有「活着、会消费队列」的子代理会话；paused/failed/completed 的段虽仍绑定 childId，
 * 但消息只会堆在一个不会醒来的会话里（旧实现就是这么静默成功的）。
 */
const MESSAGEABLE_STEP_STATUSES: ReadonlySet<string> = new Set(['running', 'interacting']);

/**
 * 不可收消息时的**自纠建议**（按当前状态给出下一步该调的动作）。
 *
 * 错误信息是模型唯一能读到的反馈：只说「不可收」不够，必须给出「那该怎么办」。
 * @param status - 该段当前状态。
 * @returns 以「；」开头的建议片段。
 */
function messageableSuggestion(status: string): string {
  switch (status) {
    case 'paused':
      return '；该 Step 已暂停：先 sandore_workflow_control {action:"continue"} 恢复它，再发消息';
    case 'failed':
      return '；该 Step 已失败：先 sandore_workflow_control {action:"continue"} 重建子代理重试，再发消息';
    case 'completed':
      return '；该 Step 已完成，无需再发消息（要改结论请新建实例或对失败的 Step 重试）';
    default:
      return '；请用 sandore_workflow_status detail=steps 确认该 Step 的最新执行段状态';
  }
}

/** 渲染任意抛出值为可读消息。 */
function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 当前 ISO 时间戳。 */
function now(): string {
  return new Date().toISOString();
}

/** 组装一条宿主唤醒诊断记录（仅测试开关下输出，见 wakeup-diag.ts）。 */
function diagRecord(
  active: ActiveInstance,
  payload: HostAgentPreStepPayload,
  batch: ReadonlyArray<HostWakeupBatchEntry & { message: PreStepMessage }>,
  decision: 'park' | 'enter' | 'partial' | 'pass',
): HostWakeupRecord {
  return {
    hostSessionId: active.state.taskId,
    instanceStatus: active.state.status,
    turn: payload.turn,
    step: payload.step,
    batch: batch.map(entry => ({
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.senderSessionId === undefined ? {} : { senderSessionId: entry.senderSessionId }),
      attribution: entry.attribution,
    })),
    decision,
  };
}

/**
 * 从 executedSteps 中定位处于 ask 保底中断且携带 ask 载荷的 Step。
 *
 * 偏离 8：executed.status 在 ask 中断时保持 running（interacting 只设 state.status），
 * 故以 finalizeMeta `currentPhase === 'ask-detect'` 标记（runPhaseA ask 分支 commitFinalize
 * 写入）定位，而非旧 `status === 'interacting'` 过滤。
 */
function findAskStep(
  steps: WorkflowTaskState['executedSteps'],
): { step: WorkflowTaskState['executedSteps'][number]; payload: AskUserQuestionPayload } | undefined {
  for (const step of steps) {
    const payload = step.finalizeMeta?.askResult?.askQuestion;
    if (step.finalizeMeta?.currentPhase === 'ask-detect' && payload !== undefined) {
      return { step, payload };
    }
  }
  return undefined;
}

/** 生成实例 ID（UUID 格式，同时作为 state 表键、宿主会话 id 与 taskId）。 */
function makeInstanceId(): string {
  return globalThis.crypto.randomUUID();
}

/** 权限预设 → sandbox 模式 + 审批策略（对齐 DSH permission-presets 的默认表）。 */
const PERMISSION_SPECS: Readonly<Record<string, { readonly sandbox: string; readonly approval: string }>> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

/**
 * 全局收集工作流定义中所有 Step 声明的透传变量默认值（first-wins，按 Stage 顺序）。
 *
 * 对齐基准 `initPassThroughVars`：startInstance 时一次性播种全部声明的默认值，
 * 解决「先引用后定义（跨 Stage 反向引用）」编排——Stage A 的 Step 引用 `${xxx}`
 * 而 `xxx` 的字面量默认值只在 Stage B 声明时，Stage A 执行能拿到定义默认值而非
 * 保留字面量（残余差异一）。仅对结果尚无的 name 写入（first-wins），同名变量
 * 重复声明取首个 Stage 顺序出现的定义；后续提取值经 finalize
 * `writeBackPassThroughVars` 覆盖（缺陷 15 修复计划第 2 点）。recoverInstance 路径
 * 不调用本函数——快照 passThroughVars 已持久化（含 startInstance 播种的默认值 +
 * 执行期提取值），原样读回即可。
 */
function collectDefaultPassThroughVars(definition: WorkflowDefinition): WorkflowTaskState['passThroughVars'] {
  const definitions = new Map((definition.steps ?? []).map(step => [step.id, step] as const));
  const result: WorkflowTaskState['passThroughVars'] = {};
  for (const stage of definition.stages) {
    for (const flowStep of stage.steps) {
      const step = definitions.get(flowStep.id);
      if (step === undefined) {
        continue;
      }
      for (const variable of step.passThroughVars ?? []) {
        if (result[variable.name] === undefined) {
          result[variable.name] = {
            value: variable.value,
            description: variable.description,
            ...(variable.refresh === undefined ? {} : { refresh: variable.refresh }),
          };
        }
      }
    }
  }
  return result;
}

/** 构造实例初始（pending）状态快照。 */
function makeInitialState(options: {
  readonly instanceId: string;
  readonly request: DagStartRequest;
  readonly definition: WorkflowDefinition;
  readonly createdAt: string;
  readonly cwd: string;
  /** 初始状态：overlay 新建路径为 `pending`（等宿主会话调用 run），已知会话路径直接 `running`。 */
  readonly status?: 'pending' | 'running';
}): WorkflowTaskState {
  const { instanceId, request, definition, createdAt, cwd } = options;
  return {
    taskId: instanceId,
    // 显式落地宿主主代理会话 id（恒等于 taskId；入口归一后不再依赖"约定"）。
    // 读取侧一律 `hostSessionId ?? taskId` 回退（旧快照没有该字段）。
    hostSessionId: instanceId,
    workflowId: request.workflowId,
    workflowName: definition.name,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(request.model === undefined ? {} : { modelSelection: request.model }),
    ...(request.permission === undefined ? {} : { permission: request.permission }),
    cwd,
    status: options.status ?? 'pending',
    originalInput: request.originalInput,
    currentStageId: definition.stages[0]?.id ?? '',
    executedSteps: [],
    stageInfos: definition.stages.map(stage => ({ id: stage.id, name: stage.name, status: 'blocked' })),
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    // 全局播种全部 Step 声明的透传变量默认值（first-wins）：解决「先引用后定义」
    // 跨 Stage 反向引用场景，使 Stage A 引用 `${xxx}` 而 xxx 默认值只在 Stage B
    // 声明时能拿到定义默认值。提取值后续经 finalize writeBackPassThroughVars 覆盖。
    passThroughVars: collectDefaultPassThroughVars(definition),
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    userMessages: [{
      id: `usr-${globalThis.crypto.randomUUID()}`,
      kind: 'input',
      target: '',
      content: request.originalInput,
      createdAt,
    }],
    stageContracts: {},
    // 入口归一（架构决策 1）：宿主会话 id 恒等于实例 id（taskId）——现已**显式落地**
    // 为顶层 `hostSessionId` 字段（见上），读取侧 `?? taskId` 回退兼容旧快照；
    // ask/permission 一律上报宿主主代理（reportToHost 单值化，恒 true——见 interaction-manager）。
    createdAt,
    updatedAt: createdAt,
  };
}

/** 从完整状态快照投影 `DagInstanceState`（引擎 `getState` 的返回形状）。 */
function toDagInstanceState(state: WorkflowTaskState): DagInstanceState {
  return {
    taskId: state.taskId,
    // 宿主主代理会话 id：新快照显式字段，旧快照回退 taskId（不做破坏性迁移）。
    hostSessionId: state.hostSessionId ?? state.taskId,
    workflowId: state.workflowId,
    status: state.status,
    originalInput: state.originalInput,
    currentStageId: state.currentStageId,
    // 存储 schema 的 executedSteps（output 为宽松 JSON 形状）与 browser-safe
    // DagInstanceState（output 为 dsh-llm ContentBlock[]）结构兼容，仅类型更窄。
    executedSteps: state.executedSteps as unknown as DagInstanceState['executedSteps'],
    stageInfos: state.stageInfos,
    pendingQueue: state.pendingQueue,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * 工作流引擎运行时。
 *
 * 作为 workflow 包默认导出：实现 12 个实例级生命周期方法
 * （start/recover/abort/reply/pause/resume/retry/getState），其中 8 个
 * 交互/生命周期/恢复方法转调 interaction/lifecycle/recovery 三管理器。
 */
export default class SandoreEngineRuntime extends SandoreEngine {
  static Config: z<SandoreConfig> = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    // 缺陷 10：maxConcurrentSteps 默认 4（合理并发上限），0=不限（UnlimitedLimiter）。
    maxConcurrentSteps: z.natural().default(4),
    defaultProvider: z.string(),
    defaultModel: z.string(),
  });

  static inject = ['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'subprocess', 'fs', 'storageDomain', 'sandorePersistence', 'userQuestions', 'sessionTitle'];

  private readonly instances = new Map<string, ActiveInstance>();
  /**
   * 宿主会话 → 其子会话 id 集合（`session/created` 按 `header.parentSession` 登记）。
   *
   * 用途：宿主唤醒抑制的判据③（见 {@link childAttribution}）。**这是唯一与「子会话是否
   * 仍 live」无关的归属来源**，因此 fillParams 参数填充 / secondary 门禁这类辅助子代理
   * 在 settle（其 live 会话已 dispose）之后仍能被正确归属并 park。
   */
  private readonly hostChildSessions = new Map<string, Set<string>>();
  /**
   * 宿主 → 子代理 prompt 投递通道（`[Service.init]` 期经 `createChildPromptDelivery`
   * 解析一次；上游 `subagents.followup` 已删，见 subagent-delivery.ts）。
   */
  private childDelivery: ChildPromptDelivery | undefined = undefined;

  /**
   * 向直接子代理投递一条宿主协议消息（queue 投递 = 独立 FIFO 轮次语义，等价旧
   * `subagents.followup`）。全部投递调用点（sendStepMessage / ask 回答注回 /
   * LifecycleManager / RecoveryManager 包装）统一走此方法。
   */
  private deliverChildPrompt(
    parent: Agent,
    childId: string,
    content: ContentBlock[],
    signal: AbortSignal | undefined,
  ): Promise<MessageId> {
    const delivery = this.childDelivery;
    if (delivery === undefined) {
      throw new SandoreError('child prompt delivery is not initialized (Service.init incomplete)', 'INVALID_OPERATION');
    }
    return delivery(parent, SessionId(childId), content, { kind: 'user' }, signal);
  }

  constructor(ctx: Context, private readonly config: SandoreConfig) {
    super(ctx);
  }

  /** 启动时（Cordis Service.init）自动扫描并恢复孤儿实例（崩溃恢复启动扫描）。 */
  protected async [Service.init](): Promise<void> {
    this.registerSubagentSettlementAdapter();
    // 架构决策 2：宿主主代理**解冻**（不再有 frozenHostAgents / pre-step reject），
    // 改为「只 park 本实例子代理的消息」——见 registerHostSessionNoticeFilter。
    // 子会话登记表必须先挂（判据③依赖它；创建早于登记的会话由判据⑤持久化兜底）。
    this.registerHostChildSessionTracker();
    this.registerHostSessionNoticeFilter();
    // 架构决策 6：宿主会话 turn 被用户中断（输入框「停止生成」）→ 实例 paused。
    this.registerHostTurnAbortWatcher();
    // 双通道 ask 通道 1：全局注册 `sandore_ask_user_question` 工具 + execute 期 gate
    // （上游 `registerContinuableSetup` 已删，child-scope 注入通道不复存在，见 ask-tool.ts）。
    this.ctx.effect(() => registerGlobalAskTool(this.ctx, this), 'sandore: global sandore_ask_user_question tool');
    // 五个 sandore_workflow_* 模型工具（架构决策 3）：sandore_workflow（定义/Step 库/
    // Microflow 库读写）+ sandore_workflow_run（唯一启动入口）+ sandore_workflow_status +
    // sandore_workflow_send_message + sandore_workflow_control；全局注册 + execute 期 gate
    // 仅顶层主代理会话（见 manager-tool.ts / host-tools.ts）。
    this.ctx.effect(() => registerGlobalWorkflowTools(this.ctx, {
      startInstance: request => this.startInstance(request),
      runInstanceInSession: (hostSessionId, request) => this.runInstanceInSession(hostSessionId, request),
      getState: instanceId => this.getState(instanceId),
      getInstanceState: instanceId => this.getInstanceState(instanceId),
      hydrateStateMessages: state => this.hydrateStateMessages(state),
      findInstanceIdByHostSession: hostSessionId => this.findInstanceIdByHostSession(hostSessionId),
      pauseStep: (instanceId, stepId) => this.pauseStep(instanceId, stepId),
      pauseAllSteps: instanceId => this.pauseAllSteps(instanceId),
      resumeStep: (instanceId, stepId, resumePrompt) => this.resumeStep(instanceId, stepId, resumePrompt),
      resumeAllSteps: (instanceId, resumePrompt) => this.resumeAllSteps(instanceId, resumePrompt),
      retryStep: (instanceId, stepId, mode, message) => this.retryStep(instanceId, stepId, mode, message),
      sendStepMessage: (instanceId, stepId, message) => this.sendStepMessage(instanceId, stepId, message),
      persistence: () => this.managerPersistenceView(),
    }), 'sandore: global sandore_workflow_* tools');
    // 宿主 → 子代理 prompt 投递通道（上游 `subagents.followup` 已删，统一 queue 投递；
    // 工厂期解析通道，皆无时抛可读错误，见 subagent-delivery.ts）。
    this.childDelivery = createChildPromptDelivery(this.ctx.subagents);
    // SSE 事件通道：注册 /sandore/events 端点，广播 sandore/* 事件给 client。
    this.ctx.effect(() => registerSandoreSse(this.ctx), 'sandore: SSE event channel');
    await this.recoverOrphanedInstances();
  }

  /**
   * ask 工具 gate 反查（`SandoreAskToolHost` 契约）：给定调用方子代理的
   * `session.header.parentSession`，判断其是否命中**当前非终态 sandore 实例**的宿主
   * 主代理会话（反查 instances 表）。
   *
   * gate 为「当前有 sandore 实例匹配」，而非「曾创建过 sandore 宿主主代理」的永久
   * 登记——终态实例（completed/failed/aborted）仍留 instances 表（getState 兜底读
   * 快照），故显式排除终态，避免宿主主代理在工作流结束后普通 turn 委派的子代理
   * 误用提问工具（误用会令提问路由到已结束实例的交互管理器）。
   */
  isSandoreSubagentParentSession(parentSession: string | undefined): boolean {
    if (parentSession === undefined) {
      return false;
    }
    return [...this.instances.values()].some(instance =>
      instance.hostAgent.id === parentSession && !TERMINAL_STATUSES.has(instance.state.status));
  }

  /**
   * DSH 适配层：把 DSH `subagent/end` 生命周期事件转译为 sandore `sandore/subagent-settled`。
   *
   * DSH continuable 子代理「完成 = settle」：`SubagentContinuationManager` 在子代理静止时
   * dispose → `notifySettlement`（向父 inbox 投 `subagent-settled` 消息）→ `observer.settle`
   * （emit `subagent/end` 生命周期事件，载荷 = `SubagentRunEndInfo`：`id` + `stopReason` +
   * `lastAssistantMessage`）。sandore 不 import dsh-subagent 类型（与接缝哲学一致），故以
   * 结构类型 + 一次性 `ctx.on` 转译：监听 DSH `subagent/end`（hostAgent 是子代理 parent，
   * 其 scope 链含引擎 ctx → 引擎 ctx 监听器接收 parent-scoped 事件），转译为 sandore 自有
   * `sandore/subagent-settled` 事件，供 `awaitSubagentSettlement`（per-call `ctx.on`）路由。
   *
   * mock `FakeSubagents` 直接发射 `sandore/subagent-settled`（不经此转译），故单测覆盖此通道。
   * 真实 DSH 部署经此桥接——e2e 验证（单测不覆盖，mock 屏蔽真实 continuation manager）。
   */
  private registerSubagentSettlementAdapter(): void {
    // DSH `SubagentRunEndInfo` 结构面（不 import dsh-subagent 类型）。
    type DshSubagentEnd = {
      readonly id: string;
      readonly stopReason: SubagentStopReason;
      readonly lastAssistantMessage?: readonly ContentBlock[];
    };
    // 名字转译：把 DSH `subagent/end` 监听器伪装成 sandore `sandore/subagent-settled`
    // 监听器（类型侧），运行时仍以 `'subagent/end'` 字符串注册，DSH emit 即命中。
    const handler = ((settlement: SubagentSettlement): void => {
      const end = settlement as unknown as DshSubagentEnd;
      this.emitSubagentSettled({
        childId: end.id,
        stopReason: end.stopReason,
        ...(end.lastAssistantMessage === undefined ? {} : { output: end.lastAssistantMessage }),
      });
    }) as (settlement: SubagentSettlement) => void;
    this.ctx.on('subagent/end' as 'sandore/subagent-settled', handler);
  }

  /**
   * 宿主会话「子代理消息 park」监听（架构决策 2：删除冻结机制后的替代手段）。
   *
   * **背景**：旧的宿主主代理冻结机制在 `agent/pre-step` 对宿主会话的**每个 turn**
   * 一律 `reject`——宿主主代理完全失去自主性（连周边任务都做不了）。架构决策 2 要求
   * 移除该机制、恢复宿主主代理自主性，**但同时**必须抑制 DSH 投给宿主会话的
   * 「子代理结算通知」，否则宿主主代理会被每个 Step 的结算各唤醒一次。
   *
   * **DSH 侧的投递路径（查证依据）**：`@deepseek-ai/dsh-subagent` 的
   * `SubagentContinuationManager.notifySettlement`（DSH 源码
   * `packages/subagent/subagent/src/continuation.ts:1535-1584`）在每个 continuable
   * 子代理 settle（走完即 dispose）时**无条件**向直接 parent 投一条消息：source
   * `{ kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId }`
   * （同文件 :1541-1554）；子代理显式发给 parent 的消息走 `agentMessage`，source
   * `{ kind: 'agent-message', form: 'relay', senderSessionId: childId }`（:276-293）。
   * parent 空闲走 `parent.followup(message)`（**开新 turn = 唤醒**），忙走
   * `parent.steer(...)`。该投递**不可配置关闭**：`ContinuableStartSpec` 只有
   * `{provider,label,childId?,request,signal}`（:92），continuation.ts 内没有任何
   * quiet/reportDelivery 开关，`notifySettlement` 是 `disposeActivation` 的固定一步，
   * 且被 DSH 当作契约（:1517-1534 注释「Unconditional for every child…」）。
   * → 抑制只能做在 `agent/pre-step` 这一层。
   *
   * **判定「是否我们实例的子代理发的」**（两条判据，来源字段足以稳定判定）：
   * ① `source.senderSessionId` ∈ 本实例已知子代理会话集合（`executedSteps[].sessionMeta.childId`
   * 全段 —— running/interacting/completed/failed/paused 都覆盖，含多执行段与冷恢复后的
   * 新 childId；再并上生命周期暂停登记表 `lifecycle.pausedIds`）；
   * ② 兜底：`ctx.sessions.get(senderSessionId).header.parentSession === 宿主会话 id`
   * （覆盖未落在 executedSteps 上的引擎自建子代理，如 fillParams 参数填充子代理、
   * secondary 门禁子代理——它们的 parent 同样是宿主会话）。
   * 两条都不命中 → 放行（其它 sandore 实例、DSH 自己的子代理、用户消息、ask/权限
   * 卡片等一切非本实例子代理来源）。
   *
   * **park 的实现与 DSH 语义（重要更正）**：本监听器对「整批消息全来自本实例子代理」
   * 的唤醒返回 `{kind:'reject'}`（turn 以 `blocked` 关闭、零模型调用）。**注意 DSH 的
   * reject 并不把消息留在 inbox**——`Inbox.claim`（`packages/core/agent/src/inbox.ts:71-78`）
   * 在 waterfall 之前就同步认领（splice 删除）了整批消息，`preStep` 返回 reject 后
   * `agent.ts:276-279` 直接结束 turn。DSH 源码 `consumed-work.ts:33-49` 对此有原文：
   * 「A `blocked` end is that input's ending too — the pre-step rejection that produced it
   * **discarded the claimed messages**, so the work it took will never run.」DSH 官方测试
   * `core/agent-loop/tests/interception.spec.ts:236-257` 亦锁定「no `user/message`」。
   * 即：park = 消费并丢弃，**不会**在下次唤醒时重新可见。
   * 对本插件无损：子代理的最终输出由引擎自己经 `sandore/subagent-settled` 适配通道
   * （DSH `subagent/end`）取得并落到 `executedSteps[].output / sessionMessages`，
   * `sandore_workflow_status` 可读；实例终态另有 {@link notifyHostTerminal} 一条汇总。
   *
   * **批次混排**：`messages` 里既有本实例子代理消息又有其它来源（用户消息等）时不能
   * reject（会连用户消息一起丢），改为「摘掉属于本实例子代理的那些、其余原样进入本
   * step」——DSH `agent.ts:243-252` 明确允许监听器改写 `messages` 批次，且
   * `agent.ts:280-286` 支持空批次（注释原文「A removed waking message … still owns the
   * initial turn boundary, but it spends no model call.」）。
   *
   * **终态放行**：本实例已终态（completed/failed/aborted）时不再 park——那一次通知
   * 让宿主主代理被唤醒去汇报结果；实例终结本身另有 {@link notifyHostTerminal}。
   */
  private registerHostSessionNoticeFilter(): void {
    const handler = (async (
      payload: HostAgentPreStepPayload,
      next: HostAgentPreStepNext,
    ): Promise<HostAgentPreStepDecision> => {
      const active = this.instances.get(payload.agent.id);
      if (active === undefined) {
        // 非本引擎实例的会话（含 Step 子代理自身）：放行，不诊断（别人的会话）。
        return next();
      }
      if (TERMINAL_STATUSES.has(active.state.status)) {
        // 本实例已终态：放行（让主代理醒一次去汇报）。**仍要诊断**——否则「终态那一次
        // 唤醒」不会进 dump，唤醒计数会偏小（M8 取证用例靠它核对次数）。
        hostWakeupDiag(diagRecord(active, payload, await this.attributeBatch(active, payload.messages), 'pass'));
        return next();
      }
      const attribution = await this.attributeBatch(active, payload.messages);
      const ours = attribution.filter(entry => entry.attribution !== null);
      if (ours.length === 0) {
        hostWakeupDiag(diagRecord(active, payload, attribution, 'pass'));
        return next();
      }
      if (ours.length === payload.messages.length) {
        // 整批都是本实例子代理的消息：park（turn 以 blocked 关闭、零模型调用）。
        hostWakeupDiag(diagRecord(active, payload, attribution, 'park'));
        return { kind: 'reject' };
      }
      // 混排：只摘掉本实例子代理的那些，其它（用户消息/ask 卡片/别的来源）照常进入。
      const oursSet = new Set(ours.map(entry => entry.message));
      const kept = payload.messages.filter(message => !oursSet.has(message));
      hostWakeupDiag(diagRecord(active, payload, attribution, 'partial'));
      return { kind: 'enter', messages: kept };
    }) as unknown as (settlement: SubagentSettlement) => void;
    this.ctx.on('agent/pre-step' as 'sandore/subagent-settled', handler, { prepend: true });
  }

  /** 批次归属判定：逐条消息给出 `{kind, senderSessionId, attribution}`（诊断与判定共用）。 */
  private async attributeBatch(
    active: ActiveInstance,
    messages: readonly PreStepMessage[],
  ): Promise<Array<HostWakeupBatchEntry & { message: PreStepMessage }>> {
    const entries: Array<HostWakeupBatchEntry & { message: PreStepMessage }> = [];
    for (const message of messages) {
      const senderSessionId = message.source?.['senderSessionId'];
      const sender = typeof senderSessionId === 'string' && senderSessionId !== '' ? senderSessionId : undefined;
      const kind = message.source?.['kind'];
      entries.push({
        message,
        ...(typeof kind === 'string' ? { kind } : {}),
        ...(sender === undefined ? {} : { senderSessionId: sender }),
        attribution: sender === undefined ? null : await this.childAttribution(active, sender, kind),
      });
    }
    return entries;
  }

  /**
   * 该 pre-step 消息是否来自**本实例**的子代理会话，命中即给出判据名
   * （`executed`/`paused`/`registry`/`live`/`persisted`；未命中 null）。
   *
   * 五条判据（由廉价到昂贵；命中即返回）：
   * ① `executed`：`senderSessionId` ∈ `executedSteps[].sessionMeta.childId`（覆盖
   *    running/interacting/completed/failed/paused、多执行段与冷恢复后的新 childId）；
   * ② `paused`：∈ 生命周期暂停登记表（兜住 `executedSteps` 尚未回写 childId 的窗口）；
   * ③ `registry`：∈ **子会话登记表**（{@link registerHostChildSessionTracker} 在
   *    `session/created` 时按 `header.parentSession = 某个活跃实例 id` 登记）——这一条
   *    是 2026-09 真机缺陷的修复核心：`fillParams` 参数填充 / secondary 门禁这类**引擎
   *    自建辅助子代理**的 childId **不在** `executedSteps`，而其 live 会话在 settle 时
   *    即被 dispose（`sessions.get` 读不到），旧判据①②因此双双落空 → 它们的结算通知
   *    会**放行并唤醒宿主主代理**（真机表现：工作流还在跑，主代理却收到一次唤醒并自行
   *    发了一条「进展更新」）。登记表在**创建时**记录，与被 dispose 无关。
   * ④ `live`：`ctx.sessions.get(sender).header.parentSession === taskId`（live 兜底）；
   * ⑤ `persisted`：`sessionPersistence.inspect(sender).header.parentSession === taskId`
   *    （**持久化兜底**，覆盖登记表未覆盖的场景：进程重启后遗留的辅助子代理、注册监听
   *    之前就已创建的会话）。仅对**子代理来源**消息（`subagent-settled`/`agent-message`）
   *    尝试，用户消息与 ask 卡片永不进入本路径。
   *
   * 安全边界：①②③④⑤ 全部要求「该会话确属本实例宿主会话的子会话」；用户消息
   * （`source.kind === 'user'`，无 senderSessionId）与带 `senderSessionId` 但无法归属的
   * 消息一律放行——**宁可少 park，也不误 park 用户消息**。
   * @param active - 本实例的运行态。
   * @param senderSessionId - 消息来源会话 id（`source.senderSessionId`）。
   * @param kind - `source.kind`（决定是否尝试持久化兜底）。
   * @returns 判据名或 null。
   */
  private async childAttribution(
    active: ActiveInstance,
    senderSessionId: string,
    kind: unknown,
  ): Promise<string | null> {
    for (const step of active.state.executedSteps) {
      if (step.sessionMeta?.childId === senderSessionId) {
        return 'executed';
      }
    }
    if (active.lifecycle.pausedIds.includes(senderSessionId)) {
      return 'paused';
    }
    if (this.hostChildSessions.get(active.state.taskId)?.has(senderSessionId) === true) {
      return 'registry';
    }
    if (this.ctx.sessions.get(SessionId(senderSessionId))?.header?.parentSession === active.state.taskId) {
      return 'live';
    }
    if (kind !== 'subagent-settled' && kind !== 'agent-message') {
      return null;
    }
    return await this.persistedChildOf(active.state.taskId, senderSessionId) ? 'persisted' : null;
  }

  /**
   * 持久化兜底：读子会话的持久化 header，判断其 `parentSession` 是否为本实例宿主会话。
   *
   * DSH `SessionPersistence.inspect(id)` 返回 `SessionInspection`（含 `header`，见
   * `packages/session/session-persistence/src/index.ts:26,253`）。服务缺失/无 `inspect`/
   * 读取失败一律返回 false（放行——不误 park）。
   */
  private async persistedChildOf(hostSessionId: string, senderSessionId: string): Promise<boolean> {
    const persistence = this.ctx.get('sessionPersistence') as
      | { inspect?: (id: SessionId) => Promise<{ header?: { parentSession?: string } } | undefined> }
      | undefined;
    if (persistence?.inspect === undefined) {
      return false;
    }
    try {
      const inspected = await persistence.inspect(SessionId(senderSessionId));
      return inspected?.header?.parentSession === hostSessionId;
    } catch {
      return false;
    }
  }

  /**
   * 子会话登记表（`taskId → 该宿主会话的子会话 id 集合`）监听。
   *
   * 在 DSH `session/created`（`packages/core/session/src/index.ts:52,1044`）时按
   * `header.parentSession` 归属登记：**这是唯一与「子会话是否仍 live」无关的归属来源**，
   * 因此是辅助子代理（fillParams/secondary 门禁）结算通知的正确判据。
   *
   * `{ global: true }`：DSH 自己的 invariant 也以该选项监听同一事件
   * （`core/session/src/invariant.ts:220`）——不加会漏掉不在本 ctx scope 下创建的会话。
   */
  private registerHostChildSessionTracker(): void {
    const handler = ((session: { readonly header?: { readonly id?: string; readonly parentSession?: string } }): void => {
      const parent = session.header?.parentSession;
      const id = session.header?.id;
      if (typeof parent !== 'string' || typeof id !== 'string' || parent === '' || id === '') {
        return;
      }
      // 只登记「本引擎活跃实例」的子会话；别的实例/DSH 自己的会话不登记（故其消息仍放行）。
      if (!this.instances.has(parent)) {
        return;
      }
      const children = this.hostChildSessions.get(parent) ?? new Set<string>();
      children.add(id);
      this.hostChildSessions.set(parent, children);
    }) as unknown as (settlement: SubagentSettlement) => void;
    this.ctx.on('session/created' as 'sandore/subagent-settled', handler, { global: true });
  }

  /**
   * 宿主会话 turn 中断监听（架构决策 6：DSH 输入框「停止生成」→ 工作流暂停）。
   *
   * **DSH 语义（查证依据，非本插件定义）**：输入框那个按钮是 `input.stop` =「停止生成」，
   * client 侧 `InputMachine.onRelease`（DSH 源码
   * `packages/client/ui-conversation/src/client/input/machine.ts:226-236`）abort 本次
   * 发送；不挂子代理地址时会话级动作走 `session.cancel` RPC → `SessionCommandController.cancel`
   * （`packages/api/session-controller/src/commands.ts:434-448`）→ `agent.cancel({kind:'user'},
   * {keepInbox:true})`——即 DSH **只是中止当前 turn，没有「暂停会话」能力**。
   *
   * **本插件附加的语义**（任务书决策 6）：把「宿主会话 turn 被用户中断」解释为
   * 「暂停本工作流实例」，走既有 pause 路径（`pauseAllSteps` → interrupt 运行中
   * Step 子代理 → 主循环 parked 在 paused）。可观测信号是 DSH `session/event`
   * 生命周期事件（`packages/core/session/src/index.ts:74`）中宿主会话的 `turn/end`
   * 且 `reason.kind === 'aborted'` 且 `reason.reason.kind === 'user'`
   * （`packages/core/session/src/types.ts:181-196`）——`user` 才是「用户点了停止生成」，
   * `parent`/`disposed`/`hook` 等其他原因不触发暂停。
   *
   * 恢复由主代理调 `sandore_workflow_control(action:'continue')`（或 UI 既有 resume）。
   */
  private registerHostTurnAbortWatcher(): void {
    const handler = (session: { readonly id?: SessionId }, event: HostSessionEventLike): void => {
      if (event.type !== 'turn/end') {
        return;
      }
      const reason = event.data?.reason;
      if (reason?.kind !== 'aborted' || reason.reason?.kind !== 'user') {
        return;
      }
      const sessionId = typeof session.id === 'string' ? session.id : undefined;
      if (sessionId === undefined) {
        return;
      }
      const active = this.instances.get(sessionId);
      if (active === undefined || TERMINAL_STATUSES.has(active.state.status)) {
        return;
      }
      try {
        active.lifecycle.pauseAllSteps();
      } catch (error) {
        // 暂停登记表为空（无运行中 Step）时 pauseAllSteps 是无害 no-op；此处只兜住
        // 意外抛错，不影响宿主会话自身的中断语义。
        this.ctx.logger.warn(`sandore: pause on host turn abort failed: ${renderError(error)}`);
      }
    };
    this.ctx.on('session/event' as 'sandore/subagent-settled', handler as unknown as (settlement: SubagentSettlement) => void);
  }

  /**
   * 实例进入终态时唤醒宿主会话一次（架构决策 2 的配套闭环）。
   *
   * 为什么需要：Step 子代理的结算通知被 {@link registerHostSessionNoticeFilter} park 掉
   * 之后，宿主主代理不会自动知道实例结束了，也就无法按注入的协作规则「结束后读取结果
   * 并汇报给用户」。故引擎在实例落终态时主动投一条汇总。
   *
   * **唤醒语义（2026-09 修订，用户要求对齐 DSH）**：投递按宿主**状态分流**——
   * 空闲走 `followup`（DSH `Agent.followup` = 「排入 next-turn 并唤醒驱动」，
   * `agent-loop/src/agent.ts:131-133`）→ 开一个新 turn（终态汇报必须靠这次唤醒）；
   * **正忙走 `steer`**（`agent.ts:135-137` = 「排入 next-step」）→ 并进**当前 turn** 的
   * 下一步，不再多造一个 turn（也就不再产生那一类空 turn）。
   * 这正是 DSH 自己投递结算通知的口径：`continuation.ts:1574-1577`
   * 「`if (parent.status === 'idle') parent.followup(message) else parent.steer(message)`」，
   * 注释原文「A busy parent is steered instead of woken: … several children settling
   * together cost one step rather than one turn each.」——原实现无条件 followup，
   * 宿主忙时消息会一直等到下一个 turn（`Inbox.claim(target, turn)` 只在 turn 边界取
   * next-turn 队列，`core/agent/src/inbox.ts:71-78`），既多造 turn 又与 DSH 不一致。
   *
   * 若希望连这一次也不唤醒（主代理只在用户消息/自身工具调用时醒），把 `followup` 换成
   * `inject`（`agent.ts:139-141`：同队列但不唤醒，消息在下次唤醒时由 `Inbox.claim` 一并取走）
   * ——决策 2 的验收口径要求「终态那一次放行、让主代理被唤醒一次去汇报结果」，故空闲时仍取
   * followup。
   *
   * source 用 {@link buildHostContextSource}（DSH 上下文注入形态）：客户端按
   * `source.kind !== 'user'` 把消息渲染成**左侧「上下文注入」行**而不是右侧用户气泡
   * （契约与证据见 host-context.ts 的 `HostContextSource` 文档）。唤醒语义不变（由投递
   * API 决定，与 source 无关）；本引擎的 park 判据只认「`senderSessionId` 属本实例子代理」
   * 的消息，注入消息不带该字段故不会被误 park。
   */
  private notifyHostTerminal(active: ActiveInstance, status: 'completed' | 'failed' | 'aborted'): void {
    const workflowName = active.state.workflowName ?? active.state.workflowId;
    try {
      this.deliverToHost(active.hostAgent, createUserMessage({
        source: hostContextSource(`工作流「${workflowName}」已结束（status=${status}）`),
        content: [{
          type: 'text',
          text: `[sandore 工作流] 实例 ${active.state.taskId}（工作流「${workflowName}」）`
            + `已结束，status=${status}。请调用 sandore_workflow_status 读取结果并汇报给用户。`,
        }],
      }));
    } catch (error) {
      this.ctx.logger.warn(`sandore: host terminal notice failed: ${renderError(error)}`);
    }
  }

  /**
   * 宿主投递的**唯一通道**：空闲 → `followup`（唤醒、开新 turn），正忙 → `steer`（并进
   * 当前 turn 的下一步）。与 DSH `SubagentContinuationManager.notifySettlement` 同口径
   * （`continuation.ts:1574-1577`），理由见 {@link notifyHostTerminal} 的注释。
   * @param hostAgent - 宿主主代理（本实例的 hostAgent）。
   * @param message - 待投递消息（source 决定客户端的呈现形态）。
   */
  private deliverToHost(hostAgent: Agent, message: UserMessage): void {
    if (hostAgent.status === 'idle') {
      hostAgent.followup(message);
      return;
    }
    hostAgent.steer(message);
  }

  /** 发射 `sandore/subagent-settled` 事件（与 mock `FakeSubagents.emitSettlement` 同形：unscoped dispatch）。 */
  private emitSubagentSettled(settlement: SubagentSettlement): void {
    for (const callback of this.ctx.events.dispatch('emit', ['sandore/subagent-settled', settlement])) {
      try {
        const returned: unknown = callback(settlement);
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`sandore: sandore/subagent-settled listener rejected: ${renderError(error)}`);
        });
      } catch (error) {
        this.ctx.logger.warn(`sandore: sandore/subagent-settled listener threw: ${renderError(error)}`);
      }
    }
  }

  /**
   * 启动实例（入口归一的**第一阶段**：新建真实顶层会话 + 绑定 + 注入协作上下文）。
   *
   * 流程（架构决策 1）：读定义 → parse → 生成 instanceId → **新建真实顶层会话**
   * （`ctx.agents.create(SessionId(instanceId))`，会话 id 恒等于实例 id）→ 应用标题/
   * 权限/workspace → 建 pending 快照并登记 → **注入协作上下文**（架构决策 4，经
   * `hostAgent.followup` 唤醒宿主会话）→ 返回 `{instanceId, status:'pending'}`。
   *
   * **本方法不再执行工作流**：唯一启动入口是 `sandore_workflow_run`
   * （{@link runInstanceInSession}），由新建出来的那个真实会话调用——正是这一步让
   * 恒等式 `hostAgent.id ≡ 宿主会话 id ≡ instanceId ≡ 调用会话` 成立。
   *
   * @param request - 启动请求（不含宿主会话 id：宿主会话由本方法新建，见 DagStartRequest）。
   * @returns `{instanceId, status:'pending'}`（执行在宿主会话调用 run 后开始）。
   */
  async startInstance(request: DagStartRequest): Promise<DagRun> {
    const persistence = this.persistence();
    if (persistence === undefined) {
      throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION');
    }
    const record = persistence.definitions.get(request.workflowId);
    if (record === undefined) {
      throw new SandoreError(`definition '${request.workflowId}' not found`, 'NODE_NOT_FOUND');
    }
    const definition = parseWorkflowYaml(record.yaml);
    const instanceId = makeInstanceId();
    const createdAt = now();
    const cwd = request.cwd;
    // 宿主会话 id ≡ 实例 id（恒等式，架构决策 1）：不再有 hostSessionId 入参与
    // 「复用 / 新建」分流，本方法恒新建真实顶层会话。
    const hostSessionId = instanceId;
    const state = makeInitialState({ instanceId, request, definition, createdAt, cwd, status: 'pending' });
    const controller = new AbortController();
    // §3.0 宿主主代理 = 纯 DSH 默认主代理：setup 只挂默认 preset（系统提示词/skills/
    // 工具全进来）+ 装 agent-scoped 模型选择，不注册 sandore 工具、不注入角色提示词。
    // `meta.agentPreset` 须在 create 前 resolve（会话边界在 setup 前快照 meta）——对齐
    // apiproxy composeAgent：先 resolve 得 resolvedId，再传 meta + setup 内 mount。
    // presets 服务缺失时跳过。
    const presets = this.ctx.get('agentPresets') as AgentPresetsSeam | undefined;
    const resolvedPresetId = presets === undefined ? undefined : (await presets.resolve())?.id;
    const selectionDeps = this.hostModelSelectionDeps();
    // 宿主会话的模型路由（`AgentOptions`）：不加这一项，宿主会话的 turn 会在 DSH
    // `agent-loop/agent.ts:483-485` 的「no provider/model」检查处直接失败（错误被 loop
    // 归一为 turn 级 error，不进 stderr），表现为「实例永远 pending、一次模型调用都没有」。
    const hostAgentOptions = resolveHostAgentOptions(selectionDeps);
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(instanceId),
      meta: {
        cwd,
        ...(resolvedPresetId === undefined ? {} : { agentPreset: resolvedPresetId }),
      },
      ...(hostAgentOptions === undefined ? {} : { agentOptions: hostAgentOptions }),
      setup: createHostAgentSetup({
        instanceId,
        ...selectionDeps,
        ...(presets === undefined ? {} : { presets }),
      }),
    });
    const hostAgent = handle.agent;
    // agents.create 已把宿主 Session 发布进 ctx.sessions，此处读回 live 会话供宿主
    // 会话身份使用（sandbox/mode append、sessionTitle、workspace attach）。
    const createdSession = this.ctx.sessions.get(SessionId(instanceId));
    if (createdSession === undefined) {
      throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
    }
    const session = createdSession;
    // 补设宿主会话标题 = 用户输入的需求（originalInput，对齐「宿主会话承载本工作流
    // 需求」语义）；rename 失败仅记录 warn，不得使 startInstance 失败或中断实例执行。
    try {
      this.ctx.sessionTitle.rename(session, request.originalInput);
    } catch (error) {
      this.ctx.logger.warn(`sandore: set host session title failed: ${renderError(error)}`);
    }
    // 宿主主代理 attach 到 web workspace（子代理获得正确 durable parent，web sidebar
    // 可见 / 暂停走 subagents.interrupt / ask 可答）。
    await this.attachHostAgentToWorkspace(hostAgent, cwd);
    // 创建实例时选择的权限预设（弹窗传入）：宿主会话 sandbox 模式 + 审批策略，
    // 在注入上下文前应用（shell/子代理继承宿主会话权限）。
    if (request.permission !== undefined) {
      this.applyPermission(session, hostAgent, request.permission);
    }
    const active = this.buildActiveInstance(controller, session, hostAgent, definition, state);
    this.instances.set(instanceId, active);
    await this.persistState(active);
    // 架构决策 4：把协作上下文注入宿主主代理（唤醒它去调用 sandore_workflow_run）。
    this.injectHostContext(active);
    return { instanceId, status: 'pending' };
  }

  /**
   * 启动实例（入口归一的**第二阶段 / 唯一启动入口**）：在调用方会话内拉起工作流。
   *
   * 两条路径在此汇合（恒等式 `hostAgent.id ≡ 宿主会话 id ≡ instanceId ≡ 调用会话`）：
   * - **overlay 新建**：`startInstance` 已用同一 id 建好宿主会话 + pending 实例，
   *   宿主主代理按注入的协作规则调用 run → 本方法发现 pending 实例 → 直接开跑
   *   （以 pending 请求为准；run 入参只校验 `workflowId` 一致）。
   * - **已知会话拉起**：用户在某个真实顶层会话里让主代理调 run → 该会话本身成为宿主
   *   （不新建会话），instanceId = 调用会话 id。
   *
   * 终态实例所在的会话可以再次 run（视为该会话的新实例，覆盖同 id 槽位）；**非终态**
   * 已有实例时拒绝（架构决策 5：同一任务结束前不要重复调用 run）。
   *
   * @param hostSessionId - 调用方（宿主）会话 id。
   * @param request - 启动请求（run 工具入参装配）。
   * @returns `{instanceId, status:'running'}`。
   */
  async runInstanceInSession(hostSessionId: string, request: DagStartRequest): Promise<DagRun> {
    const persistence = this.persistence();
    if (persistence === undefined) {
      throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION');
    }
    const existing = this.instances.get(hostSessionId);
    if (existing !== undefined && !TERMINAL_STATUSES.has(existing.state.status) && existing.state.status !== 'pending') {
      throw new SandoreError(
        `session '${hostSessionId}' already hosts a non-terminal instance '${hostSessionId}' (status '${existing.state.status}'); `
          + 'do not call sandore_workflow_run again before it ends',
        'INVALID_OPERATION',
      );
    }
    if (existing !== undefined && existing.state.status === 'pending') {
      // overlay 新建路径：pending 请求为权威（弹窗里选的 cwd/model/permission 不因
      // 模型复述 run 入参而丢失），run 入参只做 workflowId 一致性校验。
      if (existing.state.workflowId !== request.workflowId) {
        throw new SandoreError(
          `instance '${hostSessionId}' was created for workflow '${existing.state.workflowId}', `
            + `not '${request.workflowId}'`,
          'INVALID_OPERATION',
        );
      }
      existing.state = { ...existing.state, status: 'running', updatedAt: now() };
      await this.persistState(existing);
      void this.execute(hostSessionId);
      return { instanceId: hostSessionId, status: 'running' };
    }
    // 已知会话路径（或终态复用）：以调用者会话为宿主，instanceId ≡ 该会话 id。
    // 终态复用会覆盖同槽位的旧 ActiveInstance → 先撤销它的 settle 监听器（防泄漏；
    // 旧实例已终结，其 awaiter 早已解开）。
    if (existing !== undefined) {
      existing.disposeSettlementListener();
    }
    const record = persistence.definitions.get(request.workflowId);
    if (record === undefined) {
      throw new SandoreError(`definition '${request.workflowId}' not found`, 'NODE_NOT_FOUND');
    }
    const definition = parseWorkflowYaml(record.yaml);
    const hostAgent = this.ctx.agents.get(SessionId(hostSessionId));
    if (hostAgent === undefined) {
      throw new SandoreError(`host agent session '${hostSessionId}' not found`, 'NODE_NOT_FOUND');
    }
    const session = this.ctx.sessions.get(SessionId(hostSessionId));
    if (session === undefined) {
      throw new SandoreError(`host session '${hostSessionId}' was not published`, 'INVALID_OPERATION');
    }
    const createdAt = now();
    const state = makeInitialState({
      instanceId: hostSessionId,
      request,
      definition,
      createdAt,
      cwd: request.cwd,
      status: 'running',
    });
    if (request.permission !== undefined) {
      this.applyPermission(session, hostAgent, request.permission);
    }
    const active = this.buildActiveInstance(new AbortController(), session, hostAgent, definition, state);
    this.instances.set(hostSessionId, active);
    await this.persistState(active);
    void this.execute(hostSessionId);
    return { instanceId: hostSessionId, status: 'running' };
  }

  /**
   * 建**引擎自有的子代理会话**（评估/路由 fork、重试 fork）——并补写 DSH 的子代理身份。
   *
   * 两条职责：
   * 1. 调 `ctx.agents.create`（`descriptorLabel` 是本仓库给引擎用的字段，**必须剥掉**再
   *    透传，DSH 只认它自己声明的 create 选项）；
   * 2. 创建后补写 `subagent/descriptor`（见 {@link ensureSubagentDescriptor}）。
   *
   * 为什么必须补：这些会话带 `origin:'subagent'` 头但不经 DSH subagent provider 建立，
   * 缺身份事件时子代理列表会把它们显示成**「会话记录损坏」**（真机缺陷：每个 step 下面
   * 多一个 uuid 形态的损坏项）。补写后列表显示为正常条目，标签是可读文本。
   * @param options - create 选项（含可选的 `descriptorLabel`）。
   * @returns 子代理句柄。
   */
  private async createChildAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    const { descriptorLabel, ...rest } = options;
    const handle = await this.ctx.agents.create(rest);
    try {
      ensureSubagentDescriptor(this.ctx, handle.agent.id, descriptorLabel);
    } catch (error) {
      // 身份补写失败不得影响子代理本身（列表项退化为「损坏」优于评估流程失败）。
      this.ctx.logger.warn(`sandore: subagent descriptor seeding failed for '${handle.agent.id}': ${renderError(error)}`);
    }
    return handle;
  }

  /**
   * 反查某会话当前绑定的实例 id（恒等于会话 id；`sandore_workflow_status` 的
   * `instanceId` 省略路径用）。终态实例仍在表中（getState 兜底可读），故一并返回。
   *
   * 内存未命中时回退扫 state 表（进程重启后内存未重建、但快照仍在的场景）。
   */
  private findInstanceIdByHostSession(hostSessionId: string): string | undefined {
    if (this.instances.has(hostSessionId)) {
      return hostSessionId;
    }
    return this.persistence()?.state.get(hostSessionId) === undefined ? undefined : hostSessionId;
  }

  /**
   * 解析宿主会话模型选择的两个服务访问面（可选服务；缺失时为 undefined）。
   *
   * - `agentDefaultModel`：部署级默认模型（宿主会话 `AgentOptions` 与选择兜底的来源，
   *   对齐 DSH `api/session-controller/src/agent.ts:488-491`）；
   * - `sessionProjections`：读 `modelSelection` 投影（用户在会话里选的模型 → 宿主会话
   *   经 `installModelSelection` 生效，见 host-agent.ts）。
   *
   * 两者都不在 `inject` 列表里（可选依赖，`ctx.get` 缺席容忍），与 `agentPresets` 同款处理。
   */
  private hostModelSelectionDeps(): HostModelSelectionDeps {
    const defaults = this.ctx.get('agentDefaultModel') as AgentDefaultModelSeam | undefined;
    const projections = this.ctx.get('sessionProjections') as SessionProjectionsSeam | undefined;
    return {
      ...(defaults === undefined ? {} : { defaults }),
      ...(projections === undefined ? {} : { projections }),
    };
  }

  /**
   * 注入宿主主代理协作上下文（架构决策 4；文本见 {@link buildHostContextInjection}）。
   *
   * source 用 {@link hostContextSource}（DSH 上下文注入形态）：客户端按
   * `source.kind !== 'user'` 把它渲染成**左侧「上下文注入」行**，与终态通知同款；
   * 投递仍用 `followup`（= 唤醒宿主去调 `sandore_workflow_run`），唤醒语义不变。
   */
  private injectHostContext(active: ActiveInstance): void {
    const workflowName = active.state.workflowName ?? active.state.workflowId;
    const text = buildHostContextInjection({
      workflowId: active.state.workflowId,
      workflowName,
      originalInput: active.state.originalInput,
    });
    try {
      // 投递口径同 notifyHostTerminal：空闲 → followup（唤醒去调 run）、正忙 → steer
      // （并进当前 turn，不额外造 turn）。
      this.deliverToHost(active.hostAgent, createUserMessage({
        source: hostContextSource(`用户选择用工作流「${workflowName}」执行一个任务，请调用 sandore_workflow_run 启动`),
        content: [{ type: 'text', text }],
      }));
    } catch (error) {
      this.ctx.logger.warn(`sandore: host context injection failed: ${renderError(error)}`);
    }
  }

  /**
   * 应用创建实例时选择的权限预设：宿主会话 sandbox 模式（`sandbox/mode` 事件，
   * 对齐 `setSandboxMode`）+ 审批策略（`ctx.approval.setPolicy`）。失败仅记录 warn，
   * 不得使 startInstance 失败；shell/子代理在后续调用时折叠会话模式生效。
   */
  private applyPermission(session: Session, agent: Agent, permission: string): void {
    const spec = PERMISSION_SPECS[permission];
    if (spec === undefined) {
      this.ctx.logger.warn(`sandore: unknown permission preset '${permission}' ignored`);
      return;
    }
    try {
      // Round 25：内联窄断言（sandbox/mode 为 DSH known 事件，无需 ignorable 桥）。
      (session.append as (type: string, data: unknown) => unknown)('sandbox/mode', { mode: spec.sandbox });
    } catch (error) {
      this.ctx.logger.warn(`sandore: apply sandbox mode failed: ${renderError(error)}`);
    }
    try {
      const approval = this.ctx.get('approval') as
        | { setPolicy(agent: Agent, policy: string): void }
        | undefined;
      approval?.setPolicy(agent, spec.approval);
    } catch (error) {
      this.ctx.logger.warn(`sandore: apply approval policy failed: ${renderError(error)}`);
    }
  }

  /**
   * 宿主主代理 attach 到 web workspace（web sidebar 分组可见）。
   *
   * `ctx.workspaceRegistry` 缺失（测试/headless 部署无 workspace 包）时静默跳过；
   * `cwd` 未命中任何已登记 workspace 时自动注册（对齐 DSH `ensureWorkspace`：
   * resolveByPath 未命中 → create；create 内部会验证目录存在，cwd 为已存在目录
   * 时成功）——不再抛 INVALID_OPERATION；命中后 `workspace.attachSession` 把
   * hostAgent 会话挂到该 workspace 的成员账——子代理获得正确 durable parent
   * （hostAgent），web sidebar 可见、暂停走 `subagents.interrupt`（不撞
   * agent-busy fence）、ask 可答。
   */
  private async attachHostAgentToWorkspace(hostAgent: Agent, cwd: string): Promise<void> {
    const workspaceRegistry = this.ctx.get('workspaceRegistry') as WorkspaceRegistrySeam | undefined;
    if (workspaceRegistry === undefined) {
      // 测试/headless 部署无 workspace 包：静默跳过，不阻断实例启动。
      return;
    }
    let workspace = await workspaceRegistry.resolveByPath(cwd);
    if (workspace === undefined) {
      // 未命中已登记 workspace：自动注册（对齐 DSH ensureWorkspace 的未命中 create 语义）。
      workspace = await workspaceRegistry.create(cwd);
    }
    await workspace.attachSession(SessionId(hostAgent.id));
  }

  /**
   * 读运行中实例的内存 state（收尾阶段中间态立即可见；终态清表或未在内存返回 undefined）。
   *
   * 用于 `getInstanceState` RPC 的内存优先路径：commitFinalize 写入 currentPhase
   * 同步更新 `active.state` 引用，故收尾中间态（finalizing/gating/routing）在事件
   * 发出时已可从内存读到；持久化因 `buildFinalizeRequest` 未注入 `onPersist` 只在
   * 收尾全部结束后做一次，读持久化必然落后。
   */
  getInstanceState(instanceId: string): WorkflowTaskState | undefined {
    return this.instances.get(instanceId)?.state;
  }

  /**
   * **按需**为 state 里的执行段补上 `sessionMessages`（展示派生数据，不再持久化）。
   *
   * ## 为什么不再持久化
   * 实测（真机 12 个实例）：`executedSteps[].sessionMessages` 占 state 的 **41%–54%**
   * （最新实例 61,667 / 149,165 字节；另一实例 112,053 / 206,991），而它只是从
   * **step 子代理会话**（`sessionMeta.childId` 指向的 DSH 会话）派生的展示行——
   * 真值在会话里，state 里存的是副本。故 schema 与写入点已移除该字段。
   *
   * ## 兼容（不做破坏性迁移）
   * 消费面（`getInstanceState` RPC 的调用方：client 的 `chatLinesOf`、e2e 断言）仍按
   * 原字段名拿到同样的数据，但改由本方法**在读取时从会话现算**：live 会话优先，
   * live 已移除（子代理 settle 后 dispose）时回退 `sessionPersistence.inspect`。
   * 每段只取尾部 {@link HYDRATED_MESSAGES_LIMIT} 条（与原持久化截断一致）。
   *
   * 会话已不可读（未落盘 / 无 persistence / 事件为空）时该段不带 `sessionMessages`
   * （消费面本来就把缺省当「无消息行」，见 client `chatLinesOf` 的 undefined 分支）。
   * @param state - 待装饰的 state（返回**新对象**，不修改入参）。
   * @returns 带 `sessionMessages` 的 state（无段可补时原样返回入参）。
   */
  async hydrateStateMessages(state: WorkflowTaskState): Promise<WorkflowTaskState> {
    if (state.executedSteps.length === 0) return state;
    const steps = await Promise.all(state.executedSteps.map(async step => {
      const childId = step.sessionMeta?.childId;
      if (childId === undefined || childId === '') return step;
      const events = await this.readChildEvents(childId);
      if (events === undefined || events.length === 0) return step;
      const messages = collectSessionMessages(events);
      if (messages.length === 0) return step;
      return { ...step, sessionMessages: messages.slice(-HYDRATED_MESSAGES_LIMIT) } as typeof step;
    }));
    return { ...state, executedSteps: steps };
  }

  /**
   * 读某个子代理会话的完整事件（live 优先 → 持久化回退）。
   * @param childId - 子代理会话 id。
   * @returns 事件数组；两路都取不到时 undefined。
   */
  private async readChildEvents(childId: string): Promise<readonly SessionEvent[] | undefined> {
    const live = this.ctx.sessions.get(SessionId(childId));
    if (live !== undefined) {
      return live.snapshotEvents() as unknown as readonly SessionEvent[];
    }    const persistence = this.ctx.get('sessionPersistence') as
      | { inspect?: (id: string) => Promise<{ events: readonly SessionEvent[] } | undefined> }
      | undefined;
    if (persistence?.inspect === undefined) return undefined;
    try {
      const inspected = await persistence.inspect(childId);
      return inspected?.events;
    } catch {
      return undefined;
    }
  }

  /** 查询实例的当前状态快照（内存活跃实例优先，state 表兜底读）。 */
  getState(instanceId: string): DagInstanceState {
    const active = this.instances.get(instanceId);
    if (active !== undefined) {
      return toDagInstanceState(active.state);
    }
    // 内存未命中（如进程重启后）回退到持久化 state 表读回最后快照。
    const persisted = this.persistence()?.state.get(instanceId);
    if (persisted === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    return toDagInstanceState(persisted);
  }

  /**
   * 中止运行中的实例：置中止标志 → 登记表内全部子代理 interrupt（ancestor）→
   * {@link markAborted} 落 aborted 终态（保留持久化快照）+ 单发 `sandore/aborted`
   * → 清理内存 ActiveInstance（getState 退回 state 表仍可读到 aborted 快照）。
   *
   * 广播经 `markAborted` 的幂等单一出口：主循环 aborted 兜底分支同样调用它，
   * 故同一次中止恒只广播一次（详见 {@link markAborted}）。
   */
  async abortInstance(instanceId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      // 内存已清理（先前中止）：回退持久化 state 表判断终态，保持 INVALID_OPERATION 语义。
      const persisted = this.persistence()?.state.get(instanceId);
      if (persisted !== undefined && TERMINAL_STATUSES.has(persisted.status)) {
        throw new SandoreError(`instance '${instanceId}' is already in terminal state '${persisted.status}'`, 'INVALID_OPERATION');
      }
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(active.state.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
    }

    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };

    // 置中止标志（主循环观察到 signal.aborted 后退出）。
    active.controller.abort();
    // 中止传播：对暂停登记表内全部子代理执行 interrupt（ancestor authority）。
    for (const childId of active.lifecycle.pausedIds) {
      this.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: active.hostAgent });
    }
    // 中止落态 + 单发 `sandore/aborted`（幂等单一出口：主循环 aborted 兜底分支同样经
    // markAborted，故无论两路径以何序交错都只广播一次）。
    await this.markAborted(active, info);
    // 架构决策 2：宿主主代理不再冻结，中止路径无非冻结副作用；仅给宿主会话注入一条
    // 收尾通知（不唤醒——主代理下次被用户消息唤醒时读到，可据此汇报）。
    this.notifyHostTerminal(active, 'aborted');
    // 清理内存 ActiveInstance（保留持久化快照）+ 子会话登记表（实例已不在内存，
    // 不会再产生需要归属的唤醒）。
    this.instances.delete(instanceId);
    this.hostChildSessions.delete(instanceId);
  }

  /**
   * 中止落态 + 单发 `sandore/aborted`（**幂等单一出口**，所有中止路径都经此）。
   *
   * **为什么必须收敛到单一出口**：中止天然有多条路径——① {@link abortInstance} 显式
   * 路径（`controller.abort()` 后立即落态并广播）；② 主循环 aborted 兜底分支；③
   * `runAndCatch` 捕获到中止期异常（如宿主弹窗随 abort 取消 → ask waiter reject）的兜底。
   * ①与②交错时：`controller.abort()` 同步唤醒被 kill 的 shell/子代理 Step，它在①落态
   * 之后以 `aborted: true` 结算 → StepRunner 抛 `STEP_EXECUTION` → StageExecutor catch
   * 分支 `commitState({ status: 'failed' })` 把内存态**打回 failed**（stage-executor.ts
   * 失败分支 → 引擎 `commitState` 回调）→ ②原守卫 `status !== 'aborted'` 读到 failed
   * 而误判「尚未落态」→ 二次落态 + 二次广播（e2e F 层中止用例实测 2 次
   * `sandore/aborted` 的根因，探针实测兜底守卫观察到的 status 为 `failed`）。
   *
   * **幂等语义**：`active.abortedBroadcast` 一次性标记在第一处 `await` 之前**同步占用**
   * ——即使多条路径在持久化 await 窗口内并发进入，也只有先到者广播（后到者 `shouldBroadcast`
   * 为 false）。而**终态收敛每次都执行**（status='aborted' + 清空循环上下文 + 落盘）：
   * 中止期间的失败回写可能把内存态打成 failed，若不重新落态，`getState` 读到的持久化快照
   * 会停在错误的终态。中止路径**不发** `sandore/end`（②直接 return，③在中止态下不再
   * 走 failed 分支）。
   *
   * @param active - 运行中的实例（可能已清出 instances 表，仍可落盘/广播）。
   * @param info - `sandore/aborted` 的 `DagRunInfo`（taskId + workflowId）。
   */
  private async markAborted(active: ActiveInstance, info: DagRunInfo): Promise<void> {
    const shouldBroadcast = !active.abortedBroadcast;
    active.abortedBroadcast = true;
    active.state = {
      ...active.state,
      status: 'aborted',
      // 2026-08-25 real-e2e：终态统一清空循环上下文（幽灵循环帧清理）。
      activeLoopIterationStack: [],
      activeLoopStack: [],
      activeLoopNodeId: null,
      updatedAt: now(),
    };
    await this.persistState(active);
    if (shouldBroadcast) {
      this.emitAborted(info);
    }
  }

  /**
   * 恢复单个实例（崩溃恢复入口）。
   *
   * 对终态实例抛 `INVALID_OPERATION`；内存未命中时从持久化 state 表读回快照，经
   * `ctx.agents.resume` 冷恢复宿主主代理（setup 重跑）→ `recovery.recover()` 分类恢复
   * Step（running/interacting 子代理 followup 冷恢复、合成 session 标 failed）→ 重建
   * 登记表 → 重跑 `runInstance` 续跑，返回 `DagRun`。
   */
  async recoverInstance(instanceId: string): Promise<DagRun> {
    const existing = this.instances.get(instanceId);
    if (existing !== undefined) {
      if (TERMINAL_STATUSES.has(existing.state.status)) {
        throw new SandoreError(`instance '${instanceId}' is already in terminal state '${existing.state.status}'`, 'INVALID_OPERATION');
      }
      return { instanceId, status: existing.state.status };
    }
    const persistence = this.persistence();
    if (persistence === undefined) {
      throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION');
    }
    const snapshot = persistence.state.get(instanceId);
    if (snapshot === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(snapshot.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${snapshot.status}'`, 'INVALID_OPERATION');
    }
    const record = persistence.definitions.get(snapshot.workflowId);
    if (record === undefined) {
      throw new SandoreError(`definition '${snapshot.workflowId}' not found`, 'NODE_NOT_FOUND');
    }
    const definition = parseWorkflowYaml(record.yaml);
    const controller = new AbortController();
    // 宿主主代理恢复：入口归一后恒等式成立（hostAgent.id ≡ 宿主会话 id ≡ instanceId），
    // 故冷恢复唯一路径 = `agents.resume(SessionId(instanceId))`（重跑 setup：只挂默认
    // preset，保持冷恢复后能力一致）。旧的「复用调用方会话」分支已随 hostSessionId
    // 入参一并删除（架构决策 1）——不存在「instanceId 会话从未创建」的实例了。
    const presets = this.ctx.get('agentPresets') as AgentPresetsSeam | undefined;
    const selectionDeps = this.hostModelSelectionDeps();
    const hostAgentOptions = resolveHostAgentOptions(selectionDeps);
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(instanceId),
      ...(hostAgentOptions === undefined ? {} : { agentOptions: hostAgentOptions }),
      setup: createHostAgentSetup({
        instanceId,
        ...selectionDeps,
        ...(presets === undefined ? {} : { presets }),
      }),
    });
    const hostAgent = handle.agent;
    const createdSession = this.ctx.sessions.get(SessionId(instanceId));
    if (createdSession === undefined) {
      throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
    }
    const session = createdSession;
    // 崩溃恢复重建 hostAgent 后重新 attach 到快照 cwd 对应的 web workspace（与
    // startInstance 对齐；registry 缺失时静默跳过）。
    await this.attachHostAgentToWorkspace(hostAgent, snapshot.cwd);
    const active = this.buildActiveInstance(controller, session, hostAgent, definition, snapshot);
    this.instances.set(instanceId, active);
    // 清空快照残留 stale pendingInteractions（缺陷 9 B / 缺陷 27 崩溃恢复路径）：
    // InteractionManager 重建时 Maps 为空（不 hydrate），快照中的 ghost ask/permission
    // 条目会被 UI 复弹且 replyQuestion 抛 INVALID_OPERATION。clearAll 终态化 + 清空 +
    // syncState 重持久化空 pending（对齐基准 recover 步骤 B clearAll）。
    active.interactions.clearAll();
    await this.persistState(active);

    // pending 实例（overlay 新建后宿主会话尚未调用 run 就重启）：**保持 pending**，
    // 不自动执行——两阶段语义（架构决策 1）要求执行由宿主会话的 run 触发；重建进
    // 内存后，宿主会话随后的 `sandore_workflow_run` 仍能在同一槽位开跑。
    if (snapshot.status === 'pending') {
      return { instanceId, status: 'pending' };
    }

    // recover() 本体故障兜底（缺陷 11 并入 9）：followup 抛错等异常若传播出
    // recoverInstance，实例残留内存 running + 快照无 failed 落盘，二次 recoverInstance
    // no-op 卡 running。包 try/catch → catch 落 failed 终态 + emitEnd + 清内存（对齐
    // runAndCatch 语义）。runAndCatch 只覆盖续跑主循环，不覆盖 recover() 本体。
    let recoverResult: RecoverResult;
    try {
      recoverResult = await active.recovery.recover();
    } catch (error) {
      // recover() 本体故障：落 failed 终态 + emitEnd + 清内存（对齐 runAndCatch 语义）。
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      const failInfo: DagRunInfo = { taskId: active.state.taskId, workflowId: active.state.workflowId };
      this.emitEnd(failInfo, { taskId: active.state.taskId, status: 'failed', error: renderError(error) });
      this.notifyHostTerminal(active, 'failed');
      // 清内存：避免持有崩溃恢复期不一致的运行时对象；getState 兜底读快照（failed 终态）。
      this.instances.delete(instanceId);
      this.hostChildSessions.delete(instanceId);
      return { instanceId, status: 'failed' };
    }
    if (recoverResult.hasFailure) {
      // 合成 session（shell）失败：落 failed 终态 + emitEnd（缺陷 11 补充缺口一：
      // 原实现标 failed 但不 emitEnd，与 runAndCatch 不一致，前端收不到终态通知）。
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      const failInfo: DagRunInfo = { taskId: active.state.taskId, workflowId: active.state.workflowId };
      this.emitEnd(failInfo, { taskId: active.state.taskId, status: 'failed', error: 'unrecoverable synthetic session step' });
      this.notifyHostTerminal(active, 'failed');
      return { instanceId, status: 'failed' };
    }
    if (recoverResult.hasResume) {
      void this.resumeExecution(active);
      return { instanceId, status: 'running' };
    }
    // paused-only 实例：登记表已从 pausedChildIds 重建，保持 paused 等待手动 resume，不重跑。
    if (this.hasPausedStep(active)) {
      return { instanceId, status: active.state.status };
    }
    // 空 executedSteps / 纯 completed 非终态快照（startInstance 后、任何 Step 执行前崩溃）：
    // 真正重跑 runInstance 从 currentStageId 续跑（不永久 running）。
    active.state = { ...active.state, status: 'running', updatedAt: now() };
    await this.persistState(active);
    void this.resumeExecution(active);
    return { instanceId, status: 'running' };
  }

  /**
   * 孤儿实例启动扫描：遍历 state 表全部条目 → 跳过终态 → 逐个调用
   * `recoverInstance`。单实例失败不阻断（逐实例 try/catch），返回
   * `{ recovered, errors }`。
   */
  async recoverOrphanedInstances(): Promise<{
    recovered: string[];
    errors: Array<{ instanceId: string; error: string }>;
  }> {
    const recovered: string[] = [];
    const errors: Array<{ instanceId: string; error: string }> = [];
    const persistence = this.persistence();
    if (persistence === undefined) {
      return { recovered, errors };
    }
    for (const [instanceId, snapshot] of persistence.state.entries()) {
      if (TERMINAL_STATUSES.has(snapshot.status)) {
        continue;
      }
      try {
        await this.recoverInstance(instanceId);
        recovered.push(instanceId);
      } catch (error) {
        errors.push({ instanceId, error: renderError(error) });
      }
    }
    return { recovered, errors };
  }

  async replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    await active.interactions.replyQuestion(requestId, answers);
  }

  async replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    await active.interactions.replyPermission(requestId, reply);
  }

  /** 拒绝待处理问答（转发交互管理器；rejectQuestion 以 resolve 占位解挂 waiter，引擎 ask 调用处标 Step failed，缺陷 26）。 */
  async rejectQuestion(instanceId: string, requestId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    await active.interactions.rejectQuestion(requestId);
  }

  /**
   * 子代理 child-scope `ask_user_question` 工具的执行入口（双通道 ask **通道 1**）。
   *
   * 把子代理 turn 内的提问路由到**主会话**引擎级 ask（hostAgent 身份、UI 可见可答）：
   * 从 `subagent.session.header.parentSession`（= 宿主主代理会话 id）反查
   * ActiveInstance → 按 `subagent.id`（childId）反查 Step（`sessionMeta.childId`
   * 匹配，取最后活跃段）→ 构造 pending 条目 → `interactions.ask`（与引擎级 ask 闭环
   * 同一通道，registerPending + 单发 `sandore/question`）→ 返回答案。答案**不写
   * userMessages**（作为普通 tool result 进入子代理会话，时间轴由子代理会话承载）。
   *
   * 问答被拒（`rejectQuestion` 占位答案）抛 `STEP_EXECUTION`（子代理工具调用失败 →
   * 该 Step failed 语义，对齐缺陷 26 显式落态，不冒泡 runAndCatch）。
   *
   * @param subagent - 调用方子代理（`session.header.parentSession` = 宿主主代理会话
   *   id；`id` = childId）。
   * @param questions - 问题列表（DSH `AskUserQuestionItem` 驼峰形状，内部转蛇形载荷）。
   * @param signal - 可选取消信号。
   * @returns 用户整批回答（DSH `AskUserQuestionAnswer` 形状）。
   */
  async askFromSubagent(
    subagent: Agent,
    questions: readonly AskUserQuestionItem[],
    signal?: AbortSignal,
  ): Promise<AskUserQuestionAnswer> {
    const parentSession = subagent.session.header?.parentSession;
    if (parentSession === undefined) {
      throw new SandoreError(`subagent '${subagent.id}' has no parent session`, 'INVALID_OPERATION');
    }
    const active = [...this.instances.values()].find(instance => instance.hostAgent.id === parentSession);
    if (active === undefined) {
      throw new SandoreError(`no active sandore instance for parent session '${parentSession}'`, 'INVALID_OPERATION');
    }
    // 按 childId 反查 Step（sessionMeta.childId 匹配；段模型取最后匹配段）。
    const stepEntry = [...active.state.executedSteps].reverse()
      .find(entry => entry.sessionMeta?.childId === subagent.id);
    if (stepEntry === undefined) {
      throw new SandoreError(`step for subagent '${subagent.id}' not found`, 'INVALID_OPERATION');
    }
    // DSH AskUserQuestionItem（驼峰 multiSelect）→ 持久化条目载荷（蛇形 multi_select）。
    const payload: AskUserQuestionPayload = {
      questions: questions.map(question => ({
        id: question.id,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.options === undefined ? {} : { options: [...question.options] }),
        ...(question.multiSelect === undefined ? {} : { multi_select: question.multiSelect }),
      })),
    };
    const requestId = globalThis.crypto.randomUUID();
    const entry: PendingQuestionEntry = {
      id: requestId,
      stageId: stepEntry.stageId,
      stepId: stepEntry.stepId ?? stepEntry.id,
      sessionId: active.state.taskId,
      requestId,
      kind: 'question',
      status: 'pending',
      payload,
      createdAt: now(),
    };
    const answer = await active.interactions.ask({
      entry,
      ...(signal === undefined ? {} : { signal }),
    });
    if (isRejectedAnswer(answer)) {
      // 问答被拒（缺陷 26）：抛 STEP_EXECUTION → 子代理工具调用失败 → Step failed。
      throw new SandoreError(`question '${requestId}' rejected`, 'STEP_EXECUTION');
    }
    return answer;
  }

  /** 暂停单个 Step（委托生命周期协调器：反查 childId → interrupt → 登记表 → 状态 paused）。 */
  async pauseStep(instanceId: string, stepId: string): Promise<void> {
    const active = this.requireActive(instanceId);
    active.lifecycle.pauseStep(stepId);
  }

  /** 恢复单个 Step（委托生命周期协调器：反查 childId → 移出登记表 → followup → 状态 running）。 */
  async resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void> {
    const active = this.requireActive(instanceId);
    await active.lifecycle.resumeStep(stepId, resumePrompt);
    // 补充 37 SessionIdleWaiter 扩展：只唤醒目标 Step 的 waiter + '*' waiter（resumeAll 等待者）。
    this.notifyResume(active, stepId);
    this.notifyResume(active, '*');
  }

  /** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
  async pauseAllSteps(instanceId: string): Promise<void> {
    const active = this.requireActive(instanceId);
    active.lifecycle.pauseAllSteps();
  }

  /** 恢复登记表内全部 Step（逐个 followup 并清空登记表）。 */
  async resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void> {
    const active = this.requireActive(instanceId);
    // 唤醒落点必须与主循环的等待 key 同源（缺陷修复：恢复后实例停在 paused 的根因 B）。
    // 主循环 parked 时以 `pausedStep?.stepId ?? pausedStep?.id` 为 key 调 waitForResume
    // （见 runInstance 的 paused 分支），而 waitForResume 只消费**具体 stepId** 的同名标志。
    // 恢复手势若早于暂停落态到达（子代理 settle 慢于用户点击 → 主循环还没 parked），
    // 原来的「只置 `'*'`」标志不会被该 key 消费 → 唤醒被永久丢弃，实例停在 paused。
    // 故先按登记表内 childId 反查各 Step 的对外 stepId（与 lifecycle `childIdOf` 同一回退），
    // 恢复后对这些 key 逐个 notifyResume：已 parked → 直接唤醒；未 parked → 置同名标志。
    const resumedStepIds = active.lifecycle.pausedIds
      .map(childId => active.state.executedSteps.find(step => (step.sessionMeta?.childId ?? step.id) === childId))
      .map(step => step?.stepId ?? step?.id)
      .filter((stepId): stepId is string => stepId !== undefined);
    await active.lifecycle.resumeAllSteps(resumePrompt);
    for (const stepId of resumedStepIds) {
      this.notifyResume(active, stepId);
    }
    // 唤醒所有等待中的 waiter（每个 stepId key + '*' key）。
    for (const key of active.resumeWaiters.keys()) {
      this.notifyResume(active, key);
    }
    this.notifyResume(active, '*');
  }

  /** 重试单个 Step（continue/revert/fork 三模式，委托恢复协调器；revert 可选 revertBoundary）。 */
  async retryStep(instanceId: string, stepId: string, mode: RetryMode, message: string, revertBoundary?: number): Promise<void> {
    const active = this.requireActive(instanceId);
    await active.recovery.retryStep(stepId, mode, message, revertBoundary);
  }

  /** 列出某 Step 子代理会话中可用的闭合 turn 回退点候选（revert 回退点选择数据源）。 */
  listRevertBoundaries(instanceId: string, stepId: string): RevertBoundaryOption[] {
    const active = this.instances.get(instanceId);
    const state = active !== undefined ? active.state : this.persistence()?.state.get(instanceId);
    if (state === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    const step = state.executedSteps.find(item => item.stepId === stepId) ?? state.executedSteps.find(item => item.id === stepId);
    if (step === undefined) {
      throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
    }
    const childId = step.sessionMeta?.childId ?? synthesizeChildId(step.id);
    const child = this.ctx.sessions.get(SessionId(childId));
    if (child === undefined) {
      return [];
    }
    // 上游 dsh-session 0.1.2：Session.events 直读已删，经 snapshotEvents() 取全量快照。
    return listClosedTurnBoundaries(child.snapshotEvents());
  }

  /**
   * 向运行中实例的指定 Step 子代理追加一条用户 @mention 消息（缺陷 31）。
   *
   * 复用宿主 → 子代理 prompt 投递通道（上游 `ctx.subagents.followup` 已删，经
   * `createChildPromptDelivery` 的 queue 投递——独立 FIFO 轮次语义，已在 ask 回答
   * 闭环与 resumeStep/resumeAllSteps 链路使用）作为「向子代理会话追加消息并取回
   * 新回复」的现成能力。本方法仅做低成本封装：
   *
   * 1. requireActive（内存未命中抛 NODE_NOT_FOUND——子代理会话绑定内存 session）
   * 2. 终态守卫（终态实例抛 INVALID_OPERATION——无活子代理可收消息）
   * 3. 按 stepId 反查「最后活跃段」（running/interacting 中 attemptIndex 最大者；
   *    无活跃段时回退同 stepId 任意段，再退唯一执行 id——与 LifecycleManager.findStep
   *    同规则）；未找到抛 INVALID_OPERATION
   * 4. synthetic===false 才投递（synthetic 步骤——shell 合成 session
   *    无真实子代理——抛 INVALID_OPERATION，对齐 LifecycleManager.pauseStep 的
   *    非子代理守卫语义）
   * 4b. **状态门槛（P3）**：反查到的段必须是 running/interacting。旧实现没有这道闸，
   *    于是「暂停后直接发消息」会 ok 落进一个静止的子代理会话（工具描述却写着只接受
   *    running/interacting——描述与行为不符）。现在 paused/failed/completed 一律
   *    INVALID_OPERATION，错误信息给出**当前状态 + 建议动作**（可自纠）。
   * 5. 追加 userMessages `{kind:'message', target:stepId}`——**不复用 'input'**
   *    （SA8 核实：'input' 语义为原始需求/resume 输入，与讨论消息混淆会污染
   *    originalInput 语义；新增独立 kind:'message' 供时间轴区分渲染）
   * 6. persistState（落盘快照）
   * 7. 单发 `sandore/step-message`（Cordis emit → SSE，供 UI 刷新）
   *
   * 与 rejectQuestion（缺陷 26）/clearPendingInteractions（缺陷 9 #27）/retryStep
   * （缺陷 8 revertBoundary）/setPermissionMode（缺陷 29）是不同方法，互不影响：
   * 本方法不触碰 pendingInteractions 登记表、不 fork/revert 会话、不改 sandbox 模式。
   */
  async sendStepMessage(instanceId: string, stepId: string, message: string): Promise<void> {
    const active = this.requireActive(instanceId);
    if (TERMINAL_STATUSES.has(active.state.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
    }
    const step = this.findStepForMessage(active.state.executedSteps, stepId);
    if (step === undefined) {
      throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
    }
    const sessionMeta = step.sessionMeta;
    if (sessionMeta === undefined || sessionMeta.synthetic) {
      throw new SandoreError(
        `step '${stepId}' is a non-subagent step and cannot receive messages`,
        'INVALID_OPERATION',
      );
    }
    // 状态门槛（P3，与工具描述同口径）：只有 running/interacting 的子代理段可收消息。
    // 放在非子代理守卫**之后**：shell 段的结构性错误依然报「非子代理」（更精确）。
    if (!MESSAGEABLE_STEP_STATUSES.has(step.status)) {
      throw new SandoreError(
        `step '${stepId}' is in status '${step.status}' and cannot receive messages`
        + `（仅 running/interacting 的子代理 Step 可收消息）${messageableSuggestion(step.status)}`,
        'INVALID_OPERATION',
      );
    }
    const childId = sessionMeta.childId;
    if (childId === undefined) {
      // synthetic===false 的真实子代理段必然携带真实 childId（2026-09-09 起先拉起
      // 子代理再落 id）；此处仅为类型收窄 + 防御旧持久化数据。
      throw new SandoreError(`step '${stepId}' has no child session id`, 'INVALID_OPERATION');
    }
    // queue 投递（独立 FIFO 轮次语义，等价旧 subagents.followup；上游已删 followup）。
    await this.deliverChildPrompt(active.hostAgent, childId, [{ type: 'text', text: message }], active.controller.signal);
    // 投递**不写 state**（用户要求：讨论页只展示 step agent 消息与主代理消息）。
    // 该消息本身已经落在**子代理会话**里（= 该 step 面板自己那条「step agent 消息」），
    // 再往 `state.userMessages` 记一条只会把它重复搬进 discussion 时间轴。
    // 投递凭据仍有两处可对账：本工具返回的 `data.delivered`，以及下面的
    // `sandore/step-message` 单发事件（SSE）。
    this.emitStepMessage(
      { taskId: active.state.taskId, workflowId: active.state.workflowId },
      step.stepId ?? step.id,
      childId,
      message,
      step.name,
    );
  }

  /**
   * 运行中切换实例权限模式（缺陷 29）。
   *
   * 取内存 ActiveInstance → 终态守卫 → 复用 {@link applyPermission} 对宿主 session
   * + hostAgent 重新应用 sandbox 模式 + 审批策略（DSH 折叠读取，下次受限调用即
   * 生效）→ 同步 state.permission 并持久化。终态实例抛 INVALID_OPERATION；内存
   * 未命中（无 ActiveInstance）抛 NODE_NOT_FOUND（权限原语绑定内存 session，
   * 孤儿实例须先 recoverInstance 恢复进内存方可切换）。
   *
   * **子代理快照语义（架构差异，非缺陷）**：sandore Step 以子代理运行
   * （`subagents.startContinuable` parent=宿主），委派时快照宿主 sandbox+approval。
   * 故本切换对**宿主会话**与**切换后新委派的 Step** 即时生效，但**已运行 Step
   * 子代理保持其委派时的权限快照**——与基准「StepRunner 闭包每次权限请求读最新
   * 值」语义不同。详见 workflow-engine.spec.ts 子代理快照契约测试。
   */
  async setPermissionMode(instanceId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(active.state.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
    }
    // 复用 applyPermission（可重入：每次 append sandbox/mode 事件 + setPolicy，
    // DSH 折叠读取取最新值，幂等重放不累积副作用）。对宿主 session + hostAgent
    // 重新应用 → 下次受限调用（shell/新委派 Step）即按新模式判定。
    this.applyPermission(active.session, active.hostAgent, mode);
    // 同步快照 permission 字段并持久化：UI 列表/详情可读当前权限；recoverInstance
    // 虽靠 session 事件重放恢复权限，但快照字段保持一致避免漂移。
    active.state = { ...active.state, permission: mode, updatedAt: now() };
    await this.persistState(active);
  }

  // ── 执行主体 ─────────────────────────────────────────────────────────────

  private async execute(instanceId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      return;
    }
    await this.runAndCatch(active, false);
  }

  /** 重试/恢复后的续跑执行（复用 runInstance 主循环，从快照续跑，不重发 start）。 */
  private async resumeExecution(active: ActiveInstance): Promise<void> {
    await this.runAndCatch(active, true);
  }

  /** 运行主循环并兜底引擎级故障为 failed 终态。 */
  private async runAndCatch(active: ActiveInstance, isResume: boolean): Promise<void> {
    try {
      await this.runInstance(active, isResume);
    } catch (error) {
      // 中止触发的异常（第三条中止路径）：中止期间冒泡的异常多由 abort 本身引起
      // （如实例中止 → DSH 弹窗取消 → `userQuestions.ask` reject → interaction-manager
      // `failQuestion` 拒绝引擎 waiter → 异常穿出 runInstance）。此时**不得**落 failed、
      // **不得**发 `sandore/end`：中止终态与广播统一由 markAborted 幂等出口收口
      // （已广播则只补落态），否则中止路径会同时出现 `sandore/aborted` + `sandore/end`
      // 且终态快照被 failed 覆盖（中止契约破裂）。
      if (active.controller.signal.aborted) {
        await this.markAborted(active, {
          taskId: active.state.taskId,
          workflowId: active.state.workflowId,
        });
        return;
      }
      // 引擎级意外故障（非 Step 失败）：响亮落为 failed 终态。
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      const info: DagRunInfo = {
        taskId: active.state.taskId,
        workflowId: active.state.workflowId,
      };
      this.emitEnd(info, {
        taskId: active.state.taskId,
        status: 'failed',
        error: renderError(error),
      });
      this.notifyHostTerminal(active, 'failed');
    }
  }

  private async runInstance(active: ActiveInstance, isResume = false): Promise<void> {
    const { controller, hostAgent, definition } = active;
    const signal = controller.signal;
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };

    if (!isResume) {
      active.state = { ...active.state, status: 'running', updatedAt: now() };
      await this.persistState(active);
      this.emitStart(info);
    }

    const runnerConfig = this.runnerConfig(definition, hostAgent, active);
    // 全局 Step 级并发上限器（缺陷 10 队列驱动真并发改造）：workflow 读
    // maxConcurrentSteps 配置 → 创建 limiter → 注入每个 StageExecutor。多个并行
    // StageExecutor 共享同一个 limiter → 全局 Step 并发 ≤ maxConcurrentSteps。
    // maxConcurrentSteps=0 时无上限（UnlimitedLimiter）。
    const concurrencyLimiter = createConcurrencyLimiter(this.config.maxConcurrentSteps ?? 0);
    // Stage 级导航器（Stage 节点图 + Stage 契约 + Stage→Stage 推进 + Stage 级条件评估）；
    // Step 路由/循环已归 microflow StepNavigator（每 Stage 新建）。
    const navigator = new WorkflowDagNavigator(
      definition,
      this.ctx,
      runnerConfig,
      active.state.cwd,
      { currentStageId: this.resumeStageId(active), stageContracts: active.state.stageContracts },
    );
    const finalizeManager = new FinalizeManager(this.ctx, {
      ...runnerConfig,
      // 收尾真 fork（Phase B assessForked）：宿主主代理的子代理经 `agents.create` 从
      // step 子代理完整事件（live → 持久化 inspect）重建。
      ...(runnerConfig.hostAgent === undefined ? {} : { hostAgentId: runnerConfig.hostAgent.id }),
      // secondary 门禁 startContinuable 的 request.parent（宿主主代理 Agent 对象）。
      ...(runnerConfig.hostAgent === undefined ? {} : { hostAgent: runnerConfig.hostAgent }),
      // secondary 门禁 settle 终态等待（经 sandore/subagent-settled 事件路由）。
      ...(runnerConfig.awaitSubagentSettlement === undefined ? {} : { awaitSubagentSettlement: runnerConfig.awaitSubagentSettlement }),
      // secondary 门禁 startContinuable 的 DSH subagent provider 注册名（缺省 'fork'）。
      ...(runnerConfig.subagentProvider === undefined ? {} : { subagentProvider: runnerConfig.subagentProvider }),
      // secondary 门禁纠正重试的宿主投递通道（上游 followup 已删；[Service.init] 期解析）。
      ...(this.childDelivery === undefined ? {} : { deliverChildPrompt: this.childDelivery }),
      createAgent: options => this.createChildAgent(options),
      getStepSessionEvents: async childId => {
        // live → 持久化回退：子代理 settle 后 live store 已移除，从 sessionPersistence
        // inspect 读完整事件（对齐 DSH `inspectApiRemoteSession` 的持久化读路径）。
        // 上游 dsh-session 0.1.2：Session.events 直读已删，经 snapshotEvents() 取全量。
        const live = this.ctx.sessions.get(SessionId(childId));
        if (live !== undefined) {
          return [...live.snapshotEvents()];
        }
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
          return undefined;
        }
        try {
          const inspected = await persistence.inspect?.(childId);
          return inspected === undefined ? undefined : [...inspected.events];
        } catch {
          return undefined;
        }
      },
    });
    // Phase D 路由判断（分支/循环）共用的 fork 子代理配置（agents.create + 事件回退），
    // 与 FinalizeManager 同一来源（runnerConfig.hostAgent.id + ctx.agents.create）。
    const routingForkConfig = {
      ...(runnerConfig.hostAgent === undefined ? {} : { hostAgentId: runnerConfig.hostAgent.id }),
      // 与 hostAgentId 成对显式出现（不依赖 spread 隐式保留）：Phase D 路由 fork 子代理
      // setup 经 `agentPresets.composeFrom` 组合宿主主代理 preset（继承工具集 + prompt
      // sections，对齐 DSH `applyChildComposition`——scope-local 工具注册不自动继承 parent）。
      ...(runnerConfig.hostAgent === undefined ? {} : { hostAgent: runnerConfig.hostAgent }),
      createAgent: (options: CreateAgentOptions) => this.createChildAgent(options),
      getStepSessionEvents: async (childId: string) => {
        // 上游 dsh-session 0.1.2：Session.events 直读已删，经 snapshotEvents() 取全量。
        const live = this.ctx.sessions.get(SessionId(childId));
        if (live !== undefined) {
          return [...live.snapshotEvents()];
        }
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
          return undefined;
        }
        try {
          const inspected = await persistence.inspect?.(childId);
          return inspected === undefined ? undefined : [...inspected.events];
        } catch {
          return undefined;
        }
      },
    };
    let stageId = navigator.currentNodeId;

    while (stageId !== '') {
      const stage = definition.stages.find(item => item.id === stageId);
      if (stage === undefined) {
        break;
      }

      this.markStageStatus(active, stageId, 'running');
      await this.persistState(active);
      this.emitStageStart(info, stageId);

      // Step 级导航器（microflow 自有）：每 Stage 新建，持当前 Stage 的 Step 节点图 +
      // 循环管理器。LoopManager 经共享 `active.state` 的循环栈数组实现续跑状态连续
      // （崩溃恢复快照播种一致；循环计数语义不变——缺陷 3 不动）。注入 Phase D 路由
      // fork 子代理配置（hostAgentId/createAgent/getStepSessionEvents）。
      const stepNavigator = new StepNavigator(
        this.ctx,
        { ...runnerConfig, ...routingForkConfig },
        { activeLoopStack: active.state.activeLoopStack, activeLoopIterationStack: active.state.activeLoopIterationStack },
        stage,
        definition,
      );
      const loopManager = stepNavigator.loopManagerInstance;
      /** 当前循环迭代路径（无活跃循环时省略，供 step-* 事件 payload 使用）。 */
      const currentLoopIteration = (): number[] | undefined => {
        const path = loopManager.buildLoopIterationPath();
        return path.length > 0 ? path : undefined;
      };

      const hooks: StageStepHooks = {
        onStepStart: (step, childId) => this.emitStepStart(info, step.id, childId, step.name ?? step.id, currentLoopIteration()),
        onStepCompleted: (step, childId, output) => this.emitStepCompleted(info, step.id, childId, output, step.name ?? step.id, currentLoopIteration()),
        onStepFailed: (step, childId, error) => this.emitStepFailed(info, step.id, childId, error, step.name ?? step.id, currentLoopIteration()),
        // 收尾阶段流转：commitFinalize 写入 currentPhase 后单发 sandore/step-phase，
        // 供 UI 经 SSE 即时刷新（2026-09-09：shell 无 childId，事件直接带 undefined，
        // 不再回退 step.id——childId 只承载真实子代理会话 id）。
        onPhaseChange: (step, childId, phase) => this.emitStepPhase(info, step.id, childId, phase, step.name ?? step.id, currentLoopIteration()),
      };

      const resumeFrom = this.resumeInfo(active, stage);

      const executor = new StageExecutor({
        ctx: this.ctx,
        stageDef: stage,
        workflowDef: definition,
        input: {
          originalInput: active.state.originalInput,
          contractArtifacts: navigator.getContractArtifacts(),
          passThroughVars: active.state.passThroughVars,
          // v7：跨 Stage 播种前置输出（每 step 最新段）——让「依赖前一个 Stage 的 step」
          // 的 inputFrom 声明能被解析；注入面仍由 inputFrom 决定（未声明不注入）。
          previousOutputs: previousOutputsFromExecutedSteps(active.state.executedSteps as unknown as readonly ExecutedStepDefault[]),
        },
        sharedState: {
          cwd: active.state.cwd,
          taskId: active.state.taskId,
        },
        runnerConfig,
        signal,
        hooks,
        loopManager,
        stepNavigator,
        finalizeManager,
        concurrencyLimiter,
        visitCounts: active.state.visitCounts,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        commitState: (patch) => {
          // 暂停落态以**生命周期登记表 + 未消费的 resume 手势**为权威（lifecycle
          // `commitPausedRegistry`（lifecycle-manager.ts:208-217）/ `commitStepStatus` 即按
          // `status = pausedChildIds.size > 0 ? 'paused' : 'running'` 判定）：执行器在
          // 「settle(aborted) → STEP_PAUSED」catch 分支里的 `{ status: 'paused' }` 回写
          // （stage-executor.ts:886 / :1407）可能晚于 resume 手势（`resumeAllSteps` 已清空
          // 登记表、写入 running，并留下未消费的 resume 通知）——若照样落 paused，
          // 恢复后的实例会被打回暂停态（e2e M5「恢复后仍 paused」根因 A，与 aborted 双发
          // 同属「落态被回写」类缺陷）。
          // 两个条件同时成立才视为被恢复手势接管的陈旧落态：**登记表为空**（无人被登记为
          // 暂停）且**存在未消费的 resume 通知**（手势先于落态到达）。无手势的中断
          // （子代理被外部取消）不改写语义——保留 paused，用户仍可经恢复动作解锁。
          const supersededPause = patch.status === 'paused'
            && active.lifecycle.pausedIds.length === 0
            && active.resumeRequested.size > 0;
          const status = supersededPause ? undefined : patch.status;
          active.state = {
            ...active.state,
            ...(status === undefined ? {} : { status }),
            ...(patch.errorDetail === undefined ? {} : { errorDetail: patch.errorDetail }),
            updatedAt: now(),
          };
        },
        onPersist: async (executed, pendingQueue) => {
          // 逐 Step 持久化：每个 Step 完成后立即追加/更新到 executedSteps 并落盘。
          // 按唯一执行 id upsert，避免 ask 回复续跑时同一 Step（running → completed）
          // 被重复追加；崩溃恢复时无需等待 Stage 结束即可读到已完成 Step 快照。
          // 缺陷 10 pendingQueue 持久化：snapshot ready/processing Step IDs →
          // WorkflowTaskState.pendingQueue → 崩溃恢复时直接读回 re-queue（精确重放，
          // 不再从 executedSteps 反推 DAG next）。
          const entry = executed as unknown as WorkflowTaskState['executedSteps'][number];
          // 不变量（2026-09-09，入口归一后更简单）：真实子代理段（childId 已定）持久化时
          // hostSessionId（parent）必须存在——UI 据此组 subagent-kind 地址打开内嵌会话。
          // 中间 meta 写手可能只带 childId/synthetic/command，此处按权威来源回填兜底：
          // 恒等式下宿主会话 id ≡ taskId（架构决策 1），不再有 `hostSessionId ?? taskId`。
          if (entry.sessionMeta !== undefined && entry.sessionMeta.childId !== undefined
            && entry.sessionMeta.hostSessionId === undefined) {
            entry.sessionMeta = {
              ...entry.sessionMeta,
              hostSessionId: active.state.taskId,
            };
          }
          const index = active.state.executedSteps.findIndex(item => item.id === entry.id);
          active.state = {
            ...active.state,
            executedSteps:
              index >= 0
                ? active.state.executedSteps.map((item, i) => (i === index ? entry : item))
                : [...active.state.executedSteps, entry],
            ...(pendingQueue === undefined ? {} : { pendingQueue: [...pendingQueue] }),
            updatedAt: now(),
          };
          // pause→完成竞态清理：interrupt 是软信号，子代理仍可能自然完成——若该 Step
          // 已 completed 而其 childId 仍在暂停登记表，移除登记（否则残留「段 completed +
          // 登记表有值」，resume 将卡死等待不存在的 paused Step）。
          if (entry.status === 'completed' && entry.sessionMeta?.synthetic === false
            && entry.sessionMeta.childId !== undefined) {
            active.lifecycle.clearPausedOnCompletion(entry.sessionMeta.childId);
          }
          await this.persistState(active);
        },
      });

      let result = await executor.execute();

      // 交互/暂停循环：ask 回复或 pause→resume 后从断点续跑（重跑门禁 + 推进剩余 Step），
      // 直至 Stage 完成或失败。
      while (result.status === 'interacting' || result.status === 'paused') {
        if (result.status === 'interacting') {
          // Step 收尾判定为 ask：Step 进入 interacting，等待用户回复。
          this.markStageStatus(active, stageId, 'interacting');
          active.state = { ...active.state, status: 'interacting', updatedAt: now() };
          await this.persistState(active);

          const ask = findAskStep(active.state.executedSteps);
          if (ask === undefined) {
            // 无 ask 载荷（异常收尾）：不再静默 return（实例永久卡 interacting、UI 无
            // 选择框）——记 warn 并把滞留 ask-detect 的 Step 落 failed + 落 Stage/实例
            // failed + 单发 sandore/step-failed + sandore/end（对齐 runAndCatch 语义与
            // handleRejectedQuestion 的显式落态写法）。findAskStep 返回 undefined 意味着
            // 所有 ask-detect Step 均无 askQuestion 载荷（有则必命中），故全部标 failed。
            this.ctx.logger.warn(
              `sandore: instance ${active.state.taskId} stage ${stageId} interacting without ask payload; marking failed`,
            );
            const errorMessage = 'finalize assess returned ask without askQuestion payload';
            const stuckSteps = active.state.executedSteps.filter(item => item.finalizeMeta?.currentPhase === 'ask-detect');
            for (const stuck of stuckSteps) {
              this.emitStepFailed(
                info,
                stuck.stepId ?? stuck.id,
                stuck.sessionMeta?.childId ?? stuck.id,
                errorMessage,
                stuck.name ?? stuck.id,
                currentLoopIteration(),
              );
            }
            this.markStageStatus(active, stageId, 'failed');
            // 落 failed 终态（保持冻结：工作流未成功完成，hostAgent 不恢复活跃）。
            active.state = {
              ...active.state,
              executedSteps: active.state.executedSteps.map(item =>
                item.finalizeMeta?.currentPhase === 'ask-detect'
                  ? { ...item, status: 'failed' as StepStatus, error: errorMessage, updatedAt: now() }
                  : item,
              ),
              status: 'failed',
              updatedAt: now(),
            };
            await this.persistState(active);
            this.emitEnd(info, { taskId: info.taskId, status: 'failed', error: errorMessage });
            this.notifyHostTerminal(active, 'failed');
            return;
          }
          const entry: PendingQuestionEntry = {
            id: ask.step.id,
            stageId: ask.step.stageId,
            stepId: ask.step.stepId ?? ask.step.id,
            sessionId: active.state.taskId,
            requestId: globalThis.crypto.randomUUID(),
            kind: 'question',
            status: 'pending',
            payload: ask.payload,
            createdAt: now(),
          };
          // §3.6A ask 收尾闭环：接收回答（而非只当解锁信号）→ 真实子代理（synthetic ===
          // false）followup 注回让子代理基于回答继续 → 循环续跑（executor 重收集新
          // output + 重跑门禁）。Round 26：回答**不写入 userMessages**（kind:'answer'）——
          // 回答是给子代理的内部闭环消息，不注入 discussion 时间轴（用户可见性由
          // composer 问答卡 + 子代理续跑输出承载）。
          const answer = await active.interactions.ask({ entry, ...(signal === undefined ? {} : { signal }) });
          // 缺陷 26：问答被拒（rejectQuestion 以 REJECTED_ANSWER 占位 resolve，非 reject——
          // 避免冒泡 runAndCatch 把整实例落 failed 且 Step 滞留 interacting）。检测占位标记后
          // 标 ask Step failed + 落 Stage/实例 failed（经显式代码非异常冒泡），对齐基准
          // rejectQuestion→StepRunner 标 failed 的本质。
          if (isRejectedAnswer(answer)) {
            await this.handleRejectedQuestion(active, stageId, ask, info, currentLoopIteration());
            return;
          }
          const answerText = buildAnswerText(answer);
          const childId = ask.step.sessionMeta?.childId;
          if (childId !== undefined && ask.step.sessionMeta?.synthetic === false) {
            // queue 投递注回（独立 FIFO 轮次语义，等价旧 subagents.followup）。
            await this.deliverChildPrompt(hostAgent, childId, [{ type: 'text', text: answerText }], controller.signal);
          }
          // 回答已注回子代理（子代理会话内可见）；不追加 userMessages（Round 26 去讨论页污染）。
          active.state = { ...active.state, updatedAt: now() };
          await this.persistState(active);
        } else {
          // Step 被 interrupt 打断且命中暂停登记表：等待 resumeStep/resumeAllSteps 的
          // followup 续跑（D-3「命中则等待 resume 的 followup Promise」），不落 failed、
          // 不推进下一 Stage、不发射 step-failed。
          // 补充 37 SessionIdleWaiter 扩展：按 stepId 维度等待（resumeStep 只唤醒目标 Step）。
          const pausedStep = active.state.executedSteps.find(s => s.status === 'paused');
          const pausedStepId = pausedStep?.stepId ?? pausedStep?.id ?? '*';
          await this.waitForResume(active, pausedStepId);
        }

        // 中止可能在 paused 等待期命中（waitForResume 与 signal.aborted 竞争后返回）：
        // 直接退出循环，交由下方 aborted 处理分支落终态。
        if (signal.aborted) {
          break;
        }

        // 回复/恢复后从断点续跑：executor 重跑门禁审查并推进剩余 Step。
        result = await executor.execute();
      }

      if (signal.aborted) {
        // aborted 处理分支：paused 等待期命中（waitForResume 与 signal.aborted 竞争后
        // 退出循环，result 仍为 'paused'）或 Step 因中止失败（result 为 'failed'）。
        // 中止落态 + 广播收敛到 markAborted（幂等单一出口）：abortInstance 已广播则本分支
        // 只补落态**不重发** `sandore/aborted`——即使中途有失败回写把内存态打回 failed，
        // 一次性标记仍拦住二次广播；终态 status='aborted' 由 markAborted 重新落盘保证。
        // 兜底分支不触碰冻结登记——abort 清表语义由 abortInstance 统一处理。
        this.markStageStatus(active, stageId, 'failed');
        await this.markAborted(active, info);
        return;
      }

      // executedSteps 已通过 onPersist 逐 Step 追加/更新并持久化，此处仅合并透传变量。
      active.state = {
        ...active.state,
        passThroughVars: { ...active.state.passThroughVars, ...result.passThroughVars },
        updatedAt: now(),
      };

      if (result.status === 'failed') {
        this.markStageStatus(active, stageId, 'failed');
        // 落 failed 终态。
        active.state = {
          ...active.state,
          status: 'failed',
          stageContracts: { ...active.state.stageContracts, [stageId]: result.stageContract },
          // 2026-08-25 real-e2e：终态统一清空循环上下文。
          activeLoopIterationStack: [],
          activeLoopStack: [],
          activeLoopNodeId: null,
          updatedAt: now(),
        };
        await this.persistState(active);
        this.emitEnd(info, {
          taskId: info.taskId,
          status: 'failed',
          ...(result.errorDetail === undefined ? {} : { error: result.errorDetail }),
        });
        this.notifyHostTerminal(active, 'failed');
        return;
      }

      const stageContract: StageContract = result.stageContract;

      this.markStageStatus(active, stageId, 'completed');
      navigator.setStageContract(stageId, stageContract);
      active.state = {
        ...active.state,
        currentStageId: stageId,
        stageContracts: { ...active.state.stageContracts, [stageId]: stageContract },
        // 2026-08-25 real-e2e：stage 完成时清空循环上下文——循环定义在 stage 内，
        // 而跨 stage 的 LoopManager 从 active.state 继承循环栈（L1219），残留的
        // activeLoopStack/activeLoopIterationStack 会污染下一 stage（幽灵循环帧）。
        activeLoopIterationStack: [],
        activeLoopStack: [],
        activeLoopNodeId: null,
        updatedAt: now(),
      };
      await this.persistState(active);
      this.emitStageCompleted(info, stageId, stageContract);

      if (!(await navigator.tryAdvanceStage(signal))) {
        stageId = '';
      } else {
        stageId = navigator.currentNodeId;
      }
    }

    // 工作流成功完成：落 completed 终态。架构决策 2 已删除宿主主代理冻结登记，此处
    // 只需给宿主会话注入一条收尾通知（不唤醒；主代理下次被唤醒时读到，可据此汇报）。
    this.notifyHostTerminal(active, 'completed');
    active.state = {
      ...active.state,
      status: 'completed',
      // 2026-08-25 real-e2e：终态统一清空循环上下文（历史实例 activeLoopIterationStack
      // 残留 [1] 幽灵循环帧，见 docs/bugfix/bugfix-2026-08-25-round23-midstage-completed-ask-gate.md）。
      activeLoopIterationStack: [],
      activeLoopStack: [],
      activeLoopNodeId: null,
      updatedAt: now(),
    };
    await this.persistState(active);
    this.emitEnd(info, { taskId: info.taskId, status: 'completed' });
  }

  // ── 状态辅助 ─────────────────────────────────────────────────────────────

  private markStageStatus(active: ActiveInstance, stageId: string, status: StepStatus): void {
    active.state = {
      ...active.state,
      stageInfos: active.state.stageInfos.map(item => (item.id === stageId ? { ...item, status } : item)),
    };
  }

  /**
   * 处理问答被拒后的 Step-failed 语义（缺陷 26 核心）。
   *
   * `rejectQuestion` 以 `REJECTED_ANSWER` 占位 resolve waiter（非 reject，避免冒泡
   * `runAndCatch` 落整实例 failed 且 Step 滞留 interacting）；引擎 ask 调用处经
   * {@link isRejectedAnswer} 检测占位标记后转此方法：标 ask Step failed（写
   * `executedSteps` + persist）+ 单发 `sandore/step-failed` + 落 Stage failed +
   * 实例 failed + 单发 `sandore/end`（failed）。经显式代码落态而非异常冒泡，对齐
   * 基准 `rejectQuestion → StepRunner 标 failed` 的本质。
   *
   * **续跑/失败策略**：当前 Stage 无失败容错字段（`StageContract`/`Stage` schema
   * 无 continue-on-failure），故问答被拒 → Stage failed → 实例 failed。续跑
   * 语义（基准「Step failed、实例继续」）待 Stage 级失败容错字段引入后在此分支
   * 按 `stage.continueOnFailure` 决定续跑或落 Stage failed。
   */
  private async handleRejectedQuestion(
    active: ActiveInstance,
    stageId: string,
    ask: { step: WorkflowTaskState['executedSteps'][number]; payload: AskUserQuestionPayload },
    info: DagRunInfo,
    loopIteration: number[] | undefined,
  ): Promise<void> {
    const stepEntry = ask.step;
    const stepId = stepEntry.stepId ?? stepEntry.id;
    const childId = stepEntry.sessionMeta?.childId ?? synthesizeChildId(stepEntry.id);
    const name = stepEntry.name;
    const errorMessage = 'Question rejected by user';
    // 标 ask Step failed（写 executedSteps + persist）。该 Step 此前在 ask 保底中断
    // （executed.status=running + finalizeMeta currentPhase='ask-detect'，偏离 8），
    // StageExecutor 的 onStepFailed 钩子未对其触发（仅在 executor.execute() 内触发），
    // 故此处显式单发 sandore/step-failed。
    active.state = {
      ...active.state,
      executedSteps: active.state.executedSteps.map(item =>
        item.id === stepEntry.id
          ? { ...item, status: 'failed' as StepStatus, error: errorMessage, updatedAt: now() }
          : item,
      ),
      updatedAt: now(),
    };
    await this.persistState(active);
    this.emitStepFailed(info, stepId, childId, errorMessage, name, loopIteration);
    // 落 Stage failed + 实例 failed（无 Stage 级失败容错 → 整实例 failed，但经显式
    // 代码非异常冒泡；Step 正确置 failed 而非滞留 interacting）。
    this.markStageStatus(active, stageId, 'failed');
    // 落 failed 终态。
    active.state = { ...active.state, status: 'failed', updatedAt: now() };
    await this.persistState(active);
    this.emitEnd(info, { taskId: info.taskId, status: 'failed', error: errorMessage });
    this.notifyHostTerminal(active, 'failed');
  }

  private runnerConfig(definition: WorkflowDefinition, hostAgent: Agent, active: ActiveInstance): StepRunnerConfig {
    // 模型路由 L2：创建实例时选择的模型（弹窗传入，存 state.modelSelection）优先，
    // 未选择时回退引擎级默认（L2）→ llm 目录（L3）。
    const instanceModel = active.state.modelSelection;
    return {
      defaultTimeoutMs: this.config.defaultTimeoutMs ?? 7200000,
      ...(instanceModel === undefined
        ? {}
        : { defaultProvider: instanceModel.provider, defaultModel: instanceModel.model }),
      ...(this.config.defaultProvider === undefined ? {} : { defaultProvider: this.config.defaultProvider }),
      ...(this.config.defaultModel === undefined ? {} : { defaultModel: this.config.defaultModel }),
      skills: definition.skills,
      mcps: definition.mcps,
      agents: definition.agents,
      hostAgent,
      // 子代理直接 parent 会话 id（恒等式：宿主会话 id ≡ 实例 id ≡ taskId，架构决策 1；
      // 不再有 `hostSessionId ?? taskId` 回退）。
      parentSessionId: active.state.taskId,
      onChildStarted: async (stepId, childId) => {
        // Round 25（方案 B）：发布真实 childId 前尽力确认子代理会话已 live 可读
        // （startContinuable 返回时通常已 publish；仅在极端发布竞态下短暂等待一次），
        // 缩小「UI 拿到 childId 但会话尚未就绪/未落盘」的窗口。确认失败仅 warn、
        // 不阻塞 step 启动——真正兜底是 UI 侧重试（StepChatPanel Round 25 方案 A）。
        await this.assureChildSessionLive(childId);
        // 子代理真实 childId 就绪：把 running Step 的 sessionMeta 从合成占位切换为
        // 真实子代理 SessionId（暂停反查/fork/消息收集依赖该字段）。段模型下取
        // attemptIndex 最大的 running 段（避免多段时错配陈旧段）。
        const activeSteps = active.state.executedSteps
          .filter(item => item.stepId === stepId && item.status === 'running')
          .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0));
        const entry = activeSteps[0];
        if (entry === undefined || entry.sessionMeta === undefined) {
          return;
        }
        // hostSessionId = 宿主主代理会话 id（= 子代理的直接 parent，恒等于 taskId）：
        // UI 据此组 subagent-kind 地址 {kind:'subagent', parentSessionId, childSessionId,
        // mode:'continuable'} 打开内嵌会话（plain open 会被 rc.1 宿主恒拒）。
        const sessionMeta = {
          ...entry.sessionMeta,
          childId,
          synthetic: false,
          hostSessionId: active.state.taskId,
        };
        active.state = {
          ...active.state,
          executedSteps: active.state.executedSteps.map(item => (item.id === entry.id ? { ...item, sessionMeta } : item)),
          updatedAt: now(),
        };
        // await 落盘：崩溃恢复快照必须含真实 childId（fire-and-forget 会留占位）。
        await this.persistState(active);
      },
      // settle 终态等待（对齐 DSH `subagent/end`）：经 `sandore/subagent-settled` 事件路由。
      // DSH 适配层把 DSH `subagent/end`（subagent 销毁时 emit，载荷含 stopReason +
      // lastAssistantMessage）转译为本事件（见 buildActiveInstance 单一监听器把 settlement
      // 缓冲到 active.settlementBuffer + 唤醒 awaiter）；mock FakeSubagents 直接发射。
      // stopReason=completed→完成 / aborted（interrupt 暂停）→不算完成 /
      // error·max-tokens·refusal→failed。collectSubagentOutput 据此路由。
      awaitSubagentSettlement: (childId, signal) => {
        // 先查缓冲（settle 可能早于 awaiter 注册——如 resume 测试在 await resumeStep 前
        // settleChild）：命中即消费返回，避免事件丢失导致挂起。
        const buffered = active.settlementBuffer.get(childId);
        if (buffered !== undefined) {
          active.settlementBuffer.delete(childId);
          return Promise.resolve(buffered);
        }
        return new Promise<SubagentSettlement>((resolve, reject) => {
          active.settlementResolvers.set(childId, resolve);
          signal.addEventListener('abort', () => {
            active.settlementResolvers.delete(childId);
            reject(new SandoreError(`awaiting subagent '${childId}' settlement aborted`, 'CANCELLED'));
          }, { once: true });
        });
      },
    };
  }

  /**
   * Round 25（方案 B）：子代理会话 live 确认——发布真实 childId 前的尽力检查。
   *
   * `startContinuable` 返回时子代理会话通常已发布到 `ctx.sessions`（创建完成）；
   * 仅在极端发布竞态下（会话 publish 与返回之间的微任务窗口）可能短暂缺失。
   * 这里 get 命中且事件非空即返回（真实环境零等待）；缺失时等待 50ms 复查一次，
   * 仍缺失仅 warn 不阻塞——UI 侧重试（StepChatPanel Round 25 方案 A）才是兜底。
   *
   * 测试 mock 的 childId 为短 id（`child-N`，FakeSubagents.startContinuable 生成），
   * 且 FakeSessionStore 不登记子代理会话——等待只会空转，且该 50ms 会确定性改变
   * 并行 step（子代理 vs shell）的完成时序（曾致「汇合节点多执行一次」用例失败）。
   * 故仅对真实 UUID 格式的 childId 做确认，mock 直接跳过（0 延迟）。
   */
  private async assureChildSessionLive(childId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(childId)) {
      return;
    }
    // 上游 dsh-session 0.1.2：Session.events 直读已删，经 snapshotEvents() 取全量。
    const live = this.ctx.sessions.get(SessionId(childId));
    if (live !== undefined && live.snapshotEvents().length > 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    const again = this.ctx.sessions.get(SessionId(childId));
    if (again === undefined || again.snapshotEvents().length === 0) {
      this.ctx.logger.warn(`sandore: child session '${childId}' not live when publishing childId; UI open retry 兜底`);
    }
  }

  /** 构造完整 ActiveInstance（交互/生命周期/恢复三个管理器 + 宿主主代理 + 状态快照）。 */
  private buildActiveInstance(
    controller: AbortController,
    session: Session,
    hostAgent: Agent,
    definition: WorkflowDefinition,
    state: WorkflowTaskState,
  ): ActiveInstance {
    const logger = this.ctx.logger;
    const reactiveState = new ReactiveState<WorkflowTaskState>(
      state,
      async (snapshot) => {
        const persistence = this.persistence();
        if (persistence === undefined) return;
        await persistence.saveWorkflowState(snapshot);
      },
      (error) => {
        logger.warn(`sandore: persist state failed: ${renderError(error)}`);
      },
    );
    let active!: ActiveInstance;
    const interactions = new InteractionManager({
      hostAgent,
      userQuestions: () => this.ctx.get('userQuestions'),
      // 入口归一（架构决策 1）：ask/permission **一律**上报宿主主代理（reportToHost
      // 单值化为恒 true）——恒等式下宿主会话就是发起 run 的那个真实会话，其弹窗
      // 用户可见可答；不再有 overlay/复用两种场景的分流。
      persist: (entries) => {
        active.state = { ...active.state, pendingInteractions: entries, updatedAt: now() };
        void this.persistState(active);
      },
      emitQuestion: (entry) => this.emitQuestion(active, entry),
      emitPermission: (entry) => this.emitPermission(active, entry),
      emitQuestionRejected: (entry) => this.emitQuestionRejected(active, entry),
    });
    const lifecycle = new LifecycleManager({
      hostAgent,
      initialPausedChildIds: state.pausedChildIds,
      interrupt: (childId, authority) => this.ctx.subagents.interrupt(childId, authority),
      // 上游 `subagents.followup` 已删：resume 续跑经 queue 投递（独立 FIFO 轮次语义）。
      followup: async (childId, content, signal) => {
        await this.deliverChildPrompt(hostAgent, childId, content, signal);
      },
      getAgent: (childId) => this.ctx.agents.get(childId) ?? undefined,
      signal: controller.signal,
      readState: () => active.state,
      commitState: (next) => {
        active.state = next;
        void this.persistState(active);
      },
      emitStepPaused: (stepId, childId, name, loopIteration) => this.emitStepPaused(active, stepId, childId, name, loopIteration),
      emitStepResumed: (stepId, childId, resumePrompt, name, loopIteration) => this.emitStepResumed(active, stepId, childId, resumePrompt, name, loopIteration),
    });
    const recovery = new RecoveryManager({
      signal: controller.signal,
      readState: () => active.state,
      commitState: (next) => {
        active.state = next;
        void this.persistState(active);
      },
      // 上游 `subagents.followup` 已删：retry 冷恢复/重试驱动经 queue 投递。
      followup: async (childId, content, signal) => {
        await this.deliverChildPrompt(hostAgent, childId, content, signal);
      },
      createAgent: (options) => {
        // 2026-08-25 real-e2e 修复：retryStep fork/revert 模式的 createAgent 传
        // meta.parentSession=源 childId（审计语义），但 DSH continuation 的 lineage
        // 校验要求 child.parentSession === followup 的 parent（宿主主代理）——源会话
        // 已 settle/dispose 时必然不匹配 → UNAUTHORIZED（「belongs to another parent
        // session」）。包装统一为宿主主代理（fork 源记录已由 recovery-manager 的
        // runningStep.parentSessionId 承载，不依赖 meta）。
        // 上游适配：注入与 forkStepSubagent 同型的 setup（captureDelegatedPolicyOverrides
        // + applyChildComposition，hostAgent 闭包捕获）——消除 retry fork 子代理零工具
        // 缺陷（scope-local 工具注册不自动继承 parent，未组合 preset 的 child 工具
        // registry 为空）；capture 在本包装体内同步执行（首个 await 之前）。
        const setup = delegatedChildSetup(hostAgent);
        return this.createChildAgent({
          ...options,
          ...(options.meta === undefined ? {} : {
            meta: { ...options.meta, parentSession: hostAgent.id },
          }),
          setup,
        });
      },
      getSession: (id) => {
        // 上游 dsh-session 0.1.2：Session.events 直读已删，经 snapshotEvents() 取全量。
        const child = this.ctx.sessions.get(SessionId(id));
        return child === undefined ? undefined : { events: child.snapshotEvents() };
      },
      // 2026-08-25 real-e2e 修复：fork 源会话 live 已移除（子代理 settle/dispose）时，
      // `ctx.sessions.fork` 抛 SESSION_NOT_FOUND → retryStep fork 模式失败。改为
      // live → 持久化回退（对齐 getStepSessionEvents）：live 命中走 sessions.fork；
      // 否则从 sessionPersistence inspect 读事件构造 seed（recovery-manager 用
      // forked.events 作 createAgent 的 seed，无需 live 会话本体）。
      //
      // **不变量守卫（2026-09）**：fork 源**只能**是某个 step 段子代理会话（重建执行
      // 子代理时继承它自己上一次尝试的上下文）。把**宿主主代理会话**当 fork 源会把主代理
      // 历史灌进执行子代理（真机缺陷的形态），故在此响亮拒绝——这条守卫与
      // `microflow/subagents.ts` 的 FRESH_SUBAGENT_PROVIDER 一起构成「执行子代理必须全新
      // / 只带自己的上下文」的显式不变量，改回去会立刻被测试抓到。
      forkSession: async (source, boundary) => {
        if (source === active.state.taskId) {
          throw new SandoreError(
            `refusing to fork host session '${source}' as a step-subagent seed: `
            + 'step subagents must not inherit the host main-agent history (see FRESH_SUBAGENT_PROVIDER)',
            'INVALID_OPERATION',
          );
        }
        const live = this.ctx.sessions.get(SessionId(source));
        if (live !== undefined) {
          // 上游 dsh-session 0.1.2：fork boundary 为 SessionSeq 品牌数；Session.events
          // 直读已删，经 snapshotEvents() 取全量。
          const child = this.ctx.sessions.fork(SessionId(source), boundary === undefined ? undefined : SessionSeq(boundary));
          return { events: child.snapshotEvents() };
        }
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined || persistence.inspect === undefined) {
          throw new SandoreError(
            `fork source session '${source}' not found (live) and sessionPersistence unavailable`,
            'NODE_NOT_FOUND',
          );
        }
        const events = await persistence.inspect(source);
        if (events === undefined) {
          throw new SandoreError(`fork source session '${source}' not found (live or persisted)`, 'NODE_NOT_FOUND');
        }
        // 对齐 sessions.fork 的 boundary 语义：默认截到末事件；boundary 越界抛错。
        const eventList = [...events.events];
        const lastEvent = eventList.at(-1);
        if (boundary === undefined) {
          return { events: eventList };
        }
        if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= eventList.length) {
          throw new SandoreError(
            `fork boundary ${boundary} does not exist in session '${source}' (last seq: ${lastEvent?.seq ?? 'none'})`,
            'INVALID_OPERATION',
          );
        }
        return { events: eventList.slice(0, boundary + 1) };
      },
      emitStepRetried: (stepId, mode, name, loopIteration) => this.emitStepRetried(active, stepId, mode, name, loopIteration),
      resumeExecution: () => this.resumeExecution(active),
      // F1：retryStep 的 live 判定（rc.1 dispose 语义——已结算子代理不在 registry →
      // fail-fast 拒绝重试，避免 followup 挂起）。
      getAgent: (childId) => this.ctx.agents.get(childId) ?? undefined,
    });
    active = {
      controller,
      session,
      hostAgent,
      definition,
      interactions,
      lifecycle,
      recovery,
      reactiveState,
      state: undefined as unknown as WorkflowTaskState,
      resumeRequested: new Set<string>(),
      resumeWaiters: new Map<string, Array<() => void>>(),
      settlementBuffer: new Map<string, SubagentSettlement>(),
      settlementResolvers: new Map<string, (settlement: SubagentSettlement) => void>(),
      abortedBroadcast: false,
      disposeSettlementListener: () => {},
    };
    // 用 Object.defineProperty 给 state 加 getter/setter 委托 ReactiveState。
    // 这样所有 `active.state = {...}` 赋值自动触发 setter → 持久化调度，
    // `active.state` 读取返回最新值。零改动现有赋值/读取代码。
    Object.defineProperty(active, 'state', {
      get: () => reactiveState.current,
      set: (next: WorkflowTaskState) => { reactiveState.current = next; },
      enumerable: true,
      configurable: true,
    });
    // 单一 `sandore/subagent-settled` 监听器：唤醒挂起 awaiter，或在**无 awaiter** 时缓冲。
    // DSH 适配层（registerSubagentSettlementAdapter 把 DSH subagent/end 转译为本事件）
    // 与 mock FakeSubagents.settleChild/interrupt 都经此通道；监听器存活于 active 生命周期。
    //
    // **有 awaiter 时绝不写缓冲**（缺陷修复：恢复后实例停留在 paused 的根因 C）：
    // 原实现在 resolver 判定**之前**无条件 `settlementBuffer.set(...)`，使一次已被 awaiter
    // 消费的 settlement 仍以陈旧副本留在缓冲里。pause 的 interrupt 发出的 `{aborted}`
    // 因此残留 → resume 后新段 `collectSubagentOutput` → `awaitSubagentSettlement` 直接命中
    // 缓冲的陈旧 `{aborted}` → 抛 `STEP_PAUSED` → stage-executor 把段/实例重新判为 paused
    // （`sandore/step-resumed` 已发、无错误提示，但实例状态停在 paused）。
    active.disposeSettlementListener = this.ctx.on('sandore/subagent-settled', (settlement: SubagentSettlement) => {
      const resolve = active.settlementResolvers.get(settlement.childId);
      if (resolve !== undefined) {
        // 有 awaiter 在等：直接 resolve，不写 buffer（避免陈旧 settlement 残留，
        // 导致后续同 childId 的 awaiter 命中陈旧 stopReason 误判——如 pause→resume
        // 后 awaiter#2 命中陈旧 {aborted} 重新 STEP_PAUSED 使 resume 失效）
        active.settlementResolvers.delete(settlement.childId);
        resolve(settlement);
      } else {
        // 无 awaiter：缓冲（awaiter 稍后注册时先查 buffer 命中即消费）
        active.settlementBuffer.set(settlement.childId, settlement);
      }
    });
    return active;
  }

  /** 快照是否含 paused Step（paused-only 实例等待手动 resume，不自动重跑）。 */
  private hasPausedStep(active: ActiveInstance): boolean {
    return active.state.executedSteps.some(step => step.status === 'paused');
  }

  /**
   * 从段列表中取全部"活跃段"（status running/interacting，缺陷 10 多路恢复）。
   *
   * 并发落地后多个 Step 同时 running 为常态；返回全部活跃段供多路 followup/续跑。
   * 按 attemptIndex 降序排列（attempt 大者优先）。单活跃段场景退化为取首元素。
   */
  private findActiveSegments(
    steps: WorkflowTaskState['executedSteps'],
  ): WorkflowTaskState['executedSteps'][number][] {
    return steps
      .filter(step => step.status === 'running' || step.status === 'interacting')
      .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0));
  }

  /**
   * sendStepMessage 的 Step 反查（缺陷 31）：按 stepId（定义 id 或唯一执行 id）
   * 反查"最后活跃段"（running/interacting 中 attemptIndex 最大者）；无活跃段时
   * 回退同 stepId 的任意段（再退唯一执行 id）——与 {@link LifecycleManager.findStep}
   * 同规则，保证段模型下多段 Step（暂停续跑/重试/ask 续问）定位到当前活跃段。
   */
  private findStepForMessage(
    steps: WorkflowTaskState['executedSteps'],
    stepId: string,
  ): WorkflowTaskState['executedSteps'][number] | undefined {
    const byStep = steps.filter(step => step.stepId === stepId);
    if (byStep.length > 0) {
      const active = byStep
        .filter(step => step.status === 'running' || step.status === 'interacting')
        .sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0));
      return active[0] ?? byStep[byStep.length - 1];
    }
    return steps.find(step => step.id === stepId);
  }

  /** 续跑执行位置的起始 Stage：running/interacting Step 所在 Stage，否则 currentStageId。 */
  private resumeStageId(active: ActiveInstance): string {
    const resumeSteps = this.findActiveSegments(active.state.executedSteps);
    return resumeSteps[0]?.stageId ?? active.state.currentStageId;
  }

  /**
   * 计算 Stage 续跑播种（缺陷 10 多路恢复 + pendingQueue 精确重放）。
   *
   * - 多路恢复：全部 running/interacting 子代理 Step 入 resumeSubagents（并发崩溃多路续跑）。
   * - pendingQueue 精确重放：直接从 state.pendingQueue 播种初始 batch（不再反推 DAG next）。
   *   pendingQueue 为空时 fallback 到 between-steps 反推（缺陷 9 G）。
   * - completed Step 跳过不重跑（非恰好一次语义）。
   */
  private resumeInfo(active: ActiveInstance, stage: WorkflowStage): StageExecutorResume | undefined {
    const stageSteps = active.state.executedSteps.filter(step => step.stageId === stage.id);
    const resumeSteps = this.findActiveSegments(stageSteps);
    const pendingQueue = active.state.pendingQueue;

    // 多路恢复：全部 running/interacting 子代理 Step 各自续跑（缺陷 10）。
    const resumeSubagents = resumeSteps
      .map(step => {
        const stepDef = stage.steps.find(s => s.id === (step.stepId ?? step.id));
        if (stepDef === undefined) {
          return undefined;
        }
        // 分离式合并：stage.steps 仅流控位（id + branches），完整定义（command/映射等）
        // 在顶层 definition.steps，按 id 取合并视图供续跑（resumeSubagentStep 需要 command）。
        const definitionStep = active.definition.steps?.find(s => s.id === stepDef.id);
        const mergedStep: WorkflowStep = definitionStep === undefined
          ? { id: stepDef.id }
          : { ...definitionStep };
        return {
          step: mergedStep,
          executed: step as unknown as ExecutedStepDefault,
          childId: step.sessionMeta?.childId ?? synthesizeChildId(step.id),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    const completedInStage = stageSteps.filter(step => step.status === 'completed');

    // 无活跃段 + 无已完成 Step：空 Stage 快照（startInstance 后任何 Step 执行前崩溃）。
    // 有 pendingQueue 时播种（精确重放）；否则返回 undefined（执行器从首步正常重跑）。
    if (resumeSubagents.length === 0 && completedInStage.length === 0) {
      if (pendingQueue !== undefined && pendingQueue.length > 0) {
        return {
          completedSteps: [],
          ...(pendingQueue.length > 0 ? { pendingQueue } : {}),
        };
      }
      return undefined;
    }

    // 无活跃段 + 有已完成 Step：between-steps 崩溃窗口（缺陷 9 G）。
    // pendingQueue 非空时直接播种（精确重放）；否则 fallback 到 between-steps 反推。
    if (resumeSubagents.length === 0) {
      if (pendingQueue !== undefined && pendingQueue.length > 0) {
        return {
          completedSteps: completedInStage as unknown as ExecutedStepDefault[],
          pendingQueue,
        };
      }
      return {
        completedSteps: completedInStage as unknown as ExecutedStepDefault[],
        resumeBetweenSteps: true,
      };
    }

    // 有活跃段（mid-step 崩溃）：多路续跑 + pendingQueue re-queue。
    // 快照 executedSteps 为 schema 派生类型（可选字段 `| undefined`），此处收窄为
    // StageExecutor 内部的 browser-safe ExecutedStepDefault（与 onPersist 桥接一致）。
    return {
      completedSteps: completedInStage as unknown as ExecutedStepDefault[],
      resumeSubagents,
      ...(pendingQueue !== undefined && pendingQueue.length > 0 ? { pendingQueue } : {}),
    };
  }

  private persistence(): SandorePersistence | undefined {
    return this.ctx.get('sandorePersistence');
  }

  /**
   * sandore_workflow 工具的 persistence 最小面（`ctx.get('sandorePersistence')`
   * 惰性解析，结构收敛为 `SandoreManagerPersistenceSeam`；见 manager-tool.ts）。
   */
  private managerPersistenceView(): SandoreManagerPersistenceSeam | undefined {
    const persistence = this.persistence();
    if (persistence === undefined) return undefined;
    return {
      definitions: persistence.definitions,
      steps: persistence.steps,
      microflows: persistence.microflows,
      state: persistence.state,
      writeDefinitionToLibraries: definition => persistence.writeDefinitionToLibraries(definition),
    };
  }

  /** 取内存活跃实例；未命中抛 `NODE_NOT_FOUND`。 */
  private requireActive(instanceId: string): ActiveInstance {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    return active;
  }

  /**
   * 主循环 paused 时等待 resume 信号（与 `signal.aborted` 竞争）。
   *
   * 补充 37 SessionIdleWaiter 扩展：按 stepId 维度维护 waiter。resumeStep(stepId) 只唤醒
   * 目标 Step 的 waiter；resumeAllSteps 唤醒全部（'*' key）。
   *
   * 若 resume 已先行触发（竞态：resumeStep 先于主循环进入等待），立即消费标志返回；
   * 否则注册 waiter 并监听 abort：由 `notifyResume` 在 resumeStep/resumeAllSteps 时
   * resolve，或由 `abortInstance` 的 `controller.abort()` 触发 abort 监听 resolve——
   * 主循环恢复后经 `signal.aborted` 检查退出到 aborted 处理分支，避免 paused 期中止
   * 导致主循环永久悬挂。
   *
   * @param stepId - 等待 resume 的 Step id（'*' 表示等全部 resume）。
   */
  private async waitForResume(active: ActiveInstance, stepId: string): Promise<void> {
    if (active.resumeRequested.has(stepId)) {
      active.resumeRequested.delete(stepId);
      return;
    }
    await new Promise<void>(resolve => {
      if (active.controller.signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => resolve();
      active.controller.signal.addEventListener('abort', onAbort, { once: true });
      const waiters = active.resumeWaiters.get(stepId) ?? [];
      waiters.push(() => {
        active.controller.signal.removeEventListener('abort', onAbort);
        resolve();
      });
      active.resumeWaiters.set(stepId, waiters);
    });
  }

  /** resumeStep/resumeAllSteps 成功后唤醒等待 resume 的主循环（无 waiter 时置标志）。
   * @param stepId - 被恢复的 Step id（'*' 表示全部 resume）。 */
  private notifyResume(active: ActiveInstance, stepId: string): void {
    const waiters = active.resumeWaiters.get(stepId);
    if (waiters !== undefined && waiters.length > 0) {
      active.resumeWaiters.set(stepId, []);
      for (const resolve of waiters) {
        resolve();
      }
      return;
    }
    active.resumeRequested.add(stepId);
  }

  private async persistState(active: ActiveInstance): Promise<void> {
    // 关键路径立即落盘：直接写当前最新值（不排队），与改造前 persistState 语义一致。
    await active.reactiveState.flush();
  }

  // ── 事件单发（ctx.emit → SSE → UI） ───────────────────────────────────────

  private emitContained(name: string, args: unknown[]): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = callback(...args);
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`sandore: ${name} listener rejected: ${renderError(error)}`);
        });
      } catch (error) {
        this.ctx.logger.warn(`sandore: ${name} listener threw: ${renderError(error)}`);
      }
    }
  }

  private emitStart(info: DagRunInfo): void {
    this.emitContained('sandore/start', [info]);
  }

  private emitStageStart(info: DagRunInfo, stageId: string): void {
    this.emitContained('sandore/stage-start', [info, stageId]);
  }

  private emitStageCompleted(info: DagRunInfo, stageId: string, stageContract: StageContract): void {
    this.emitContained('sandore/stage-completed', [info, stageId, stageContract]);
  }

  private emitStepStart(info: DagRunInfo, stepId: string, childId: string | undefined, name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-start', [info, stepId, childId, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  private emitStepCompleted(info: DagRunInfo, stepId: string, childId: string | undefined, output: ContentBlock[], name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-completed', [info, stepId, childId, output, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  private emitStepFailed(info: DagRunInfo, stepId: string, childId: string | undefined, error: string, name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-failed', [info, stepId, childId, error, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  private emitStepPaused(active: ActiveInstance, stepId: string, childId: string, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/step-paused', [info, stepId, childId, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  private emitStepResumed(active: ActiveInstance, stepId: string, childId: string, resumePrompt: string | undefined, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/step-resumed', [info, stepId, childId, resumePrompt, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  private emitStepRetried(active: ActiveInstance, stepId: string, mode: RetryMode, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/step-retried', [info, stepId, mode, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  /** 单发 `sandore/step-message`（Cordis `emit` → SSE → UI；缺陷 31 讨论消息端点）。 */
  private emitStepMessage(info: DagRunInfo, stepId: string, childId: string, message: string, name: string): void {
    this.emitContained('sandore/step-message', [info, stepId, childId, message, name]);
  }

  /**
   * 单发 `sandore/step-phase`（Cordis `emit` → SSE → UI）。
   *
   * 收尾阶段流转（ask-detect/finalizing/gating/completed）由 microflow
   * `commitFinalize` 写入 `currentPhase` 时经 `onPhaseChange` 钩子透传到本方法。
   */
  private emitStepPhase(
    info: DagRunInfo,
    stepId: string,
    childId: string | undefined,
    phase: FinalizePhase,
    name: string,
    loopIteration?: number[],
  ): void {
    this.emitContained('sandore/step-phase', [info, stepId, childId, phase, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
  }

  private emitEnd(info: DagRunInfo, result: DagResultInfo): void {
    this.emitContained('sandore/end', [info, result]);
  }

  private emitAborted(info: DagRunInfo): void {
    this.emitContained('sandore/aborted', [info]);
  }

  private emitQuestion(active: ActiveInstance, entry: PendingQuestionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/question', [info, entry]);
  }

  private emitPermission(active: ActiveInstance, entry: PendingPermissionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/permission', [info, entry]);
  }

  /** 单发 `sandore/question_rejected`（Cordis `emit` → SSE → UI；缺陷 26）。 */
  private emitQuestionRejected(active: ActiveInstance, entry: PendingQuestionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/question_rejected', [info, entry]);
  }
}
