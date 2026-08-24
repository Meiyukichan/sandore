/**
 * 分支条件两阶段评估器（branch-evaluator）。
 *
 * **fork-based 判断（缺陷 2/4 会话机制改造）**：agent/prompt/skill/mcp 四类经
 * `ctx.llm.stream()` 跑判断，会话机制从「一次性临时会话 + 手动传 I/O 文本」改为
 * 「fork 当前 step 会话 + 全量历史注入」——`forkStepSessionMessages` fork 出子代理会话
 * 分支并取其 derived messages 全量历史，作为 `llm.stream({ messages })` 前缀注入，AI 在
 * fork 会话上跑判断即可见全部 I/O（无需手动传 I/O 文本）；fork 失败（合成 session/非 live）
 * 降级为一次性临时会话（不传历史）。`shouldExecute`/`shouldBreak` 模板 +
 * `extractShouldExecute`/`extractBreakResult` 提取函数保留（结构化返回）；shell 类经
 * `ctx.shell.run()`（简单命令）或 `ctx.subprocess.spawn()`（透传变量替换 → 环境变量注入 →
 * stdin 注入）直接执行（`sessionHandle = null`）。`collect(partial)` 聚合 AI 输出文本
 * （shell 直接返回 stdout）；`evaluate()` 一步完成两阶段。
 * `evaluateCondition()` 在条件分支 AI 路径上叠加解析失败重试（首轮评估 +
 * 最多 {@link MAX_BRANCH_EVAL_RETRIES} 次 follow-up 纠正），shell 路径直接委托
 * `evaluate()`（走 matchesExpectation，无重试）。
 *
 * 另提供纯函数 `extractShouldExecute`（条件分支 shouldExecute 两层解析，public；
 * 解析失败返回 undefined 触发重试）、`extractBreakResult`（循环跳出 shouldBreak 三级
 * 解析，public，供 LoopManager 复用；分场景字段互不复用）与 `matchesExpectation`
 * （大小写不敏感+包含匹配；显式 `/.../ ` 定界时走正则）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/branch-evaluator
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';

import { SandoreError } from './errors.ts';
import { driveAgentRound, forkStepSubagent } from './fork-session.ts';
import { replacePassThroughVars } from './file-utils.ts';
import {
  buildShellEnv,
  resolvePassThroughVars,
  resolveProviderModel as resolveModelRoute,
  textSummary,
} from './internal.ts';
import type { AgentHandle, AgentOptions, CreateAgentOptions } from './subagents.ts';
import type { CommandConfig, DagBranch } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-sandore-workflow/src/shell';

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
/** 走 fork 会话/临时会话的四类命令（与 shell 分支区分）。 */
type AiCommand = PromptCommand | AgentCommand | SkillCommand | McpCommand;
/** 四类 AI 命令的 value（provider/model 三层回退的取值域）。 */
type AiValue = PromptCommand['value'] | AgentCommand['value'] | SkillCommand['value'] | McpCommand['value'];

/** AI 分支评估会话标识（fork 成功时为 fork 会话 id，降级时为临时 eval-xxxx）。 */
export type TempSessionHandle = string;

/** BranchEvaluator 的引擎级配置（provider/model 三层回退的 L2 来源 + shell 超时 + Phase D 路由 fork 能力注入）。 */
export interface BranchEvaluatorConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  /**
   * 宿主主代理 session id（Phase D 路由判断 fork 子代理的 `meta.parentSession`；
   * 引擎注入 `runnerConfig.hostAgent.id`）。
   */
  readonly hostAgentId?: string;
  /**
   * `ctx.agents.create` 的注入包装（引擎注入 `(o) => ctx.agents.create(o)`）。
   *
   * Phase D 路由判断（条件/循环跳出）经 `forkStepSubagent` 用它从 seed 重建宿主子代理，
   * `followup` 驱动一轮（不再 `forkStepSessionMessages` 同步历史注入 + `llm.stream`
   * 拼数组）；未注入时降级临时会话（`llm.stream` 单条判断提示词，不传历史）。
   */
  readonly createAgent?: (options: CreateAgentOptions) => Promise<AgentHandle>;
  /**
   * 取 step 子代理完整事件（live → persistence 回退，引擎注入：`ctx.sessions.get` →
   * `ctx.get('sessionPersistence').inspect`）。`undefined` = 无事件源 → 路由判断降级。
   */
  readonly getStepSessionEvents?: (childId: string) => Promise<readonly DshSessionEvent[] | undefined>;
}

