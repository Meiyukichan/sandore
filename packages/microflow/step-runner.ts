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
import { assertFreshSubagentProvider, FRESH_SUBAGENT_PROVIDER } from './subagents.ts';
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
   * `request.agentOptions?.provider ?? parent.options.provider` 解析）。
   *
   * **缺省 `'spawn'`（= {@link FRESH_SUBAGENT_PROVIDER}），不是 `'fork'`**：`fork`
   * provider 会用**父会话（宿主主代理）的闭合 turn 前缀**给子代理做 seed
   * （`subagent-fork-in-process/src/index.ts:48-54,76-90`，`inheritsParentContext = true`），
   * 实测把主代理的历史灌进了每个 step 会话；`spawn` 是全新的子代理
   * （`:49-50,54-65`），两者 capabilities 完全相同。详见
   * {@link FRESH_SUBAGENT_PROVIDER} 的注释与 {@link assertFreshSubagentProvider} 守卫。
   *
   * 覆盖成继承父上下文的 provider（如 `'fork'`）会在执行前被
   * {@link assertFreshSubagentProvider} **响亮拒绝**（不变量，不能靠人记得）。
   *
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
   * 宿主主代理（= 子代理直接 parent）的会话 id：引擎注入
   * `hostSessionId ?? taskId`（确定性来源，不依赖 Agent.id 运行时形状）。随
   * 子代理结果/暂停/完成写回段 sessionMeta.hostSessionId，UI 据此组 subagent-kind
   * 地址打开内嵌会话（2026-09-09）。
   */
  readonly parentSessionId?: string;
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
  /**
   * 该 Step 的**直接上游** step id（DAG 入边来源；由 StageExecutor 计算）。
   *
   * `inputFrom` 未声明时按本列表过滤 `previousOutputs`（v7：默认只注入直接上游，而不是
   * 把当前 Stage 已执行的所有 step 输出都塞进 `<ReferenceInfo>`）。
   */
  readonly upstreamStepIds?: readonly string[];
  /**
   * 上游 step id → 展示名（`StageExecutor` 从合并后的 step 视图填；只用于
   * 「上游未产出内容」标注块的人读名称，查不到时回退 id）。
   */
  readonly upstreamStepNames?: Readonly<Record<string, string>>;
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
  // 注意：**不再有 `sessionMessages`**（2026-09）：state 不再持久化该展示派生字段，
  // 改由 `getInstanceState` RPC 读取时从子代理会话按需回算（见 workflow-engine.ts 的
  // `hydrateStateMessages`）。
}

/** 结构化提示词主头部（v6：行动引导 + 职责四点；无角色声明、无行为要求、无输出格式要求）。 */
const PROMPT_MAIN_HEADER = [
  '你正在执行工作流中的一个 Step。必须先明确以下三点，再开始执行：',
  '- `## 用户指令` —— 用户提供的当前任务指令，是本次 Step 要达成的**唯一验收目标**。',
  '- `## 任务规则` —— 用户配置的约束，执行时**不得违反**。',
  '- `## 参考信息` —— 执行上下文，按需查阅。',
  '',
  // 架构决策 5：写死「没有向主代理发消息的工具」正向说明——工具层已用
  // toolFilter deny `send_message`（子代理 scope 里没有该工具），此句是 prompt 侧
  // 弱约束，避免模型因工具列表里没有 send_message 而困惑或反复试探。
  '你没有向主代理发消息的工具，直接结束即可（结果由引擎收集）。',
].join('\n');

/** fillParams 临时会话的任务指令。 */
const FILL_PARAMS_TASK =
  '你的唯一任务是根据这个参数模板，然后根据（## 输入信息）中的信息，\n或者你可以进行一定程度的探索后，将参数模板的内容按照模板格式填充后返回这个结果！';

/** fillParams 临时会话的红线规则（只读，禁止文件改动与过度探索）。 */
const FILL_PARAMS_RED_LINES = [
  '禁止编辑或者创建或者删除任何文件',
  '禁止过度探索，你的任务是根据已有信息，做足够探索后尽快返回这个参数模板结果',
  '不要过度思考，你的职责不是设计或者开发',
  // 架构决策 5（同型约束）：参数填充子代理同样没有 send_message（toolFilter deny）。
  '你没有向主代理发消息的工具，直接返回结果即可',
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
    // 桩不承载宿主投递（`deliverToHost` 只对真实宿主 agent 调用；此处仅为结构完整）。
    steer: () => {},
    whenIdle: async () => {},
  };
}

