/**
 * 内存 mock agents（测试专用，非发布面）。
 *
 * 提供 `get`/`create`/`resume` 等价语义，`FakeAgent` 携带 `whenIdle` 与
 * `session.events`（`assistant/message`、`assistant/chunk` 事件快照），并附带事件
 * 构造助手供 `finalAssistantOutput` 测试使用。以 `ctx.provide('agents', …)` 注入。
 * @module @meiyukichan/dsh-sandore/workflow/tests/mocks/agents
 */
import { createAssistantMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session';

import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentRegistry,
  AgentSetup,
  AgentSetupContext,
  AgentStatus,
  CreateAgentOptions,
  ResumeAgentOptions,
  Session,
  SessionEvent,
  SessionId,
} from '../../microflow/subagents';
import { FakeSessionStore } from './sessions.ts';

/** 记录事件的最小 Session 形状。 */
export class FakeSession implements Session {
  readonly events: SessionEvent[] = [];
  /** 会话 header（父会话/工作目录；askFromSubagent 反查 ActiveInstance 用）。 */
  header: Session['header'];

  constructor(header?: Session['header']) {
    this.header = header;
  }

  append(event: SessionEvent): void {
    this.events.push(event);
  }
}

/** 构造一条 `assistant/message` 事件。 */
export function assistantMessageEvent(content: ContentBlock[], seq = 0, time = 0): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 0,
      step: 0,
      message: createAssistantMessage({ content, source: { provider: 'mock', model: 'mock' } }),
    },
  };
}

/** 构造一条 `assistant/chunk`（text-delta）事件。 */
export function assistantChunkEvent(text: string, seq = 0, time = 0): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time,
    data: {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text },
    },
  };
}

/** 内存 mock Agent：`followup` 按 `followupHandler` 追加 assistant 回复；`whenIdle` 立即 resolve。 */
export class FakeAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: FakeSession;
  readonly inbox: { hasPending: boolean };
  readonly ctx: unknown;
  status: AgentStatus = 'idle';
  /** 记录每次 `followup` 的入参（content + source）。 */
  readonly followups: Array<{ content: ContentBlock[]; source?: unknown }> = [];
  /** `whenIdle` 被 await 的次数（Phase B/C 收尾真 fork 的驱动断言）。 */
  whenIdleCount = 0;
  /**
   * `followup` 的回复钩子：返回非空 ContentBlock[] 时追加一条 `assistant/message`
   * 事件（供 `finalAssistantOutput` 读取）；返回 undefined 时只记录不追加。
   */
  followupHandler?: (content: ContentBlock[]) => ContentBlock[] | undefined;

  /**
   * 构造可选自定义 ctx（默认 undefined；fork 子代理 preset 组合测试以可识别对象
   * 断言 `composeFrom` 的 parentCtx === hostAgent.ctx 透传）。
   */
  constructor(id: SessionId, options: AgentOptions = {}, session?: FakeSession, ctxValue: unknown = undefined) {
    this.id = id;
    this.options = options;
    this.session = session ?? new FakeSession();
    this.inbox = { hasPending: false };
    this.ctx = ctxValue;
  }

  followup(message: { content: ContentBlock[]; source?: unknown }): void {
    this.followups.push({ content: message.content, source: message.source });
    const reply = this.followupHandler?.(message.content);
    if (reply !== undefined && reply.length > 0) {
      this.session.append(assistantMessageEvent(reply, this.session.events.length, Date.now()));
    }
  }

  async whenIdle(): Promise<void> {
    this.whenIdleCount += 1;
    // mock：无驱动活动，立即 idle。
  }
}