/** 分支评估附加选项（分支列表 + shell 三注入所需上下文 + fork 源会话）。 */
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
  /**
   * 当前 step 的子代理会话 ID（Phase D 路由判断的 fork 子代理 seed 源：live →
   * persistence 回退取完整事件，`agents.create` 重建宿主子代理，AI 可见全部 I/O）。
   * 仅 agent/skill/mcp 类型有效（prompt/shell 合成 session 降级）。
   */
  readonly stepSessionId?: string;
  /** 当前 step id（路由 fork 子代理合成 id 前缀；缺省 'route'）。 */
  readonly stepId?: string;
}

/** 一次分支评估的最终结果。 */
export interface BranchEvalResult {
  /** 聚合输出文本（AI 会话输出或 shell stdout）。 */
  readonly output: string;
  /** fork 会话标识（fork 成功）或临时 eval-xxxx（降级）；shell 分支为 null。 */
  readonly sessionHandle: TempSessionHandle | null;
}

/** 两阶段评估的中间态：`start` 产生、`collect` 消费。 */
export interface BranchEvalPartial {
  /** fork 会话标识（fork 成功）或临时 eval-xxxx（降级）；shell 分支为 null。 */
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

/** 条件分支 AI 评估解析失败重试上限（首次评估 + 最多 N 次 follow-up 纠正重试）。 */
const MAX_BRANCH_EVAL_RETRIES = 2;

/** 重试时附给 AI 的纠正提示（要求仅返回合法 shouldExecute JSON）。 */
const SHOULD_EXECUTE_CORRECTION_HINT =
  '未能从你的上一轮输出中解析出 shouldExecute 布尔值，请仅返回 JSON：{"shouldExecute": true} 或 {"shouldExecute": false}。';

/**
 * 构建结构化分支评估提示词（主头部 + 任务 + 候选分支 + 返回格式 + 红线规则）。
 *
 * **fork-based 改造（缺陷 2）**：删除原「### 前置上下文」节——判断走 fork 全量历史注入
 * （`forkStepSessionMessages`），AI 在 fork 会话上即可见全部上下文，不再手动拼 I/O 文本。
 */
function buildBranchPrompt(taskText: string, branches: readonly DagBranch[]): string {
  const sections: string[] = [BRANCH_PROMPT_HEADER];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(taskText);
  sections.push('');
  sections.push('## 候选分支');
  if (branches.length === 0) {
    sections.push('（无显式分支，请依据任务判断返回 shouldExecute）');
  }
  for (const branch of branches) {
    const label = branch.label ?? branch.next;
    sections.push(`- ${label}`);
  }
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否执行当前候选分支。');
  sections.push('');
  sections.push('## 红线规则');
  for (const rule of BRANCH_RED_LINES) {
    sections.push(`- ${rule}`);
  }
  return sections.join('\n');
}

/** 循环跳出专用提示词主头部（缺陷 4：不复用条件分支 shouldExecute 模板）。 */
const BREAK_PROMPT_HEADER =
  '你是严谨准确的循环跳出判断Agent，你的任务是根据用户配置的跳出条件与当前循环体的输入输出，判断是否应该跳出当前循环。';

/** 循环跳出红线规则（只读、禁止文件改动与过度思考、未完成不擅自跳出）。 */
const BREAK_RED_LINES = [
  '禁止编辑、创建或删除任何文件',
  '禁止过度思考，你的职责是尽快判断是否跳出并返回结果',
  '如果当前循环体实际未完成目标，禁止擅自判定跳出',
] as const;

/**
 * 构建循环跳出专用 shouldBreak 提示词（主头部 + 任务 + 返回格式 + 红线规则）。
 *
 * **fork-based 改造（缺陷 4）**：删除原「## 当前循环体的输入输出」节——判断走 fork 全量
 * 历史注入（`forkStepSessionMessages`），AI 在 fork 会话上即可见循环体全部 I/O，不再手动
 * 拼 I/O 块（推翻原 `buildLoopBreakContext`/`buildBreakContextMessage` 的 I/O 传参方案）。
 *
 * **缺陷 4/2 分场景字段**：循环跳出要求返回 `{"shouldBreak": true/false}`，与
 * {@link extractBreakResult} 的 shouldBreak 解析对齐；**不复用**条件分支
 * {@link buildBranchPrompt} 的 shouldExecute 模板——两者分场景字段互不复用。
 */
function buildBreakPrompt(taskText: string): string {
  const sections: string[] = [BREAK_PROMPT_HEADER];
  sections.push('');
  sections.push('## 你的任务');
  sections.push(taskText);
  sections.push('');
  sections.push('## 返回格式');
  sections.push('请仅返回 JSON，格式为：{"shouldBreak": true} 或 {"shouldBreak": false}，其中 shouldBreak 表示是否应该跳出当前循环。');
  sections.push('');
  sections.push('## 红线规则');
  for (const rule of BREAK_RED_LINES) {
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

/**
 * 两层解析条件分支 shouldExecute 布尔（public）。
 *
 * ① JSON 解析取 `shouldExecute`（布尔直接返回；字符串 `"true"`/`"false"` 大小写
 * 不敏感转布尔）；② regex 回退 `/\{"shouldExecute"\s*:\s*(true|false)/i`（匹配后
 * 转小写判定）。两层均不满足返回 undefined（解析失败，触发
 * {@link BranchEvaluator.evaluateCondition} 重试或由调用方按 false 处理）。
 * **仅条件分支使用**——循环跳出走 {@link extractBreakResult} 的 shouldBreak 字段，
 * 两者分场景字段互不复用。
 */
export function extractShouldExecute(raw: string): boolean | undefined {
  const parsed = parseJsonObject(raw);
  if (parsed !== undefined) {
    const shouldExecute = parsed['shouldExecute'];
    if (typeof shouldExecute === 'boolean') {
      return shouldExecute;
    }
    if (typeof shouldExecute === 'string' && /^(true|false)$/i.test(shouldExecute)) {
      return shouldExecute.toLowerCase() === 'true';
    }
  }
  const match = raw.match(/\{"shouldExecute"\s*:\s*(true|false)/i);
  const extracted = match?.[1];
  if (extracted !== undefined) {
    return extracted.toLowerCase() === 'true';
  }
  return undefined;
}

/**
 * 判定分支评估结果是否匹配 expectation。
 *
 * 语义对齐基准 `workflow-engine-helpers.matchesExpectation`：默认大小写不敏感 +
 * 包含匹配（宽松，便于迁移工作流）。需正则时用**显式定界符**——expectation 以
 * `/` 起始且以 `/` 结尾（如 `/build-[0-9]+/`）才视为正则，取中间 inner 用
 * `new RegExp(inner)` 匹配；非法正则返回 false。无定界符一律走包含匹配，此时
 * 字面量含 `.`、`\`、`%`、括号等不会被启发式误判为正则（废除旧
 * `hasRegexMetacharacters` 启发式）。expectation 为 undefined 时返回 false（守卫，
 * 避免静默变并行分支）。
 */
export function matchesExpectation(result: string, expectation: string | undefined): boolean {
  if (expectation === undefined) {
    return false;
  }
  // 显式正则：`/pattern/` 定界（首尾均为 `/` 且长度 ≥ 2）。仅此形态走正则路径。
  if (expectation.length >= 2 && expectation.startsWith('/') && expectation.endsWith('/')) {
    const inner = expectation.slice(1, -1);
    let regex: RegExp;
    try {
      regex = new RegExp(inner);
    } catch {
      return false;
    }
    return regex.test(result);
  }
  // 默认路径：大小写不敏感 + 包含匹配（与基准一致）。
  const normalizedOutput = result.trim().toLowerCase();
  const normalizedExpectation = expectation.trim().toLowerCase();
  return normalizedOutput === normalizedExpectation || normalizedOutput.includes(normalizedExpectation);
}

/** fork-based dispatch 的可选注入参数（stepSessionId + stepId + workdir + signal）。 */
interface DispatchOptions {
  readonly stepSessionId?: string;
  readonly stepId?: string;
  readonly workdir?: string;
  readonly signal?: AbortSignal;
}

/** Phase D 路由 AI 判断的解析/重试规格（条件分支与循环跳出各自提供）。 */
interface RoutingAiSpec {
  /** 输出是否满足（不再重试）。 */
  readonly isSatisfied: (output: string) => boolean;
  /** 不满足时 followup/追加的纠正提示。 */
  readonly correctionHint: string;
  /** 重试上限（首次之外最多 N 次）。 */
  readonly maxRetries: number;
  /** 重试耗尽回调（记日志等；不抛错——不满足由调用方按 false 处理）。 */
  readonly onExhausted?: (output: string) => void;
}

/** 路由 fork 子代理的 provider/model（L2 引擎默认；缺省时由宿主运行时按 parent options 解析）。 */
function routingAgentOptions(config: BranchEvaluatorConfig): AgentOptions | undefined {
  return config.defaultProvider !== undefined && config.defaultModel !== undefined
    ? { provider: config.defaultProvider, model: config.defaultModel }
    : undefined;
}

/**
 * 分支条件两阶段评估器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`start()` 按 `condition.type` 分发（shell 直接
 * 执行，其余四类走 `ctx.llm.stream()` fork 会话注入全量历史），`collect()` 聚合输出文本，
 * `evaluate()` 一步完成。AI 会话失败（error/aborted）抛 `SandoreError`。
 */
export class BranchEvaluator {
  constructor(
    private readonly ctx: Context,
    private readonly config: BranchEvaluatorConfig,
  ) {}

  /** 启动评估，返回中间态；AI 会话带 sessionHandle（fork id 或降级 eval-xxxx），shell 直接执行完成。 */
  async start(condition: CommandConfig, options: BranchEvalOptions = {}): Promise<BranchEvalPartial> {
    switch (condition.type) {
      case 'shell':
        return await this.startShell(condition, options);
      case 'agent':
      case 'prompt':
      case 'skill':
      case 'mcp':
        return await this.startAi(condition, options);
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
  async evaluate(condition: CommandConfig, options: BranchEvalOptions = {}): Promise<BranchEvalResult> {
    const partial = await this.start(condition, options);
    return await this.collect(partial);
  }

  /**
   * 启动循环跳出评估：shell 直接执行（不消费 I/O 上下文），AI 四类走 fork 会话注入全量历史
   * + 专用 shouldBreak 模板（缺陷 4，不复用条件分支 shouldExecute 模板，不手动传 I/O）。
   */
  async startBreak(condition: CommandConfig, options: BranchEvalOptions = {}): Promise<BranchEvalPartial> {
    switch (condition.type) {
      case 'shell':
        return await this.startShell(condition, options);
      case 'agent':
      case 'prompt':
      case 'skill':
      case 'mcp':
        return await this.startBreakAi(condition, options);
      default:
        // 穷尽 5 类型后 `condition` 已收窄为 never；此处仅防御运行期注入的未知命令类型。
        throw new SandoreError(
          `unsupported branch condition type '${(condition as CommandConfig).type}'`,
          'STEP_EXECUTION',
        );
    }
  }

  /**
   * 循环跳出一步完成两阶段评估（专用 shouldBreak 模板，单轮，无重试）。
   *
   * shell breakCondition 直接执行命令（不消费 I/O 上下文，decideBreak 走
   * matchesExpectation）；AI breakCondition fork step 会话注入全量历史后发送 shouldBreak
   * 模板提示词，由 {@link extractBreakResult} 解析 shouldBreak（与提示词格式对齐，消除缺陷 2/4
   * 指出的「buildBranchPrompt 要求 shouldExecute 而 decideBreak 解析 shouldBreak」
   * 字段错配）。仅循环跳出使用——条件分支仍走 {@link evaluate}/
   * {@link evaluateCondition} 的 shouldExecute 路径。
   */
  async evaluateBreak(condition: CommandConfig, options: BranchEvalOptions = {}): Promise<BranchEvalResult> {
    const partial = await this.startBreak(condition, options);
    return await this.collect(partial);
  }

  /**
   * 条件分支评估（带解析失败重试，Phase D 路由 fork 子代理机制）。
   *
   * shell 条件直接委托 {@link evaluate}（走 matchesExpectation，无重试）；AI 条件
   * （agent/prompt/skill/mcp）经 {@link runRoutingAi} 用 fork 子代理机制（`agents.create`
   * + seed 完整事件 + followup + whenIdle + finalAssistantOutput + dispose）重建宿主子
   * 代理跑判断，首轮发送分支评估提示词，若 {@link extractShouldExecute} 解析失败
   * （undefined），则给**同一个 fork 子代理** `followup` 纠正提示重新返回，最多重试
   * {@link MAX_BRANCH_EVAL_RETRIES} 次；重试耗尽记日志（条件不通过由调用方
   * decideCondition 的 `extractShouldExecute === true` 判定兜底为 false）。fork 失败
   * 降级 `llm.stream` 临时会话（单条判断提示词 + messages 追加重试）。仅条件分支使用——
   * 循环跳出仍走 {@link evaluateBreak} + extractBreakResult（shouldBreak 字段，缺陷 4 范畴）。
   */
  async evaluateCondition(
    condition: CommandConfig,
    options: BranchEvalOptions = {},
  ): Promise<BranchEvalResult> {
    if (condition.type === 'shell') {
      return this.evaluate(condition, options);
    }
    const route = await this.resolveProviderModel(condition.value);
    const taskText = replacePassThroughVars(
      condition.value.promptText,
      resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations),
    );
    const promptText = buildBranchPrompt(taskText, options.branches ?? []);
    return this.runRoutingAi(route, promptText, options, {
      isSatisfied: output => extractShouldExecute(output) !== undefined,
      correctionHint: SHOULD_EXECUTE_CORRECTION_HINT,
      maxRetries: MAX_BRANCH_EVAL_RETRIES,
      onExhausted: output => {
        this.ctx.logger.warn(
          `sandore: branch condition shouldExecute unparseable after ${MAX_BRANCH_EVAL_RETRIES} retry attempt(s); last output: ${output.slice(0, 200)}`,
        );
      },
    });
  }

  /**
   * Phase D 路由判断（条件分支 / 循环跳出共用的 AI 判断驱动）。
   *
   * **fork 子代理机制**：经 {@link forkStepSubagent} 从 step 子代理完整事件（live →
   * persistence 回退）截到闭合 turn 作 seed，`agents.create` 重建宿主主代理的子代理 →
   * `followup(promptText)` → `whenIdle()` → `finalAssistantOutput` → 输出文本；`isSatisfied`
   * 不满足时给**同一个 fork 子代理** `followup(correctionHint)` 重试（上限 maxRetries）；
   * 评估完 `dispose()`（live 移除、持久化保留，UI 可经 branchMeta/loopMeta.sessionId 打开）。
   * `sessionHandle` = 路由子代理 id。
   *
   * **降级（不失败）**：配置缺省 / 事件源缺失 / 无闭合 turn / `agents.create` 抛错 →
   * `llm.stream` 临时会话（单条判断提示词，不传历史）+ messages 追加同样重试；
   * `sessionHandle` = eval- 句柄。
   */
  private async runRoutingAi(
    route: { provider: string; model: string },
    promptText: string,
    options: BranchEvalOptions,
    spec: RoutingAiSpec,
  ): Promise<BranchEvalResult> {
    const hostAgentId = this.config.hostAgentId;
    const createAgent = this.config.createAgent;
    const agentOptions = routingAgentOptions(this.config);
    if (hostAgentId !== undefined && createAgent !== undefined) {
      try {
        const forked = await forkStepSubagent(this.ctx, options.stepSessionId, {
          hostAgentId,
          stepId: options.stepId ?? 'route',
          ...(options.workdir === undefined ? {} : { cwd: options.workdir }),
          ...(this.config.getStepSessionEvents === undefined ? {} : { getEvents: this.config.getStepSessionEvents }),
          createAgent,
          ...(agentOptions === undefined ? {} : { agentOptions }),
        });
        if (forked !== undefined) {
          const { handle } = forked;
          try {
            let output = await driveAgentRound(handle, promptText);
            let attempts = 0;
            while (!spec.isSatisfied(output) && attempts < spec.maxRetries) {
              attempts += 1;
              output = await driveAgentRound(handle, spec.correctionHint);
            }
            if (!spec.isSatisfied(output)) {
              spec.onExhausted?.(output);
            }
            return { output, sessionHandle: handle.agent.id };
          } finally {
            // 评估完 dispose：live 移除、持久化记录保留（UI 可经 branchMeta/loopMeta.sessionId 打开）。
            await handle.dispose();
          }
        }
      } catch {
        // fork 失败 → 降级 llm.stream 临时会话（下方）。
      }
    }
    // 降级：一次性临时会话（无历史）+ messages 追加同样重试。
    const messages: Message[] = [createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: promptText }],
    })];
    let output = await this.streamAi(route, messages, options.signal);
    let attempts = 0;
    while (!spec.isSatisfied(output) && attempts < spec.maxRetries) {
      attempts += 1;
      messages.push(
        createAssistantMessage({
          content: [{ type: 'text', text: output }],
          source: { provider: route.provider, model: route.model },
        }),
      );
      messages.push(
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: spec.correctionHint }],
        }),
      );
      output = await this.streamAi(route, messages, options.signal);
    }
    if (!spec.isSatisfied(output)) {
      spec.onExhausted?.(output);
    }
    return { output, sessionHandle: this.newSessionHandle() };
  }

  private async startAi(condition: AiCommand, options: BranchEvalOptions): Promise<BranchEvalPartial> {
    const route = await this.resolveProviderModel(condition.value);
    const taskText = replacePassThroughVars(
      condition.value.promptText,
      resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations),
    );
    const promptText = buildBranchPrompt(taskText, options.branches ?? []);
    return this.dispatchAi(route, promptText, {
      ...(options.stepSessionId === undefined ? {} : { stepSessionId: options.stepSessionId }),
      ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * 循环跳出 AI 评估入口：专用 shouldBreak 模板（缺陷 4）。
   *
   * 与条件分支 {@link startAi} 共用 route 解析、透传变量替换与流式聚合，仅提示词模板
   * 不同——循环跳出要求 `{"shouldBreak": true/false}`，不复用 shouldExecute 模板；
   * 会话机制同为 Phase D 路由 fork 子代理（不手动传 I/O）。
   */
  private async startBreakAi(condition: AiCommand, options: BranchEvalOptions): Promise<BranchEvalPartial> {
    const route = await this.resolveProviderModel(condition.value);
    const taskText = replacePassThroughVars(
      condition.value.promptText,
      resolvePassThroughVars(options.passThroughVars, options.loopTurn, options.loopMaxIterations),
    );
    const promptText = buildBreakPrompt(taskText);
    return this.dispatchAi(route, promptText, {
      ...(options.stepSessionId === undefined ? {} : { stepSessionId: options.stepSessionId }),
      ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * 组装单轮 AI 判断并启动输出聚合（条件分支与循环跳出共用，Phase D 路由 fork 子代理）。
   *
   * fork step 会话注入全量历史（`forkStepSubagent`：live → persistence 回退取事件、
   * `agents.create` 重建宿主子代理）→ `followup(promptText)` 驱动一轮（`whenIdle` →
   * `finalAssistantOutput`）；fork 失败（配置缺省/合成 session/非 live/无事件源）降级为
   * 一次性临时会话（`llm.stream` 单条判断提示词）。`sessionHandle` = 路由子代理 id
   * （fork 成功）或临时 eval-xxxx（降级）。
   */
  private async dispatchAi(
    route: { provider: string; model: string },
    promptText: string,
    options: DispatchOptions,
  ): Promise<BranchEvalPartial> {
    const hostAgentId = this.config.hostAgentId;
    const createAgent = this.config.createAgent;
    const agentOptions = routingAgentOptions(this.config);
    if (hostAgentId !== undefined && createAgent !== undefined) {
      try {
        const forked = await forkStepSubagent(this.ctx, options.stepSessionId, {
          hostAgentId,
          stepId: options.stepId ?? 'route',
          ...(options.workdir === undefined ? {} : { cwd: options.workdir }),
          ...(this.config.getStepSessionEvents === undefined ? {} : { getEvents: this.config.getStepSessionEvents }),
          createAgent,
          ...(agentOptions === undefined ? {} : { agentOptions }),
        });
        if (forked !== undefined) {
          const { handle } = forked;
          // 两阶段接口：sessionHandle 同步为路由子代理 id，输出聚合异步驱动 + dispose。
          return {
            sessionHandle: handle.agent.id,
            outputPromise: (async () => {
              try {
                return await driveAgentRound(handle, promptText);
              } finally {
                await handle.dispose();
              }
            })(),
          };
        }
      } catch {
        // fork 失败 → 降级 llm.stream 临时会话（下方）。
      }
    }
    // 降级：一次性临时会话（无历史）。
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: promptText }],
    });
    return {
      sessionHandle: this.newSessionHandle(),
      outputPromise: this.streamAi(route, [message], options.signal),
    };
  }

  /** 单轮 AI 会话流式评估：聚合输出文本；error/aborted 抛 SandoreError。 */
  private async streamAi(
    route: { provider: string; model: string },
    messages: Message[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const generateOptions: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages,
      ...(signal === undefined ? {} : { signal }),
    };
    const assembler = new BlockAssembler();
    const stream = this.ctx.llm.stream(generateOptions);
    return this.aggregate(stream, assembler);
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
    // 统一经 `ctx.shell`（平台 shell 解释器）执行：env/stdin 由 ShellExecRequest
    // 携带。不要用 `ctx.subprocess.spawn` 直接执行——subprocess 不做 shell 解释，
    // PowerShell cmdlet 等内建命令不是可执行文件，条件命令会失败。
    const request: ShellExecRequest = {
      command,
      timeoutMs: this.config.defaultTimeoutMs,
      ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(env === undefined ? {} : { env }),
    };
    const spec = this.ctx.shell.resolve(request);
    const result = await this.ctx.shell.run(spec);
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

  /** 生成临时会话标识（纯 UUID 格式；fork 降级时用）。 */
  private newSessionHandle(): TempSessionHandle {
    return globalThis.crypto.randomUUID();
  }

  /** provider/model 三层回退：条件定义 → 引擎配置 → ctx.llm 目录兜底。 */
  private async resolveProviderModel(value: AiValue): Promise<{ provider: string; model: string }> {
    return resolveModelRoute(value, this.config, this.ctx.llm);
  }
}
