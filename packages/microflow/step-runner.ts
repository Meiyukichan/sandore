/**
 * 单 Step 执行器（shell / prompt / agent / skill / mcp）。
 *
 * shell Step 走 `ctx.shell.resolve(request)` → `ctx.shell.run(spec)`（简单命令，
 * 无 stdin/env 注入需求）；存在 stdin（`inputFrom` 解析到内容）或非空透传变量
 * 注入需求时改走 `ctx.subprocess.spawn()`（`stdin: { data }` 写 JSON、`env` 合并）。
 * prompt/agent/skill/mcp 四类 AI 会话统一走可续接子代理（设计决策 D3：
 * `ctx.subagents.startContinuable` → `ctx.agents.get(childId)` → settle
 * （`awaitSubagentSettlement` 对齐 DSH `subagent/end`）→ final output）——prompt
 * 与 agent/skill/mcp 行为对齐（真实子代理会话：可暂停/恢复/重试/会话可点；提问经
 * 全局注册的 `sandore_ask_user_question` 工具（execute 期 gate 仅放行 sandore
 * 子代理），见 workflow/ask-tool.ts）。
 * agent 定义 `agentParamsTemplate` 时先 `fillParams` 临时会话填充
 * 「### 当前Step参数」子节。所有提示词/命令构建前先 `replacePassThroughVars`
 * 替换 `${xxx}` 透传变量（含循环上下文变量）。
 * @module @meiyukichan/dsh-sandore/microflow/src/step-runner
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import { SandoreError } from './errors.ts';
import { idMatches, replacePassThroughVars } from './file-utils.ts';
import {
  buildShellEnv,
  describeError,
  escapeXml,
  escapeXmlAttr,
  resolvePassThroughVars,
  resolveProviderModel as resolveModelRoute,
  textSummary,
} from './internal.ts';
import { finalAssistantOutput, collectSessionMessages } from './subagents.ts';
import { sessionEventList } from './session-events.ts';
import type { Agent, SubagentSettlement } from './subagents.ts';
import type { CommandConfig, SessionMessage, WorkflowStep } from '../workflow/schema';
import { resolveHostSandboxPolicy } from '../workflow/shell';
import type { ShellExecRequest, ShellRunResult } from '../workflow/shell';

type ShellCommand = Extract<CommandConfig, { type: 'shell' }>;
type PromptCommand = Extract<CommandConfig, { type: 'prompt' }>;
type AgentCommand = Extract<CommandConfig, { type: 'agent' }>;
type SkillCommand = Extract<CommandConfig, { type: 'skill' }>;
type McpCommand = Extract<CommandConfig, { type: 'mcp' }>;

/** 走可续接子代理的命令类型（agent/skill/mcp/prompt；仅 shell 除外）。 */
type SubagentCommand = AgentCommand | SkillCommand | McpCommand;

/** 可续接子代理命令的 type 判别值（`collectSubagentOutput`/`resumeSubagent` 的 commandType 取值域）。 */
type SubagentCommandType = 'agent' | 'skill' | 'mcp' | 'prompt';

/** prompt/agent/skill/mcp 四种命令的 value（provider/model 三层回退的取值域）。 */
type ModelRoutedValue =
  | PromptCommand['value']
  | AgentCommand['value']
  | SkillCommand['value']
  | McpCommand['value'];

