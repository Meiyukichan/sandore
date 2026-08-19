/**
 * Step 收尾拆分（finalize-manager）。
 *
 * `FinalizeAssessor`（收尾第 1 部分）按 Step 类型选择会话完成完成判定 + 透传变量提取
 * + ask 转换：session 类型（agent/prompt/skill/mcp）经 `ctx.sessions.fork(stepSessionId)`
 * 创建 fork 会话（boundary 省略取源最后一条事件，规避 OPEN_TURN），评估 LLM 请求携带
 * fork 会话 `sessionId` 作身份戳记（路由/重放）；fork 抛错时降级为一次性临时会话（省略
 * sessionId）且 Step 不失败；shell 类型经 `ctx.llm.stream()` 一次性临时会话（shell stdout
 * 作为输入）。完整注入 fork 会话历史留待 Task 4。
 * `GateEvaluator`（收尾第 2 部分）恒开独立新临时会话执行 primary/secondary 双门
 * 审查，`gatesPassed=true` 后再验证 outputTo 产物文件存在，缺失则覆盖为 false。
 * `FinalizeManager.finalizeStep` 编排：跳过检查（无未解析透传变量 + 无门禁）→ assess →
 * ask 置 interacting 中断门禁 / gate 审查 → 回写 passThroughVars（保留 refresh）→ 同步
 * finalizeMeta 到 executedSteps → persistState。
 * @module @deepseek-ai/dsh-sandore-microflow/src/finalize-manager
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

import { SandoreError } from './errors.ts';
import { findFilesByGlob, findFilesByRegex, isGlobPattern } from './file-utils.ts';
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
  readonly completionType: 'completed' | 'ask';
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

/** 收窄未知值为 completionType（仅 `'ask'` 判为 ask，其余回落 completed）。 */
function parseCompletionType(value: unknown): 'completed' | 'ask' {
  return value === 'ask' ? 'ask' : 'completed';
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
  sections.push('1. 判断当前 Step 是否真正完成（completionType: completed | ask）');
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
  sections.push('{"completionType": "completed" | "ask", "passThroughVars": {}, "askQuestion": {"questions": []}}');
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
 * ① JSON 解析取 `completionType`/`passThroughVars`/`askQuestion`；② regex 回退
 * `/"completionType"\s*:\s*"([^"]+)"/`（透传变量回落空）；③ 原始输出回落
 * `completionType='completed'` + 空透传变量。
 */
export function parseAssessResult(raw: string): AssessParsed {
  const parsed = parseJsonObject(raw);
  if (parsed !== undefined) {
    const askQuestion = parseAskQuestion(parsed['askQuestion']);
    return {
      completionType: parseCompletionType(parsed['completionType']),
      passThroughVars: parsePassThroughVars(parsed['passThroughVars']),
      ...(askQuestion === undefined ? {} : { askQuestion }),
    };
  }
  const match = raw.match(/"completionType"\s*:\s*"([^"]+)"/);
  const completionType = match?.[1] === 'ask' ? 'ask' : 'completed';
  return { completionType, passThroughVars: {} };
}

/** 解析 primary 门禁输出（`taskStatus` + `errorDetail`）。 */
export function parsePrimaryGate(raw: string): PrimaryGateParsed {
  const parsed = parseJsonObject(raw);
  const passed = parsed?.['taskStatus'] === 'done';
  const errorDetail = parsed?.['errorDetail'];
  return {
    passed,
    ...(passed || typeof errorDetail !== 'string' ? {} : { errorDetail }),
  };
}

/** 解析 secondary 门禁输出（`gateStatus` + `gateDetail`）。 */
export function parseSecondaryGate(raw: string): SecondaryGateParsed {
  const parsed = parseJsonObject(raw);
  const passed = parsed?.['gateStatus'] === 'done';
  const detail = parsed?.['gateDetail'];
  return {
    passed,
    ...(passed || typeof detail !== 'string' ? {} : { detail }),
  };
}

