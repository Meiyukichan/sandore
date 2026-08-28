/**
 * Step 收尾拆分（finalize-manager）。
 *
 * 5 阶段收尾重构后按阶段拆分为三个公开入口（stage-executor 的 `runPhaseA/B/C` 直接调用）：
 * - **Phase A（问题检测/评估，ask 保底）**：`assessOnly()` → `FinalizeAssessor.assess`
 *   **ask 判定**（是否需向用户提问）。**临时会话**（`llm.stream` 直调、不 fork、不带
 *   sessionId），输入 = `<stepContext>`（input/output/artifacts，`buildFinalizeContext`
 *   已含当前 step 子代理返回结果 output 文本）——评估无需 fork 会话：DSH 子代理 settle
 *   后 live store 已移除，`sessions.fork` 必然 SESSION_NOT_FOUND。`hasAsk` + askQuestion
 *   载荷 → Step 置 interacting（引擎级 ask 闭环，currentPhase='ask-detect'）；结果
 *   （hasAsk/askQuestion）维护在 state（finalizeMeta）并持久化，**不写回透传变量**
 *   （透传变量只在 Phase B 写回）。临时会话用完即删、不维持。
 * - **Phase B（收尾）**：`assessForked()` → `FinalizeAssessor.assessForked` **真 fork
 *   子代理**——经 `forkStepSubagent` 从 step 子代理完整事件（live → 持久化 inspect）
 *   截到闭合 turn 作 seed，`ctx.agents.create` 重建宿主主代理的子代理（meta
 *   `parentSession: hostAgent.id` + `origin: 'subagent'`），`followup(assessPrompt)` →
 *   `whenIdle()` → `finalAssistantOutput` → `parseAssessResult`；评估完 `dispose()`
 *   （live 移除、持久化记录保留，UI 可打开 assessSessionId）。fork/驱动失败降级
 *   `assess` 临时会话并记 errorDetail（不失败）。`commitFinalize(..., 'finalizing')`
 *   回写透传变量（保留 refresh）+ 组装 finalizeMeta（assessSessionId 持久化到 state）。
 * - **Phase C（门禁）**：`evaluateGates()` → `GateEvaluator`：**primary 门禁为纯代码
 *   产物校验**（outputTo 文件存在性，零 AI 调用），**secondary 门禁为 AI 门禁审查**
 *   （`secondaryEnabled` 时经 `subagents.startContinuable` 建宿主主代理的**可续接
 *   子代理**——与 step 执行子代理同机制：agent loop + 工具 + preset 系统提示词；
 *   prompt 携带 stepContext——settle 终态取输出（`awaitSubagentSettlement` 注入 /
 *   `whenIdle` 回退），失败降级临时会话记 errorDetail），`gatesPassed=false` 由调用方
 *   落 failed（currentPhase='gating'）。
 *
 * `finalizeStep()` 保留为编排兼容入口（跳过检查 → assessOnly → ask? → commit
 * 'finalizing' → evaluateGates → commitFinalize），供既有调用方/测试使用。
 * @module dsh-sandore/microflow/src/finalize-manager
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';

import { SandoreError } from './errors.ts';
import { fileExists, findFilesByGlob, findFilesByRegex, hasUnresolvedVars, isGlobPattern, resolveOutputToVars } from './file-utils.ts';
import { describeError, escapeXml, resolveProviderModel, textSummary } from './internal.ts';
import { driveAgentRound, forkStepSubagent } from './fork-session.ts';
import { finalAssistantOutput } from './subagents.ts';
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, SubagentSettlement } from './subagents.ts';
import type { PassThroughVarValue } from './stage-executor.ts';

import type { ExecutedStepDefault, FinalizeOutcome } from '../workflow/types';
import type {
  AskUserQuestionPayload,
  FinalizeAssessResult,
  FinalizeAskResult,
  FinalizeMeta,
  FinalizePhase,
  GateEvalResult,
  Gates,
  PassThroughVar,
  RoutingResult,
  WorkflowStep,
} from '../workflow/schema';

/** 收尾管理器引擎级配置（provider/model 三层回退的 L2 来源 + 收尾真 fork 能力注入）。 */
export interface FinalizeManagerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  /**
   * 宿主主代理 session id（收尾真 fork 子代理的 `meta.parentSession`，即 fork 子代理
   * 作为宿主主代理的子代理；引擎注入 `runnerConfig.hostAgent.id`）。
   */
  readonly hostAgentId?: string;
  /**
   * `ctx.agents.create` 的注入包装（引擎注入 `(o) => ctx.agents.create(o)`）。
   *
   * 仅 Phase B `assessForked` 经 `forkStepSubagent` 用它从 seed 重建宿主子代理；
   * 未注入时降级临时会话（记 errorDetail，不失败）。
   */
  readonly createAgent?: (options: CreateAgentOptions) => Promise<AgentHandle>;
  /**
   * 取 step 子代理完整事件（live → persistence 回退，引擎注入：`ctx.sessions.get` →
   * `ctx.get('sessionPersistence').inspect`）。`undefined` = 无事件源（shell 合成
   * 会话 / live 与持久化均无记录）→ 收尾真 fork 降级临时会话。
   */
  readonly getStepSessionEvents?: (childId: string) => Promise<readonly DshSessionEvent[] | undefined>;
  /**
   * 宿主主代理（secondary 门禁 `subagents.startContinuable` 的 `request.parent`；
   * 引擎注入 `runnerConfig.hostAgent`）。`undefined` = 未配置 → secondary 门禁降级
   * 临时会话（记 errorDetail，不失败）。
   */
  readonly hostAgent?: Agent;
  /**
   * 子代理 settle 终态等待（引擎注入 `runnerConfig.awaitSubagentSettlement`，经
   * `sandore/subagent-settled` 事件路由 DSH settle 终态）。缺省回退
   * `child.whenIdle()` + `finalAssistantOutput`（兼容无注入场景）。
   */
  readonly awaitSubagentSettlement?: (childId: string, signal: AbortSignal) => Promise<SubagentSettlement>;
  /**
   * DSH subagent provider 注册名（`startContinuable` 的 `provider`；缺省 `'fork'`，
   * DSH base bundle 已注册）。与模型路由解耦：模型路由经 `request.agentOptions`
   * 承载（`resolveForkAgentOptions`），不要把模型 provider id 填到这里。
   */
  readonly subagentProvider?: string;
}

/** Step 收尾评估上下文（`<stepContext>` 的 input/output/artifacts 块）。 */
export interface FinalizeStepContext {
  readonly input: string;
  readonly output: string;
  readonly artifacts?: readonly string[];
}

/** FinalizeAssessor 的评估输入。 */
export interface FinalizeAssessInput {
  readonly step: WorkflowStep;
  /** session 类型 Step 的 fork 源会话 ID（Phase B 真 fork 用；Phase A 临时会话忽略）。 */
  readonly stepSessionId?: string;
  readonly context: FinalizeStepContext;
  /** 收尾真 fork 子代理的工作目录（meta.cwd；Phase A 临时会话忽略）。 */
  readonly workdir?: string;
  readonly signal?: AbortSignal;
  /** fork 子代理创建后回调（上报真实 forkSessionId，供调用方立即 commit running + id）。 */
  readonly onForkCreated?: (forkSessionId: string) => void;
}

