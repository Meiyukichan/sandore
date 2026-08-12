/**
 * opencode 协议类型定义（@meiyukichan/claude-sdk 适配层）
 *
 * 本文件以 furina/changes/claude-sdk-adapter/api.yaml 的 definitions 为权威口径，
 * 交叉参考 docs/sdk/openapi.json（目标协议）与 specs/**\/*.md 的字段约束。
 * 关键口径差异（以 api.yaml 为准）：
 * - SessionV2Info.cost 为 Cost 对象（total_cost_usd/currency），tokens 为 TokenUsage（全可选）；
 * - time 字段为 date-time 字符串（非 epoch 毫秒数）；
 * - SessionV2Info.id 保留 Claude SDK 原始 session_id（如 UUID），不做 ^ses 前缀转换（design.md D7）。
 */

/** 工作区 ID（^wrk 前缀）。 */
export type WorkspaceID = `wrk${string}`;

/** 消息 ID（^msg_ 前缀，归一化时生成）。 */
export type MessageID = `msg_${string}`;

/** 内容块 ID（^prt 前缀，归一化时生成）。 */
export type PartID = `prt_${string}`;

/** 事件 ID（^evt_ 前缀）。 */
export type EventID = `evt_${string}`;

/** 消息投递模式：steer=立即调度执行；queue=入队不执行（暂停语义）。适配层使用 queue。 */
export type Delivery = 'steer' | 'queue';

/** 会话历史消息类型（opencode SessionMessage 联合的 User/Assistant/System 子集）。 */
export type MessageType = 'user' | 'assistant' | 'system';

/** 模型状态。适配层默认 'active'。 */
export type ModelStatus = 'alpha' | 'beta' | 'deprecated' | 'active';

/** 工具调用状态状态值（openapi ToolState 联合的 status 判别）。 */
export type ToolStateStatus = 'pending' | 'running' | 'completed' | 'error';

/** 工具调用块状态（openapi ToolState 联合。适配层仅构造 completed 变体，字段为 subset：
 * status+input+time 核心必填；output/title 等需工具结果数据的字段暂缺）。 */
export type ToolState =
  | { status: 'pending'; input: unknown; raw: string }
  | { status: 'running'; input: unknown; title?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
  | { status: 'completed'; input: unknown; output?: unknown; title?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } }
  | { status: 'error'; input: unknown; error: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } };

/** 历史消息中工具调用块状态（openapi SessionMessageToolState 联合的简化 subset：
 * status 必填；input/content/structured 等可选——历史消息映射为适配层简化表示）。 */
export interface SessionMessageToolState {
  status: ToolStateStatus;
  input?: unknown;
  content?: unknown[];
  structured?: unknown;
  error?: unknown;
}

/** 权限申请回复（opencode permission.replied 的 reply 枚举）。 */
export type PermissionReply = 'once' | 'always' | 'reject';

/** 问题选项（opencode QuestionInfo.options 元素，AskUserQuestion 工具 input）。 */
export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

/** 问题信息（opencode QuestionInfo，question.asked 的 questions 元素）。 */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** 问题回复（question.replied 的 answers；question → 所选 label 或自由文本）。 */
export type QuestionAnswer = Record<string, string | string[]>;

/**
 * opencode 全局事件类型（适配层 SDKMessage → GlobalEvent 映射的子集，见 specs event-streaming）。
 * 权限申请/回复与问题提问/回复由 canUseTool 桥接产出（session-state.ts）。
 */
export type GlobalEventType =
  | 'session.created'
  | 'message.part.delta'
  | 'message.part.updated'
  | 'session.next.step.ended'
  | 'session.error'
  | 'session.idle'
  | 'permission.asked'
  | 'permission.replied'
  | 'question.asked'
  | 'question.replied';

/** 位置引用：标识会话/事件所属的项目目录。 */
export interface LocationRef {
  directory: string;
  workspaceID?: WorkspaceID;
}

/** 模型引用。providerID 本适配层固定为 'anthropic'。 */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/** Token 用量（api.yaml 单独定义；openapi 中为 SessionV2Info.tokens 内联对象）。 */
export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** 会话累计成本（api.yaml 单独定义；openapi 中 SessionV2Info.cost 为裸 number）。 */
export interface Cost {
  total_cost_usd?: number;
  currency?: string; // 默认 'USD'
}

/** 会话时间戳（date-time 字符串，非 epoch 毫秒）。 */
export interface SessionTime {
  created: string;
  updated: string;
  archived?: string;
}

/** 会话信息（opencode v2 会话对象，session.create 返回）。 */
export interface SessionV2Info {
  /** 会话 ID。保留 Claude SDK 原始 session_id（如 UUID），不做 ^ses 前缀转换（design.md D7）。 */
  id: string;
  parentID?: string;
  /** 项目 ID（由 cwd 编码生成）。 */
  projectID: string;
  /** agent 名称，如 general-purpose。 */
  agent?: string;
  model?: ModelRef;
  cost: Cost;
  tokens: TokenUsage;
  time: SessionTime;
  title: string;
  location: LocationRef;
  subpath?: string;
  revert?: Record<string, unknown>;
}

/** prompt 文件附件（uri 必填）。 */
export interface PromptInputFileAttachment {
  uri: string;
  name?: string;
  description?: string;
  source?: Record<string, unknown>;
}

