/**
 * sandore Host RPC 的 wire 类型面（type-only，供 typert 生成物 .d.ts 引用）。
 *
 * 本文件仅承载 `sandore.*` Remote 边界的入参/结果类型与对应 zod 入参 schema，
 * 无 Cordis `Context` 依赖（`ctx.sandorePersistence`/`ctx.sandoreEngine` 的
 * 声明在 `seam.ts`）。将 wire 类型从 `remote.ts` 拆出，使 `./types` 子路径
 * 可被 microflow/ui 等下游包以 `import type` 消费，而不把 `remote.ts` 的运行时
 * `SandoreRemote` 类一并卷入其编译程序。
 * @module @deepseek-ai/dsh-sandore-workflow/src/wire
 */
import { z } from 'zod';
import type { JobRecord, WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts';
/** `definitions` 表条目：记录键（workflowId）与 value 的合并。 */
export interface WorkflowDefinitionEntry extends WorkflowDefinitionRecord {
    id: string;
}
/** `jobs` 表条目：记录键（jobId）与 value 的合并。 */
export interface JobEntry extends JobRecord {
    id: string;
}
/** 实例清单摘要（从 `state` 表派生）。 */
export interface InstanceSummary {
    instanceId: string;
    jobId: string;
    workflowId: string;
    status: WorkflowTaskState['status'];
    createdAt: string;
    updatedAt: string;
}
/** 实例产物条目（从 `stageContracts` 的产物契约扁平化）。 */
export interface ArtifactEntry {
    stepId: string;
    stageId: string;
    outputToId?: string;
    files: string[];
    returnPrompt?: string;
}
/** `createDefinition` 入参：仅承载 YAML 文本。 */
export declare const CreateDefinitionInputSchema: z.ZodObject<{
    yaml: z.ZodString;
}, z.core.$strip>;
/** `updateDefinition` 入参：可更新的元数据字段。 */
export declare const UpdateDefinitionInputSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** `createJob` 入参。 */
export declare const CreateJobInputSchema: z.ZodObject<{
    name: z.ZodString;
    workflowId: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** `updateJob` 入参。 */
export declare const UpdateJobInputSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** `startInstance` 入参。 */
export declare const StartInstanceInputSchema: z.ZodObject<{
    jobId: z.ZodString;
    originalInput: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** 单个问题回答的 zod 校验（对齐 DSH `AskUserQuestionAnswerItem`）。 */
export declare const AskUserQuestionAnswerItemSchema: z.ZodObject<{
    id: z.ZodString;
    selected: z.ZodArray<z.ZodString>;
    custom: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** 用户整批回答的 zod 校验（对齐 DSH `AskUserQuestionAnswer`）。 */
export declare const AskUserQuestionAnswerSchema: z.ZodObject<{
    answers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        selected: z.ZodArray<z.ZodString>;
        custom: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** `replyQuestion` 入参。 */
export declare const ReplyQuestionInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
    requestId: z.ZodString;
    answers: z.ZodObject<{
        answers: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            selected: z.ZodArray<z.ZodString>;
            custom: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
/** `replyPermission` 入参（`reply` 限定 once/always/reject）。 */
export declare const ReplyPermissionInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
    requestId: z.ZodString;
    reply: z.ZodEnum<{
        once: "once";
        always: "always";
        reject: "reject";
    }>;
}, z.core.$strip>;
/** `pauseStep` 入参。 */
export declare const PauseStepInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
    stepId: z.ZodString;
}, z.core.$strip>;
/** `resumeStep` 入参（可选恢复提示词）。 */
export declare const ResumeStepInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
    stepId: z.ZodString;
    resumePrompt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** `pauseAll` 入参。 */
export declare const PauseAllInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
}, z.core.$strip>;
/** `resumeAll` 入参（可选统一恢复提示词）。 */
export declare const ResumeAllInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
    resumePrompt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** `retryStep` 入参（`mode` 限定 continue/revert/fork）。 */
export declare const RetryStepInputSchema: z.ZodObject<{
    instanceId: z.ZodString;
    stepId: z.ZodString;
    mode: z.ZodEnum<{
        continue: "continue";
        revert: "revert";
        fork: "fork";
    }>;
    message: z.ZodString;
}, z.core.$strip>;
export type CreateDefinitionInput = z.infer<typeof CreateDefinitionInputSchema>;
export type UpdateDefinitionInput = z.infer<typeof UpdateDefinitionInputSchema>;
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;
export type UpdateJobInput = z.infer<typeof UpdateJobInputSchema>;
export type StartInstanceInput = z.infer<typeof StartInstanceInputSchema>;
export type ReplyQuestionInput = z.infer<typeof ReplyQuestionInputSchema>;
export type ReplyPermissionInput = z.infer<typeof ReplyPermissionInputSchema>;
export type PauseStepInput = z.infer<typeof PauseStepInputSchema>;
export type ResumeStepInput = z.infer<typeof ResumeStepInputSchema>;
export type PauseAllInput = z.infer<typeof PauseAllInputSchema>;
export type ResumeAllInput = z.infer<typeof ResumeAllInputSchema>;
export type RetryStepInput = z.infer<typeof RetryStepInputSchema>;
/** `sandore.ping` 的桩返回数据（非真实引擎状态）。 */
export interface PingResponse {
    /** 恒为 true，表示往返成功。 */
    pong: boolean;
    /** 服务命名空间标识。 */
    service: string;
    /** Host 侧生成的时间戳（ISO 8601 字符串）。 */
    time: string;
}
//# sourceMappingURL=wire.d.ts.map