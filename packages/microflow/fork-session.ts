/**
 * fork 会话历史注入工具（fork-based 判断 + 上下文压缩共用）。
 *
 * 从当前 step 的子代理会话 fork 出一个分支，取 fork 会话的 derived LLM messages
 * （基于 surface 折叠的全量消息历史），供判断/压缩 LLM 请求作为 `messages` 前缀注入。
 * fork 失败（source 非 live / 合成 session / OPEN_TURN 等）返回 undefined（调用方降级）。
 *
 * **设计（fork-based 判断）**：判断不再手动传 I/O 文本——fork 会话携带全量历史，
 * AI 在 fork 会话上跑判断即可见全部 I/O（缺陷 2/4 的会话机制从「一次性临时会话 +
 * 手动传 I/O」改为「fork + 全量历史」）。DSH 契约：`GenerateOptions.sessionId` 只作
 * 路由戳记、不自动加载历史；历史加载是调用方职责——本工具把 `child.deriveMessages()`
 * 拼进 `llm.stream({ messages: [...history, judgePrompt] })`，实现「fork 全量历史注入」
 * （落地缺陷 24 的「完整注入 fork 会话历史」卡点）。
 *
 * **收尾真 fork（`forkStepSubagent`，定稿四阶段）**：Phase B 透传变量提取 / Phase C
 * secondary 门禁 / Phase D 路由判断（branch-evaluator 条件分支与循环跳出）不再
 * `sessions.fork`（DSH 子代理 settle 后 live store 已移除，`sessions.fork(childId)`
 * 必然 SESSION_NOT_FOUND，评估降级为无上下文临时会话）——改经 `ctx.agents.create({ seed })`
 * 从完整事件（live → `sessionPersistence.inspect` 回退）重建宿主主代理的子代理
 * （seed 契约：balanced completed-turn prefix），`followup` 驱动一轮（
 * {@link driveAgentRound}）。本函数即该路径的事件获取 + 闭合 turn 截断 + `agents.create`
 * 封装。
 *
 * **`forkStepSessionMessages`（持久化回退）**：作为「取 step 会话完整历史」的底层工具
 * 保留（live `sessions.get` 命中时维持 `sessions.fork`；live 无时经
 * `ctx.get('sessionPersistence')?.inspect(stepSessionId)` 读完整事件（参考 DSH
 * `inspectApiRemoteSession`，agent-lookup L94-111）→ 截到最后一个闭合 turn/end（balanced
 * prefix）→ `sessions.create(合成 id, { seed, meta })` 重建 fork 会话 → `deriveMessages()`），
 * 供既有调用/测试使用；分支/循环判断与上下文压缩的取历史路径已由 `forkStepSubagent` 的
 * `getStepSessionEvents`（engine 注入，live → inspect 回退）+ 闭合截断承担，不再直接经
 * `forkStepSessionMessages` 注入 messages 数组。
 * @module dsh-sandore/microflow/src/fork-session
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';
import { textSummary } from './internal.ts';
import { finalAssistantOutput } from './subagents.ts';
import type { AgentHandle, AgentOptions, CreateAgentOptions } from './subagents.ts';

/** fork 会话历史注入结果（derived messages + fork 会话 id）。 */
export interface ForkStepHistory {
  /**
   * fork 会话的 derived LLM messages（全量历史，surface 折叠后）。深冻结的共享消息对象，
   * 拼进 `llm.stream` 的 `messages` 数组作为历史前缀只读不改。
   */
  readonly messages: readonly Message[];
  /** fork 出的 child session id（作 LLM 请求 `sessionId` 戳记 + `sessionHandle`）。 */
  readonly forkSessionId: string;
}

/**
 * 合成分支判断 fork 会话 id（纯 UUID 格式，与 childId 保持一致）。
 */
function synthesizeJudgeChildId(_stepSessionId: string): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 经 `sessionPersistence.inspect` 读持久化会话完整事件（live 无时的回退读路径）。
 *
 * 对齐 DSH `inspectApiRemoteSession`（agent-lookup L94-111）：`ctx.get('sessionPersistence')`
 * 可选，缺失/无 `inspect` 方法/读取出错均返回 undefined（调用方降级）。
 * @param ctx - 宿主上下文（可选 `sessionPersistence` 服务）。
 * @param stepSessionId - 待读持久化会话 id。
 * @returns 持久化完整事件，读不到时 undefined。
 */
