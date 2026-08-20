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
import { z } from 'zod'

import type { WorkflowDefinitionRecord, WorkflowTaskState } from './schema.ts'

// ── wire 接口 ────────────────────────────────────────────────────────────────

/** `definitions` 表条目：记录键（workflowId）与 value 的合并。 */
export interface WorkflowDefinitionEntry extends WorkflowDefinitionRecord {
  id: string
}

/** 实例清单摘要（从 `state` 表派生）。 */
export interface InstanceSummary {
  instanceId: string
  workflowId: string
  /** 作业需求（创建实例时的原始输入，供列表直接展示，无需再查详情）。 */
  originalInput: string
  status: WorkflowTaskState['status']
  createdAt: string
  updatedAt: string
}

/** 实例产物条目（从 `stageContracts` 的产物契约扁平化）。 */
export interface ArtifactEntry {
  stepId: string
  stageId: string
  outputToId?: string
  files: string[]
  returnPrompt?: string
}

/**
 * `importDefinitionFromYaml` 结果（缺陷 30，对齐基准 created/updated/skipped 三态）。
 *
 * `matchedCount` 为按 `matchBy` 命中的现有记录数（created 时为 0；'id' 模式恒为
 * 0 或 1；'name' 模式可能 >1）。name 非唯一键：多匹配时取最新 `updatedAt` 的记录
 * （确定性策略，SA8），并在 `matchedCount` 注明命中数供调用方识别歧义。
 */
export interface ImportDefinitionResult {
  /** 导入动作：新建 / 更新（版本不同） / 跳过（同版本已存在）。 */
  status: 'created' | 'updated' | 'skipped'
  /** 命中或新建的记录 id（created 时为 createDefinition 生成的新 `wfl-{uuid}`）。 */
  id: string
  /** 导入后的定义 name（与 YAML 顶层 name 一致；skipped 时为现有记录 name）。 */
  name: string
  /** matchBy 命中的现有记录数（created 时为 0）。 */
  matchedCount: number
}

// ── 入参 zod schema ──────────────────────────────────────────────────────────

/** `createDefinition` 入参：仅承载 YAML 文本。 */
export const CreateDefinitionInputSchema = z.object({
  yaml: z.string(),
})

/**
 * `importDefinitionFromYaml` 入参（缺陷 30）：幂等导入 YAML 文本。
 *
 * `matchBy` 选匹配现有定义的键，默认 `name`。因 `createDefinition` 强制生成
 * 新 `wfl-{uuid}` 并改写 YAML 顶层 id（remote.spec 锁定此行为），按 name 查找
 * 是唯一能在「复用 createDefinition/updateYaml 本体不改」约束下实现幂等导入
 * 的身份策略（应答文档缺陷 30 修复计划点 2「关键前置」推荐后者）。`matchBy:'id'`
 * 按 YAML 顶层 id 直接查 `definitions` 表；标准 `createDefinition` 路径产生的记录
 * 键为 `wfl-{uuid}` 而非 YAML 原始 id，故 'id' 模式仅在记录曾以 YAML id 为键
 * 存储时可命中——对任意文件的幂等重放导入，请用默认 'name'。
 */
export const ImportDefinitionInputSchema = z.object({
  yaml: z.string(),
  matchBy: z.enum(['id', 'name']).optional(),
})

/** `updateDefinition` 入参：可更新的元数据字段。 */
export const UpdateDefinitionInputSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
})

/** 创建实例时选择的模型（对齐 DSH `ModelSelection`）。 */
export const StartModelSelectionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

/** `startInstance` 入参（去 job 概念：直接绑定工作流定义 + 工作目录 + 模型/权限）。 */
export const StartInstanceInputSchema = z.object({
  workflowId: z.string(),
  originalInput: z.string(),
  cwd: z.string().optional(),
  model: StartModelSelectionSchema.optional(),
  permission: z.string().optional(),
})

/** 单个问题回答的 zod 校验（对齐 DSH `AskUserQuestionAnswerItem`）。 */
export const AskUserQuestionAnswerItemSchema = z.object({
  id: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
})

/** 用户整批回答的 zod 校验（对齐 DSH `AskUserQuestionAnswer`）。 */
export const AskUserQuestionAnswerSchema = z.object({
  answers: z.array(AskUserQuestionAnswerItemSchema),
})

/** `replyQuestion` 入参。 */
export const ReplyQuestionInputSchema = z.object({
  instanceId: z.string(),
  requestId: z.string(),
  answers: AskUserQuestionAnswerSchema,
})

/** `rejectQuestion` 入参（拒绝单个问答 → 标对应 Step failed，缺陷 26）。 */
export const RejectQuestionInputSchema = z.object({
  instanceId: z.string(),
  requestId: z.string(),
})

/** `replyPermission` 入参（`reply` 限定 once/always/reject）。 */
export const ReplyPermissionInputSchema = z.object({
  instanceId: z.string(),
  requestId: z.string(),
  reply: z.enum(['once', 'always', 'reject']),
})

/**
 * `updateInstancePermissionMode` 入参（缺陷 29）：运行中切换实例权限模式。
 *
 * `mode` 限定三档预设（对齐 `PERMISSION_SPECS` 与 DSH permission-presets）。
 * 转发 `ctx.sandoreEngine.setPermissionMode`：对宿主 session + hostAgent 重新
 * 应用 sandbox 模式 + 审批策略（DSH 折叠读取，下次受限调用生效）；终态实例
 * 拒绝。详见 {@link ./workflow-engine.ts SandoreEngineRuntime.setPermissionMode}。
 */
export const UpdateInstancePermissionModeInputSchema = z.object({
  instanceId: z.string(),
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
})

