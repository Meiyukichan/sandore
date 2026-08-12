/**
 * 事件系统（GlobalEventManager）—— @meiyukichan/claude-sdk 适配层（event-01）
 *
 * 将 Claude SDK query() 产出的原始 SDKMessage 流归一化为 opencode 协议的 GlobalEvent 信封：
 *   - system/init                    → session.created（properties 含 sessionID + info）
 *   - stream_event text_delta        → message.part.delta（field:'text'）
 *   - stream_event input_json_delta  → message.part.delta（field:'tool_input'）
 *   - assistant 完整消息每个内容块   → message.part.updated（part: TextPart | ToolPart，time 为 epoch 毫秒）
 *   - result success                 → session.next.step.ended（finish/cost/tokens）
 *   - result error                   → session.error
 *   - system session_state_changed idle → session.idle
 * 无对应 opencode 事件类型的 SDKMessage 静默跳过（不产出事件）。
 *
 * 会话级视图 sessionEvents(sessionId) 订阅 SessionManager.events(sessionId) 的原始回放通道并归一化；
 * 全局视图 global.event({directory}) 只产出匹配 directory 的事件（省略时用客户端 cwd），
 * 两者共享同一套归一化逻辑（design.md D4）。事件 ID 以 evt_ 前缀生成（design.md D7）。
 */