/** GateEvaluator 的评估输入。 */
export interface FinalizeGateInput {
  readonly step: WorkflowStep;
  readonly context: FinalizeStepContext;
  /** 三级合并后的门禁配置。 */
  readonly gates: Gates;
  readonly workdir: string;
  /**
   * 保留字段（兼容调用方透传）：secondary 门禁子代理**无 seed**（prompt 携带
   * stepContext，见 `buildSecondaryGatePrompt`），不消费本字段。primary 为纯代码
   * 产物校验、不建子代理。
   */
  readonly stepSessionId?: string;
  /**
   * outputTo 路径解析用的透传变量映射（缺陷 34）。
   *
   * 由 `FinalizeManager` 合并 `request.passThroughVars`（引擎累加器）+ 当次
   * `assessResult.passThroughVars`（快照提取值）后传入——使自引用变量
   * （本 Step 提取并在自身 outputTo 中引用的 `${xxx}`）在门禁时可解析。
   * 缺省 `{}`：含未解析占位符的路径走字面匹配自然不命中（确定性报 missing）。
   * **时序兼容**：verifyArtifacts 用此传入副本解析，不依赖提前持久化，避免
   * assess 与 gate 之间的变量竞态。
   */
  readonly vars?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** finalizeStep 编排请求（含回写目标与持久化钩子）。 */
export interface FinalizeStepRequest {
  readonly step: WorkflowStep;
  readonly executedStep: ExecutedStepDefault;
  readonly stepSessionId?: string;
  readonly context: FinalizeStepContext;
  /** 三级合并后的门禁配置；省略视为无门禁。 */
  readonly gates?: Gates;
  readonly workdir: string;
  /** 引擎透传变量累积器（就地回写提取结果）。 */
  readonly passThroughVars?: Record<string, PassThroughVarValue>;
  readonly signal?: AbortSignal;
  /** 同步 finalizeMeta 后的持久化回调（由引擎注入）。 */
  readonly onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
  /**
   * 收尾阶段流转回调（由引擎注入，发射 `sandore/step-phase` 事件）。
   *
   * 每次 `commitFinalize(currentPhase)` 写入 finalizeMeta 后触发一次；
   * `childId` 取执行段 `sessionMeta.childId`（shell 等无真实会话时为合成占位，
   * 可能为 undefined——引擎侧自行回退）。microflow 只透传、不发射事件。
   */
  readonly onPhaseChange?: (step: WorkflowStep, childId: string | undefined, phase: FinalizePhase) => void;
  /** fork 子代理创建后回调（上报真实 forkSessionId，供调用方立即 commit running + id）。 */
  readonly onForkCreated?: (forkSessionId: string) => void;
}

/** Assessor 解析出的 ask 判定结果（未含会话/原始输出字段；**不判完成度**）。 */
export interface AssessParsed {
  /**
   * 是否需要向用户提问确认后继续（ask 保底通道：`hasAsk=true` 且含 `askQuestion` 载荷
   * 才真正提问；`hasAsk=true` 但无载荷为假 ask，回落 completed）。
   */
  readonly hasAsk: boolean;
  readonly passThroughVars: Record<string, string>;
  readonly askQuestion?: AskUserQuestionPayload;
  /** Phase B 收尾压缩摘要（合并 JSON 的 compressedOutput；缺省 undefined）。 */
  readonly compressedOutput?: string;
}

/** secondary 门禁解析结果（`gateStatus` → passed）。 */
export interface SecondaryGateParsed {
  readonly passed: boolean;
  readonly detail?: string;
}

/** secondary 门禁子代理评估结果（含 gateSessionId/raw/passed + 降级说明）。 */
interface SecondaryGateEval {
  readonly gateSessionId: string;
  readonly raw: string;
  readonly passed: boolean;
  readonly detail?: string;
  /** 子代理路径降级到临时会话的原因（并入 `GateEvalResult.errorDetail`）。 */
  readonly degraded?: string;
}

/** 解析外部输出 JSON 为对象；解析失败或非对象返回 undefined。 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

/**
 * 剥离 markdown ```json 围栏，提取围栏内 JSON 文本。
 *
 * LLM 收尾输出常把 JSON 包进 ```json ... ``` 围栏（语言标记可大写/省略、围栏前可有
 * 空格、围栏后可有散文）——直接 `JSON.parse` 必失败并落入 regex 回退，只恢复
 * `completionType` 而丢弃 `askQuestion`/`passThroughVars`（假 ask → 实例卡
 * interacting、UI 无选择框）。本函数提取首个围栏块内的文本；未命中围栏时原样返回，
 * 保持既有解析路径不变。
 */
function stripJsonFence(raw: string): string {
  // 容忍围栏前任意文字（如「好的，以下是结果：」），取第一个 ```json 或 ``` 代码块内容。
  const match = raw.match(/```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i)
    ?? raw.match(/```\r?\n([\s\S]*?)\r?\n[ \t]*```/);
  return match?.[1]?.trim() ?? raw;
}

/** 收窄未知值为 hasAsk（`true` 判为需提问；兼容旧 `completionType:'ask'` 字符串）。 */
function parseHasAsk(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  // 旧版 completionType 兼容：'ask' → 需提问（回落 false）。
  return value === 'ask';
}

/** 收窄未知值为透传变量记录（仅保留 string 值条目）。 */
function parsePassThroughVars(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

/** 收窄未知值为 `AskUserQuestionPayload`；无法构造合法载荷时返回 undefined。 */
function parseAskQuestion(value: unknown): AskUserQuestionPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const questions = (value as Record<string, unknown>)['questions'];
  if (!Array.isArray(questions)) {
    return undefined;
  }
  const parsed: AskUserQuestionPayload['questions'] = [];
  for (const question of questions) {
    if (typeof question !== 'object' || question === null) {
      continue;
    }
    const record = question as Record<string, unknown>;
    const id = record['id'];
    const text = record['question'];
    if (typeof id !== 'string' || typeof text !== 'string') {
      continue;
    }
    const options = parseOptions(record['options']);
    const header = record['header'];
    const multiSelect = record['multi_select'];
    parsed.push({
      id,
      question: text,
      ...(typeof header === 'string' ? { header } : {}),
      ...(options === undefined ? {} : { options }),
      ...(typeof multiSelect === 'boolean' ? { multi_select: multiSelect } : {}),
    });
  }
  if (parsed.length === 0) {
    return undefined;
  }
  return { questions: parsed };
}

/** 收窄未知值为问题选项列表（仅保留 `label`/`description` 合法条目）。 */
function parseOptions(value: unknown): AskUserQuestionPayload['questions'][number]['options'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed: AskUserQuestionPayload['questions'][number]['options'] = [];
  for (const option of value) {
    if (typeof option !== 'object' || option === null) {
      continue;
    }
    const record = option as Record<string, unknown>;
    const label = record['label'];
    if (typeof label !== 'string') {
      continue;
    }
    const description = record['description'];
    parsed.push(typeof description === 'string' ? { label, description } : { label });
  }
  return parsed.length === 0 ? undefined : parsed;
}

/** 生成临时会话标识（纯 UUID 格式）。 */
function newSessionHandle(): string {
  return globalThis.crypto.randomUUID();
}

/** 收尾 fork 子代理的 provider/model（L2 引擎默认；缺省时由宿主运行时按 parent options 解析）。 */
function resolveForkAgentOptions(config: FinalizeManagerConfig): AgentOptions | undefined {
  return config.defaultProvider !== undefined && config.defaultModel !== undefined
    ? { provider: config.defaultProvider, model: config.defaultModel }
    : undefined;
}

/** 按 N 空格缩进多行文本（XML 块内内容对齐）。 */
function indentBlock(text: string, spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => `${prefix}${line}`);
}

/**
 * 构建收尾输入信息 v6 块（`<ReferenceInfo>`：当前 Step 的输入和输出）。
 *
 * v6 框架（2026-08-25）：`<ReferenceInfo>` root + `<Reference title>` 自描述块 +
 * `<Input>`/`<Output>`/`<Artifacts>`/`<Artifact>`（全驼峰）；内容统一转义
 * （`escapeXml`）。替代 v1 的 `<stepContext>` 小写根标签（违反全目录 PascalCase 规范）。
 */
function buildStepContextBlock(context: FinalizeStepContext): string {
  return [
    '<ReferenceInfo>',
    '  <Reference title="当前 Step 的输入和输出">',
    '    <Input>',
    ...indentBlock(escapeXml(context.input), 6),
    '    </Input>',
    '    <Output>',
    ...indentBlock(escapeXml(context.output), 6),
    '    </Output>',
    '    <Artifacts>',
    ...(context.artifacts ?? []).map(artifact => `      <Artifact>${escapeXml(artifact)}</Artifact>`),
    '    </Artifacts>',
    '  </Reference>',
    '</ReferenceInfo>',
  ].join('\n');
}

/**
 * 构建 Phase A 收尾评估提示词（v6 结构，2026-08-25 精简——**只做 ask 判断**）。
 *
 * Phase A 职责 = 判断当前 Step 的输出（Output）**本身**是否就是在向用户提问
 * （hasAsk + askQuestion 载荷）——**不是**判断任务是否完成/走偏，也**不**根据上下文
 * 需要推断是否需要提问（2026-08-26 语义收紧：曾出现把「读取 counts.json 的结果」这类
 * 正常输出误判为 ask 并编造无关问题的案例）。透传变量提取与输出压缩是 Phase B 的职责
 * （`buildPhaseBFinalizePrompt`）——Phase B 注释明确「不复用 Phase A 结果」，Phase A 做
 * 这两项是纯浪费，故本模板不再要求（返回格式仅 hasAsk/askQuestion）。
 *
 * 参考信息**只注入 Output**（不注入 Input/Artifacts，2026-08-26）：判断对象唯一是
 * step 返回的结果文本，输入/上下文会带偏判断（模型会从「用户原始需求/指令」推断
 * 流程需要澄清，而非看输出本身是否在提问）。
 */
function buildAssessPrompt(context: FinalizeStepContext): string {
  const header = [
    '当前 Step 已执行完成。请判断当前 Step 的输出是否是在向用户提问。必须先明确以下三点，再开始执行：',
    '- `## 你的任务` —— 本次 ask 判断要达成的**唯一目标**。',
    '- `## 参考信息` —— 当前 Step 的执行输出（Output），按需查阅。',
    '- `## 返回格式` —— 必须返回的 JSON 格式。',
  ];
  const sections: string[] = [...header];
  sections.push('');
  sections.push('## 你的任务');
  sections.push('根据 `## 参考信息` 中当前 Step 的输出，判断它**本身**是否就是在向用户提问（询问用户、等待用户回答后继续）。');
  sections.push('- hasAsk: true —— 输出本身就是一句提问（如「请问您的具体需求是什么？」）；');
  sections.push('- hasAsk: false —— 输出是正常结果（完成报告、数据、文件路径等）。');
  sections.push('**唯一判断依据是输出文本本身是否就是一句提问**；不得根据任务是否完成、是否走偏或任何上下文需要推断是否需要提问。');
  sections.push('若 hasAsk: true，askQuestion 的 question 应**提取自输出中的问题**（取原文或简洁概括），不得编造与输出无关的问题。');
  sections.push('');
  sections.push('## 参考信息');
  sections.push('<ReferenceInfo>');
  sections.push('  <Reference title="当前 Step 的执行输出">');
  sections.push('    <Output>');
  sections.push(...indentBlock(escapeXml(context.output.trim() === '' ? '(无输出)' : context.output), 6));
  sections.push('    </Output>');
  sections.push('  </Reference>');
  sections.push('</ReferenceInfo>');
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请将结果以 ```json 代码围栏包裹输出，围栏内只放 JSON，不要包含任何其他文字或解释。');
  sections.push('示例（输出是正常结果，不是提问）：');
  sections.push('```json');
  sections.push('{"hasAsk": false, "askQuestion": {"questions": []}}');
  sections.push('```');
  sections.push('示例（输出本身就是提问）：');
  sections.push('```json');
  sections.push('{"hasAsk": true, "askQuestion": {"questions": [{"id": "550e8400-e29b-41d4-a716-446655440000", "question": "请问您的具体需求是什么？"}]}}');
  sections.push('```');
  sections.push('');
  sections.push('## 红线规则');
  sections.push('- 仅当输出本身是提问时 hasAsk: true；不得根据任务是否完成或上下文需要推断提问');
  sections.push('- askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question');
  return sections.join('\n');
}

/**
 * Phase B 专用收尾提示词（v6 结构，2026-08-25 改造）。
 *
 * 与 `buildAssessPrompt`（Phase A）分工：**不含 hasAsk 判断**——Phase A 已完成 ask
 * 判定，Phase B 只做透传变量提取 + 执行总结（compressedOutput）。返回 JSON：
 * `{"passThroughVars": {...}, "compressedOutput": "..."}`。
 *
 * `degradedContext`（可选）：fork 降级（`degradeFinalize` 临时会话无 fork 历史）时注入
 * step 执行输入/输出 v6 块——渲染为 `## 参考信息` 节 + 头部三点加「参考信息」点（对齐
 * batch/loop-break 降级模式）；fork 成功（上下文在会话里）不传。
 */
function buildPhaseBFinalizePrompt(
  context: FinalizeStepContext,
  passThroughVars: readonly PassThroughVar[],
  degradedContext?: string,
): string {
  const header = [
    '当前 Step 已执行完成。请完成本次收尾处理。必须先明确以下三点，再开始执行：',
    '- `## 你的任务` —— 本次收尾处理要达成的**唯一目标**。',
    '- `## 透传变量` —— 需要提取的透传变量列表。',
    ...(degradedContext === undefined
      ? ['- `## 返回格式` —— 必须返回的 JSON 格式。']
      : ['- `## 参考信息` —— 当前 Step 的执行输入与输出，按需查阅。', '- `## 返回格式` —— 必须返回的 JSON 格式。']),
  ];
  const sections: string[] = [...header];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(degradedContext === undefined
    ? '1. 提取透传变量值：对每个列出的透传变量，根据当前 Step 的执行上下文（输出、工具调用与中间结果）提取其值并写入 passThroughVars。'
    : '1. 提取透传变量值：对每个列出的透传变量，根据 `## 参考信息` 中的信息提取其值并写入 passThroughVars。');
  sections.push(degradedContext === undefined
    ? '2. 执行总结：按 `## 输出模板` 的 Markdown 模板，把当前 Step 执行输出完整总结写入 compressedOutput。'
    : '2. 执行总结：按 `## 输出模板` 的 Markdown 模板，把 <Output> 完整总结写入 compressedOutput。');
  if (degradedContext !== undefined) {
    sections.push('');
    sections.push('## 参考信息');
    sections.push(degradedContext);
  }
  sections.push('');
  sections.push('## 透传变量');
  if (passThroughVars.length === 0) {
    sections.push('（无透传变量，passThroughVars 返回空对象）');
  }
  for (const variable of passThroughVars) {
    sections.push(`- ${variable.name}: ${variable.description}`);
  }
  sections.push('');
  sections.push('## 输出模板（compressedOutput 按此 Markdown 模板书写）');
  sections.push('注意：compressedOutput 是后续 Step 的唯一上下文来源，必须完整保留关键信息，禁止过度压缩。');
  sections.push('```md');
  sections.push('# 任务要求');
  sections.push('本次 Step 要达成的目标：原始指令的要点与验收标准。');
  sections.push('');
  sections.push('# 执行过程');
  sections.push('实际执行的关键步骤：调用的工具与操作的文件路径、读取与写入的内容、产生的中间结果、关键决策及其依据、遇到的异常与处理方式。');
  sections.push('');
  sections.push('# 最终成果');
  sections.push('本次 Step 的完整产出：生成/修改的文件与路径、核心数据与结论、验证方式与结果（包含所有关键信息，不得比原始输出更简短）。');
  sections.push('');
  sections.push('# 未完成与遗留');
  sections.push('未达成的部分、原因与已完成的进展、对后续 Step 的依赖与建议。');
  sections.push('```');
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请将结果以 ```json 代码围栏包裹输出，围栏内只放 JSON，不要包含任何其他文字或解释。');
  sections.push('示例：');
  sections.push('```json');
  sections.push('{"passThroughVars": {}, "compressedOutput": "..."}');
  sections.push('```');
  sections.push('');
  sections.push('## 红线规则');
  // 仅保留只读安全约束（fork 子代理有工具）；「禁止过度探索」主观性已删（2026-08-25）。
  sections.push('- 禁止编辑、创建或删除任何文件');
  return sections.join('\n');
}

/**
 * Phase B 收尾 JSON 解析失败原因诊断（public）：`parseFinalizeResult` 失败时的具体原因，
 * 供动态纠正提示 `buildFinalizeRetryHint` 携带；解析成功返回 undefined。
 */
export function explainFinalizeResultParse(raw: string): string | undefined {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
  if (parsed === undefined) {
    return '输出既不是合法 JSON，也不包含收尾处理字段';
  }
  const compressedOutput = parsed['compressedOutput'];
  if (typeof compressedOutput !== 'string') {
    return '输出缺少 compressedOutput 字段（或不是字符串）';
  }
  return undefined;
}

/** 构建带解析失败原因的 Phase B 重试纠正提示（格式对齐 Phase B 返回格式节）。 */
export function buildFinalizeRetryHint(output: string): string {
  const reason = explainFinalizeResultParse(output) ?? '无法解析输出';
  return [
    '未能从你的输出中解析出合法的收尾处理 JSON：' + reason + '。请严格按以下格式返回（用 ```json 代码围栏包裹，围栏内只放 JSON）：',
    '```json',
    '{"passThroughVars": {}, "compressedOutput": "..."}',
    '```',
  ].join('\n');
}

/** Phase B 收尾 JSON 解析重试上限（首次 + 最多 N 次 followup 重试，超限报错 Step 落 failed）。 */
const MAX_FINALIZE_JSON_RETRIES = 3;

/** secondary 门禁输出解析失败重试上限（首次 + 最多 N 次 followup 纠正重试；超限按不通过）。 */
const MAX_SECONDARY_GATE_RETRIES = 2;

/** Phase B 收尾解析结果（passThroughVars + compressedOutput）。 */
interface FinalizeParsed {
  readonly passThroughVars: Record<string, string>;
  readonly compressedOutput: string;
}

/** 解析 Phase B 收尾输出 JSON；非法 JSON / 缺字段 / 字段类型错误返回 undefined（触发重试）。 */
function parseFinalizeResult(raw: string): FinalizeParsed | undefined {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
  if (parsed === undefined) {
    return undefined;
  }
  const compressedOutput = parsed['compressedOutput'];
  if (typeof compressedOutput !== 'string') {
    return undefined;
  }
  const passThroughVars = parsePassThroughVars(parsed['passThroughVars']);
  return { passThroughVars, compressedOutput };
}

/**
 * 构建 secondary 门禁提示词（v6 结构，2026-08-25 改造）。
 *
 * 框架 = 时序开场 + 三点 + `## 你的任务`（**用户 prompt 原样注入**，未配置时用中性
 * fallback，不内置「检查完成度/质量」要求）+ `## 审查要求`（工具验证引导）+
 * `## 参考信息`（v6 `<ReferenceInfo>` 块，**必注入**——门禁子代理无 seed 无 fork 历史）+
 * 返回 JSON 格式。primary 门禁为纯代码产物校验（零 AI），不再有对应提示词——本函数是
 * 唯一的门禁 AI 提示词构建入口。
 */
function buildSecondaryGatePrompt(context: FinalizeStepContext, secondaryPrompt: string | undefined): string {
  const header = [
    '当前 Step 已执行完成。请完成门禁审查。必须先明确以下三点，再开始执行：',
    '- `## 你的任务` —— 用户配置的门控审查要求，是本次审查的**唯一目标**。',
    '- `## 参考信息` —— 当前 Step 的执行输入与输出，按需查阅。',
    '- `## 返回格式` —— 必须返回的 JSON 格式。',
  ];
  const sections: string[] = [...header];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(secondaryPrompt ?? '请根据门控审查要求审查当前 Step 的输出，并给出通过或不通过的结论。');
  sections.push('');
  // 2026-08-25 real-e2e 增强：引导门禁子代理**实际使用工具验证**（Round 21 已注入
  // 完整工具集 + 正确 cwd，但 AI 偶发「仅凭 Step 输出文本猜测」不查文件 → 误判 error，
  // 导致工作流失败）。要求基于文件系统事实判断，而非文本推断。
  sections.push('## 审查要求');
  sections.push('你必须**实际使用文件系统工具验证**（如 glob/read/stat 等）确认审查依据，而不是仅凭 Step 输出文本推断结论。');
  sections.push('若审查要求涉及产物文件的存在性/内容，请先使用工具在当前项目目录中搜索确认，再给出结论。');
  sections.push('只有当工具验证结果与审查要求不符时，才判定不通过。');
  sections.push('');
  sections.push('## 参考信息');
  sections.push(buildStepContextBlock(context));
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请仅返回 JSON，格式如下：');
  sections.push('```json');
  sections.push('{"gateStatus": "done", "gateDetail": "..."}');
  sections.push('```');
  sections.push('或');
  sections.push('```json');
  sections.push('{"gateStatus": "error", "gateDetail": "..."}');
  sections.push('```');
  sections.push('');
  sections.push('其中，`gateStatus` 为审查结论（`done` = 通过，`error` = 不通过），`gateDetail` 为审查说明。');
  return sections.join('\n');
}

/**
 * 三级解析收尾评估结果（public）。
 *
 * ① JSON 解析取 `hasAsk`/`passThroughVars`/`askQuestion`（`hasAsk` 布尔；兼容旧
 * `completionType` 字符串 `'ask'`）；② regex 回退（`"hasAsk": true` 或旧
 * `"completionType": "ask"`，透传变量回落空）；③ 原始输出回落 `hasAsk=false` +
 * 空透传变量。
 *
 * **围栏兼容（缺陷定位）**：LLM 输出带 ```json 围栏时裸 `JSON.parse` 失败，旧实现
 * 直接落入 regex 回退只恢复 completionType、askQuestion/passThroughVars 全丢（假
 * ask → 实例卡 interacting）。现先裸解析，失败后剥离围栏再解析，仍失败才回退。
 */
export function parseAssessResult(raw: string): AssessParsed {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
  if (parsed !== undefined) {
    const askQuestion = parseAskQuestion(parsed['askQuestion']);
    const compressedOutput = parsed['compressedOutput'];
    // hasAsk 主键；旧 completionType 兼容回退（LLM 仍可能输出旧格式）。
    const hasAsk = parseHasAsk(parsed['hasAsk']) || parseHasAsk(parsed['completionType']);
    return {
      hasAsk,
      passThroughVars: parsePassThroughVars(parsed['passThroughVars']),
      ...(askQuestion === undefined ? {} : { askQuestion }),
      ...(typeof compressedOutput === 'string' ? { compressedOutput } : {}),
    };
  }
  const matchAsk = raw.match(/"hasAsk"\s*:\s*(true|false)/);
  const matchType = raw.match(/"completionType"\s*:\s*"([^"]+)"/);
  const hasAsk = matchAsk !== null ? matchAsk[1] === 'true' : matchType?.[1] === 'ask';
  return { hasAsk, passThroughVars: {} };
}

