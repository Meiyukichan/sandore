/**
 * sandore 工作流引擎的 8 个编排器模型工具。
 *
 * 以 `defineTool` 形状（`name`/`description`/`parameters`/`output`/`execute`）导出
 * 结构化工具定义，经宿主主代理 `setup(agentCtx)` 的 `agentCtx.tools.register` 逐个
 * 注册。工具 `execute` 全部转调 `engine` 实例级方法并闭包捕获 `instanceId`，不持有
 * 业务状态；对 completed 实例的 resume/retry/pause 类工具与终态实例的 abort 返回
 * 结构化 no-op（含原因），`getState` 对任意状态只读可用；engine 抛出的 `SandoreError`
 * 摘要透传为错误结果。
 *
 * 本包对 workflow 仅 `import type`（依赖方向 tool → workflow 单向 type-only），
 * 无任何运行时 import。
 * @module @deepseek-ai/dsh-sandore-tool/src/index
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type {
  DagInstanceState,
  DagRun,
  DagRunStatus,
  DagStartRequest,
} from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { SandoreEngineSurface } from '@deepseek-ai/dsh-sandore-workflow/src/engine-surface';

/** 创建编排器工具的入参。 */
export interface CreateSandoreToolsOptions {
  /** 工作流实例 ID（每个工具 execute 闭包捕获）。 */
  readonly instanceId: string;
  /** 工作流引擎实例（工具逻辑全部转调其方法）。 */
  readonly engine: SandoreEngineSurface;
}

/** engine 抛出的 `SandoreError` 摘要（稳定 `code` + 人类可读 `message`）。 */
export interface SandoreErrorSummary {
  /** 稳定机器可路由错误码。 */
  readonly code: string;
  /** 人类可读错误信息。 */
  readonly message: string;
}

/** 工具统一执行结果信封。 */
export interface SandoreToolResult {
  /** 操作是否成功；no-op 与错误均返回 false。 */
  readonly ok: boolean;
  /** `ok === false` 时的人类可读原因（no-op 或错误说明）。 */
  readonly reason?: string;
  /** engine 抛出的 `SandoreError` 摘要（仅错误场景存在）。 */
  readonly error?: SandoreErrorSummary;
  /** `sandore_getState` 的状态快照。 */
  readonly state?: DagInstanceState;
  /** `sandore_startInstance` 返回的运行句柄。 */
  readonly run?: DagRun;
}

/** `defineTool` 形状的结构化工具定义（DSH `ToolDefinition` 最小结构面）。 */
export interface SandoreToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ContentBlock[];
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

/** 无参工具的 args 形状（仅用作编译期类型）。 */
type NoArgs = Record<string, never>;

/** `sandore_startInstance` 的入参。 */
interface StartInstanceArgs {
  readonly workflowId: string;
  readonly originalInput: string;
  readonly cwd?: string;
}

/** `sandore_pauseStep` 的入参。 */
interface StepArgs {
  readonly stepId: string;
}

/** `sandore_resumeStep` 的入参。 */
interface ResumeStepArgs {
  readonly stepId: string;
  readonly resumePrompt?: string;
}

/** `sandore_resumeAllPaused` 的入参。 */
interface ResumeAllArgs {
  readonly resumePrompt?: string;
}

/** `sandore_retryStep` 的入参。 */
interface RetryStepArgs {
  readonly stepId: string;
  readonly mode: 'continue' | 'revert' | 'fork';
  readonly message: string;
}

/** 无参工具的 JSON Schema。 */
const NO_ARGS_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

/** `sandore_startInstance` 的 JSON Schema。 */
const START_INSTANCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    workflowId: { type: 'string', description: '工作流定义 ID。' },
    originalInput: { type: 'string', description: '用户原始需求。' },
    cwd: { type: 'string', description: '可选工作目录。' },
  },
  required: ['workflowId', 'originalInput'],
};

/** 单个 Step 参数的 JSON Schema。 */
const STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    stepId: { type: 'string', description: 'Step ID。' },
  },
  required: ['stepId'],
};

