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
// ── 入参 zod schema ──────────────────────────────────────────────────────────
/** `createDefinition` 入参：仅承载 YAML 文本。 */
export const CreateDefinitionInputSchema = z.object({
    yaml: z.string(),
});
/** `updateDefinition` 入参：可更新的元数据字段。 */
export const UpdateDefinitionInputSchema = z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
});
/** 创建实例时选择的模型（对齐 DSH `ModelSelection`）。 */
export const StartModelSelectionSchema = z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
});
/** `startInstance` 入参（去 job 概念：直接绑定工作流定义 + 工作目录 + 模型/权限）。 */
export const StartInstanceInputSchema = z.object({
    workflowId: z.string(),
    originalInput: z.string(),
    cwd: z.string().optional(),
    model: StartModelSelectionSchema.optional(),
    permission: z.string().optional(),
});
/** 单个问题回答的 zod 校验（对齐 DSH `AskUserQuestionAnswerItem`）。 */
export const AskUserQuestionAnswerItemSchema = z.object({
    id: z.string(),
    selected: z.array(z.string()),
    custom: z.string().optional(),
});
/** 用户整批回答的 zod 校验（对齐 DSH `AskUserQuestionAnswer`）。 */
export const AskUserQuestionAnswerSchema = z.object({
    answers: z.array(AskUserQuestionAnswerItemSchema),
});
/** `replyQuestion` 入参。 */
export const ReplyQuestionInputSchema = z.object({
    instanceId: z.string(),
    requestId: z.string(),
    answers: AskUserQuestionAnswerSchema,
});
/** `replyPermission` 入参（`reply` 限定 once/always/reject）。 */
export const ReplyPermissionInputSchema = z.object({
    instanceId: z.string(),
    requestId: z.string(),
    reply: z.enum(['once', 'always', 'reject']),
});
/** `pauseStep` 入参。 */
export const PauseStepInputSchema = z.object({
    instanceId: z.string(),
    stepId: z.string(),
});
/** `resumeStep` 入参（可选恢复提示词）。 */
export const ResumeStepInputSchema = z.object({
    instanceId: z.string(),
    stepId: z.string(),
    resumePrompt: z.string().optional(),
});
/** `pauseAll` 入参。 */
export const PauseAllInputSchema = z.object({
    instanceId: z.string(),
});
/** `resumeAll` 入参（可选统一恢复提示词）。 */
export const ResumeAllInputSchema = z.object({
    instanceId: z.string(),
    resumePrompt: z.string().optional(),
});
/** `retryStep` 入参（`mode` 限定 continue/revert/fork）。 */
export const RetryStepInputSchema = z.object({
    instanceId: z.string(),
    stepId: z.string(),
    mode: z.enum(['continue', 'revert', 'fork']),
    message: z.string(),
});
//# sourceMappingURL=wire.js.map