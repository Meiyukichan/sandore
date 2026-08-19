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
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionMessage } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
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
    readonly inbox: {
        readonly hasPending: boolean;
    };
    readonly status: AgentStatus;
    readonly ctx: unknown;
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
/**
 * `AgentSetup` 回调的 agentCtx 最小面。
 *
 * 结构兼容 DSH 真实 agent scope Context：`tools.register`/`systemPrompt.section`
 * 为 sandore 直接使用的键；`agentPresets` 为可选服务面（无 preset 部署时为
 * undefined，`mount`/`resolve` 签名对齐 `@deepseek-ai/dsh-agent-presets`）。
 */
export interface AgentSetupContext {
    readonly tools: {
        register(tool: unknown): void;
    };
    readonly systemPrompt: {
        section(section: PromptSection): void;
    };
    /** agentPresets 服务最小面：挂载 preset 组合（§3.0 宿主主代理 = 纯 DSH 默认 preset）。 */
    readonly agentPresets?: {
        mount(agentCtx: AgentSetupContext, id?: string): Promise<unknown>;
        resolve(id?: string): Promise<{
            readonly id: string;
        }>;
        composeFrom(agentCtx: AgentSetupContext, parentCtx: unknown): string | undefined;
    };
}
/** 代理 setup 回调：在 mint agentCtx 后、发布前执行，可返回同步提交对象。 */
export type AgentSetup = (agentCtx: AgentSetupContext) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;
/** `ctx.agents.create` 的选项（sessionId + meta/seed/可选配置/取消/setup）。 */
export interface CreateAgentOptions {
    readonly sessionId: SessionId;
    readonly meta?: {
        readonly cwd?: string;
        readonly parentSession?: SessionId;
        readonly seedLength?: number;
        readonly origin?: 'subagent';
        readonly delegationDepth?: number;
        readonly agentPreset?: string;
    };
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
/** `followup` 的选项。 */
export interface SubagentFollowupOptions {
    readonly source: MessageSource;
    readonly signal: AbortSignal;
}
/** `interrupt` 的授权凭证。 */
export type SubagentInterruptAuthority = {
    readonly kind: 'user';
    readonly parentSessionId: SessionId;
} | {
    readonly kind: 'ancestor';
    readonly agent: Agent;
};
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
/** `listChildren` 返回的子代理条目（child/diagnostic 判别联合）。 */
export type SubagentListEntry = {
    readonly kind: 'child';
    readonly id: SessionId;
    readonly activity: 'running' | 'inactive';
    readonly hasChildren: boolean;
} & ({
    readonly mode: 'one-shot';
    readonly label?: string;
} | {
    readonly mode: 'continuable';
    readonly label: string;
}) | {
    readonly kind: 'diagnostic';
    readonly id: SessionId;
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable';
};
/** `ctx.subagents` 能力接缝：可续接子代理 + 一次性子代理。 */
export interface SubagentRuntime {
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
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
export type SessionEvent = {
    readonly type: 'assistant/message';
    readonly seq: number;
    readonly time: number;
    readonly data: AssistantMessageData;
} | {
    readonly type: 'assistant/chunk';
    readonly seq: number;
    readonly time: number;
    readonly data: AssistantChunkData;
} | {
    readonly type: 'user/message';
    readonly seq: number;
    readonly time: number;
    readonly data: UserMessageData;
} | {
    readonly type: 'tool/call';
    readonly seq: number;
    readonly time: number;
    readonly data: ToolCallData;
} | {
    readonly type: 'tool/result';
    readonly seq: number;
    readonly time: number;
    readonly data: ToolResultData;
};
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
    readonly message: {
        readonly content: readonly ContentBlock[];
    };
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
export declare function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined;
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
export declare function collectSessionMessages(events: readonly SessionEvent[]): SessionMessage[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        subagents: SubagentRuntime;
        agents: AgentRegistry;
    }
}
//# sourceMappingURL=subagents.d.ts.map