/** `sandore_resumeStep` 的 JSON Schema（`resumePrompt` 可选）。 */
const RESUME_STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    stepId: { type: 'string', description: 'Step ID。' },
    resumePrompt: { type: 'string', description: '可选恢复提示词。' },
  },
  required: ['stepId'],
};

/** `sandore_resumeAllPaused` 的 JSON Schema（`resumePrompt` 可选）。 */
const RESUME_ALL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    resumePrompt: { type: 'string', description: '可选恢复提示词。' },
  },
};

/** `sandore_retryStep` 的 JSON Schema（`mode` 枚举 + 必填 `stepId`/`message`）。 */
const RETRY_STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    stepId: { type: 'string', description: 'Step ID。' },
    mode: {
      type: 'string',
      enum: ['continue', 'revert', 'fork'],
      description: '重试模式：continue（同会话续跑）/ revert（回退后续跑）/ fork（新会话重试）。',
    },
    message: { type: 'string', description: '重试附带的提示消息。' },
  },
  required: ['stepId', 'mode', 'message'],
};

/** 工具结果信封的 JSON Schema（`ok` 必填，其余按需存在）。 */
const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    error: { type: 'object' },
    state: { type: 'object' },
    run: { type: 'object' },
  },
  required: ['ok'],
};

/** 工具结果的 `output` 声明（共享：schema + 纯 render 投影）。 */
const TOOL_OUTPUT: SandoreToolDefinition['output'] = {
  schema: RESULT_SCHEMA,
  render: (_args: unknown, value: unknown): ContentBlock[] => {
    const text = JSON.stringify(value) ?? '';
    return [{ type: 'text', text }];
  },
};

/** 实例的终态集合（completed/failed/aborted，供 abort 的 no-op 判定）。 */
const TERMINAL_STATUSES: readonly DagRunStatus[] = ['completed', 'failed', 'aborted'];

/** `status` 是否为终态。 */
function isTerminalStatus(status: DagRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 构造成功结果信封。 */
function successResult(): SandoreToolResult {
  return { ok: true };
}

/** 构造 no-op 结果信封（含人类可读原因）。 */
function noOpResult(reason: string): SandoreToolResult {
  return { ok: false, reason };
}

/** 从任意抛出值提取 `SandoreError` 摘要（结构判定，不 import 运行时）。 */
function summarizeError(err: unknown): SandoreErrorSummary {
  if (!(err instanceof Error)) {
    return { code: 'UNKNOWN', message: String(err) };
  }
  const code = 'code' in err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
  return { code, message: err.message };
}

/** 构造错误结果信封（engine 抛出的 `SandoreError` 摘要透传）。 */
function errorResult(err: unknown): SandoreToolResult {
  const summary = summarizeError(err);
  return { ok: false, reason: summary.message, error: summary };
}

/** 执行操作并把任何抛错映射为错误结果（不向调用方裸抛）。 */
async function withErrorHandling(operation: () => SandoreToolResult | Promise<SandoreToolResult>): Promise<SandoreToolResult> {
  try {
    return await operation();
  } catch (err) {
    return errorResult(err);
  }
}

/** 读实例状态；completed 时返回 no-op，否则执行 operation。 */
async function runUnlessCompleted(
  engine: SandoreEngineSurface,
  instanceId: string,
  toolName: string,
  operation: () => Promise<void>,
): Promise<SandoreToolResult> {
  const state = engine.getState(instanceId);
  if (state.status === 'completed') {
    return noOpResult(`instance '${instanceId}' is completed; ${toolName} is a no-op`);
  }
  await operation();
  return successResult();
}

/** 读实例状态；终态时返回 no-op，否则执行 abort。 */
async function abortUnlessTerminal(engine: SandoreEngineSurface, instanceId: string): Promise<SandoreToolResult> {
  const state = engine.getState(instanceId);
  if (isTerminalStatus(state.status)) {
    return noOpResult(`instance '${instanceId}' is ${state.status}; abort is a no-op`);
  }
  await engine.abortInstance(instanceId);
  return successResult();
}

/** 单个工具规格：`args` 为已校验参数的类型化视图。 */
interface ToolSpec<A> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: A): SandoreToolResult | Promise<SandoreToolResult>;
}