/** 解析 secondary 门禁输出（`gateStatus` + `gateDetail`）；带 ```json 围栏时同样剥离。 */
export function parseSecondaryGate(raw: string): SecondaryGateParsed {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
  const passed = parsed?.['gateStatus'] === 'done';
  const detail = parsed?.['gateDetail'];
  return {
    passed,
    ...(passed || typeof detail !== 'string' ? {} : { detail }),
  };
}

/**
 * secondary 门禁输出解析失败原因诊断（public）：`parseSecondaryGate` 无法得出合法结论时的
 * 具体原因（供动态纠正提示 `buildSecondaryGateCorrectionHint` 携带）；合法结论
 * （`gateStatus` 为 `done`/`error`）返回 undefined。
 */
export function explainSecondaryGateParse(raw: string): string | undefined {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
  if (parsed === undefined) {
    return '输出既不是合法 JSON，也不包含门禁审查结果';
  }
  const status = parsed['gateStatus'];
  if (status === 'done' || status === 'error') {
    return undefined; // 合法结论（done 通过 / error 不通过）
  }
  if (status === undefined) {
    return '输出缺少 gateStatus 字段';
  }
  return 'gateStatus 必须是 done 或 error';
}

/** 构建带解析失败原因的 secondary 门禁纠正提示（格式对齐门禁返回格式节）。 */
export function buildSecondaryGateCorrectionHint(output: string): string {
  const reason = explainSecondaryGateParse(output) ?? '无法解析输出';
  return [
    '未能从你的输出中解析出门禁审查结果：' + reason + '。请仅返回 JSON，格式如下：',
    '```json',
    '{"gateStatus": "done", "gateDetail": "..."}',
    '```',
    '或',
    '```json',
    '{"gateStatus": "error", "gateDetail": "..."}',
    '```',
    '其中，`gateStatus` 为审查结论（`done` = 通过，`error` = 不通过），`gateDetail` 为审查说明。',
  ].join('\n');
}