async function readPersistedEvents(
  ctx: Context,
  stepSessionId: string,
): Promise<readonly DshSessionEvent[] | undefined> {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) {
    return undefined;
  }
  try {
    const inspected = await persistence.inspect?.(SessionId(stepSessionId));
    return inspected === undefined ? undefined : [...inspected.events];
  } catch {
    return undefined;
  }
}

/**
 * fork step 会话并取其 derived LLM messages 全量历史（fork-based 判断的会话机制核心）。
 *
 * **live 优先**：`ctx.sessions.get(stepSessionId)` 命中（真实子代理 live store 仍可读）
 * 时维持现有 `sessions.fork`（boundary 省略取源末事件 seq；源会话闭合时全量历史）；
 * **持久化回退**：live 无（DSH 子代理 settle 后 live store 已移除，`sessions.fork` 必然
 * SESSION_NOT_FOUND）时经 `sessionPersistence.inspect` 读完整事件 → 截到最后一个闭合
 * turn/end（balanced prefix，复用 `computeSafeRevertBoundary`/`hasUnclosedTurnTail`）→
 * `sessions.create(合成 id, { seed, meta })` 重建 fork 会话 → `deriveMessages()`。
 *
 * 任一步失败（`sessions` 未注册 / live 与持久化均无事件 / 无闭合 turn 可截 / 重建抛错）
 * 返回 undefined（调用方降级为一次性临时会话，不传历史）。省略或空串直接返回 undefined。
 *
 * 返回的 `messages` 是 fork 会话截至 fork 点的全量 derived 历史——判断 AI 据此可见当前
 * step 的完整输入输出与工具调用轨迹，无需调用方手动拼装 I/O 文本。
 */
export async function forkStepSessionMessages(
  ctx: Context,
  stepSessionId: string | undefined,
): Promise<ForkStepHistory | undefined> {
  if (stepSessionId === undefined || stepSessionId === '') {
    return undefined;
  }
  const sessions = ctx.get('sessions');
  if (sessions === undefined) {
    return undefined;
  }
  // 1) live 优先：源会话仍在 live store（未 settle）→ 维持现有 sessions.fork。
  try {
    if (sessions.get(SessionId(stepSessionId)) !== undefined) {
      const child = sessions.fork(SessionId(stepSessionId));
      return { messages: child.deriveMessages(), forkSessionId: child.id };
    }
  } catch {
    return undefined;
  }
  // 2) 持久化回退：live 无（子代理 settle 后 live store 已移除）→ inspect 读完整事件 →
  //    截到最后一个闭合 turn/end → sessions.create 重建 fork 会话（随 fiber 卸载回收）。
  try {
    const events = await readPersistedEvents(ctx, stepSessionId);
    if (events === undefined || events.length === 0) {
      return undefined;
    }
    // 截到最后一个闭合 turn/end：尾部未闭合时取最后一个 turn/end 前缀（含端点）；
    // 尾部已闭合（或全无 turn 边界）时全量事件即 balanced prefix。无任何闭合 turn
    // 可截时返回 undefined 供调用方降级（不失败）。
    let seed: readonly DshSessionEvent[];
    if (hasUnclosedTurnTail(events)) {
      const boundary = computeSafeRevertBoundary(events);
      if (boundary === undefined) {
        return undefined;
      }
      seed = events.filter(event => event.seq <= boundary);
    } else {
      seed = events;
    }
    const childSessionId = synthesizeJudgeChildId(stepSessionId);
    const child = sessions.create(SessionId(childSessionId), {
      seed,
      meta: { parentSession: SessionId(stepSessionId), seedLength: seed.length },
    });
    return { messages: child.deriveMessages(), forkSessionId: child.id };
  } catch {
    return undefined;
  }
}

/**
 * seed 截断只需读的事件最小结构（`type`/`seq` 包络；DSH 全量 `SessionEvent` 结构兼容）。
 */
