/**
 * Step 收尾拆分（finalize-manager）。
 *
 * 5 阶段收尾重构后按阶段拆分为三个公开入口（stage-executor 的 `runPhaseA/B/C` 直接调用）：
 * - **Phase A（问题检测/评估，ask 保底）**：`assessOnly()` → `FinalizeAssessor` 完成判定 +
 *   透传变量提取 + ask 保底判断。session 类型（agent/prompt/skill/mcp）经
 *   `ctx.sessions.fork(stepSessionId)` 创建 fork 会话（boundary 省略取源最后一条事件，
 *   规避 OPEN_TURN），评估 LLM 请求携带 fork 会话 `sessionId` 作身份戳记（路由/重放）；
 *   fork 抛错时降级为一次性临时会话（省略 sessionId）且 Step 不失败；shell 类型经
 *   `ctx.llm.stream()` 一次性临时会话（shell stdout 作为输入）。`hasAsk` + askQuestion
 *   载荷 → Step 置 interacting（引擎级 ask 闭环，currentPhase='ask-detect'）；评估 fork
 *   会话**用完即删**（live 引用评估后释放、不常驻；顶层 assessSessionId 不在此阶段记录）。
 * - **Phase B（收尾）**：`commitFinalize(..., 'finalizing')` 回写透传变量（保留 refresh）+
 *   组装 finalizeMeta（assessSessionId 持久化到 state）。
 * - **Phase C（门禁）**：`evaluateGates()` → `GateEvaluator` 用**真实 fork 会话**执行
 *   primary/secondary 双门审查（`gateSessionId` 为真实 fork id，持久化到 state），
 *   `gatesPassed=true` 后再验证 outputTo 产物文件存在，缺失则覆盖为 false。
 *
 * `finalizeStep()` 保留为编排兼容入口（跳过检查 → assessOnly → ask? → evaluateGates →
 * commitFinalize），供既有调用方/测试使用。
 * @module @deepseek-ai/dsh-sandore-microflow/src/finalize-manager
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

import { SandoreError } from './errors.ts';
import { fileExists, findFilesByGlob, findFilesByRegex, hasUnresolvedVars, isGlobPattern, resolveOutputToVars } from './file-utils.ts';
import { describeError, resolveProviderModel, textSummary } from './internal.ts';
import type { PassThroughVarValue } from './stage-executor.ts';

import type { ExecutedStepDefault, FinalizeOutcome } from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type {
  AskUserQuestionPayload,
  FinalizeAssessResult,
  FinalizeMeta,
  GateEvalResult,
  Gates,
  PassThroughVar,
  WorkflowStep,
} from '@deepseek-ai/dsh-sandore-workflow/src/schema';

/** 收尾管理器引擎级配置（provider/model 三层回退的 L2 来源）。 */
export interface FinalizeManagerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
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
  /** session 类型 Step 的 fork 源会话 ID（省略时降级为临时会话）。 */
  readonly stepSessionId?: string;
  readonly context: FinalizeStepContext;
  readonly signal?: AbortSignal;
}

