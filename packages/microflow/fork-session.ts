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
 * @module @meiyukichan/dsh-sandore/microflow/src/fork-session
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';
import { textSummary } from './internal.ts';
import { finalAssistantOutput } from './subagents.ts';
import { sessionEventList } from './session-events.ts';
import type { Agent, AgentHandle, AgentOptions, AgentSetup, AgentSetupContext, CreateAgentOptions } from './subagents.ts';

/**
 * 上游 child 组合原语的本地同语义实现（seam 版，见文件尾「上游适配」注释块）。
 *
 * **为何不直接 `import { applyChildComposition, ... } from '@deepseek-ai/dsh-subagent'`**
 * （实测结论）：静态 import 会把 dsh-subagent 的 d.ts（含其
 * `declare module '@deepseek-ai/cordis' { interface Context { subagents: ... } }` 增广）
 * 拉进类型程序；该增广与 sandore 接缝文件的同名 `subagents`/`agents` 成员合并后，
 * `ctx.subagents`/`ctx.agents` 全量被解析为 DSH 类型（DSH `Agent` 依赖 `session` 面
 * 与 sandore 接缝 Session 不兼容），破坏 step-runner/finalize-manager/workflow-engine
 * 全部接缝调用点的类型检查。故按仓库既有先例（`computeSafeRevertBoundary`/
 * `hasUnclosedTurnTail` 的上游复制注释）本地复刻上游原语，逐字段对齐上游源码
 * （packages/subagent/subagent/src/child-agent.ts / depth.ts，HEAD 72f523be1a），
 * 语义漂移由上游对照注释与单测锁定。
 *
 * 上游对照表（本文件本地实现 ← 上游原语）：
 * - {@link delegationDepthOfSeam} ← `delegationDepthOf`（depth.ts L28-36）
 * - {@link resolveChildDepthSeam} ← `resolveChildDepth`（child-agent.ts L49-58）
 * - {@link composeChildSessionMeta} ← `childSessionMeta`（child-agent.ts L138-156）
 * - {@link applyChildCompositionSeam} ← `applyChildComposition`（child-agent.ts
 *   L199-218，composition 恒 `{}`：persona 由 sandore 调用方承担；toolFilter 只用于
 *   架构决策 5 的 `send_message` 屏蔽——经 scoped `tools.restrict` 实施）
 * - {@link captureDelegatedPolicyOverridesSeam} ← `captureDelegatedPolicyOverrides`
 *   （child-agent.ts L242-247）
 * - {@link appendDelegatedPolicyOverridesSeam} ← `appendDelegatedPolicyOverrides`
 *   （child-agent.ts L258-268）
 * - {@link SUBAGENT_DELEGATION_CONTEXT} ← 同名常量（child-agent.ts L171-175，逐字）
 */

/** 上游 `SUBAGENT_DELEGATION_CONTEXT` 原文（delegation 域模型面声明，逐字对齐）。 */
const SUBAGENT_DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
  + 'widened from inside this session — operations that require approval are rejected automatically. '
  + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
  + 'limitation in your reply so the delegating agent can handle it.';

/** 上游 delegation 原语使用的 parent 结构面（`ctx.get` 取 sandboxPolicy/approval/agentPresets）。 */
type DshCtxReader = { readonly get?: (name: string) => unknown };

/**
 * 读上游 `delegationDepthOf`（depth.ts L28-36）：持久化 session header 权威且单调，
 * 运行时 `AgentOptions.subagentDepth` 只能加深不能降低（恢复的 child 以 header 计，
 * 防止从零重计后越权当作顶层代理再委派）。
 */
function delegationDepthOfSeam(parent: Agent): number {
  const options = parent.options as { readonly subagentDepth?: unknown };
  const runtime = options.subagentDepth;
  if (runtime !== undefined && (typeof runtime !== 'number' || !Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer');
  }
  const header = parent.session.header as { readonly delegationDepth?: unknown } | undefined;
  const persisted = header?.delegationDepth;
  return Math.max(typeof persisted === 'number' ? persisted : 0, typeof runtime === 'number' ? runtime : 0);
}

/**
 * 读上游 `resolveChildDepth`（child-agent.ts L49-58）：child 深度 = parent 深度 + 1，
 * safe-integer 越界抛 RangeError（sandore fork 路径不传 maxDepth 上限）。
 */
function resolveChildDepthSeam(parent: Agent): number {
  const childDepth = delegationDepthOfSeam(parent) + 1;
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range');
  }
  return childDepth;
}