/**
 * 判定 command 类型是否走 session 会话（agent/skill/mcp）。
 *
 * 探索修正（2026-08）：'prompt' 无真实会话（sessionMeta 为合成占位，`synthetic:true`），
 * 误入后 `sessions.fork(合成id)` 必抛 SESSION_NOT_FOUND → 每次收尾评估降级。
 */
function isSessionType(type: string | undefined): boolean {
  return type === 'agent' || type === 'skill' || type === 'mcp';
}

/** 判定 Step 是否含未解析透传变量（value 仍含 `${xxx}` 占位）。 */
function hasUnresolvedPassThroughVars(step: WorkflowStep): boolean {
  return (step.passThroughVars ?? []).some(variable => /\$\{[^}]+\}/.test(variable.value));
}

/** 判定门禁配置是否存在 enabled 门禁（primary 或 secondary）。 */
function hasEnabledGates(gates: Gates | undefined): gates is Gates {
  return gates !== undefined && (gates.primary?.enabled === true || gates.secondary?.enabled === true);
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

/** 组装 finalizeMeta（status/completionType/assessResult + 可选 gateResult/gateSessionId）。 */
function buildFinalizeMeta(assessResult: FinalizeAssessResult, gateResult: GateEvalResult | undefined): FinalizeMeta {
  return {
    status: assessResult.completionType === 'ask' ? 'ask' : 'completed',
    completionType: assessResult.completionType,
    assessResult,
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
      completionType: parsed.completionType,
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
 */
export class GateEvaluator {
  constructor(
    private readonly ctx: Context,
    private readonly config: FinalizeManagerConfig,
  ) {}

  /** 执行门禁审查，返回 `GateEvalResult`（含 gateSessionId/assessmentRaw）。 */
  async evaluate(input: FinalizeGateInput): Promise<GateEvalResult> {
    const primaryEnabled = input.gates.primary?.enabled === true;
    const secondaryEnabled = input.gates.secondary?.enabled === true;
    const gateSessionId = newSessionHandle();
    const rawParts: string[] = [];
    const errorParts: string[] = [];

    let primaryPassed: boolean | undefined;
    if (primaryEnabled) {
      const raw = await runStream(this.ctx, this.config, buildPrimaryGatePrompt(input.context), input.signal, {
        code: 'GATE_FAILED',
        action: 'gate evaluation',
      });
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
      });
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
      const missing = await this.verifyArtifacts(input.step, input.workdir);
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

  /** 校验 outputTo 产物文件存在；返回缺失的 pattern 列表。 */
  private async verifyArtifacts(step: WorkflowStep, workdir: string): Promise<string[]> {
    const missing: string[] = [];
    for (const outputTo of step.outputTo ?? []) {
      if (outputTo.regex !== undefined) {
        const found = await findFilesByRegex(this.ctx.fs, workdir, outputTo.regex);
        if (found.length === 0) {
          missing.push(outputTo.regex);
        }
      } else if (outputTo.path !== undefined) {
        const found = isGlobPattern(outputTo.path)
          ? await findFilesByGlob(this.ctx.fs, workdir, outputTo.path)
          : await findFilesByRegex(this.ctx.fs, workdir, outputTo.path);
        if (found.length === 0) {
          missing.push(outputTo.path);
        }
      }
    }
    return missing;
  }
}

/**
 * Step 收尾编排器。
 *
 * 组合 {@link FinalizeAssessor} 与 {@link GateEvaluator}，`finalizeStep()` 按序执行：跳过检查
 * （无未解析透传变量 + 无门禁 → 零 AI 调用直接 done）→ assess → ask 置 interacting 中断
 * 门禁 / gate 审查 → 回写 passThroughVars（保留 refresh）→ 同步 finalizeMeta → persistState。
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

  /** 编排单个 Step 的收尾，返回 `FinalizeOutcome`（done/ask/error 三态）。 */
  async finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome> {
    const { step, executedStep } = request;
    const needsAssess = hasUnresolvedPassThroughVars(step);
    const hasGates = hasEnabledGates(request.gates);

    if (!needsAssess && !hasGates) {
      return { type: 'done', completionType: 'completed' };
    }

    const assessResult = await this.assessor.assess({
      step,
      ...(request.stepSessionId === undefined ? {} : { stepSessionId: request.stepSessionId }),
      context: request.context,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (assessResult.completionType === 'ask') {
      executedStep.status = 'interacting';
      await this.persistFinalize(executedStep, assessResult, request, undefined);
      return { type: 'ask', assessResult };
    }

    return this.finalizeAfterAssess(executedStep, assessResult, request);
  }

  /**
   * ask 回复后重跑收尾（继续门禁审查）：
   * 评估已在首次 finalizeStep 完成（completionType === 'ask'），此处仅重跑门禁并把
   * executedStep 从 interacting 置回 completed/failed。
   */
  async finalizeStepAfterAsk(
    request: FinalizeStepRequest,
    assessResult: FinalizeAssessResult,
  ): Promise<FinalizeOutcome> {
    request.executedStep.status = 'completed';
    return this.finalizeAfterAssess(request.executedStep, assessResult, request);
  }

  /** 评估完成后（completionType === 'completed' 或 ask 恢复后）的收尾：门禁审查 + 回写。 */
  private async finalizeAfterAssess(
    executedStep: ExecutedStepDefault,
    assessResult: FinalizeAssessResult,
    request: FinalizeStepRequest,
  ): Promise<FinalizeOutcome> {
    const hasGates = hasEnabledGates(request.gates);
    let gateResult: GateEvalResult | undefined;
    if (hasGates) {
      gateResult = await this.gateEvaluator.evaluate({
        step: request.step,
        context: request.context,
        gates: request.gates,
        workdir: request.workdir,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }

    if (gateResult !== undefined && !gateResult.gatesPassed) {
      await this.persistFinalize(executedStep, assessResult, request, gateResult);
      return {
        type: 'error',
        errorDetail: gateResult.errorDetail ?? 'gate evaluation failed',
        assessResult,
        gateResult,
      };
    }

    await this.persistFinalize(executedStep, assessResult, request, gateResult);
    return {
      type: 'done',
      completionType: 'completed',
      assessResult,
      ...(gateResult === undefined ? {} : { gateResult }),
    };
  }

  /** 回写 finalizeMeta + 透传变量 + onPersist（评估结果与门禁结果的统一落点）。 */
  private async persistFinalize(
    executedStep: ExecutedStepDefault,
    assessResult: FinalizeAssessResult,
    request: FinalizeStepRequest,
    gateResult: GateEvalResult | undefined,
  ): Promise<void> {
    executedStep.finalizeMeta = buildFinalizeMeta(assessResult, gateResult);
    // 透传变量提取回退：AI 评估未提取（fork 降级/模型行为）且步骤仅声明一个
    // 未解析变量、输出非空时，以输出文本为该变量值（对齐「变量值从步骤输出
    // 提取」的文档语义，避免单变量场景下提取落空）。
    const extracted: Record<string, string> = { ...assessResult.passThroughVars };
    fillUnresolvedSingleVar(request.step, extracted, request.context.output);
    writeBackPassThroughVars(extracted, request.step, request.passThroughVars);
    await request.onPersist?.(executedStep);
  }
}

/** 单变量提取回退：AI 未提取且步骤仅声明一个未解析变量、输出非空时用输出文本。 */
function fillUnresolvedSingleVar(
  step: WorkflowStep,
  extracted: Record<string, string>,
  output: string | undefined,
): void {
  if (Object.keys(extracted).length > 0) return;
  const unresolved = (step.passThroughVars ?? []).filter(variable => /\$\{[^}]+\}/.test(variable.value));
  if (unresolved.length === 1 && output !== undefined && output.trim() !== '') {
    extracted[unresolved[0]!.name] = output;
  }
}