/** prompt agent 附件（name 必填）。 */
export interface PromptAgentAttachment {
  name: string;
  source?: Record<string, unknown>;
}

/** 用户输入（session.prompt 的 prompt 载荷）。 */
export interface PromptInput {
  text: string;
  files?: PromptInputFileAttachment[];
  agents?: PromptAgentAttachment[];
}

/** 已入队的会话输入（session.prompt 返回）。 */
export interface SessionInputAdmitted {
  admittedSeq: number; // >= 0
  id: MessageID;
  sessionID: string;
  prompt: PromptInput;
  delivery: Delivery;
  timeCreated: string; // date-time
  promotedSeq?: number; // >= 0
}

/** 消息时间戳（date-time 字符串）。 */
export interface MessageTime {
  created?: string;
  completed?: string;
}

/** assistant 文本内容块。 */
export interface SessionMessageAssistantText {
  type: 'text';
  id: string;
  text: string;
}

/** assistant 推理内容块。 */
export interface SessionMessageAssistantReasoning {
  type: 'reasoning';
  id: string;
  text: string;
  providerMetadata?: Record<string, unknown>;
  time?: MessageTime;
}

/** assistant 工具调用内容块。 */
export interface SessionMessageAssistantTool {
  type: 'tool';
  id: string;
  name: string;
  provider?: string;
  state: SessionMessageToolState;
  time: MessageTime;
}

/** assistant 消息内容块联合。 */
export type SessionMessageAssistantContent =
  | SessionMessageAssistantText
  | SessionMessageAssistantReasoning
  | SessionMessageAssistantTool;

/** 会话历史消息（opencode SessionMessage 联合的 User/Assistant/System 子集）。 */
export interface SessionMessage {
  id: MessageID;
  type: MessageType;
  time?: MessageTime;
  /** user/system 消息文本。 */
  text?: string;
  /** assistant 消息内容块。 */
  content?: SessionMessageAssistantContent[];
  finish?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
}

/** 分页游标（不透明，previous/next 由适配层生成）。 */
export interface SessionMessagesCursor {
  previous?: string;
  next?: string;
}

/** 会话消息读取结果（session.messages 返回）。 */
export interface SessionMessagesResponse {
  data: SessionMessage[];
  cursor: SessionMessagesCursor;
}

/** 模型信息（opencode v2 模型对象；适配层仅要求 id/providerID/name/status 四项）。 */
export interface ModelV2Info {
  /** 模型 ID，映射自 ModelInfo.value。 */
  id: string;
  /** provider ID，本适配层固定 'anthropic'。 */
  providerID: string;
  family?: string;
  /** 显示名，映射自 ModelInfo.displayName。 */
  name: string;
  api?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /** 模型变体；resolvedModel（规范 wire id）保留于此。 */
  variants?: Array<Record<string, unknown>>;
  time?: { released?: string }; // date-time
  cost?: Array<Record<string, unknown>>;
  status: ModelStatus; // 默认 'active'
  enabled?: boolean; // 默认 true
  limit?: { context?: number; input?: number; output?: number };
}

/** 位置信息（model.list 返回，标识项目与 workspace）。 */
export interface LocationInfo {
  directory: string;
  workspaceID?: WorkspaceID;
  project: { id: string; directory: string };
}

/** 模型列表响应（model.list 返回）。 */
export interface ModelListResponse {
  location: LocationInfo;
  data: ModelV2Info[];
}

/** 文本内容块（opencode TextPart，message.part.updated 的 part 变体之一）。 */
export interface TextPart {
  id: PartID;
  sessionID: string;
  messageID: MessageID;
  type: 'text';
  text: string;
  time?: { start?: number; end?: number };
  metadata?: Record<string, unknown>;
}

/** 工具调用内容块（opencode ToolPart，message.part.updated 的 part 变体之一）。
 * 字段集以 docs/sdk/openapi.json 的 ToolPart 为口径（additionalProperties:false，无 input）；
 * 工具入参通过 metadata 携带（metadata: { input: <工具参数> }）。 */
export interface ToolPart {
  id: PartID;
  sessionID: string;
  messageID: MessageID;
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

/** 消息内容块联合（本适配层只产 TextPart 或 ToolPart）。 */
export type Part = TextPart | ToolPart;

/** 全局事件负载。 */
export interface GlobalEventPayload {
  id: EventID;
  type: GlobalEventType;
  properties: Record<string, unknown>;
}

/** 全局事件信封（适配层所有事件产出的统一结构）。 */
export interface GlobalEvent {
  directory?: string;
  project?: string;
  workspace?: string;
  payload: GlobalEventPayload;
}

/** 会话不存在错误。 */
export interface SessionNotFoundError {
  _tag: 'SessionNotFoundError';
  sessionID: string;
  message: string;
}

/** 超时错误（适配层自定义；用于 session.create 启动超时 / session.wait 超时）。 */
export interface TimeoutError {
  _tag: 'TimeoutError';
  message: string;
  timeoutMs?: number;
}

/** 无效请求错误。 */
export interface InvalidRequestError {
  _tag: 'InvalidRequestError';
  message: string;
  kind?: string;
  field?: string;
}

/** 适配层错误联合（以 _tag 字段判别）。 */
export type ClaudeSDKError = SessionNotFoundError | TimeoutError | InvalidRequestError;