/**
 * 读上游 `childSessionMeta`（child-agent.ts L138-156）：构造 child 会话的持久创建
 * 元数据——cwd 继承 parent header、agentPreset 记录 parent 的 live 组合（child 历史
 * 可重建的关键）、parentSession 直系血缘、isSeeded fork 标记、origin 分类、
 * delegationDepth 递归预算（须跨持久化存活）。meta 键对齐上游会话头合法集合
 * （cwd/parentSession/isSeeded/origin/delegationDepth/agentPreset——`seedLength`
 * 已被上游校验显式拒绝）。
 */
function composeChildSessionMeta(parent: Agent, childDepth: number, isSeeded: boolean): NonNullable<CreateAgentOptions['meta']> {
  const header = parent.session.header as
    | { readonly cwd?: string; readonly id?: string }
    | undefined;
  const presets = (parent.ctx as DshCtxReader | undefined)?.get?.('agentPresets') as
    | { readonly composedPreset?: (ctx: unknown) => string | undefined }
    | undefined;
  const agentPreset = presets?.composedPreset?.(parent.ctx);
  return {
    ...(header?.cwd !== undefined ? { cwd: header.cwd } : {}),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    parentSession: SessionId(header?.id ?? ''),
    isSeeded,
    // 导航分类标记（mode/续接能力以 descriptor 为权威，与上游注释一致）。
    origin: 'subagent',
    // 持久化字段：递归预算必须跨持久化与恢复存活。
    delegationDepth: childDepth,
  };
}

/** 上游 `DelegatedPolicyOverrides`（child-agent.ts L221-230）：delegation 边界注入 child 的策略。 */
interface DelegatedPolicyOverrides {
  /** parent 会话的显式 sandbox 模式覆盖（无覆盖为 undefined）。 */
  readonly sandboxMode: string | undefined;
  /** 有 approval 能力组合时固定 `'never'`（delegated child 只能在委派时确定的 scope 内行动），否则 undefined。 */
  readonly approvalPolicy: 'never' | undefined;
}

/**
 * 读上游 `captureDelegatedPolicyOverrides`（child-agent.ts L242-247）：child start
 * 首个 await 之前同步调用（晚到的 parent 切换属于 parent 的未来，不属于本 child）。
 * 只捕获 parent 会话的显式 sandbox 覆盖（部署默认值与一次性授权不捕获），approval
 * 一律钉 `'never'`。
 */
function captureDelegatedPolicyOverridesSeam(parent: Agent): DelegatedPolicyOverrides {
  const reader = parent.ctx as DshCtxReader | undefined;
  const sandboxPolicy = reader?.get?.('sandboxPolicy') as
    | { readonly overrideOf?: (session: unknown) => string | undefined }
    | undefined;
  return {
    sandboxMode: sandboxPolicy?.overrideOf?.(parent.session),
    approvalPolicy: reader?.get?.('approval') === undefined ? undefined : 'never',
  };
}

/**
 * 读上游 `appendDelegatedPolicyOverrides`（child-agent.ts L258-268）：把捕获的
 * delegation 策略以 `source: 'delegation'` 事件 append 到 child 未发布会话日志
 * （落在 fork seed 之后——fresh 策略覆盖 stale seed 态；child 后续切换仍覆盖这些事件）。
 */
function appendDelegatedPolicyOverridesSeam(session: AgentSetupContext['agent']['session'], overrides: DelegatedPolicyOverrides): void {
  if (overrides.sandboxMode !== undefined) {
    session.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' });
  }
  if (overrides.approvalPolicy !== undefined) {
    session.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' });
  }
}

/**
 * 读上游 `applyChildComposition`（child-agent.ts L199-218，composition = `{}` 分支）：
 * ① join parent preset（`childCtx.get('agentPresets')?.composeFrom(childCtx,
 * parent.ctx)`——无 preset 部署 `?.` 容忍）；② 注册 delegation 域模型面声明
 * （runtime-context contribution，非 system-prompt section——部署系统提示词在
 * parent/child 间保持一致）；③ 架构决策 5：把 `send_message` 从 child 工具集里
 * 移除（`childCtx.tools.restrict({deny:['send_message']})`，对齐 DSH child-agent.ts
 * L217 的 `childCtx.tools.restrict(composition.toolFilter)` 同一原语）。join 在前、
 * child 自有注册/限制在后（scope 就近遮蔽的层次语义，上游注释 L186-194）。
 *
 * `restrict` 的三处容错（缺一不可，否则最小部署会因缺工具而**致命失败**）：
 * ① `tools.restrict` 不存在（旧版/最小 agentCtx）→ 跳过；② 该 scope 内没有
 * `send_message` 全局工具时 DSH 会抛 `tools.restrict() names unknown global tool`
 * → 捕获并 warn（此时本就没有要屏蔽的工具，语义已达成）；③ 任何其他抛错同理只 warn。
 */