/** 判定 Step 是否含未解析透传变量（value 仍含 `${xxx}` 占位）。 */
export function hasUnresolvedPassThroughVars(step: WorkflowStep): boolean {
  return (step.passThroughVars ?? []).some(variable => hasUnresolvedVars(variable.value));
}

/**
 * 判定门禁配置是否存在 enabled 门禁（primary 或 secondary）。
 *
 * primary 默认启用（对齐基准 `primary?.enabled ?? true`）——未显式 `enabled:false`
 * 即视为有门禁（进入 Phase C 做**纯代码产物校验**，零 AI 成本）；secondary 默认
 * 禁用，需显式 `enabled:true` 才计入（**唯一会跑门禁 AI 的通道**）。`gates` 为
 * `undefined`（三级均未配置，`mergeGates` 返回 undefined）时返回 false，仍走
 * `finalizeStep` 的零 AI 调用跳过路径。
 *
 * 方案说明：primary 纯校验并入 Phase C 统一跑（verifyArtifacts 是纯代码、无 AI
 * 成本、无 fork 会话）——保留本谓词语义（primary 默认启用 → 进 Phase C 做代码
 * 校验）是侵入最小的方案，且与基准「primary 启用时收尾不跳过」一致；门禁 AI 只
 * 在显式配置 secondary 时产生（见 {@link GateEvaluator.evaluate}）。
 */
export function hasEnabledGates(gates: Gates | undefined): gates is Gates {
  return gates !== undefined && (gates.primary?.enabled !== false || gates.secondary?.enabled === true);
}

/** 就地回写提取的透传变量（保留 Step 定义中的 description/refresh 标志）。 */
function writeBackPassThroughVars(
  extracted: Readonly<Record<string, string>>,
  step: WorkflowStep,
  target: Record<string, PassThroughVarValue> | undefined,
): void {
  if (target === undefined) {
    return;
  }
  const declared = step.passThroughVars ?? [];
  for (const [name, value] of Object.entries(extracted)) {
    const definition = declared.find(variable => variable.name === name);
    if (definition === undefined) {
      continue;
    }
    target[name] = {
      value,
      description: definition.description,
      ...(definition.refresh === undefined ? {} : { refresh: definition.refresh }),
    };
  }
}

/**
 * 合并 outputTo 路径解析用的透传变量映射（缺陷 34）。
 *
 * 引擎累加器 `request.passThroughVars`（前置 Step 已提取值）+ 当次 assess 提取值
 * `assessResult.passThroughVars`（快照，本 Step 新提取/refresh 覆盖）→ 字符串映射。
 * 当次提取值优先（refresh 场景下取最新），供 {@link GateEvaluator.verifyArtifacts}
 * 解析自引用变量（本 Step 提取并在自身 outputTo 中引用的 `${xxx}`）。
 *
 * **时序兼容**：返回独立副本，不读写 `request.passThroughVars` 累加器——verifyArtifacts
 * 用此副本解析，避免 assess 与 gate 之间的变量竞态（不依赖提前持久化）。
 */
function buildOutputToVars(
  passThroughVars: Record<string, PassThroughVarValue> | undefined,
  extracted: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (passThroughVars !== undefined) {
    for (const [name, value] of Object.entries(passThroughVars)) {
      result[name] = value.value;
    }
  }
  for (const [name, value] of Object.entries(extracted)) {
    result[name] = value;
  }
  return result;
}

