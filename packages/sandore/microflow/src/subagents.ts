/**
 * sandore 引擎使用的 `ctx.subagents` / `ctx.agents` 能力接缝（本地结构类型声明）。
 *
 * `@deepseek-ai/dsh-subagent` 与 `@deepseek-ai/dsh-agent` 未作为 sandore 的运行时
 * 依赖安装，本文件按 DSH 公开 API 复刻 agent/skill/mcp Step 执行所需的最小结构类型
 * （`startContinuable`/`followup`/`interrupt`/`start` + `get`/`create`/`resume` +
 * `AgentHandle`），并声明 `ctx.subagents` / `ctx.agents` 上下文键。宿主运行时注入的
 * 真实服务结构兼容即可，无需包级依赖。`finalAssistantOutput` 按 DSH 源码选取规则在
 * 接缝内自带（最后一条非空 assistant 消息 → 回退累计 text-delta → undefined），不
 * import DSH 内部模块。
 * @module @deepseek-ai/dsh-sandore-microflow/src/subagents
 */
import type { AssistantMessage, ContentBlock, MessageSource, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';

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
}

/** 可续接子代理的活代理引用（`ctx.agents.get` 返回的裸 Agent）。 */
export interface Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly status: AgentStatus;
  /** 当前整代理活动达到静止后 resolve。 */
  whenIdle(): Promise<void>;
}

/** 代理句柄：仅持有者可 `dispose` 拆除该代理。 */
export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}

/** `ctx.agents.create` 的选项（最小面：sessionId + 可选配置/取消）。 */
export interface CreateAgentOptions {
  readonly sessionId: SessionId;
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
}

/** `ctx.agents.resume` 的选项（最小面：resumeSessionId + 可选配置/取消）。 */
export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId;
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
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

/** `followup` 的选项。 */
export interface SubagentFollowupOptions {
  readonly source: MessageSource;
  readonly signal: AbortSignal;
}

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

/** `ctx.subagents` 能力接缝：可续接子代理 + 一次性子代理。 */
export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
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
 * 仅精确建模 `assistant/message` 与 `assistant/chunk` 两类事件；`seq`/`time` 为 DSH
 * 追加式日志的包络字段（深冻结快照）。其余事件类型由宿主运行时注入，接缝不建模。
 */
export type SessionEvent =
  | { readonly type: 'assistant/message'; readonly seq: number; readonly time: number; readonly data: AssistantMessageData }
  | { readonly type: 'assistant/chunk'; readonly seq: number; readonly time: number; readonly data: AssistantChunkData };

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime;
    agents: AgentRegistry;
  }
}