import type { NonNullableUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { SessionManager } from './session';
import type {
  EventID,
  GlobalEvent,
  MessageID,
  Part,
  PartID,
  TextPart,
  ToolPart,
} from './types';

/** GlobalEventManager 构造参数。 */
export interface GlobalEventManagerOptions {
  /** 会话管理器（提供 create/events 等会话级操作）。 */
  sessions: SessionManager;
  /** 客户端工作目录（global.event 省略 directory 时的默认过滤值）。 */
  cwd: string;
}

/** 全局事件订阅参数。 */
export interface GlobalEventOptions {
  /** 项目目录过滤条件；省略时默认用客户端 cwd。 */
  directory?: string;
}

/**
 * 事件管理：提供会话级（sessionEvents）与全局（global）两类 GlobalEvent 视图。
 * 会话注册（registerSession）后其归一化事件被投递到内部全局回放通道，global.event 按 directory 过滤。
 */
export class GlobalEventManager {
  private readonly sessions: SessionManager;
  private readonly cwd: string;
  private readonly directories = new Map<string, string>();
  private readonly channel = new GlobalChannel();
  private readonly consuming = new Set<string>();

  constructor(options: GlobalEventManagerOptions) {
    this.sessions = options.sessions;
    this.cwd = options.cwd;
  }

  /** 注册一个会话到全局视图：记录其 directory 并开始投递该会话的归一化事件。 */
  registerSession(sessionId: string, directory: string): void {
    this.directories.set(sessionId, directory);
    if (this.consuming.has(sessionId)) {
      return;
    }
    this.consuming.add(sessionId);
    void this.feedGlobal(sessionId);
  }

  /** 返回该会话归一化后的 AsyncIterable<GlobalEvent>；会话不存在抛 SessionNotFoundError。
   * 合并 SDKMessage 归一化流（session.created、message.part.delta/updated、step.ended 等）与控制事件流
   * （permission.asked、question.asked 等 canUseTool 桥接产出）。 */
  sessionEvents(sessionId: string): AsyncIterable<GlobalEvent> {
    // pending→created 后调用方可能以真实 session_id 订阅（design.md D2.1）：目录先查注册表，
    // 未命中则经 SessionManager 解析占位别名并回退到会话自身目录，保证真实 id 也能取到 directory。
    const resolved = this.sessions.resolveSessionId(sessionId);
    const directory = this.directories.get(sessionId) ?? this.sessions.getDirectory(resolved);
    // 同步查找会话：SessionManager.events 对不存在会话抛 SessionNotFoundError。
    const raw = this.sessions.events(sessionId);
    const control = this.sessions.controlEvents(sessionId);
    return mergeAsyncIterables(this.normalize(raw, directory), control);
  }

  /** 返回全局事件流；只产出匹配 directory 的事件（省略时用客户端 cwd），GlobalEvent.directory 等于过滤值。 */
  global(options: GlobalEventOptions = {}): AsyncIterable<GlobalEvent> {
    const directory = options.directory ?? this.cwd;
    return this.filterByDirectory(directory);
  }

  /** 关闭全局通道：终止所有 global.event 订阅（客户端销毁时调用）。 */
  close(): void {
    this.channel.close();
  }

  /** 归一化原始 SDKMessage 流为 GlobalEvent 流（每次调用使用全新的流式状态）。 */
  private async *normalize(
    raw: AsyncIterable<SDKMessage>,
    directory: string | undefined,
  ): AsyncGenerator<GlobalEvent> {
    const normalizer = new StreamNormalizer();
    for await (const message of raw) {
      for (const event of normalizer.handle(message, directory)) {
        yield event;
      }
    }
  }

  /**
   * 后台消费某会话的归一化事件并投递到全局通道；会话事件流结束（关闭/自然终止）时随之结束。
   * 结束时（finally）清理该会话的 directory 记录与消费标记，避免长生命周期客户端无界累积（M3）。
   */
  private async feedGlobal(sessionId: string): Promise<void> {
    try {
      for await (const event of this.sessionEvents(sessionId)) {
        this.channel.write(event);
      }
    } catch {
      // 会话中途被关闭或原始通道终止时，该会话的全局投递随之结束，无需向消费者抛出。
    } finally {
      this.directories.delete(sessionId);
      this.consuming.delete(sessionId);
    }
  }

  /** 全局通道按 directory 过滤产出。 */
  private async *filterByDirectory(directory: string): AsyncGenerator<GlobalEvent> {
    for await (const event of this.channel.subscribe()) {
      if (event.directory === directory) {
        yield event;
      }
    }
  }
}

/**
 * 流式归一化上下文：逐条 SDKMessage 映射为 GlobalEvent 数组。
 * 维护跨消息的流式状态（当前 messageID / 按内容块序号捕获的 partID），供 message.part.delta 使用（D7 前缀生成）。
 * partID 按内容块数组序号关联：content_block_start 捕获 prt_<index>，assistant 完整消息按同序号复用，
 * 保证 delta 与 message.part.updated 的 partID 一致（M2：消费方以 partID 为键合并 delta）。
 */
class StreamNormalizer {
  private messageIdValue: string | undefined;
  /** 按内容块序号捕获的 partID；稀疏数组，未捕获序号为 undefined（assistant 时回退生成）。 */
  private partIdValues: Array<PartID | undefined> = [];
  /**
   * 跨消息工具调用状态：callID → 对应 tool part 定位与工具元信息（partID/sessionID/messageID/name/input）。
   * assistant 的 tool_use 块产出 running 态 part 后登记，后续 user 消息的 tool_result
   * （tool_use_id 匹配）到达时更新同一 partID 为 completed/error（openapi "part 更新"语义）。
   */
  private readonly pendingTools = new Map<
    string,
    { partID: PartID; sessionID: string; messageID: MessageID; name: string; input: unknown }
  >();

  /** 将一条 SDKMessage 归一化为 0..n 条 GlobalEvent；无对应类型返回空数组（静默跳过）。 */
  handle(message: SDKMessage, directory: string | undefined): GlobalEvent[] {
    switch (message.type) {
      case 'system':
        return this.handleSystem(message, directory);
      case 'stream_event':
        return this.handleStreamEvent(message, directory);
      case 'assistant':
        return this.handleAssistant(message, directory);
      case 'user':
        return this.handleToolResult(message, directory);
      case 'result':
        return this.handleResult(message, directory);
      default:
        // status / task_notification / hook_* 等：无对应 opencode 事件类型，静默跳过。
        return [];
    }
  }

  private handleSystem(
    message: Extract<SDKMessage, { type: 'system' }>,
    directory: string | undefined,
  ): GlobalEvent[] {
    if (message.subtype === 'init') {
      return [
        makeEvent('session.created', {
          sessionID: message.session_id,
          info: buildSessionInfo(message),
        }, directory),
      ];
    }
    if (message.subtype === 'session_state_changed' && message.state === 'idle') {
      return [makeEvent('session.idle', { sessionID: message.session_id }, directory)];
    }
    // compact_boundary / permission_denied 等其它 system 子类型：无对应事件，静默跳过。
    return [];
  }

  private handleStreamEvent(
    message: Extract<SDKMessage, { type: 'stream_event' }>,
    directory: string | undefined,
  ): GlobalEvent[] {
    const event = message.event;
    switch (event.type) {
      case 'message_start':
        // message_start 携带消息级 ID（BetaMessage.id，Anthropic 已是 ^msg_ 前缀）。
        // 新一轮消息：内容块序号从 0 重新计，清空上一轮捕获的 partID。
        this.messageIdValue = asMessageId(event.message.id);
        this.partIdValues = [];
        return [];
      case 'content_block_start':
        // content_block_start 的 index 作为 partID 来源（^prt 前缀生成）。
        this.partIdValues[event.index] = makePartIdFromIndex(event.index);
        return [];
      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          return [
            makeEvent('message.part.delta', {
              sessionID: message.session_id,
              messageID: this.currentMessageId(),
              partID: this.currentPartId(event.index),
              field: 'text',
              delta: delta.text,
            }, directory),
          ];
        }
        if (delta.type === 'input_json_delta') {
          return [
            makeEvent('message.part.delta', {
              sessionID: message.session_id,
              messageID: this.currentMessageId(),
              partID: this.currentPartId(event.index),
              field: 'tool_input',
              delta: delta.partial_json,
            }, directory),
          ];
        }
        // thinking_delta / citations_delta 等增量：无对应事件，静默跳过。
        return [];
      }
      default:
        // content_block_stop / message_delta / message_stop：无增量事件，静默跳过。
        return [];
    }
  }

  private handleAssistant(
    message: Extract<SDKMessage, { type: 'assistant' }>,
    directory: string | undefined,
  ): GlobalEvent[] {
    const events: GlobalEvent[] = [];
    const messageID = asMessageId(message.message.id);
    const parsed = message.timestamp !== undefined ? Date.parse(message.timestamp) : NaN;
    const time = Number.isNaN(parsed) ? Date.now() : parsed;
    const content = message.message.content;
    for (let i = 0; i < content.length; i++) {
      // 按内容块数组序号复用流式阶段捕获的 partID，使 updated 与 delta 的 partID 一致（M2）。
      const block = content[i];
      if (block.type === 'tool_use') {
        // tool_use：产出 running 态 part，并登记 callID→partID，供后续 tool_result 更新为 completed/error。
        const partID = this.partIdValues[i] ?? makePartId();
        this.pendingTools.set(block.id, {
          partID,
          sessionID: message.session_id,
          messageID,
          name: block.name,
          input: block.input,
        });
        const part: ToolPart = {
          id: partID,
          sessionID: message.session_id,
          messageID,
          type: 'tool',
          callID: block.id,
          tool: block.name,
          state: {
            status: 'running',
            input: block.input,
            title: extractToolTitle(block),
            time: { start: time },
          },
          metadata: { input: block.input },
        };
        events.push(
          makeEvent('message.part.updated', { sessionID: message.session_id, part, time }, directory),
        );
        continue;
      }
      const part = mapContentBlock(block, message.session_id, messageID, this.partIdValues[i], time);
      if (part !== undefined) {
        events.push(
          makeEvent('message.part.updated', { sessionID: message.session_id, part, time }, directory),
        );
      }
    }
    return events;
  }

  /**
   * 处理 user 消息中的 tool_result 块：按 tool_use_id 匹配先前登记的 tool part，
   * 产出更新后的 message.part.updated（state: completed/error，含 output/title/time.end）。
   * 未匹配到 pending tool（如权限拒绝/时序异常）时静默跳过。
   */
  private handleToolResult(
    message: Extract<SDKMessage, { type: 'user' }>,
    directory: string | undefined,
  ): GlobalEvent[] {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const events: GlobalEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const pending = this.pendingTools.get(block.tool_use_id);
      if (pending === undefined) continue;
      this.pendingTools.delete(block.tool_use_id);
      const { partID, sessionID, messageID, name, input } = pending;
      const parsedTime = message.timestamp !== undefined ? Date.parse(message.timestamp) : NaN;
      const endTime = Number.isNaN(parsedTime) ? Date.now() : parsedTime;
      const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      const state: ToolPart['state'] = block.is_error
        ? { status: 'error', input, error: output, time: { end: endTime } }
        : { status: 'completed', input, output, title: name, time: { end: endTime } };
      const part: ToolPart = {
        id: partID,
        sessionID,
        messageID,
        type: 'tool',
        callID: block.tool_use_id,
        tool: name,
        state,
      };
      events.push(makeEvent('message.part.updated', { sessionID, part, time: endTime }, directory));
    }
    return events;
  }

  private handleResult(
    message: Extract<SDKMessage, { type: 'result' }>,
    directory: string | undefined,
  ): GlobalEvent[] {
    if (message.subtype === 'success') {
      return [
        makeEvent('session.next.step.ended', {
          sessionID: message.session_id,
          finish: message.stop_reason ?? 'end_turn',
          cost: message.total_cost_usd,
          tokens: mapTokens(message.usage),
        }, directory),
      ];
    }
    return [
      makeEvent('session.error', {
        sessionID: message.session_id,
        error: {
          name: message.subtype,
          message: message.errors.join('; ') || `session ended with error: ${message.subtype}`,
        },
      }, directory),
    ];
  }

  /** 当前 messageID（message_start 捕获；缺失时生成）。 */
  private currentMessageId(): MessageID {
    if (this.messageIdValue === undefined) {
      this.messageIdValue = makeMessageId();
    }
    return this.messageIdValue as MessageID;
  }

  /** 指定内容块序号的 partID（content_block_start 捕获；缺失时生成并记录）。 */
  private currentPartId(index: number): PartID {
    const captured = this.partIdValues[index];
    if (captured !== undefined) {
      return captured;
    }
    const generated = makePartId();
    this.partIdValues[index] = generated;
    return generated;
  }
}