/** 组装 finalizeMeta（currentPhase + previousPhase + 各阶段结果）。 */
function buildFinalizeMeta(
  existing: FinalizeMeta | undefined,
  assessResult: FinalizeAssessResult | undefined,
  gateResult: GateEvalResult | undefined,
  currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
  options?: { readonly askResult?: FinalizeAskResult; readonly routingResult?: RoutingResult },
): FinalizeMeta {
  // Bug 1：覆盖 currentPhase 前保存旧值到 previousPhase（UI 展示阶段流转痕迹）。
  const previousPhase = existing?.currentPhase;

  // Round 11：进入阶段时自动注入 running 空快照——若该阶段的 Result 尚未提供
  // （undefined）且之前的 finalizeMeta 也无该阶段 Result，注入只含 status:'running'
  // 的空对象。完成时 commitFinalize 传入真实 Result（含 status:'done'/'failed'），
  // buildFinalizeMeta 用真实值覆盖之前的 running 快照。
  const effectiveAskResult = options?.askResult ?? (
    currentPhase === 'ask-detect' && existing?.askResult === undefined
      ? { status: 'running' as const, hasAsk: false, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
      : undefined
  );
  const effectiveAssessResult = assessResult ?? (
    currentPhase === 'finalizing' && existing?.assessResult === undefined
      ? { status: 'running' as const, passThroughVars: {}, forkSessionId: '', assessmentRaw: '' }
      : undefined
  );
  const effectiveGateResult = gateResult ?? (
    currentPhase === 'gating' && existing?.gateResult === undefined
      ? { status: 'running' as const, gatesPassed: false, gateSessionId: '', assessmentRaw: '' }
      : undefined
  );
  const effectiveRoutingResult = options?.routingResult ?? (
    currentPhase === 'routing' && existing?.routingResult === undefined
      ? { status: 'running' as const }
      : undefined
  );

  return {
    currentPhase,
    ...(previousPhase !== undefined ? { previousPhase } : {}),
    // Phase A → askResult
    ...(effectiveAskResult === undefined ? {} : { askResult: effectiveAskResult }),
    // Phase B → assessResult（sessionId 从 Result 内读，不再冗余到顶层）
    ...(effectiveAssessResult === undefined ? {} : { assessResult: effectiveAssessResult }),
    // Phase C → gateResult（sessionId 从 Result 内读，不再冗余到顶层）
    ...(effectiveGateResult === undefined ? {} : { gateResult: effectiveGateResult }),
    // Phase D → routingResult（sessionId 从 Result 内读，不再冗余到顶层）
    ...(effectiveRoutingResult === undefined ? {} : { routingResult: effectiveRoutingResult }),
  };
}

/** 临时会话聚合失败语义（错误码 + 动作标签，供共享聚合函数构造错误消息）。 */
interface StreamFailure {
  readonly code: 'FINALIZE_FAILED' | 'GATE_FAILED';
  readonly action: string;
}

/**
 * 临时会话聚合文本；error/aborted 抛 `code` 指定的 SandoreError。
 *
 * **一次性临时会话**（Phase A assess / Phase C secondary 降级）：不携带 sessionId、
 * 不加载任何历史——输入完全来自 `promptText`（Phase A 的 `<stepContext>` 已含当前
 * step 子代理返回结果 output 文本）。
 */
async function runStream(
  ctx: Context,
  config: FinalizeManagerConfig,
  promptText: string,
  signal: AbortSignal | undefined,
  failure: StreamFailure,
): Promise<string> {
  const route = await resolveProviderModel({}, config, ctx.llm);
  const message = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: promptText }],
  });
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    ...(signal === undefined ? {} : { signal }),
  };
  const assembler = new BlockAssembler();
  const stream = ctx.llm.stream(options);
  for await (const chunk of stream) {
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish.kind === 'error') {
    throw new SandoreError(`${failure.action} failed: ${finish.failure.message}`, failure.code);
  }
  if (finish.kind === 'aborted') {
    throw new SandoreError(`${failure.action} aborted: ${finish.failure.message}`, failure.code);
  }
  return textSummary(assembler.blocks());
}

/**
 * 收尾第 1 部分：ask 判定（是否需向用户提问）+ 透传变量提取（**不判完成度**）。
 *
 * **临时会话**（`llm.stream` 直调，不 fork、不带 sessionId）：Phase A 评估输入 =
 * `<stepContext>`（input/output/artifacts，`buildFinalizeContext` 已含当前 step 子代理
 * 返回结果 output 文本）——DSH 子代理 settle 后 live store 已移除，`sessions.fork`
 * 必然 SESSION_NOT_FOUND，故评估不再依赖 fork 会话。输出三级解析
 * （JSON → regex → 原始）。shell 类型同样临时会话（shell stdout 作为输入）。
 */
export class FinalizeAssessor {
  constructor(
    private readonly ctx: Context,
    private readonly config: FinalizeManagerConfig,
  ) {}

  /** 执行收尾评估（Phase A 临时会话路径），返回 `FinalizeAskResult`（含 hasAsk/forkSessionId/assessmentRaw + 可选 compressedOutput）。 */
  async assess(input: FinalizeAssessInput): Promise<FinalizeAskResult> {
    const forkSessionId = newSessionHandle();
    const promptText = buildAssessPrompt(input.context);
    const raw = await runStream(this.ctx, this.config, promptText, input.signal, {
      code: 'FINALIZE_FAILED',
      action: 'finalize assess',
    });
    const parsed = parseAssessResult(raw);
    return {
      status: 'done',
      hasAsk: parsed.hasAsk,
      passThroughVars: parsed.passThroughVars,
      ...(parsed.askQuestion === undefined ? {} : { askQuestion: parsed.askQuestion }),
      ...(parsed.compressedOutput === undefined ? {} : { compressedOutput: parsed.compressedOutput }),
      forkSessionId,
      assessmentRaw: raw,
    };
  }

  /**
   * 执行收尾处理（Phase B 真 fork 子代理路径），返回 `FinalizeAssessResult`（含
   * `compressedOutput`——合并 JSON 的压缩摘要，落入 previousOutputs）。
   *
   * **合并 JSON**：经 {@link forkStepSubagent} 从 step 子代理完整事件（live → 持久化
   * inspect）截到闭合 turn 作 seed，`agents.create` 重建宿主主代理的子代理（meta
   * `parentSession: hostAgent.id` + `origin:'subagent'`），
   * `followup(buildAssessPrompt)` 驱动一轮 → `whenIdle()` → `finalAssistantOutput` →
   * `parseFinalizeResult`（**一个 LLM 调用返回 `{"passThroughVars": {...},
   * "compressedOutput": "..."}`**——透传变量提取 + compress 输出压缩合并）；评估完
   * `dispose()`（live 移除、持久化记录保留，UI 可打开 assessSessionId）。`forkSessionId`
   * = 子代理 id。
   *
   * **JSON 校验 + 重试**：`parseFinalizeResult` 不满足（非法 JSON / `compressedOutput`
   * 缺失或非字符串 / `passThroughVars` 无法解析）→ 给**同一个 fork 子代理**
   * `followup(buildFinalizeRetryHint(raw))` 重新返回 JSON（动态携带上一轮解析失败原因，
   * 说明缺什么、要求重新返回合法 JSON），再 `whenIdle` + 收集，最多重试
   * {@link MAX_FINALIZE_JSON_RETRIES} 次；超限
   * **抛错（Step 落 failed，errorDetail 说明「Phase B JSON 解析失败」）**——不降级。
   *
   * **降级（不失败）**：fork/驱动失败（配置缺省 / 事件源缺失 / 无闭合 turn /
   * `agents.create` 抛错 / followup 抛错）→ `degradeFinalize` 临时会话（llm.stream +
   * 同 prompt，单次解析，失败返回空结果）+ errorDetail。
   */
  async assessForked(input: FinalizeAssessInput): Promise<FinalizeAssessResult> {
    const hostAgentId = this.config.hostAgentId;
    const createAgent = this.config.createAgent;
    if (hostAgentId === undefined || createAgent === undefined) {
      // 引擎未注入宿主主代理/createAgent（配置缺省，如单测裸配置）：降级临时会话。
      return this.degradeFinalize(input, 'fork subagent finalize degraded to temp session: hostAgentId/createAgent not configured');
    }
    const agentOptions = resolveForkAgentOptions(this.config);
    try {
      const forked = await forkStepSubagent(this.ctx, input.stepSessionId, {
        hostAgentId,
        stepId: input.step.id,
        ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
        ...(this.config.getStepSessionEvents === undefined ? {} : { getEvents: this.config.getStepSessionEvents }),
        createAgent,
        ...(agentOptions === undefined ? {} : { agentOptions }),
      });
      if (forked === undefined) {
        return this.degradeFinalize(
          input,
          'fork subagent finalize degraded to temp session: no event source or no closed turn boundary for fork seed',
        );
      }
      const { handle } = forked;
      try {
        // Round 17：fork 创建后立即回调上报真实 forkSessionId
        input.onForkCreated?.(handle.agent.id);

        const promptText = buildPhaseBFinalizePrompt(input.context, input.step.passThroughVars ?? []);
        let raw = await driveAgentRound(handle, promptText);
        let parsed = parseFinalizeResult(raw);
        let retries = 0;
        while (parsed === undefined && retries < MAX_FINALIZE_JSON_RETRIES) {
          retries += 1;
          raw = await driveAgentRound(handle, buildFinalizeRetryHint(raw));
          parsed = parseFinalizeResult(raw);
        }
        if (parsed === undefined) {
          // JSON 超限：Step 落 failed（不降级）——errorDetail 说明「Phase B JSON 解析失败」。
          throw new SandoreError(
            `finalize Phase B JSON parse failed after ${retries} retry attempt(s); expected {"passThroughVars": {...}, "compressedOutput": "..."}`,
            'FINALIZE_FAILED',
          );
        }
        return {
          status: 'done',
          passThroughVars: parsed.passThroughVars,
          compressedOutput: parsed.compressedOutput,
          forkSessionId: handle.agent.id,
          assessmentRaw: raw,
        };
      } finally {
        // 评估完 dispose：live 移除、持久化记录保留（UI 可打开 assessSessionId）。
        await handle.dispose();
      }
    } catch (error) {
      // SandoreError（JSON 超限 FINALIZE_FAILED）保持报错（Step 落 failed，不降级）；
      // 其余（fork/驱动失败）降级临时会话 + errorDetail（不失败）。
      if (error instanceof SandoreError) {
        throw error;
      }
      return this.degradeFinalize(input, `fork subagent finalize degraded to temp session: ${describeError(error)}`);
    }
  }