/** StepRunner 的引擎级配置（provider/model 三层回退的 L2 来源 + 名称校验数据源）。 */
export interface StepRunnerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  /**
   * 可续接子代理的 DSH subagent provider 注册名（`startContinuable` 的 `provider`
   * 参数），与模型路由解耦：子代理的模型路由经 `request.agentOptions`
   * （`{ provider, model }`）承载（DSH `continuation.ts` 以
   * `request.agentOptions?.provider ?? parent.options.provider` 解析）。DSH 默认
   * bundle 已注册 `fork`（`subagent-fork-in-process`，支持 continuable：
   * prepareContinuable + startContinuable + followup + interrupt + cold resume），
   * 缺省即 `'fork'`，运行 agent/prompt/skill/mcp Step **无需任何额外 subagent
   * provider 配置**。如需换用其他已注册 provider（如 `'spawn'`）可在此覆盖。
   * **注意：模型 provider id（如 `xiaomi-token-plan-cn`）绝不能填到这里**——DSH 只
   * 认注册的 subagent provider 名，否则运行时报
   * `no subagent provider registered for "<model provider id>"`。
   */
  readonly subagentProvider?: string;
  /** 工作流级 skills 名称数组（skill 类型名称校验数据源）。 */
  readonly skills?: readonly string[];
  /** 工作流级 mcps 名称数组（mcp 类型名称校验数据源）。 */
  readonly mcps?: readonly string[];
  /** 工作流级 agents 名称数组（agent 类型名称校验数据源）。 */
  readonly agents?: readonly string[];
  /** 宿主主代理（子代理 parent）；缺省时使用最小桩对象。 */
  readonly hostAgent?: Agent;
  /**
   * 子代理真实 childId 就绪回调（由 workflow 层注入）：`startContinuable` 返回后、
   * settle 等待前调用，把真实子代理 SessionId 上抛给引擎（供暂停反查 childId）。
   * 返回 Promise 时 runner 会 await（引擎借此把真实 childId 落盘后再继续）。
   */
  readonly onChildStarted?: (stepId: string, childId: string) => void | Promise<void>;
  /**
   * 子代理 settle 终态等待回调（由 workflow 层注入，对齐 DSH `subagent/end`）。
   *
   * 传入子代理 SessionId 与取消信号，resolve 为该子代理的 settle 终态结算信号
   * （{@link SubagentSettlement}：stopReason + 可选 output）。DSH continuable 子代理
   * 「完成 = settle」：interrupt → settle(`aborted`)；自然完成 → settle(`completed`)；
   * 模型/传输失败 → `error`。引擎实现经 `sandore/subagent-settled` 事件路由
   * （DSH 适配层把 `subagent/end` 转译为该事件）。
   *
   * 缺省（未注入）时回退 `whenIdle()` + `finalAssistantOutput()`（兼容无注入场景，
   * 如最小桩/不测 settle 的单测——此回退路径无法区分 abort，不适用于暂停语义）。
   */
  readonly awaitSubagentSettlement?: (childId: string, signal: AbortSignal) => Promise<SubagentSettlement>;
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
  /** 执行段唯一 id（executed.id，纯 UUID）；区别于 `step.stepId`（定义 id）——提示词 title 展示用执行段 id。 */
  readonly executedId: string;
  readonly workdir: string;
  readonly originalInput: string;
  readonly previousOutputs: readonly PreviousStepOutput[];
  /** 所属 Stage id（子代理 ask 转接回调的定位字段）。 */
  readonly stageId: string;
  readonly signal?: AbortSignal;
  /** 当前透传变量（键为变量名，值为已解析字符串）。 */
  readonly passThroughVars?: Readonly<Record<string, string>>;
  /** 当前循环迭代序号（1-based；不在循环中缺省视为 0）。 */
  readonly loopTurn?: number;
  /** 活跃循环 `maxIterations`（不在循环中缺省视为 0）。 */
  readonly loopMaxIterations?: number;
  /**
   * 当前 Step 解析后的任务规则（缺陷 7 修复：3 级合并 step ∪ stage → workflow.rules
   * 查内容；由 {@link resolveStepRules} 在 {@link StageExecutor.processCommandNode}
   * 计算）。非空时注入提示词 `## 任务规则` 节，prompt/agent/skill/mcp 四路 AI 提示词
   * 同时生效；shell Step 无 AI 提示词不适用。缺省（无规则）时不注入该节。
   */
  readonly resolvedRules?: Readonly<Record<string, string>>;
}

/** 单 Step 执行结果附带的会话元数据（prompt/agent/skill/mcp 返回真实 childId）。 */
export interface StepRunSessionMeta {
  readonly childId?: string;
  readonly synthetic: boolean;
  readonly command: CommandConfig['type'];
}

/** 单 Step 执行结果（成功时的输出块）。 */
export interface StepRunResult {
  readonly output: ContentBlock[];
  readonly sessionMeta?: StepRunSessionMeta;
  /** 子代理会话消息行（§3.8A：真实子代理采集，随结果带出写 `executed.sessionMessages`）。 */
  readonly sessionMessages?: SessionMessage[];
}

/** 结构化提示词主头部（v6：行动引导 + 职责三点；无角色声明、无行为要求、无输出格式要求）。 */
const PROMPT_MAIN_HEADER = [
  '你正在执行工作流中的一个 Step。必须先明确以下三点，再开始执行：',
  '- `## 用户指令` —— 用户提供的当前任务指令，是本次 Step 要达成的**唯一验收目标**。',
  '- `## 任务规则` —— 用户配置的约束，执行时**不得违反**。',
  '- `## 参考信息` —— 执行上下文，按需查阅。',
].join('\n');