/** 由内容块序号生成 partID（^prt 前缀 + index，供 delta 与 updated 共用）。 */
function makePartIdFromIndex(index: number): PartID {
  // 模板字面量拼接保证 ^prt 前缀，断言收窄为 PartID（设计.md D7）。
  return `prt_${index}` as PartID;
}

/** 提取工具标题（tool_use 块无顶层 title，取 input.description 或工具名作为展示标题）。 */
function extractToolTitle(block: { name: string; input: unknown }): string | undefined {
  const input = block.input;
  if (
    typeof input === 'object' &&
    input !== null &&
    'description' in input &&
    typeof (input as { description?: unknown }).description === 'string'
  ) {
    const description = (input as { description: string }).description;
    if (description !== '') {
      return description;
    }
  }
  return block.name;
}

/**
 * 将 assistant 文本内容块映射为 TextPart；无对应类型（thinking 等）返回 undefined。
 * tool_use 块由 handleAssistant 单独处理（running 态 part + pendingTools 登记，供 tool_result 更新）。
 * partId 为流式阶段按内容块序号捕获的 ID（缺失时生成），保证与 delta 的 partID 一致（M2）。
 */
function mapContentBlock(
  block: Extract<SDKMessage, { type: 'assistant' }>['message']['content'][number],
  sessionID: string,
  messageID: MessageID,
  partId: PartID | undefined,
  _time: number,
): Part | undefined {
  if (block.type !== 'text') {
    // thinking 等无对应 GlobalEvent 的内容块，静默跳过。
    return undefined;
  }
  return {
    id: partId ?? makePartId(),
    sessionID,
    messageID,
    type: 'text',
    text: block.text,
  };
}

