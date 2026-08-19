import { z } from "zod";
//#region src/schema.ts
/**
* 工作流引擎的 Zod Schema 与派生 TS 类型（浏览器安全）。
*
* 记录 schema（存储域 value / 业务数据模型）用真实 `zod`（`z.infer` 保持类型不重复，
* 同一 schema 后续可投影为 RPC wire schema）；插件 `Config` 才用 schemastery（见
* `index.ts`）。分三层：定义层（`WorkflowDefinition`/`WorkflowStage`/`WorkflowStep`/
* `CommandConfig` 五类型 discriminated union）、运行时层（`WorkflowTaskState`，无
* `permissionMode`）、记录层（`WorkflowDefinitionRecord`/`JobRecord`）。
*
* 本模块仅依赖 `zod`（浏览器安全），存储域声明 `sandoreDomainSpec`（依赖 Node 侧
* `@deepseek-ai/dsh-storage-domain`）已拆至 `./domain.ts`，故可作为 `./schema`
* 子路径在浏览器侧安全导入。
* @module @deepseek-ai/dsh-sandore-workflow/src/schema
*/
/** Step 与 Stage 共用的执行状态枚举。 */
const StepStatusSchema = z.enum([
	"blocked",
	"ready",
	"interacting",
	"running",
	"completed",
	"failed",
	"paused"
]);
/** 工作流实例生命周期状态枚举。 */
const DagRunStatusSchema = z.enum([
	"pending",
	"running",
	"interacting",
	"completed",
	"failed",
	"aborted",
	"paused"
]);
/**
* 内容块（merge-extensible）：只约束 `type` 为字符串、保留其余字段以支持
* round-trip（对齐 DSH apiproxy 的 `contentBlockSchema` 范式）。
*/
const ContentBlockSchema = z.looseObject({ type: z.string() });
/**
* 五种 Step 命令的 discriminated union。判别字段为顶层 `type`，变体字段整体
* 嵌套于 `value`（对齐权威 YAML 示例 `command: { type: shell, value: { command } }`）。
*/
const CommandConfigSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("agent"),
		value: z.object({
			promptText: z.string(),
			agentParamsTemplate: z.string().optional(),
			providerId: z.string().optional(),
			modelId: z.string().optional()
		})
	}),
	z.object({
		type: z.literal("prompt"),
		value: z.object({
			promptText: z.string(),
			providerId: z.string().optional(),
			modelId: z.string().optional()
		})
	}),
	z.object({
		type: z.literal("shell"),
		value: z.object({ command: z.string() })
	}),
	z.object({
		type: z.literal("skill"),
		value: z.object({
			promptText: z.string(),
			providerId: z.string().optional()
		})
	}),
	z.object({
		type: z.literal("mcp"),
		value: z.object({ promptText: z.string() })
	})
]);
/** Step 输入绑定项：`path` 为引用的 Step id（简化格式，单段），`regex` 对 Step 输出文本做正则匹配。 */
const InputFromItemSchema = z.object({
	id: z.string(),
	path: z.string().optional(),
	regex: z.string().optional()
});
/** Step 输出绑定项：`path`/`regex` 为产物文件路径（支持 glob/regex）。 */
const OutputToItemSchema = z.object({
	id: z.string(),
	path: z.string().optional(),
	regex: z.string().optional()
});
/** Step 透传变量。 */
const PassThroughVarSchema = z.object({
	name: z.string(),
	value: z.string(),
	description: z.string(),
	refresh: z.boolean().optional()
});
/** 透传变量的键值记录值（运行时状态 / Stage 契约共用）。 */
const PassThroughVarValueSchema = z.object({
	value: z.string(),
	description: z.string(),
	refresh: z.boolean().optional()
});
/** DAG 循环控制（挂在分支上的可选属性：该分支 next 指向更早节点 = 回边）。 */
const DagLoopSchema = z.object({
	breakCondition: CommandConfigSchema.optional(),
	breakExpectation: z.string().optional(),
	next: z.string().optional(),
	maxIterations: z.number(),
	exitTo: z.string().optional()
});
/**
* DAG 分支：分支是唯一出边单元，统一 `{ next, condition?, loop? }` 三并列字段。
* - 无 `condition` = 并行分支（始终纳入下一批，多条并发）；
* - 有 `condition` = 条件分支（布尔判定：AI 输出 true/false，shell 走
*   `matchesExpectation(breakExpectation)`，true 才走）；
* - 有 `loop` = 循环分支（该分支 `next` 为回边，`loop` 控制迭代/跳出/exitTo）。
*/
const DagBranchSchema = z.object({
	next: z.string(),
	label: z.string().optional(),
	condition: CommandConfigSchema.optional(),
	loop: DagLoopSchema.optional()
});
/** 门控配置（Workflow/Stage/Step 三级合并）。 */
const GatesSchema = z.object({
	maxRetries: z.number().optional(),
	maxTokens: z.number().optional(),
	primary: z.object({ enabled: z.boolean() }).optional(),
	secondary: z.object({
		enabled: z.boolean(),
		prompt: z.string().optional()
	}).optional(),
	need_confirm: z.boolean().optional()
});
/** 工作流默认设置（与 `dynamic-workflow-engine.md` 的 `DEFAULT_SETTINGS` 对齐）。 */
const DEFAULT_SETTINGS = {
	defaultTimeout: 120,
	maxConcurrentAgents: 4
};
/** 工作流设置：`defaultTimeout`（分钟）默认 120，`maxConcurrentAgents` 默认 4。 */
const WorkflowSettingsSchema = z.object({
	defaultTimeout: z.number().default(DEFAULT_SETTINGS.defaultTimeout),
	maxConcurrentAgents: z.number().default(DEFAULT_SETTINGS.maxConcurrentAgents)
});
/** 单个 Step 定义（V2 顶层 `steps[]` 完整定义：命令 + 映射 + 透传变量 + 门控）。 */
const WorkflowStepSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	command: CommandConfigSchema.optional(),
	inputFrom: z.array(InputFromItemSchema).optional(),
	outputTo: z.array(OutputToItemSchema).optional(),
	passThroughVars: z.array(PassThroughVarSchema).optional(),
	timeout: z.number().optional(),
	defaultExpectation: z.string().optional(),
	rules: z.array(z.string()).optional(),
	gates: GatesSchema.optional()
});
/**
* Stage 内 Step 位置（V2 分离式：仅 id + 流控 branches；完整定义在顶层 `steps[]`
* 按 id 交叉引用）。
*/
const StageStepSchema = z.object({
	id: z.string(),
	branches: z.array(DagBranchSchema).optional()
});
/** 单个 Stage 定义：内部 Step 流控（轻量）+ Stage 级 DAG 字段（出边统一进 branches）。 */
const WorkflowStageSchema = z.object({
	id: z.string(),
	name: z.string(),
	rules: z.array(z.string()).optional(),
	gates: GatesSchema.optional(),
	steps: z.array(StageStepSchema),
	defaultExpectation: z.string().optional(),
	branches: z.array(DagBranchSchema).optional()
});
/** 工作流定义（V2 两级 Stage → Step）。 */
const WorkflowDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	description: z.string().optional(),
	engine: z.string().optional(),
	skills: z.array(z.string()).default([]),
	mcps: z.array(z.string()).default([]),
	agents: z.array(z.string()).default([]),
	settings: WorkflowSettingsSchema.default(DEFAULT_SETTINGS),
	rules: z.record(z.string(), z.string()).optional(),
	gates: GatesSchema.optional(),
	stages: z.array(WorkflowStageSchema),
	steps: z.array(WorkflowStepSchema).optional()
});
/** Step 会话合成占位元数据（替代 SDK 时代的 `{sessionId,inputJson,outputJson,partsJson}`）。 */
const StepSessionMetaSchema = z.object({
	childId: z.string(),
	synthetic: z.boolean(),
	command: z.enum([
		"shell",
		"prompt",
		"agent",
		"skill",
		"mcp"
	]),
	hostSessionId: z.string().optional()
});
/** 向用户提问的载荷（对齐 DSH `ask_user_question`）。 */
const AskUserQuestionPayloadSchema = z.object({ questions: z.array(z.object({
	id: z.string(),
	question: z.string(),
	header: z.string().optional(),
	options: z.array(z.object({
		label: z.string(),
		description: z.string().optional()
	})).optional(),
	multi_select: z.boolean().optional()
})) });
/** pending 交互条目状态：`pending` 待回复、`replied` 已回复、`rejected` 已拒绝。 */
const PendingInteractionStatusSchema = z.enum([
	"pending",
	"replied",
	"rejected"
]);
/** 待回复问答条目（`pendingInteractions` 的 question 变体）。 */
const PendingQuestionEntrySchema = z.object({
	id: z.string(),
	stageId: z.string(),
	stepId: z.string(),
	sessionId: z.string(),
	requestId: z.string(),
	kind: z.literal("question"),
	status: PendingInteractionStatusSchema,
	payload: AskUserQuestionPayloadSchema,
	answer: z.array(z.array(z.string())).optional(),
	createdAt: z.string()
});
/** 待回复权限条目载荷（permission/patterns/metadata/tool）。 */
const PendingPermissionPayloadSchema = z.object({
	permission: z.string(),
	patterns: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	tool: z.string().optional()
});
/** 待回复权限条目（`pendingInteractions` 的 permission 变体）。 */
const PendingPermissionEntrySchema = z.object({
	id: z.string(),
	stageId: z.string(),
	stepId: z.string(),
	sessionId: z.string(),
	requestId: z.string(),
	kind: z.literal("permission"),
	status: PendingInteractionStatusSchema,
	payload: PendingPermissionPayloadSchema,
	answer: z.enum([
		"once",
		"always",
		"reject"
	]).optional(),
	createdAt: z.string()
});
/** 收尾第 1 部分（Assessor）结果。 */
const FinalizeAssessResultSchema = z.object({
	completionType: z.enum(["completed", "ask"]),
	passThroughVars: z.record(z.string(), z.string()),
	askQuestion: AskUserQuestionPayloadSchema.optional(),
	errorDetail: z.string().optional(),
	forkSessionId: z.string(),
	assessmentRaw: z.string()
});
/** 收尾第 2 部分（GateEvaluator）结果。 */
const GateEvalResultSchema = z.object({
	gatesPassed: z.boolean(),
	primaryPassed: z.boolean().optional(),
	secondaryPassed: z.boolean().optional(),
	gateDetails: z.object({
		primary: z.object({
			enabled: z.boolean(),
			passed: z.boolean().optional()
		}),
		secondary: z.object({
			enabled: z.boolean(),
			passed: z.boolean().optional(),
			prompt: z.string().optional()
		})
	}).optional(),
	errorDetail: z.string().optional(),
	gateSessionId: z.string(),
	assessmentRaw: z.string()
});
/** Step 收尾状态元数据。 */
const FinalizeMetaSchema = z.object({
	status: z.enum([
		"evaluating",
		"completed",
		"ask"
	]),
	sessionId: z.string().optional(),
	gateSessionId: z.string().optional(),
	directory: z.string().optional(),
	errorDetail: z.string().optional(),
	completionType: z.enum(["completed", "ask"]).optional(),
	assessResult: FinalizeAssessResultSchema.optional(),
	gateResult: GateEvalResultSchema.optional()
});
/** 分支/循环评估元数据。 */
const BranchMetaSchema = z.object({
	result: z.string().optional(),
	sessionId: z.string().optional(),
	directory: z.string().optional(),
	status: z.enum(["evaluating", "completed"]),
	expectation: z.string().optional()
});
/** 会话消息记录。 */
const SessionMessageSchema = z.object({
	type: z.enum([
		"text",
		"tool",
		"reasoning"
	]),
	text: z.string().optional(),
	tool: z.string().optional(),
	args: z.unknown().optional(),
	output: z.unknown().optional()
});
/** 重试历史记录。 */
const RetryRecordSchema = z.object({
	mode: z.enum([
		"continue",
		"revert",
		"fork"
	]),
	timestamp: z.string(),
	userMessage: z.string(),
	revertMessageId: z.string().optional(),
	result: z.enum([
		"running",
		"completed",
		"failed"
	])
});
/** 用户在执行过程中的消息（原始需求 / 恢复 / 重试，统一时间轴渲染）。 */
const UserMessageRecordSchema = z.object({
	id: z.string(),
	/** 消息种类：input=原始需求 / resume=继续消息 / retry=重试消息 / answer=ask 回答。 */
	kind: z.enum([
		"input",
		"resume",
		"retry",
		"answer"
	]),
	/** 目标：'broadcast'（广播）或 Step 定义 id（定点）；input 时为 ''。 */
	target: z.string(),
	/** 用户消息文本。 */
	content: z.string(),
	/** 消息时间（ISO；统一时间轴排序键）。 */
	createdAt: z.string()
});
/** 已执行 Step 的默认实现快照。 */
const ExecutedStepDefaultSchema = z.object({
	id: z.string(),
	stepId: z.string().optional(),
	stageId: z.string(),
	name: z.string(),
	status: StepStatusSchema,
	command: CommandConfigSchema.optional(),
	inputFrom: z.array(InputFromItemSchema).optional(),
	outputTo: z.array(OutputToItemSchema).optional(),
	passThroughVars: z.array(PassThroughVarSchema).optional(),
	sessionMeta: StepSessionMetaSchema.optional(),
	finalizeMeta: FinalizeMetaSchema.optional(),
	visitCount: z.number(),
	/** 本执行段开始时间（ISO；统一时间轴排序键，替代对 startedAt 的可选依赖）。 */
	createdAt: z.string().optional(),
	/** 执行段序号（同 stepId 第几次执行段；0-based，缺省 0 = 首次执行）。 */
	attemptIndex: z.number().int().nonnegative().optional(),
	/** Step 开始执行的时间（ISO；引擎写入，供 UI 展示相对时间）。 */
	startedAt: z.string().optional(),
	/** Step 最近一次状态变更的时间（ISO；running 后每次转态更新，供 UI 展示相对时间）。 */
	updatedAt: z.string().optional(),
	branchMeta: BranchMetaSchema.optional(),
	error: z.string().optional(),
	pausedAt: z.string().optional(),
	sessionMessages: z.array(SessionMessageSchema).optional(),
	pauseEntryId: z.string().optional(),
	loopIteration: z.array(z.number()).optional(),
	loopMeta: BranchMetaSchema.optional(),
	retryHistory: z.array(RetryRecordSchema).optional(),
	parentSessionId: z.string().optional(),
	output: z.array(ContentBlockSchema).optional()
});
/** 单个 Stage 的状态快照。 */
const StageInfoSchema = z.object({
	id: z.string(),
	name: z.string(),
	status: StepStatusSchema
});
/** Stage 完成时对外暴露的产物契约。 */
const StageContractSchema = z.object({
	stageId: z.string(),
	stageName: z.string(),
	status: StepStatusSchema,
	artifacts: z.array(z.object({
		stepId: z.string(),
		outputToId: z.string(),
		files: z.array(z.string()),
		returnPrompt: z.string().optional()
	})),
	passThroughVars: z.record(z.string(), PassThroughVarValueSchema),
	contractArtifacts: z.record(z.string(), z.array(z.string())),
	completedAt: z.string(),
	errorDetail: z.string().optional()
});
/** 工作流实例的持久化状态快照（存储域 `state` 表 value）。 */
const WorkflowTaskStateSchema = z.object({
	taskId: z.string(),
	/** 兼容旧版 job 关联（去 job 概念后新实例不写；旧快照保留以通过校验）。 */
	jobId: z.string().optional(),
	workflowId: z.string(),
	/** 工作流名称（启动时从定义写入；持久化快照携带，供 UI 树标题展示）。 */
	workflowName: z.string().optional(),
	/** 工作流描述（启动时从定义写入；供执行详情 head 展示，旧实例可能缺）。 */
	description: z.string().optional(),
	/** 创建实例时选择的模型（弹窗传入；作为该实例的 L2 默认模型路由）。 */
	modelSelection: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().optional()
	}).optional(),
	/** 创建实例时选择的权限预设（read-only / workspace-write / danger-full-access）。 */
	permission: z.string().optional(),
	cwd: z.string(),
	status: DagRunStatusSchema,
	originalInput: z.string(),
	currentStageId: z.string(),
	executedSteps: z.array(ExecutedStepDefaultSchema),
	stageInfos: z.array(StageInfoSchema),
	pendingInteractions: z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema])),
	pendingQueue: z.array(z.string()),
	visitCounts: z.record(z.string(), z.number()),
	passThroughVars: z.record(z.string(), PassThroughVarValueSchema),
	activeLoopIterationStack: z.array(z.number()),
	activeLoopNodeId: z.string().nullable(),
	activeLoopStack: z.array(z.string()),
	pausedChildIds: z.array(z.string()),
	/** 用户指令消息（恢复/重试；统一时间轴渲染，初始需求由 originalInput 承载）。 */
	userMessages: z.array(UserMessageRecordSchema).optional(),
	stageContracts: z.record(z.string(), StageContractSchema),
	createdAt: z.string(),
	updatedAt: z.string()
});
/** 工作流定义记录（`definitions` 表 value）：YAML 文本封顶 65536 字符防失控。 */
const WorkflowDefinitionRecordSchema = z.object({
	yaml: z.string().max(65536),
	name: z.string(),
	version: z.string(),
	description: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string()
});
//#endregion
export { AskUserQuestionPayloadSchema, BranchMetaSchema, CommandConfigSchema, DagBranchSchema, DagLoopSchema, ExecutedStepDefaultSchema, FinalizeAssessResultSchema, FinalizeMetaSchema, GateEvalResultSchema, GatesSchema, InputFromItemSchema, OutputToItemSchema, PassThroughVarSchema, PendingPermissionEntrySchema, PendingQuestionEntrySchema, RetryRecordSchema, SessionMessageSchema, StageContractSchema, StageInfoSchema, StageStepSchema, StepSessionMetaSchema, UserMessageRecordSchema, WorkflowDefinitionRecordSchema, WorkflowDefinitionSchema, WorkflowSettingsSchema, WorkflowStageSchema, WorkflowStepSchema, WorkflowTaskStateSchema };
