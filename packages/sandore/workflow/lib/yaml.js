import { WorkflowDefinitionSchema } from "./schema.js";
import { parseDocument, stringify } from "yaml";
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
export { convertLegacyToV2, parseWorkflowYaml, serializeWorkflowYaml };
