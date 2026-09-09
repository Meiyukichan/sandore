/**
 * sandore 引擎使用的 `ctx.subagents` / `ctx.agents` 能力接缝（本地结构类型声明）。
 *
 * `@deepseek-ai/dsh-subagent` 已作为 sandore 的 peer 依赖声明（上游适配：fork setup
 * 与宿主投递经其包根导出 / `internal` 子路径实现），但本文件仍按结构类型复刻
 * agent/skill/mcp Step 执行所需的最小面（`startContinuable`/`interrupt`/`start` +
 * `get`/`create`/`resume` + `AgentHandle`），并声明 `ctx.subagents` / `ctx.agents`
 * 上下文键；宿主运行时注入的真实服务结构兼容即可。`finalAssistantOutput` 按 DSH
 * 源码选取规则在接缝内自带（最后一条非空 assistant 消息 → 回退累计 text-delta →
 * undefined），引擎主路径不 import DSH 内部模块。
 *
 * **上游破坏性变更适配（DSH 0.1.2-rc.1，commit 3091bdc257 / ec493c2db8）**：
 * - `ctx.subagents.registerContinuableSetup` 已删（设计否决 child-setup 贡献注册表）
 *   → 子代理 child-scope 注入通道不复存在，ask 工具改为全局注册 + gate（见
 *   workflow/ask-tool.ts `registerGlobalAskTool`），fork 判断子代理的 preset 组合改经
 *   包根导出 `applyChildComposition`（见 fork-session.ts）。
 * - `ctx.subagents.followup` 已删（统一为 steer/queue 投递）→ 宿主向子代理投递消息
 *   改经 `queueHostSubagentPrompt`（'queue' 投递 = 独立 FIFO 轮次语义，见
 *   workflow/subagent-delivery.ts）；本接缝的 {@link ChildPromptDelivery} 即其最小面。
 * - 会话头校验拒绝 `meta.seedLength` → fork/create 的 meta 改用 `meta.isSeeded: true`
 *   + create options 顶层 `inheritedEventCount`（见 {@link CreateAgentOptions}）。
 * @module @meiyukichan/dsh-sandore/microflow/src/subagents
 */
import type { AssistantMessage, ContentBlock, MessageSource, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionMessage } from '../workflow/schema';

/** 会话 ID（与 DSH `SessionId` 品牌字符串结构兼容）。 */
export type SessionId = string;

/** 消息 ID（与 DSH `MessageId` 品牌字符串结构兼容）。 */
export type MessageId = string;

/** 代理创建选项（provider/model/maxTokens）。 */
export interface AgentOptions {
  provider?: string;
  model?: string;
  maxTokens?: number;
}

/** 代理生命周期状态：`idle` 无驱动活动，`running` 有活动。 */
export type AgentStatus = 'idle' | 'running';

/** 会话最小结构：追加式事件日志的不可变快照。 */
export interface Session {
  readonly events: readonly SessionEvent[];
  /**
   * DSH 会话 header（父会话/工作目录等；sandore 子代理经 DSH `childSessionMeta`
   * 写入 `parentSession` = 宿主主代理会话 id）。仅承载身份/路由信息，不参与事件流。
   * `askFromSubagent`（workflow-engine）据此反查 ActiveInstance。
   */
  readonly header?: { readonly parentSession?: string; readonly cwd?: string };
}

/** 可续接子代理的活代理引用（`ctx.agents.get` 返回的裸 Agent）。 */
export interface Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: { readonly hasPending: boolean };
  readonly status: AgentStatus;
  readonly ctx: unknown;
  /**
   * 排队一个普通续接轮次并唤醒驱动（对齐 DSH `Agent.followup(message: UserMessage)`，
   * runtime-types L124）。消息为模型面入参的最小结构面：`content` 块 + 来源
   * （`source` 缺省时由宿主运行时按注入来源补齐）。收尾评估（Phase B assessForked /
   * Phase C secondary gate）用它驱动宿主主代理的子代理跑一轮评估。
   */
  followup(message: { readonly content: ContentBlock[]; readonly source?: MessageSource }): void;
  /** 当前整代理活动达到静止后 resolve。 */
  whenIdle(): Promise<void>;
}

/** 代理句柄：仅持有者可 `dispose` 拆除该代理。 */
export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}

