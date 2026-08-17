/**
 * sandore 工作流引擎的 capability seam。
 *
 * 定义 `ctx.sandoreEngine` 抽象接口（`SandoreEngine extends Service`）、
 * 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）
 * 与空 Provider 桩（`SandoreEngineStub`）。真实执行逻辑见 `workflow-engine.ts`。
 * @module @deepseek-ai/dsh-sandore-workflow/src/seam
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/**
 * 工作流引擎的 Service Definition。
 *
 * Service 层只暴露实例级操作（start/recover/abort/reply/pause/resume/retry/getState），
 * 定义/Job 的 CRUD 与实例讨论/产物查询放在 Host RPC 层（见 `remote.ts`）。
 */
export class SandoreEngine extends Service {
    constructor(ctx) {
        super(ctx, 'sandoreEngine');
    }
}
/**
 * 空 Provider 桩。
 *
 * 仅声明依赖注入与配置 schema；11 个方法抛 `not implemented`。
 * 真实执行逻辑在 `SandoreEngineRuntime`（`workflow-engine.ts`）。
 */
export class SandoreEngineStub extends SandoreEngine {
    static Config = z.object({
        defaultTimeoutMs: z.natural().default(7200000),
        maxConcurrentSteps: z.natural().default(0),
        defaultProvider: z.string(),
        defaultModel: z.string(),
    });
    static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions', 'sessionTitle'];
    startInstance(request) {
        throw new Error('SandoreEngineStub.startInstance is not implemented');
    }
    recoverInstance(instanceId) {
        throw new Error('SandoreEngineStub.recoverInstance is not implemented');
    }
    abortInstance(instanceId) {
        throw new Error('SandoreEngineStub.abortInstance is not implemented');
    }
    replyQuestion(instanceId, requestId, answers) {
        throw new Error('SandoreEngineStub.replyQuestion is not implemented');
    }
    replyPermission(instanceId, requestId, reply) {
        throw new Error('SandoreEngineStub.replyPermission is not implemented');
    }
    pauseStep(instanceId, stepId) {
        throw new Error('SandoreEngineStub.pauseStep is not implemented');
    }
    resumeStep(instanceId, stepId, resumePrompt) {
        throw new Error('SandoreEngineStub.resumeStep is not implemented');
    }
    pauseAllSteps(instanceId) {
        throw new Error('SandoreEngineStub.pauseAllSteps is not implemented');
    }
    resumeAllSteps(instanceId, resumePrompt) {
        throw new Error('SandoreEngineStub.resumeAllSteps is not implemented');
    }
    retryStep(instanceId, stepId, mode, message) {
        throw new Error('SandoreEngineStub.retryStep is not implemented');
    }
    getState(instanceId) {
        throw new Error('SandoreEngineStub.getState is not implemented');
    }
}
//# sourceMappingURL=seam.js.map