/** `pauseStep` 入参。 */
export const PauseStepInputSchema = z.object({
  instanceId: z.string(),
  stepId: z.string(),
})

/** `resumeStep` 入参（可选恢复提示词）。 */
export const ResumeStepInputSchema = z.object({
  instanceId: z.string(),
  stepId: z.string(),
  resumePrompt: z.string().optional(),
})

/** `pauseAll` 入参。 */
export const PauseAllInputSchema = z.object({
  instanceId: z.string(),
})

/** `resumeAll` 入参（可选统一恢复提示词）。 */
export const ResumeAllInputSchema = z.object({
  instanceId: z.string(),
  resumePrompt: z.string().optional(),
})

/** `retryStep` 入参（`mode` 限定 continue/revert/fork；revert 可选 `revertBoundary`）。 */
export const RetryStepInputSchema = z.object({
  instanceId: z.string(),
  stepId: z.string(),
  mode: z.enum(['continue', 'revert', 'fork']),
  message: z.string(),
  /** 可选：revert 模式用户所选闭合 turn/end 的事件 seq；省略 = 最后一个闭合 turn/end。 */
  revertBoundary: z.number().optional(),
})

/** revert 回退点候选（一个闭合 turn 的 `turn/end` 事件 seq + turn 编号 + 文本预览）。 */
export const RevertBoundaryOptionSchema = z.object({
  /** 闭合 turn 的 `turn/end` 事件 seq（传给 `retryStep` 的 `revertBoundary`）。 */
  seq: z.number(),
  /** turn 编号（事件 `data.turn`；展示用「Turn N+1」）。 */
  turn: z.number(),
  /** 该 turn 内 assistant 文本块预览（前 80 字符；无 assistant 文本则为空串）。 */
  preview: z.string(),
})

/** `listRevertBoundaries` 入参（实例 + 目标 Step）。 */
export const ListRevertBoundariesInputSchema = z.object({
  instanceId: z.string(),
  stepId: z.string(),
})

/** `recoverInstance` 入参（单实例崩溃恢复）。 */
export const RecoverInstanceInputSchema = z.object({
  instanceId: z.string(),
})

/**
 * `sendStepMessage` 入参（缺陷 31）：向运行中实例的指定 Step 子代理追加一条
 * 用户消息（@mention 语义）。
 *
 * @mention 由 UI 端 @Step 选择器产出 `stepId`，引擎端不做文本解析。`message`
 * 至少 1 字符（空串无意义且与 followup 调用约定相悖）。转发
 * `ctx.sandoreEngine.sendStepMessage`：requireActive + 终态守卫 → 按 stepId
 * 反查最后活跃段 sessionMeta.childId → synthetic===false 才 subagents.followup
 * （synthetic 步骤抛 INVALID_OPERATION）→ 追加 userMessages `{kind:'message',
 * target:stepId}`（不复用 'input'，避免污染 originalInput 语义）→ persistState →
 * 双发 `sandore/step-message`。详见 {@link ./workflow-engine.ts SandoreEngineRuntime.sendStepMessage}。
 */
export const SendStepMessageInputSchema = z.object({
  instanceId: z.string(),
  stepId: z.string(),
  message: z.string().min(1),
})

/** `recoverOrphanedInstances` 的批量恢复结果（对齐基准 GET /jobs 恢复触发）。 */
export interface RecoverOrphanedInstancesResult {
  /** 成功恢复（重新进入内存登记表）的实例 id 列表。 */
  recovered: string[]
  /** 逐实例恢复失败的错误摘要（单实例失败不阻断其余恢复）。 */
  errors: Array<{ instanceId: string; error: string }>
}

export type CreateDefinitionInput = z.infer<typeof CreateDefinitionInputSchema>
export type ImportDefinitionInput = z.infer<typeof ImportDefinitionInputSchema>
export type UpdateDefinitionInput = z.infer<typeof UpdateDefinitionInputSchema>
export type StartModelSelectionInput = z.infer<typeof StartModelSelectionSchema>
export type StartInstanceInput = z.infer<typeof StartInstanceInputSchema>
export type ReplyQuestionInput = z.infer<typeof ReplyQuestionInputSchema>
export type RejectQuestionInput = z.infer<typeof RejectQuestionInputSchema>
export type ReplyPermissionInput = z.infer<typeof ReplyPermissionInputSchema>
export type UpdateInstancePermissionModeInput = z.infer<typeof UpdateInstancePermissionModeInputSchema>
export type PauseStepInput = z.infer<typeof PauseStepInputSchema>
export type ResumeStepInput = z.infer<typeof ResumeStepInputSchema>
export type PauseAllInput = z.infer<typeof PauseAllInputSchema>
export type ResumeAllInput = z.infer<typeof ResumeAllInputSchema>
export type RetryStepInput = z.infer<typeof RetryStepInputSchema>
export type RevertBoundaryOption = z.infer<typeof RevertBoundaryOptionSchema>
export type ListRevertBoundariesInput = z.infer<typeof ListRevertBoundariesInputSchema>
export type RecoverInstanceInput = z.infer<typeof RecoverInstanceInputSchema>
export type SendStepMessageInput = z.infer<typeof SendStepMessageInputSchema>

// ── ping ─────────────────────────────────────────────────────────────────────

/** `sandore.ping` 的桩返回数据（非真实引擎状态）。 */
export interface PingResponse {
  /** 恒为 true，表示往返成功。 */
  pong: boolean
  /** 服务命名空间标识。 */
  service: string
  /** Host 侧生成的时间戳（ISO 8601 字符串）。 */
  time: string
}