/** fillParams 临时会话的任务指令。 */
const FILL_PARAMS_TASK =
  '你的唯一任务是根据这个参数模板，然后根据（## 输入信息）中的信息，\n或者你可以进行一定程度的探索后，将参数模板的内容按照模板格式填充后返回这个结果！';

/** fillParams 临时会话的红线规则（只读，禁止文件改动与过度探索）。 */
const FILL_PARAMS_RED_LINES = [
  '禁止编辑或者创建或者删除任何文件',
  '禁止过度探索，你的任务是根据已有信息，做足够探索后尽快返回这个参数模板结果',
  '不要过度思考，你的职责不是设计或者开发',
] as const;

/** 构造缺省 hostAgent 时的最小 parent 桩（每次返回新对象，避免跨 run 共享可变 `session.events`）。 */
function createHostAgentStub(): Agent {
  return {
    id: 'sandore-host',
    options: {},
    session: { events: [] },
    inbox: { hasPending: false },
    status: 'idle',
    ctx: undefined,
    followup: () => {},
    whenIdle: async () => {},
  };
}

/** 多行文本每行前加 N 空格缩进（XML 块内内容对齐）。 */
function indentLines(text: string, spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => `${prefix}${line}`);
}

/**
 * 渲染「前置 Steps 输出和产物」XML 块（v6：`<Reference title="前置Step: {{name}} (id: {{id}}) 的输出和产物">`，
 * 内容为 `<Output>` + `<Artifacts>`，全部转义；无前置输出返回空）。
 */
function renderPreviousOutputs(previousOutputs: readonly PreviousStepOutput[]): string[] {
  if (previousOutputs.length === 0) {
    return [];
  }
  const sections: string[] = [];
  for (const previous of previousOutputs) {
    const name = escapeXmlAttr(previous.name);
    const id = escapeXmlAttr(previous.id);
    sections.push(`  <Reference title="前置Step: ${name} (id: ${id}) 的输出和产物">`);
    sections.push('    <Output>');
    sections.push(...indentLines(escapeXml(previous.returnPrompt), 6));
    sections.push('    </Output>');
    sections.push('    <Artifacts>');
    for (const file of previous.files) {
      sections.push(`      <Artifact>${escapeXml(file)}</Artifact>`);
    }
    sections.push('    </Artifacts>');
    sections.push('  </Reference>');
    sections.push('');
  }
  return sections;
}

/** 命中名称数组时加前缀，未命中回退纯提示词。 */
function prefixIfAllowed(resolved: string, prefix: string, name: string, allowed: readonly string[] | undefined): string {
  if (allowed !== undefined && allowed.includes(name)) {
    return `${prefix}${resolved}`;
  }
  return resolved;
}

/** 按命令类型构建「## 你的任务」内容（透传变量替换 + 名称校验前缀）。 */
function buildTaskText(
  command: SubagentCommand | PromptCommand,
  vars: Readonly<Record<string, string>>,
  skills: readonly string[] | undefined,
  mcps: readonly string[] | undefined,
  agents: readonly string[] | undefined,
): string {
  const name = command.value.promptText;
  const resolved = replacePassThroughVars(name, vars);
  switch (command.type) {
    case 'agent':
      return prefixIfAllowed(resolved, '使用 Agent：', name, agents);
    case 'skill':
      return prefixIfAllowed(resolved, '使用 skill：', name, skills);
    case 'mcp':
      return prefixIfAllowed(resolved, '使用 MCP：', name, mcps);
    default:
      return resolved;
  }
}

/**
 * 构建结构化提示词（v6：头部三点 + `## 用户指令`（`<UserInstruction>` XML 隔离 + 转义）
 * + 可选 `## 任务规则` + `## 参考信息`（`<ReferenceInfo>`：当前 Step 身份块（含可选
 * `<Params>`）+ 整体目标块 + 前置输出和产物块）。
 *
 * 双通道 ask 重构后不再注入「向用户提问」引导节（`[[SANDORE_ASK]]` 标记块机制已删）：
 * 子代理提问走全局注册的 `sandore_ask_user_question` 工具（execute 期 gate 仅放行
 * sandore 子代理，见 workflow/ask-tool.ts），prompt/agent/skill/mcp 四路 AI 提示词
 * 共用本函数。
 *
 * `## 任务规则` 节置于参考信息**之前**（与头部三点顺序一致：用户指令 → 任务规则 →
 * 参考信息）；仅当 `resolvedRules` 非空时渲染，逐键输出 `- **{key}**: {content}`。
 *
 * 所有 XML 内容统一转义（`escapeXml`，含 `<UserInstruction>`）；title 属性值用
 * `escapeXmlAttr`。`<UserInstruction>` 内容为 `buildTaskText` 输出（agent/skill/mcp
 * 名称命中定义数组时带「使用 Agent：/使用 skill：/使用 MCP：」前缀，防纯名称歧义）。
 */
