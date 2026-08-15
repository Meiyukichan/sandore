/**
 * 单 Step 执行器（shell / prompt）。
 *
 * shell Step 走 `ctx.shell.resolve(request)` → `ctx.shell.run(spec)`，读
 * `ShellRunResult` 判定成功/失败（非零退出/超时/中止 resolve 为结果而非
 * reject）；prompt Step 走三层 provider/model 回退（Step 定义 → 引擎 Config →
 * `ctx.llm` 目录兜底）后 `ctx.llm.stream()`，聚合 block-end 为 `ContentBlock[]`，
 * `finish.reason.kind === 'error'`（或 'aborted'）为终端失败。
 * @module @deepseek-ai/dsh-sandore-microflow/src/step-runner
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm';

import { SandoreError } from './errors.ts';
import type { CommandConfig, WorkflowStep } from '../../workflow/src/schema.ts';
import type { ShellExecRequest, ShellRunResult } from '../../workflow/src/shell.ts';

type ShellCommand = Extract<CommandConfig, { type: 'shell' }>;
type PromptCommand = Extract<CommandConfig, { type: 'prompt' }>;

/** StepRunner 的引擎级配置（provider/model 三层回退的 L2 来源）。 */
export interface StepRunnerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
}

/** 前置 Step 的输出摘要（prompt 结构化提示词的参考信息）。 */
export interface PreviousStepOutput {
  readonly name: string;
  readonly id: string;
  readonly returnPrompt: string;
  readonly files: string[];
}

/** 单 Step 执行请求。 */
export interface StepRunRequest {
  readonly step: WorkflowStep;
  readonly workdir: string;
  readonly originalInput: string;
  readonly previousOutputs: readonly PreviousStepOutput[];
  readonly signal?: AbortSignal;
}

/** 单 Step 执行结果（成功时的输出块）。 */
export interface StepRunResult {
  readonly output: ContentBlock[];
}

/** 结构化提示词主头部。 */
const PROMPT_MAIN_HEADER =
  '你是严谨准确的Step执行Agent，你的任务是参考`## 参考信息`和`## 前置Steps输出`中的信息，\n准确完成`## 你的任务`中的要求。';

/**
 * 构建 prompt Step 的结构化提示词（主头部 + `## 你的任务` + `## 参考信息` +
 * `## 前置Steps输出与产物`）。
 */
function buildPromptText(
  step: WorkflowStep,
  command: PromptCommand,
  originalInput: string,
  previousOutputs: readonly PreviousStepOutput[],
): string {
  const sections: string[] = [];
  sections.push(PROMPT_MAIN_HEADER);
  sections.push('');
  sections.push('## 你的任务');
  sections.push(command.value.promptText);
  sections.push('');
  sections.push('## 参考信息');
  sections.push('### 用户原始需求');
  sections.push(originalInput);

  if (previousOutputs.length > 0) {
    sections.push('');
    sections.push('## 前置Steps输出与产物');
    for (const previous of previousOutputs) {
      sections.push(`### 前置Step: ${previous.name} (${previous.id})`);
      sections.push(`<${previous.id}>`);
      sections.push('  <output>');
      for (const line of previous.returnPrompt.split('\n')) {
        sections.push(`    ${line}`);
      }
      sections.push('  </output>');
      sections.push('  <artifacts>');
      for (const file of previous.files) {
        sections.push(`    - ${file}`);
      }
      sections.push('  </artifacts>');
      sections.push(`</${previous.id}>`);
    }
  }

  return sections.join('\n');
}

/**
 * 单 Step 执行器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`run()` 按 `step.command.type` 分发到
 * shell/prompt 两条路径。成功返回 `{ output: ContentBlock[] }`，失败抛
 * `SandoreError`（超时 → `STEP_TIMEOUT`，其余 → `STEP_EXECUTION`）。
 */
export class StepRunner {
  constructor(
    private readonly ctx: Context,
    private readonly config: StepRunnerConfig,
  ) {}

  /** 执行单个 Step；失败抛 `SandoreError`。 */
  async run(request: StepRunRequest): Promise<StepRunResult> {
    const command = request.step.command;
    if (command === undefined) {
      throw new SandoreError(`step '${request.step.id}' has no command`, 'STEP_EXECUTION');
    }
    switch (command.type) {
      case 'shell':
        return await this.runShell(command, request);
      case 'prompt':
        return await this.runPrompt(command, request);
      default:
        throw new SandoreError(`unsupported step command type '${command.type}'`, 'STEP_EXECUTION');
    }
  }

  private async runShell(command: ShellCommand, request: StepRunRequest): Promise<StepRunResult> {
    const shellRequest: ShellExecRequest = {
      command: command.value.command,
      timeoutMs: this.stepTimeoutMs(request.step),
      ...(request.workdir === undefined ? {} : { workdir: request.workdir }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    const spec = this.ctx.shell.resolve(shellRequest);
    const result = await this.ctx.shell.run(spec);
    return this.toShellResult(result);
  }

  private toShellResult(result: ShellRunResult): StepRunResult {
    if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
      return { output: [{ type: 'text', text: result.stdout.text }] };
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

  /** 解析 Step 级 timeout（分钟）→ 毫秒；缺省回退引擎 defaultTimeoutMs。 */
  private stepTimeoutMs(step: WorkflowStep): number {
    return step.timeout === undefined ? this.config.defaultTimeoutMs : step.timeout * 60_000;
  }

  private async runPrompt(command: PromptCommand, request: StepRunRequest): Promise<StepRunResult> {
    const route = await this.resolveProviderModel(command);
    const promptText = buildPromptText(request.step, command, request.originalInput, request.previousOutputs);
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: promptText }],
    });
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages: [message],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream(options)) {
      assembler.push(chunk);
    }
    const output = assembler.blocks();
    const finish = assembler.finish;
    if (finish.kind === 'error') {
      throw new SandoreError(`prompt step failed: ${finish.failure.message}`, 'STEP_EXECUTION');
    }
    if (finish.kind === 'aborted') {
      throw new SandoreError(`prompt step aborted: ${finish.failure.message}`, 'STEP_EXECUTION');
    }
    return { output };
  }

  private async resolveProviderModel(command: PromptCommand): Promise<{ provider: string; model: string }> {
    const { providerId, modelId } = command.value;
    // L1：Step 定义 providerId + modelId 成对提供才用。
    if (providerId !== undefined && modelId !== undefined) {
      return { provider: providerId, model: modelId };
    }
    // L2：引擎 Config defaultProvider + defaultModel 成对配置才用。
    if (this.config.defaultProvider !== undefined && this.config.defaultModel !== undefined) {
      return { provider: this.config.defaultProvider, model: this.config.defaultModel };
    }
    // L3：`ctx.llm` 目录兜底（listProviders 同步、listModels 异步）。
    const provider = this.llm().listProviders()[0];
    if (provider === undefined) {
      throw new SandoreError('no LLM provider available', 'STEP_EXECUTION');
    }
    const models = await this.llm().listModels(provider.id);
    const model = models[0];
    if (model === undefined) {
      throw new SandoreError(`no LLM model available for provider '${provider.id}'`, 'STEP_EXECUTION');
    }
    this.ctx.logger.warn(
      `sandore: prompt step falls back to directory provider '${provider.id}' model '${model.id}'`,
    );
    return { provider: provider.id, model: model.id };
  }

  /** `ctx.llm`（类型来自 dsh-llm 的 Context 增强）。 */
  private llm(): LlmRuntime {
    return this.ctx.llm;
  }
}