/** 由 result success 的 usage 映射 tokens（input/output/cache，非零才产出）。 */
function mapTokens(usage: NonNullableUsage): Record<string, unknown> {
  const tokens: Record<string, unknown> = {};
  if (usage.input_tokens > 0) {
    tokens.input = usage.input_tokens;
  }
  if (usage.output_tokens > 0) {
    tokens.output = usage.output_tokens;
  }
  const cache: Record<string, unknown> = {};
  if (usage.cache_read_input_tokens > 0) {
    cache.read = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens > 0) {
    cache.write = usage.cache_creation_input_tokens;
  }
  if (Object.keys(cache).length > 0) {
    tokens.cache = cache;
  }
  return tokens;
}

/** 由 init 消息构造 session.created 的 info（SessionV2Info 口径，location.directory=cwd）。 */
function buildSessionInfo(
  message: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: message.session_id,
    projectID: encodeProjectID(message.cwd),
    cost: {},
    tokens: {},
    time: { created: now, updated: now },
    title: '',
    location: { directory: message.cwd },
  };
}

/** 构造 GlobalEvent 信封（payload.id 以 evt_ 前缀生成）。 */
function makeEvent(
  type: GlobalEvent['payload']['type'],
  properties: Record<string, unknown>,
  directory: string | undefined,
): GlobalEvent {
  const event: GlobalEvent = {
    directory,
    payload: {
      // 模板字面量拼接保证 ^evt_ 前缀，断言收窄为 EventID。
      id: `evt_${crypto.randomUUID()}` as EventID,
      type,
      properties,
    },
  };
  return event;
}