interface SeedBoundaryEvent {
  readonly type: string;
  readonly seq: number;
}

/**
 * 计算最后一个闭合 turn 的末事件 seq（复制自 workflow recovery-manager 的
 * `computeSafeRevertBoundary`，L115-123——microflow 不引入 workflow 运行时依赖，
 * 两个 10 行小函数直接复制并保持语义一致；来源见 recovery-manager.ts）。
 *
 * 事件流中 `turn/end` 标记一个闭合 turn 的结束；若事件流无任何 `turn/end`（整个
 * 会话处于未闭合 turn），返回 `undefined`（调用方降级临时会话，不失败）。
 * @param events - 子代理会话事件流（含 `turn/start`/`turn/end` 边界事件）。
 * @returns 最后一个闭合 turn 的末事件 seq，或无法取到合法闭合 turn 时为 `undefined`。
 */
export function computeSafeRevertBoundary(events: readonly SeedBoundaryEvent[]): number | undefined {
  let lastClosedTurnEndSeq: number | undefined;
  for (const event of events) {
    if (event.type === 'turn/end') {
      lastClosedTurnEndSeq = event.seq;
    }
  }
  return lastClosedTurnEndSeq;
}

/**
 * 判定会话事件流尾部是否存在未闭合 turn（复制自 workflow recovery-manager 的
 * `hasUnclosedTurnTail`，L135-143；来源同上）。
 *
 * DSH seed 契约要求 balanced completed-turn prefix：末事件落在未闭合 turn 内
 * （最后 turn 边界为 `turn/start` 而非 `turn/end`）时，必须截到最后一个闭合
 * `turn/end` 才能作为 `agents.create` 的 seed。
 * @param events - 子代理会话事件流（含 `turn/start`/`turn/end` 边界事件）。
 * @returns 末事件落在未闭合 turn 内为 true。
 */
export function hasUnclosedTurnTail(events: readonly SeedBoundaryEvent[]): boolean {
  let lastTurnBoundaryType: string | undefined;
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      lastTurnBoundaryType = event.type;
    }
  }
  return lastTurnBoundaryType === 'turn/start';
}

/** `forkStepSubagent` 的选项（引擎/管理器注入的能力与上下文）。 */
export interface ForkStepSubagentOptions {
  /** 宿主主代理 session id（meta.parentSession：fork 子代理作为宿主主代理的子代理）。 */
  readonly hostAgentId: string;
  /** 源 step id（合成 fork 会话 id 前缀：`finalize-{stepId}-{random}`）。 */
  readonly stepId: string;
  /** 子代理工作目录（meta.cwd）。 */
  readonly cwd?: string;
  /** 取源会话完整事件（live → persistence 回退，由引擎注入；undefined = 无事件源）。 */
  readonly getEvents?: (childId: string) => Promise<readonly DshSessionEvent[] | undefined>;
  /** `ctx.agents.create` 的注入包装（未注入时返回 undefined 供调用方降级）。 */
  readonly createAgent?: (options: CreateAgentOptions) => Promise<AgentHandle>;
  /** 子代理的 provider/model（缺省时由宿主运行时按 parent options 解析）。 */
  readonly agentOptions?: AgentOptions;
}

/** `forkStepSubagent` 的结果：重建的宿主子代理句柄 + 截断后的 seed 事件前缀。 */
export interface ForkStepSubagentResult {
  readonly handle: AgentHandle;
  /** 截到最后一个闭合 turn/end 的 seed 事件前缀（含端点；尾部已闭合时为全量）。 */
  readonly events: readonly DshSessionEvent[];
}

/**
 * 合成收尾评估 fork 会话 id（纯 UUID 格式，与 childId 保持一致）。
 */
function synthesizeFinalizeChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 收尾真 fork：从 step 子代理的完整事件（live → persistence 回退）重建宿主主代理的
 * 子代理（Phase B `assessForked` / Phase C secondary gate 共用）。
 *
 * 流程：live/持久化取完整事件 → 截到最后一个闭合 turn/end（DSH seed 契约：balanced
 * completed-turn prefix、contiguous from seq 0、无 open turn/step 或 dangling tool
 * call）→ `ctx.agents.create({ sessionId: 合成 id, seed, meta: { cwd, parentSession:
 * 宿主主代理 id, seedLength, origin: 'subagent' }, agentOptions })`。
 *
 * 返回 undefined 的降级条件（调用方降级临时会话并记 errorDetail，Step 不失败）：
 * - `stepSessionId` 省略/空串；
 * - `createAgent` 未注入（配置缺省）；
 * - 事件源缺失（getEvents 未注入 / 返回 undefined / 空事件流——shell 合成会话无事件）；
 * - 事件流存在未闭合尾部且无任何闭合 turn 可截（无法构造安全 seed）。
 *
 * `agents.create` 自身抛错（session 校验/发布失败）原样冒泡，由调用方捕获降级。
 * @param ctx - microflow 上下文（`ctx.agents.create` 经 `opts.createAgent` 注入）。
 * @param stepSessionId - 源 step 子代理会话 id（live 已移除时从持久化 inspect 读）。
 * @param opts - 宿主主代理 id / stepId / cwd / 事件获取 / createAgent 包装 / agentOptions。
 * @returns 重建的宿主子代理句柄 + 截断 seed；不可安全 fork 时为 undefined。
 */
export async function forkStepSubagent(
  ctx: Context,
  stepSessionId: string | undefined,
  opts: ForkStepSubagentOptions,
): Promise<ForkStepSubagentResult | undefined> {
  if (stepSessionId === undefined || stepSessionId === '') {
    return undefined;
  }
  if (opts.createAgent === undefined) {
    return undefined;
  }
  const events = opts.getEvents === undefined
    ? undefined
    : await opts.getEvents(stepSessionId);
  if (events === undefined || events.length === 0) {
    return undefined;
  }
  // 截到最后一个闭合 turn/end：尾部未闭合时取最后一个 turn/end 前缀（含端点）；
  // 尾部已闭合（或全无 turn 边界）时全量事件即 balanced prefix。无任何闭合 turn
  // 可截时返回 undefined 供调用方降级（不失败）。
  let seed: readonly DshSessionEvent[];
  if (hasUnclosedTurnTail(events)) {
    const boundary = computeSafeRevertBoundary(events);
    if (boundary === undefined) {
      return undefined;
    }
    seed = events.filter(event => event.seq <= boundary);
  } else {
    seed = events;
  }
  const handle = await opts.createAgent({
    sessionId: SessionId(synthesizeFinalizeChildId(opts.stepId)),
    seed,
    meta: {
      cwd: opts.cwd ?? '/',
      parentSession: SessionId(opts.hostAgentId),
      seedLength: seed.length,
      origin: 'subagent',
    },
    ...(opts.agentOptions === undefined ? {} : { agentOptions: opts.agentOptions }),
  });
  return { handle, events: seed };
}

/**
 * 驱动宿主子代理跑一轮并收集最终输出文本（收尾真 fork 的公共驱动循环）。
 *
 * Phase B 收尾（`assessForked`）、Phase D 路由判断（branch-evaluator 条件/循环跳出）与
 * Phase C secondary 门禁共用：`followup(createUserMessage(...))` 排队续接轮次并唤醒驱动
 * （消息经 DSH `createUserMessage` 补全 id/role，对齐 `Agent.followup(message: UserMessage)`
 * 契约）→ `whenIdle()` 等整代理静止 → `finalAssistantOutput(agent.session.events)` 取最后
 * 一条非空 assistant 输出 → `textSummary` 归一为纯文本（供 JSON 解析器消费）。
 * 子代理句柄的 `dispose()` 由调用方负责（评估完即删）。
 * @param handle - `agents.create` 返回的宿主子代理句柄。
 * @param promptText - 评估提示词（收尾 JSON / 路由判断 / 门禁审查）。
 * @returns 子代理最终输出文本（无输出时为空串，由解析器回落）。
 */
export async function driveAgentRound(handle: AgentHandle, promptText: string): Promise<string> {
  handle.agent.followup(createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: promptText }],
  }));
  await handle.agent.whenIdle();
  return textSummary(finalAssistantOutput(handle.agent.session.events));
}