/** 多行文本每行前加 N 空格缩进（XML 块内内容对齐）。 */
function indentLines(text: string, spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => `${prefix}${line}`);
}

/**
 * 「参考信息」里前置输出块的总字符预算（超出即截断并标注）。
 *
 * 依据：本仓库对**模型可见文本**的既有封顶是 `workflow/tool-support.ts` 的
 * `RENDER_MAX_CHARS = 20000`（工具结果渲染上限），这里取同一量级——单步 prompt 的
 * 参考信息（不含用户指令/任务规则）不应超过一次工具结果的体量，否则长工作流会把
 * prompt 撑爆。截断只作用于**前置输出块**：当前 Step 身份块与「用户原始需求」块恒完整。
 */
const REFERENCE_INFO_MAX_CHARS = 20_000;

/**
 * 渲染「前置 Steps 输出和产物」XML 块（v6：`<Reference title="前置Step: {{name}} (id: {{id}}) 的输出和产物">`，
 * 内容为 `<Output>` + `<Artifacts>`，全部转义；无前置输出返回空）。
 *
 * v7 体积护栏：累计渲染字符超过 {@link REFERENCE_INFO_MAX_CHARS} 时截断后续前置块，
 * 并追加一行显式标注（模型据此知道还有依赖未展示，可自行用文件/工具补齐）。
 */