function applyChildCompositionSeam(childCtx: AgentSetupContext, parent: Agent): void {
  childCtx.get?.('agentPresets')?.composeFrom(childCtx, parent.ctx);
  childCtx.systemPrompt.context({
    name: 'subagent:delegation',
    order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: SUBAGENT_DELEGATION_CONTEXT,
  });
  const restrict = childCtx.tools.restrict;
  if (typeof restrict !== 'function') {
    return;
  }
  try {
    restrict.call(childCtx.tools, { deny: ['send_message'] });
  } catch {
    // 未注册全局 send_message 的部署：无工具可屏蔽，语义已达成（不阻断 child 创建）。
  }
}

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
    // 上游适配：meta 删 seedLength（会话头校验显式拒绝），改 `isSeeded: true` +
    // 顶层 `inheritedEventCount`（= 截断后 seed 长度，DSH `CreateSessionOptions` 契约）。
    const child = sessions.create(SessionId(childSessionId), {
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: SessionId(stepSessionId), isSeeded: true },
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
  /** 源 step id（合成 fork 会话 id 为纯 UUID，经 synthesizeFinalizeChildId 生成）。 */
  readonly stepId: string;
  /**
   * 子代理列表标题的 `<前缀> <名称>` 部分（引擎消费：创建后补写 `subagent/descriptor`
   * 身份事件，最终标题为 `<本值> · <childId>`；缺省 `finalize <stepId>`）。调用方应传
   * **可读的 step 名称**，避免列表出现 `step-<uuid>`。
   */
  readonly label?: string;
  /** 子代理工作目录（meta.cwd）。 */
  readonly cwd?: string;
  /** 取源会话完整事件（live → persistence 回退，由引擎注入；undefined = 无事件源）。 */
  readonly getEvents?: (childId: string) => Promise<readonly DshSessionEvent[] | undefined>;
  /** `ctx.agents.create` 的注入包装（未注入时返回 undefined 供调用方降级）。 */
  readonly createAgent?: (options: CreateAgentOptions) => Promise<AgentHandle>;
  /** 子代理的 provider/model（缺省时由宿主运行时按 parent options 解析）。 */
  readonly agentOptions?: AgentOptions;
  /**
   * 宿主主代理 Agent 对象——fork 子代理经 `agentPresets.composeFrom` 组合 preset
   * （继承宿主主代理工具集 + prompt sections，对齐 DSH `applyChildComposition`：
   * child-agent.ts L199-218「a child that joins no preset sees an empty tool registry」）
   * 的 parentCtx 来源（`opts.hostAgent.ctx`）。DSH 的 agent scope 工具是 scope-local
   * 注册、不自动继承 parent：缺省时 fork 子代理 tool registry 为空（仅 seed 历史注入、
   * 无工具），模型从 seed 历史学到的工具调用会报 unknown tool。
   */
  readonly hostAgent?: Agent;
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
 * 构造与上游 child 创建同型的 setup（delegation 策略注入 + child 组合）。
 *
 * 对齐上游 continuable/one-shot child 创建的固定形态（continuation.ts
 * `materializeTracked` setup 与 subagent-in-process-driver `startInProcessRun` setup）：
 * ① `appendDelegatedPolicyOverrides` 把 capture 的 delegation 策略 append 到 child
 * 未发布会话日志（fresh 策略覆盖 stale seed 态）；② `applyChildComposition` 组合
 * 宿主主代理 preset（继承工具集 + prompt sections——scope-local 注册不自动继承
 * parent，缺组合的 child 工具 registry 为空）并注册 delegation 运行时上下文声明。
 * `forkStepSubagent` 与 workflow-engine 的 retry `createAgent` 包装共用本工厂。
 *
 * capture 必须在 child start 首个 await 之前同步调用（上游契约：晚于首个 await 的
 * parent 切换属于 parent 的未来）——本工厂在调用方构造 create 实参时同步 capture，
 * setup 闭包内只做 append/apply。
 * @param hostAgent - 宿主主代理 Agent（child 的 parent）。
 * @returns `agents.create` 的 setup 回调。
 */
export function delegatedChildSetup(hostAgent: Agent): AgentSetup {
  // capture（同步，工厂调用点即 create 实参构造点，首个 await 之前——上游契约）。
  const policies = captureDelegatedPolicyOverridesSeam(hostAgent);
  return (agentCtx: AgentSetupContext): void => {
    appendDelegatedPolicyOverridesSeam(agentCtx.agent.session, policies);
    // composition 恒 `{}`：persona/toolFilter 由 `request` 层承载（sandore fork 子代理
    // 不做 per-child persona/toolFilter），此处仅做 preset 组合 + delegation 上下文。
    applyChildCompositionSeam(agentCtx, hostAgent);
  };
}

/**
 * 收尾真 fork：从 step 子代理的完整事件（live → persistence 回退）重建宿主主代理的
 * 子代理（Phase B `assessForked` / Phase C secondary gate 共用）。
 *
 * 流程：live/持久化取完整事件 → 截到最后一个闭合 turn/end（DSH seed 契约：balanced
 * completed-turn prefix、contiguous from seq 0、无 open turn/step 或 dangling tool
 * call）→ `ctx.agents.create({ sessionId: 合成 id, seed, meta, inheritedEventCount,
 * agentOptions, setup })`。
 *
 * meta（上游适配）：hostAgent 提供时经上游 `childSessionMeta(hostAgent,
 * resolveChildDepth(hostAgent, undefined), true)` 生成（cwd 继承宿主主代理 header，
 * delegationDepth 持久化，origin='subagent'，agentPreset 记录宿主组合）再覆盖
 * `cwd`（显式注入优先）与 `parentSession`（宿主主代理 id）；hostAgent 缺省（降级
 * 路径）保持既有 meta 形状但改 `isSeeded: true`（`seedLength` 已被上游会话头校验
 * 拒绝）。顶层 `inheritedEventCount = seed.length`。
 *
 * setup（hostAgent 提供时）：{@link delegatedChildSetup}（对齐上游 child 创建的
 * delegation 策略注入 + preset 组合；旧手写 `composeFrom` 调用已并入
 * `applyChildComposition`，不再单独调用）。缺省时不传 setup（向后兼容：无 preset
 * 组合，行为与既有路径一致）。
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
 * @param opts - 宿主主代理 id / stepId / cwd / 事件获取 / createAgent 包装 / agentOptions
 *   / hostAgent（提供时注入 delegatedChildSetup setup，继承宿主主代理工具集 + prompt
 *   sections）。
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
  // **不变量守卫（2026-09）**：本函数是**评估类 fork**（Phase B 收尾评估 / Phase D 路由
  // 判断）——它的 seed 源**必须**是某个 step 子代理会话（评估子代理据此看到该 step 的
  // 完整历史，属设计如此）；把**宿主主代理会话**当源会把主代理历史灌进执行子代理
  // （真机缺陷形态），故显式拒绝。
  if (stepSessionId === opts.hostAgentId) {
    throw new Error(
      `refusing to seed a fork from the host session '${stepSessionId}': `
      + 'execution subagents must be fresh; only a step subagent session may be a fork source',
    );
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
  // 局部 const 捕获：闭包内引用 const 才能保留 undefined 收窄。
  const hostAgent = opts.hostAgent;
  // meta：hostAgent 提供时经上游 childSessionMeta/resolveChildDepth 同语义实现生成再
  // 覆盖 cwd/parentSession；缺省（降级路径）保持既有形状（isSeeded 替代已删的 seedLength）。
  const meta: NonNullable<CreateAgentOptions['meta']> = hostAgent === undefined
    ? {
      cwd: opts.cwd ?? '/',
      parentSession: SessionId(opts.hostAgentId),
      isSeeded: true,
      origin: 'subagent',
    }
    : (() => {
      const generated = composeChildSessionMeta(hostAgent, resolveChildDepthSeam(hostAgent), true);
      return {
        ...generated,
        // 显式 cwd 优先；未提供时保留 childSessionMeta 继承自宿主主代理 header 的 cwd。
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        parentSession: SessionId(opts.hostAgentId),
      };
    })();
  // childId 用**纯 UUID**（`synthesizeFinalizeChildId` = `randomUUID()`），并把它拼进标签，
  // 使列表标题形如 `finalize 分析 · 34ef519c-…`（与 step 执行同款）。
  const childSessionId = synthesizeFinalizeChildId(opts.stepId);
  const handle = await opts.createAgent({
    sessionId: SessionId(childSessionId),
    seed,
    meta,
    inheritedEventCount: seed.length,
    ...(opts.agentOptions === undefined ? {} : { agentOptions: opts.agentOptions }),
    ...(hostAgent === undefined ? {} : { setup: delegatedChildSetup(hostAgent) }),
    // 子代理列表标签（引擎消费：补写 `subagent/descriptor` 身份事件，见
    // workflow/subagent-identity.ts）。`opts.label` 传 `<前缀> <名称>`，这里补上 childId，
    // 最终形如 `finalize 分析 · 34ef519c-…`。
    descriptorLabel: `${opts.label ?? `finalize ${opts.stepId}`} · ${childSessionId}`,
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
  return textSummary(finalAssistantOutput(sessionEventList(handle.agent.session)));
}
