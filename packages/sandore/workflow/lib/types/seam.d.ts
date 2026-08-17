/**
 * sandore 工作流引擎的 capability seam。
 *
 * 定义 `ctx.sandoreEngine` 抽象接口（`SandoreEngine extends Service`）、
 * 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）
 * 与空 Provider 桩（`SandoreEngineStub`）。真实执行逻辑见 `workflow-engine.ts`。
 * @module @deepseek-ai/dsh-sandore-workflow/src/seam
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';
import type { AskUserQuestionAnswer, AskUserQuestionItem, DagResultInfo, DagRun, DagRunInfo, DagStartRequest, DagInstanceState, PendingPermissionEntry, PendingQuestionEntry, StageContract } from './types.ts';
import type { SandoreEngineSurface } from './engine-surface.ts';
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
        'sandore/question'(info: DagRunInfo, question: PendingQuestionEntry): void;
        'sandore/permission'(info: DagRunInfo, permission: PendingPermissionEntry): void;
        'sandore/end'(info: DagRunInfo, result: DagResultInfo): void;
        'sandore/aborted'(info: DagRunInfo): void;
    }
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'sandore/start': {
            taskId: string;
            workflowId: string;
            jobId: string;
        };
        'sandore/stage-start': {
            taskId: string;
            stageId: string;
        };
        'sandore/stage-completed': {
            taskId: string;
            stageId: string;
            stageContract: StageContract;
        };
        'sandore/step-start': {
            stepId: string;
            childId: string;
            name: string;
            loopIteration?: number[];
        };
        'sandore/step-completed': {
            stepId: string;
            childId: string;
            output: ContentBlock[];
            name: string;
            loopIteration?: number[];
        };
        'sandore/step-failed': {
            stepId: string;
            childId: string;
            error: string;
            name: string;
            loopIteration?: number[];
        };
        'sandore/step-paused': {
            stepId: string;
            childId: string;
            name: string;
            loopIteration?: number[];
        };
        'sandore/step-resumed': {
            stepId: string;
            childId: string;
            resumePrompt?: string;
            name: string;
            loopIteration?: number[];
        };
        'sandore/step-retried': {
            stepId: string;
            mode: string;
            name: string;
            loopIteration?: number[];
        };
        'sandore/question': {
            question: PendingQuestionEntry;
        };
        'sandore/permission': {
            permission: PendingPermissionEntry;
        };
        'sandore/end': {
            taskId: string;
            jobId: string;
            result: DagResultInfo;
        };
        'sandore/aborted': {
            taskId: string;
        };
    }
}
/**
 * 工作流引擎的 Service Definition。
 *
 * Service 层只暴露实例级操作（start/recover/abort/reply/pause/resume/retry/getState），
 * 定义/Job 的 CRUD 与实例讨论/产物查询放在 Host RPC 层（见 `remote.ts`）。
 */
export declare abstract class SandoreEngine extends Service implements SandoreEngineSurface {
    constructor(ctx: Context);
    /** 启动一个新的工作流实例。 */
    abstract startInstance(request: DagStartRequest): Promise<DagRun>;
    /** 恢复一个已存在的工作流实例。 */
    abstract recoverInstance(instanceId: string): Promise<DagRun>;
    /** 中止一个运行中的工作流实例。 */
    abstract abortInstance(instanceId: string): Promise<void>;
    /** 回复一个待处理问答请求。 */
    abstract replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void>;
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
    /** 重试单个 Step。 */
    abstract retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>;
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
 * 仅声明依赖注入与配置 schema；11 个方法抛 `not implemented`。
 * 真实执行逻辑在 `SandoreEngineRuntime`（`workflow-engine.ts`）。
 */
export declare class SandoreEngineStub extends SandoreEngine {
    static Config: z<SandoreConfig>;
    static inject: string[];
    startInstance(request: DagStartRequest): Promise<DagRun>;
    recoverInstance(instanceId: string): Promise<DagRun>;
    abortInstance(instanceId: string): Promise<void>;
    replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void>;
    replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void>;
    pauseStep(instanceId: string, stepId: string): Promise<void>;
    resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;
    pauseAllSteps(instanceId: string): Promise<void>;
    resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;
    retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>;
    getState(instanceId: string): DagInstanceState;
}
//# sourceMappingURL=seam.d.ts.map