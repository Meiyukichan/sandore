/**
 * 内存 mock agents（测试专用，非发布面）。
 *
 * 提供 `get`/`create`/`resume` 等价语义，`FakeAgent` 携带 `whenIdle` 与
 * `session.events`（`assistant/message`、`assistant/chunk` 事件快照），并附带事件
 * 构造助手供 `finalAssistantOutput` 测试使用。以 `ctx.provide('agents', …)` 注入。
 * @module dsh-sandore/workflow/tests/mocks/agents
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

  constructor(id: SessionId, options: AgentOptions = {}, session?: FakeSession) {
    this.id = id;
    this.options = options;
    this.session = session ?? new FakeSession();
    this.inbox = { hasPending: false };
    this.ctx = undefined;
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

/** 构造 `AgentSetup` 回调的最小 agentCtx（记录 register/section 调用）。 */
function makeSetupContext(): AgentSetupContext {
  return {
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  };
}

/** 内存 mock AgentRegistry：`get`/`create`/`resume` + 显式注册。 */
export class FakeAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<SessionId, FakeAgent>();
  /** 每次 `create` 记录的 `meta.cwd`（用于断言 setup/meta 回放）。 */
  readonly createCwds: Array<string | undefined> = [];
  /** 每次 `create` 记录的完整 `meta`（收尾真 fork 的 parentSession/origin/seedLength 断言）。 */
  readonly createMetas: Array<CreateAgentOptions['meta']> = [];
  /** 每次 `create` 记录的 `seed`（revert/fork 的 fork 前缀回放断言）。 */
  readonly createSeeds: Array<readonly DshSessionEvent[] | undefined> = [];
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
    this.createCwds.push(options.meta?.cwd);
    this.createMetas.push(options.meta);
    this.createSeeds.push(options.seed);
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

  private async runSetup(setup?: AgentSetup): Promise<void> {
    if (this.setupError !== undefined) {
      throw this.setupError;
    }
    if (setup === undefined) return;
    this.setupCount += 1;
    const commit = await setup(makeSetupContext());
    commit?.commit();
  }
}