/** 生成 msg_ 前缀的消息 ID。 */
function makeMessageId(): MessageID {
  // 模板字面量拼接保证 ^msg_ 前缀，断言收窄为 MessageID（设计.md D7）。
  return `msg_${crypto.randomUUID()}` as MessageID;
}

/** 生成 prt_ 前缀的内容块 ID。 */
function makePartId(): PartID {
  // 模板字面量拼接保证 ^prt 前缀，断言收窄为 PartID（设计.md D7）。
  return `prt_${crypto.randomUUID()}` as PartID;
}

/** 归一化消息 ID：Anthropic 的 BetaMessage.id 已是 ^msg_ 前缀，缺失时补前缀。 */
function asMessageId(id: string): MessageID {
  return (id.startsWith('msg_') ? id : `msg_${id}`) as MessageID;
}

/** 合并流的结束标记。 */
const MERGE_DONE = Symbol('merge-done');
/** 合并流的错误标记（携带原因）。 */
const MERGE_ERROR = Symbol('merge-error');

/**
 * 合并两个 AsyncIterable 为一个：两端并发拉取，事件按到达顺序入队产出；两者都结束后终止。
 * 用于 sessionEvents 合并 SDKMessage 归一化流与控制事件流（两个回放通道均缓冲全部事件，
 * 并发拉取保证任一端挂起时另一端的事件仍被消费——顺序拉取会在 A 挂起时饿死 B）。
 * 任一端抛错：向消费者抛出，并终止另一端。
 */
