/**
 * 客户端工厂（createClaudeClient）—— @meiyukichan/claude-sdk 适配层（event-01）
 *
 * 将 Claude SDK 装配为 opencode 协议风格的方法级客户端（design.md D1/D3）：
 *   - client.session：create/messages/prompt/interrupt/wait/events（委托 SessionManager 与 GlobalEventManager）；
 *   - client.model.list：获取可用模型（委托 ModelManager，惰性控制 Query，design.md D9）；
 *   - client.global.event：全局事件视图（委托 GlobalEventManager，按 directory 过滤）。
 * cwd 作为默认 directory（会话创建与事件过滤）；本库不启动任何 HTTP 服务器（D1）。
 * client.close() 关闭全部会话、控制 Query 与全局事件通道。
 */
import type { GlobalEvent, ModelListResponse, SessionInputAdmitted, SessionMessagesResponse, SessionV2Info } from './types';

import { GlobalEventManager } from './events';
import type { GlobalEventOptions } from './events';
import { ModelManager } from './model';
import type { ModelListOptions } from './model';
import { SessionManager } from './session';
import type {
  CreateSessionOptions,
  GetSessionMessagesFn,
  SessionMessagesOptions,
  SessionPromptInput,
  SessionWaitOptions,
} from './session';
import type { QueryFactory, RespondPermissionInput, RespondQuestionInput } from './session-state';

/** createClaudeClient 构造参数。 */
export interface CreateClientOptions {
  /** 客户端工作目录（会话创建默认 location 与全局事件过滤默认 directory）。 */
  cwd: string;
  /** 创建 Query 的工厂（依赖注入点，默认 Claude SDK query）。 */
  queryFn?: QueryFactory;
  /** 获取会话历史消息的函数（依赖注入点，默认 Claude SDK getSessionMessages）。 */
  getSessionMessagesFn?: GetSessionMessagesFn;
}

/** client.session 命名空间。 */
export interface ClaudeSessionNamespace {
  create(options?: CreateSessionOptions): Promise<SessionV2Info>;
  messages(sessionId: string, options?: SessionMessagesOptions): Promise<SessionMessagesResponse>;
  prompt(sessionId: string, input: SessionPromptInput): Promise<SessionInputAdmitted>;
  interrupt(sessionId: string): Promise<void>;
  wait(sessionId: string, options?: SessionWaitOptions): Promise<void>;
  events(sessionId: string): AsyncIterable<GlobalEvent>;
  /** 回复挂起的权限申请（canUseTool 桥接）；requestID 为 permission.asked 事件的 properties.id。 */
  respondPermission(sessionId: string, input: RespondPermissionInput): void;
  /** 回复挂起的问题提问（AskUserQuestion 桥接）；requestID 为 question.asked 事件的 properties.id。 */
  respondQuestion(sessionId: string, input: RespondQuestionInput): void;
}

/** client.model 命名空间。 */
export interface ClaudeModelNamespace {
  list(options?: ModelListOptions): Promise<ModelListResponse>;
}

/** client.global 命名空间。 */
export interface ClaudeGlobalNamespace {
  event(options?: GlobalEventOptions): AsyncIterable<GlobalEvent>;
}

/** opencode 协议风格的方法级客户端对象。 */
export interface ClaudeClient {
  session: ClaudeSessionNamespace;
  model: ClaudeModelNamespace;
  global: ClaudeGlobalNamespace;
  close(): void;
}

/**
 * 创建 opencode 协议风格的方法级客户端。
 * cwd 为默认 directory（会话创建与事件过滤）；不启动任何 HTTP 服务器。
 */
export function createClaudeClient(options: CreateClientOptions): ClaudeClient {
  const sessions = new SessionManager({
    cwd: options.cwd,
    queryFn: options.queryFn,
    getSessionMessagesFn: options.getSessionMessagesFn,
  });
  const globalEvents = new GlobalEventManager({ sessions, cwd: options.cwd });
  const models = new ModelManager({ cwd: options.cwd, queryFn: options.queryFn });

  return {
    session: {
      async create(createOptions = {}) {
        const session = await sessions.create(createOptions);
        // 会话的实际 directory（create 的 location/cwd 覆盖，否则客户端 cwd）注册到全局视图。
        const directory = createOptions.location?.directory ?? createOptions.cwd ?? options.cwd;
        globalEvents.registerSession(session.id, directory);
        return session;
      },
      messages(sessionId, messagesOptions) {
        return sessions.messages(sessionId, messagesOptions);
      },
      prompt(sessionId, input) {
        return sessions.prompt(sessionId, input);
      },
      interrupt(sessionId) {
        return sessions.interrupt(sessionId);
      },
      wait(sessionId, waitOptions) {
        return sessions.wait(sessionId, waitOptions);
      },
      events(sessionId) {
        return globalEvents.sessionEvents(sessionId);
      },
      respondPermission(sessionId, input) {
        return sessions.respondPermission(sessionId, input);
      },
      respondQuestion(sessionId, input) {
        return sessions.respondQuestion(sessionId, input);
      },
    },
    model: {
      list(modelOptions) {
        return models.list(modelOptions);
      },
    },
    global: {
      event(eventOptions) {
        return globalEvents.global(eventOptions);
      },
    },
    close() {
      sessions.closeAll();
      models.close();
      globalEvents.close();
    },
  };
}