function renderPreviousOutputs(previousOutputs: readonly PreviousStepOutput[]): string[] {
  if (previousOutputs.length === 0) {
    return [];
  }
  const sections: string[] = [];
  let used = 0;
  let shown = 0;
  for (const previous of previousOutputs) {
    const name = escapeXmlAttr(previous.name);
    const id = escapeXmlAttr(previous.id);
    const block = [
      `  <Reference title="前置Step: ${name} (id: ${id}) 的输出和产物">`,
      '    <Output>',
      ...indentLines(escapeXml(previous.returnPrompt), 6),
      '    </Output>',
      '    <Artifacts>',
      ...previous.files.map(file => `      <Artifact>${escapeXml(file)}</Artifact>`),
      '    </Artifacts>',
      '  </Reference>',
      '',
    ];
    const size = block.join('\n').length;
    if (used + size > REFERENCE_INFO_MAX_CHARS) {
      const omitted = previousOutputs.length - shown;
      sections.push(`  <Reference title="参考信息已截断">超出 ${REFERENCE_INFO_MAX_CHARS} 字符预算，省略 ${omitted} 个前置 Step 的输出（如需请显式声明 inputFrom 或缩小 regex 范围）</Reference>`);
      sections.push('');
      break;
    }
    used += size;
    shown += 1;
    sections.push(...block);
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

/** 上游未产出内容的标注条目（「上游未产出内容」`<Reference>` 块）。 */
export interface UnresolvedUpstream {
  readonly id: string;
  readonly name: string;
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
 *
 * v8：新增「上游未产出内容」标注（`unresolvedUpstreams`）——上游本次未执行或输出为空时
 * 显式点名，避免参考信息静默留空被读成「依赖丢了」（真机 `test-workflow` 的 loop：
 * 上游 `sce3` 因条件分支从未执行，参考信息整篇为空）。
 */
function buildPromptText(
  taskText: string,
  stepName: string,
  executedId: string,
  originalInput: string,
  previousOutputs: readonly PreviousStepOutput[],
  paramsText: string | undefined,
  resolvedRules?: Readonly<Record<string, string>>,
  unresolvedUpstreams: readonly UnresolvedUpstream[] = [],
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
  // 上游未产出内容（可选）：上游本次未执行（条件分支未选中）或输出为空时只标注、不编造。
  // 摆在「用户原始需求」之后、前置输出之前：无前置输出时它是唯一上下文，有输出时也先
  // 让模型知道依赖集合的缺口。
  if (unresolvedUpstreams.length > 0) {
    sections.push('');
    for (const upstream of unresolvedUpstreams) {
      const name = escapeXmlAttr(upstream.name);
      const id = escapeXmlAttr(upstream.id);
      sections.push(`  <Reference title="上游未产出内容">${name} (id: ${id})：本次未执行或输出为空，无可注入内容</Reference>`);
    }
  }
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
 * 解析该 Step 要注入 `## 参考信息` 的前置输出（**只注入声明/直接上游**，与 `resolveShellStdin` 同语义）。
 *
 * 契约（v7，2026-09 真机缺陷修复）：
 * - **显式 `inputFrom` 优先**：按 `path`（stepId 匹配 `idMatches`）/ `regex` 过滤；
 *   - `regex`：对输出做正则**提取**（注入 `match[0]`，而不是检测命中后注入整篇）；
 * - **未声明 `inputFrom` → 注入直接上游**（`upstreamStepIds`：DAG 入边来源的 step，含
 *   普通 `next` 边与循环边的 `exitTo` 出口，见 `stage-executor.directUpstreamStepIds`）。
 *   旧版"未配置则注入全量"是 prompt 膨胀的根因：真机 `test-workflow` 的 `loop`（无 inputFrom）
 *   拿到了当前 Stage 所有已执行 step 的输出（sce1/parallel1/sce2/修复问题），而它唯一的
 *   流程上游 `sce3` 反而因为走了另一条条件分支而未出现。默认 = 直接上游既符合"DAG 依赖"
 *   直觉，也不会随 Stage 规模/循环轮次膨胀；上游未执行时不静默留空，另有「上游未产出内容」
 *   标注块（见 {@link buildPromptText} 的 `unresolvedUpstreams`）。
 * - 同一 stepId 的多段（loop/重试/暂停续跑）**只保留最近一段**（数组序 = 完成顺序）。
 * @param step - 目标 Step 定义。
 * @param previousOutputs - 实例/Stage 累积的前置输出（每 step 已 upsert 为最新段）。
 * @param upstreamStepIds - 直接上游 step id（未声明 inputFrom 时的默认集合）。
 * @returns 注入用的前置输出列表。
 */
function filterPreviousOutputs(
  step: WorkflowStep,
  previousOutputs: readonly PreviousStepOutput[],
  upstreamStepIds: readonly string[] = [],
): readonly PreviousStepOutput[] {
  const inputFrom = step.inputFrom;
  if (inputFrom === undefined || inputFrom.length === 0) {
    // 默认 = 直接上游（v7/v8）。**按上游 step 去重**（2026-09 全量 e2e 红灯根因）：
    // `idMatches` 明确允许 `sce3-<后缀>` 这类**循环别名 id**
    // （`actualId.startsWith(targetId + '-')`），而上一版按**原始 id** 去重 ⇒ 同一步骤的两个
    // 别名各注入一份、块标题还都叫 `前置Step: sce3`（真机现象：m15 的「同一上游只注入一次」
    // 得到 2）。按上游归并后，同一上游恒只注入一份（取**最新段**：数组序 = 完成顺序）。
    const byUpstream = new Map<string, PreviousStepOutput>();
    for (const upstream of new Set(upstreamStepIds)) {
      let latest: PreviousStepOutput | undefined;
      for (const previous of previousOutputs) {
        if (idMatches(previous.id, upstream)) latest = previous;
      }
      if (latest !== undefined) byUpstream.set(upstream, latest);
    }
    // 输出顺序 = 上游声明顺序（确定性；不再随 previousOutputs 的累积顺序漂移）。
    return [...byUpstream.values()];
  }
  const matched: PreviousStepOutput[] = [];
  /** 已注入的**声明上游 step**（`path` 形态：别名 id 归并到同一声明上游，只取一段）。 */
  const injectedUpstreams = new Set<string>();
  /** 已注入的原始段 id（`regex` 形态：多个 regex 声明命中同一段时不重复注入）。 */
  const injectedIds = new Set<string>();
  for (const item of inputFrom) {
    if (item.regex !== undefined) {
      let regex: RegExp;
      try {
        regex = new RegExp(item.regex);
      } catch {
        continue;
      }
      for (const previous of previousOutputs) {
        const found = regex.exec(previous.returnPrompt);
        if (found !== null && !injectedIds.has(previous.id)) {
          // 提取片段：注入的是命中的那一小段（regex 未加捕获组时取整段匹配）。
          injectedIds.add(previous.id);
          matched.push({ ...previous, returnPrompt: found[0] });
        }
      }
    } else if (item.path !== undefined) {
      const stepId = stepIdFromPath(item.path);
      if (injectedUpstreams.has(stepId)) {
        continue;
      }
      // 该声明上游的**最新段**（数组序 = 完成顺序）；别名 id 归并到同一逻辑上游。
      let latest: PreviousStepOutput | undefined;
      for (const previous of previousOutputs) {
        if (idMatches(previous.id, stepId)) latest = previous;
      }
      if (latest !== undefined) {
        injectedUpstreams.add(stepId);
        matched.push(latest);
      }
    }
  }
  return matched;
}

/**
 * 计算「上游未产出内容」的标注条目（v8）。
 *
 * 上游集合 = 显式 `inputFrom` 的 `path`（`regex` 形态不指向具体 step，跳过）**或**直接上游
 * （未声明 `inputFrom` 时）。`previousOutputs` 只包含**有输出**的 step（
 * `previousOutputsFromExecutedSteps` 会跳过空输出），故不在其中的上游 = 本次未执行或输出为空。
 * @param request - 单 Step 执行请求。
 * @returns 待标注的上游（按声明顺序去重）。
 */
function unresolvedUpstreamsOf(request: StepRunRequest): UnresolvedUpstream[] {
  const declared = (request.step.inputFrom ?? [])
    .map(item => item.path)
    .filter((path): path is string => path !== undefined && path !== '');
  const upstreamIds = declared.length > 0 ? declared : (request.upstreamStepIds ?? []);
  const unresolved: UnresolvedUpstream[] = [];
  for (const id of new Set(upstreamIds)) {
    if (request.previousOutputs.some(previous => idMatches(previous.id, id))) continue;
    unresolved.push({ id, name: request.upstreamStepNames?.[id] ?? id });
  }
  return unresolved;
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
   * {@link StepRunnerConfig.subagentProvider}）；缺省 {@link FRESH_SUBAGENT_PROVIDER}
   * （`spawn`，**全新子代理**：不继承父会话上下文）。
   */
  private readonly subagentProvider: string;

  constructor(
    private readonly ctx: Context,
    private readonly config: StepRunnerConfig,
  ) {
    // 不变量（2026-09 真机缺陷修复）：step 子代理必须**全新**——不携带宿主主代理/父会话
    // 的历史。缺省用 `spawn`（`inheritsParentContext = false`，无 seed）；用 `fork`
    // 会把父会话闭合 turn 前缀 seed 进子代理（见 FRESH_SUBAGENT_PROVIDER 的证据注释）。
    this.subagentProvider = config.subagentProvider ?? FRESH_SUBAGENT_PROVIDER;
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
    const launched = await this.launchSubagent(request);
    return this.collectSubagentOutput(launched.commandType, launched.childId, request.step.id, request.stageId, request.signal);
  }

  /**
   * 拉起真实子代理（只启动、不等待 settle）：prompt 组装 → `startContinuable`
   * → `onChildStarted` 上抛真实 childId（engine 侧把 running 段的 sessionMeta
   * 回填真实 childId + 落盘）。
   *
   * 2026-09-09 架构决定：**不再生成合成占位 childId**——引擎先调用本方法拿到
   * 真实会话 id，之后才发 step-start / 继续 settle 收尾；执行段与事件里的 childId
   * 一出生就是真实会话 id（UI 拿到即可 binding + 打开实时对话）。
   */
  async launchSubagent(request: StepRunRequest): Promise<{ commandType: SubagentCommandType; childId: string }> {
    const command = request.step.command;
    if (command === undefined || command.type === 'shell') {
      throw new SandoreError(`step '${request.step.id}' is not a subagent command`, 'STEP_EXECUTION');
    }
    // v7：参考信息里的前置输出 = 显式 inputFrom **或**直接上游（每 step 只取最新段）；
    // prompt 与 fillParams 共用过滤后的列表。
    const previousOutputs = filterPreviousOutputs(request.step, request.previousOutputs, request.upstreamStepIds);
    // v8：上游里「本次未执行或输出为空」的条目显式标注（`filterPreviousOutputs` 对它们
    // 只会静默省略）。真机缺陷形态：loop 的上游 sce3 因条件分支从未执行 → 参考信息整篇
    // 为空，模型与人都不知是「依赖丢了」还是「本来就没有」。
    const unresolvedUpstreams = unresolvedUpstreamsOf(request);
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
      unresolvedUpstreams,
    );
    // 不变量守卫（防复发）：所用 provider 不得声明继承父会话上下文（`fork` 会）。
    assertFreshSubagentProvider(this.ctx.subagents, this.subagentProvider);
    // **childId 由引擎显式生成纯 UUID**（无前缀）：用户要求子代理标题显示
    // `<step 名称> · <childId>`，而 label 里要带 childId 就必须先知道它（DSH 的
    // `ContinuableStartSpec.label` 必填、`childId` 可选；不传则由 DSH 分配 → 拼不出 label）。
    const childId = globalThis.crypto.randomUUID();
    const stepDisplayName = request.step.name ?? request.step.id;
    const started = await this.ctx.subagents.startContinuable({
      childId,
      // 列表/血缘标题：`<名称> · <childId>`（无 `step ` 前缀；名称缺失回退 step id）。
      label: `${stepDisplayName} · ${childId}`,
      // `provider` 是 DSH subagent provider 注册名（固定 `this.subagentProvider`，
      // 缺省 `spawn` = 全新子代理，见 FRESH_SUBAGENT_PROVIDER），与模型路由完全解耦：
      // 模型路由经 `request.agentOptions`（{ provider, model }）承载（DSH continuation.ts：
      // `request.agentOptions?.provider ?? parent.options.provider`）。不要把模型
      // provider id（`route.provider`）填到这里——DSH 只认注册的 subagent provider
      // 名（spawn/fork），否则运行时报
      // `no subagent provider registered for "<model provider id>"`。
      provider: this.subagentProvider,
      request: {
        prompt: [{ type: 'text', text: promptText }],
        parent: this.resolveParent(),
        agentOptions: { provider: route.provider, model: route.model },
        // ask 工具全局注册 + gate（上游适配）：屏蔽 DSH 全局版 ask_user_question，
        // 引导模型使用全局注册的 `sandore_ask_user_question`（gate 仅放行 sandore
        // 子代理，见 workflow/ask-tool.ts registerGlobalAskTool）。
        //
        // 架构决策 5：再屏蔽 `send_message`——DSH 对 continuable 子代理**硬编码**注入
        // 「完成后 send_message 汇报给 parent」的指引（`@deepseek-ai/dsh-subagent`
        // continuation.ts:296-309 `continuableInitialPrompt`，且不可配置关闭），工作流
        // Step 子代理的产出应由引擎收集（settle → executedSteps[].output），不能反向
        // 唤醒宿主主代理。**关键机制**：该指引的注入本身是条件的——continuation.ts:495-500
        // 只在 `isAdjacentAgentSendMessageTool(ctx.tools.get('send_message', childAgent))`
        // 为真时才追加指引；toolFilter deny 后子代理 scope 里没有该工具（DSH
        // `childCtx.tools.restrict(filter)`，child-agent.ts:217），DSH 便不再注入汇报
        // 指引（双保险：工具没了 + 指引没了；prompt 侧另有弱约束文案）。
        toolFilter: { deny: ['ask_user_question', 'send_message'] },
      },
      signal: request.signal ?? new AbortController().signal,
    });
    await this.config.onChildStarted?.(request.step.id, started.childId);
    return { commandType: command.type, childId: started.childId };
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
    // 注意：**不再采集/持久化 `sessionMessages`**（2026-09）——实测它占 state 的
    // 41%–54%（最新实例 61,667/149,165 字节），而它只是从本 step 子代理会话派生的
    // 展示行。现在由引擎在 `getInstanceState` RPC 读取时按需从会话现算
    //（`workflow-engine.ts` 的 `hydrateStateMessages`，每段取尾部 10 条），消费面
    // 字段名与形状不变。本函数的 `StepRunResult` 也不再携带该字段。
    return {
      output,
      // hostSessionId = 宿主主代理（parent）会话 id：贯穿持久化，UI 组 subagent-kind
      // 地址打开内嵌会话需要它（2026-09-09；来源为引擎注入的确定性 parentSessionId）。
      sessionMeta: {
        childId,
        synthetic: false,
        command: commandType,
        ...(this.config.parentSessionId === undefined
          ? {}
          : { hostSessionId: this.config.parentSessionId }),
      },
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
      // 与 runSubagent 同款不变量守卫：参数填充子代理同样必须**全新**（不继承父历史）。
      assertFreshSubagentProvider(this.ctx.subagents, this.subagentProvider);
      // 与 step 执行同款：引擎生成纯 UUID childId，标题 `fillParams <名称> · <childId>`。
      const fillChildId = globalThis.crypto.randomUUID();
      const started = await this.ctx.subagents.startContinuable({
        provider: this.subagentProvider,
        childId: fillChildId,
        label: `fillParams ${request.step.name ?? request.step.id} · ${fillChildId}`,
        request: {
          prompt: [{ type: 'text', text: promptText }],
          parent: this.resolveParent(),
          agentOptions: { provider: route.provider, model: route.model },
          // 与 runSubagent 同型：屏蔽 DSH 全局版 ask_user_question（参数填充子代理
          // 无提问通道需求）+ send_message（架构决策 5：子代理不向主代理汇报）。
          toolFilter: { deny: ['ask_user_question', 'send_message'] },
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