/** GateEvaluator 的评估输入。 */
export interface FinalizeGateInput {
  readonly step: WorkflowStep;
  readonly context: FinalizeStepContext;
  /** 三级合并后的门禁配置。 */
  readonly gates: Gates;
  readonly workdir: string;
  /**
   * 门禁 fork 源会话 ID（session 类型 Step 的真实子代理会话）。
   *
   * 非省略时 `evaluate` 经 `ctx.sessions.fork(stepSessionId)` 创建**真实 fork 会话**
   * 作为门禁 LLM 请求的路由戳记（`gateSessionId` 为真实 fork 会话 id，持久化到
   * finalizeMeta 供 UI 打开）；fork 抛错（合成 session/非 live）或省略时降级为
   * 一次性临时句柄（`eval-{random}`）。
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
}

/** Assessor 解析出的完成判定结果（未含会话/原始输出字段）。 */
export interface AssessParsed {
  /**
   * 是否需要向用户提问确认后继续（ask 保底通道：`hasAsk=true` 且含 `askQuestion` 载荷
   * 才真正提问；`hasAsk=true` 但无载荷为假 ask，回落 completed）。
   */
  readonly hasAsk: boolean;
  readonly passThroughVars: Record<string, string>;
  readonly askQuestion?: AskUserQuestionPayload;
}

/** primary 门禁解析结果（`taskStatus` → passed）。 */
export interface PrimaryGateParsed {
  readonly passed: boolean;
  readonly errorDetail?: string;
}

/** secondary 门禁解析结果（`gateStatus` → passed）。 */
export interface SecondaryGateParsed {
  readonly passed: boolean;
  readonly detail?: string;
}

/** 收尾评估提示词主头部。 */
const ASSESS_PROMPT_HEADER = '你是严谨准确的Step执行后处理Agent，在当前Step的会话分支中进行收尾评估。';

/** 收尾评估红线规则（只读，禁止文件改动与过度探索）。 */
const ASSESS_RED_LINES = [
  '禁止编辑、创建或删除任何文件',
  '禁止过度探索',
  'askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question',
] as const;

/** primary 门禁提示词主头部。 */
const PRIMARY_GATE_PROMPT_HEADER = '你是严谨准确的Step门禁审查Agent，请校验产物文件是否存在并判断Step是否基本完成。';

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
  const match = raw.match(/[ \t]*```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*```/i);
  return match?.[1] ?? raw;
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

/** 生成临时会话标识（随机 8 位 hex）。 */
function newSessionHandle(): string {
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `eval-${random}`;
}

/** 按 4 空格缩进多行文本。 */
function indentBlock(text: string): string[] {
  return text.split('\n').map(line => `    ${line}`);
}

/** 构建 `<stepContext>`（input/output/artifacts XML 块）。 */
function buildStepContextBlock(context: FinalizeStepContext): string {
  const lines: string[] = ['<stepContext>', '  <input>'];
  lines.push(...indentBlock(context.input));
  lines.push('  </input>');
  lines.push('  <output>');
  lines.push(...indentBlock(context.output));
  lines.push('  </output>');
  lines.push('  <artifacts>');
  for (const artifact of context.artifacts ?? []) {
    lines.push(`    - ${artifact}`);
  }
  lines.push('  </artifacts>');
  lines.push('</stepContext>');
  return lines.join('\n');
}

/** 构建收尾评估提示词（头部 + stepContext + 任务 + 透传变量列表 + 返回格式 + 红线规则）。 */
function buildAssessPrompt(context: FinalizeStepContext, passThroughVars: readonly PassThroughVar[]): string {
  const sections: string[] = [ASSESS_PROMPT_HEADER, '', buildStepContextBlock(context)];
  sections.push('');
  sections.push('## 你的任务');
  sections.push('1. 判断当前 Step 是否真正完成（hasAsk: false = 已完成；true = 需要向用户提问确认后继续）');
  sections.push('2. 提取透传变量值：对每个列出的透传变量，从 <output> 中提取其值并写入 passThroughVars；若变量值就是 <output> 的完整文本，直接使用它。');
  sections.push('');
  sections.push('## 透传变量');
  if (passThroughVars.length === 0) {
    sections.push('（无透传变量）');
  }
  for (const variable of passThroughVars) {
    sections.push(`- ${variable.name}: ${variable.description}`);
  }
  sections.push('');
  sections.push('## 返回格式（JSON）');
  sections.push('{"hasAsk": false, "passThroughVars": {}, "askQuestion": {"questions": []}}');
  sections.push('');
  sections.push('## 红线规则');
  for (const rule of ASSESS_RED_LINES) {
    sections.push(`- ${rule}`);
  }
  return sections.join('\n');
}

/** 构建 primary 门禁提示词。 */
function buildPrimaryGatePrompt(context: FinalizeStepContext): string {
  const sections: string[] = [PRIMARY_GATE_PROMPT_HEADER, '', buildStepContextBlock(context)];
  sections.push('');
  sections.push('## 返回格式（JSON）');
  sections.push('{"taskStatus": "done" | "error", "errorDetail": "..."}');
  return sections.join('\n');
}

/** 构建 secondary 门禁提示词（注入 secondaryPrompt 完整审查）。 */
function buildSecondaryGatePrompt(context: FinalizeStepContext, secondaryPrompt: string | undefined): string {
  const sections: string[] = [PRIMARY_GATE_PROMPT_HEADER, '', buildStepContextBlock(context)];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(secondaryPrompt ?? '对当前 Step 的输出进行完整门控审查。');
  sections.push('');
  sections.push('## 返回格式（JSON）');
  sections.push('{"gateStatus": "done" | "error", "gateDetail": "..."}');
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
    // hasAsk 主键；旧 completionType 兼容回退（LLM 仍可能输出旧格式）。
    const hasAsk = parseHasAsk(parsed['hasAsk']) || parseHasAsk(parsed['completionType']);
    return {
      hasAsk,
      passThroughVars: parsePassThroughVars(parsed['passThroughVars']),
      ...(askQuestion === undefined ? {} : { askQuestion }),
    };
  }
  const matchAsk = raw.match(/"hasAsk"\s*:\s*(true|false)/);
  const matchType = raw.match(/"completionType"\s*:\s*"([^"]+)"/);
  const hasAsk = matchAsk !== null ? matchAsk[1] === 'true' : matchType?.[1] === 'ask';
  return { hasAsk, passThroughVars: {} };
}