/** `AgentSetup` 的提交对象：在发布前同步校验并提交。 */
export interface AgentSetupCommit {
  commit(): void;
}

/** `systemPrompt.section` 的入参（DSH `PromptSection` 最小面）。 */
export interface PromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

/** `systemPrompt.context` 的入参（DSH `PromptContext` 最小面：有序动态运行时上下文）。 */
export interface PromptContext {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

/**
 * `AgentSetup` 回调的 agentCtx 最小面。
 *
 * 结构兼容 DSH 真实 agent scope Context：`tools.register`/`systemPrompt.section` 为
 * sandore 直接使用的键；`agent` 为 child agent 活引用最小面（上游 `materializeTracked`
 * 的 setup 经 `(childCtx.agent as Agent).session` append delegation policy 事件）；
 * `systemPrompt.context`/`getContextOrder` 为 `applyChildComposition` 注册 delegation
 * 运行时上下文所需（包根导出，见 fork-session.ts）；`agentPresets` 为可选服务面
 * （无 preset 部署时为 undefined，`mount`/`resolve`/`composeFrom` 签名对齐
 * `@deepseek-ai/dsh-agent-presets`——`applyChildComposition` 内部同样经
 * `childCtx.get('agentPresets')?.composeFrom(...)` 组合 parent preset）。
 */
export interface AgentSetupContext {
  /** child agent 活引用最小面（delegation policy append 取 `agent.session.append`）。 */
  readonly agent: {
    readonly session: {
      /** 对齐 DSH `Session.append(type, data)`：向未发布会话日志追加事件。 */
      append(type: string, data: unknown): unknown;
    };
  };
  readonly tools: { register(tool: unknown): void };
  readonly systemPrompt: {
    section(section: PromptSection): void;
    /** 注册有序动态运行时上下文（对齐 DSH `systemPrompt.context`，返回 disposer）。 */
    context(declaration: PromptContext): void;
    /** 解析仓库级 context 中心 placement（对齐 DSH `systemPrompt.getContextOrder`）。 */
    getContextOrder(name: string): number;
  };
  /**
   * Cordis service getter（DSH 真实 agent scope ctx 兼容的最小面）：上游
   * `applyChildComposition` 以 `childCtx.get('agentPresets')?.composeFrom(childCtx,
   * parent.ctx)` 组合宿主主代理 preset（继承工具集 + prompt sections）。可选：
   * mock/测试环境的最小 agentCtx 未提供时视为无 preset 部署（上游同样以 `?.` 容忍）。
   */
  get?(name: 'agentPresets'): AgentSetupContext['agentPresets'];
  /** agentPresets 服务最小面：挂载 preset 组合（§3.0 宿主主代理 = 纯 DSH 默认 preset）。 */
  readonly agentPresets?: {
    mount(agentCtx: AgentSetupContext, id?: string): Promise<unknown>;
    resolve(id?: string): Promise<{ readonly id: string }>;
    composeFrom(agentCtx: AgentSetupContext, parentCtx: unknown): string | undefined;
  };
}

/** 代理 setup 回调：在 mint agentCtx 后、发布前执行，可返回同步提交对象。 */
export type AgentSetup = (
  agentCtx: AgentSetupContext,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;

/** `ctx.agents.create` 的选项（sessionId + meta/seed/顶层继承计数/可选配置/取消/setup）。 */
export interface CreateAgentOptions {
  readonly sessionId: SessionId;
  /**
   * 会话创建元数据（上游合法键：cwd/parentSession/isSeeded/origin/delegationDepth/
   * agentPreset）。**上游破坏性变更**：`seedLength` 已从 meta 删除（会话头校验显式
   * throw `invalid field "seedLength"`）；fork 血缘改用 `isSeeded: true` 标记 +
   * create options 顶层 {@link inheritedEventCount} 表达。
   */
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded?: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
  /**
   * fork 继承的事件前缀长度（上游 `inheritedEventCount`，`meta.isSeeded` 为 true 时
   * 必须携带且 ≤ seed 长度，否则会话创建期校验抛错）。brand（SessionLogOffset）不
   * 影响运行时，接缝以 number 承载。
   */
  readonly inheritedEventCount?: number;
  readonly seed?: readonly DshSessionEvent[];
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
  readonly setup?: AgentSetup;
}

/** `ctx.agents.resume` 的选项（resumeSessionId + 可选配置/取消/setup）。 */
export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId;
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
  readonly setup?: AgentSetup;
}

/** `ctx.agents` 能力接缝：查询/创建/恢复活代理。 */
export interface AgentRegistry {
  get(id: SessionId): Agent | undefined;
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
}

/** 子代理工具作用域限制（`allow`/`deny` 工具名）。 */
export interface ToolRestriction {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/** `startContinuable` 的委派请求（扣除 label/signal/outputSchema 后的字段）。 */
export interface ContinuableStartRequest {
  readonly prompt: ContentBlock[];
  readonly parent: Agent;
  readonly agentOptions?: AgentOptions;
  readonly maxDepth?: number;
  readonly toolFilter?: ToolRestriction;
  readonly persona?: string;
}

/** `startContinuable` 的入参。 */
export interface ContinuableStartSpec {
  readonly provider: string;
  readonly label: string;
  readonly request: ContinuableStartRequest;
  readonly signal: AbortSignal;
}

/** `startContinuable` 的返回：持久 child 会话 ID 与被接受首条提示词的 inbox 消息 ID。 */
export interface ContinuableStart {
  readonly childId: SessionId;
  readonly messageId: MessageId;
}

/**
 * 宿主 → 直接子代理的 prompt 投递函数最小面（上游 `subagents.followup` 删除后的替代
 * 通道，见 workflow/subagent-delivery.ts `createChildPromptDelivery`）。
 *
 * 对齐 `@deepseek-ai/dsh-subagent/internal` 的 `queueHostSubagentPrompt(runtime,
 * parent, childId, content, source, signal)`：'queue' 投递 = 独立 FIFO 轮次语义（旧
 * followup 的等价语义——消息排入 child inbox，作为新 turn 驱动 child 续跑），`parent`
 * 必须是 exact live direct parent（授权投递），`source` 为宿主协议来源（现调用点为
 * `{ kind: 'user' }`），`signal` 为 inbox 接受前的取消信号。
 */
export type ChildPromptDelivery = (
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal?: AbortSignal,
) => Promise<MessageId>;

/** `interrupt` 的授权凭证。 */
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent };

/** 一次性子代理启动请求（`ctx.subagents.start` 的入参）。 */
export interface SubagentStartRequest {
  readonly label?: string;
  readonly prompt: ContentBlock[];
  readonly parent: Agent;
  readonly signal: AbortSignal;
  readonly agentOptions?: AgentOptions;
  readonly maxDepth?: number;
  readonly toolFilter?: ToolRestriction;
  readonly persona?: string;
}

/** 一次性子代理运行句柄。 */
export interface SubagentRun {
  readonly id: SessionId;
  readonly localAgent: Agent | undefined;
  readonly result: Promise<SubagentResult>;
  dispose(): Promise<void>;
}

/** 子代理运行终态。 */
export interface SubagentResult {
  readonly output: ContentBlock[];
  readonly structured?: unknown;
  readonly stopReason: SubagentStopReason;
}

/** 子代理停止原因。 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal';

/**
 * 子代理 settle 终态结算信号（对齐 DSH `subagent/end` 生命周期事件载荷）。
 *
 * DSH continuable 子代理「完成 = settle」：`SubagentContinuationManager.watchSettlement`
 * 在子代理静止（idle + 无 owned children + 无 accepted 唤醒）时 `dispose` →
 * `notifySettlement`（向父 inbox 投 `subagent-settled` 消息）→ `observer.settle`（emit
 * `subagent/end` 生命周期事件，载荷含 `stopReason` + `lastAssistantMessage`）。interrupt
 * → 子代理静止 → settle(stopReason=`aborted`)；自然完成 → settle(`completed`)；模型/
 * 传输失败 → settle(`error`)；token 上限 → `max-tokens`；hook 拒绝 → `refusal`。
 *
 * 本接缝不 import `@deepseek-ai/dsh-subagent` 类型（与既有结构类型哲学一致），故自行
 * 声明 `sandore/subagent-settled` 事件作为 settle 观察通道：DSH 适配层把 DSH
 * `subagent/end` 转译为本事件（见 workflow-engine），mock `FakeSubagents` 直接发射。
 * `report`（子代理主动 `reportFrom` 投递，child 仍 alive，中间结果）是 DSH 另一条父
 * 代理返回通道——sandore 子代理当前不使用 report 工具（提问走全局注册的
 * `sandore_ask_user_question` 工具，见 workflow/ask-tool.ts），report 通道作为未来
 * 扩展保留（届时同样经此事件投递 `completed`）。
 */
export interface SubagentSettlement {
  /** 结算的子代理 SessionId（对齐 DSH `SubagentRunEndInfo.id`）。 */
  readonly childId: SessionId;
  /** 终态停止原因（对齐 DSH `SubagentRunEndInfo.stopReason`）。 */
  readonly stopReason: SubagentStopReason;
  /**
   * 最终 assistant 输出（对齐 DSH `SubagentRunEndInfo.lastAssistantMessage`）。
   * 缺省时由消费方回退 `finalAssistantOutput(child.session.events)` 读取。
   */
  readonly output?: readonly ContentBlock[];
}

/** `listChildren` 返回的子代理条目（child/diagnostic 判别联合）。 */
export type SubagentListEntry =
  | { readonly kind: 'child'; readonly id: SessionId; readonly activity: 'running' | 'inactive'; readonly hasChildren: boolean }
    & ({ readonly mode: 'one-shot'; readonly label?: string } | { readonly mode: 'continuable'; readonly label: string })
  | { readonly kind: 'diagnostic'; readonly id: SessionId; readonly reason: 'corrupt' | 'unsupported' | 'unavailable' };

/**
 * `ctx.subagents` 能力接缝：可续接子代理 + 一次性子代理。
 *
 * **上游删除的方法**（不再声明，见文件头「上游破坏性变更适配」）：
 * - `followup`（commit ec493c2db8，统一为 steer/queue 投递）→
 *   {@link ChildPromptDelivery}。
 * - `registerContinuableSetup`（commit 3091bdc257，设计否决 child-setup 贡献注册表）
 *   → ask 工具全局注册 + gate（workflow/ask-tool.ts），fork preset 组合经包根导出
 *   `applyChildComposition`（fork-session.ts）。
 */
export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}

