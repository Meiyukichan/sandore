/**
 * 会话管理（SessionManager）—— @meiyukichan/claude-sdk 适配层（session-01）
 *
 * 维护 Map<sessionId, SessionState>（design.md D2/D7 决策），把 Claude SDK 一体化的
 * query() AsyncGenerator 拆解为 opencode 协议风格的三段式会话方法：
 *   - create()：后台启动 query()；提供 firstMessage 时立即调度为首条输入、捕获 system/init 的 session_id 后
 *     resolve 真实 SessionV2Info；缺省时返回占位 SessionV2Info（id 为 ses_<uuid>），会话 pending，首个 prompt 触发
 *     init 后按真实 id 回填（design.md D2.1，SDK 仅在首条用户消息 yield 后才产出 init 的契约）；
 *   - messages()：包装 getSessionMessages()，返回 SessionMessagesResponse{data, cursor}；
 *   - prompt()：向该会话输入队列 push SDKUserMessage，返回 Promise<SessionInputAdmitted>；pending 状态等待 init
 *     捕获真实 session_id（超时抛 TimeoutError），created 状态直接使用真实 id；
 *   - interrupt()：调用 Query.interrupt()（空闲会话 no-op）；
 *   - wait()：基于 session_state_changed/result 事件驱动等待空闲（支持 timeout）；
 *   - events()：订阅会话原始 SDKMessage 事件流（回放型通道，event-01 据此归一化 GlobalEvent）；
 *   - close()：关闭 Query、结束事件通道并从 Map 清理。
 *
 * 关键口径：SessionV2Info.id 保留 Claude 原始 session_id（D7，不做 ^ses 前缀转换）；占位 id 在 created 后保留为
 * 别名键（resolveSessionId 归一化），location.directory 取客户端 cwd；projectID 由 cwd 编码生成；
 * prompt 的 message ID 以 msg_ 前缀生成。
 */