/** 把工具规格封装为 `defineTool` 形状的结构化定义（注册表已按 schema 校验 args）。 */
function makeTool<A>(spec: ToolSpec<A>): SandoreToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: TOOL_OUTPUT,
    // 注册表（DSH defineTool / register）在调用 execute 前已按 `parameters` 校验并收窄
    // `args`；此处仅恢复编译期类型，不做二次校验。
    execute: (args: unknown, _exec: unknown) => withErrorHandling(() => spec.execute(args as A)),
  };
}

/**
 * 创建 8 个 `sandore_*` 编排器工具。
 *
 * 每个工具 `execute` 转调 `engine` 的对应实例级方法并闭包捕获 `instanceId`；工具不
 * 持有任何业务状态。返回数组可经宿主主代理 `setup(agentCtx)` 内
 * `agentCtx.tools.register(tool)` 逐个注册。
 * @param options - 实例 ID 与引擎实例。
 * @returns 8 个工具定义（名称与转调映射见 spec）。
 */
export function createSandoreTools(options: CreateSandoreToolsOptions): SandoreToolDefinition[] {
  const { instanceId, engine } = options;

  return [
    makeTool<NoArgs>({
      name: 'sandore_getState',
      description: '查询当前工作流实例的状态快照（只读，任意状态均可用）。',
      parameters: NO_ARGS_SCHEMA,
      execute: () => ({ ok: true, state: engine.getState(instanceId) }),
    }),

    makeTool<StartInstanceArgs>({
      name: 'sandore_startInstance',
      description: '启动一个新的工作流实例，返回运行句柄（instanceId + status）。',
      parameters: START_INSTANCE_SCHEMA,
      execute: async (args) => {
        const request: DagStartRequest = {
          workflowId: args.workflowId,
          originalInput: args.originalInput,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        };
        return { ok: true, run: await engine.startInstance(request) };
      },
    }),

    makeTool<NoArgs>({
      name: 'sandore_abortInstance',
      description: '中止当前工作流实例；对终态（completed/failed/aborted）返回 no-op。',
      parameters: NO_ARGS_SCHEMA,
      execute: () => abortUnlessTerminal(engine, instanceId),
    }),

    makeTool<StepArgs>({
      name: 'sandore_pauseStep',
      description: '暂停实例内指定的 Step。',
      parameters: STEP_SCHEMA,
      execute: (args) =>
        runUnlessCompleted(engine, instanceId, 'sandore_pauseStep', () => engine.pauseStep(instanceId, args.stepId)),
    }),

    makeTool<ResumeStepArgs>({
      name: 'sandore_resumeStep',
      description: '恢复实例内已暂停的 Step（可选附带恢复提示词）。',
      parameters: RESUME_STEP_SCHEMA,
      execute: (args) =>
        runUnlessCompleted(engine, instanceId, 'sandore_resumeStep', () => engine.resumeStep(instanceId, args.stepId, args.resumePrompt)),
    }),

    makeTool<NoArgs>({
      name: 'sandore_pauseAllSteps',
      description: '暂停实例内所有 Step。',
      parameters: NO_ARGS_SCHEMA,
      execute: () => runUnlessCompleted(engine, instanceId, 'sandore_pauseAllSteps', () => engine.pauseAllSteps(instanceId)),
    }),

    makeTool<ResumeAllArgs>({
      name: 'sandore_resumeAllPaused',
      description: '恢复实例内所有已暂停的 Step（可选附带恢复提示词）。',
      parameters: RESUME_ALL_SCHEMA,
      execute: (args) =>
        runUnlessCompleted(engine, instanceId, 'sandore_resumeAllPaused', () => engine.resumeAllSteps(instanceId, args.resumePrompt)),
    }),

    makeTool<RetryStepArgs>({
      name: 'sandore_retryStep',
      description: '重试实例内指定的 Step（continue/revert/fork 三模式）。',
      parameters: RETRY_STEP_SCHEMA,
      execute: (args) =>
        runUnlessCompleted(engine, instanceId, 'sandore_retryStep', () => engine.retryStep(instanceId, args.stepId, args.mode, args.message)),
    }),
  ];
}
