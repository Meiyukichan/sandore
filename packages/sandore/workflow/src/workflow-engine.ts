/**
 * sandore 工作流引擎运行时（Stage 级线性主循环）。
 *
 * `SandoreEngineRuntime` 继承 {@link SandoreEngine}：`startInstance` 异步完成
 * 读定义 → parse → 生成 instanceId → 初始化 pending 快照 → `ctx.agents.create`
 * 创建宿主主代理（setup 注册 8 个 `sandore_*` 工具）→ fire-and-forget
 * `execute`；`execute` 以 Stage 级线性主循环编排（每 Stage 新建 microflow `StepNavigator`
 * 承担 Step 级路由/循环，`StageExecutor` 执行 Stage 内 Step → 收集 StageContract →
 * `tryAdvanceStage` 评估 Stage `branch.condition`（基于 StageContract）选下一 Stage）。每次状态
 * 变化 `persistState` 并双发 `sandore/*` 事件（`ctx.emit` + 宿主 Session
 * `append`）；每个 Step 完成后经 `onPersist` 钩子立即追加到
 * `state.executedSteps` 并持久化；`childId = step-{stepId}-{execId 前 8 位}`
 * 合成 sessionMeta。
 * @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session';
// 加载 @deepseek-ai/dsh-session-title 的 Cordis 面声明（使 `ctx.sessionTitle` 类型可用）。
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title';
import z from '@deepseek-ai/schemastery';

/**
 * `Session.append` 的编译期最小面：新 harness 支持可选 `ignorable` 第三参数
 * （sandore/* 事件为 out-of-repo 事件词表，必须带 `ignorable: true` 信封标记，
 * 旧 harness 重建日志时才不会拒绝）。沙盒链接的 dsh-session 类型尚未包含该
 * 参数，此处以窄断言桥接；运行时由真实 harness 的 `Session.append` 承接。
 */
type SessionAppendWithIgnorable = (
  type: string,
  data: unknown,
  opts?: { ignorable?: true },
) => unknown;

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
import { createHostAgentSetup } from './host-agent.ts';
import type { AgentPresetsSeam } from './host-agent.ts';
import { installSandoreAskTool } from './ask-tool.ts';
import { InteractionManager, buildAnswerText, isRejectedAnswer } from './interaction-manager.ts';
import { LifecycleManager } from './lifecycle-manager.ts';
import type { SandorePersistence } from './persistence.ts';
import { RecoveryManager } from './recovery-manager.ts';
import { listClosedTurnBoundaries } from './recovery-manager.ts';
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

import { FinalizeManager } from '@deepseek-ai/dsh-sandore-microflow/src/finalize-manager';
import { createConcurrencyLimiter } from '@deepseek-ai/dsh-sandore-microflow/src/concurrency-limiter';
import type { ConcurrencyLimiter } from '@deepseek-ai/dsh-sandore-microflow/src/concurrency-limiter';
import { StageExecutor } from '@deepseek-ai/dsh-sandore-microflow/src/stage-executor';
import type { StageExecutorResume, StageStepHooks } from '@deepseek-ai/dsh-sandore-microflow/src/stage-executor';
import { StepNavigator } from '@deepseek-ai/dsh-sandore-microflow/src/step-navigator';
import type { StepRunnerConfig } from '@deepseek-ai/dsh-sandore-microflow/src/step-runner';
import type { Agent, ContinuableSetupContribution, CreateAgentOptions, SubagentSettlement, SubagentStopReason } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';

/**
 * `agent/pre-step` 事件的最小结构面（sandore 不 import `@deepseek-ai/dsh-agent` 类型，
 * 以结构类型声明对齐 DSH `PreStepDecision` / pre-step payload）。DSH 在 agent scope 以
 * waterfall 模式分发该事件：`agent` 为提出步骤的 subject，`next()` 委托下游监听链。
 */
interface HostAgentPreStepPayload {
  readonly agent: { readonly id: SessionId };
  readonly messages: readonly unknown[];
  readonly turn: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

/** `agent/pre-step` 的决策：reject 关闭该 turn（无 step、不产生模型调用）或 enter 消息批次。 */
type HostAgentPreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: readonly unknown[] };

/** `agent/pre-step` 的 `next` 委托：调用则进入下游监听链/内建行为。 */
type HostAgentPreStepNext = () => Promise<HostAgentPreStepDecision>;

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
}

/** 实例终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted']);

/** 渲染任意抛出值为可读消息。 */
function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 当前 ISO 时间戳。 */
function now(): string {
  return new Date().toISOString();
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
}): WorkflowTaskState {
  const { instanceId, request, definition, createdAt, cwd } = options;
  return {
    taskId: instanceId,
    workflowId: request.workflowId,
    workflowName: definition.name,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(request.model === undefined ? {} : { modelSelection: request.model }),
    ...(request.permission === undefined ? {} : { permission: request.permission }),
    cwd,
    status: 'pending',
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
    createdAt,
    updatedAt: createdAt,
  };
}