function buildPromptText(
  taskText: string,
  stepName: string,
  executedId: string,
  originalInput: string,
  previousOutputs: readonly PreviousStepOutput[],
  paramsText: string | undefined,
  resolvedRules?: Readonly<Record<string, string>>,
): string {
  const sections: string[] = [];
  sections.push(PROMPT_MAIN_HEADER);
  sections.push('');
  sections.push('## 用户指令');
  sections.push('<UserInstruction>');
  sections.push(escapeXml(taskText));
  sections.push('</UserInstruction>');
  // `## 任务规则`（可选）——置于参考信息之前，与头部三点顺序一致。
  if (resolvedRules !== undefined) {
    const ruleKeys = Object.keys(resolvedRules);
    if (ruleKeys.length > 0) {
      sections.push('');
      sections.push('## 任务规则');
      for (const key of ruleKeys) {
        sections.push(`- **${key}**: ${resolvedRules[key]}`);
      }
    }
  }
  sections.push('');
  sections.push('## 参考信息');
  sections.push('<ReferenceInfo>');
  // 当前 Step 身份块（含可选 <Params> 子标签；无参数时为空块锚点）。
  // id 展示执行段 id（executed.id，本次执行唯一），非定义 stepId。
  const stepNameEscaped = escapeXmlAttr(stepName);
  const executedIdEscaped = escapeXmlAttr(executedId);
  if (paramsText === undefined) {
    sections.push(`  <Reference title="你正在执行的Step: ${stepNameEscaped} (id: ${executedIdEscaped})"></Reference>`);
  } else {
    sections.push(`  <Reference title="你正在执行的Step: ${stepNameEscaped} (id: ${executedIdEscaped})">`);
    sections.push('    <Params>');
    sections.push(...indentLines(escapeXml(paramsText), 6));
    sections.push('    </Params>');
    sections.push('  </Reference>');
  }
  sections.push('');
  // 用户原始需求（整个工作流的整体目标）。
  sections.push('  <Reference title="用户原始需求（整个工作流的整体目标）">');
  sections.push(...indentLines(escapeXml(originalInput), 4));
  sections.push('  </Reference>');
  // 前置 Steps 输出和产物（可选，每个前置一块）。
  sections.push(...renderPreviousOutputs(previousOutputs));
  sections.push('</ReferenceInfo>');
  return sections.join('\n');
}

/** 构建 fillParams 临时会话提示词（输入信息 + 参数模板 + 任务指令 + 红线规则）。 */
function buildFillParamsPrompt(
  originalInput: string,
  previousOutputs: readonly PreviousStepOutput[],
  template: string,
): string {
  const sections: string[] = [];
  sections.push('## 输入信息');
  sections.push('### 用户原始需求');
  sections.push(originalInput);
  sections.push(...renderPreviousOutputs(previousOutputs));
  sections.push('');
  sections.push('## 参数模板');
  sections.push(template);
  sections.push('');
  sections.push('## 你的任务');
  sections.push(FILL_PARAMS_TASK);
  sections.push('');
  sections.push('## 红线规则');
  for (const rule of FILL_PARAMS_RED_LINES) {
    sections.push(`- ${rule}`);
  }
  return sections.join('\n');
}

/** 从 `inputFrom` 的 `path` 取 Step id（简化格式：path 直接为 stepId，单段）。 */
function stepIdFromPath(path: string): string {
  return path;
}

/**
 * 按 `step.inputFrom` 过滤前置输出（v6 修复：prompt 提示词只注入**声明的依赖**，
 * 对齐 `resolveShellStdin` 的匹配语义——此前全量注入导致「配置只依赖 sce1 却显示
 * 所有前置 step 输出」）。
 *
 * - `inputFrom` 未配置/为空 → 返回全量（向后兼容：未声明依赖的工作流仍可引用全部前置）。
 * - 配置后按 `path`（stepId 匹配 `idMatches`）/ `regex`（returnPrompt 匹配）筛选；
 *   循环/重试多段同 stepId 时**按 id 去重、只保留最近一段**（数组序 = 完成顺序）。
 */