async function* mergeAsyncIterables<T>(
  a: AsyncIterable<T>,
  b: AsyncIterable<T>,
): AsyncGenerator<T> {
  const itA = a[Symbol.asyncIterator]();
  const itB = b[Symbol.asyncIterator]();
  const queue: Array<T | typeof MERGE_DONE | { [MERGE_ERROR]: unknown }> = [];
  let waiters: Array<() => void> = [];
  let doneA = false;
  let doneB = false;
  let aborted = false;

  const notify = (): void => {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  };

  const feed = async (
    it: AsyncIterator<T>,
    markDone: (v: boolean) => void,
  ): Promise<void> => {
    try {
      while (!aborted) {
        const { value, done } = await it.next();
        if (done) break;
        queue.push(value);
        notify();
      }
    } catch (error) {
      queue.push({ [MERGE_ERROR]: error });
      notify();
      aborted = true;
      return;
    } finally {
      markDone(true);
      queue.push(MERGE_DONE);
      notify();
    }
  };

  void feed(itA, (v) => { doneA = v; });
  void feed(itB, (v) => { doneB = v; });

  while (true) {
    if (aborted) return;
    if (queue.length === 0) {
      if (doneA && doneB) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
      continue;
    }
    const item = queue.shift() as T | typeof MERGE_DONE | { [MERGE_ERROR]: unknown };
    if (typeof item === 'symbol' && item === MERGE_DONE) {
      if (doneA && doneB) return;
      continue;
    }
    if (item !== null && typeof item === 'object' && MERGE_ERROR in item) {
      aborted = true;
      throw item[MERGE_ERROR];
    }
    yield item as T;
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

// ---------------------------------------------------------------------------
// 全局事件回放通道（有界 buffer：晚订阅者从剩余缓冲回放；已消费前缀及时释放；
// 无订阅者或 close 后缓冲清空——避免长生命周期客户端无界累积，M3）
// ---------------------------------------------------------------------------

/**
 * 全局事件回放型广播通道。
 * buffer 为有界回放缓冲：事件自写入起保留，直到被所有活跃订阅者消费（trim 释放已消费前缀）；
 * 无订阅者时缓冲立即释放；close 后各订阅者终止并清空缓冲。语义边界：仅保留有订阅者期间的
 * 未消费事件，过早的离线事件不回放（与 ReplayChannel 的回放窗口一致，但不再跨客户端生命周期累积）。
 */
class GlobalChannel {
  private readonly buffer: GlobalEvent[] = [];
  private readonly subscribers = new Set<GlobalSubscriber>();
  /** 已从 buffer 释放的逻辑事件前缀数（buffer[i] 对应逻辑事件 dropped+i）。 */
  private dropped = 0;
  private closed = false;

  write(event: GlobalEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    for (const subscriber of this.subscribers) {
      subscriber.notify();
    }
    this.trim();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers) {
      subscriber.end();
    }
    this.subscribers.clear();
    this.release();
  }

  /** 订阅全局事件流（每次调用返回新订阅，从剩余缓冲回放；close 后订阅立即终止）。 */
  subscribe(): AsyncIterable<GlobalEvent> {
    const subscriber = new GlobalSubscriber(this.buffer, () => this.dropped);
    if (this.closed) {
      subscriber.end();
    } else {
      this.subscribers.add(subscriber);
    }
    const channel = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* subscriber.iterate();
        } finally {
          channel.subscribers.delete(subscriber);
          channel.trim();
        }
      },
    };
  }

  /** 释放已被全部活跃订阅者消费的前缀；无订阅者时清空整个缓冲。 */
  private trim(): void {
    if (this.subscribers.size === 0) {
      this.release();
      return;
    }
    let oldest = Infinity;
    for (const subscriber of this.subscribers) {
      if (subscriber.cursor < oldest) {
        oldest = subscriber.cursor;
      }
    }
    if (oldest > this.dropped) {
      const released = oldest - this.dropped;
      this.buffer.splice(0, released);
      this.dropped = oldest;
    }
  }

  /** 清空缓冲并复位释放前缀计数。 */
  private release(): void {
    this.buffer.length = 0;
    this.dropped = 0;
  }
}

/** 单个全局订阅者：共享通道 buffer、各自持有逻辑游标，notify/end 唤醒挂起的迭代。 */
class GlobalSubscriber {
  private readonly buffer: GlobalEvent[];
  private readonly droppedFn: () => number;
  private index = 0;
  private ended = false;
  private readonly waiters: Array<() => void> = [];

  constructor(buffer: GlobalEvent[], droppedFn: () => number) {
    this.buffer = buffer;
    this.droppedFn = droppedFn;
  }

  /** 下一个待消费的逻辑事件位置（含已释放前缀，供通道 trim 判定）。 */
  get cursor(): number {
    return this.index;
  }

  notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  async *iterate(): AsyncGenerator<GlobalEvent> {
    while (true) {
      const dropped = this.droppedFn();
      if (this.index < dropped) {
        // 订阅晚于缓冲释放：跳到当前最早可用位置，丢失已释放前缀。
        this.index = dropped;
      }
      const offset = this.index - dropped;
      if (offset < this.buffer.length) {
        yield this.buffer[offset] as GlobalEvent;
        this.index++;
      } else if (this.ended) {
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
          // 注册后再检查一次，避免 write 与 wait 之间的唤醒竞态。
          if (this.index - this.droppedFn() < this.buffer.length || this.ended) {
            const idx = this.waiters.indexOf(resolve);
            if (idx >= 0) this.waiters.splice(idx, 1);
            resolve();
          }
        });
      }
    }
  }
}