  /** 降级临时会话收尾处理（llm.stream + 同 prompt，单次解析；失败返回空结果）并记 errorDetail（不失败）。 */
  private async degradeFinalize(
    input: FinalizeAssessInput,
    reason: string,
  ): Promise<FinalizeAssessResult> {
    // 降级版：注入 step 执行输入/输出 v6 块（`buildStepContextBlock`）作参考信息，
    // 弥补临时会话无 fork 历史（对齐 batch/loop-break 降级模式）。
    const promptText = buildPhaseBFinalizePrompt(
      input.context,
      input.step.passThroughVars ?? [],
      buildStepContextBlock(input.context),
    );
    const raw = await runStream(this.ctx, this.config, promptText, input.signal, {
      code: 'FINALIZE_FAILED',
      action: 'finalize Phase B',
    });
    const parsed = parseFinalizeResult(raw);
    return {
      status: 'done',
      passThroughVars: parsed?.passThroughVars ?? {},
      compressedOutput: parsed?.compressedOutput ?? '',
      ...(reason === undefined ? {} : { errorDetail: reason }),
      forkSessionId: newSessionHandle(),
      assessmentRaw: raw,
    };
  }
}

/**
 * 收尾第 2 部分：门禁校验（primary 纯代码产物校验 + secondary AI 门禁审查）。
 *
 * **primary 门禁（纯代码产物校验，零 AI 成本）**：默认启用（对齐基准
 * `primary?.enabled ?? true`），未显式 `enabled:false` 即校验 outputTo 产物文件
 * 存在——相对路径**都**存在才通过、正则匹配到一个即算存在（verifyArtifacts）；
 * 无 outputTo 视为无校验内容、直接通过。产物缺失 → `gatesPassed=false` 并记
 * `missing output files: ...`。**不**开 LLM 会话、**不**判完成度（完成度检查只允许
 * 在 secondary 门禁中显式配置）。
 *
 * **secondary 门禁（AI 门禁审查，需显式启用）**：`secondary.enabled:true` 时才经
 * `subagents.startContinuable` 建宿主主代理的**可续接子代理**（与 step 执行子代理同
 * 机制：agent loop + 工具 + preset 系统提示词；**无 seed**——prompt 携带 stepContext，
 * 见 `buildSecondaryGatePrompt`）跑门控审查（审查要求完全来自用户 prompt，**不内置
 * 完成度/质量检查**），settle 终态取输出（`awaitGateOutput`）返回
 * `gateStatus`/`gateDetail`；失败降级一次性临时会话并记 errorDetail（不失败）。未启用
 * 的门禁在
 * `gateDetails` 中仅标 `enabled:false`、不输出 `passed`（顶层
 * `primaryPassed`/`secondaryPassed` 亦省略）。
 *
 * **primary 默认启用**（对齐基准 `primary?.enabled ?? true`）：未配置 primary 或
 * `enabled!==false` 时执行 primary 纯代码校验；仅显式 `primary.enabled:false` 才跳过。
 * secondary 默认禁用（对齐基准 `secondary?.enabled ?? false`），需显式 `enabled:true`
 * 才执行。差异场景：用户只配置 secondary 门禁、未配置 primary 时，基准 primary 默认
 * 执行（纯代码校验），sandore 改动后同样默认执行。
 *
 * **零门禁 AI**：未配置 secondary（仅 primary 或均未配置）时，本类不产生任何
 * `runStream` 调用（不 fork、不开 LLM 会话）。
 */
export class GateEvaluator {
  constructor(
    private readonly ctx: Context,
    private readonly config: FinalizeManagerConfig,
  ) {}

  /** 执行门禁校验，返回 `GateEvalResult`（含 gateSessionId/assessmentRaw）。 */
  async evaluate(input: FinalizeGateInput): Promise<GateEvalResult> {
    // primary 默认启用（对齐基准 primary?.enabled ?? true）：未配置或 enabled!==false
    // 即执行 primary 纯代码校验；仅显式 enabled:false 才跳过。secondary 默认禁用，需
    // 显式 enabled:true 才执行（与基准 secondary?.enabled ?? false 一致）。
    const primaryEnabled = input.gates.primary?.enabled !== false;
    const secondaryEnabled = input.gates.secondary?.enabled === true;
    const rawParts: string[] = [];
    const errorParts: string[] = [];

    // primary = 纯代码产物校验（无 AI）：outputTo 全部存在（相对路径都存在、正则匹配
    // 到一个即算存在）才通过；无 outputTo 视为无校验内容、直接通过。产物缺失 → 不通过。
    let primaryPassed: boolean | undefined;
    if (primaryEnabled) {
      const missing = await this.verifyArtifacts(input.step, input.workdir, input.vars ?? {});
      primaryPassed = missing.length === 0;
      if (missing.length > 0) {
        errorParts.push(`missing output files: ${missing.join(', ')}`);
      }
    }

    // secondary = AI 门禁审查（显式 enabled:true 才跑）：经 `subagents.startContinuable`
    // 建宿主主代理的可续接子代理（**无 seed**——prompt 已携带 stepContext），settle
    // 终态取输出返回 gateStatus/gateDetail；子代理路径失败降级临时会话（runStream）并记
    // errorDetail（不失败）。primary 仅代码校验时无 AI、不建子代理。
    let secondaryPassed: boolean | undefined;
    let gateSessionId = newSessionHandle();
    if (secondaryEnabled) {
      const secondary = await this.evaluateSecondary(input);
      gateSessionId = secondary.gateSessionId;
      rawParts.push(secondary.raw);
      secondaryPassed = secondary.passed;
      if (!secondary.passed && secondary.detail !== undefined) {
        errorParts.push(secondary.detail);
      }
      if (secondary.degraded !== undefined) {
        errorParts.push(secondary.degraded);
      }
    }

    const gatesPassed =
      (primaryEnabled ? primaryPassed === true : true) &&
      (secondaryEnabled ? secondaryPassed === true : true);

    const errorDetail = errorParts.length === 0 ? undefined : errorParts.join('; ');
    const gateDetails =
      primaryEnabled || secondaryEnabled
        ? {
            primary: {
              enabled: primaryEnabled,
              ...(primaryEnabled ? { passed: primaryPassed ?? false } : {}),
            },
            secondary: {
              enabled: secondaryEnabled,
              ...(secondaryEnabled ? { passed: secondaryPassed ?? false } : {}),
              ...(input.gates.secondary?.prompt === undefined ? {} : { prompt: input.gates.secondary.prompt }),
            },
          }
        : undefined;

    return {
      status: gatesPassed ? 'done' : 'failed',
      gatesPassed,
      ...(primaryPassed === undefined ? {} : { primaryPassed }),
      ...(secondaryPassed === undefined ? {} : { secondaryPassed }),
      ...(gateDetails === undefined ? {} : { gateDetails }),
      ...(errorDetail === undefined ? {} : { errorDetail }),
      gateSessionId,
      assessmentRaw: rawParts.join('\n'),
    };
  }

