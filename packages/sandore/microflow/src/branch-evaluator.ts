/**
 * 分支条件两阶段评估器（branch-evaluator）。
 *
 * 以 `start(condition, contextMessage)` 启动评估：agent/prompt/skill/mcp 四类经
 * `ctx.llm.stream()` 创建临时会话发送评估提示词（携带 `sessionHandle`）；shell 类
 * 经 `ctx.shell.run()`（简单命令）或 `ctx.subprocess.spawn()`（透传变量替换 →
 * 环境变量注入 → stdin 注入）直接执行（`sessionHandle = null`）。`collect(partial)`
 * 聚合 AI 输出文本（shell 直接返回 stdout）；`evaluate()` 一步完成两阶段。
 *
 * 另提供纯函数 `extractExpectation`（三级解析）、`extractBreakResult`（public，
 * 供 LoopManager 复用）与 `matchesExpectation`（regex 或字符串相等匹配）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/branch-evaluator
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

import { SandoreError } from './errors.ts';
import { replacePassThroughVars } from './file-utils.ts';
import {
  buildShellEnv,
  resolvePassThroughVars,
  resolveProviderModel as resolveModelRoute,
  splitCommand,
  textSummary,
} from './internal.ts';
import type { CommandConfig, DagBranch } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import type { ShellExecRequest, ShellRunResult, SubprocessSpawnSpec } from '@deepseek-ai/dsh-sandore-workflow/src/shell';

/** shell 命令变体。 */
type ShellCommand = Extract<CommandConfig, { type: 'shell' }>;
/** prompt 命令变体。 */
type PromptCommand = Extract<CommandConfig, { type: 'prompt' }>;
/** agent 命令变体。 */
type AgentCommand = Extract<CommandConfig, { type: 'agent' }>;
/** skill 命令变体。 */
type SkillCommand = Extract<CommandConfig, { type: 'skill' }>;
/** mcp 命令变体。 */
type McpCommand = Extract<CommandConfig, { type: 'mcp' }>;
/** 走临时会话的四类命令（与 shell 分支区分）。 */
type AiCommand = PromptCommand | AgentCommand | SkillCommand | McpCommand;
/** 四类 AI 命令的 value（provider/model 三层回退的取值域）。 */
type AiValue = PromptCommand['value'] | AgentCommand['value'] | SkillCommand['value'] | McpCommand['value'];

/** AI 分支评估临时会话标识（与 DSH 品牌字符串结构兼容）。 */
export type TempSessionHandle = string;

/** BranchEvaluator 的引擎级配置（provider/model 三层回退的 L2 来源 + shell 超时）。 */
export interface BranchEvaluatorConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
}

/** 分支评估附加选项（分支列表 + shell 三注入所需上下文）。 */
export interface BranchEvalOptions {
  /** 候选分支（用于构建评估提示词的分支列表）。 */
  readonly branches?: readonly DagBranch[];
  /** 透传变量（shell 三注入与提示词 `${xxx}` 替换）。 */
  readonly passThroughVars?: Readonly<Record<string, string>>;
  /** 当前循环迭代序号（1-based；非循环 0）。 */
  readonly loopTurn?: number;
  /** 活跃循环 maxIterations（非循环 0）。 */
  readonly loopMaxIterations?: number;
  /** shell 执行工作目录。 */
  readonly workdir?: string;
  /** shell 分支 stdin 注入内容（当前 Step 输出 JSON）。 */
  readonly stdin?: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 一次分支评估的最终结果。 */
export interface BranchEvalResult {
  /** 聚合输出文本（AI 会话输出或 shell stdout）。 */
  readonly output: string;
  /** 临时会话标识；shell 分支为 null。 */
  readonly sessionHandle: TempSessionHandle | null;
}

/** 两阶段评估的中间态：`start` 产生、`collect` 消费。 */
export interface BranchEvalPartial {
  /** 临时会话标识；shell 分支为 null。 */
  readonly sessionHandle: TempSessionHandle | null;
  /** 待聚合的输出（AI 会话为流聚合 promise，shell 为直接结果）。 */
  readonly outputPromise: Promise<string>;
}

/** 结构化分支评估提示词主头部。 */
const BRANCH_PROMPT_HEADER =
  '你是严谨准确的DAG分支评估Agent，你的任务是根据分支条件与上下文，判断本次执行应路由到哪个分支。';

/** 分支评估红线规则（只读，禁止文件改动与过度思考）。 */
const BRANCH_RED_LINES = [
  '禁止编辑、创建或删除任何文件',
  '禁止过度思考，你的职责是尽快判断分支并返回结果',
] as const;

/** 构建结构化分支评估提示词（主头部 + 任务 + 上下文 + 分支列表 + 返回格式 + 红线规则）。 */
function buildBranchPrompt(taskText: string, contextMessage: string, branches: readonly DagBranch[]): string {
  const sections: string[] = [BRANCH_PROMPT_HEADER];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(taskText);
  sections.push('');
  sections.push('## 参考信息');
  sections.push('### 前置上下文');
  sections.push(contextMessage);
  sections.push('');
  sections.push('## 候选分支');
  if (branches.length === 0) {
    sections.push('（无显式分支，请依据任务判断返回 expectation）');
  }
  for (const branch of branches) {
    const label = branch.label ?? branch.next;
    const expectation = branch.expectation ?? '(并行分支，无 expectation)';
    sections.push(`- ${label}: expectation=${expectation}`);
  }
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请仅返回 JSON，格式为：{"branchExpectation": "..."}，其中 branchExpectation 为命中分支的 expectation 值。');
  sections.push('');
  sections.push('## 红线规则');
  for (const rule of BRANCH_RED_LINES) {
    sections.push(`- ${rule}`);
  }
  return sections.join('\n');
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
  // raw 已收窄为非空 object，转换为可索引访问的 Record 以读取字段。
  return raw as Record<string, unknown>;
}

/**
 * 三级解析分支 expectation。
 *
 * ① JSON 解析取 `branchExpectation` 字段；② regex 回退
 * `/"branchExpectation"\s*:\s*"([^"]+)"/`；③ 原始输出 `raw.trim()`。
 */
export function extractExpectation(raw: string): string {
  const parsed = parseJsonObject(raw);
  if (parsed !== undefined) {
    const branchExpectation = parsed['branchExpectation'];
    if (typeof branchExpectation === 'string') {
      return branchExpectation;
    }
  }
  const match = raw.match(/"branchExpectation"\s*:\s*"([^"]+)"/);
  const extracted = match?.[1];
  if (extracted !== undefined) {
    return extracted;
  }
  return raw.trim();
}