/** `assistant/message` 事件载荷。 */
export interface AssistantMessageData {
  turn: number;
  step: number;
  message: AssistantMessage;
  usage?: TokenUsage;
}

/** `assistant/chunk` 事件载荷。 */
export interface AssistantChunkData {
  turn: number;
  step: number;
  chunk: StreamChunk;
}

/**
 * `finalAssistantOutput` 需要的最小会话事件快照。
 *
 * 精确建模 `assistant/message` 与 `assistant/chunk` 两类事件；`seq`/`time` 为 DSH
 * 追加式日志的包络字段（深冻结快照）。消息收集（`collectSessionMessages`）额外建模
 * `user/message`、`tool/call`、`tool/result` 三类。其余事件类型由宿主运行时注入，
 * 接缝不建模。
 */
export type SessionEvent =
  | { readonly type: 'assistant/message'; readonly seq: number; readonly time: number; readonly data: AssistantMessageData }
  | { readonly type: 'assistant/chunk'; readonly seq: number; readonly time: number; readonly data: AssistantChunkData }
  | { readonly type: 'user/message'; readonly seq: number; readonly time: number; readonly data: UserMessageData }
  | { readonly type: 'tool/call'; readonly seq: number; readonly time: number; readonly data: ToolCallData }
  | { readonly type: 'tool/result'; readonly seq: number; readonly time: number; readonly data: ToolResultData };

