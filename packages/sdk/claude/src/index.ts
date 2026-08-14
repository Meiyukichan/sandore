/**
 * 包公共入口（@meiyukichan/claude-sdk）
 *
 * re-export 全部公开 API（design.md D11）：
 *   - 客户端工厂 createClaudeClient 与 ClaudeClient/CreateClientOptions 及 session/model/global 命名空间类型（client.ts）；
 *   - 会话管理类型与依赖注入函数类型（session.ts）；
 *   - QueryLike 接口、SessionState 状态封装与错误类（session-state.ts）；
 *   - 事件管理（events.ts）、模型管理（model.ts）；
 *   - opencode 协议全部公开类型（types.ts）。
 * 消费者 MUST 经包名引入（如 `import { createClaudeClient } from '@meiyukichan/claude-sdk'`）。
 * StreamNormalizer 等内部实现类不导出。
 */
export { createClaudeClient } from './client.js';
export type {
  ClaudeClient,
  ClaudeGlobalNamespace,
  ClaudeModelNamespace,
  ClaudeSessionNamespace,
  CreateClientOptions,
} from './client.js';

export { SessionManager } from './session.js';
export type {
  CreateSessionOptions,
  DeleteSessionFn,
  ForkSessionFn,
  GetSessionMessagesFn,
  GetSubagentMessagesFn,
  ListSubagentsFn,
  SessionManagerOptions,
  SessionMessagesOptions,
  SessionPromptInput,
  SessionWaitOptions,
} from './session.js';

export { SessionNotFoundError, SessionState, TimeoutError } from './session-state.js';
export type {
  PermissionRequestInfo,
  QueryFactory,
  QueryLike,
  QuestionRequestInfo,
  RespondPermissionInput,
  RespondQuestionInput,
  SessionPhase,
  SessionQueryOptions,
  SessionStateOptions,
  SessionStateValue,
  ToolAuthMode,
} from './session-state.js';

export { GlobalEventManager } from './events.js';
export type { GlobalEventManagerOptions, GlobalEventOptions } from './events.js';

export { ModelManager } from './model.js';
export type { ModelListOptions, ModelManagerOptions } from './model.js';

export * from './types.js';
