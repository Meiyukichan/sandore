import { SandoreError, isFatalSandoreError } from "@deepseek-ai/dsh-sandore-microflow/src/errors";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { parseDocument, stringify } from "yaml";
import { Service } from "@deepseek-ai/cordis";
import z$1 from "@deepseek-ai/schemastery";
import { BranchEvaluator, matchesExpectation } from "@deepseek-ai/dsh-sandore-microflow/src/branch-evaluator";
import { LoopManager } from "@deepseek-ai/dsh-sandore-microflow/src/loop-manager";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { SessionId } from "@deepseek-ai/dsh-session";
import { FinalizeManager } from "@deepseek-ai/dsh-sandore-microflow/src/finalize-manager";
import { StageExecutor } from "@deepseek-ai/dsh-sandore-microflow/src/stage-executor";
//#region src/yaml-error.ts
/**
* YAML 解析或工作流定义校验失败（浏览器安全，仅继承 `Error`）。
*
* `code` 为稳定机器码（`YAML_PARSE` 语法错误 / `DEFINITION_INVALID` Zod 或引用
* 完整性校验失败），`cause` 挂原始 `ZodError` 供诊断。
*/
var WorkflowYamlError = class extends Error {
	/** 稳定机器可路由错误码。 */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.name = "WorkflowYamlError";
		this.code = code;
	}
};
//#endregion
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
//#region src/domain.ts
/**
* sandore 存储域声明（Node 侧）。
*
* `sandoreDomainSpec` 依赖 `@deepseek-ai/dsh-storage-domain`（Node 侧 cordis 插件），
* 故从浏览器安全的 `schema.ts` 拆出至此，使定义层 schema 可作为 `./schema` 子路径
* 在浏览器侧安全导入。定义/Job/状态三表的 value schema 仍来自 `./schema.ts`（纯 zod）。
* @module @deepseek-ai/dsh-sandore-workflow/src/domain
*/
/** sandore 存储域声明：两表 `definitions`/`state`，Zod 校验每一条记录（去 job 概念）。 */
const sandoreDomainSpec = defineDomain({
	name: "sandore",
	version: 1,
	tables: {
		definitions: domainTable(WorkflowDefinitionRecordSchema),
		state: domainTable(WorkflowTaskStateSchema)
	}
});
//#endregion
//#region src/yaml-parser.ts
/**
* 工作流 YAML 的 V1/V2 双格式解析与序列化（浏览器安全）。
*
* `parseWorkflowYaml` 用 `yaml` 包的 `parseDocument(text, { prettyErrors: true })`
* 解析（语法错误抛 `WorkflowYamlError('YAML_PARSE')`），检测 V1（`stages[].scenarios[]`）
* 并自动 `convertLegacyToV2()` 转两级 `stages[].steps[]`，再走 `WorkflowDefinitionSchema`
* 验证（失败抛 `WorkflowYamlError('DEFINITION_INVALID', { cause })`），最后做 `next`
* 引用完整性校验。`serializeWorkflowYaml` 序列化结果可被再次解析且深层相等。
* @module @deepseek-ai/dsh-sandore-workflow/src/yaml-parser
*/
/** V1 旧 `PromptConfig` 类型名 → V2 `CommandConfig` 类型名的映射。 */
const PROMPT_TYPE_TO_COMMAND_TYPE = {
	Bash: "shell",
	PromptTemplate: "prompt",
	AgentTemplate: "agent",
	SkillTemplate: "skill",
	McpTemplate: "mcp"
};
/** 将旧 `PromptConfig` 类型名映射为 V2 命令类型名（未知类型回退为 `prompt`）。 */
function promptToCommandType(type) {
	return PROMPT_TYPE_TO_COMMAND_TYPE[type] ?? "prompt";
}
/** 收窄任意值为 `Record<string, unknown>`。 */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 渲染单个 YAML 语法错误，附行列信息。 */
function describeYamlError(error) {
	const position = error.linePos?.[0];
	const where = position === void 0 ? "" : ` at line ${String(position.line)}, column ${String(position.col)}`;
	return `${error.code}${where}`;
}
/** 渲染任意抛出的值为可读消息（诊断用，永不按消息路由）。 */
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 将 V1 的单个 Task 转为 V2 Step（`prompt`（旧 `PromptConfig`）→ `command`）。 */
function convertTaskToStep(task) {
	if (!isRecord(task)) throw new WorkflowYamlError("V1 task must be an object", "DEFINITION_INVALID");
	const { prompt, ...rest } = task;
	if (isRecord(prompt)) {
		const type = typeof prompt.type === "string" ? prompt.type : "";
		return {
			...rest,
			command: {
				type: promptToCommandType(type),
				value: prompt.value
			}
		};
	}
	return { ...rest };
}
/**
* 将单个 Stage 的 `scenarios[]` 展平为分离式输出：
* - Stage 的 `steps[]` 只保留流控位 `{ id, branches? }`；
* - 完整 Task 定义（name/command/映射等，**不含 branches**）收集到 `definitions`，
*   由 `convertLegacyToV2` 汇总进顶层 `steps[]`（V2 分离式按 id 交叉引用）。
* 同一 Scenario 内相邻 Task 依次接 `branches: [{ next }]`（tsk-a→tsk-b→tsk-c），
* Scenario 的 `next` 落到其最后一个 Step（指向下一 Scenario 的首个 Task）。
* 显式 `branches` 不被覆盖。
*/
function convertStage(stage) {
	const scenarios = stage.scenarios;
	if (!Array.isArray(scenarios)) return {
		stage,
		definitions: []
	};
	const converted = [];
	const scenarioSteps = /* @__PURE__ */ new Map();
	for (const scenario of scenarios) {
		if (!isRecord(scenario)) continue;
		const list = (Array.isArray(scenario.tasks) ? scenario.tasks : []).map(convertTaskToStep);
		for (let index = 0; index + 1 < list.length; index++) {
			const current = list[index];
			const following = list[index + 1];
			if (current === void 0 || following === void 0) continue;
			if (current.branches === void 0) current.branches = [{ next: following.id }];
		}
		scenarioSteps.set(String(scenario.id), list);
		converted.push(...list);
	}
	for (const scenario of scenarios) {
		if (!isRecord(scenario)) continue;
		const next = scenario.next;
		if (typeof next !== "string") continue;
		const own = scenarioSteps.get(String(scenario.id));
		const target = scenarioSteps.get(next);
		if (own === void 0 || own.length === 0 || target === void 0 || target.length === 0) continue;
		const last = own[own.length - 1];
		const firstTarget = target[0];
		if (isRecord(last) && isRecord(firstTarget) && last.branches === void 0) last.branches = [{ next: firstTarget.id }];
	}
	const steps = [];
	const definitions = [];
	for (const task of converted) {
		const { branches, ...definition } = task;
		steps.push(branches === void 0 ? { id: task.id } : {
			id: task.id,
			branches
		});
		definitions.push(definition);
	}
	return {
		stage: {
			...Object.fromEntries(Object.entries(stage).filter(([key]) => key !== "scenarios")),
			steps
		},
		definitions
	};
}
/**
* 检测 V1 三级结构（`stages[].scenarios[]`）并自动转换为 V2 两级结构
* （`stages[].steps[]` 流控 + 顶层 `steps[]` 完整定义）。同一 Stage 同时含
* `steps[]` 与 `scenarios[]` 视为混合格式，抛 `WorkflowYamlError('DEFINITION_INVALID')`。
*/
function convertLegacyToV2(raw) {
	if (!isRecord(raw)) return raw;
	const stages = raw.stages;
	if (!Array.isArray(stages)) return raw;
	let hasScenarios = false;
	for (const stage of stages) {
		if (!isRecord(stage)) continue;
		const hasSteps = Array.isArray(stage.steps);
		const hasScen = Array.isArray(stage.scenarios);
		if (hasSteps && hasScen) throw new WorkflowYamlError(`stage '${String(stage.id)}' mixes 'steps' and 'scenarios'`, "DEFINITION_INVALID");
		if (hasScen) hasScenarios = true;
	}
	if (!hasScenarios) return raw;
	const definitions = [];
	const convertedStages = stages.map((stage) => {
		if (!isRecord(stage)) return stage;
		const { stage: converted, definitions: stageDefs } = convertStage(stage);
		definitions.push(...stageDefs);
		return converted;
	});
	const existingSteps = Array.isArray(raw.steps) ? raw.steps : [];
	return {
		...raw,
		stages: convertedStages,
		steps: [...existingSteps, ...definitions]
	};
}
/**
* 校验节点 ID 引用完整性：
* - `branches[].next`、`branches[].loop.next`、`branches[].loop.exitTo` 引用的节点 ID 均存在；
* - `inputFrom[].path` 的 `stageId[.stepId[.outputToId]]` 前两段（Stage/Step 节点 ID）存在。
* 不满足时抛 `WorkflowYamlError('DEFINITION_INVALID')`。
*/
function validateReferences(definition) {
	const seenStageIds = /* @__PURE__ */ new Set();
	for (const stage of definition.stages) {
		if (seenStageIds.has(stage.id)) throw new WorkflowYamlError(`duplicate stage id '${stage.id}'`, "DEFINITION_INVALID");
		seenStageIds.add(stage.id);
	}
	const seenStepPositionIds = /* @__PURE__ */ new Set();
	for (const stage of definition.stages) for (const step of stage.steps) {
		if (seenStepPositionIds.has(step.id)) throw new WorkflowYamlError(`duplicate step id '${step.id}'`, "DEFINITION_INVALID");
		seenStepPositionIds.add(step.id);
	}
	const seenStepDefinitionIds = /* @__PURE__ */ new Set();
	for (const step of definition.steps ?? []) {
		if (seenStepDefinitionIds.has(step.id)) throw new WorkflowYamlError(`duplicate step id '${step.id}'`, "DEFINITION_INVALID");
		seenStepDefinitionIds.add(step.id);
	}
	const stageIds = new Set(definition.stages.map((stage) => stage.id));
	const stepIds = /* @__PURE__ */ new Set();
	for (const step of definition.steps ?? []) stepIds.add(step.id);
	for (const stage of definition.stages) for (const step of stage.steps) stepIds.add(step.id);
	const nodeIds = /* @__PURE__ */ new Set([...stageIds, ...stepIds]);
	const checkTarget = (target, where) => {
		if (target !== void 0 && !nodeIds.has(target)) throw new WorkflowYamlError(`${where} references missing node '${target}'`, "DEFINITION_INVALID");
	};
	const checkNode = (node, kind) => {
		for (const branch of node.branches ?? []) {
			checkTarget(branch.next, `${kind} '${node.id}'.branches.next`);
			if (branch.loop !== void 0) {
				checkTarget(branch.loop.next, `${kind} '${node.id}'.branches.loop.next`);
				checkTarget(branch.loop.exitTo, `${kind} '${node.id}'.branches.loop.exitTo`);
			}
		}
	};
	for (const stage of definition.stages) {
		checkNode(stage, "stage");
		for (const step of stage.steps) checkNode(step, "step");
	}
	for (const step of definition.steps ?? []) checkNode(step, "step");
	for (const step of definition.steps ?? []) for (const input of step.inputFrom ?? []) {
		const path = input.path;
		if (path === void 0 || path.startsWith("${")) continue;
		if (!stepIds.has(path)) throw new WorkflowYamlError(`step '${step.id}'.inputFrom references missing step '${path}'`, "DEFINITION_INVALID");
	}
}
/**
* 解析工作流 YAML 文本为 `WorkflowDefinition`。
*
* 流程：YAML 语法解析（错误 → `YAML_PARSE`）→ V1 自动转换 → Zod 验证（失败 →
* `DEFINITION_INVALID`，`cause` 挂原始 `ZodError`）→ `next` 引用完整性校验。
* @param text - YAML 文本（V1 三级或 V2 两级格式）。
* @returns 验证通过的 `WorkflowDefinition`。
*/
function parseWorkflowYaml(text) {
	const document = parseDocument(text, { prettyErrors: true });
	if (document.errors.length > 0) throw new WorkflowYamlError(`invalid YAML: ${document.errors.map(describeYamlError).join("; ")}`, "YAML_PARSE");
	const data = convertLegacyToV2(document.toJS());
	let definition;
	try {
		definition = WorkflowDefinitionSchema.parse(data);
	} catch (error) {
		throw new WorkflowYamlError(`invalid workflow definition: ${describeError(error)}`, "DEFINITION_INVALID", { cause: error });
	}
	validateReferences(definition);
	return definition;
}
/**
* 序列化 `WorkflowDefinition` 为 YAML 文本（DagEditor 保存 / round-trip 测试用）。
* 序列化结果可被 {@link parseWorkflowYaml} 再次解析且深层相等。
* @param definition - 规范化后的工作流定义。
* @returns YAML 文本。
*/
function serializeWorkflowYaml(definition) {
	return stringify(definition);
}
//#endregion
//#region src/seam.ts
/**
* sandore 工作流引擎的 capability seam。
*
* 定义 `ctx.sandoreEngine` 抽象接口（`SandoreEngine extends Service`）、
* 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）
* 与空 Provider 桩（`SandoreEngineStub`）。真实执行逻辑见 `workflow-engine.ts`。
* @module @deepseek-ai/dsh-sandore-workflow/src/seam
*/
/**
* 工作流引擎的 Service Definition。
*
* Service 层只暴露实例级操作（start/recover/abort/reply/pause/resume/retry/getState），
* 定义/Job 的 CRUD 与实例讨论/产物查询放在 Host RPC 层（见 `remote.ts`）。
*/
var SandoreEngine = class extends Service {
	constructor(ctx) {
		super(ctx, "sandoreEngine");
	}
};
/**
* 空 Provider 桩。
*
* 仅声明依赖注入与配置 schema；11 个方法抛 `not implemented`。
* 真实执行逻辑在 `SandoreEngineRuntime`（`workflow-engine.ts`）。
*/
var SandoreEngineStub = class extends SandoreEngine {
	static Config = z$1.object({
		defaultTimeoutMs: z$1.natural().default(72e5),
		maxConcurrentSteps: z$1.natural().default(0),
		defaultProvider: z$1.string(),
		defaultModel: z$1.string()
	});
	static inject = [
		"sessions",
		"sessionPersistence",
		"subagents",
		"llm",
		"shell",
		"fs",
		"storageDomain",
		"agents",
		"userQuestions",
		"sessionTitle"
	];
	startInstance(request) {
		throw new Error("SandoreEngineStub.startInstance is not implemented");
	}
	recoverInstance(instanceId) {
		throw new Error("SandoreEngineStub.recoverInstance is not implemented");
	}
	abortInstance(instanceId) {
		throw new Error("SandoreEngineStub.abortInstance is not implemented");
	}
	replyQuestion(instanceId, requestId, answers) {
		throw new Error("SandoreEngineStub.replyQuestion is not implemented");
	}
	replyPermission(instanceId, requestId, reply) {
		throw new Error("SandoreEngineStub.replyPermission is not implemented");
	}
	pauseStep(instanceId, stepId) {
		throw new Error("SandoreEngineStub.pauseStep is not implemented");
	}
	resumeStep(instanceId, stepId, resumePrompt) {
		throw new Error("SandoreEngineStub.resumeStep is not implemented");
	}
	pauseAllSteps(instanceId) {
		throw new Error("SandoreEngineStub.pauseAllSteps is not implemented");
	}
	resumeAllSteps(instanceId, resumePrompt) {
		throw new Error("SandoreEngineStub.resumeAllSteps is not implemented");
	}
	retryStep(instanceId, stepId, mode, message) {
		throw new Error("SandoreEngineStub.retryStep is not implemented");
	}
	getState(instanceId) {
		throw new Error("SandoreEngineStub.getState is not implemented");
	}
};
//#endregion
//#region src/dag-navigator.ts
/** 去重并保序。 */
function dedupe(ids) {
	return [...new Set(ids)];
}
var WorkflowDagNavigator = class {
	definition;
	nodeIndex = /* @__PURE__ */ new Map();
	stageContracts = /* @__PURE__ */ new Map();
	stageOrder;
	currentStageId;
	evaluator;
	loopManager;
	constructor(definition, ctx, config, loopState, seed) {
		this.definition = definition;
		this.buildNodeIndex(definition);
		this.stageOrder = definition.stages.map((stage) => stage.id);
		this.currentStageId = seed?.currentStageId ?? this.stageOrder[0] ?? "";
		this.evaluator = new BranchEvaluator(ctx, config);
		this.loopManager = new LoopManager(ctx, config, loopState);
		if (seed?.stageContracts !== void 0) for (const [id, contract] of Object.entries(seed.stageContracts)) this.stageContracts.set(id, contract);
	}
	/** 当前 Stage ID（无 Stage 时为空字符串）。 */
	get currentNodeId() {
		return this.currentStageId;
	}
	/** 循环管理器（引擎/执行器共享，用于 ID 后缀与迭代路径）。 */
	get loopManagerInstance() {
		return this.loopManager;
	}
	/** 已完成 Stage 的契约（stageId → StageContract）只读快照。 */
	getStageContracts() {
		return new Map(this.stageContracts);
	}
	/** 查询单个 Stage 的契约。 */
	getStageContract(stageId) {
		return this.stageContracts.get(stageId);
	}
	/** 聚合前置 Stage 的契约产物（供后续 Stage 引用）。 */
	getContractArtifacts() {
		const merged = {};
		for (const contract of this.stageContracts.values()) for (const [name, files] of Object.entries(contract.contractArtifacts)) merged[name] = [...merged[name] ?? [], ...files];
		return merged;
	}
	/** 保存 Stage 完成契约。 */
	setStageContract(stageId, contract) {
		this.stageContracts.set(stageId, contract);
	}
	/** 当前 Stage 是否已全部完成（以已存契约的 completed 状态判定）。 */
	isStageAllDone(stageId) {
		return this.stageContracts.get(stageId)?.status === "completed";
	}
	/**
	* 推进到下一 Stage。
	*
	* 仅在当前 Stage 已完成（`isStageAllDone`）时推进：优先跟随当前 Stage 的
	* `branches`（首个同 Stage 有效目标，通常为串行/并行下一 Stage），否则按定义数组
	* 顺序推断下一 Stage。无下一 Stage 返回 false。
	*/
	tryAdvanceStage() {
		if (!this.isStageAllDone(this.currentStageId)) return false;
		const current = this.nodeIndex.get(this.currentStageId);
		if (current === void 0 || current.kind !== "stage") return false;
		let nextId;
		for (const branch of current.branches ?? []) if (this.nodeIndex.get(branch.next)?.kind === "stage") {
			nextId = branch.next;
			break;
		}
		if (nextId === void 0) {
			const index = this.stageOrder.indexOf(current.id);
			nextId = index >= 0 ? this.stageOrder[index + 1] : void 0;
		}
		const next = nextId === void 0 ? void 0 : this.nodeIndex.get(nextId);
		if (next === void 0 || next.kind !== "stage") return false;
		this.currentStageId = next.id;
		return true;
	}
	/**
	* Step 级调度单一入口。
	*
	* 统一分支路由（branches 是唯一出边单元）：
	* ① 并行分支（无 condition）始终纳入下一批（多条并发）；
	* ② 条件分支（有 condition）逐条布尔评估（AI 输出 true/false；shell 走
	*    `matchesExpectation(breakExpectation)`），true 纳入；
	* ③ 循环分支（有 loop，next 为回边）：命中后经 `checkLoopBreak` 判定跳出
	*    （走 `exitTo`）或继续下一迭代（回 `loop.next`）；
	* ④ 无任何命中时按定义数组顺序线性兜底；无 Step 级目标返回空
	*    （由引擎 `tryAdvanceStage` 跨阶段推进）。
	*/
	async resolveNextNodes(nodeId, context) {
		const node = this.nodeIndex.get(nodeId);
		if (node === void 0 || node.kind !== "step") return { nextNodeIds: [] };
		const branches = node.branches ?? [];
		if (branches.length === 0) {
			const arrayNext = this.arrayNextStep(node);
			return arrayNext === void 0 ? { nextNodeIds: [] } : { nextNodeIds: [arrayNext] };
		}
		const parallel = branches.filter((branch) => branch.condition === void 0 && branch.loop === void 0);
		const conditional = branches.filter((branch) => branch.condition !== void 0 && branch.loop === void 0);
		const loopBranches = branches.filter((branch) => branch.loop !== void 0);
		const nextNodeIds = [];
		let branchMeta;
		for (const branch of parallel) if (this.sameStageStep(node, branch.next) !== void 0) nextNodeIds.push(branch.next);
		for (const branch of conditional) {
			const result = await this.evaluator.evaluate(branch.condition, "", this.branchEvalOptions(node, context));
			branchMeta = {
				status: "completed",
				result: result.output,
				...result.sessionHandle === null ? {} : { sessionId: result.sessionHandle }
			};
			if (this.decideCondition(branch.condition, result.output, branch.label) && this.sameStageStep(node, branch.next) !== void 0) nextNodeIds.push(branch.next);
		}
		let loopResult;
		for (const branch of loopBranches) {
			const loop = branch.loop;
			if (this.loopManager.activeLoopNodeId === node.id) {
				const visitCount = (context.visitCounts[node.id] ?? 0) + 1;
				context.visitCounts[node.id] = visitCount;
				const outcome = await this.loopManager.checkLoopBreak({
					id: node.id,
					loop
				}, visitCount, {
					input: "",
					output: "",
					passThroughVars: context.passThroughVars
				});
				if (outcome.shouldBreak) {
					this.loopManager.popActiveLoop();
					const exitTo = loop.exitTo;
					loopResult = {
						nextNodeIds: exitTo !== void 0 && this.sameStageStep(node, exitTo) !== void 0 ? [exitTo] : [],
						...outcome.loopMeta === void 0 ? {} : { loopMeta: outcome.loopMeta }
					};
					break;
				}
				this.loopManager.incrementLoopIteration();
				const loopTo = loop.next;
				if (loopTo !== void 0 && this.sameStageStep(node, loopTo) !== void 0) {
					loopResult = { nextNodeIds: [loopTo] };
					break;
				}
				loopResult = { nextNodeIds: [] };
				break;
			}
			context.visitCounts[node.id] = 0;
			this.loopManager.pushActiveLoop(node.id, loop.maxIterations);
			const loopTo = loop.next;
			if (loopTo !== void 0 && this.sameStageStep(node, loopTo) !== void 0) {
				loopResult = { nextNodeIds: [loopTo] };
				break;
			}
			this.loopManager.popActiveLoop();
			const exitTo = loop.exitTo;
			loopResult = { nextNodeIds: exitTo !== void 0 && this.sameStageStep(node, exitTo) !== void 0 ? [exitTo] : [] };
			break;
		}
		if (loopResult !== void 0) return loopResult;
		if (nextNodeIds.length > 0) return {
			nextNodeIds: dedupe(nextNodeIds),
			...branchMeta === void 0 ? {} : { branchMeta }
		};
		const arrayNext = this.arrayNextStep(node);
		if (arrayNext !== void 0) nextNodeIds.push(arrayNext);
		return {
			nextNodeIds: dedupe(nextNodeIds),
			...branchMeta === void 0 ? {} : { branchMeta }
		};
	}
	/** 按 condition 类型判定条件分支是否通过。 */
	decideCondition(condition, output, expectation) {
		if (condition.type === "shell") {
			if (expectation === void 0) return false;
			return matchesExpectation(output.trim(), expectation);
		}
		return output.trim().toLowerCase() === "true";
	}
	/** 数组顺序的下一 Step（同 Stage 内，线性兜底）。 */
	arrayNextStep(node) {
		if (node.kind !== "step") return;
		const steps = node.stage.steps;
		const index = steps.findIndex((step) => step.id === node.id);
		return index < 0 ? void 0 : steps[index + 1]?.id;
	}
	/** 组装分支评估选项（候选分支 + 透传变量 + 循环上下文 + 取消信号）。 */
	branchEvalOptions(node, context) {
		const loopContext = this.loopManager.getLoopIterationContext();
		return {
			...node.branches === void 0 ? {} : { branches: node.branches },
			passThroughVars: context.passThroughVars,
			loopTurn: loopContext.loopTurn,
			loopMaxIterations: loopContext.loopMaxIterations,
			...context.signal === void 0 ? {} : { signal: context.signal }
		};
	}
	/** 目标节点是否为同 Stage 内的 Step（跨阶段隔离：跨 Stage 目标返回 undefined）。 */
	sameStageStep(node, targetId) {
		const target = this.nodeIndex.get(targetId);
		if (target === void 0 || target.kind !== "step") return;
		if (target.stage.id !== node.stage.id) return;
		return target;
	}
	buildNodeIndex(definition) {
		const definitions = new Map((definition.steps ?? []).map((step) => [step.id, step]));
		for (const stage of definition.stages) {
			this.nodeIndex.set(stage.id, {
				kind: "stage",
				stage,
				id: stage.id,
				name: stage.name,
				branches: stage.branches
			});
			for (const step of stage.steps) {
				const definitionStep = definitions.get(step.id);
				const merged = definitionStep === void 0 ? step : {
					...definitionStep,
					...step.branches === void 0 ? {} : { branches: step.branches }
				};
				this.nodeIndex.set(step.id, {
					kind: "step",
					stage,
					step: merged,
					id: step.id,
					name: merged.name ?? step.id,
					branches: merged.branches
				});
			}
		}
	}
};
//#endregion
//#region src/wire.ts
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
/** `createDefinition` 入参：仅承载 YAML 文本。 */
const CreateDefinitionInputSchema = z.object({ yaml: z.string() });
/** `updateDefinition` 入参：可更新的元数据字段。 */
const UpdateDefinitionInputSchema = z.object({
	name: z.string().optional(),
	version: z.string().optional(),
	description: z.string().optional()
});
/** 创建实例时选择的模型（对齐 DSH `ModelSelection`）。 */
const StartModelSelectionSchema = z.object({
	provider: z.string(),
	model: z.string(),
	reasoningEffort: z.string().optional()
});
/** `startInstance` 入参（去 job 概念：直接绑定工作流定义 + 工作目录 + 模型/权限）。 */
const StartInstanceInputSchema = z.object({
	workflowId: z.string(),
	originalInput: z.string(),
	cwd: z.string().optional(),
	model: StartModelSelectionSchema.optional(),
	permission: z.string().optional()
});
/** 单个问题回答的 zod 校验（对齐 DSH `AskUserQuestionAnswerItem`）。 */
const AskUserQuestionAnswerItemSchema = z.object({
	id: z.string(),
	selected: z.array(z.string()),
	custom: z.string().optional()
});
/** 用户整批回答的 zod 校验（对齐 DSH `AskUserQuestionAnswer`）。 */
const AskUserQuestionAnswerSchema = z.object({ answers: z.array(AskUserQuestionAnswerItemSchema) });
/** `replyQuestion` 入参。 */
const ReplyQuestionInputSchema = z.object({
	instanceId: z.string(),
	requestId: z.string(),
	answers: AskUserQuestionAnswerSchema
});
/** `replyPermission` 入参（`reply` 限定 once/always/reject）。 */
const ReplyPermissionInputSchema = z.object({
	instanceId: z.string(),
	requestId: z.string(),
	reply: z.enum([
		"once",
		"always",
		"reject"
	])
});
/** `pauseStep` 入参。 */
const PauseStepInputSchema = z.object({
	instanceId: z.string(),
	stepId: z.string()
});
/** `resumeStep` 入参（可选恢复提示词）。 */
const ResumeStepInputSchema = z.object({
	instanceId: z.string(),
	stepId: z.string(),
	resumePrompt: z.string().optional()
});
/** `pauseAll` 入参。 */
const PauseAllInputSchema = z.object({ instanceId: z.string() });
/** `resumeAll` 入参（可选统一恢复提示词）。 */
const ResumeAllInputSchema = z.object({
	instanceId: z.string(),
	resumePrompt: z.string().optional()
});
/** `retryStep` 入参（`mode` 限定 continue/revert/fork）。 */
const RetryStepInputSchema = z.object({
	instanceId: z.string(),
	stepId: z.string(),
	mode: z.enum([
		"continue",
		"revert",
		"fork"
	]),
	message: z.string()
});
//#endregion
//#region src/remote.ts
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** 实例的终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES$1 = /* @__PURE__ */ new Set([
	"completed",
	"failed",
	"aborted"
]);
/**
* sandore 的 Host RPC 服务。
*
* 定义/Job/实例 CRUD + 7 个生命周期 RPC + 产物查询 + Provider/Model 转发；
* `ping` 保留。
*/
let SandoreRemote = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _ping_decorators;
	let _listDefinitions_decorators;
	let _createDefinition_decorators;
	let _updateDefinition_decorators;
	let _deleteDefinition_decorators;
	let _getYaml_decorators;
	let _updateYaml_decorators;
	let _listInstances_decorators;
	let _startInstance_decorators;
	let _deleteInstance_decorators;
	let _getInstanceState_decorators;
	let _abortInstance_decorators;
	let _replyQuestion_decorators;
	let _replyPermission_decorators;
	let _pauseStep_decorators;
	let _resumeStep_decorators;
	let _pauseAll_decorators;
	let _resumeAll_decorators;
	let _retryStep_decorators;
	let _getArtifacts_decorators;
	let _listProviders_decorators;
	let _listModels_decorators;
	return class SandoreRemote extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_ping_decorators = [Remote("ping")];
			_listDefinitions_decorators = [Remote("listDefinitions")];
			_createDefinition_decorators = [Remote("createDefinition")];
			_updateDefinition_decorators = [Remote("updateDefinition")];
			_deleteDefinition_decorators = [Remote("deleteDefinition")];
			_getYaml_decorators = [Remote("getYaml")];
			_updateYaml_decorators = [Remote("updateYaml")];
			_listInstances_decorators = [Remote("listInstances")];
			_startInstance_decorators = [Remote("startInstance")];
			_deleteInstance_decorators = [Remote("deleteInstance")];
			_getInstanceState_decorators = [Remote("getInstanceState")];
			_abortInstance_decorators = [Remote("abortInstance")];
			_replyQuestion_decorators = [Remote("replyQuestion")];
			_replyPermission_decorators = [Remote("replyPermission")];
			_pauseStep_decorators = [Remote("pauseStep")];
			_resumeStep_decorators = [Remote("resumeStep")];
			_pauseAll_decorators = [Remote("pauseAll")];
			_resumeAll_decorators = [Remote("resumeAll")];
			_retryStep_decorators = [Remote("retryStep")];
			_getArtifacts_decorators = [Remote("getArtifacts")];
			_listProviders_decorators = [Remote("listProviders")];
			_listModels_decorators = [Remote("listModels")];
			__esDecorate(this, null, _ping_decorators, {
				kind: "method",
				name: "ping",
				static: false,
				private: false,
				access: {
					has: (obj) => "ping" in obj,
					get: (obj) => obj.ping
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listDefinitions_decorators, {
				kind: "method",
				name: "listDefinitions",
				static: false,
				private: false,
				access: {
					has: (obj) => "listDefinitions" in obj,
					get: (obj) => obj.listDefinitions
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createDefinition_decorators, {
				kind: "method",
				name: "createDefinition",
				static: false,
				private: false,
				access: {
					has: (obj) => "createDefinition" in obj,
					get: (obj) => obj.createDefinition
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _updateDefinition_decorators, {
				kind: "method",
				name: "updateDefinition",
				static: false,
				private: false,
				access: {
					has: (obj) => "updateDefinition" in obj,
					get: (obj) => obj.updateDefinition
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteDefinition_decorators, {
				kind: "method",
				name: "deleteDefinition",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteDefinition" in obj,
					get: (obj) => obj.deleteDefinition
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getYaml_decorators, {
				kind: "method",
				name: "getYaml",
				static: false,
				private: false,
				access: {
					has: (obj) => "getYaml" in obj,
					get: (obj) => obj.getYaml
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _updateYaml_decorators, {
				kind: "method",
				name: "updateYaml",
				static: false,
				private: false,
				access: {
					has: (obj) => "updateYaml" in obj,
					get: (obj) => obj.updateYaml
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listInstances_decorators, {
				kind: "method",
				name: "listInstances",
				static: false,
				private: false,
				access: {
					has: (obj) => "listInstances" in obj,
					get: (obj) => obj.listInstances
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _startInstance_decorators, {
				kind: "method",
				name: "startInstance",
				static: false,
				private: false,
				access: {
					has: (obj) => "startInstance" in obj,
					get: (obj) => obj.startInstance
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteInstance_decorators, {
				kind: "method",
				name: "deleteInstance",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteInstance" in obj,
					get: (obj) => obj.deleteInstance
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getInstanceState_decorators, {
				kind: "method",
				name: "getInstanceState",
				static: false,
				private: false,
				access: {
					has: (obj) => "getInstanceState" in obj,
					get: (obj) => obj.getInstanceState
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _abortInstance_decorators, {
				kind: "method",
				name: "abortInstance",
				static: false,
				private: false,
				access: {
					has: (obj) => "abortInstance" in obj,
					get: (obj) => obj.abortInstance
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _replyQuestion_decorators, {
				kind: "method",
				name: "replyQuestion",
				static: false,
				private: false,
				access: {
					has: (obj) => "replyQuestion" in obj,
					get: (obj) => obj.replyQuestion
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _replyPermission_decorators, {
				kind: "method",
				name: "replyPermission",
				static: false,
				private: false,
				access: {
					has: (obj) => "replyPermission" in obj,
					get: (obj) => obj.replyPermission
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _pauseStep_decorators, {
				kind: "method",
				name: "pauseStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "pauseStep" in obj,
					get: (obj) => obj.pauseStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resumeStep_decorators, {
				kind: "method",
				name: "resumeStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "resumeStep" in obj,
					get: (obj) => obj.resumeStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _pauseAll_decorators, {
				kind: "method",
				name: "pauseAll",
				static: false,
				private: false,
				access: {
					has: (obj) => "pauseAll" in obj,
					get: (obj) => obj.pauseAll
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resumeAll_decorators, {
				kind: "method",
				name: "resumeAll",
				static: false,
				private: false,
				access: {
					has: (obj) => "resumeAll" in obj,
					get: (obj) => obj.resumeAll
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _retryStep_decorators, {
				kind: "method",
				name: "retryStep",
				static: false,
				private: false,
				access: {
					has: (obj) => "retryStep" in obj,
					get: (obj) => obj.retryStep
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getArtifacts_decorators, {
				kind: "method",
				name: "getArtifacts",
				static: false,
				private: false,
				access: {
					has: (obj) => "getArtifacts" in obj,
					get: (obj) => obj.getArtifacts
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listProviders_decorators, {
				kind: "method",
				name: "listProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProviders" in obj,
					get: (obj) => obj.listProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listModels_decorators, {
				kind: "method",
				name: "listModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "listModels" in obj,
					get: (obj) => obj.listModels
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"sandorePersistence",
			"sandoreEngine",
			"llm"
		];
		constructor(ctx) {
			super(ctx, "sandore");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/** 健康检查往返，验证 Host/Client RPC 链路。 */
		ping() {
			return {
				pong: true,
				service: "sandore",
				time: (/* @__PURE__ */ new Date()).toISOString()
			};
		}
		/** 列出全部工作流定义（含 `id` 键）。 */
		listDefinitions() {
			const entries = [];
			for (const [id, record] of this.ctx.sandorePersistence.definitions.entries()) entries.push({
				id,
				...record
			});
			return entries;
		}
		/**
		* 创建定义：解析+验证 YAML → 生成 `wfl-{uuid}` → 以规范 id 重新序列化存储。
		* 非法 YAML 抛 `SandoreError`，`definitions` 表不新增记录。存储的 YAML 文本顶层
		* `id` 与记录键一致（客户端传入的哨兵 id 如 `wfl-new` 不回写进持久化文本）。
		*/
		async createDefinition(input) {
			const definition = parseWorkflowYaml(CreateDefinitionInputSchema.parse(input).yaml);
			const id = `wfl-${globalThis.crypto.randomUUID()}`;
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const record = {
				yaml: serializeWorkflowYaml({
					...definition,
					id
				}),
				name: definition.name,
				version: definition.version,
				...definition.description === void 0 ? {} : { description: definition.description },
				createdAt: now,
				updatedAt: now
			};
			await this.ctx.sandorePersistence.definitions.put(id, record);
			return {
				id,
				...record
			};
		}
		/** 更新定义元数据（name/version/description），保留 yaml 文本。 */
		async updateDefinition(id, input) {
			const parsed = UpdateDefinitionInputSchema.parse(input);
			const existing = this.requireDefinition(id);
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const description = parsed.description ?? existing.description;
			const next = {
				yaml: existing.yaml,
				name: parsed.name ?? existing.name,
				version: parsed.version ?? existing.version,
				...description === void 0 ? {} : { description },
				createdAt: existing.createdAt,
				updatedAt: now
			};
			await this.ctx.sandorePersistence.definitions.put(id, next);
			return {
				id,
				...next
			};
		}
		/** 删除定义（不级联删除实例）；重复删除幂等（返回 false）。 */
		async deleteDefinition(id) {
			return await this.ctx.sandorePersistence.definitions.delete(id);
		}
		/** 读取定义的原始 YAML 文本。 */
		getYaml(id) {
			return this.requireDefinition(id).yaml;
		}
		/** 重新验证后覆盖定义的 YAML 文本；非法 YAML 抛错且存储保持旧值。
		*  元数据（name/version/description）从新 YAML 解析同步，保证列表展示与内容一致。 */
		async updateYaml(id, yaml) {
			const parsed = parseWorkflowYaml(yaml);
			const existing = this.requireDefinition(id);
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const next = {
				yaml,
				name: parsed.name,
				version: parsed.version,
				...parsed.description === void 0 ? {} : { description: parsed.description },
				createdAt: existing.createdAt,
				updatedAt: now
			};
			await this.ctx.sandorePersistence.definitions.put(id, next);
			return {
				id,
				...next
			};
		}
		/** 列出实例摘要（从 `state` 表派生，去 job 概念）。 */
		listInstances() {
			const summaries = [];
			for (const [instanceId, state] of this.ctx.sandorePersistence.state.entries()) summaries.push({
				instanceId,
				workflowId: state.workflowId,
				originalInput: state.originalInput,
				status: state.status,
				createdAt: state.createdAt,
				updatedAt: state.updatedAt
			});
			return summaries;
		}
		/** 启动实例：校验定义存在后转发 `ctx.sandoreEngine.startInstance`（去 job 概念）。 */
		async startInstance(input) {
			const parsed = StartInstanceInputSchema.parse(input);
			if (this.ctx.sandorePersistence.definitions.get(parsed.workflowId) === void 0) throw new SandoreError(`workflow '${parsed.workflowId}' does not exist`, "INVALID_OPERATION");
			const request = {
				workflowId: parsed.workflowId,
				originalInput: parsed.originalInput,
				...parsed.cwd === void 0 ? {} : { cwd: parsed.cwd },
				...parsed.model === void 0 ? {} : { model: parsed.model },
				...parsed.permission === void 0 ? {} : { permission: parsed.permission }
			};
			return await this.ctx.sandoreEngine.startInstance(request);
		}
		/** 删除实例快照（`state` 表删除）；重复删除幂等。 */
		async deleteInstance(instanceId) {
			return await this.ctx.sandorePersistence.state.delete(instanceId);
		}
		/** 读取实例的完整状态快照；不存在抛 `NODE_NOT_FOUND`。 */
		getInstanceState(instanceId) {
			return this.requireInstanceState(instanceId);
		}
		/** 中止运行中实例（转发引擎）；终态实例抛 `INVALID_OPERATION`。 */
		async abortInstance(instanceId) {
			const state = this.requireInstanceState(instanceId);
			if (TERMINAL_STATUSES$1.has(state.status)) throw new SandoreError(`instance '${instanceId}' is already in terminal state '${state.status}'`, "INVALID_OPERATION");
			await this.ctx.sandoreEngine.abortInstance(instanceId);
		}
		/** 回复待处理问答（转发 `ctx.sandoreEngine.replyQuestion`）。 */
		async replyQuestion(input) {
			const parsed = ReplyQuestionInputSchema.parse(input);
			await this.ctx.sandoreEngine.replyQuestion(parsed.instanceId, parsed.requestId, parsed.answers);
		}
		/** 回复待处理权限请求（转发 `ctx.sandoreEngine.replyPermission`）。 */
		async replyPermission(input) {
			const parsed = ReplyPermissionInputSchema.parse(input);
			await this.ctx.sandoreEngine.replyPermission(parsed.instanceId, parsed.requestId, parsed.reply);
		}
		/** 暂停单个 Step（转发 `ctx.sandoreEngine.pauseStep`）。 */
		async pauseStep(input) {
			const parsed = PauseStepInputSchema.parse(input);
			await this.ctx.sandoreEngine.pauseStep(parsed.instanceId, parsed.stepId);
		}
		/** 恢复单个 Step（转发 `ctx.sandoreEngine.resumeStep`，可选恢复提示词）。 */
		async resumeStep(input) {
			const parsed = ResumeStepInputSchema.parse(input);
			await this.ctx.sandoreEngine.resumeStep(parsed.instanceId, parsed.stepId, parsed.resumePrompt);
		}
		/** 暂停实例内全部 Step（转发 `ctx.sandoreEngine.pauseAllSteps`）。 */
		async pauseAll(input) {
			const parsed = PauseAllInputSchema.parse(input);
			await this.ctx.sandoreEngine.pauseAllSteps(parsed.instanceId);
		}
		/** 恢复实例内全部 Step（转发 `ctx.sandoreEngine.resumeAllSteps`，可选恢复提示词）。 */
		async resumeAll(input) {
			const parsed = ResumeAllInputSchema.parse(input);
			await this.ctx.sandoreEngine.resumeAllSteps(parsed.instanceId, parsed.resumePrompt);
		}
		/** 重试失败 Step（转发 `ctx.sandoreEngine.retryStep`）。 */
		async retryStep(input) {
			const parsed = RetryStepInputSchema.parse(input);
			await this.ctx.sandoreEngine.retryStep(parsed.instanceId, parsed.stepId, parsed.mode, parsed.message);
		}
		/**
		* 查询实例产物：从 `stageContracts` 的产物契约扁平化条目，可选按 stageId 过滤。
		*/
		getArtifacts(instanceId, stageId) {
			const state = this.requireInstanceState(instanceId);
			const entries = [];
			for (const [contractStageId, contract] of Object.entries(state.stageContracts)) {
				if (stageId !== void 0 && contractStageId !== stageId) continue;
				for (const artifact of contract.artifacts) entries.push({
					stepId: artifact.stepId,
					stageId: contractStageId,
					outputToId: artifact.outputToId,
					files: [...artifact.files],
					...artifact.returnPrompt === void 0 ? {} : { returnPrompt: artifact.returnPrompt }
				});
			}
			return entries;
		}
		/** 列出 LLM Provider（透传 `ctx.llm.listProviders()`）。 */
		listProviders() {
			return this.ctx.llm.listProviders();
		}
		/** 列出某 Provider 的模型（透传 `ctx.llm.listModels()`）。 */
		async listModels(provider) {
			return await this.ctx.llm.listModels(provider);
		}
		requireDefinition(id) {
			const record = this.ctx.sandorePersistence.definitions.get(id);
			if (record === void 0) throw new SandoreError(`definition '${id}' not found`, "NODE_NOT_FOUND");
			return {
				id,
				...record
			};
		}
		requireInstanceState(instanceId) {
			const state = this.ctx.sandorePersistence.state.get(instanceId);
			if (state === void 0) throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
			return state;
		}
	};
})();
//#endregion
//#region src/host-agent.ts
/**
* 创建宿主主代理的 setup 回调（create 与 resume 共用，保证注册行为一致）。
*
* 返回的 `AgentSetup` 在 agent/session 发布前执行：挂载 DSH 默认 agent preset。
* `presets` 服务缺失时（无 preset 部署）跳过 mount，与 apiproxy `composeAgent` 的
* `presets === undefined` 分支一致。
* @param options - 实例 ID 与（可选的）agentPresets 服务。
* @returns 宿主主代理的 setup 回调。
*/
function createHostAgentSetup(options) {
	const { presets } = options;
	return async (agentCtx) => {
		if (presets === void 0) return;
		await presets.mount(agentCtx);
	};
}
//#endregion
//#region src/interaction-manager.ts
/** 子代理 ask 标记块起止定界。 */
const ASK_MARKER_START = "[[SANDORE_ASK]]";
const ASK_MARKER_END = "[[/SANDORE_ASK]]";
/** 生成请求关联 ID。 */
function makeRequestId() {
	return globalThis.crypto.randomUUID();
}
/** 提取 ContentBlock[] 中的纯文本（仅 text 块）。 */
function textOf(output) {
	const texts = [];
	for (const block of output) if (block.type === "text") texts.push(block.text);
	return texts.join("\n");
}
/** 蛇形 `AskUserQuestionPayload` → 驼峰 `AskUserQuestionItem[]`（对齐 DSH）。 */
function toAskItems(payload) {
	return payload.questions.map((question) => ({
		id: question.id,
		question: question.question,
		...question.header === void 0 ? {} : { header: question.header },
		...question.options === void 0 ? {} : { options: question.options.map((option) => ({
			label: option.label,
			...option.description === void 0 ? {} : { description: option.description }
		})) },
		...question.multi_select === void 0 ? {} : { multiSelect: question.multi_select }
	}));
}
/** `AskUserQuestionAnswer` → 持久化条目 answer 的 `string[][]` 形状。 */
function toAnswerArray(answer) {
	return answer.answers.map((item) => item.selected);
}
/**
* `AskUserQuestionAnswer` → 注回子代理/写 userMessages 的可读文本。
*
* 每题一行：选中项 `selected` 用 `、` 连接，`custom` 自由文本追加为「（补充：…）」；
* 无选中项仅自由文本时输出自由文本本身。空答案条目跳过。
* @param answer - 用户整批回答。
* @returns 多行可读文本。
*/
function buildAnswerText(answer) {
	return answer.answers.map((item) => {
		const parts = [];
		if (item.selected.length > 0) parts.push(item.selected.join("、"));
		const custom = item.custom?.trim();
		if (custom !== void 0 && custom !== "") parts.push(`补充：${custom}`);
		return parts.length > 1 ? `${parts[0]}（${parts.slice(1).join("；")}）` : parts[0] ?? "";
	}).filter((part) => part !== "").join("\n");
}
/**
* 解析子代理 final result 中的保守标记块 `[[SANDORE_ASK]]{...json...}[[/SANDORE_ASK]]`。
*
* 仅解析首个标记块；JSON 解析失败、`AskUserQuestionPayloadSchema` 校验不通过或
* `questions` 为空均返回 `undefined`（按普通输出处理，不转接）。
* @param text - 子代理 final result 的纯文本。
* @returns 合法 ask 载荷，或无合法标记块时为 `undefined`。
*/
function parseDelegatedAsk(text) {
	const start = text.indexOf(ASK_MARKER_START);
	if (start < 0) return;
	const jsonStart = start + 15;
	const end = text.indexOf(ASK_MARKER_END, jsonStart);
	if (end < 0) return;
	let parsed;
	try {
		parsed = JSON.parse(text.slice(jsonStart, end));
	} catch {
		return;
	}
	const result = AskUserQuestionPayloadSchema.safeParse(parsed);
	if (!result.success) return;
	if (result.data.questions.length === 0) return;
	return result.data;
}
/**
* 交互管理器。
*
* Map 仅维护「活跃 pending」条目（用于 reply 路由）；终态（replied/rejected）
* 条目进入 `resolvedEntries` 历史并随每次 `syncState` 一并镜像到快照，保证
* `pendingInteractions` 始终是「pending + 终态」的全量历史。
*/
var InteractionManager = class {
	deps;
	pendingQuestions = /* @__PURE__ */ new Map();
	pendingPermissions = /* @__PURE__ */ new Map();
	resolvedEntries = [];
	questionWaiters = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** 登记一条待回复问答条目（登记即持久化 + 发射 `sandore/question`）。 */
	addPendingQuestion(entry) {
		this.pendingQuestions.set(entry.requestId, entry);
		this.syncState();
		this.deps.emitQuestion(entry);
	}
	/** 登记一条待回复权限条目（登记即持久化 + 发射 `sandore/permission`，无自动审批）。 */
	addPendingPermission(entry) {
		this.pendingPermissions.set(entry.requestId, entry);
		this.syncState();
		this.deps.emitPermission(entry);
	}
	/**
	* 引擎级 ask 主通道：登记 → `ctx.userQuestions.ask`（hostAgent 身份）→ await 答案。
	*
	* 无 `userQuestions`（卡片通道不可用）时挂起，仅能由 {@link replyQuestion} 兼容
	* 路径 resolve。返回前条目已终态化（status=replied + answer）并持久化。
	* @param input - pending 条目与可选取消信号。
	* @returns 用户整批回答。
	*/
	async ask(input) {
		const { entry, signal } = input;
		this.addPendingQuestion(entry);
		return await new Promise((resolve, reject) => {
			this.questionWaiters.set(entry.requestId, {
				resolve,
				reject
			});
			const userQuestions = this.deps.userQuestions();
			if (userQuestions !== void 0) userQuestions.ask({
				questions: toAskItems(entry.payload),
				agent: this.deps.hostAgent,
				...signal === void 0 ? {} : { signal }
			}).then((result) => this.finishQuestion(entry, result), (error) => this.failQuestion(entry, error));
		});
	}
	/**
	* 兼容回复路径：resolve 内部等待 Promise（与 ask 的 await 汇合）并终态化条目。
	*
	* 未知或已 replied 的 requestId 抛 {@link SandoreError}（`INVALID_OPERATION`）。
	* @param requestId - 待回复请求关联 ID。
	* @param answer - 用户整批回答。
	*/
	async replyQuestion(requestId, answer) {
		const entry = this.pendingQuestions.get(requestId);
		if (entry === void 0) throw new SandoreError(`pending question '${requestId}' not found or already replied`, "INVALID_OPERATION");
		this.finishQuestion(entry, answer);
	}
	/**
	* 兼容回复路径：按 reply 取值终态化权限条目（once/always → replied，reject → rejected）。
	*
	* 不实现 permissionMode/自动审批；未知或已回复的 requestId 抛 `INVALID_OPERATION`。
	* @param requestId - 待回复请求关联 ID。
	* @param reply - 权限决定。
	*/
	async replyPermission(requestId, reply) {
		const entry = this.pendingPermissions.get(requestId);
		if (entry === void 0) throw new SandoreError(`pending permission '${requestId}' not found or already replied`, "INVALID_OPERATION");
		this.pendingPermissions.delete(requestId);
		this.resolvedEntries.push({
			...entry,
			status: reply === "reject" ? "rejected" : "replied",
			answer: reply
		});
		this.syncState();
	}
	/**
	* 子代理 ask 转接：final result 含合法标记块时转引擎级 ask，答案 followup 注回子代理。
	*
	* 无合法标记块时按普通输出处理（不转接、不报错）。
	* @param input - 子代理 childId、final result、以及构造 pending 条目的定位字段。
	* @returns 是否发生转接。
	*/
	async delegateSubagentAsk(input) {
		const payload = parseDelegatedAsk(textOf(input.output));
		if (payload === void 0) return { delegated: false };
		const requestId = makeRequestId();
		const entry = {
			id: requestId,
			stageId: input.stageId,
			stepId: input.stepId,
			sessionId: input.sessionId,
			requestId,
			kind: "question",
			status: "pending",
			payload,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		const answer = await this.ask({
			entry,
			...input.signal === void 0 ? {} : { signal: input.signal }
		});
		await this.deps.followup(input.childId, [{
			type: "text",
			text: JSON.stringify(answer)
		}]);
		return { delegated: true };
	}
	/** 终态化一条问答条目并 resolve 其等待 Promise（幂等，兼容卡片/兼容路径竞态）。 */
	finishQuestion(entry, answer) {
		if (this.pendingQuestions.get(entry.requestId) === void 0) return;
		this.pendingQuestions.delete(entry.requestId);
		this.resolvedEntries.push({
			...entry,
			status: "replied",
			answer: toAnswerArray(answer)
		});
		this.syncState();
		const waiter = this.questionWaiters.get(entry.requestId);
		this.questionWaiters.delete(entry.requestId);
		waiter?.resolve(answer);
	}
	/** 卡片 ask 失败（取消/拒绝）时清理 pending 条目并拒绝其等待 Promise。 */
	failQuestion(entry, error) {
		if (this.pendingQuestions.get(entry.requestId) === void 0) return;
		this.pendingQuestions.delete(entry.requestId);
		this.resolvedEntries.push({
			...entry,
			status: "rejected"
		});
		this.syncState();
		const waiter = this.questionWaiters.get(entry.requestId);
		this.questionWaiters.delete(entry.requestId);
		waiter?.reject(error);
	}
	/**
	* 把活跃 pending 条目镜像持久化到状态快照（**只含 pending**，不含终态历史）。
	*
	* 探索修正（2026-08）：原实现持久化 pending + resolvedEntries 全量历史，前端
	* `partitionInteractions` 不筛 status → 回答/批准后 5s 轮询再次弹出接管面板，
	* 二次提交抛 INVALID_OPERATION 无法关闭。终态条目不再进快照（历史由 userMessages
	* 与 executedSteps 承载）；resolvedEntries 仅保留内存作审计。
	*/
	syncState() {
		const entries = [...this.pendingQuestions.values(), ...this.pendingPermissions.values()];
		this.deps.persist(entries);
	}
};
//#endregion
//#region src/lifecycle-manager.ts
/** Step 终态集合：暂停对终态 Step 抛 `INVALID_OPERATION`。 */
const TERMINAL_STEP_STATUSES = /* @__PURE__ */ new Set(["completed", "failed"]);
/** 恢复提示词的缺省值（`resumeStep`/`resumeAllSteps` 未显式提供时使用）。 */
const DEFAULT_RESUME_PROMPT = "请继续完成当前任务。";
/** 当前 ISO 时间戳。 */
function now$2() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/**
* 生命周期协调器。
*
* 持有暂停登记表（内存 `Set`），通过注入的依赖驱动单步/全局暂停与恢复；状态更新
* 以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
*/
var LifecycleManager = class {
	deps;
	pausedChildIds;
	constructor(deps) {
		this.deps = deps;
		this.pausedChildIds = new Set(deps.initialPausedChildIds);
	}
	/** 暂停登记表当前内容（子代理 SessionId 集合，仅只读投影）。 */
	get pausedIds() {
		return [...this.pausedChildIds];
	}
	/**
	* 子代理自然完成（interrupt 软信号未生效，Step 已 completed）时清理暂停登记表：
	* 移除该 childId 并同步持久化。pause→完成竞态（pauseStep 先 interrupt+登记，但子代理
	* 仍跑完）后，若不清登记会残留「段 completed + 登记表有值」的不一致，resume 将卡死。
	* @param childId - 已完成的子代理 SessionId。
	*/
	clearPausedOnCompletion(childId) {
		if (!this.pausedChildIds.has(childId)) return;
		this.pausedChildIds.delete(childId);
		this.commitPausedRegistry();
	}
	/** 某子代理 SessionId 是否在暂停登记表中。 */
	hasPaused(childId) {
		return this.pausedChildIds.has(childId);
	}
	/** 暂停单个 Step（经 childId 反查 + interrupt + 登记表 add + 状态 paused + 事件）。 */
	pauseStep(stepId) {
		const step = this.findStep(stepId);
		if (step === void 0) throw new SandoreError(`step '${stepId}' not found`, "INVALID_OPERATION");
		if (this.isNonSubagentCommand(step)) throw new SandoreError(`step '${stepId}' is a non-subagent step (${step.command?.type}) and cannot be paused`, "INVALID_OPERATION");
		if (TERMINAL_STEP_STATUSES.has(step.status)) throw new SandoreError(`step '${stepId}' is in terminal state '${step.status}'`, "INVALID_OPERATION");
		const childId = this.childIdOf(step);
		if (this.pausedChildIds.has(childId)) return;
		const child = this.deps.getAgent(childId);
		if (child !== void 0 && child.status === "idle" && !child.inbox.hasPending) return;
		this.deps.interrupt(childId, {
			kind: "ancestor",
			agent: this.deps.hostAgent
		});
		this.pausedChildIds.add(childId);
		this.commitStepStatus(step, "paused", { pausedAt: now$2() });
		this.deps.emitStepPaused(this.stepIdOf(step), childId, step.name, step.loopIteration);
	}
	/**
	* 恢复单个 Step（反查 childId + 移出登记表 + followup + 追加新执行段 + 用户消息）。
	*
	* 段模型：被暂停段保持 paused 定格快照；恢复时以它为基底创建**新执行段**
	* （新唯一执行 id + attemptIndex+1 + createdAt），followup 唤醒同一子代理续跑。
	* 恢复消息不写入段（统一存 `userMessages`，避免广播时每段重复同一句话）。
	*/
	async resumeStep(stepId, resumePrompt) {
		const step = this.findStep(stepId);
		if (step === void 0) throw new SandoreError(`step '${stepId}' not found`, "INVALID_OPERATION");
		const childId = this.childIdOf(step);
		if (!this.pausedChildIds.has(childId)) throw new SandoreError(`step '${stepId}' is not paused`, "INVALID_OPERATION");
		const content = [{
			type: "text",
			text: resumePrompt ?? DEFAULT_RESUME_PROMPT
		}];
		await this.deps.followup(childId, content, this.deps.signal);
		this.pausedChildIds.delete(childId);
		this.deps.appendUserMessage(this.userMessage("resume", this.stepIdOf(step), resumePrompt ?? DEFAULT_RESUME_PROMPT));
		this.commitPausedRegistry();
		this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt, step.name, step.loopIteration);
	}
	/** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
	pauseAllSteps() {
		const targets = this.deps.readState().executedSteps.filter((step) => (step.status === "running" || step.status === "interacting") && !this.isNonSubagentCommand(step));
		for (const step of targets) this.pauseStep(this.stepIdOf(step));
	}
	/**
	* 恢复登记表内全部 Step（逐个 followup + 移表，完成后登记表清空）。
	* 广播指令是实例级事件：只追加一条 `target:'broadcast'` 用户消息（不得复制进每个 Step）。
	*/
	async resumeAllSteps(resumePrompt) {
		const childIds = [...this.pausedChildIds];
		for (const childId of childIds) {
			const step = this.findStepByChildId(childId);
			if (step === void 0) continue;
			const content = [{
				type: "text",
				text: resumePrompt ?? DEFAULT_RESUME_PROMPT
			}];
			await this.deps.followup(childId, content, this.deps.signal);
			this.pausedChildIds.delete(childId);
			this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt, step.name, step.loopIteration);
		}
		if (childIds.length > 0) {
			this.deps.appendUserMessage(this.userMessage("resume", "broadcast", resumePrompt ?? DEFAULT_RESUME_PROMPT));
			this.commitPausedRegistry();
		}
	}
	/** 登记表变更后同步持久化（pausedChildIds + 实例 status；空表 → running）。 */
	commitPausedRegistry() {
		const next = {
			...this.deps.readState(),
			status: this.pausedChildIds.size > 0 ? "paused" : "running",
			pausedChildIds: [...this.pausedChildIds],
			updatedAt: now$2()
		};
		this.deps.commitState(next);
	}
	/**
	* 按 stepId（定义 id 或唯一执行 id）反查"最后活跃段"（status running/interacting 中
	* attemptIndex 最大者）；无活跃段时回退同 stepId 的任意段（再退唯一执行 id）。
	* 段模型下同 step 可有多段（attempt0 paused + attempt1 running），暂停/恢复必须定位活跃段。
	*/
	findStep(stepId) {
		const steps = this.deps.readState().executedSteps;
		const byStep = steps.filter((step) => step.stepId === stepId);
		if (byStep.length > 0) return byStep.filter((step) => step.status === "running" || step.status === "interacting").sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0] ?? byStep[byStep.length - 1];
		return steps.find((step) => step.id === stepId);
	}
	/** 按子代理 SessionId 反查 Step（`resumeAllSteps` 遍历登记表用）。 */
	findStepByChildId(childId) {
		return this.deps.readState().executedSteps.find((step) => this.childIdOf(step) === childId);
	}
	/** 反查 Step 的子代理 SessionId（缺省回退唯一执行 id）。 */
	childIdOf(step) {
		return step.sessionMeta?.childId ?? step.id;
	}
	/** 判定 Step 是否为非子代理命令（shell/prompt 合成占位，无真实子代理，不可暂停）。 */
	isNonSubagentCommand(step) {
		const type = step.command?.type;
		return type === "shell" || type === "prompt";
	}
	/** Step 对外展示 id（定义 stepId，缺省回退唯一执行 id）。 */
	stepIdOf(step) {
		return step.stepId ?? step.id;
	}
	/** 不可变重建状态：更新单个 Step 状态 + 同步登记表 + 持久化。 */
	commitStepStatus(step, status, extra) {
		const state = this.deps.readState();
		const next = {
			...state,
			status: this.pausedChildIds.size > 0 ? "paused" : "running",
			executedSteps: state.executedSteps.map((item) => {
				if (item.id !== step.id) return item;
				return {
					...item,
					status,
					...extra.pausedAt === void 0 ? {} : { pausedAt: extra.pausedAt }
				};
			}),
			pausedChildIds: [...this.pausedChildIds],
			updatedAt: now$2()
		};
		this.deps.commitState(next);
	}
	/** 构造一条用户消息记录（统一时间轴）。 */
	userMessage(kind, target, content) {
		return {
			id: `usr-${globalThis.crypto.randomUUID()}`,
			kind,
			target,
			content,
			createdAt: now$2()
		};
	}
};
//#endregion
//#region src/recovery-manager.ts
/** 当前 ISO 时间戳。 */
function now$1() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/** 文本 ContentBlock 的构造。 */
function textBlock(text) {
	return [{
		type: "text",
		text
	}];
}
/** 合成新子代理 SessionId（与 shell/prompt 的 `synthesizeChildId` 同规则）。 */
function synthesizeChildId(stepId) {
	return `step-${stepId}-${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
/**
* 计算 revert 模式的安全 turn 边界：最后一个闭合 turn 的末事件 seq。
*
* 事件流中 `turn/end` 标记一个闭合 turn 的结束；若事件流无任何 `turn/end`（整个
* 会话处于未闭合 turn），返回 `undefined`（revert 以错误结束）。fork 前据此截取前缀
* 可避免 DSH `sessions.fork` 的 `OPEN_TURN` 校验失败。
* @param events - 子代理会话事件流（含 `turn/start`/`turn/end` 边界事件）。
* @returns 最后一个闭合 turn 的末事件 seq，或无法取到合法闭合 turn 时为 `undefined`。
*/
function computeSafeRevertBoundary(events) {
	let lastClosedTurnEndSeq;
	for (const event of events) if (event.type === "turn/end") lastClosedTurnEndSeq = event.seq;
	return lastClosedTurnEndSeq;
}
/**
* 恢复协调器。
*
* 持有注入的依赖，实现 `retryStep`（三模式重试）与 `recover`（Step 分类恢复）；
* 状态更新以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
*/
var RecoveryManager = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* 重试单个 failed Step（continue/revert/fork 三模式共用续跑循环）。
	*
	* 前置校验：实例 completed 或 Step completed → 无害 no-op（不抛错、不改状态）；
	* Step running/interacting/paused → 抛 `INVALID_OPERATION`；仅 failed 可重试。
	* 随后清残留字段 + 置 running + 追加 `RetryRecord`（result 先 `running`）+ 发射
	* `sandore/step-retried`，按模式准备子代理会话（continue 不变 / revert 安全边界
	* fork + 新 agent / fork 全量 fork + 新 agent），followup 后 `resumeExecution`
	* 续跑，最后据实际结果更新 `retryHistory` 末条 result。
	* @param stepId - 待重试 Step 的定义 id（或唯一执行 id）。
	* @param mode - 重试模式。
	* @param message - 重试附带的提示消息。
	*/
	async retryStep(stepId, mode, message) {
		const state = this.deps.readState();
		if (state.status === "completed") return;
		const step = findStep(state.executedSteps, stepId);
		if (step === void 0) throw new SandoreError(`step '${stepId}' not found`, "INVALID_OPERATION");
		if (step.status === "completed") return;
		if (step.status !== "failed") throw new SandoreError(`step '${stepId}' is '${step.status}', only failed steps can be retried`, "INVALID_OPERATION");
		if (!isSubagentStep(step)) throw new SandoreError(`step '${stepId}' is not a resumable subagent step (shell/prompt cannot be retried)`, "INVALID_OPERATION");
		const retryRecord = {
			mode,
			timestamp: now$1(),
			userMessage: message,
			result: "running"
		};
		const cleaned = cleanStepResidue(step);
		const newSegmentId = globalThis.crypto.randomUUID();
		let runningStep = {
			...cleaned,
			id: newSegmentId,
			attemptIndex: (cleaned.attemptIndex ?? 0) + 1,
			createdAt: now$1(),
			startedAt: now$1(),
			status: "running",
			retryHistory: [...cleaned.retryHistory ?? [], retryRecord]
		};
		this.commitRunningStep(state, runningStep);
		this.deps.appendUserMessage({
			id: `usr-${globalThis.crypto.randomUUID()}`,
			kind: "retry",
			target: stepIdOf(step),
			content: message,
			createdAt: now$1()
		});
		this.deps.emitStepRetried(stepIdOf(step), mode, step.name, step.loopIteration);
		let childId = childIdOf(step);
		try {
			if (mode === "revert" || mode === "fork") {
				const sourceEvents = this.deps.getSession(childId)?.events ?? [];
				let boundary;
				if (mode === "revert") {
					boundary = computeSafeRevertBoundary(sourceEvents);
					if (boundary === void 0) throw new SandoreError(`cannot revert step '${stepId}': no closed turn boundary in child session`, "INVALID_OPERATION");
				}
				const forked = this.deps.forkSession(childId, boundary);
				const newChildId = synthesizeChildId(stepIdOf(step));
				await this.deps.createAgent({
					sessionId: newChildId,
					meta: {
						origin: "subagent",
						parentSession: childId,
						seedLength: forked.events.length
					},
					seed: forked.events
				});
				const sessionMeta = {
					...runningStep.sessionMeta ?? {
						command: "agent",
						synthetic: false
					},
					childId: newChildId,
					synthetic: false
				};
				runningStep = {
					...runningStep,
					sessionMeta,
					parentSessionId: childId
				};
				this.commitStep(this.deps.readState(), runningStep);
				childId = newChildId;
			}
			await this.deps.followup(childId, textBlock(message), this.deps.signal);
		} catch (error) {
			this.failRetry(newSegmentId);
			throw error;
		}
		try {
			await this.deps.resumeExecution();
		} catch (error) {
			this.failRetry(newSegmentId);
			throw error;
		}
		const result = findStep(this.deps.readState().executedSteps, newSegmentId)?.status === "completed" ? "completed" : "failed";
		this.setRetryResult(newSegmentId, result);
	}
	/**
	* 单实例恢复例程的 Step 分类处理（崩溃恢复）。
	*
	* 遍历快照 `executedSteps`：`running`/`interacting` 的子代理 Step 经 `followup`
	* 冷恢复（absent child 自动从持久化 Session 恢复）；合成 session（shell/prompt）
	* 无真实子代理，标记 `failed`（不可恢复）；`completed`/`failed`/`paused` 无需处理
	* （paused 登记表由引擎从 `pausedChildIds` 重建，等待手动 resume）。
	* @returns 分类结果（是否有可续跑子代理 / 是否有合成 session 失败）。
	*/
	async recover() {
		const state = this.deps.readState();
		const coldResumePrompt = "请从崩溃前的断点继续完成当前任务。";
		const running = state.executedSteps.filter((step) => step.status === "running" || step.status === "interacting");
		let hasFailure = false;
		for (const step of running) {
			if (isSubagentStep(step)) continue;
			this.commitStep(this.deps.readState(), {
				...step,
				status: "failed",
				error: "synthetic session is not recoverable"
			});
			hasFailure = true;
		}
		let hasResume = false;
		if (!hasFailure) {
			const resumeStep = running.find(isSubagentStep);
			if (resumeStep !== void 0) {
				const childId = childIdOf(resumeStep);
				await this.deps.followup(childId, textBlock(coldResumePrompt), this.deps.signal);
				hasResume = true;
			}
		}
		return {
			hasResume,
			hasFailure
		};
	}
	/** 不可变重建状态：更新单个 Step（按唯一执行 id 定位，不改实例状态）+ updatedAt。 */
	commitStep(prev, step) {
		this.deps.commitState({
			...prev,
			executedSteps: prev.executedSteps.map((item) => item.id === step.id ? step : item),
			updatedAt: now$1()
		});
	}
	/** 重试发起：追加新执行段（保留旧 failed 段定格快照）并置实例 running + updatedAt。 */
	commitRunningStep(prev, step) {
		this.deps.commitState({
			...prev,
			status: "running",
			executedSteps: [...prev.executedSteps, step],
			updatedAt: now$1()
		});
	}
	/** 重试会话准备/续跑失败：Step 回退 failed、实例 failed，记录 retryHistory 末条 result=failed。 */
	failRetry(stepId) {
		const state = this.deps.readState();
		const step = findStep(state.executedSteps, stepId);
		if (step === void 0) return;
		const retryHistory = markLastRetryResult(step.retryHistory ?? [], "failed");
		this.deps.commitState({
			...state,
			status: "failed",
			executedSteps: state.executedSteps.map((item) => item.id === stepId ? {
				...item,
				status: "failed",
				retryHistory
			} : item),
			updatedAt: now$1()
		});
	}
	/** 更新 retryHistory 末条记录的 result。 */
	setRetryResult(stepId, result) {
		const state = this.deps.readState();
		const step = findStep(state.executedSteps, stepId);
		if (step === void 0 || step.retryHistory === void 0 || step.retryHistory.length === 0) return;
		const retryHistory = markLastRetryResult(step.retryHistory, result);
		this.deps.commitState({
			...state,
			executedSteps: state.executedSteps.map((item) => item.id === stepId ? {
				...item,
				retryHistory
			} : item),
			updatedAt: now$1()
		});
	}
};
/** 从 executedSteps 中按定义 stepId 或唯一执行 id 反查 Step。 */
function findStep(steps, stepId) {
	return steps.find((step) => step.stepId === stepId) ?? steps.find((step) => step.id === stepId);
}
/** 反查 Step 的子代理 SessionId（缺省回退唯一执行 id）。 */
function childIdOf(step) {
	return step.sessionMeta?.childId ?? step.id;
}
/** Step 对外展示 id（定义 stepId，缺省回退唯一执行 id）。 */
function stepIdOf(step) {
	return step.stepId ?? step.id;
}
/** 判定 Step 是否为可续接子代理 Step（agent/skill/mcp，非 shell/prompt 合成 session）。 */
function isSubagentStep(step) {
	const command = step.sessionMeta?.command ?? step.command?.type;
	return command === "agent" || command === "skill" || command === "mcp";
}
/** 清除上一轮重试的残留字段（暂停细节/门禁评估现场；保留 sessionMessages 供消息框展示）。 */
function cleanStepResidue(step) {
	const { pausedAt: _pausedAt, pauseEntryId: _pauseEntryId, finalizeMeta: _finalizeMeta, ...rest } = step;
	return rest;
}
/** 更新 retryHistory 末条记录的 result（返回新数组）。 */
function markLastRetryResult(history, result) {
	if (history.length === 0) return [];
	return history.map((record, index) => index === history.length - 1 ? {
		...record,
		result
	} : record);
}
//#endregion
//#region src/workflow-engine.ts
/**
* sandore 工作流引擎运行时（Stage 级线性主循环）。
*
* `SandoreEngineRuntime` 继承 {@link SandoreEngine}：`startInstance` 异步完成
* 读定义 → parse → 生成 instanceId → 初始化 pending 快照 → `ctx.agents.create`
* 创建宿主主代理（setup 注册 8 个 `sandore_*` 工具）→ fire-and-forget
* `execute`；`execute` 以 Stage 级线性主循环编排（StageExecutor 执行 Stage 内
* Step → 收集 StageContract → `tryAdvanceStage` 跟随 `Stage.next`）。每次状态
* 变化 `persistState` 并双发 `sandore/*` 事件（`ctx.emit` + 宿主 Session
* `append`）；每个 Step 完成后经 `onPersist` 钩子立即追加到
* `state.executedSteps` 并持久化；`childId = step-{stepId}-{execId 前 8 位}`
* 合成 sessionMeta。
* @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine
*/
/** 实例终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES = /* @__PURE__ */ new Set([
	"completed",
	"failed",
	"aborted"
]);
/** 渲染任意抛出值为可读消息。 */
function renderError(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 当前 ISO 时间戳。 */
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/** 从 executedSteps 中定位处于 interacting 且携带 ask 载荷的 Step。 */
function findAskStep(steps) {
	for (const step of steps) {
		const payload = step.finalizeMeta?.assessResult?.askQuestion;
		if (step.status === "interacting" && payload !== void 0) return {
			step,
			payload
		};
	}
}
/** 生成实例 ID（UUID 格式，同时作为 state 表键、宿主会话 id 与 taskId）。 */
function makeInstanceId() {
	return globalThis.crypto.randomUUID();
}
/** 权限预设 → sandbox 模式 + 审批策略（对齐 DSH permission-presets 的默认表）。 */
const PERMISSION_SPECS = {
	"read-only": {
		sandbox: "read-only",
		approval: "ask"
	},
	"workspace-write": {
		sandbox: "workspace-write",
		approval: "ask"
	},
	"danger-full-access": {
		sandbox: "danger-full-access",
		approval: "never"
	}
};
/** 构造实例初始（pending）状态快照。 */
function makeInitialState(options) {
	const { instanceId, request, definition, createdAt, cwd } = options;
	return {
		taskId: instanceId,
		workflowId: request.workflowId,
		workflowName: definition.name,
		...definition.description === void 0 ? {} : { description: definition.description },
		...request.model === void 0 ? {} : { modelSelection: request.model },
		...request.permission === void 0 ? {} : { permission: request.permission },
		cwd,
		status: "pending",
		originalInput: request.originalInput,
		currentStageId: definition.stages[0]?.id ?? "",
		executedSteps: [],
		stageInfos: definition.stages.map((stage) => ({
			id: stage.id,
			name: stage.name,
			status: "blocked"
		})),
		pendingInteractions: [],
		pendingQueue: [],
		visitCounts: {},
		passThroughVars: {},
		activeLoopIterationStack: [],
		activeLoopNodeId: null,
		activeLoopStack: [],
		pausedChildIds: [],
		userMessages: [{
			id: `usr-${globalThis.crypto.randomUUID()}`,
			kind: "input",
			target: "",
			content: request.originalInput,
			createdAt
		}],
		stageContracts: {},
		createdAt,
		updatedAt: createdAt
	};
}
/** 从完整状态快照投影 `DagInstanceState`（引擎 `getState` 的返回形状）。 */
function toDagInstanceState(state) {
	return {
		taskId: state.taskId,
		workflowId: state.workflowId,
		status: state.status,
		originalInput: state.originalInput,
		currentStageId: state.currentStageId,
		executedSteps: state.executedSteps,
		stageInfos: state.stageInfos,
		pendingQueue: state.pendingQueue,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt
	};
}
/**
* 工作流引擎运行时。
*
* 作为 workflow 包默认导出：实现 11 个实例级生命周期方法
* （start/recover/abort/reply/pause/resume/retry/getState），其中 8 个
* 交互/生命周期/恢复方法转调 interaction/lifecycle/recovery 三管理器。
*/
var SandoreEngineRuntime = class extends SandoreEngine {
	config;
	static Config = z$1.object({
		defaultTimeoutMs: z$1.natural().default(72e5),
		maxConcurrentSteps: z$1.natural().default(0),
		defaultProvider: z$1.string(),
		defaultModel: z$1.string()
	});
	static inject = [
		"sessions",
		"sessionPersistence",
		"subagents",
		"agents",
		"llm",
		"shell",
		"subprocess",
		"fs",
		"storageDomain",
		"sandorePersistence",
		"userQuestions",
		"sessionTitle"
	];
	instances = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
	}
	/** 启动时（Cordis Service.init）自动扫描并恢复孤儿实例（崩溃恢复启动扫描）。 */
	async [Service.init]() {
		await this.recoverOrphanedInstances();
	}
	/** 启动实例：读定义 → parse → 初始化 pending 快照 → 创建宿主主代理 → fire-and-forget 执行。 */
	async startInstance(request) {
		const persistence = this.persistence();
		if (persistence === void 0) throw new SandoreError("sandore persistence is not available", "INVALID_OPERATION");
		const record = persistence.definitions.get(request.workflowId);
		if (record === void 0) throw new SandoreError(`definition '${request.workflowId}' not found`, "NODE_NOT_FOUND");
		const definition = parseWorkflowYaml(record.yaml);
		const instanceId = makeInstanceId();
		const createdAt = now();
		const cwd = request.cwd ?? "/tmp";
		const state = makeInitialState({
			instanceId,
			request,
			definition,
			createdAt,
			cwd
		});
		const controller = new AbortController();
		const presets = this.ctx.get("agentPresets");
		const resolvedPresetId = presets === void 0 ? void 0 : (await presets.resolve())?.id;
		const hostAgent = (await this.ctx.agents.create({
			sessionId: SessionId(instanceId),
			meta: {
				cwd,
				...resolvedPresetId === void 0 ? {} : { agentPreset: resolvedPresetId }
			},
			setup: createHostAgentSetup({
				instanceId,
				...presets === void 0 ? {} : { presets }
			})
		})).agent;
		const session = this.ctx.sessions.get(SessionId(instanceId));
		if (session === void 0) throw new SandoreError(`host session '${instanceId}' was not published`, "INVALID_OPERATION");
		try {
			this.ctx.sessionTitle.rename(session, `工作流实例 ${instanceId}`);
		} catch (error) {
			this.ctx.logger.warn(`sandore: set host session title failed: ${renderError(error)}`);
		}
		if (request.permission !== void 0) this.applyPermission(session, hostAgent, request.permission);
		const active = this.buildActiveInstance(controller, session, hostAgent, definition, state);
		this.instances.set(instanceId, active);
		this.persistState(active);
		this.execute(instanceId);
		return {
			instanceId,
			status: "running"
		};
	}
	/**
	* 应用创建实例时选择的权限预设：宿主会话 sandbox 模式（`sandbox/mode` 事件，
	* 对齐 `setSandboxMode`）+ 审批策略（`ctx.approval.setPolicy`）。失败仅记录 warn，
	* 不得使 startInstance 失败；shell/子代理在后续调用时折叠会话模式生效。
	*/
	applyPermission(session, agent, permission) {
		const spec = PERMISSION_SPECS[permission];
		if (spec === void 0) {
			this.ctx.logger.warn(`sandore: unknown permission preset '${permission}' ignored`);
			return;
		}
		try {
			session.append("sandbox/mode", { mode: spec.sandbox });
		} catch (error) {
			this.ctx.logger.warn(`sandore: apply sandbox mode failed: ${renderError(error)}`);
		}
		try {
			this.ctx.get("approval")?.setPolicy(agent, spec.approval);
		} catch (error) {
			this.ctx.logger.warn(`sandore: apply approval policy failed: ${renderError(error)}`);
		}
	}
	/** 查询实例的当前状态快照（内存活跃实例优先，state 表兜底读）。 */
	getState(instanceId) {
		const active = this.instances.get(instanceId);
		if (active !== void 0) return toDagInstanceState(active.state);
		const persisted = this.persistence()?.state.get(instanceId);
		if (persisted === void 0) throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
		return toDagInstanceState(persisted);
	}
	/**
	* 中止运行中的实例：置中止标志 → 登记表内全部子代理 interrupt（ancestor）→
	* 实例 aborted 终态（保留持久化快照）→ 双发 `sandore/aborted` → 清理内存
	* ActiveInstance（getState 退回 state 表仍可读到 aborted 快照）。
	*/
	async abortInstance(instanceId) {
		const active = this.instances.get(instanceId);
		if (active === void 0) {
			const persisted = this.persistence()?.state.get(instanceId);
			if (persisted !== void 0 && TERMINAL_STATUSES.has(persisted.status)) throw new SandoreError(`instance '${instanceId}' is already in terminal state '${persisted.status}'`, "INVALID_OPERATION");
			throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
		}
		if (TERMINAL_STATUSES.has(active.state.status)) throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, "INVALID_OPERATION");
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		active.controller.abort();
		for (const childId of active.lifecycle.pausedIds) this.ctx.subagents.interrupt(childId, {
			kind: "ancestor",
			agent: active.hostAgent
		});
		active.state = {
			...active.state,
			status: "aborted",
			updatedAt: now()
		};
		await this.persistState(active);
		this.emitAborted(active.session, info);
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
	async recoverInstance(instanceId) {
		const existing = this.instances.get(instanceId);
		if (existing !== void 0) {
			if (TERMINAL_STATUSES.has(existing.state.status)) throw new SandoreError(`instance '${instanceId}' is already in terminal state '${existing.state.status}'`, "INVALID_OPERATION");
			return {
				instanceId,
				status: existing.state.status
			};
		}
		const persistence = this.persistence();
		if (persistence === void 0) throw new SandoreError("sandore persistence is not available", "INVALID_OPERATION");
		const snapshot = persistence.state.get(instanceId);
		if (snapshot === void 0) throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
		if (TERMINAL_STATUSES.has(snapshot.status)) throw new SandoreError(`instance '${instanceId}' is already in terminal state '${snapshot.status}'`, "INVALID_OPERATION");
		const record = persistence.definitions.get(snapshot.workflowId);
		if (record === void 0) throw new SandoreError(`definition '${snapshot.workflowId}' not found`, "NODE_NOT_FOUND");
		const definition = parseWorkflowYaml(record.yaml);
		const controller = new AbortController();
		const presets = this.ctx.get("agentPresets");
		const hostAgent = (await this.ctx.agents.resume({
			resumeSessionId: SessionId(instanceId),
			setup: createHostAgentSetup({
				instanceId,
				...presets === void 0 ? {} : { presets }
			})
		})).agent;
		const session = this.ctx.sessions.get(SessionId(instanceId));
		if (session === void 0) throw new SandoreError(`host session '${instanceId}' was not published`, "INVALID_OPERATION");
		const active = this.buildActiveInstance(controller, session, hostAgent, definition, snapshot);
		this.instances.set(instanceId, active);
		await this.persistState(active);
		const recoverResult = await active.recovery.recover();
		if (recoverResult.hasFailure) {
			active.state = {
				...active.state,
				status: "failed",
				updatedAt: now()
			};
			await this.persistState(active);
			return {
				instanceId,
				status: "failed"
			};
		}
		if (recoverResult.hasResume) {
			this.resumeExecution(active);
			return {
				instanceId,
				status: "running"
			};
		}
		if (this.hasPausedStep(active)) return {
			instanceId,
			status: active.state.status
		};
		active.state = {
			...active.state,
			status: "running",
			updatedAt: now()
		};
		await this.persistState(active);
		this.resumeExecution(active);
		return {
			instanceId,
			status: "running"
		};
	}
	/**
	* 孤儿实例启动扫描：遍历 state 表全部条目 → 跳过终态 → 逐个调用
	* `recoverInstance`。单实例失败不阻断（逐实例 try/catch），返回
	* `{ recovered, errors }`。
	*/
	async recoverOrphanedInstances() {
		const recovered = [];
		const errors = [];
		const persistence = this.persistence();
		if (persistence === void 0) return {
			recovered,
			errors
		};
		for (const [instanceId, snapshot] of persistence.state.entries()) {
			if (TERMINAL_STATUSES.has(snapshot.status)) continue;
			try {
				await this.recoverInstance(instanceId);
				recovered.push(instanceId);
			} catch (error) {
				errors.push({
					instanceId,
					error: renderError(error)
				});
			}
		}
		return {
			recovered,
			errors
		};
	}
	async replyQuestion(instanceId, requestId, answers) {
		const active = this.instances.get(instanceId);
		if (active === void 0) throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
		await active.interactions.replyQuestion(requestId, answers);
	}
	async replyPermission(instanceId, requestId, reply) {
		const active = this.instances.get(instanceId);
		if (active === void 0) throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
		await active.interactions.replyPermission(requestId, reply);
	}
	/** 暂停单个 Step（委托生命周期协调器：反查 childId → interrupt → 登记表 → 状态 paused）。 */
	async pauseStep(instanceId, stepId) {
		this.requireActive(instanceId).lifecycle.pauseStep(stepId);
	}
	/** 恢复单个 Step（委托生命周期协调器：反查 childId → 移出登记表 → followup → 状态 running）。 */
	async resumeStep(instanceId, stepId, resumePrompt) {
		const active = this.requireActive(instanceId);
		await active.lifecycle.resumeStep(stepId, resumePrompt);
		this.notifyResume(active);
	}
	/** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
	async pauseAllSteps(instanceId) {
		this.requireActive(instanceId).lifecycle.pauseAllSteps();
	}
	/** 恢复登记表内全部 Step（逐个 followup 并清空登记表）。 */
	async resumeAllSteps(instanceId, resumePrompt) {
		const active = this.requireActive(instanceId);
		await active.lifecycle.resumeAllSteps(resumePrompt);
		this.notifyResume(active);
	}
	/** 重试单个 Step（continue/revert/fork 三模式，委托恢复协调器）。 */
	async retryStep(instanceId, stepId, mode, message) {
		await this.requireActive(instanceId).recovery.retryStep(stepId, mode, message);
	}
	async execute(instanceId) {
		const active = this.instances.get(instanceId);
		if (active === void 0) return;
		await this.runAndCatch(active, false);
	}
	/** 重试/恢复后的续跑执行（复用 runInstance 主循环，从快照续跑，不重发 start）。 */
	async resumeExecution(active) {
		await this.runAndCatch(active, true);
	}
	/** 运行主循环并兜底引擎级故障为 failed 终态。 */
	async runAndCatch(active, isResume) {
		try {
			await this.runInstance(active, isResume);
		} catch (error) {
			active.state = {
				...active.state,
				status: "failed",
				updatedAt: now()
			};
			await this.persistState(active);
			const info = {
				taskId: active.state.taskId,
				workflowId: active.state.workflowId
			};
			this.emitEnd(active.session, info, {
				taskId: active.state.taskId,
				status: "failed",
				error: renderError(error)
			});
		}
	}
	async runInstance(active, isResume = false) {
		const { controller, session, hostAgent, definition } = active;
		const signal = controller.signal;
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		if (!isResume) {
			active.state = {
				...active.state,
				status: "running",
				updatedAt: now()
			};
			await this.persistState(active);
			this.emitStart(session, info);
		}
		const runnerConfig = this.runnerConfig(definition, hostAgent, active);
		const navigator = new WorkflowDagNavigator(definition, this.ctx, runnerConfig, {
			activeLoopStack: active.state.activeLoopStack,
			activeLoopIterationStack: active.state.activeLoopIterationStack
		}, {
			currentStageId: this.resumeStageId(active),
			stageContracts: active.state.stageContracts
		});
		const loopManager = navigator.loopManagerInstance;
		/** 当前循环迭代路径（无活跃循环时省略，供 step-* 事件 payload 使用）。 */
		const currentLoopIteration = () => {
			const path = loopManager.buildLoopIterationPath();
			return path.length > 0 ? path : void 0;
		};
		const finalizeManager = new FinalizeManager(this.ctx, runnerConfig);
		let stageId = navigator.currentNodeId;
		while (stageId !== "") {
			const stage = definition.stages.find((item) => item.id === stageId);
			if (stage === void 0) break;
			this.markStageStatus(active, stageId, "running");
			await this.persistState(active);
			this.emitStageStart(session, info, stageId);
			const hooks = {
				onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId, step.name ?? step.id, currentLoopIteration()),
				onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output, step.name ?? step.id, currentLoopIteration()),
				onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error, step.name ?? step.id, currentLoopIteration())
			};
			const resumeFrom = this.resumeInfo(active, stage);
			const executor = new StageExecutor({
				ctx: this.ctx,
				stageDef: stage,
				workflowDef: definition,
				input: {
					originalInput: active.state.originalInput,
					contractArtifacts: navigator.getContractArtifacts(),
					passThroughVars: active.state.passThroughVars
				},
				sharedState: {
					cwd: active.state.cwd,
					taskId: active.state.taskId
				},
				runnerConfig,
				signal,
				hooks,
				loopManager,
				finalizeManager,
				resolveNextNodes: (nodeId, context) => navigator.resolveNextNodes(nodeId, context),
				visitCounts: active.state.visitCounts,
				...resumeFrom === void 0 ? {} : { resumeFrom },
				onPersist: async (executed) => {
					const entry = executed;
					const index = active.state.executedSteps.findIndex((item) => item.id === entry.id);
					active.state = {
						...active.state,
						executedSteps: index >= 0 ? active.state.executedSteps.map((item, i) => i === index ? entry : item) : [...active.state.executedSteps, entry],
						updatedAt: now()
					};
					if (entry.status === "completed" && entry.sessionMeta?.synthetic === false) active.lifecycle.clearPausedOnCompletion(entry.sessionMeta.childId);
					await this.persistState(active);
				}
			});
			let result = await executor.execute();
			while (result.status === "interacting" || result.status === "paused") {
				if (result.status === "interacting") {
					this.markStageStatus(active, stageId, "interacting");
					active.state = {
						...active.state,
						status: "interacting",
						updatedAt: now()
					};
					await this.persistState(active);
					const ask = findAskStep(active.state.executedSteps);
					if (ask === void 0) return;
					const entry = {
						id: ask.step.id,
						stageId: ask.step.stageId,
						stepId: ask.step.stepId ?? ask.step.id,
						sessionId: active.state.taskId,
						requestId: globalThis.crypto.randomUUID(),
						kind: "question",
						status: "pending",
						payload: ask.payload,
						createdAt: now()
					};
					const answerText = buildAnswerText(await active.interactions.ask({
						entry,
						...signal === void 0 ? {} : { signal }
					}));
					const childId = ask.step.sessionMeta?.childId;
					if (childId !== void 0 && ask.step.sessionMeta?.synthetic === false) await this.ctx.subagents.followup(hostAgent, childId, [{
						type: "text",
						text: answerText
					}], {
						source: { kind: "user" },
						signal: controller.signal
					});
					active.state = {
						...active.state,
						userMessages: [...active.state.userMessages ?? [], {
							id: globalThis.crypto.randomUUID(),
							kind: "answer",
							target: ask.step.stepId ?? ask.step.id,
							content: answerText,
							createdAt: now()
						}],
						updatedAt: now()
					};
					await this.persistState(active);
				} else await this.waitForResume(active);
				if (signal.aborted) break;
				result = await executor.execute();
			}
			if (signal.aborted) {
				this.markStageStatus(active, stageId, "failed");
				if (active.state.status !== "aborted") {
					active.state = {
						...active.state,
						status: "aborted",
						updatedAt: now()
					};
					await this.persistState(active);
					this.emitAborted(session, info);
				}
				return;
			}
			active.state = {
				...active.state,
				passThroughVars: {
					...active.state.passThroughVars,
					...result.passThroughVars
				},
				updatedAt: now()
			};
			if (result.status === "failed") {
				this.markStageStatus(active, stageId, "failed");
				active.state = {
					...active.state,
					status: "failed",
					stageContracts: {
						...active.state.stageContracts,
						[stageId]: result.stageContract
					},
					updatedAt: now()
				};
				await this.persistState(active);
				this.emitEnd(session, info, {
					taskId: info.taskId,
					status: "failed",
					...result.errorDetail === void 0 ? {} : { error: result.errorDetail }
				});
				return;
			}
			const stageContract = result.stageContract;
			this.markStageStatus(active, stageId, "completed");
			navigator.setStageContract(stageId, stageContract);
			active.state = {
				...active.state,
				currentStageId: stageId,
				stageContracts: {
					...active.state.stageContracts,
					[stageId]: stageContract
				},
				updatedAt: now()
			};
			await this.persistState(active);
			this.emitStageCompleted(session, info, stageId, stageContract);
			if (!navigator.tryAdvanceStage()) stageId = "";
			else stageId = navigator.currentNodeId;
		}
		active.state = {
			...active.state,
			status: "completed",
			updatedAt: now()
		};
		await this.persistState(active);
		this.emitEnd(session, info, {
			taskId: info.taskId,
			status: "completed"
		});
	}
	markStageStatus(active, stageId, status) {
		active.state = {
			...active.state,
			stageInfos: active.state.stageInfos.map((item) => item.id === stageId ? {
				...item,
				status
			} : item)
		};
	}
	runnerConfig(definition, hostAgent, active) {
		const instanceModel = active.state.modelSelection;
		return {
			defaultTimeoutMs: this.config.defaultTimeoutMs ?? 72e5,
			...instanceModel === void 0 ? {} : {
				defaultProvider: instanceModel.provider,
				defaultModel: instanceModel.model
			},
			...this.config.defaultProvider === void 0 ? {} : { defaultProvider: this.config.defaultProvider },
			...this.config.defaultModel === void 0 ? {} : { defaultModel: this.config.defaultModel },
			skills: definition.skills,
			mcps: definition.mcps,
			agents: definition.agents,
			hostAgent,
			onChildStarted: async (stepId, childId) => {
				const entry = active.state.executedSteps.filter((item) => item.stepId === stepId && item.status === "running").sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
				if (entry === void 0 || entry.sessionMeta === void 0) return;
				const sessionMeta = {
					...entry.sessionMeta,
					childId,
					synthetic: false
				};
				active.state = {
					...active.state,
					executedSteps: active.state.executedSteps.map((item) => item.id === entry.id ? {
						...item,
						sessionMeta
					} : item),
					updatedAt: now()
				};
				await this.persistState(active);
			},
			isPausedChild: (childId) => active.lifecycle.hasPaused(childId),
			onDelegatedAsk: async ({ childId, output, stepId, stageId }) => {
				return (await active.interactions.delegateSubagentAsk({
					childId,
					output,
					stageId,
					stepId,
					sessionId: active.state.taskId,
					...active.controller.signal === void 0 ? {} : { signal: active.controller.signal }
				})).delegated;
			}
		};
	}
	/** 构造完整 ActiveInstance（交互/生命周期/恢复三个管理器 + 宿主主代理 + 状态快照）。 */
	buildActiveInstance(controller, session, hostAgent, definition, state) {
		let active;
		active = {
			controller,
			session,
			hostAgent,
			definition,
			interactions: new InteractionManager({
				hostAgent,
				userQuestions: () => this.ctx.get("userQuestions"),
				persist: (entries) => {
					active.state = {
						...active.state,
						pendingInteractions: entries,
						updatedAt: now()
					};
					this.persistState(active);
				},
				emitQuestion: (entry) => this.emitQuestion(session, active, entry),
				emitPermission: (entry) => this.emitPermission(session, active, entry),
				followup: async (childId, content) => {
					await this.ctx.subagents.followup(hostAgent, childId, content, {
						source: { kind: "user" },
						signal: controller.signal
					});
				}
			}),
			lifecycle: new LifecycleManager({
				hostAgent,
				initialPausedChildIds: state.pausedChildIds,
				interrupt: (childId, authority) => this.ctx.subagents.interrupt(childId, authority),
				followup: async (childId, content, signal) => {
					await this.ctx.subagents.followup(hostAgent, childId, content, {
						source: { kind: "user" },
						signal
					});
				},
				getAgent: (childId) => this.ctx.agents.get(childId) ?? void 0,
				signal: controller.signal,
				readState: () => active.state,
				commitState: (next) => {
					active.state = next;
					this.persistState(active);
				},
				appendUserMessage: (record) => {
					active.state = {
						...active.state,
						userMessages: [...active.state.userMessages ?? [], record],
						updatedAt: now()
					};
					this.persistState(active);
				},
				emitStepPaused: (stepId, childId, name, loopIteration) => this.emitStepPaused(session, active, stepId, childId, name, loopIteration),
				emitStepResumed: (stepId, childId, resumePrompt, name, loopIteration) => this.emitStepResumed(session, active, stepId, childId, resumePrompt, name, loopIteration)
			}),
			recovery: new RecoveryManager({
				signal: controller.signal,
				readState: () => active.state,
				commitState: (next) => {
					active.state = next;
					this.persistState(active);
				},
				appendUserMessage: (record) => {
					active.state = {
						...active.state,
						userMessages: [...active.state.userMessages ?? [], record],
						updatedAt: now()
					};
					this.persistState(active);
				},
				followup: async (childId, content, signal) => {
					await this.ctx.subagents.followup(hostAgent, childId, content, {
						source: { kind: "user" },
						signal
					});
				},
				createAgent: (options) => this.ctx.agents.create(options),
				getSession: (id) => {
					const child = this.ctx.sessions.get(SessionId(id));
					return child === void 0 ? void 0 : { events: child.events };
				},
				forkSession: (source, boundary) => {
					return { events: this.ctx.sessions.fork(SessionId(source), boundary).events };
				},
				emitStepRetried: (stepId, mode, name, loopIteration) => this.emitStepRetried(session, active, stepId, mode, name, loopIteration),
				resumeExecution: () => this.resumeExecution(active)
			}),
			state,
			resumeRequested: false,
			resumeWaiters: []
		};
		return active;
	}
	/** 快照是否含 paused Step（paused-only 实例等待手动 resume，不自动重跑）。 */
	hasPausedStep(active) {
		return active.state.executedSteps.some((step) => step.status === "paused");
	}
	/** 从段列表中取"最后活跃段"（status running/interacting 中 attemptIndex 最大者）。 */
	findActiveSegment(steps) {
		return steps.filter((step) => step.status === "running" || step.status === "interacting").sort((a, b) => (b.attemptIndex ?? 0) - (a.attemptIndex ?? 0))[0];
	}
	/** 续跑执行位置的起始 Stage：running/interacting Step 所在 Stage，否则 currentStageId。 */
	resumeStageId(active) {
		return this.findActiveSegment(active.state.executedSteps)?.stageId ?? active.state.currentStageId;
	}
	/** 计算 Stage 续跑播种：跳过已完成 Step 并从 running/interacting 子代理 Step 续跑。 */
	resumeInfo(active, stage) {
		const stageSteps = active.state.executedSteps.filter((step) => step.stageId === stage.id);
		const resumeStep = this.findActiveSegment(stageSteps);
		if (resumeStep === void 0) return;
		const stepDef = stage.steps.find((step) => step.id === (resumeStep.stepId ?? resumeStep.id));
		if (stepDef === void 0) return;
		const definitionStep = active.definition.steps?.find((step) => step.id === stepDef.id);
		const mergedStep = definitionStep === void 0 ? { id: stepDef.id } : { ...definitionStep };
		return {
			completedSteps: stageSteps.filter((step) => step.id !== resumeStep.id && step.status === "completed"),
			resumeSubagent: {
				step: mergedStep,
				executed: resumeStep,
				childId: resumeStep.sessionMeta?.childId ?? resumeStep.id
			}
		};
	}
	persistence() {
		return this.ctx.get("sandorePersistence");
	}
	/** 取内存活跃实例；未命中抛 `NODE_NOT_FOUND`。 */
	requireActive(instanceId) {
		const active = this.instances.get(instanceId);
		if (active === void 0) throw new SandoreError(`instance '${instanceId}' not found`, "NODE_NOT_FOUND");
		return active;
	}
	/**
	* 主循环 paused 时等待 resume 信号（与 `signal.aborted` 竞争）。
	*
	* 若 resume 已先行触发（竞态：resumeStep 先于主循环进入等待），立即消费标志返回；
	* 否则注册 waiter 并监听 abort：由 `notifyResume` 在 resumeStep/resumeAllSteps 时
	* resolve，或由 `abortInstance` 的 `controller.abort()` 触发 abort 监听 resolve——
	* 主循环恢复后经 `signal.aborted` 检查退出到 aborted 处理分支，避免 paused 期中止
	* 导致主循环永久悬挂。
	*/
	async waitForResume(active) {
		if (active.resumeRequested) {
			active.resumeRequested = false;
			return;
		}
		await new Promise((resolve) => {
			if (active.controller.signal.aborted) {
				resolve();
				return;
			}
			const onAbort = () => resolve();
			active.controller.signal.addEventListener("abort", onAbort, { once: true });
			active.resumeWaiters.push(() => {
				active.controller.signal.removeEventListener("abort", onAbort);
				resolve();
			});
		});
	}
	/** resumeStep/resumeAllSteps 成功后唤醒等待 resume 的主循环（无 waiter 时置标志）。 */
	notifyResume(active) {
		if (active.resumeWaiters.length > 0) {
			const waiters = active.resumeWaiters.splice(0);
			for (const resolve of waiters) resolve();
			return;
		}
		active.resumeRequested = true;
	}
	async persistState(active) {
		const persistence = this.persistence();
		if (persistence === void 0) return;
		try {
			await persistence.saveWorkflowState(active.state);
		} catch (error) {
			this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
		}
	}
	emitContained(name, args) {
		for (const callback of this.ctx.events.dispatch("emit", [name, ...args])) try {
			const returned = callback(...args);
			Promise.resolve(returned).catch((error) => {
				this.ctx.logger.warn(`sandore: ${name} listener rejected: ${renderError(error)}`);
			});
		} catch (error) {
			this.ctx.logger.warn(`sandore: ${name} listener threw: ${renderError(error)}`);
		}
	}
	safeAppend(fn) {
		try {
			fn();
		} catch (error) {
			this.ctx.logger.warn(`sandore: session append failed: ${renderError(error)}`);
		}
	}
	emitStart(session, info) {
		this.emitContained("sandore/start", [info]);
		this.safeAppend(() => session.append("sandore/start", {
			taskId: info.taskId,
			workflowId: info.workflowId
		}, { ignorable: true }));
	}
	emitStageStart(session, info, stageId) {
		this.emitContained("sandore/stage-start", [info, stageId]);
		this.safeAppend(() => session.append("sandore/stage-start", {
			taskId: info.taskId,
			stageId
		}, { ignorable: true }));
	}
	emitStageCompleted(session, info, stageId, stageContract) {
		this.emitContained("sandore/stage-completed", [
			info,
			stageId,
			stageContract
		]);
		this.safeAppend(() => session.append("sandore/stage-completed", {
			taskId: info.taskId,
			stageId,
			stageContract
		}, { ignorable: true }));
	}
	emitStepStart(session, info, stepId, childId, name, loopIteration) {
		this.emitContained("sandore/step-start", [
			info,
			stepId,
			childId,
			name,
			...loopIteration === void 0 ? [] : [loopIteration]
		]);
		this.safeAppend(() => session.append("sandore/step-start", {
			stepId,
			childId,
			name,
			...loopIteration === void 0 ? {} : { loopIteration }
		}, { ignorable: true }));
	}
	emitStepCompleted(session, info, stepId, childId, output, name, loopIteration) {
		this.emitContained("sandore/step-completed", [
			info,
			stepId,
			childId,
			output,
			name,
			...loopIteration === void 0 ? [] : [loopIteration]
		]);
		this.safeAppend(() => session.append("sandore/step-completed", {
			stepId,
			childId,
			output,
			name,
			...loopIteration === void 0 ? {} : { loopIteration }
		}, { ignorable: true }));
	}
	emitStepFailed(session, info, stepId, childId, error, name, loopIteration) {
		this.emitContained("sandore/step-failed", [
			info,
			stepId,
			childId,
			error,
			name,
			...loopIteration === void 0 ? [] : [loopIteration]
		]);
		this.safeAppend(() => session.append("sandore/step-failed", {
			stepId,
			childId,
			error,
			name,
			...loopIteration === void 0 ? {} : { loopIteration }
		}, { ignorable: true }));
	}
	emitStepPaused(session, active, stepId, childId, name, loopIteration) {
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		this.emitContained("sandore/step-paused", [
			info,
			stepId,
			childId,
			name,
			...loopIteration === void 0 ? [] : [loopIteration]
		]);
		this.safeAppend(() => session.append("sandore/step-paused", {
			stepId,
			childId,
			name,
			...loopIteration === void 0 ? {} : { loopIteration }
		}, { ignorable: true }));
	}
	emitStepResumed(session, active, stepId, childId, resumePrompt, name, loopIteration) {
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		this.emitContained("sandore/step-resumed", [
			info,
			stepId,
			childId,
			resumePrompt,
			name,
			...loopIteration === void 0 ? [] : [loopIteration]
		]);
		this.safeAppend(() => session.append("sandore/step-resumed", {
			stepId,
			childId,
			...resumePrompt === void 0 ? {} : { resumePrompt },
			name,
			...loopIteration === void 0 ? {} : { loopIteration }
		}, { ignorable: true }));
	}
	emitStepRetried(session, active, stepId, mode, name, loopIteration) {
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		this.emitContained("sandore/step-retried", [
			info,
			stepId,
			mode,
			name,
			...loopIteration === void 0 ? [] : [loopIteration]
		]);
		this.safeAppend(() => session.append("sandore/step-retried", {
			stepId,
			mode,
			name,
			...loopIteration === void 0 ? {} : { loopIteration }
		}, { ignorable: true }));
	}
	emitEnd(session, info, result) {
		this.emitContained("sandore/end", [info, result]);
		this.safeAppend(() => session.append("sandore/end", {
			taskId: info.taskId,
			result
		}, { ignorable: true }));
	}
	emitAborted(session, info) {
		this.emitContained("sandore/aborted", [info]);
		this.safeAppend(() => session.append("sandore/aborted", { taskId: info.taskId }, { ignorable: true }));
	}
	emitQuestion(session, active, entry) {
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		this.emitContained("sandore/question", [info, entry]);
		this.safeAppend(() => session.append("sandore/question", { question: entry }, { ignorable: true }));
	}
	emitPermission(session, active, entry) {
		const info = {
			taskId: active.state.taskId,
			workflowId: active.state.workflowId
		};
		this.emitContained("sandore/permission", [info, entry]);
		this.safeAppend(() => session.append("sandore/permission", { permission: entry }, { ignorable: true }));
	}
};
//#endregion
//#region src/persistence.ts
/**
* sandore 存储域持久化 Provider。
*
* `SandorePersistence` 在 `[Service.init]` 中打开 `sandore` 域（两表
* `definitions`/`state`，去 job 概念），用 `ctx.effect` 挂 `Domain.close()` 释放，
* 并暴露两表 `KvTable` 句柄与 `saveWorkflowState`（`state.put(taskId, state)`
* 全量覆盖）。`SandoreRemote` 通过 `ctx.sandorePersistence` 访问这些句柄。
* @module @deepseek-ai/dsh-sandore-workflow/src/persistence
*/
/** sandore 存储域持久化 Provider。 */
var SandorePersistence = class extends Service {
	static inject = ["storageDomain"];
	definitionsTable;
	stateTable;
	constructor(ctx) {
		super(ctx, "sandorePersistence");
	}
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(sandoreDomainSpec);
		this.ctx.effect(() => () => domain.close(), "sandore.domainClose");
		this.definitionsTable = domain.table("definitions");
		this.stateTable = domain.table("state");
	}
	/** `definitions` 表句柄（key = workflowId）。 */
	get definitions() {
		return this.requireTable(this.definitionsTable, "definitions");
	}
	/** `state` 表句柄（key = instanceId）。 */
	get state() {
		return this.requireTable(this.stateTable, "state");
	}
	/**
	* 全量覆盖写入实例状态快照。
	* @param state - 完整运行时状态快照；以 `state.taskId`（instanceId）为键。
	*/
	async saveWorkflowState(state) {
		await this.state.put(state.taskId, state);
	}
	requireTable(table, name) {
		if (table === void 0) throw new Error(`sandore persistence is not initialized ('${name}' table unavailable)`);
		return table;
	}
};
//#endregion
//#region src/plugin.ts
/**
* sandore workflow 包的复合插件（默认导出）。
*
* `workflow` 包由三个独立 Service 组成一条依赖链：
*
* ```
* storageDomain ──▶ SandorePersistence   (sandorePersistence)
* sandorePersistence + sessions + … ──▶ SandoreEngineRuntime (sandoreEngine)
* sandorePersistence + sandoreEngine + llm ──▶ SandoreRemote (sandore RPC)
* ```
*
* 单元测试里三者经 `ctx.plugin(...)` 逐个注册，但生产 cordis.yml 只加载包默认
* 导出。因此本复合插件在 `[Service.init]` 中按拓扑序依次 `ctx.plugin(...)` 注册
* 三个子服务，使 `sandorePersistence` / `sandoreEngine` / `sandore` RPC 全部对
* 宿主可用；自身不 `inject` 任何子服务（它们各自声明依赖），Config 透传
* `SandoreEngineRuntime.Config`。
*
* @module @deepseek-ai/dsh-sandore-workflow/plugin
*/
var SandoreWorkflowPlugin = class extends Service {
	config;
	static Config = SandoreEngineRuntime.Config;
	constructor(ctx, config) {
		super(ctx, "sandoreWorkflow");
		this.config = config;
	}
	async [Service.init]() {
		await this.ctx.plugin(SandorePersistence);
		await this.ctx.plugin(SandoreEngineRuntime, this.config);
		await this.ctx.plugin(SandoreRemote);
	}
};
//#endregion
//#region src/index.ts
var src_default = SandoreWorkflowPlugin;
//#endregion
export { AskUserQuestionPayloadSchema, BranchMetaSchema, CommandConfigSchema, DagBranchSchema, DagLoopSchema, ExecutedStepDefaultSchema, FinalizeAssessResultSchema, FinalizeMetaSchema, GateEvalResultSchema, GatesSchema, InputFromItemSchema, OutputToItemSchema, PassThroughVarSchema, PendingPermissionEntrySchema, PendingQuestionEntrySchema, RetryRecordSchema, SandoreEngine, SandoreEngineRuntime, SandoreEngineStub, SandoreError, SandoreRemote, SandoreWorkflowPlugin, SessionMessageSchema, StageContractSchema, StageInfoSchema, StageStepSchema, StepSessionMetaSchema, UserMessageRecordSchema, WorkflowDagNavigator, WorkflowDefinitionRecordSchema, WorkflowDefinitionSchema, WorkflowSettingsSchema, WorkflowStageSchema, WorkflowStepSchema, WorkflowTaskStateSchema, WorkflowYamlError, convertLegacyToV2, src_default as default, isFatalSandoreError, parseWorkflowYaml, sandoreDomainSpec, serializeWorkflowYaml };