function filterPreviousOutputs(
  step: WorkflowStep,
  previousOutputs: readonly PreviousStepOutput[],
): readonly PreviousStepOutput[] {
  const inputFrom = step.inputFrom;
  if (inputFrom === undefined || inputFrom.length === 0) {
    return previousOutputs;
  }
  const matched: PreviousStepOutput[] = [];
  for (const item of inputFrom) {
    if (item.regex !== undefined) {
      let regex: RegExp;
      try {
        regex = new RegExp(item.regex);
      } catch {
        continue;
      }
      for (const previous of previousOutputs) {
        if (regex.test(previous.returnPrompt)) {
          matched.push(previous);
        }
      }
    } else if (item.path !== undefined) {
      const stepId = stepIdFromPath(item.path);
      for (const previous of previousOutputs) {
        if (idMatches(previous.id, stepId)) {
          matched.push(previous);
        }
      }
    }
  }
  // 按 id 去重、保留最近一段（数组序 = 完成顺序，最后一段为最新）。
  const seen = new Set<string>();
  const result: PreviousStepOutput[] = [];
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const previous = matched[index]!;
    if (!seen.has(previous.id)) {
      seen.add(previous.id);
      result.unshift(previous);
    }
  }
  return result;
}

/** 解析 shell Step 的 stdin：`inputFrom` 命中前置输出时返回 JSON 序列化，否则 undefined。 */
function resolveShellStdin(step: WorkflowStep, previousOutputs: readonly PreviousStepOutput[]): string | undefined {
  const inputFrom = step.inputFrom;
  if (inputFrom === undefined || inputFrom.length === 0) {
    return undefined;
  }
  const matched: PreviousStepOutput[] = [];
  for (const item of inputFrom) {
    if (item.regex !== undefined) {
      let regex: RegExp;
      try {
        regex = new RegExp(item.regex);
      } catch {
        continue;
      }
      for (const previous of previousOutputs) {
        if (regex.test(previous.returnPrompt)) {
          matched.push(previous);
        }
      }
    } else if (item.path !== undefined) {
      const stepId = stepIdFromPath(item.path);
      for (const previous of previousOutputs) {
        if (idMatches(previous.id, stepId)) {
          matched.push(previous);
        }
      }
    }
  }
  if (matched.length === 0) {
    return undefined;
  }
  return JSON.stringify(matched);
}

/**
 * 单 Step 执行器。
 *
 * 构造时绑定 `ctx` 与引擎级配置；`run()` 按 `step.command.type` 分发到
 * shell 与 prompt/agent/skill/mcp 两条路径（决策 D3：除 shell 外全部经可续接子代理）。
 * 成功返回 `{ output: ContentBlock[] }`，失败抛 `SandoreError`
 * （超时 → `STEP_TIMEOUT`，其余 → `STEP_EXECUTION`）。
 */
export class StepRunner {
  /**
   * 可续接子代理的 DSH subagent provider 注册名（见
   * {@link StepRunnerConfig.subagentProvider}）；缺省 `'fork'`（DSH base bundle 已注册）。
   */
  private readonly subagentProvider: string;

