/**
 * 内存 mock agents（测试专用，非发布面）。
 *
 * 提供 `get`/`create`/`resume` 等价语义，`FakeAgent` 携带 `whenIdle` 与
 * `session.events`（`assistant/message`、`assistant/chunk` 事件快照），并附带事件
 * 构造助手供 `finalAssistantOutput` 测试使用。以 `ctx.provide('agents', …)` 注入。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/agents
 */
import { createAssistantMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';

import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentRegistry,
  AgentStatus,
  CreateAgentOptions,
  ResumeAgentOptions,
  Session,
  SessionEvent,
  SessionId,
} from '../../../microflow/src/subagents.ts';

/** 记录事件的最小 Session 形状。 */
export class FakeSession implements Session {
  readonly events: SessionEvent[] = [];

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

/** 内存 mock Agent：`whenIdle` 立即 resolve（无驱动活动）。 */
export class FakeAgent implements Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: FakeSession;
  status: AgentStatus = 'idle';

  constructor(id: SessionId, options: AgentOptions = {}, session?: FakeSession) {
    this.id = id;
    this.options = options;
    this.session = session ?? new FakeSession();
  }

  async whenIdle(): Promise<void> {
    // mock：无驱动活动，立即 idle。
  }
}

/** 内存 mock AgentRegistry：`get`/`create`/`resume` + 显式注册。 */
export class FakeAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<SessionId, FakeAgent>();

  get(id: SessionId): FakeAgent | undefined {
    return this.agents.get(id);
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const agent = new FakeAgent(options.sessionId, options.agentOptions);
    this.agents.set(agent.id, agent);
    return {
      agent,
      dispose: async () => {
        this.agents.delete(agent.id);
      },
    };
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
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
}