/** `user/message` 事件载荷（DSH `UserMessage` 最小面：id + content 块）。 */
export interface UserMessageData {
  readonly id: string;
  readonly content: readonly ContentBlock[];
}

/** `tool/call` 事件载荷（DSH 形状：callId + name + 原始 arguments JSON 串）。 */
export interface ToolCallData {
  readonly turn: number;
  readonly step: number;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** `tool/result` 事件载荷（DSH `ToolResultMessage` 最小面：content 块）。 */
export interface ToolResultData {
  readonly turn: number;
  readonly step: number;
  readonly message: { readonly content: readonly ContentBlock[] };
}

/**
 * 选取子代理最终 assistant 输出（与 DSH 源码规则一致，与 stop reason 无关）。
 *
 * 1. 取最后一条非空 `assistant/message` 的 `message.content`（后写覆盖）。
 * 2. 无候选时累积 `assistant/chunk` 中 `text-delta` 文本，非空则返回
 *    `[{ type: 'text', text }]`。
 * 3. 两者皆无返回 `undefined`。
 * @param events - 子代理事件日志（`agent.session.events`）。
 * @returns 选中的 `ContentBlock[]`，或无输出时为 `undefined`。
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined {
  let message: ContentBlock[] | undefined;
  const partial: string[] = [];
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content;
      if (content.length > 0) message = content;
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      const text = event.data.chunk.text;
      if (text.length > 0) partial.push(text);
    }
  }
  if (message !== undefined) return message;
  const text = partial.join('');
  return text.length > 0 ? [{ type: 'text', text }] : undefined;
}

/**
 * 从子代理会话事件归一化消息行（§3.8A：`executedSteps[].sessionMessages` 数据源）。
 *
 * 采集规则（对齐 DSH `core/session/src/types.ts` 事件形状）：
 * - `user/message` → `{type:'text', text}`（取全部 text 块拼接）
 * - `assistant/message` → 逐块归一：text → `{type:'text'}`；reasoning →
 *   `{type:'reasoning'}`；tool-call → `{type:'tool', tool:name, args}`
 * - `tool/result` → `{type:'tool', output}`（取 message.content 的 text 拼接）
 * `assistant/chunk` 与其余事件类型忽略（chunk 已由 message 汇总，避免重复）。
 * @param events - 子代理事件日志（`agent.session.events`）。
 * @returns 归一化后的消息行（无任何可采集行时为 `[]`）。
 */
export function collectSessionMessages(events: readonly SessionEvent[]): SessionMessage[] {
  const messages: SessionMessage[] = [];
  const pushText = (type: 'text' | 'reasoning', text: string): void => {
    if (text === '') return;
    messages.push({ type, text });
  };
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = blocksToText(event.data.content);
      pushText('text', text);
    } else if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type === 'text') {
          pushText('text', block.text);
        } else if (block.type === 'reasoning') {
          pushText('reasoning', block.text);
        } else if (block.type === 'tool-call') {
          messages.push({ type: 'tool', tool: block.name, args: block.arguments });
        }
      }
    } else if (event.type === 'tool/result') {
      const text = blocksToText(event.data.message.content);
      if (text !== '') {
        messages.push({ type: 'tool', output: text });
      }
    }
  }
  return messages;
}