  /**
   * secondary 门禁（AI 门禁审查）子代理路径。
   *
   * 经 `subagents.startContinuable` 建宿主主代理的**可续接子代理**（与 step 执行子代理
   * 同机制：agent loop + 工具 + preset 系统提示词；**无 seed**——prompt 携带
   * stepContext，见 `buildSecondaryGatePrompt`），settle 终态取输出（
   * {@link awaitGateOutput}：`awaitSubagentSettlement` 注入 / `whenIdle` 回退 →
   * `finalAssistantOutput` → `textSummary`）→ `parseSecondaryGate`。`gateSessionId` =
   * 真实子代理 id（UI 可打开；子代理由 DSH settle 侧 dispose，live 移除、持久化记录
   * 保留）。
   *
   * 降级条件（**不失败**，返回 `degraded` 说明并入 errorDetail）：
   * - 引擎未注入 hostAgent（配置缺省）；
   * - `startContinuable` / settle 等待 / 输出收集抛错。
   * 降级路径 = 一次性临时会话（`runStream`）。
   */
  private async evaluateSecondary(input: FinalizeGateInput): Promise<SecondaryGateEval> {
    const promptText = buildSecondaryGatePrompt(input.context, input.gates.secondary?.prompt);
    if (this.config.hostAgent === undefined) {
      const raw = await runStream(this.ctx, this.config, promptText, input.signal, {
        code: 'GATE_FAILED',
        action: 'gate evaluation',
      });
      return this.secondaryFromRaw(raw, newSessionHandle(),
        'secondary gate subagent degraded to temp session: hostAgent not configured');
    }
    try {
      const agentOptions = resolveForkAgentOptions(this.config);
      const started = await this.ctx.subagents.startContinuable({
        // `provider` 是 DSH subagent provider 注册名（缺省 'fork'，DSH base bundle 已
        // 注册），与模型路由解耦：模型路由经 `request.agentOptions` 承载
        // （resolveForkAgentOptions）——不要把模型 provider id 填到这里。
        provider: this.config.subagentProvider ?? 'fork',
        label: `gate ${input.step.id}`,
        request: {
          prompt: [{ type: 'text', text: promptText }],
          parent: this.config.hostAgent,
          ...(agentOptions === undefined ? {} : { agentOptions }),
        },
        signal: input.signal ?? new AbortController().signal,
      });
      // 2026-08-25：解析失败（非合法 done/error）给**同一个子代理** followup 纠正重试
      // （上限 MAX_SECONDARY_GATE_RETRIES，纠正提示携带失败原因，对齐 batch/loop-break）；
      // 合法 `error`（不通过）不算解析失败、不重试。
      let raw = await this.awaitGateOutput(started.childId, input.signal);
      let retries = 0;
      while (explainSecondaryGateParse(raw) !== undefined && retries < MAX_SECONDARY_GATE_RETRIES) {
        retries += 1;
        await this.ctx.subagents.followup(this.config.hostAgent, started.childId, [
          { type: 'text', text: buildSecondaryGateCorrectionHint(raw) },
        ], {
          source: { kind: 'user' },
          signal: input.signal ?? new AbortController().signal,
        });
        raw = await this.awaitGateOutput(started.childId, input.signal);
      }
      return this.secondaryFromRaw(raw, started.childId);
    } catch (error) {
      const raw = await runStream(this.ctx, this.config, promptText, input.signal, {
        code: 'GATE_FAILED',
        action: 'gate evaluation',
      });
      return this.secondaryFromRaw(raw, newSessionHandle(),
        `secondary gate subagent degraded to temp session: ${describeError(error)}`);
    }
  }

  /**
   * 等待 secondary 门禁子代理 settle 终态并收集最终 assistant 输出。
   *
   * `awaitSubagentSettlement` 注入时按其结算信号路由：`stopReason !== 'completed'`
   * → 抛错（进降级）；输出取 settle 载荷 `output`（缺省回退
   * `finalAssistantOutput(child.session.events)`）。未注入时回退
   * `child.whenIdle()` + `finalAssistantOutput`。子代理不存在或无输出抛
   * `SandoreError`（进降级）。
   */
  private async awaitGateOutput(childId: string, signal?: AbortSignal): Promise<string> {
    const child = this.ctx.agents.get(childId);
    if (child === undefined) {
      throw new SandoreError(`gate subagent '${childId}' not found in registry`, 'GATE_FAILED');
    }
    const awaitSettlement = this.config.awaitSubagentSettlement;
    const blocks = awaitSettlement === undefined
      ? await (async () => {
          await child.whenIdle();
          return finalAssistantOutput(child.session.events);
        })()
      : await (async () => {
          const settlement: SubagentSettlement = await awaitSettlement(childId, signal ?? new AbortController().signal);
          if (settlement.stopReason !== 'completed') {
            throw new SandoreError(`gate subagent '${childId}' settle ${settlement.stopReason}`, 'GATE_FAILED');
          }
          return settlement.output ?? finalAssistantOutput(child.session.events);
        })();
    if (blocks === undefined) {
      throw new SandoreError('gate subagent produced no assistant output', 'GATE_FAILED');
    }
    return textSummary(blocks);
  }

  /** 归一 secondary 门禁子代理/临时会话输出为 `SecondaryGateEval`。 */
  private secondaryFromRaw(raw: string, gateSessionId: string, degraded?: string): SecondaryGateEval {
    const parsed = parseSecondaryGate(raw);
    return {
      gateSessionId,
      raw,
      passed: parsed.passed,
      ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
      ...(degraded === undefined ? {} : { degraded }),
    };
  }

  /**
   * 校验 outputTo 产物文件存在；返回缺失的 pattern 列表。
   *
   * **primary 门禁的校验本体**：相对路径（非 glob 字面路径 / glob）须**全部**存在、
   * 正则匹配到一个即算存在——全部命中才通过（缺失列表为空），任一缺失即不通过。
   *
   * **缺陷 34**：每项 path/regex 先经 {@link resolveOutputToVars} 用 `vars` 替换
   * `${xxx}` 透传变量占位符后再匹配——原实现原样传入 findFilesByGlob/findFilesByRegex/
   * fileExists，路径含 `${xxx}` 时 `new RegExp('${projectName}')` 的 `$` 行尾锚 +
   * 花括号字面量永不匹配 → 确定性报 missing → Step 失败。vars 由
   * {@link GateEvaluator.evaluate} 传入（引擎累加器 + 当次 assess 提取值合并），
   * 使自引用变量在门禁时可解析。
   */
  private async verifyArtifacts(
    step: WorkflowStep,
    workdir: string,
    vars: Readonly<Record<string, string>>,
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const outputTo of step.outputTo ?? []) {
      const resolved = resolveOutputToVars(outputTo, vars);
      if (resolved.regex !== undefined) {
        const found = await findFilesByRegex(this.ctx.fs, workdir, resolved.regex);
        if (found.length === 0) {
          missing.push(resolved.regex);
        }
      } else if (resolved.path !== undefined) {
        if (isGlobPattern(resolved.path)) {
          const found = await findFilesByGlob(this.ctx.fs, workdir, resolved.path);
          if (found.length === 0) {
            missing.push(resolved.path);
          }
        } else {
          // 非 glob 字面路径：精确存在性检查（resolve + readText），避免路径中的
          // `.` 被当作正则元字符导致漏报（树内相似文件误命中→该报缺失却放行）或
          // 误报（`./` 前缀使非锚定 regex 误判→门禁恒失败）。对齐基准
          // fs.existsSync(path.resolve(cwd, path))；regex 字段仍走 findFilesByRegex。
          const exists = await fileExists(this.ctx.fs, workdir, resolved.path);
          if (!exists) {
            missing.push(resolved.path);
          }
        }
      }
    }
    return missing;
  }
}

/**
 * Step 收尾编排器。
 *
 * 组合 {@link FinalizeAssessor} 与 {@link GateEvaluator}，按 5 阶段收尾重构拆分
 * （stage-executor 的 `runPhaseA/B/C` 直接调用本管理器的方法）：
 * - **Phase A（问题检测/评估，ask 保底）**：`assessOnly()` 只跑评估（**ask 判定**
 *   [是否需向用户提问] + 透传变量提取，**不判完成度**）——**临时会话**（`llm.stream`
 *   直调，不 fork），输入含当前 step 子代理返回结果 output；`hasAsk` + askQuestion
 *   载荷 → 调用方把 Step 置 interacting 中断（引擎级 ask 闭环），finalizeMeta
 *   currentPhase='ask-detect' 且**不记录顶层 assessSessionId**、**不写回透传变量**。
 * - **Phase B（收尾）**：`assessForked()` **真 fork 子代理**（`agents.create` 从完整
 *   事件 seed 重建宿主主代理的子代理，followup 驱动一轮收集输出）+ `commitFinalize(...,
 *   'finalizing')` 回写透传变量（保留 refresh）+ 组装 finalizeMeta（`assessSessionId`
 *   持久化到 state）。
 * - **Phase C（门禁）**：`evaluateGates()` 跑门禁——primary 为**纯代码产物校验**（零
 *   AI、不建子代理），secondary 显式启用才经 `subagents.startContinuable` 建宿主主代理
 *   的可续接子代理（无 seed）跑 **AI 门禁审查**（`gateSessionId` 持久化到 state）；
 *   未通过由调用方落 failed（currentPhase='gating'）。
 *
 * `finalizeStep()` 保留为编排兼容入口（跳过检查 → assessOnly → ask? → commit
 * 'finalizing' → evaluateGates → commitFinalize），供既有调用方/测试使用。
 */
