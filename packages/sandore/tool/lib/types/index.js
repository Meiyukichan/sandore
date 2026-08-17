/** 无参工具的 JSON Schema。 */
const NO_ARGS_SCHEMA = { type: 'object', properties: {} };
/** `sandore_startInstance` 的 JSON Schema。 */
const START_INSTANCE_SCHEMA = {
    type: 'object',
    properties: {
        workflowId: { type: 'string', description: '工作流定义 ID。' },
        jobId: { type: 'string', description: 'Job ID。' },
        originalInput: { type: 'string', description: '用户原始需求。' },
        cwd: { type: 'string', description: '可选工作目录。' },
    },
    required: ['workflowId', 'jobId', 'originalInput'],
};
/** 单个 Step 参数的 JSON Schema。 */
const STEP_SCHEMA = {
    type: 'object',
    properties: {
        stepId: { type: 'string', description: 'Step ID。' },
    },
    required: ['stepId'],
};
/** `sandore_resumeStep` 的 JSON Schema（`resumePrompt` 可选）。 */
const RESUME_STEP_SCHEMA = {
    type: 'object',
    properties: {
        stepId: { type: 'string', description: 'Step ID。' },
        resumePrompt: { type: 'string', description: '可选恢复提示词。' },
    },
    required: ['stepId'],
};
/** `sandore_resumeAllPaused` 的 JSON Schema（`resumePrompt` 可选）。 */
const RESUME_ALL_SCHEMA = {
    type: 'object',
    properties: {
        resumePrompt: { type: 'string', description: '可选恢复提示词。' },
    },
};
/** `sandore_retryStep` 的 JSON Schema（`mode` 枚举 + 必填 `stepId`/`message`）。 */
const RETRY_STEP_SCHEMA = {
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
const RESULT_SCHEMA = {
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
const TOOL_OUTPUT = {
    schema: RESULT_SCHEMA,
    render: (_args, value) => {
        const text = JSON.stringify(value) ?? '';
        return [{ type: 'text', text }];
    },
};
/** 实例的终态集合（completed/failed/aborted，供 abort 的 no-op 判定）。 */
const TERMINAL_STATUSES = ['completed', 'failed', 'aborted'];
/** `status` 是否为终态。 */
function isTerminalStatus(status) {
    return TERMINAL_STATUSES.includes(status);
}
/** 构造成功结果信封。 */
function successResult() {
    return { ok: true };
}
/** 构造 no-op 结果信封（含人类可读原因）。 */
function noOpResult(reason) {
    return { ok: false, reason };
}
/** 从任意抛出值提取 `SandoreError` 摘要（结构判定，不 import 运行时）。 */
function summarizeError(err) {
    if (!(err instanceof Error)) {
        return { code: 'UNKNOWN', message: String(err) };
    }
    const code = 'code' in err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
    return { code, message: err.message };
}
/** 构造错误结果信封（engine 抛出的 `SandoreError` 摘要透传）。 */
function errorResult(err) {
    const summary = summarizeError(err);
    return { ok: false, reason: summary.message, error: summary };
}
/** 执行操作并把任何抛错映射为错误结果（不向调用方裸抛）。 */
async function withErrorHandling(operation) {
    try {
        return await operation();
    }
    catch (err) {
        return errorResult(err);
    }
}
/** 读实例状态；completed 时返回 no-op，否则执行 operation。 */
async function runUnlessCompleted(engine, instanceId, toolName, operation) {
    const state = engine.getState(instanceId);
    if (state.status === 'completed') {
        return noOpResult(`instance '${instanceId}' is completed; ${toolName} is a no-op`);
    }
    await operation();
    return successResult();
}
/** 读实例状态；终态时返回 no-op，否则执行 abort。 */
async function abortUnlessTerminal(engine, instanceId) {
    const state = engine.getState(instanceId);
    if (isTerminalStatus(state.status)) {
        return noOpResult(`instance '${instanceId}' is ${state.status}; abort is a no-op`);
    }
    await engine.abortInstance(instanceId);
    return successResult();
}
/** 把工具规格封装为 `defineTool` 形状的结构化定义（注册表已按 schema 校验 args）。 */
function makeTool(spec) {
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TOOL_OUTPUT,
        // 注册表（DSH defineTool / register）在调用 execute 前已按 `parameters` 校验并收窄
        // `args`；此处仅恢复编译期类型，不做二次校验。
        execute: (args, _exec) => withErrorHandling(() => spec.execute(args)),
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
export function createSandoreTools(options) {
    const { instanceId, engine } = options;
    return [
        makeTool({
            name: 'sandore_getState',
            description: '查询当前工作流实例的状态快照（只读，任意状态均可用）。',
            parameters: NO_ARGS_SCHEMA,
            execute: () => ({ ok: true, state: engine.getState(instanceId) }),
        }),
        makeTool({
            name: 'sandore_startInstance',
            description: '启动一个新的工作流实例，返回运行句柄（instanceId + status）。',
            parameters: START_INSTANCE_SCHEMA,
            execute: async (args) => {
                const request = {
                    workflowId: args.workflowId,
                    jobId: args.jobId,
                    originalInput: args.originalInput,
                    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
                };
                return { ok: true, run: await engine.startInstance(request) };
            },
        }),
        makeTool({
            name: 'sandore_abortInstance',
            description: '中止当前工作流实例；对终态（completed/failed/aborted）返回 no-op。',
            parameters: NO_ARGS_SCHEMA,
            execute: () => abortUnlessTerminal(engine, instanceId),
        }),
        makeTool({
            name: 'sandore_pauseStep',
            description: '暂停实例内指定的 Step。',
            parameters: STEP_SCHEMA,
            execute: (args) => runUnlessCompleted(engine, instanceId, 'sandore_pauseStep', () => engine.pauseStep(instanceId, args.stepId)),
        }),
        makeTool({
            name: 'sandore_resumeStep',
            description: '恢复实例内已暂停的 Step（可选附带恢复提示词）。',
            parameters: RESUME_STEP_SCHEMA,
            execute: (args) => runUnlessCompleted(engine, instanceId, 'sandore_resumeStep', () => engine.resumeStep(instanceId, args.stepId, args.resumePrompt)),
        }),
        makeTool({
            name: 'sandore_pauseAllSteps',
            description: '暂停实例内所有 Step。',
            parameters: NO_ARGS_SCHEMA,
            execute: () => runUnlessCompleted(engine, instanceId, 'sandore_pauseAllSteps', () => engine.pauseAllSteps(instanceId)),
        }),
        makeTool({
            name: 'sandore_resumeAllPaused',
            description: '恢复实例内所有已暂停的 Step（可选附带恢复提示词）。',
            parameters: RESUME_ALL_SCHEMA,
            execute: (args) => runUnlessCompleted(engine, instanceId, 'sandore_resumeAllPaused', () => engine.resumeAllSteps(instanceId, args.resumePrompt)),
        }),
        makeTool({
            name: 'sandore_retryStep',
            description: '重试实例内指定的 Step（continue/revert/fork 三模式）。',
            parameters: RETRY_STEP_SCHEMA,
            execute: (args) => runUnlessCompleted(engine, instanceId, 'sandore_retryStep', () => engine.retryStep(instanceId, args.stepId, args.mode, args.message)),
        }),
    ];
}
//# sourceMappingURL=index.js.map