/** 解析 primary 门禁输出（`taskStatus` + `errorDetail`）；带 ```json 围栏时同样剥离。 */
export function parsePrimaryGate(raw: string): PrimaryGateParsed {
  const parsed = parseJsonObject(raw) ?? parseJsonObject(stripJsonFence(raw));
  const passed = parsed?.['taskStatus'] === 'done';
  const errorDetail = parsed?.['errorDetail'];
  return {
    passed,
    ...(passed || typeof errorDetail !== 'string' ? {} : { errorDetail }),
  };
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
 * 判定 command 类型是否走 session 会话（agent/skill/mcp/prompt）。
 *
 * 决策 D3 修复（2026-08）：'prompt' 现为真实可续接子代理会话（`synthetic:false` +
 * 真实 childId），与 agent/skill/mcp 一致走 `sessions.fork(stepSessionId)` 评估续接。
 */
function isSessionType(type: string | undefined): boolean {
  return type === 'agent' || type === 'skill' || type === 'mcp' || type === 'prompt';
}

/** 判定 Step 是否含未解析透传变量（value 仍含 `${xxx}` 占位）。 */
export function hasUnresolvedPassThroughVars(step: WorkflowStep): boolean {
  return (step.passThroughVars ?? []).some(variable => hasUnresolvedVars(variable.value));
}

/**
 * 判定门禁配置是否存在 enabled 门禁（primary 或 secondary）。
 *
 * primary 默认启用（对齐基准 `primary?.enabled ?? true`）——未显式 `enabled:false`
 * 即视为有门禁；secondary 默认禁用，需显式 `enabled:true` 才计入。`gates` 为
 * `undefined`（三级均未配置，`mergeGates` 返回 undefined）时返回 false，仍走
 * `finalizeStep` 的零 AI 调用跳过路径。
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

/** 组装 finalizeMeta（currentPhase + assessSessionId/assessResult + 可选 gateResult/gateSessionId）。 */
function buildFinalizeMeta(
  assessResult: FinalizeAssessResult | undefined,
  gateResult: GateEvalResult | undefined,
  currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
  options?: { readonly recordAssessSession?: boolean },
): FinalizeMeta {
  return {
    currentPhase,
    ...(assessResult === undefined
      ? {}
      : {
          assessResult,
          // Phase A（ask-detect）不持久化评估 fork 会话 id（计划：Phase A 用完即删、
          // Phase B/C 才持久化到 state）——顶层 assessSessionId 自 Phase B 起记录；
          // assessResult.forkSessionId 因 schema 强约束随结果落 state（见 schema 注释）。
          ...(options?.recordAssessSession === false ? {} : { assessSessionId: assessResult.forkSessionId }),
        }),
    ...(gateResult === undefined ? {} : { gateResult, gateSessionId: gateResult.gateSessionId }),
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
 * `sessionId` 为评估续接的 fork 会话 ID（仅 session 类型且 fork 成功时传入，令 LLM
 * 请求携带 fork 会话身份用于路由/重放）；降级或 shell 类型时为 `undefined`，请求退化为
 * 一次性临时会话。
 */
async function runStream(
  ctx: Context,
  config: FinalizeManagerConfig,
  promptText: string,
  signal: AbortSignal | undefined,
  failure: StreamFailure,
  sessionId?: SessionId,
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
    ...(sessionId === undefined ? {} : { sessionId }),
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
 * 收尾第 1 部分：完成判定 + 透传变量提取 + ask 转换。
 *
 * session 类型 Step 经 `ctx.sessions.fork(stepSessionId)` 创建 fork 会话（boundary 省略
 * 取源最后一条事件），评估 LLM 请求携带 fork 会话 `sessionId` 作身份戳记（路由/重放）；
 * fork 抛错时降级为一次性临时会话（省略 sessionId）并记 `errorDetail`（Step 不失败）。
 * shell 类型经
 * `ctx.llm.stream()` 一次性临时会话（shell stdout 作为输入）。评估提示词含
 * `<stepContext>`、透传变量列表、返回 JSON 格式与红线规则；输出三级解析
 * （JSON → regex → 原始）。
 */
export class FinalizeAssessor {
  constructor(
    private readonly ctx: Context,
    private readonly config: FinalizeManagerConfig,
  ) {}

  /** 执行收尾评估，返回 `FinalizeAssessResult`（含 forkSessionId/assessmentRaw）。 */
  async assess(input: FinalizeAssessInput): Promise<FinalizeAssessResult> {
    let forkSessionId: string;
    let sessionId: SessionId | undefined;
    let errorDetail: string | undefined;
    const commandType = input.step.command?.type;
    if (isSessionType(commandType) && input.stepSessionId !== undefined) {
      try {
        const child = this.ctx.sessions.fork(SessionId(input.stepSessionId));
        forkSessionId = child.id;
        sessionId = child.id;
      } catch (error) {
        forkSessionId = newSessionHandle();
        errorDetail = `fork session degraded to temp session: ${describeError(error)}`;
      }
    } else {
      forkSessionId = newSessionHandle();
    }
    const promptText = buildAssessPrompt(input.context, input.step.passThroughVars ?? []);
    const raw = await runStream(this.ctx, this.config, promptText, input.signal, {
      code: 'FINALIZE_FAILED',
      action: 'finalize assess',
    }, sessionId);
    const parsed = parseAssessResult(raw);
    return {
      hasAsk: parsed.hasAsk,
      passThroughVars: parsed.passThroughVars,
      ...(parsed.askQuestion === undefined ? {} : { askQuestion: parsed.askQuestion }),
      ...(errorDetail === undefined ? {} : { errorDetail }),
      forkSessionId,
      assessmentRaw: raw,
    };
  }
}

/**
 * 收尾第 2 部分：独立新临时会话双门审查。
 *
 * primary 门禁（产物存在 + 基本完成度 → `taskStatus`）与 secondary 门禁
 * （`secondaryEnabled` 时注入 `secondaryPrompt` → `gateStatus`）各开一次 `ctx.llm.stream()`
 * 临时会话，与 Assessor 完全隔离。`gatesPassed=true` 后再验证 outputTo 产物文件存在，
 * 任一缺失则覆盖为 false 并记 `errorDetail`。未启用的门禁在 `gateDetails` 中仅标
 * `enabled:false`、不输出 `passed`（顶层 `primaryPassed`/`secondaryPassed` 亦省略）。
 *
 * **primary 默认启用**（对齐基准 `primary?.enabled ?? true`）：未配置 primary 或
 * `enabled!==false` 时执行 primary 门禁；仅显式 `primary.enabled:false` 才跳过。
 * secondary 默认禁用（对齐基准 `secondary?.enabled ?? false`），需显式 `enabled:true`
 * 才执行。差异场景：用户只配置 secondary 门禁、未配置 primary 时，基准 primary 默认
 * 执行，sandore 改动后同样默认执行（修前 sandore 默认不执行 → 行为分歧，已修）。
 */
export class GateEvaluator {
  constructor(
    private readonly ctx: Context,
    private readonly config: FinalizeManagerConfig,
  ) {}

  /** 执行门禁审查，返回 `GateEvalResult`（含 gateSessionId/assessmentRaw）。 */
  async evaluate(input: FinalizeGateInput): Promise<GateEvalResult> {
    // primary 默认启用（对齐基准 primary?.enabled ?? true）：未配置或 enabled!==false
    // 即执行 primary 门禁；仅显式 enabled:false 才跳过。secondary 默认禁用，需显式
    // enabled:true 才执行（与基准 secondary?.enabled ?? false 一致）。
    const primaryEnabled = input.gates.primary?.enabled !== false;
    const secondaryEnabled = input.gates.secondary?.enabled === true;
    // 真实 fork 会话（Phase C 门禁）：session 类型 Step 有真实子代理会话时 fork 出
    // 门禁专用会话（`gateSessionId` = 真实 fork id，持久化到 finalizeMeta 供 UI 打开，
    // 对齐 Phase B/C fork 会话持久化到 state 规则）；fork 失败（合成 session/非 live/
    // OPEN_TURN 等）或非 session 类型降级为一次性临时句柄（不失败）。
    let gateSessionId: string;
    let sessionId: SessionId | undefined;
    if (input.stepSessionId !== undefined) {
      try {
        const child = this.ctx.sessions.fork(SessionId(input.stepSessionId));
        gateSessionId = child.id;
        sessionId = child.id;
      } catch (error) {
        gateSessionId = newSessionHandle();
        this.ctx.logger.warn(`sandore: gate fork session degraded to temp session: ${describeError(error)}`);
      }
    } else {
      gateSessionId = newSessionHandle();
    }
    const rawParts: string[] = [];
    const errorParts: string[] = [];

    let primaryPassed: boolean | undefined;
    if (primaryEnabled) {
      const raw = await runStream(this.ctx, this.config, buildPrimaryGatePrompt(input.context), input.signal, {
        code: 'GATE_FAILED',
        action: 'gate evaluation',
      }, sessionId);
      rawParts.push(raw);
      const parsed = parsePrimaryGate(raw);
      primaryPassed = parsed.passed;
      if (!parsed.passed && parsed.errorDetail !== undefined) {
        errorParts.push(parsed.errorDetail);
      }
    }

    let secondaryPassed: boolean | undefined;
    if (secondaryEnabled) {
      const raw = await runStream(this.ctx, this.config, buildSecondaryGatePrompt(input.context, input.gates.secondary?.prompt), input.signal, {
        code: 'GATE_FAILED',
        action: 'gate evaluation',
      }, sessionId);
      rawParts.push(raw);
      const parsed = parseSecondaryGate(raw);
      secondaryPassed = parsed.passed;
      if (!parsed.passed && parsed.detail !== undefined) {
        errorParts.push(parsed.detail);
      }
    }

    let gatesPassed =
      (primaryEnabled ? primaryPassed === true : true) &&
      (secondaryEnabled ? secondaryPassed === true : true);
    if (gatesPassed) {
      const missing = await this.verifyArtifacts(input.step, input.workdir, input.vars ?? {});
      if (missing.length > 0) {
        gatesPassed = false;
        errorParts.push(`missing output files: ${missing.join(', ')}`);
      }
    }

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
   * 校验 outputTo 产物文件存在；返回缺失的 pattern 列表。
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
 * - **Phase A（问题检测/评估，ask 保底）**：`assessOnly()` 只跑评估（完成判定 + 透传
 *   变量提取 + ask 保底判断）；`hasAsk` + askQuestion 载荷 → 调用方把 Step 置
 *   interacting 中断（引擎级 ask 闭环），finalizeMeta currentPhase='ask-detect' 且
 *   **不记录顶层 assessSessionId**（评估 fork 会话**用完即删**：live 引用评估后释放、
 *   不持久化——计划「Phase A 不持久化」）。
 * - **Phase B（收尾）**：`commitFinalize(..., 'finalizing')` 回写透传变量（保留
 *   refresh）+ 组装 finalizeMeta（`assessSessionId` 持久化到 state）。
 * - **Phase C（门禁）**：`evaluateGates()` 用**真实 fork 会话**跑门禁（`gateSessionId`
 *   持久化到 state）；未通过由调用方落 failed（currentPhase='gating'）。
 *
 * `finalizeStep()` 保留为编排兼容入口（跳过检查 → assessOnly → ask? → evaluateGates →
 * commitFinalize），供既有调用方/测试使用。
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
   * 完成判定 + 透传变量提取 + ask 转换。假 ask 防御（`hasAsk` 但无 askQuestion 载荷）
   * 回落 `hasAsk=false`。**不**跑门禁、**不**回写任何状态——调用方（stage-executor
   * `runPhaseA`）根据返回值决定 ask 中断或继续 Phase B/C。
   */
  async assessOnly(request: FinalizeStepRequest): Promise<FinalizeAssessResult> {
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
   * Phase C：门禁审查（GateEvaluator，真实 fork 会话）。
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
   * 收尾落点（Phase B / 门禁后）：回写 finalizeMeta + 透传变量 + onPersist。
   *
   * `currentPhase` 标注当前收尾阶段（`ask-detect`/`finalizing`/`gating`/`completed`），
   * 供 UI 展示；`assessSessionId`（Phase B 起）/`gateSessionId`（Phase C）持久化到
   * state。`options.recordAssessSession=false`（Phase A ask 保底中断）时不记录顶层
   * assessSessionId（计划：Phase A fork 用完即删、不持久化；Phase B 收尾才落
   * assessSessionId）。
   * 透传变量提取回退：AI 未提取（fork 降级/模型行为）且步骤仅声明一个未解析变量、
   * 输出非空时，以输出文本为该变量值（对齐「变量值从步骤输出提取」的文档语义，
   * 避免单变量场景下提取落空）。
   */
  async commitFinalize(
    request: FinalizeStepRequest,
    assessResult: FinalizeAssessResult | undefined,
    gateResult: GateEvalResult | undefined,
    currentPhase: NonNullable<FinalizeMeta['currentPhase']>,
    options?: { readonly recordAssessSession?: boolean },
  ): Promise<void> {
    request.executedStep.finalizeMeta = buildFinalizeMeta(assessResult, gateResult, currentPhase, options);
    const extracted: Record<string, string> = { ...(assessResult?.passThroughVars ?? {}) };
    fillUnresolvedSingleVar(request.step, extracted, request.context.output);
    writeBackPassThroughVars(extracted, request.step, request.passThroughVars);
    await request.onPersist?.(request.executedStep);
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

    const assessResult = await this.assessOnly(request);

    if (assessResult.hasAsk) {
      executedStep.status = 'interacting';
      // Phase A ask 保底中断：currentPhase='ask-detect'，不记录顶层 assessSessionId。
      await this.commitFinalize(request, assessResult, undefined, 'ask-detect', { recordAssessSession: false });
      return { type: 'ask', assessResult };
    }

    let gateResult: GateEvalResult | undefined;
    if (hasEnabledGates(request.gates)) {
      gateResult = await this.evaluateGates(request, assessResult);
    }

    if (gateResult !== undefined && !gateResult.gatesPassed) {
      await this.commitFinalize(request, assessResult, gateResult, 'gating');
      return {
        type: 'error',
        errorDetail: gateResult.errorDetail ?? 'gate evaluation failed',
        assessResult,
        gateResult,
      };
    }

    await this.commitFinalize(request, assessResult, gateResult, 'completed');
    return {
      type: 'done',
      assessResult,
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