/**
 * 把 ContentBlock[] 的文本块拼接为纯文本。
 *
 * rc.1 适配：真实 `tool/result` 的 `message.content` 恒为单个
 * `ToolResultBlock{type:'tool-result', content: ContentBlock[]}` 包装（dsh-llm
 * types.ts:88-93；core/session 校验强制单 tool-result 块）——故除顶层 text 外，
 * 递归进入任何带 `content` 数组的块（tool-result 包装）提取内层 text。
 */
function blocksToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  const visit = (block: ContentBlock): void => {
    if (block.type === 'text' && block.text !== '') {
      parts.push(block.text);
      return;
    }
    const nested = (block as { type?: string; content?: unknown }).content;
    if (Array.isArray(nested)) {
      for (const inner of nested as readonly ContentBlock[]) visit(inner);
    }
  };
  for (const block of blocks) visit(block);
  return parts.join('\n');
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime;
    agents: AgentRegistry;
  }

  interface Events {
    /**
     * 子代理 settle 终态结算通知（对齐 DSH `subagent/end`）。
     *
     * 由 DSH 适配层（workflow-engine）在收到 DSH `subagent/end` 后转译发射；mock
     * `FakeSubagents` 直接发射（`settleChild` / `interrupt` 自动）。载荷为
     * {@link SubagentSettlement}（childId + stopReason + 可选 output），供
     * `awaitSubagentSettlement` 路由到对应 childId 的等待者。
     *
     * `stopReason` 自然区分 completed/aborted/error：`completed` 才算 Step 完成；
     * `aborted`（interrupt 暂停）不算完成；`error`/`max-tokens`/`refusal` 落 failed。
     * @mode emit
     */
    'sandore/subagent-settled'(settlement: SubagentSettlement): void;
  }
}
