/**
 * `createSandoreTools` 的单元测试：8 个工具名与转调映射、per-instance 闭包捕获、
 * completed/终态实例的结构化 no-op、`getState` 只读可用、`SandoreError` 摘要透传
 * 与 defineTool 形状（parameters/output）。
 * @module @deepseek-ai/dsh-sandore-tool/src/index.spec
 */
import { describe, expect, it, vi } from 'vitest';
import { SandoreError } from '@deepseek-ai/dsh-sandore-workflow/src/errors';
import { createSandoreTools } from "./index.js";
/** 构造一个字段完整的 `DagInstanceState` 快照。 */
function makeState(status) {
    return {
        taskId: 'inst-1',
        jobId: 'job-1',
        workflowId: 'wfl-1',
        status,
        originalInput: 'do the thing',
        currentStageId: '',
        executedSteps: [],
        stageInfos: [],
        pendingQueue: [],
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
    };
}
/** 构造一个用 `vi.fn` 打桩的引擎（getState 按入参 status 回放快照）。 */
function makeEngine(status = 'running') {
    return {
        getState: vi.fn(() => makeState(status)),
        startInstance: vi.fn(async (request) => ({ instanceId: 'inst-new', status: 'running' })),
        abortInstance: vi.fn(async () => { }),
        pauseStep: vi.fn(async () => { }),
        resumeStep: vi.fn(async () => { }),
        pauseAllSteps: vi.fn(async () => { }),
        resumeAllSteps: vi.fn(async () => { }),
        retryStep: vi.fn(async () => { }),
        recoverInstance: vi.fn(async () => ({ instanceId: 'inst-new', status: 'running' })),
        replyQuestion: vi.fn(async () => { }),
        replyPermission: vi.fn(async () => { }),
    };
}
/** 从工具数组按名称取单个工具定义。 */
function toolByName(tools, name) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
        throw new Error(`tool '${name}' not found`);
    }
    return tool;
}
/** 以空 exec 执行工具并收窄为结果信封。 */
async function run(tool, args) {
    return (await tool.execute(args, undefined));
}
describe('createSandoreTools', () => {
    it('returns 8 tools with the expected names', () => {
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: makeEngine() });
        expect(tools.map((tool) => tool.name)).toEqual([
            'sandore_getState',
            'sandore_startInstance',
            'sandore_abortInstance',
            'sandore_pauseStep',
            'sandore_resumeStep',
            'sandore_pauseAllSteps',
            'sandore_resumeAllPaused',
            'sandore_retryStep',
        ]);
    });
    it('declares defineTool-shaped name/description/parameters/output/render for every tool', () => {
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: makeEngine() });
        for (const tool of tools) {
            expect(tool.name).toMatch(/^sandore_/);
            expect(tool.description.length).toBeGreaterThan(0);
            expect(tool.parameters).toBeTypeOf('object');
            expect(tool.output).toBeDefined();
            expect(typeof tool.output.render).toBe('function');
        }
    });
    it('sandore_getState delegates to engine.getState with the captured instanceId and stays readable for any state', async () => {
        const engine = makeEngine('completed');
        const tools = createSandoreTools({ instanceId: 'inst-done', engine: engine });
        const result = await run(toolByName(tools, 'sandore_getState'), {});
        expect(engine.getState).toHaveBeenCalledWith('inst-done');
        expect(result).toMatchObject({ ok: true, state: { status: 'completed' } });
    });
    it('sandore_startInstance delegates to engine.startInstance with request args', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_startInstance'), {
            workflowId: 'wfl-1',
            jobId: 'job-1',
            originalInput: 'do it',
        });
        expect(engine.startInstance).toHaveBeenCalledWith({ workflowId: 'wfl-1', jobId: 'job-1', originalInput: 'do it' });
        expect(result).toMatchObject({ ok: true, run: { instanceId: 'inst-new', status: 'running' } });
    });
    it('sandore_startInstance forwards optional cwd when provided', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        await run(toolByName(tools, 'sandore_startInstance'), {
            workflowId: 'wfl-1',
            jobId: 'job-1',
            originalInput: 'do it',
            cwd: '/srv/app',
        });
        expect(engine.startInstance).toHaveBeenCalledWith({
            workflowId: 'wfl-1',
            jobId: 'job-1',
            originalInput: 'do it',
            cwd: '/srv/app',
        });
    });
    it('sandore_pauseStep delegates to engine.pauseStep with the captured instanceId', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_pauseStep'), { stepId: 'step-1' });
        expect(engine.pauseStep).toHaveBeenCalledWith('inst-1', 'step-1');
        expect(result).toEqual({ ok: true });
    });
    it('sandore_resumeStep delegates with optional resumePrompt', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_resumeStep'), { stepId: 'step-1', resumePrompt: 'please continue' });
        expect(engine.resumeStep).toHaveBeenCalledWith('inst-1', 'step-1', 'please continue');
        expect(result).toEqual({ ok: true });
    });
    it('sandore_resumeStep omits resumePrompt when absent', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        await run(toolByName(tools, 'sandore_resumeStep'), { stepId: 'step-1' });
        expect(engine.resumeStep).toHaveBeenCalledWith('inst-1', 'step-1', undefined);
    });
    it('sandore_pauseAllSteps delegates to engine.pauseAllSteps', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_pauseAllSteps'), {});
        expect(engine.pauseAllSteps).toHaveBeenCalledWith('inst-1');
        expect(result).toEqual({ ok: true });
    });
    it('sandore_resumeAllPaused delegates to engine.resumeAllSteps', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_resumeAllPaused'), { resumePrompt: 'resume all' });
        expect(engine.resumeAllSteps).toHaveBeenCalledWith('inst-1', 'resume all');
        expect(result).toEqual({ ok: true });
    });
    it('sandore_retryStep delegates with stepId/mode/message', async () => {
        const engine = makeEngine();
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_retryStep'), { stepId: 'step-1', mode: 'fork', message: 'redo' });
        expect(engine.retryStep).toHaveBeenCalledWith('inst-1', 'step-1', 'fork', 'redo');
        expect(result).toEqual({ ok: true });
    });
    it('sandore_abortInstance delegates to engine.abortInstance for a non-terminal instance', async () => {
        const engine = makeEngine('running');
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_abortInstance'), {});
        expect(engine.abortInstance).toHaveBeenCalledWith('inst-1');
        expect(result).toEqual({ ok: true });
    });
    it('returns a structured no-op (without calling the engine) for a completed instance on resume/retry/pause tools', async () => {
        const engine = makeEngine('completed');
        const tools = createSandoreTools({ instanceId: 'inst-done', engine: engine });
        for (const [name, args] of [
            ['sandore_resumeStep', { stepId: 'step-1' }],
            ['sandore_retryStep', { stepId: 'step-1', mode: 'continue', message: 'x' }],
            ['sandore_pauseStep', { stepId: 'step-1' }],
            ['sandore_pauseAllSteps', {}],
            ['sandore_resumeAllPaused', {}],
        ]) {
            const result = await run(toolByName(tools, name), args);
            expect(result.ok).toBe(false);
            expect(result.error).toBeUndefined();
            expect(result.reason).toMatch(/completed/);
        }
        expect(engine.resumeStep).not.toHaveBeenCalled();
        expect(engine.retryStep).not.toHaveBeenCalled();
        expect(engine.pauseStep).not.toHaveBeenCalled();
        expect(engine.pauseAllSteps).not.toHaveBeenCalled();
        expect(engine.resumeAllSteps).not.toHaveBeenCalled();
    });
    it('sandore_abortInstance returns a structured no-op for a terminal instance', async () => {
        const engine = makeEngine('aborted');
        const tools = createSandoreTools({ instanceId: 'inst-aborted', engine: engine });
        const result = await run(toolByName(tools, 'sandore_abortInstance'), {});
        expect(result.ok).toBe(false);
        expect(result.error).toBeUndefined();
        expect(result.reason).toMatch(/aborted/);
        expect(engine.abortInstance).not.toHaveBeenCalled();
    });
    it('sandore_retryStep still delegates for a failed instance (retry is the primary use case)', async () => {
        const engine = makeEngine('failed');
        const tools = createSandoreTools({ instanceId: 'inst-failed', engine: engine });
        const result = await run(toolByName(tools, 'sandore_retryStep'), { stepId: 'step-1', mode: 'continue', message: 'retry' });
        expect(engine.retryStep).toHaveBeenCalledWith('inst-failed', 'step-1', 'continue', 'retry');
        expect(result).toEqual({ ok: true });
    });
    it('returns an error summary when the engine throws SandoreError', async () => {
        const engine = makeEngine();
        engine.resumeStep.mockRejectedValue(new SandoreError('step not found', 'NODE_NOT_FOUND'));
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: engine });
        const result = await run(toolByName(tools, 'sandore_resumeStep'), { stepId: 'nope' });
        expect(result.ok).toBe(false);
        expect(result.error).toEqual({ code: 'NODE_NOT_FOUND', message: 'step not found' });
    });
    it('returns an error summary when getState throws SandoreError', async () => {
        const engine = makeEngine();
        engine.getState.mockImplementation(() => {
            throw new SandoreError('instance not found', 'NODE_NOT_FOUND');
        });
        const tools = createSandoreTools({ instanceId: 'inst-none', engine: engine });
        const result = await run(toolByName(tools, 'sandore_pauseStep'), { stepId: 'step-1' });
        expect(result.ok).toBe(false);
        expect(result.error).toEqual({ code: 'NODE_NOT_FOUND', message: 'instance not found' });
        expect(engine.pauseStep).not.toHaveBeenCalled();
    });
    it('declares resumeStep/retryStep parameter schemas with the required fields', () => {
        const tools = createSandoreTools({ instanceId: 'inst-1', engine: makeEngine() });
        expect(toolByName(tools, 'sandore_resumeStep').parameters).toMatchObject({
            properties: { stepId: { type: 'string' }, resumePrompt: { type: 'string' } },
            required: ['stepId'],
        });
        expect(toolByName(tools, 'sandore_retryStep').parameters).toMatchObject({
            properties: {
                stepId: { type: 'string' },
                mode: { type: 'string', enum: ['continue', 'revert', 'fork'] },
                message: { type: 'string' },
            },
            required: ['stepId', 'mode', 'message'],
        });
    });
});
//# sourceMappingURL=index.spec.js.map