/**
 * 三级解析循环跳出结果（public）。
 *
 * ① JSON 解析取 `shouldBreak`（布尔转字符串，字符串 `"true"`/`"false"` 转小写）；
 * ② regex 回退 `/"shouldBreak"\s*:\s*(true|false)/i`（匹配后转小写）；③ `raw.trim()`。
 */
export function extractBreakResult(raw: string): string {
  const parsed = parseJsonObject(raw);
  if (parsed !== undefined) {
    const shouldBreak = parsed['shouldBreak'];
    if (typeof shouldBreak === 'boolean') {
      return String(shouldBreak);
    }
    if (typeof shouldBreak === 'string' && /^(true|false)$/i.test(shouldBreak)) {
      return shouldBreak.toLowerCase();
    }
  }
  const match = raw.match(/"shouldBreak"\s*:\s*(true|false)/i);
  const extracted = match?.[1];
  if (extracted !== undefined) {
    return extracted.toLowerCase();
  }
  return raw.trim();
}

/** 含 regex 元字符时判定 expectation 为正则，否则视为字面字符串。 */
function hasRegexMetacharacters(value: string): boolean {
  return /[\\^$.*+?()[\]{}|]/.test(value);
}

/**
 * 判定分支评估结果是否匹配 expectation：expectation 含 regex 特征时做正则匹配
 * （正则非法视为不匹配），否则字符串相等比较。
 */
export function matchesExpectation(result: string, expectation: string): boolean {
  if (hasRegexMetacharacters(expectation)) {
    let regex: RegExp;
    try {
      regex = new RegExp(expectation);
    } catch {
      return false;
    }
    return regex.test(result);
  }
  return result === expectation;
}

/**
 * 分支条件两阶段评估器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`start()` 按 `condition.type` 分发（shell 直接
 * 执行，其余四类走 `ctx.llm.stream()` 临时会话），`collect()` 聚合输出文本，
 * `evaluate()` 一步完成。AI 会话失败（error/aborted）抛 `SandoreError`。
 */
export class BranchEvaluator {
  constructor(
    private readonly ctx: Context,
    private readonly config: BranchEvaluatorConfig,
  ) {}

  /** 启动评估，返回中间态；AI 会话带 sessionHandle，shell 直接执行完成。 */
  async start(condition: CommandConfig, contextMessage: string, options: BranchEvalOptions = {}): Promise<BranchEvalPartial> {
    switch (condition.type) {
      case 'shell':
        return await this.startShell(condition, options);
      case 'agent':
      case 'prompt':
      case 'skill':
      case 'mcp':
        return await this.startAi(condition, contextMessage, options);
      default:
        // 穷尽 5 类型后 `condition` 已收窄为 never；此处仅防御运行期注入的未知命令类型。
        throw new SandoreError(
          `unsupported branch condition type '${(condition as CommandConfig).type}'`,
          'STEP_EXECUTION',
        );
    }
  }

  /** 收集评估结果：聚合 AI 输出文本（shell 直接返回 stdout）。 */
  async collect(partial: BranchEvalPartial): Promise<BranchEvalResult> {
    const output = await partial.outputPromise;
    return { output, sessionHandle: partial.sessionHandle };
  }