/** 从完整状态快照投影 `DagInstanceState`（引擎 `getState` 的返回形状）。 */
function toDagInstanceState(state: WorkflowTaskState): DagInstanceState {
  return {
    taskId: state.taskId,
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
   * 宿主主代理冻结登记（sandore 侧 hostAgent 冻结，不改 DSH）：存「工作流未成功完成」
   * 的宿主主代理 id（= hostAgent.id）。startInstance/recoverInstance 创建或恢复 hostAgent
   * 时加入；解冻规则：
   * - **completed（成功完成）**：移除登记，hostAgent 恢复普通响应（实例仍留 instances 表，
   *   不解冻则 hostAgent 永远被拒）。
   * - **failed（实例留 instances 表）**：保持冻结（工作流没成功完成，hostAgent 不应恢复
   *   活跃）。
   * - **aborted / recoverInstance-catch（实例清出 instances 表）**：移除登记（清表即
   *   放行——实例生命周期结束，hostAgent 恢复普通响应）。
   *
   * 判定按 hostAgent.id 而非 instances 表键（复用场景 hostAgent.id = hostSessionId ≠
   * instanceId，instances.get 查不到会误放行）；崩溃恢复重建 hostAgent 时 recoverInstance
   * 重新加入，天然覆盖。
   */
  private readonly frozenHostAgents = new Set<string>();

  constructor(ctx: Context, private readonly config: SandoreConfig) {
    super(ctx);
  }

  /** 启动时（Cordis Service.init）自动扫描并恢复孤儿实例（崩溃恢复启动扫描）。 */
  protected async [Service.init](): Promise<void> {
    this.registerSubagentSettlementAdapter();
    this.registerHostAgentFreezeListener();
    // 双通道 ask 通道 1：child-scope ask_user_question 工具注入（gate：仅 sandore 子代理）。
    this.registerSandoreAskToolSetup();
    // SSE 事件通道：注册 /sandore/events 端点，广播 sandore/* 事件给 client。
    this.ctx.effect(() => registerSandoreSse(this.ctx), 'sandore: SSE event channel');
    await this.recoverOrphanedInstances();
  }

  /**
   * 注册 child-scope `ask_user_question` 工具安装贡献（双通道 ask 通道 1，4.3）。
   *
   * 经 `ctx.subagents.registerContinuableSetup` 把安装器组合进每个 continuable child
   * 的 unpublished scope；安装器内做 **gate 校验**：child 的
   * `session.header.parentSession` 必须命中**当前非终态 sandore 实例**的宿主主代理会话
   * （反查 instances 表：`instances[].hostAgent.id === parentSession` 且实例状态非终态）
   * 才注册工具（child-scope 同名注册遮蔽全局 DSH 版），否则返回空 disposer（不安装）。
   *
   * **与计划对齐（4.3）**：gate 为「当前有 sandore 实例匹配」，而非「曾创建过 sandore
   * 宿主主代理」的永久登记——终态实例（completed/failed/aborted）仍留 instances 表
   * （getState 兜底读快照），故显式排除终态，避免宿主主代理在工作流结束后普通 turn
   * 委派的子代理误注入（误注入会令其提问路由到已结束实例的交互管理器）。
   * `subagents` 服务缺失（最小桩部署）时静默跳过。
   */
  private registerSandoreAskToolSetup(): void {
    const contribution: ContinuableSetupContribution = childCtx => {
      // childCtx.agent 在 setup 期可用（对齐 DSH continuation.ts 的
      // appendDelegatedPolicyOverrides 用法）；结构访问 header.parentSession。
      const agent = (childCtx as { agent?: unknown }).agent as
        | { readonly session: { readonly header: { readonly parentSession?: string } } }
        | undefined;
      const parentSession = agent?.session?.header?.parentSession;
      const isSandoreChild = parentSession !== undefined
        && [...this.instances.values()].some(instance =>
          instance.hostAgent.id === parentSession && !TERMINAL_STATUSES.has(instance.state.status));
      if (!isSandoreChild) {
        // gate 未命中（非 sandore 子代理 / 终态实例的后续子代理）：不安装。
        return () => {};
      }
      return installSandoreAskTool(childCtx as unknown as { readonly tools: { register(tool: unknown): () => void } }, this);
    };
    this.ctx.subagents.registerContinuableSetup(contribution);
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
   * 宿主主代理冻结监听（sandore 侧 hostAgent 冻结，不改 DSH）。
   *
   * 工作流未成功完成前 hostAgent 不执行任何模型 turn：子代理 settle / report 唤醒投给
   * hostAgent 的消息在 `agent/pre-step` 被 reject（DSH 官方 park-parent 模式，
   * `deepseek-harness/packages/subagent/tool-subagent-control/tests/park-parent.ts`）——
   * reject 后 turn 以 blocked 关闭、不发 user/message、不产生任何模型调用，消息在
   * claim 处被消费；hostAgent 保持注册存活（引擎只把它当 parent 身份锚点，从不驱动
   * 它，pre-step reject 不影响注册）。
   *
   * **解冻规则（仅两条路径）**：`frozenHostAgents` 在 startInstance/recoverInstance 加入；
   * ① runInstance completed 分支移除（成功完成才解冻）；② abortInstance /
   * recoverInstance-catch 清出 instances 表时同步移除（清表即放行）。**failed（实例留
   * instances 表）保持冻结**——除非工作流成功完成或实例生命周期结束，否则 hostAgent
   * 一直冻结。
   *
   * 挂引擎 ctx + 按 subject.id 过滤（挂 hostAgent.ctx 的 scope 隔离不可行：sandore
   * 接缝 `Agent.ctx` 为 unknown、mock 环境为 undefined）：DSH `agent/pre-step` 在 agent
   * scope 分发，事件沿 scope 链冒泡到引擎 ctx（与 registerSubagentSettlementAdapter
   * 同机制）。子代理的 pre-step 同样到达本监听器，但 childId 不在冻结登记 → 放行
   * （不冻结子代理）。按 hostAgent.id 登记（复用场景 hostAgent.id = hostSessionId ≠
   * instanceId，instances.get 查不到会误放行——故以登记集合为判定依据）。
   *
   * `prepend: true`：冻结期间最先 reject，避免下游 pre-step 监听器（tmux-context/
   * session-reference 等）先行注入上下文再做无用功。settlement 内容不丢：sandore 自持
   * `sandore/subagent-settled` 通道，不依赖 hostAgent 会话。可选部署级增强（不改
   * DSH / agent-presets，仅文档提示）：tool-subagent-report 配 `reportDelivery: 'quiet'`
   * 可连显式 report 的唤醒都省掉——reject 已保证零模型成本，report 唤醒只是多一次空
   * turn 噪声。
   */
  private registerHostAgentFreezeListener(): void {
    const handler = ((
      payload: HostAgentPreStepPayload,
      next: HostAgentPreStepNext,
    ): Promise<HostAgentPreStepDecision> => {
      if (!this.frozenHostAgents.has(payload.agent.id)) {
        return next();
      }
      return Promise.resolve({ kind: 'reject' });
    }) as unknown as (settlement: SubagentSettlement) => void;
    this.ctx.on('agent/pre-step' as 'sandore/subagent-settled', handler, { prepend: true });
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
   * 启动实例：读定义 → parse → 初始化 pending 快照 → 解析宿主主代理（复用调用方传入
   * 的 hostSessionId，或未传入时新建）→ fire-and-forget 执行。
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
    // 工作目录：request.cwd 必填（新增实例弹窗传入；hostAgent 据此 attach web workspace）。
    const cwd = request.cwd;
    const state = makeInitialState({ instanceId, request, definition, createdAt, cwd });
    const controller = new AbortController();
    // 宿主主代理会话 id：调用方可传 `hostSessionId` 复用已存在的宿主会话（不新建）；
    // 未传入时以 instanceId 新建（hostAgent 会话 id = instanceId，历史行为）。事件双发
    // 的 live 会话统一按 hostSessionId 读回。
    const hostSessionId = request.hostSessionId ?? instanceId;
    let hostAgent: Agent;
    let session: Session;
    if (request.hostSessionId === undefined) {
      // §3.0 宿主主代理 = 纯 DSH 默认主代理：setup 只挂默认 preset（系统提示词/skills/
      // 工具全进来），不注册 sandore 工具、不注入角色提示词。`meta.agentPreset` 须在
      // create 前 resolve（会话边界在 setup 前快照 meta）——对齐 apiproxy composeAgent：
      // 先 resolve 得 resolvedId，再传 meta + setup 内 mount。presets 服务缺失时跳过。
      const presets = this.ctx.get('agentPresets') as
        | AgentPresetsSeam
        | undefined;
      const resolvedPresetId = presets === undefined ? undefined : (await presets.resolve())?.id;
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(instanceId),
        meta: {
          cwd,
          ...(resolvedPresetId === undefined ? {} : { agentPreset: resolvedPresetId }),
        },
        setup: createHostAgentSetup({ instanceId, ...(presets === undefined ? {} : { presets }) }),
      });
      hostAgent = handle.agent;
      // agents.create 已把宿主 Session 发布进 ctx.sessions，此处读回 live 会话用于事件双发。
      const createdSession = this.ctx.sessions.get(SessionId(instanceId));
      if (createdSession === undefined) {
        throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
      }
      session = createdSession;
      // 补设宿主会话标题 = 用户输入的需求（originalInput，对齐「宿主会话承载本工作流
      // 需求」语义）；rename 失败仅记录 warn，不得使 startInstance 失败或中断实例执行。
      try {
        this.ctx.sessionTitle.rename(session, request.originalInput);
      } catch (error) {
        this.ctx.logger.warn(`sandore: set host session title failed: ${renderError(error)}`);
      }
      // 宿主主代理 attach 到 web workspace（仅新建分支：子代理获得正确 durable parent，
      // web sidebar 可见 / 暂停走 subagents.interrupt / ask 可答；复用分支的会话归属
      // 由调用方负责，不在此重复 attach）。
      await this.attachHostAgentToWorkspace(hostAgent, cwd);
    } else {
      // 复用调用方传入的宿主主代理会话（不新建）：校验 agent 存在（live，在注册表）。
      // 复用场景 hostAgent.id = hostSessionId ≠ instanceId——引擎只把它当 parent 身份
      // 锚点（subagents.interrupt/followup 的 authority），不驱动它，复用与新建等价。
      const existing = this.ctx.agents.get(SessionId(hostSessionId));
      if (existing === undefined) {
        throw new SandoreError(`host agent session '${hostSessionId}' not found`, 'NODE_NOT_FOUND');
      }
      hostAgent = existing;
      const existingSession = this.ctx.sessions.get(SessionId(hostSessionId));
      if (existingSession === undefined) {
        throw new SandoreError(`host session '${hostSessionId}' was not published`, 'INVALID_OPERATION');
      }
      session = existingSession;
      // 复用不重设标题：保留调用方会话的既有标题。
    }
    // 创建实例时选择的权限预设（弹窗传入）：宿主会话 sandbox 模式 + 审批策略，
    // 在 fire 执行前应用（shell/子代理继承宿主会话权限）。
    if (request.permission !== undefined) {
      this.applyPermission(session, hostAgent, request.permission);
    }
    const active = this.buildActiveInstance(controller, session, hostAgent, definition, state);
    this.instances.set(instanceId, active);
    // 冻结宿主主代理（hostAgent 新建或复用即冻结，直到工作流 completed 才解冻；
    // failed/aborted 保持冻结）。按 hostAgent.id 登记（复用场景 hostAgent.id =
    // hostSessionId ≠ instanceId）。置于 execute 前：子代理 settle/report 唤醒在
    // pre-step 即被 reject。注意：同一 hostSessionId 复用于多个并发实例时，冻结状态
    // 按 hostAgent 主体共享——任一实例 completed 即解冻该 hostAgent。
    this.frozenHostAgents.add(hostAgent.id);
    void this.persistState(active);
    void this.execute(instanceId);
    return { instanceId, status: 'running' };
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
      (session.append as SessionAppendWithIgnorable)('sandbox/mode', { mode: spec.sandbox });
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
   * 实例 aborted 终态（保留持久化快照）→ 双发 `sandore/aborted` → 清理内存
   * ActiveInstance（getState 退回 state 表仍可读到 aborted 快照）。
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
    // 实例 aborted 终态（清理前落盘，保证清理后 getState 仍能读到 aborted 快照）。
    active.state = { ...active.state, status: 'aborted', updatedAt: now() };
    await this.persistState(active);
    this.emitAborted(active.session, info);
    // 清表分支：实例清出 instances 表后冻结登记同步移除——监听器对 subject 自动放行
    // （hostAgent 恢复普通响应；failed/aborted 中仅清表分支放行，留表分支保持冻结）。
    this.frozenHostAgents.delete(active.hostAgent.id);
    // 清理内存 ActiveInstance（保留持久化快照）。
    this.instances.delete(instanceId);
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
    // 冷恢复宿主主代理（resume 重跑 setup：只挂默认 preset，保持冷恢复后能力一致）。
    const presets = this.ctx.get('agentPresets') as AgentPresetsSeam | undefined;
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(instanceId),
      setup: createHostAgentSetup({ instanceId, ...(presets === undefined ? {} : { presets }) }),
    });
    const hostAgent = handle.agent;
    const session = this.ctx.sessions.get(SessionId(instanceId));
    if (session === undefined) {
      throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
    }
    // 崩溃恢复重建 hostAgent 后重新 attach 到快照 cwd 对应的 web workspace（与
    // startInstance 新建分支对齐；registry 缺失时静默跳过）。
    await this.attachHostAgentToWorkspace(hostAgent, snapshot.cwd);
    const active = this.buildActiveInstance(controller, session, hostAgent, definition, snapshot);
    this.instances.set(instanceId, active);
    // 冻结宿主主代理（崩溃恢复重建 hostAgent 后重新冻结，直到工作流 completed 才解冻；
    // failed/aborted 保持冻结）。按 hostAgent.id 登记（resume 场景 hostAgent.id =
    // instanceId）。置于 recover 前：恢复期子代理 settle/report 唤醒同样
    // 在 pre-step 被 reject。
    this.frozenHostAgents.add(hostAgent.id);
    // 清空快照残留 stale pendingInteractions（缺陷 9 B / 缺陷 27 崩溃恢复路径）：
    // InteractionManager 重建时 Maps 为空（不 hydrate），快照中的 ghost ask/permission
    // 条目会被 UI 复弹且 replyQuestion 抛 INVALID_OPERATION。clearAll 终态化 + 清空 +
    // syncState 重持久化空 pending（对齐基准 recover 步骤 B clearAll）。
    active.interactions.clearAll();
    await this.persistState(active);

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
      this.emitEnd(active.session, failInfo, { taskId: active.state.taskId, status: 'failed', error: renderError(error) });
      // 清表分支：实例清出 instances 表后冻结登记同步移除——监听器对 subject 自动放行。
      this.frozenHostAgents.delete(active.hostAgent.id);
      // 清内存：避免持有崩溃恢复期不一致的运行时对象；getState 兜底读快照（failed 终态）。
      this.instances.delete(instanceId);
      return { instanceId, status: 'failed' };
    }
    if (recoverResult.hasFailure) {
      // 合成 session（shell）失败：落 failed 终态 + emitEnd（缺陷 11 补充缺口一：
      // 原实现标 failed 但不 emitEnd，与 runAndCatch 不一致，前端收不到终态通知）。
      // **保持冻结**：工作流未成功完成，hostAgent 不恢复活跃。
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      const failInfo: DagRunInfo = { taskId: active.state.taskId, workflowId: active.state.workflowId };
      this.emitEnd(active.session, failInfo, { taskId: active.state.taskId, status: 'failed', error: 'unrecoverable synthetic session step' });
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
   * 同一通道，registerPending + 双发 `sandore/question`）→ 返回答案。答案**不写
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
    await active.lifecycle.resumeAllSteps(resumePrompt);
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
    const childId = step.sessionMeta?.childId ?? step.id;
    const child = this.ctx.sessions.get(SessionId(childId));
    if (child === undefined) {
      return [];
    }
    return listClosedTurnBoundaries(child.events);
  }

  /**
   * 向运行中实例的指定 Step 子代理追加一条用户 @mention 消息（缺陷 31）。
   *
   * 复用 DSH 宿主 `ctx.subagents.followup`（已在 ask 回答闭环 L656-664 与
   * resumeStep/resumeAllSteps 两条链路直接使用）作为「向子代理会话追加消息并取回
   * 新回复」的现成能力。本方法仅做低成本封装：
   *
   * 1. requireActive（内存未命中抛 NODE_NOT_FOUND——子代理会话绑定内存 session）
   * 2. 终态守卫（终态实例抛 INVALID_OPERATION——无活子代理可收消息）
   * 3. 按 stepId 反查「最后活跃段」（running/interacting 中 attemptIndex 最大者；
   *    无活跃段时回退同 stepId 任意段，再退唯一执行 id——与 LifecycleManager.findStep
   *    同规则）；未找到抛 INVALID_OPERATION
   * 4. synthetic===false 才 followup（synthetic 步骤——shell 合成 session
   *    无真实子代理——抛 INVALID_OPERATION，对齐 LifecycleManager.pauseStep 的
   *    非子代理守卫语义）
   * 5. 追加 userMessages `{kind:'message', target:stepId}`——**不复用 'input'**
   *    （SA8 核实：'input' 语义为原始需求/resume 输入，与讨论消息混淆会污染
   *    originalInput 语义；新增独立 kind:'message' 供时间轴区分渲染）
   * 6. persistState（落盘快照）
   * 7. 双发 `sandore/step-message`（Cordis emit + Session append，供 UI 刷新）
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
    const childId = sessionMeta.childId;
    await this.ctx.subagents.followup(
      active.hostAgent,
      childId,
      [{ type: 'text', text: message }],
      { source: { kind: 'user' }, signal: active.controller.signal },
    );
    active.state = {
      ...active.state,
      userMessages: [
        ...(active.state.userMessages ?? []),
        {
          id: `usr-${globalThis.crypto.randomUUID()}`,
          kind: 'message',
          target: step.stepId ?? step.id,
          content: message,
          createdAt: now(),
        },
      ],
      updatedAt: now(),
    };
    await this.persistState(active);
    this.emitStepMessage(
      active.session,
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
      // 引擎级意外故障（非 Step 失败）：响亮落为 failed 终态。
      // **保持冻结**：工作流未成功完成，hostAgent 不恢复活跃。
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      const info: DagRunInfo = {
        taskId: active.state.taskId,
        workflowId: active.state.workflowId,
      };
      this.emitEnd(active.session, info, {
        taskId: active.state.taskId,
        status: 'failed',
        error: renderError(error),
      });
    }
  }

  private async runInstance(active: ActiveInstance, isResume = false): Promise<void> {
    const { controller, session, hostAgent, definition } = active;
    const signal = controller.signal;
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };

    if (!isResume) {
      active.state = { ...active.state, status: 'running', updatedAt: now() };
      await this.persistState(active);
      this.emitStart(session, info);
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
      createAgent: options => this.ctx.agents.create(options),
      getStepSessionEvents: async childId => {
        // live → 持久化回退：子代理 settle 后 live store 已移除，从 sessionPersistence
        // inspect 读完整事件（对齐 DSH `inspectApiRemoteSession` 的持久化读路径）。
        const live = this.ctx.sessions.get(SessionId(childId));
        if (live !== undefined) {
          return [...live.events];
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
      createAgent: (options: CreateAgentOptions) => this.ctx.agents.create(options),
      getStepSessionEvents: async (childId: string) => {
        const live = this.ctx.sessions.get(SessionId(childId));
        if (live !== undefined) {
          return [...live.events];
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
      this.emitStageStart(session, info, stageId);

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
        onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId, step.name ?? step.id, currentLoopIteration()),
        onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output, step.name ?? step.id, currentLoopIteration()),
        onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error, step.name ?? step.id, currentLoopIteration()),
        // 收尾阶段流转：commitFinalize 写入 currentPhase 后双发 sandore/step-phase，
        // 供 UI 不经 5s 轮询即时刷新（childId 缺省时回退 stepId 占位）。
        onPhaseChange: (step, childId, phase) => this.emitStepPhase(session, info, step.id, childId ?? step.id, phase, step.name ?? step.id, currentLoopIteration()),
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
          active.state = {
            ...active.state,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.errorDetail !== undefined ? { errorDetail: patch.errorDetail } : {}),
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
          if (entry.status === 'completed' && entry.sessionMeta?.synthetic === false) {
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
            // failed + 双发 sandore/step-failed + sandore/end（对齐 runAndCatch 语义与
            // handleRejectedQuestion 的显式落态写法）。findAskStep 返回 undefined 意味着
            // 所有 ask-detect Step 均无 askQuestion 载荷（有则必命中），故全部标 failed。
            this.ctx.logger.warn(
              `sandore: instance ${active.state.taskId} stage ${stageId} interacting without ask payload; marking failed`,
            );
            const errorMessage = 'finalize assess returned ask without askQuestion payload';
            const stuckSteps = active.state.executedSteps.filter(item => item.finalizeMeta?.currentPhase === 'ask-detect');
            for (const stuck of stuckSteps) {
              this.emitStepFailed(
                session,
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
            this.emitEnd(session, info, { taskId: info.taskId, status: 'failed', error: errorMessage });
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
          // false）followup 注回让子代理基于回答继续 → 回答写入 userMessages（kind:'answer'）
          // 统一时间轴 → 循环续跑（executor 重收集新 output + 重跑门禁）。
          const answer = await active.interactions.ask({ entry, ...(signal === undefined ? {} : { signal }) });
          // 缺陷 26：问答被拒（rejectQuestion 以 REJECTED_ANSWER 占位 resolve，非 reject——
          // 避免冒泡 runAndCatch 把整实例落 failed 且 Step 滞留 interacting）。检测占位标记后
          // 标 ask Step failed + 落 Stage/实例 failed（经显式代码非异常冒泡），对齐基准
          // rejectQuestion→StepRunner 标 failed 的本质。
          if (isRejectedAnswer(answer)) {
            await this.handleRejectedQuestion(active, stageId, ask, info, session, currentLoopIteration());
            return;
          }
          const answerText = buildAnswerText(answer);
          const childId = ask.step.sessionMeta?.childId;
          if (childId !== undefined && ask.step.sessionMeta?.synthetic === false) {
            await this.ctx.subagents.followup(hostAgent, childId, [{ type: 'text', text: answerText }], {
              source: { kind: 'user' },
              signal: controller.signal,
            });
          }
          active.state = {
            ...active.state,
            userMessages: [
              ...(active.state.userMessages ?? []),
              {
                id: globalThis.crypto.randomUUID(),
                kind: 'answer',
                target: ask.step.stepId ?? ask.step.id,
                content: answerText,
                createdAt: now(),
              },
            ],
            updatedAt: now(),
          };
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
        // abortInstance 已落 aborted 态并双发 sandore/aborted，此处仅在尚未落态时兜底
        // （`active.state.status !== 'aborted'` 守卫避免 sandore/aborted 双发）。
        this.markStageStatus(active, stageId, 'failed');
        if (active.state.status !== 'aborted') {
          // 兜底落 aborted 终态（正常路径 abortInstance 已落态、清表并移除冻结登记；
          // 兜底分支不触碰登记——abort 清表语义由 abortInstance 统一处理）。
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
          this.emitAborted(session, info);
        }
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
        // 落 failed 终态（保持冻结：工作流未成功完成，hostAgent 不恢复活跃）。
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
        this.emitEnd(session, info, {
          taskId: info.taskId,
          status: 'failed',
          ...(result.errorDetail === undefined ? {} : { error: result.errorDetail }),
        });
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
      this.emitStageCompleted(session, info, stageId, stageContract);

      if (!(await navigator.tryAdvanceStage(signal))) {
        stageId = '';
      } else {
        stageId = navigator.currentNodeId;
      }
    }

    // 工作流成功完成：落 completed 终态并解冻宿主主代理——**唯一解冻点**（failed/aborted
    // 终态不移除冻结登记，hostAgent 保持冻结）。引擎不 dispose hostAgent、ActiveInstance
    // 仍留 instances 表，解冻后 hostAgent 恢复普通响应。
    this.frozenHostAgents.delete(active.hostAgent.id);
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
    this.emitEnd(session, info, { taskId: info.taskId, status: 'completed' });
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
   * `executedSteps` + persist）+ 双发 `sandore/step-failed` + 落 Stage failed +
   * 实例 failed + 双发 `sandore/end`（failed）。经显式代码落态而非异常冒泡，对齐
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
    session: Session,
    loopIteration: number[] | undefined,
  ): Promise<void> {
    const stepEntry = ask.step;
    const stepId = stepEntry.stepId ?? stepEntry.id;
    const childId = stepEntry.sessionMeta?.childId ?? stepEntry.id;
    const name = stepEntry.name;
    const errorMessage = 'Question rejected by user';
    // 标 ask Step failed（写 executedSteps + persist）。该 Step 此前在 ask 保底中断
    // （executed.status=running + finalizeMeta currentPhase='ask-detect'，偏离 8），
    // StageExecutor 的 onStepFailed 钩子未对其触发（仅在 executor.execute() 内触发），
    // 故此处显式双发 sandore/step-failed。
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
    this.emitStepFailed(session, info, stepId, childId, errorMessage, name, loopIteration);
    // 落 Stage failed + 实例 failed（无 Stage 级失败容错 → 整实例 failed，但经显式
    // 代码非异常冒泡；Step 正确置 failed 而非滞留 interacting）。
    this.markStageStatus(active, stageId, 'failed');
    // 落 failed 终态（保持冻结：工作流未成功完成，hostAgent 不恢复活跃）。
    active.state = { ...active.state, status: 'failed', updatedAt: now() };
    await this.persistState(active);
    this.emitEnd(session, info, { taskId: info.taskId, status: 'failed', error: errorMessage });
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
        const sessionMeta = { ...entry.sessionMeta, childId, synthetic: false };
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
    const live = this.ctx.sessions.get(SessionId(childId));
    if (live !== undefined && live.events.length > 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    const again = this.ctx.sessions.get(SessionId(childId));
    if (again === undefined || again.events.length === 0) {
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
      persist: (entries) => {
        active.state = { ...active.state, pendingInteractions: entries, updatedAt: now() };
        void this.persistState(active);
      },
      emitQuestion: (entry) => this.emitQuestion(session, active, entry),
      emitPermission: (entry) => this.emitPermission(session, active, entry),
      emitQuestionRejected: (entry) => this.emitQuestionRejected(session, active, entry),
    });
    const lifecycle = new LifecycleManager({
      hostAgent,
      initialPausedChildIds: state.pausedChildIds,
      interrupt: (childId, authority) => this.ctx.subagents.interrupt(childId, authority),
      followup: async (childId, content, signal) => {
        await this.ctx.subagents.followup(hostAgent, childId, content, {
          source: { kind: 'user' },
          signal,
        });
      },
      getAgent: (childId) => this.ctx.agents.get(childId) ?? undefined,
      signal: controller.signal,
      readState: () => active.state,
      commitState: (next) => {
        active.state = next;
        void this.persistState(active);
      },
      appendUserMessage: (record) => {
        active.state = {
          ...active.state,
          userMessages: [...(active.state.userMessages ?? []), record],
          updatedAt: now(),
        };
        void this.persistState(active);
      },
      emitStepPaused: (stepId, childId, name, loopIteration) => this.emitStepPaused(session, active, stepId, childId, name, loopIteration),
      emitStepResumed: (stepId, childId, resumePrompt, name, loopIteration) => this.emitStepResumed(session, active, stepId, childId, resumePrompt, name, loopIteration),
    });
    const recovery = new RecoveryManager({
      signal: controller.signal,
      readState: () => active.state,
      commitState: (next) => {
        active.state = next;
        void this.persistState(active);
      },
      appendUserMessage: (record) => {
        active.state = {
          ...active.state,
          userMessages: [...(active.state.userMessages ?? []), record],
          updatedAt: now(),
        };
        void this.persistState(active);
      },
      followup: async (childId, content, signal) => {
        await this.ctx.subagents.followup(hostAgent, childId, content, {
          source: { kind: 'user' },
          signal,
        });
      },
      createAgent: (options) => {
        // 2026-08-25 real-e2e 修复：retryStep fork/revert 模式的 createAgent 传
        // meta.parentSession=源 childId（审计语义），但 DSH continuation 的 lineage
        // 校验要求 child.parentSession === followup 的 parent（宿主主代理）——源会话
        // 已 settle/dispose 时必然不匹配 → UNAUTHORIZED（「belongs to another parent
        // session」）。包装统一为宿主主代理（fork 源记录已由 recovery-manager 的
        // runningStep.parentSessionId 承载，不依赖 meta）。
        return this.ctx.agents.create({
          ...options,
          ...(options.meta === undefined ? {} : {
            meta: { ...options.meta, parentSession: hostAgent.id },
          }),
        });
      },
      getSession: (id) => {
        const child = this.ctx.sessions.get(SessionId(id));
        return child === undefined ? undefined : { events: child.events };
      },
      // 2026-08-25 real-e2e 修复：fork 源会话 live 已移除（子代理 settle/dispose）时，
      // `ctx.sessions.fork` 抛 SESSION_NOT_FOUND → retryStep fork 模式失败。改为
      // live → 持久化回退（对齐 getStepSessionEvents）：live 命中走 sessions.fork；
      // 否则从 sessionPersistence inspect 读事件构造 seed（recovery-manager 用
      // forked.events 作 createAgent 的 seed，无需 live 会话本体）。
      forkSession: async (source, boundary) => {
        const live = this.ctx.sessions.get(SessionId(source));
        if (live !== undefined) {
          const child = this.ctx.sessions.fork(SessionId(source), boundary);
          return { events: child.events };
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
      emitStepRetried: (stepId, mode, name, loopIteration) => this.emitStepRetried(session, active, stepId, mode, name, loopIteration),
      resumeExecution: () => this.resumeExecution(active),
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
    // 单一 `sandore/subagent-settled` 监听器：缓冲 settlement + 唤醒挂起 awaiter。
    // DSH 适配层（registerSubagentSettlementAdapter 把 DSH subagent/end 转译为本事件）
    // 与 mock FakeSubagents.settleChild 都经此通道；监听器存活于 active 生命周期。
    this.ctx.on('sandore/subagent-settled', (settlement: SubagentSettlement) => {
      active.settlementBuffer.set(settlement.childId, settlement);
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
          childId: step.sessionMeta?.childId ?? step.id,
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

  // ── 事件双发 ─────────────────────────────────────────────────────────────

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

  private safeAppend(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.ctx.logger.warn(`sandore: session append failed: ${renderError(error)}`);
    }
  }

  private emitStart(session: Session, info: DagRunInfo): void {
    this.emitContained('sandore/start', [info]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/start', { taskId: info.taskId, workflowId: info.workflowId }, { ignorable: true }));
  }

  private emitStageStart(session: Session, info: DagRunInfo, stageId: string): void {
    this.emitContained('sandore/stage-start', [info, stageId]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/stage-start', { taskId: info.taskId, stageId }, { ignorable: true }));
  }

  private emitStageCompleted(session: Session, info: DagRunInfo, stageId: string, stageContract: StageContract): void {
    this.emitContained('sandore/stage-completed', [info, stageId, stageContract]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/stage-completed', { taskId: info.taskId, stageId, stageContract }, { ignorable: true }));
  }

  private emitStepStart(session: Session, info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-start', [info, stepId, childId, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-start', { stepId, childId, name, ...(loopIteration === undefined ? {} : { loopIteration }) }, { ignorable: true }));
  }

  private emitStepCompleted(session: Session, info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[], name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-completed', [info, stepId, childId, output, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-completed', { stepId, childId, output, name, ...(loopIteration === undefined ? {} : { loopIteration }) }, { ignorable: true }));
  }

  private emitStepFailed(session: Session, info: DagRunInfo, stepId: string, childId: string, error: string, name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-failed', [info, stepId, childId, error, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-failed', { stepId, childId, error, name, ...(loopIteration === undefined ? {} : { loopIteration }) }, { ignorable: true }));
  }

  private emitStepPaused(session: Session, active: ActiveInstance, stepId: string, childId: string, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/step-paused', [info, stepId, childId, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-paused', { stepId, childId, name, ...(loopIteration === undefined ? {} : { loopIteration }) }, { ignorable: true }));
  }

  private emitStepResumed(session: Session, active: ActiveInstance, stepId: string, childId: string, resumePrompt: string | undefined, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/step-resumed', [info, stepId, childId, resumePrompt, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-resumed', { stepId, childId, ...(resumePrompt === undefined ? {} : { resumePrompt }), name, ...(loopIteration === undefined ? {} : { loopIteration }) }, { ignorable: true }));
  }

  private emitStepRetried(session: Session, active: ActiveInstance, stepId: string, mode: RetryMode, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/step-retried', [info, stepId, mode, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-retried', { stepId, mode, name, ...(loopIteration === undefined ? {} : { loopIteration }) }, { ignorable: true }));
  }

  /** 双发 `sandore/step-message`（Cordis `emit` + Session `append`，缺陷 31，供 UI 刷新）。 */
  private emitStepMessage(session: Session, info: DagRunInfo, stepId: string, childId: string, message: string, name: string): void {
    this.emitContained('sandore/step-message', [info, stepId, childId, message, name]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/step-message', { stepId, childId, message, name }, { ignorable: true }));
  }

  /**
   * 双发 `sandore/step-phase`（Cordis `emit` + Session `append`）。
   *
   * 收尾阶段流转（ask-detect/finalizing/gating/completed）由 microflow
   * `commitFinalize` 写入 `currentPhase` 时经 `onPhaseChange` 钩子透传到本方法；
   * Session append 载荷对齐 SessionEventMap（taskId 隐含于会话，不带入 data）。
   */
  private emitStepPhase(
    session: Session,
    info: DagRunInfo,
    stepId: string,
    childId: string,
    phase: FinalizePhase,
    name: string,
    loopIteration?: number[],
  ): void {
    this.emitContained('sandore/step-phase', [info, stepId, childId, phase, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)(
      'sandore/step-phase',
      { stepId, childId, phase, name, ...(loopIteration === undefined ? {} : { loopIteration }) },
      { ignorable: true },
    ));
  }

  private emitEnd(session: Session, info: DagRunInfo, result: DagResultInfo): void {
    this.emitContained('sandore/end', [info, result]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/end', { taskId: info.taskId, result }, { ignorable: true }));
  }

  private emitAborted(session: Session, info: DagRunInfo): void {
    this.emitContained('sandore/aborted', [info]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/aborted', { taskId: info.taskId }, { ignorable: true }));
  }

  private emitQuestion(session: Session, active: ActiveInstance, entry: PendingQuestionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/question', [info, entry]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/question', { question: entry }, { ignorable: true }));
  }

  private emitPermission(session: Session, active: ActiveInstance, entry: PendingPermissionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/permission', [info, entry]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/permission', { permission: entry }, { ignorable: true }));
  }

  /** 双发 `sandore/question_rejected`（Cordis `emit` + Session `append`，缺陷 26）。 */
  private emitQuestionRejected(session: Session, active: ActiveInstance, entry: PendingQuestionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
    };
    this.emitContained('sandore/question_rejected', [info, entry]);
    this.safeAppend(() => (session.append as SessionAppendWithIgnorable)('sandore/question_rejected', { question: entry }, { ignorable: true }));
  }
}