export class FinalizeManager {
  private readonly assessor: FinalizeAssessor;
  private readonly gateEvaluator: GateEvaluator;

  constructor(
    private readonly ctx: Context,
    private readonly config: FinalizeManagerConfig,
  ) {
    this.assessor = new FinalizeAssessor(ctx, config);
    this.gateEvaluator = new GateEvaluator(ctx, config);
  }

  /**
   * Phase A：只跑评估（ask 保底判断）。
   *
   * **ask 判定**（是否需向用户提问）+ 透传变量提取（**不判完成度**）。假 ask 防御
   * （`hasAsk` 但无 askQuestion 载荷）回落 `hasAsk=false`。**不**跑门禁、**不**回写任何
   * 状态——调用方（stage-executor `runPhaseA`）根据返回值决定 ask 中断或继续 Phase B/C。
   */
  async assessOnly(request: FinalizeStepRequest): Promise<FinalizeAskResult> {
    let assessResult = await this.assessor.assess({
      step: request.step,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      context: request.context,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    // 假 ask 防御（缺陷定位）：ask 判定但无 askQuestion 载荷时无法发起提问——置
    // interacting 只会让实例永久卡 interacting、UI 无选择框。回落 hasAsk=false 走普通
    // 收尾（门禁 + 透传变量回写），并记 warn 暴露异常收尾。
    if (assessResult.hasAsk && assessResult.askQuestion === undefined) {
      this.ctx.logger.warn(
        `sandore: step ${request.step.id} finalize assess returned ask without askQuestion payload; treating as completed`,
      );
      return { ...assessResult, hasAsk: false };
    }
    return assessResult;
  }

  /**
   * Phase C：门禁（primary 纯代码产物校验 + secondary AI 门禁审查）。
   *
   * 缺陷 34：合并引擎累加器 + 当次 assess 提取值为 outputTo 路径解析用 vars（独立副本，
   * 不依赖提前持久化——避免 assess 与 gate 之间的变量竞态）。仅运行门禁，不回写状态。
   */
  async evaluateGates(request: FinalizeStepRequest, assessResult: FinalizeAssessResult): Promise<GateEvalResult> {
    if (request.gates === undefined) {
      // 理论不可达：evaluateGates 仅在 hasEnabledGates(request.gates) 时被调用。
      throw new SandoreError('gate evaluation requires gates configuration', 'FINALIZE_FAILED');
    }
    const outputToVars = buildOutputToVars(request.passThroughVars, assessResult.passThroughVars);
    return await this.gateEvaluator.evaluate({
      step: request.step,
      context: request.context,
      gates: request.gates,
      workdir: request.workdir,
      vars: outputToVars,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /**
   * Phase B：真 fork 子代理收尾处理（`FinalizeAssessor.assessForked`）。
   *
   * 从 step 子代理完整事件（live → 持久化 inspect）截到闭合 turn 作 seed，经
   * `ctx.agents.create` 重建宿主主代理的子代理驱动一轮（**一个 LLM 调用返回合并 JSON：
   * `{"passThroughVars": {...}, "compressedOutput": "..."}`**——透传变量提取 + 输出压缩
   * 合并；解析失败 followup 重试 ≤3 次，超限抛错 Step 落 failed）；fork/驱动失败降级
   * 临时会话并记 errorDetail（不失败）。返回含 `compressedOutput`（压缩摘要落
   * previousOutputs，schema 字段）。
   */
  async assessForked(request: FinalizeStepRequest): Promise<FinalizeAssessResult> {
    return await this.assessor.assessForked({
      step: request.step,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      context: request.context,
      workdir: request.workdir,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onForkCreated === undefined ? {} : { onForkCreated: request.onForkCreated }),
    });
  }

  /**
   * 收尾落点（Phase B / 门禁后）：回写 finalizeMeta + 透传变量 + onPersist。
   *
   * `currentPhase` 标注当前收尾阶段（`ask-detect`/`finalizing`/`gating`/`completed`），
   * 供 UI 展示；`assessSessionId`（Phase B 起）/`gateSessionId`（Phase C）持久化到
   * state。写入 finalizeMeta 后触发 `onPhaseChange` 回调（引擎侧发射
   * `sandore/step-phase` 事件，供 UI 不经轮询即时刷新）。
   * `options.recordAssessSession=false`（Phase A ask 保底中断）时不记录顶层
   * assessSessionId（计划：Phase A fork 用完即删、不持久化；Phase B 收尾才落
   * assessSessionId）。
   *
   * **透传变量写回仅在 Phase B（`currentPhase === 'finalizing'`）执行**——Phase A
   * （`ask-detect`）调用不写回（透传变量只在收尾阶段提取落账）；`gating`/`completed`
   * 的幂等重写不再重复回写（Phase B 已写）。
   * 透传变量提取回退：AI 未提取（fork 降级/模型行为）且步骤仅声明一个未解析变量、
   * 输出非空时，以输出文本为该变量值（对齐「变量值从步骤输出提取」的文档语义，
   * 避免单变量场景下提取落空）。
   */
  async commitFinalize(
    request: FinalizeStepRequest,
    assessResult: FinalizeAssessResult | undefined,
    gateResult: GateEvalResult | undefined,
    currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
    options?: { readonly askResult?: FinalizeAskResult; readonly routingResult?: RoutingResult },
  ): Promise<void> {
    request.executedStep.finalizeMeta = buildFinalizeMeta(request.executedStep.finalizeMeta, assessResult, gateResult, currentPhase, options);
    // Round 17：透传变量写回守卫——仅在 Phase B assessResult 为 done 时写回（running 中间态不写回）。
    if (currentPhase === 'finalizing' && assessResult !== undefined && assessResult.status !== 'running') {
      const extracted: Record<string, string> = { ...(assessResult?.passThroughVars ?? {}) };
      fillUnresolvedSingleVar(request.step, extracted, request.context.output);
      writeBackPassThroughVars(extracted, request.step, request.passThroughVars);
    }
    // Round 7 修复：先持久化同步（upsert 进 active.state + persistState），后发事件。
    // 保证事件发出时 active.state 已含最新 finalizeMeta（中间态立即可见）。
    await request.onPersist?.(request.executedStep);
    request.onPhaseChange?.(request.step, request.executedStep.sessionMeta?.childId, currentPhase);
  }

  /** 编排单个 Step 的收尾（兼容入口），返回 `FinalizeOutcome`（done/ask/error 三态）。 */
  async finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome> {
    const { step, executedStep } = request;
    const needsAssess = hasUnresolvedPassThroughVars(step);
    const hasGates = hasEnabledGates(request.gates);

    if (!needsAssess && !hasGates) {
      // 零 AI 调用跳过路径：无未解析透传变量 + 无门禁 → 直接 done（不写 finalizeMeta）。
      return { type: 'done' };
    }

    const askResult = await this.assessOnly(request);

    if (askResult.hasAsk) {
      executedStep.status = 'interacting';
      // Phase A ask 保底中断：currentPhase='ask-detect'。
      await this.commitFinalize(request, undefined, undefined, 'ask-detect', { askResult });
      return { type: 'ask', assessResult: askResult };
    }

    // Phase B 收尾落点：回写透传变量 + 持久化 assessSessionId（currentPhase='finalizing'）。
    // 透传变量写回仅在本阶段执行（commitFinalize 按 currentPhase 门控）。
    const phaseBResult = await this.assessor.assessForked({
      step: request.step,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      context: request.context,
      workdir: request.workdir,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onForkCreated === undefined ? {} : { onForkCreated: request.onForkCreated }),
    });
    await this.commitFinalize(request, phaseBResult, undefined, 'finalizing');

    let gateResult: GateEvalResult | undefined;
    if (hasEnabledGates(request.gates)) {
      gateResult = await this.evaluateGates(request, phaseBResult);
    }

    if (gateResult !== undefined && !gateResult.gatesPassed) {
      await this.commitFinalize(request, phaseBResult, gateResult, 'gating');
      return {
        type: 'error',
        errorDetail: gateResult.errorDetail ?? 'gate evaluation failed',
        assessResult: phaseBResult,
        gateResult,
      };
    }

    await this.commitFinalize(request, phaseBResult, gateResult, 'completed');
    return {
      type: 'done',
      assessResult: phaseBResult,
      ...(gateResult === undefined ? {} : { gateResult }),
    };
  }
}

/** 单变量提取回退：AI 未提取且步骤仅声明一个未解析变量、输出非空时用输出文本。 */
function fillUnresolvedSingleVar(
  step: WorkflowStep,
  extracted: Record<string, string>,
  output: string | undefined,
): void {
  if (Object.keys(extracted).length > 0) return;
  const unresolved = (step.passThroughVars ?? []).filter(variable => hasUnresolvedVars(variable.value));
  if (unresolved.length === 1 && output !== undefined && output.trim() !== '') {
    extracted[unresolved[0]!.name] = output;
  }
}