/** 内存 mock AgentRegistry：`get`/`create`/`resume` + 显式注册。 */
export class FakeAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<SessionId, FakeAgent>();
  /** 每次 `create` 记录的 `meta.cwd`（用于断言 setup/meta 回放）。 */
  readonly createCwds: Array<string | undefined> = [];
  /** 每次 `create` 记录的完整 `meta`（收尾真 fork 的 parentSession/origin/isSeeded 断言）。 */
  readonly createMetas: Array<CreateAgentOptions['meta']> = [];
  /** 每次 `create` 记录的顶层 `inheritedEventCount`（上游 fork 契约断言：>0 须 isSeeded）。 */
  readonly createInheritedEventCounts: Array<number | undefined> = [];
  /** 每次 `create` 记录的 `seed`（revert/fork 的 fork 前缀回放断言）。 */
  readonly createSeeds: Array<readonly DshSessionEvent[] | undefined> = [];
  /**
   * 每次 `create` 记录的 `setup` 入参（fork 子代理 preset 组合 setup 注入断言；
   * 未注入为 undefined——hostAgent 缺省的向后兼容断言数据源）。
   */
  readonly createSetups: Array<AgentSetup | undefined> = [];
  /**
   * setup 执行期 `agentPresets.composeFrom` 的调用记录（agentCtx + parentCtx）：
   * fork 子代理 setup 经 `applyChildComposition`（内部 `childCtx.get('agentPresets')`
   * → composeFrom）组合宿主主代理 preset 的断言数据源（parentCtx 应 === hostAgent.ctx）。
   */
  readonly composeFromCalls: Array<{ agentCtx: AgentSetupContext; parentCtx: unknown }> = [];
  /**
   * setup 执行期 `systemPrompt.context` 的调用记录（applyChildComposition 注册
   * `subagent:delegation` 运行时上下文的断言数据源）。
   */
  readonly systemPromptContexts: Array<{ agentCtx: AgentSetupContext; declaration: { name: string; order: number; text: string } }> = [];
  /**
   * setup 执行期 `agent.session.append`（delegation 策略事件注入）的调用记录
   * （appendDelegatedPolicyOverrides 断言数据源；缺省策略为空时不产生记录）。
   */
  readonly setupPolicyAppends: Array<{ type: string; data: unknown }> = [];
  /** 每次 `create` 生成的 FakeAgent（供断言 followup/whenIdle 驱动）。 */
  readonly createdAgents: FakeAgent[] = [];
  /** 每次 `create`/`resume` 执行 `setup` 回调的次数。 */
  setupCount = 0;
  /** 若设置，`runSetup` 抛出该错误（模拟 setup 抛错回滚）。 */
  setupError?: Error;
  /** 若设置，`create` 抛出该错误（模拟收尾真 fork 的 agents.create 失败）。 */
  createError?: Error;
  /**
   * 每次 `create` 生成的 FakeAgent 的默认 `followupHandler`（收尾真 fork 的评估回复
   * mock：Phase B assess / Phase C secondary gate 经 followup 驱动一轮后由
   * `finalAssistantOutput` 收集输出）。缺省 undefined → followup 只记录不追加。
   */
  createFollowupHandler?: (content: ContentBlock[]) => ContentBlock[] | undefined;

  constructor(private readonly sessions?: FakeSessionStore) {}

  get(id: SessionId): FakeAgent | undefined {
    return this.agents.get(id);
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.createError !== undefined) {
      throw this.createError;
    }
    // create 期按真实 DSH 会话头校验规则验证 meta（防回归）：`seedLength` 已被上游
    // 校验显式拒绝（invalid field）；`inheritedEventCount > 0` 而未标记 `isSeeded`
    // 亦被拒绝（inheritedEventCount 仅在 seeded 头下合法）。
    if (options.meta !== undefined && 'seedLength' in options.meta) {
      throw new Error('session header has invalid field "seedLength"');
    }
    if ((options.inheritedEventCount ?? 0) > 0 && options.meta?.isSeeded !== true) {
      throw new Error('inheritedEventCount requires meta.isSeeded');
    }
    this.createCwds.push(options.meta?.cwd);
    this.createMetas.push(options.meta);
    this.createInheritedEventCounts.push(options.inheritedEventCount);
    this.createSeeds.push(options.seed);
    // 先记录 setup 入参再执行（记录不受 setupError 抛错影响，时序对齐 DSH
    // setupAndPublish 的 create 期 `setup?.(prepared.agent.ctx)` 执行点）。
    this.createSetups.push(options.setup);
    await this.runSetup(options.setup);
    const agent = new FakeAgent(options.sessionId, options.agentOptions);
    agent.followupHandler = this.createFollowupHandler;
    this.createdAgents.push(agent);
    // 回放 fork 前缀 seed 进子代理会话（revert/fork 的续跑输入，供 finalAssistantOutput 读取）。
    // DSH 全量 SessionEvent（含 turn 边界）与微流窄 SessionEvent 在 assistant/message、
    // assistant/chunk 上结构一致，finalAssistantOutput 仅读取这两类事件，忽略其余。
    for (const event of options.seed ?? []) {
      agent.session.append(event as unknown as SessionEvent);
    }
    this.agents.set(agent.id, agent);
    // 与 DSH agents.create 一致：宿主 Session 在发布时进入 session store，
    // 引擎随后经 `ctx.sessions.get(instanceId)` 读回用于事件双发。
    if (this.sessions !== undefined) {
      this.sessions.create(options.sessionId);
    }
    return {
      agent,
      dispose: async () => {
        this.agents.delete(agent.id);
      },
    };
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    await this.runSetup(options.setup);
    const existing = this.agents.get(options.resumeSessionId);
    const agent = existing ?? new FakeAgent(options.resumeSessionId, options.agentOptions);
    this.agents.set(agent.id, agent);
    return {
      agent,
      dispose: async () => {
        this.agents.delete(agent.id);
      },
    };
  }

  register(agent: FakeAgent): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * 构造 `AgentSetup` 回调的最小 agentCtx（记录 register/section/context/策略 append）。
   *
   * 结构对齐上游 `materializeTracked`/`startInProcessRun` 的 setup 需求：`agent.session.
   * append`（delegation 策略注入，记入 `setupPolicyAppends`）、`systemPrompt.context`/
   * `getContextOrder`（applyChildComposition 注册 delegation 运行时上下文，记入
   * `systemPromptContexts`）、`get('agentPresets')` 返回记录型服务面：`composeFrom`
   * 把 (agentCtx, parentCtx) 记入 `composeFromCalls`（fork 子代理 setup 组合宿主主代理
   * preset 的断言数据源）；其余服务名返回 undefined（模拟未注册的可选服务）。
   */
  private makeSetupContext(): AgentSetupContext {
    const registry = this;
    const setupCtx: AgentSetupContext = {
      agent: {
        session: {
          append: (type: string, data: unknown) => {
            registry.setupPolicyAppends.push({ type, data });
            return undefined;
          },
        },
      },
      tools: { register: () => {} },
      systemPrompt: {
        section: () => {},
        context: (declaration) => {
          registry.systemPromptContexts.push({ agentCtx: setupCtx, declaration });
          return () => {};
        },
        getContextOrder: (name: string) => (name === 'SUBAGENT_DELEGATION' ? 70 : 99),
      },
      get: (name) => (name === 'agentPresets'
        ? {
          mount: () => Promise.resolve(undefined),
          resolve: () => Promise.resolve({ id: 'preset-mock' }),
          composeFrom: (agentCtx: AgentSetupContext, parentCtx: unknown) => {
            registry.composeFromCalls.push({ agentCtx, parentCtx });
            return 'preset-mock';
          },
        }
        : undefined),
    };
    return setupCtx;
  }

  private async runSetup(setup?: AgentSetup): Promise<void> {
    if (this.setupError !== undefined) {
      throw this.setupError;
    }
    if (setup === undefined) return;
    this.setupCount += 1;
    const commit = await setup(this.makeSetupContext());
    commit?.commit();
  }
}