import {
  deleteSession,
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionMessagesOptions,
  GetSubagentMessagesOptions,
  ListSubagentsOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SessionMessage as SDKStoredMessage,
  SessionMutationOptions,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { SessionNotFoundError, SessionState } from './session-state.js';
import type {
  QueryFactory,
  RespondPermissionInput,
  RespondQuestionInput,
  SessionPhase,
  ToolAuthMode,
} from './session-state.js';
import type {
  Delivery,
  GlobalEvent,
  LocationRef,
  MessageID,
  ModelRef,
  PromptInput,
  SessionInputAdmitted,
  SessionMessage,
  SessionMessageAssistantContent,
  SessionMessagesResponse,
  SessionV2Info,
} from './types.js';

/** 会话创建参数（client.session.create 入参）。 */
export interface CreateSessionOptions {
  /** 会话模型（ModelRef.id 透传给 query() options.model）。 */
  model?: ModelRef;
  /** agent 名称，透传给 query() options.agent。 */
  agent?: string;
  /** 位置引用；省略时使用客户端 cwd 作为默认 location。 */
  location?: LocationRef;
  /** 会话工作目录；省略时使用客户端 cwd。 */
  cwd?: string;
  /** 首条用户消息（design.md D2.1）。提供时 create() 立即调度为首条输入、捕获真实 session_id 后 resolve 完整信息；
   * 缺省时返回占位 SessionV2Info（id 为 ses_<uuid>），会话 pending，首个 prompt() 触发 init 后回填真实 id。 */
  firstMessage?: string;
  /** system/init 捕获超时毫秒数（覆盖 SessionManager 默认）。 */
  initTimeoutMs?: number;
  /** 允许的工具白名单（透传给 query options.allowedTools）。 */
  allowedTools?: string[];
  /** 禁止的工具黑名单（透传给 query options.disallowedTools）。 */
  disallowedTools?: string[];
  /** 权限模式：default 触发受限工具权限（配合 canUseTool 桥接）；acceptEdits/bypassPermissions 自动放行。 */
  permissionMode?: PermissionMode;
  /** 自定义系统提示词（string 或 string 数组）。 */
  systemPrompt?: string | string[];
  /** 单回合最大轮数。 */
  maxTurns?: number;
  /** 扩展思考配置。 */
  thinking?: ThinkingConfig;
  /** 权限/问题桥接开关；缺省启用。disabled 时不注入 canUseTool。 */
  toolAuth?: ToolAuthMode;
}

/** 会话消息读取参数（对应 opencode v2 的 limit + cursor + order）。 */
export interface SessionMessagesOptions {
  /** 返回消息条数上限。 */
  limit?: number;
  /** 不透明分页游标（本适配层编码为 offset:<n>）。 */
  cursor?: string;
  /** 排序方向（默认 asc）。 */
  order?: 'asc' | 'desc';
}

/** 会话消息发送参数（client.session.prompt 入参）。 */
export interface SessionPromptInput {
  /** 用户输入。 */
  prompt: PromptInput;
  /** 投递模式（本适配层当前固定 queue 语义）。 */
  delivery?: Delivery;
  /** 是否调度执行（当前为入队不执行）。 */
  resume?: boolean;
}

/** 会话空闲等待参数。 */
export interface SessionWaitOptions {
  /** 超时毫秒数；缺省为永不超时。 */
  timeout?: number;
}

/** 获取会话历史消息的函数（依赖注入点，默认 Claude SDK getSessionMessages）。 */
export type GetSessionMessagesFn = (
  sessionId: string,
  options?: GetSessionMessagesOptions,
) => Promise<SDKStoredMessage[]>;

/** 分叉会话函数（依赖注入点，默认 Claude SDK forkSession；design.md D13/D1）。 */
export type ForkSessionFn = (
  sessionId: string,
  options?: ForkSessionOptions,
) => Promise<ForkSessionResult>;

/** 删除会话函数（依赖注入点，默认 Claude SDK deleteSession；design.md D13/D6）。 */
export type DeleteSessionFn = (
  sessionId: string,
  options?: SessionMutationOptions,
) => Promise<void>;

/** 列出子 Agent 函数（依赖注入点，默认 Claude SDK listSubagents；design.md D13/D7）。 */
export type ListSubagentsFn = (
  sessionId: string,
  options?: ListSubagentsOptions,
) => Promise<string[]>;

/** 获取子 Agent 消息函数（依赖注入点，默认 Claude SDK getSubagentMessages；design.md D13/D7）。 */
export type GetSubagentMessagesFn = (
  sessionId: string,
  agentId: string,
  options?: GetSubagentMessagesOptions,
) => Promise<SDKStoredMessage[]>;

/** SessionManager 构造参数。 */
export interface SessionManagerOptions {
  /** 客户端工作目录（会话创建默认 location 与 getSessionMessages 的 dir）。 */
  cwd: string;
  /** 创建 Query 的工厂（默认 Claude SDK query）。 */
  queryFn?: QueryFactory;
  /** 获取会话历史消息的函数（默认 Claude SDK getSessionMessages）。 */
  getSessionMessagesFn?: GetSessionMessagesFn;
  /** 分叉会话函数（默认 Claude SDK forkSession）。 */
  forkSessionFn?: ForkSessionFn;
  /** 删除会话函数（默认 Claude SDK deleteSession）。 */
  deleteSessionFn?: DeleteSessionFn;
  /** 列出子 Agent 函数（默认 Claude SDK listSubagents）。 */
  listSubagentsFn?: ListSubagentsFn;
  /** 获取子 Agent 消息函数（默认 Claude SDK getSubagentMessages）。 */
  getSubagentMessagesFn?: GetSubagentMessagesFn;
  /** system/init 捕获默认超时毫秒数。 */
  initTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** 分页游标前缀（offset 编码）。 */
const CURSOR_PREFIX = 'offset:';

/**
 * 会话管理：维护 Map<sessionId, SessionState>，对外提供 create/messages/prompt/interrupt/wait/events/close。
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly cwd: string;
  private readonly queryFn: QueryFactory;
  private readonly getSessionMessagesFn: GetSessionMessagesFn;
  private readonly forkSessionFn: ForkSessionFn;
  private readonly deleteSessionFn: DeleteSessionFn;
  private readonly listSubagentsFn: ListSubagentsFn;
  private readonly getSubagentMessagesFn: GetSubagentMessagesFn;
  private readonly initTimeoutMs: number;

  constructor(options: SessionManagerOptions) {
    this.cwd = options.cwd;
    this.queryFn = options.queryFn ?? query;
    this.getSessionMessagesFn = options.getSessionMessagesFn ?? getSessionMessages;
    this.forkSessionFn = options.forkSessionFn ?? forkSession;
    this.deleteSessionFn = options.deleteSessionFn ?? deleteSession;
    this.listSubagentsFn = options.listSubagentsFn ?? listSubagents;
    this.getSubagentMessagesFn = options.getSubagentMessagesFn ?? getSubagentMessages;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  }

  /** 创建新会话：提供 firstMessage 时捕获真实 session_id 后 resolve；缺省时返回占位信息（pending）。 */
  async create(options: CreateSessionOptions = {}): Promise<SessionV2Info> {
    const directory = options.location?.directory ?? options.cwd ?? this.cwd;
    const placeholderId = makePlaceholderSessionId();
    const state = new SessionState({
      queryFn: this.queryFn,
      cwd: directory,
      agent: options.agent,
      model: options.model?.id,
      initTimeoutMs: options.initTimeoutMs ?? this.initTimeoutMs,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode,
      systemPrompt: options.systemPrompt,
      maxTurns: options.maxTurns,
      thinking: options.thinking,
      toolAuth: options.toolAuth,
      onInit: (sessionId) => {
        // pending→created：以真实 session_id 登记（占位 id 保留为别名，兼容已持有占位 id 的调用方）。
        this.sessions.set(sessionId, state);
      },
      onClose: () => {
        this.sessions.delete(placeholderId);
        const realId = state.sessionId;
        if (realId !== undefined) {
          this.sessions.delete(realId);
        }
      },
    });

    const firstMessage = options.firstMessage;
    if (firstMessage !== undefined) {
      // 提供 firstMessage：立即调度为首条用户消息 → init 触发 → 捕获真实 session_id 后 resolve 完整信息。
      state.push(makeUserMessage(firstMessage));
      let sessionId: string;
      try {
        sessionId = await state.waitForInit();
      } catch (error) {
        state.close();
        throw error;
      }
      this.sessions.set(sessionId, state);
      return this.buildInfo(sessionId, directory, options);
    }

    // 未提供 firstMessage：返回占位 SessionV2Info（id 为 ses_<uuid>），会话 pending，首个 prompt 触发 init 后回填。
    this.sessions.set(placeholderId, state);
    return this.buildInfo(placeholderId, directory, options);
  }

  /** 读取会话历史消息（包装 getSessionMessages，返回 {data, cursor}）。 */
  async messages(
    sessionId: string,
    options: SessionMessagesOptions = {},
  ): Promise<SessionMessagesResponse> {
    const state = this.getState(sessionId);
    // 占位别名（ses_<uuid>）非真实 Claude session_id，须解析为真实 id 再调 getSessionMessages（D2.1）。
    const resolvedId = state.sessionId ?? sessionId;
    const limit = options.limit;
    const offset = decodeCursor(options.cursor);
    const order = options.order ?? 'asc';
    const stored = await this.getSessionMessagesFn(resolvedId, {
      dir: state.directory,
      limit: limit === undefined ? undefined : limit + 1,
      offset,
      // SDK 默认过滤 system 消息（向后兼容），spec 要求 data 含 user/assistant/system，须显式包含。
      includeSystemMessages: true,
    });

    let data = stored.map(mapStoredMessage);
    if (order === 'desc') {
      data = [...data].reverse();
    }
    const hasNext = limit !== undefined && stored.length > limit;
    return {
      data: limit === undefined ? data : data.slice(0, limit),
      cursor: {
        previous:
          limit !== undefined && offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : undefined,
        next: hasNext ? encodeCursor(offset + limit) : undefined,
      },
    };
  }

  /** 向会话输入队列 push SDKUserMessage，返回 Promise<SessionInputAdmitted>（id 以 msg_ 前缀生成）。
   * pending 状态（未捕获 init）等待首个 prompt 触发 init 捕获真实 session_id，超时抛 TimeoutError；
   * created 状态立即使用真实 session_id。 */
  async prompt(sessionId: string, input: SessionPromptInput): Promise<SessionInputAdmitted> {
    const state = this.getState(sessionId);
    const admittedSeq = state.push(makeUserMessage(input.prompt.text));
    const timeCreated = new Date().toISOString();
    const realSessionId = await state.waitForInit();
    return {
      admittedSeq,
      id: makeMessageId(),
      sessionID: realSessionId,
      prompt: input.prompt,
      delivery: input.delivery ?? 'queue',
      timeCreated,
    };
  }

  /** 中断会话当前执行；空闲会话为 no-op。 */
  async interrupt(sessionId: string): Promise<void> {
    const state = this.getState(sessionId);
    await state.interrupt();
  }

  /** 等待会话 agent loop 空闲（事件驱动）；支持 timeout，超时抛 TimeoutError。 */
  async wait(sessionId: string, options: SessionWaitOptions = {}): Promise<void> {
    const state = this.getState(sessionId);
    await state.waitForIdle(options.timeout);
  }

  /** 订阅会话原始 SDKMessage 事件流（回放型通道，晚订阅回放已发生消息；不存在会话抛 SessionNotFoundError）。 */
  events(sessionId: string): AsyncIterable<SDKMessage> {
    const state = this.getState(sessionId);
    return state.events;
  }

  /** 订阅会话控制事件流（permission.asked/question.asked 等桥接产出的 GlobalEvent，回放型）。 */
  controlEvents(sessionId: string): AsyncIterable<GlobalEvent> {
    const state = this.getState(sessionId);
    return state.controlEvents;
  }

  /** 回复挂起的权限申请（canUseTool 桥接）：requestID 为 permission.asked 的 properties.id。 */
  respondPermission(sessionId: string, input: RespondPermissionInput): void {
    const state = this.getState(sessionId);
    state.respondPermission(input);
  }

  /** 回复挂起的问题提问（AskUserQuestion 桥接）：requestID 为 question.asked 的 properties.id。 */
  respondQuestion(sessionId: string, input: RespondQuestionInput): void {
    const state = this.getState(sessionId);
    state.respondQuestion(input);
  }

  /** 关闭会话：关闭 Query、结束事件通道并从 Map 移除。 */
  close(sessionId: string): void {
    const state = this.getState(sessionId);
    state.close();
    this.sessions.delete(sessionId);
  }

  /** 关闭全部会话（客户端销毁时清理）。 */
  closeAll(): void {
    for (const state of this.sessions.values()) {
      state.close();
    }
    this.sessions.clear();
  }

  /** 解析会话 ID：占位别名映射到真实 session_id（created 后）；未创建（或不存在）返回原值。 */
  resolveSessionId(sessionId: string): string {
    const state = this.sessions.get(sessionId);
    return state?.sessionId ?? sessionId;
  }

  /** 返回会话生命周期阶段（pending/created）；不存在会话抛 SessionNotFoundError。 */
  getPhase(sessionId: string): SessionPhase {
    return this.getState(sessionId).phase;
  }

  /** 返回会话工作目录（事件归一化 directory 的来源）；不存在会话抛 SessionNotFoundError。 */
  getDirectory(sessionId: string): string {
    return this.getState(sessionId).directory;
  }

  private getState(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return state;
  }

  /** 构造 SessionV2Info（占位与真实 id 共用；id 由调用方给定）。 */
  private buildInfo(
    sessionId: string,
    directory: string,
    options: CreateSessionOptions,
  ): SessionV2Info {
    const now = new Date().toISOString();
    return {
      id: sessionId,
      projectID: encodeProjectID(directory),
      agent: options.agent,
      model: options.model,
      cost: {},
      tokens: {},
      time: { created: now, updated: now },
      title: '',
      location: { directory },
    };
  }
}

/** 由 cwd 编码生成 projectID（确定性：路径段 ASCII 保留，非 ASCII 按字节转 %XX，段以 - 连接）。 */
function encodeProjectID(directory: string): string {
  const separator = directory.includes('\\') ? '\\' : '/';
  const segments = directory.split(separator);
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    encoded.push(
      segment.replace(/[^A-Za-z0-9-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`),
    );
  }
  return encoded.join('-');
}

/** 解码不透明游标为 offset（非法/缺省游标回退 0）。 */
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || !cursor.startsWith(CURSOR_PREFIX)) return 0;
  const parsed = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** 将 offset 编码为不透明游标。 */
function encodeCursor(offset: number): string {
  return `${CURSOR_PREFIX}${offset}`;
}

/** 生成 msg_ 前缀的消息 ID（design.md D7：归一化时生成，本适配层直接产出）。 */
function makeMessageId(): MessageID {
  // 模板字面量拼接可确保 ^msg_ 前缀，断言收窄为 MessageID。
  // 使用 Web Crypto 全局 randomUUID（Node 24 可用），避免引入 @types/node 依赖。
  return `msg_${crypto.randomUUID()}` as MessageID;
}

/** 构造用户输入 SDKUserMessage（prompt/firstMessage 共用，design.md D2.1 的 SDKUserMessage 形状）。 */
function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

/** 生成占位会话 ID（ses_ 前缀，符合 opencode ID pattern；未提供 firstMessage 时 create 先返回占位）。 */
function makePlaceholderSessionId(): string {
  return `ses_${crypto.randomUUID()}`;
}

/** 判断对象是否为 Record<string, unknown>。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 将 Claude SDK getSessionMessages() 返回的 SessionMessage 映射为 opencode SessionMessage：
 * uuid→id（加 msg_ 前缀）、提取 text/content、time 等未提供字段缺省。
 */
function mapStoredMessage(stored: SDKStoredMessage): SessionMessage {
  const base = {
    id: `msg_${stored.uuid}` as MessageID,
    type: stored.type,
  };
  switch (stored.type) {
    case 'user':
      return { ...base, text: extractText(stored.message) };
    case 'assistant':
      return { ...base, content: extractAssistantContent(stored.message) };
    default:
      return { ...base, text: extractSystemText(stored.message) };
  }
}

/** 提取 user 消息文本（MessageParam.content 为字符串或内容块数组）。 */
function extractText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === 'string') {
    return content === '' ? undefined : content;
  }
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter(isRecord)
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text);
    return textBlocks.length > 0 ? textBlocks.join('\n') : undefined;
  }
  return undefined;
}

/** 提取 assistant 消息内容块（text/reasoning/tool 联合映射）。 */
function extractAssistantContent(message: unknown): SessionMessageAssistantContent[] | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const result: SessionMessageAssistantContent[] = [];
  for (const block of message.content.filter(isRecord)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({
        type: 'text',
        id: typeof block.id === 'string' ? block.id : '',
        text: block.text,
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      result.push({
        type: 'reasoning',
        id: typeof block.id === 'string' ? block.id : '',
        text: block.thinking,
      });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      result.push({
        type: 'tool',
        id: typeof block.id === 'string' ? block.id : '',
        name: block.name,
        state: { status: 'completed', input: block.input },
        time: {},
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

/** 提取 system 消息文本（compact boundary 等信息性消息的 text 字段）。 */
function extractSystemText(message: unknown): string | undefined {
  if (isRecord(message) && typeof message.text === 'string' && message.text !== '') {
    return message.text;
  }
  return undefined;
}
