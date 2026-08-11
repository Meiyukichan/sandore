/**
 * opencode 协议类型定义测试（src/types.ts）
 *
 * 以 furina/changes/claude-sdk-adapter/api.yaml definitions 为权威口径，
 * 交叉参考 docs/sdk/openapi.json（目标协议）与 specs/**\/*.md。
 * 编译期断言（expectTypeOf）由 tsc --noEmit 验证；值构造断言由 vitest 运行时验证。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ClaudeSDKError,
  Cost,
  Delivery,
  EventID,
  GlobalEvent,
  GlobalEventPayload,
  GlobalEventType,
  InvalidRequestError,
  LocationInfo,
  LocationRef,
  MessageID,
  MessageType,
  ModelListResponse,
  ModelRef,
  ModelStatus,
  ModelV2Info,
  Part,
  PartID,
  PromptAgentAttachment,
  PromptInput,
  PromptInputFileAttachment,
  SessionInputAdmitted,
  SessionMessage,
  SessionMessageAssistantContent,
  SessionMessagesResponse,
  SessionNotFoundError,
  SessionV2Info,
  TextPart,
  TimeoutError,
  TokenUsage,
  ToolPart,
  ToolState,
  WorkspaceID,
} from '../src/types';

describe('通用基础类型（api.yaml definitions）', () => {
  it('Cost 仅含 total_cost_usd/currency，均可选', () => {
    expectTypeOf<Cost['total_cost_usd']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Cost['currency']>().toEqualTypeOf<string | undefined>();
    const cost: Cost = {};
    expect(cost).toEqual({});
  });

  it('TokenUsage 字段全可选，cache 为 { read?, write? }', () => {
    expectTypeOf<TokenUsage['input']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<TokenUsage['output']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<TokenUsage['reasoning']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<TokenUsage['cache']>().toEqualTypeOf<
      { read?: number; write?: number } | undefined
    >();
    const tokens: TokenUsage = { input: 10, output: 20, cache: { read: 5, write: 1 } };
    expect(tokens.input).toBe(10);
  });

  it('LocationRef：directory 必填，workspaceID 可选且为 ^wrk 前缀', () => {
    expectTypeOf<LocationRef['directory']>().toEqualTypeOf<string>();
    expectTypeOf<LocationRef['workspaceID']>().toEqualTypeOf<WorkspaceID | undefined>();
    expectTypeOf<WorkspaceID>().toEqualTypeOf<`wrk${string}`>();
    const location: LocationRef = { directory: '/path/to/project' };
    expect(location.directory).toBe('/path/to/project');
  });

  it('ModelRef：id/providerID 必填，variant 可选', () => {
    expectTypeOf<ModelRef['id']>().toEqualTypeOf<string>();
    expectTypeOf<ModelRef['providerID']>().toEqualTypeOf<string>();
    expectTypeOf<ModelRef['variant']>().toEqualTypeOf<string | undefined>();
    const model: ModelRef = { id: 'sonnet', providerID: 'anthropic' };
    expect(model.providerID).toBe('anthropic');
  });
});

describe('会话管理类型（session-management）', () => {
  it('SessionV2Info：必填 id/projectID/cost/tokens/time/title/location，其余可选', () => {
    expectTypeOf<SessionV2Info['id']>().toEqualTypeOf<string>();
    expectTypeOf<SessionV2Info['projectID']>().toEqualTypeOf<string>();
    expectTypeOf<SessionV2Info['cost']>().toEqualTypeOf<Cost>();
    expectTypeOf<SessionV2Info['tokens']>().toEqualTypeOf<TokenUsage>();
    expectTypeOf<SessionV2Info['title']>().toEqualTypeOf<string>();
    expectTypeOf<SessionV2Info['location']>().toEqualTypeOf<LocationRef>();
    expectTypeOf<SessionV2Info['time']>().toEqualTypeOf<{
      created: string;
      updated: string;
      archived?: string;
    }>();
    expectTypeOf<SessionV2Info['parentID']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionV2Info['agent']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionV2Info['model']>().toEqualTypeOf<ModelRef | undefined>();
    expectTypeOf<SessionV2Info['subpath']>().toEqualTypeOf<string | undefined>();
  });

  it('SessionV2Info 可完整构造（time 为 date-time 字符串，id 保留 Claude 原始 session_id）', () => {
    const session: SessionV2Info = {
      id: 'e0c8f2a0-7c1a-4b3f-9d5e-1a2b3c4d5e6f',
      projectID: 'project-abc',
      cost: { total_cost_usd: 0.05, currency: 'USD' },
      tokens: { input: 120, output: 340, reasoning: 0 },
      time: { created: '2026-08-11T00:00:00.000Z', updated: '2026-08-11T00:01:00.000Z' },
      title: 'hello world',
      location: { directory: '/path/to/project' },
    };
    expect(session.id).toMatch(/^[0-9a-f-]+$/);
    expect(session.location.directory).toBe('/path/to/project');
    expect(session.cost.currency).toBe('USD');
  });

  it('PromptInput：text 必填，files/agents 为附件数组（uri/name 分别必填）', () => {
    expectTypeOf<PromptInput['text']>().toEqualTypeOf<string>();
    expectTypeOf<PromptInput['files']>().toEqualTypeOf<
      PromptInputFileAttachment[] | undefined
    >();
    expectTypeOf<PromptInput['agents']>().toEqualTypeOf<PromptAgentAttachment[] | undefined>();
    expectTypeOf<PromptInputFileAttachment['uri']>().toEqualTypeOf<string>();
    expectTypeOf<PromptInputFileAttachment['name']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PromptAgentAttachment['name']>().toEqualTypeOf<string>();
    const prompt: PromptInput = { text: 'hello' };
    expect(prompt.text).toBe('hello');
  });

  it('SessionInputAdmitted：必填 admittedSeq/id/sessionID/prompt/delivery/timeCreated', () => {
    expectTypeOf<SessionInputAdmitted['admittedSeq']>().toEqualTypeOf<number>();
    expectTypeOf<SessionInputAdmitted['id']>().toEqualTypeOf<MessageID>();
    expectTypeOf<SessionInputAdmitted['sessionID']>().toEqualTypeOf<string>();
    expectTypeOf<SessionInputAdmitted['prompt']>().toEqualTypeOf<PromptInput>();
    expectTypeOf<SessionInputAdmitted['delivery']>().toEqualTypeOf<Delivery>();
    expectTypeOf<SessionInputAdmitted['timeCreated']>().toEqualTypeOf<string>();
    expectTypeOf<SessionInputAdmitted['promotedSeq']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Delivery>().toEqualTypeOf<'steer' | 'queue'>();
  });

  it('SessionInputAdmitted 可完整构造（id 为 ^msg_ 前缀，delivery 为 queue）', () => {
    const admitted: SessionInputAdmitted = {
      admittedSeq: 0,
      id: 'msg_1a2b3c',
      sessionID: 'e0c8f2a0-7c1a-4b3f-9d5e-1a2b3c4d5e6f',
      prompt: { text: 'hello' },
      delivery: 'queue',
      timeCreated: '2026-08-11T00:00:00.000Z',
    };
    expect(admitted.id).toMatch(/^msg_/);
    expect(admitted.delivery).toBe('queue');
  });

  it('SessionMessage：id 为 ^msg_ 前缀，type 为 user/assistant/system 联合，其余可选', () => {
    expectTypeOf<SessionMessage['id']>().toEqualTypeOf<MessageID>();
    expectTypeOf<SessionMessage['type']>().toEqualTypeOf<MessageType>();
    expectTypeOf<MessageType>().toEqualTypeOf<'user' | 'assistant' | 'system'>();
    expectTypeOf<SessionMessage['time']>().toEqualTypeOf<
      { created?: string; completed?: string } | undefined
    >();
    expectTypeOf<SessionMessage['text']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionMessage['content']>().toEqualTypeOf<
      SessionMessageAssistantContent[] | undefined
    >();
    expectTypeOf<SessionMessage['finish']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SessionMessage['cost']>().toEqualTypeOf<number | undefined>();
  });

  it('SessionMessagesResponse：data/cursor 必填，cursor 为 { previous?, next? }', () => {
    expectTypeOf<SessionMessagesResponse['data']>().toEqualTypeOf<SessionMessage[]>();
    expectTypeOf<SessionMessagesResponse['cursor']>().toEqualTypeOf<{
      previous?: string;
      next?: string;
    }>();
    const response: SessionMessagesResponse = { data: [], cursor: {} };
    expect(response.data).toEqual([]);
  });
});

describe('模型类型（model-providers）', () => {
  it('ModelV2Info：必填 id/providerID/name/status，其余可选', () => {
    expectTypeOf<ModelV2Info['id']>().toEqualTypeOf<string>();
    expectTypeOf<ModelV2Info['providerID']>().toEqualTypeOf<string>();
    expectTypeOf<ModelV2Info['name']>().toEqualTypeOf<string>();
    expectTypeOf<ModelV2Info['status']>().toEqualTypeOf<ModelStatus>();
    expectTypeOf<ModelStatus>().toEqualTypeOf<'alpha' | 'beta' | 'deprecated' | 'active'>();
    expectTypeOf<ModelV2Info['family']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ModelV2Info['enabled']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ModelV2Info['limit']>().toEqualTypeOf<
      { context?: number; input?: number; output?: number } | undefined
    >();
  });

  it('ModelV2Info 可完整构造（providerID 为 anthropic，status 为 active）', () => {
    const model: ModelV2Info = {
      id: 'sonnet',
      providerID: 'anthropic',
      name: 'Claude Sonnet',
      status: 'active',
    };
    expect(model.id).toBe('sonnet');
    expect(model.providerID).toBe('anthropic');
  });

  it('LocationInfo：directory/project 必填，project 含 id/directory', () => {
    expectTypeOf<LocationInfo['directory']>().toEqualTypeOf<string>();
    expectTypeOf<LocationInfo['workspaceID']>().toEqualTypeOf<WorkspaceID | undefined>();
    expectTypeOf<LocationInfo['project']>().toEqualTypeOf<{
      id: string;
      directory: string;
    }>();
    const location: LocationInfo = {
      directory: '/path/to/project',
      project: { id: 'project-abc', directory: '/path/to/project' },
    };
    expect(location.project.id).toBe('project-abc');
  });

  it('ModelListResponse：location/data 必填', () => {
    expectTypeOf<ModelListResponse['location']>().toEqualTypeOf<LocationInfo>();
    expectTypeOf<ModelListResponse['data']>().toEqualTypeOf<ModelV2Info[]>();
    const response: ModelListResponse = {
      location: {
        directory: '/path/to/project',
        project: { id: 'project-abc', directory: '/path/to/project' },
      },
      data: [],
    };
    expect(response.data).toEqual([]);
  });
});

describe('内容块类型（Part）', () => {
  it('PartID 为 ^prt 前缀模板', () => {
    expectTypeOf<PartID>().toEqualTypeOf<`prt_${string}`>();
  });

  it('TextPart：必填 id/sessionID/messageID/type/text', () => {
    expectTypeOf<TextPart['id']>().toEqualTypeOf<PartID>();
    expectTypeOf<TextPart['sessionID']>().toEqualTypeOf<string>();
    expectTypeOf<TextPart['messageID']>().toEqualTypeOf<MessageID>();
    expectTypeOf<TextPart['type']>().toEqualTypeOf<'text'>();
    expectTypeOf<TextPart['text']>().toEqualTypeOf<string>();
    const part: TextPart = {
      id: 'prt_1a2b3c',
      sessionID: 'ses-1',
      messageID: 'msg_01abc',
      type: 'text',
      text: 'hello',
    };
    expect(part.type).toBe('text');
    expect(part.text).toBe('hello');
  });

  it('ToolPart：必填 id/sessionID/messageID/type/callID/tool/state，metadata 可选且无 input', () => {
    expectTypeOf<ToolPart['callID']>().toEqualTypeOf<string>();
    expectTypeOf<ToolPart['tool']>().toEqualTypeOf<string>();
    expectTypeOf<ToolPart['state']>().toEqualTypeOf<ToolState>();
    expectTypeOf<ToolState>().toEqualTypeOf<'pending' | 'running' | 'completed' | 'error'>();
    // M1：工具入参移入 metadata（schema additionalProperties:false，input 字段被移除）。
    expectTypeOf<ToolPart['metadata']>().toEqualTypeOf<Record<string, unknown> | undefined>();
    expectTypeOf<ToolPart>().not.toHaveProperty('input');
    const part: ToolPart = {
      id: 'prt_toolu_01',
      sessionID: 'ses-1',
      messageID: 'msg_01abc',
      type: 'tool',
      callID: 'toolu_01',
      tool: 'Bash',
      state: 'completed',
    };
    expect(part.type).toBe('tool');
    expect(part.callID).toBe('toolu_01');
  });

  it('Part 为 TextPart | ToolPart 联合', () => {
    expectTypeOf<Part>().toEqualTypeOf<TextPart | ToolPart>();
  });
});

describe('事件类型（event-streaming）', () => {
  it('GlobalEventPayload：id 为 ^evt_ 前缀，type/properties 必填', () => {
    expectTypeOf<GlobalEventPayload['id']>().toEqualTypeOf<EventID>();
    expectTypeOf<GlobalEventPayload['type']>().toEqualTypeOf<GlobalEventType>();
    expectTypeOf<GlobalEventPayload['properties']>().toEqualTypeOf<
      Record<string, unknown>
    >();
    expectTypeOf<EventID>().toEqualTypeOf<`evt_${string}`>();
    expectTypeOf<GlobalEventType>().toEqualTypeOf<
      | 'session.created'
      | 'message.part.delta'
      | 'message.part.updated'
      | 'session.next.step.ended'
      | 'session.error'
      | 'session.idle'
    >();
  });

  it('GlobalEvent：payload 必填，directory/project/workspace 可选', () => {
    expectTypeOf<GlobalEvent['payload']>().toEqualTypeOf<GlobalEventPayload>();
    expectTypeOf<GlobalEvent['directory']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GlobalEvent['project']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GlobalEvent['workspace']>().toEqualTypeOf<string | undefined>();
  });

  it('GlobalEvent 可完整构造（payload.id 以 evt_ 开头）', () => {
    const event: GlobalEvent = {
      directory: '/path/to/project',
      payload: {
        id: 'evt_9z8y7x',
        type: 'session.created',
        properties: { sessionID: 'e0c8f2a0-7c1a-4b3f-9d5e-1a2b3c4d5e6f' },
      },
    };
    expect(event.payload.id).toMatch(/^evt_/);
    expect(event.payload.type).toBe('session.created');
  });
});

describe('错误类型（_tag 判别联合）', () => {
  it('SessionNotFoundError：_tag/sessionID/message 必填', () => {
    expectTypeOf<SessionNotFoundError['_tag']>().toEqualTypeOf<'SessionNotFoundError'>();
    expectTypeOf<SessionNotFoundError['sessionID']>().toEqualTypeOf<string>();
    expectTypeOf<SessionNotFoundError['message']>().toEqualTypeOf<string>();
  });

  it('TimeoutError：_tag/message 必填，timeoutMs 可选', () => {
    expectTypeOf<TimeoutError['_tag']>().toEqualTypeOf<'TimeoutError'>();
    expectTypeOf<TimeoutError['message']>().toEqualTypeOf<string>();
    expectTypeOf<TimeoutError['timeoutMs']>().toEqualTypeOf<number | undefined>();
  });

  it('InvalidRequestError：_tag/message 必填，kind/field 可选', () => {
    expectTypeOf<InvalidRequestError['_tag']>().toEqualTypeOf<'InvalidRequestError'>();
    expectTypeOf<InvalidRequestError['message']>().toEqualTypeOf<string>();
    expectTypeOf<InvalidRequestError['kind']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<InvalidRequestError['field']>().toEqualTypeOf<string | undefined>();
  });

  it('ClaudeSDKError 为三种错误的判别联合', () => {
    expectTypeOf<ClaudeSDKError>().toEqualTypeOf<
      SessionNotFoundError | TimeoutError | InvalidRequestError
    >();
    const error: ClaudeSDKError = {
      _tag: 'SessionNotFoundError',
      sessionID: 'e0c8f2a0-7c1a-4b3f-9d5e-1a2b3c4d5e6f',
      message: 'session not found',
    };
    expect(error._tag).toBe('SessionNotFoundError');
  });
});