  /** 一步完成两阶段评估。 */
  async evaluate(condition: CommandConfig, contextMessage: string, options: BranchEvalOptions = {}): Promise<BranchEvalResult> {
    const partial = await this.start(condition, contextMessage, options);
    return await this.collect(partial);
  }

  private async startAi(condition: AiCommand, contextMessage: string, options: BranchEvalOptions): Promise<BranchEvalPartial> {
    const route = await this.resolveProviderModel(condition.value);
    const taskText = replacePassThroughVars(
      condition.value.promptText,
      resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations),
    );
    const promptText = buildBranchPrompt(taskText, contextMessage, options.branches ?? []);
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: promptText }],
    });
    const sessionHandle = this.newSessionHandle();
    const generateOptions: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages: [message],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const assembler = new BlockAssembler();
    const stream = this.ctx.llm.stream(generateOptions);
    return {
      sessionHandle,
      outputPromise: this.aggregate(stream, assembler),
    };
  }

  private async startShell(condition: ShellCommand, options: BranchEvalOptions): Promise<BranchEvalPartial> {
    const command = replacePassThroughVars(
      condition.value.command,
      resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations),
    );
    const env = buildShellEnv(options.passThroughVars, options.loopTurn, options.loopMaxIterations);
    const output = await this.runShellCommand(command, options, env);
    return { sessionHandle: null, outputPromise: Promise.resolve(output) };
  }

  /** 聚合 AI 临时会话输出为文本；error/aborted 抛 SandoreError。 */
  private async aggregate(stream: AsyncIterable<StreamChunk>, assembler: BlockAssembler): Promise<string> {
    for await (const chunk of stream) {
      assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish.kind === 'error') {
      throw new SandoreError(`branch evaluation failed: ${finish.failure.message}`, 'STEP_EXECUTION');
    }
    if (finish.kind === 'aborted') {
      throw new SandoreError(`branch evaluation aborted: ${finish.failure.message}`, 'STEP_EXECUTION');
    }
    return textSummary(assembler.blocks());
  }

  private async runShellCommand(
    command: string,
    options: BranchEvalOptions,
    env: Record<string, string> | undefined,
  ): Promise<string> {
    if (options.stdin === undefined && env === undefined) {
      return await this.runShellSimple(command, options);
    }
    return await this.runShellSubprocess(command, options, env);
  }

  private async runShellSimple(command: string, options: BranchEvalOptions): Promise<string> {
    const request: ShellExecRequest = {
      command,
      timeoutMs: this.config.defaultTimeoutMs,
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const spec = this.ctx.shell.resolve(request);
    const result = await this.ctx.shell.run(spec);
    return this.toStdout(result);
  }

  private async runShellSubprocess(
    command: string,
    options: BranchEvalOptions,
    env: Record<string, string> | undefined,
  ): Promise<string> {
    const tokens = splitCommand(command);
    const program = tokens[0] ?? command;
    const args = tokens.slice(1);
    const executable = await this.ctx.subprocess.resolveExecutable(program, env, options.signal);
    const spec: SubprocessSpawnSpec = {
      argv: [executable, ...args],
      cwd: options.workdir ?? '',
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: 1024 * 1024 },
        stderr: { maxBytes: 1024 * 1024 },
      },
      graceMs: this.config.defaultTimeoutMs,
      ...(env === undefined ? {} : { env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const handle = this.ctx.subprocess.spawn(spec);
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    const result: ShellRunResult = {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut ?? false,
      aborted: options.signal?.aborted ?? false,
      timeoutMs: this.config.defaultTimeoutMs,
      stdout: { text: stdout?.text ?? '', truncated: stdout?.lossy ?? false },
      stderr: { text: stderr?.text ?? '', truncated: stderr?.lossy ?? false },
    };
    return this.toStdout(result);
  }

  /** shell 结果 → 输出文本：成功返回 stdout，非零退出/超时/中止抛 SandoreError。 */
  private toStdout(result: ShellRunResult): string {
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
      return result.stdout.text;
    }
    const stderr = result.stderr.text.trim();
    const stderrSummary = stderr === '' ? '(no stderr)' : stderr;
    if (result.timedOut) {
      throw new SandoreError(`shell command timed out: ${stderrSummary}`, 'STEP_TIMEOUT');
    }
    const reason = result.aborted
      ? 'aborted'
      : `exited with code ${result.exitCode === null ? 'signal' : String(result.exitCode)}`;
    throw new SandoreError(`shell command ${reason}: ${stderrSummary}`, 'STEP_EXECUTION');
  }

  /** 生成临时会话标识（随机 8 位 hex）。 */
  private newSessionHandle(): TempSessionHandle {
    const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `eval-${random}`;
  }

  /** provider/model 三层回退：条件定义 → 引擎配置 → ctx.llm 目录兜底。 */
  private async resolveProviderModel(value: AiValue): Promise<{ provider: string; model: string }> {
    return resolveModelRoute(value, this.config, this.ctx.llm);
  }
}