  constructor(
    private readonly ctx: Context,
    private readonly config: StepRunnerConfig,
  ) {
    // 方案 2：复用 DSH 默认 fork subagent provider（支持 continuable），provider 参数
    // 与模型路由解耦——模型路由经 request.agentOptions 传给子代理。缺省 'fork' 即满足
    // agent/prompt/skill/mcp Step，无需任何额外 subagent provider 配置。
    this.subagentProvider = config.subagentProvider ?? 'fork';
  }

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
      case 'agent':
      case 'skill':
      case 'mcp':
        // 设计决策 D3：除 shell 外，prompt/agent/skill/mcp 全部经可续接子代理
        // （`startContinuable`）运行——prompt 与 agent/skill/mcp 行为对齐。
        return await this.runSubagent(command, request);
      default:
        // 穷尽 5 类型后 `command` 已收窄为 never；此处仅防御运行期注入的未知命令类型。
        throw new SandoreError(
          `unsupported step command type '${(command as CommandConfig).type}'`,
          'STEP_EXECUTION',
        );
    }
  }

  private async runShell(command: ShellCommand, request: StepRunRequest): Promise<StepRunResult> {
    const resolvedCommand = replacePassThroughVars(
      command.value.command,
      resolvePassThroughVars(request.passThroughVars, request.loopTurn, request.loopMaxIterations),
    );
    const stdin = resolveShellStdin(request.step, request.previousOutputs);
    const env = buildShellEnv(request.passThroughVars, request.loopTurn, request.loopMaxIterations);
    // 统一经 `ctx.shell`（平台 shell 解释器，如 PowerShell/bash）执行：env/stdin
    // 由 ShellExecRequest 携带。不要在这里改用 `ctx.subprocess.spawn` 直接执行
    // 命令——subprocess 不做 shell 解释，PowerShell cmdlet（New-Item 等）不是可
    // 执行文件，带透传变量/inputFrom 的 shell 步骤会失败。
    return await this.runShellSimple(resolvedCommand, request, stdin, env);
  }

  private async runShellSimple(
    command: string,
    request: StepRunRequest,
    stdin: string | undefined = undefined,
    env: Record<string, string> | undefined = undefined,
  ): Promise<StepRunResult> {
    // 携带宿主会话的 per-call sandbox 策略（workspace = 会话 cwd）：直接调用
    // 不传策略时执行器回落 deployment 默认（启动目录，主目录启动会触发 Windows
    // ACL 临时目录边界冲突）。
    const sandboxPolicy = resolveHostSandboxPolicy(this.ctx, this.config.hostAgent?.session);
    const shellRequest: ShellExecRequest = {
      command,
      timeoutMs: this.stepTimeoutMs(request.step),
      ...(request.workdir === undefined ? {} : { workdir: request.workdir }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(stdin === undefined ? {} : { stdin }),
      ...(env === undefined ? {} : { env }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
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

  /**
   * 经可续接子代理执行 prompt/agent/skill/mcp Step（设计决策 D3：AI 会话一律
   * `startContinuable` 真实子代理，与临时 `ctx.llm.stream()` 区分）。
   *
   * agent 定义 `agentParamsTemplate` 时先 `fillParams` 临时会话填充
   * 「### 当前Step参数」；prompt 无参数模板（paramsText 恒 undefined）。随后三层
   * provider/model 回退 → 构建结构化提示词 → `startContinuable`（parent=宿主主代理；
   * subagent provider 名与模型路由解耦——provider 参数用 DSH 注册的 `fork`，模型
   * 路由经 `request.agentOptions`）。子代理提问能力由全局注册的
   * `sandore_ask_user_question` 工具提供（execute 期 gate 仅放行 sandore 子代理，
   * 见 workflow/ask-tool.ts `registerGlobalAskTool`；`request.toolFilter` deny DSH
   * 全局版 `ask_user_question` 引导模型用 sandore 通道）→ `onChildStarted` 上抛真实
   * childId → `collectSubagentOutput` 等 settle 终态（completed/aborted/error 路由）
   * + final output。
   */
  private async runSubagent(command: SubagentCommand | PromptCommand, request: StepRunRequest): Promise<StepRunResult> {
    // v6：按 step.inputFrom 过滤前置输出（未配置依赖 → 全量；配置后只注入声明的依赖，
    // 多段同 stepId 去重取最近一段）——prompt 与 fillParams 共用过滤后的列表。
    const previousOutputs = filterPreviousOutputs(request.step, request.previousOutputs);
    const paramsText =
      command.type === 'agent' && command.value.agentParamsTemplate !== undefined
        ? await this.fillParams(command, command.value.agentParamsTemplate, { ...request, previousOutputs })
        : undefined;
    const route = await this.resolveProviderModel(command.value);
    const taskText = buildTaskText(
      command,
      resolvePassThroughVars(request.passThroughVars, request.loopTurn, request.loopMaxIterations),
      this.config.skills,
      this.config.mcps,
      this.config.agents,
    );
    const promptText = buildPromptText(
      taskText,
      request.step.name ?? request.step.id,
      request.executedId,
      request.originalInput,
      previousOutputs,
      paramsText,
      request.resolvedRules,
    );
    const started = await this.ctx.subagents.startContinuable({
      // `provider` 是 DSH subagent provider 注册名（固定 `this.subagentProvider`，
      // 缺省 'fork'，DSH base bundle 已注册），与模型路由完全解耦：模型路由经
      // `request.agentOptions`（{ provider, model }）承载（DSH continuation.ts：
      // `request.agentOptions?.provider ?? parent.options.provider`）。不要把模型
      // provider id（`route.provider`）填到这里——DSH 只认注册的 subagent provider
      // 名（fork/spawn），否则运行时报
      // `no subagent provider registered for "<model provider id>"`。
      provider: this.subagentProvider,
      label: `step ${request.step.id}`,
      request: {
        prompt: [{ type: 'text', text: promptText }],
        parent: this.resolveParent(),
        agentOptions: { provider: route.provider, model: route.model },
        // ask 工具全局注册 + gate（上游适配）：屏蔽 DSH 全局版 ask_user_question，
        // 引导模型使用全局注册的 `sandore_ask_user_question`（gate 仅放行 sandore
        // 子代理，见 workflow/ask-tool.ts registerGlobalAskTool）。
        toolFilter: { deny: ['ask_user_question'] },
      },
      signal: request.signal ?? new AbortController().signal,
    });
    await this.config.onChildStarted?.(request.step.id, started.childId);
    return this.collectSubagentOutput(command.type, started.childId, request.step.id, request.stageId, request.signal);
  }

  /**
   * 暂停后恢复子代理 Step：重新 settle + final output。
   *
   * 暂停的子代理 Step 被 `interrupt` 打断后（settle `aborted`），`resumeStep` 的
   * `followup` cold-resume 重新驱动子代理；本方法在 `followup` 之后被引擎续跑路径调用，
   * 重新等待子代理 settle 并取回最终 assistant 输出（等价于首次执行时的输出收集尾段）。
   */
  async resumeSubagent(
    commandType: SubagentCommandType,
    childId: string,
    stepId: string,
    stageId: string,
    signal?: AbortSignal,
  ): Promise<StepRunResult> {
    return this.collectSubagentOutput(commandType, childId, stepId, stageId, signal);
  }

  /**
   * 收集已启动子代理的最终输出（首次执行与暂停续跑共用：settle 终态 + final output）。
   *
   * 完成判定对齐 DSH `subagent/end`：等 `awaitSubagentSettlement`（由 workflow 层注入，
   * 经 `sandore/subagent-settled` 事件路由 DSH settle 终态）。按 `stopReason` 区分：
   * - `completed` → Step 完成，取 settle 载荷 `output`（缺省回退 `finalAssistantOutput`）。
   * - `aborted`（interrupt 暂停）→ 不算完成，抛 `STEP_PAUSED` sentinel 供 stage-executor
   *   路由为 paused（不再依赖暂停登记表兜底）。
   * - `error`/`max-tokens`/`refusal` → 落 `STEP_EXECUTION`（failed）。
   *
   * `awaitSubagentSettlement` 缺省时回退 `whenIdle()` + `finalAssistantOutput()`（兼容无注入
   * 场景；此回退无法区分 abort，不适用于暂停语义——暂停路径必经注入的 settle）。
   *
   * 双通道 ask 重构后**不再有 ask 转接循环**（`[[SANDORE_ASK]]` 标记块机制已删）：子代理
   * 提问经全局注册的 `sandore_ask_user_question` 工具在执行 turn 内同步完成（工具调用
   * 阻塞等待引擎级 ask 答案），final output 即最终输出，无标记块解析。
   */
  private async collectSubagentOutput(
    commandType: SubagentCommandType,
    childId: string,
    stepId: string,
    stageId: string,
    signal?: AbortSignal,
  ): Promise<StepRunResult> {
    // 子代理注册先于 startContinuable 返回（rc.1 与 mock 同语义），此处同步 get 恒命中；
    // settle 即 dispose 的竞态由引擎 settlementBuffer（settle 早于 awaiter 注册）覆盖，
    // 故 registry 缺失视为真错误（STEP_EXECUTION），不进入 settle 等待造成挂起。
    const child = this.ctx.agents.get(childId);
    if (child === undefined) {
      throw new SandoreError(`subagent '${childId}' not found in registry`, 'STEP_EXECUTION');
    }
    const awaitSettlement = this.config.awaitSubagentSettlement;
    // settle 终态 → final output：只有 DSH settle（completed）才算完成；aborted 抛暂停
    // sentinel；error/max-tokens/refusal 落 failed。未注入时回退 whenIdle + finalAssistantOutput。
    const settle = async (): Promise<ContentBlock[]> => {
      if (awaitSettlement === undefined) {
        await child.whenIdle();
        const fallback = finalAssistantOutput(sessionEventList(child.session));
        if (fallback === undefined) {
          throw new SandoreError('subagent produced no assistant output', 'STEP_EXECUTION');
        }
        return fallback;
      }
      const settlement: SubagentSettlement = await awaitSettlement(childId, signal ?? new AbortController().signal);
      if (settlement.stopReason === 'completed') {
        // settle 载荷 output 为只读视图（对齐 DSH lastAssistantMessage 借用语义），拷贝为可变数组。
        const out = settlement.output ?? finalAssistantOutput(sessionEventList(child.session));
        if (out === undefined) {
          throw new SandoreError('subagent produced no assistant output', 'STEP_EXECUTION');
        }
        return [...out];
      }
      if (settlement.stopReason === 'aborted') {
        // interrupt 暂停：不算完成，抛 STEP_PAUSED sentinel 供 stage-executor 路由为 paused。
        throw new SandoreError(`subagent '${childId}' interrupted (settle aborted)`, 'STEP_PAUSED', { fatal: false });
      }
      // error / max-tokens / refusal（及未知 reason）→ failed。
      throw new SandoreError(`subagent '${childId}' settle ${settlement.stopReason}`, 'STEP_EXECUTION');
    };
    const output = await settle();
    // §3.8A：子代理消息持久化（settle 后采集，随结果带出 → finishCommandNode 写
    // executed.sessionMessages → onPersist 定格；前端内嵌消息框/失败·暂停最近 N 条）。
    // 只保留最新 10 条（slice(-10)）：真实子代理走 StepChatPanel 实时订阅不读
    // sessionMessages；合成会话兜底（chatLinesOf）也只展示最近 N 条——截断减小
    // 持久化体积，不影响兜底正确性。
    // 取最新活 child（cold-resume 后的新 handle），回退 start child（mock FakeAgent 复用）。
    const liveChild = this.ctx.agents.get(childId) ?? child;
    return {
      output,
      sessionMeta: { childId, synthetic: false, command: commandType },
      sessionMessages: collectSessionMessages(sessionEventList(liveChild?.session)).slice(-10),
    };
  }

  /**
   * 用可续接子代理按模板填充参数（v6 改造：与 step-execute 同机制——DSH preset +
   * 工具 + settle 收集输出，不再 llm.stream 临时会话）；失败（error/aborted/抛错/
   * 无输出）回退模板原文。
   */
  private async fillParams(command: AgentCommand, template: string, request: StepRunRequest): Promise<string> {
    const route = await this.resolveProviderModel(command.value);
    const promptText = buildFillParamsPrompt(request.originalInput, request.previousOutputs, template);
    try {
      const started = await this.ctx.subagents.startContinuable({
        provider: this.subagentProvider,
        label: `fillParams ${request.step.id}`,
        request: {
          prompt: [{ type: 'text', text: promptText }],
          parent: this.resolveParent(),
          agentOptions: { provider: route.provider, model: route.model },
          // 与 runSubagent 同型：屏蔽 DSH 全局版 ask_user_question（参数填充子代理
          // 无提问通道需求）。
          toolFilter: { deny: ['ask_user_question'] },
        },
        signal: request.signal ?? new AbortController().signal,
      });
      // settle 终态收集（与 collectSubagentOutput 同语义）：completed → 输出；
      // 其余 stopReason（error/max-tokens/refusal/aborted）回退模板原文。
      const awaitSettlement = this.config.awaitSubagentSettlement;
      const collect = async (): Promise<readonly ContentBlock[] | undefined> => {
        if (awaitSettlement !== undefined) {
          const settlement = await awaitSettlement(started.childId, request.signal ?? new AbortController().signal);
          if (settlement.stopReason !== 'completed') {
            return undefined;
          }
          const child = this.ctx.agents.get(started.childId);
          return settlement.output ?? (child === undefined ? undefined : finalAssistantOutput(sessionEventList(child.session)));
        }
        const child = this.ctx.agents.get(started.childId);
        if (child === undefined) {
          return undefined;
        }
        await child.whenIdle();
        return finalAssistantOutput(sessionEventList(child.session));
      };
      const output = await collect();
      if (output === undefined) {
        this.ctx.logger.warn('sandore: fillParams subagent produced no output, falling back to template');
        return template;
      }
      const text = textSummary(output);
      return text === '' ? template : text;
    } catch (error) {
      this.ctx.logger.warn(`sandore: fillParams subagent failed: ${describeError(error)}`);
      return template;
    }
  }

  private async resolveProviderModel(value: ModelRoutedValue): Promise<{ provider: string; model: string }> {
    return resolveModelRoute(
      value,
      this.config,
      this.ctx.llm,
      (provider, model) =>
        this.ctx.logger.warn(`sandore: step falls back to directory provider '${provider}' model '${model}'`),
    );
  }

  /** 子代理 parent：优先 config.hostAgent，缺省用最小桩对象。 */
  private resolveParent(): Agent {
    return this.config.hostAgent ?? createHostAgentStub();
  }
}
