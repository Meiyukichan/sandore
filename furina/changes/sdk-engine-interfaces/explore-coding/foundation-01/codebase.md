## Exploration Result

`furina config show project.sourcecode codebases` 返回 `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。经核验，`docs/codebase` 目录为空（`ls -la` 显示 `total 0`），无文件可供 furina-codebase 探索，Phase 3 无有效产出，转入 Phase 4 手动补充探索。

## Supplementary Exploration Result

### 1. 包公共入口现状（packages/sdk/claude）

**package.json**（`D:/project-code/llm/sandore/packages/sdk/claude/package.json`）：
- `name: @meiyukichan/claude-sdk`、`version: 0.1.0`、`type: module`。
- `scripts` 仅 `test: vitest run`、`typecheck: tsc --noEmit`。**无 `main`/`module`/`exports`/`types`/`files`/`scripts.build`**。
- `peerDependencies: { "@anthropic-ai/claude-agent-sdk": ">=0.3.0" }`；`devDependencies: { typescript: ^5.5.0, vitest: ^2.1.9 }`。
- 注：底层 SDK 包自身 `peerDependencies` 为 `@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.0.0`（node_modules/@anthropic-ai/claude-agent-sdk/package.json）。

**tsconfig.json**：`{ "extends": "../../../tsconfig.base.json", "include": ["src", "test"] }`。**无 `outDir`/`declaration`/`composite`**。

**无 `src/index.ts`**（src 目录仅 `client.ts`/`events.ts`/`model.ts`/`session.ts`/`session-state.ts`/`types.ts`）。

**需新增的公开导出盘点**（index.ts re-export 候选）：
- `client.ts`：`createClaudeClient`、`ClaudeClient`、`ClaudeSessionNamespace`、`ClaudeModelNamespace`、`ClaudeGlobalNamespace`、`CreateClientOptions`。
- `session.ts`：`SessionManager`、`SessionManagerOptions`、`CreateSessionOptions`、`SessionMessagesOptions`、`SessionPromptInput`、`SessionWaitOptions`、`GetSessionMessagesFn`。
- `session-state.ts`：`SessionState`、`SessionStateOptions`、`SessionStateValue`、`SessionPhase`、`ToolAuthMode`、`SessionQueryOptions`、`PermissionRequestInfo`、`QuestionRequestInfo`、`RespondPermissionInput`、`RespondQuestionInput`、`QueryLike`、`QueryFactory`、`TimeoutError`、`SessionNotFoundError`。
- `events.ts`：`GlobalEventManager`、`GlobalEventManagerOptions`、`GlobalEventOptions`（`StreamNormalizer` 为内部类，**未导出**）。
- `model.ts`：`ModelManager`、`ModelManagerOptions`、`ModelListOptions`。
- `types.ts`：全部协议类型（`WorkspaceID`/`MessageID`/`PartID`/`EventID`/`Delivery`/`MessageType`/`ModelStatus`/`ToolStateStatus`/`ToolState`/`SessionMessageToolState`/`PermissionReply`/`QuestionOption`/`QuestionInfo`/`QuestionAnswer`/`GlobalEventType`/`LocationRef`/`ModelRef`/`TokenUsage`/`Cost`/`SessionTime`/`SessionV2Info`/`PromptInput`/`SessionInputAdmitted`/`SessionMessage`/`SessionMessagesResponse`/`ModelV2Info`/`ModelListResponse`/`TextPart`/`ToolPart`/`Part`/`GlobalEventPayload`/`GlobalEvent`/`SessionNotFoundError`/`TimeoutError`/`InvalidRequestError`/`ClaudeSDKError` 等）。

### 2. 依赖注入扩展现状（SessionManagerOptions / QueryLike）

**SessionManagerOptions**（`src/session.ts` L117-126）现有字段：`cwd`（必填）、`queryFn?`、`getSessionMessagesFn?`、`initTimeoutMs?`。构造函数（L143-148）默认赋 SDK 模块级函数：`queryFn ?? query`、`getSessionMessagesFn ?? getSessionMessages`。需新增 `forkSessionFn`/`deleteSessionFn`/`listSubagentsFn`/`getSubagentMessagesFn` 四个注入点，模式复用现有 `GetSessionMessagesFn`（L111-114：`(sessionId, options?) => Promise<SDKStoredMessage[]>`）。

**QueryLike**（`src/session-state.ts` L118-125）当前定义：`next`/`return`/`throw`/`[Symbol.asyncIterator]`/`interrupt`/`close`。`SessionState.query` 类型为 QueryLike（L275），现调用点仅用到 `next`/`return`/`throw`/`close`/`interrupt`。

**客户端装配链路**：`CreateClientOptions`（client.ts L28-35）透传 `queryFn`/`getSessionMessagesFn` 给 `SessionManager`；`ModelManager` 也注入 `queryFn`（model.ts L24）。

### 3. 底层 SDK 能力核验（sdk.d.ts 精确签名）

模块级函数（均已在 sdk.mjs 导出：`export{...vTt as forkSession...ETt as deleteSession...TTt as listSubagents...ATt as getSubagentMessages...}`）：
- **forkSession**（L700）：`export declare function forkSession(_sessionId: string, _options?: ForkSessionOptions): Promise<ForkSessionResult>;`
  - `ForkSessionOptions = SessionMutationOptions & { upToMessageId?: string; title?: string }`（L705）；`ForkSessionResult = { sessionId: string }`（L715）。
  - 文档：复制 source 会话消息到新文件，重映射消息 UUID 保留 parentUuid 链，支持 `upToMessageId` 分支切片；forked 会话无 undo 历史。
- **deleteSession**（L530）：`export declare function deleteSession(_sessionId: string, _options?: SessionMutationOptions): Promise<void>;`
  - `SessionMutationOptions = { dir?: string; sessionStore?: SessionStore }`（L4935，renameSession/tagSession/deleteSession/forkSession 共享）。
  - 文档：不带 sessionStore 时删除 `{sessionId}.jsonl` 与 `{sessionId}/` 子代理 transcript 子目录；找不到会话抛错。
- **listSubagents**（L1009）：`export declare function listSubagents(_sessionId: string, _options?: ListSubagentsOptions): Promise<string[]>;`
  - `ListSubagentsOptions = { dir?: string; sessionStore?: SessionStore }`（L1014）。
  - 文档：扫描 `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`。
- **getSubagentMessages**（L796）：`export declare function getSubagentMessages(_sessionId: string, _agentId: string, _options?: GetSubagentMessagesOptions): Promise<SessionMessage[]>;`
  - `GetSubagentMessagesOptions = { dir?, limit?, offset?, sessionStore? }`（L801）。
  - 文档：解析子代理 transcript，经 parentUuid 链构建会话链，按时间顺序返回 user/assistant 消息。

Query 实例方法（`Query extends AsyncGenerator<SDKMessage, void>`，L2356）：
- **rewindFiles**（L2563）：`rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;`
  - `RewindFilesResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number; ... }`（L2770）。
  - 文档：将受追踪文件回滚到指定 user message 状态，需 `enableFileCheckpointing` 选项开启。
- **setPermissionMode**（L2377）：`setPermissionMode(mode: PermissionMode): Promise<void>;`
  - `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`（L2169）。
  - 文档：仅 streaming input mode 可用。
- 相关：`interrupt(): Promise<SDKControlInterruptResponse | undefined>`（L2370）；`getSessionMessages(_sessionId, _options?: GetSessionMessagesOptions)`（L759），`GetSessionMessagesOptions` 含 `dir/limit/offset/includeSystemMessages/sessionStore`（L764）。

### 4. scripts/e2e.ts 引用方式与包名改动的必要条件

**当前引用**（`D:/project-code/llm/sandore/scripts/e2e.ts` L21-22）：
```ts
import { createClaudeClient } from '../packages/sdk/claude/src/client';
import type { GlobalEvent, QuestionInfo } from '../packages/sdk/claude/src/types';
```

**scripts 运行环境**：
- `scripts/package.json`：name=`claude-session-chat`、private、type=module；`dependencies: { "@anthropic-ai/claude-agent-sdk": "latest" }`；`devDependencies: { @types/node, tsx, typescript }`；scripts `e2e: tsx e2e.ts`。
- `scripts/tsconfig.json`：`moduleResolution: bundler`、`noEmit`、`types: ["node"]`、include 仅 `conversation.ts`/`e2e.ts`。
- **scripts 不在 pnpm-workspace.yaml**（该文件仅含 `packages/*` 与 `packages/sdk/*`）；已核验 `scripts/node_modules/@meiyukichan` 与根 `node_modules/@meiyukichan` 均**不存在**。

**改为包名 `@meiyukichan/claude-sdk` 的必要条件**（事实层面，非方案）：
- 包需 build 产出 `dist/` 且 package.json 配置 `exports`/`types`（供 tsx bundler 解析）；
- `@meiyukichan/claude-sdk` 需进入 scripts 的模块解析链（当前无任何链接）：或经 pnpm workspace + 安装，或经 `file:` 依赖，或经 tsconfig `paths` 映射；
- e2e.ts 中 `GlobalEvent`/`QuestionInfo` 的类型导入同样需改为包名路径。

### 5. 根 .gitignore 与 tsconfig 组织

- **.gitignore**（`D:/project-code/llm/sandore/.gitignore`）：**已含 `dist/`**（另有 `.worktrees/`/`node_modules/`/`coverage/`/`build/` 等）。满足 spec"dist 目录被 gitignore"。
- **tsconfig 组织**：根仅有 `tsconfig.base.json`（target ES2022、module ESNext、moduleResolution bundler、strict、skipLibCheck）；**根无 tsconfig.json**。**无 composite/项目引用（project references）**。包 tsconfig 单向 extends base。`composite` 属可选（design.md D11 "composite（若 monorepo 需）"，当前 monorepo 未用）。
- 根 `package.json`：name=sandore、private、scripts `test: pnpm -r test`、`typecheck: pnpm -r typecheck`。

### 6. 现有测试 FakeQuery 实现与 QueryLike 扩展的类型影响

4 个测试文件各自定义 `FakeQuery implements QueryLike`：
- `test/session.test.ts` L102：实现 `next`/`return`/`throw`/`[Symbol.asyncIterator]`/`interrupt`/`close` + 测试辅助（pushMessage/end/fail/readInput）。**无 rewindFiles/setPermissionMode**。
- `test/model.test.ts` L28（FakeModelQuery）：同上 + `supportedModels`。**无 rewindFiles/setPermissionMode**。
- `test/client.test.ts` L63：同上 + `supportedModels`。**无 rewindFiles/setPermissionMode**。
- `test/events.test.ts` L230：同上。**无 rewindFiles/setPermissionMode**。

**结论**：QueryLike 为 `implements` 目标接口，若新增**必选**的 `rewindFiles`/`setPermissionMode` 方法签名，上述 4 个 FakeQuery/FakeModelQuery 类将因**缺少成员而无法通过类型检查**（`implements QueryLike` 要求完整实现）。需为各测试类补 stub 方法（如 `readonly rewindFiles = vi.fn(async () => ({ canRewind: true }))`、`readonly setPermissionMode = vi.fn(async () => {})`）。这与 plan.json foundation-01 acceptance_criteria"现有 FakeQuery 等实现能通过类型检查"直接对应。

### 7. package-entry spec.md 与 design.md D11/D13 要求

**`furina/changes/sdk-engine-interfaces/specs/package-entry/spec.md`**（已读全文）：
- *Requirement: Package public entry*：系统 SHALL 提供 `src/index.ts` 作为包公共入口，re-export 全部公开 API，MUST 至少 re-export `createClaudeClient`、`ClaudeClient`、`CreateClientOptions` 等公开类型；消费者 MUST 能经包名引入（`import { createClaudeClient } from '@meiyukichan/claude-sdk'`），而非源码路径。Scenario：`createClaudeClient({ cwd })` 可调用；`import type { ClaudeClient, CreateClientOptions }` TS 校验通过。
- *Requirement: Package.json exports and build*：`package.json` MUST 配置 `main`（指向 dist 产物，如 `dist/index.js`）、`types`（`dist/index.d.ts`）、`exports`（`.` 映射到 dist 产物）、`files`（含 `dist`）、`scripts.build`（执行 TS 编译，如 `tsc`）；`tsconfig.json` MUST 配置 `outDir`、`declaration: true`。Scenario：`npm run build` 产出 `dist/`（含 `index.js`/`index.d.ts` 及子模块产物）；Node 经 `main`/`exports` 解析到 `dist/index.js`、TS 经 `types` 解析到 `dist/index.d.ts`；`dist/` 不进入版本控制。

**`furina/changes/sdk-engine-interfaces/design.md`**：
- **D11（包入口与构建，L97-99）**：新增 `src/index.ts` re-export `createClaudeClient`、`ClaudeClient` 及全部公开类型；`package.json` 补 `main`（指向 dist/index.js）、`module`、`exports`（import 指向 dist，require 指向 dist）、`types`（指向 dist/index.d.ts）、`files: ["dist"]`、`scripts.build: "tsc"`；`tsconfig.json` 增 `outDir: "dist"`、`declaration: true`、`composite`（若 monorepo 需）；dist 加入 .gitignore。
- **D13（依赖注入扩展，L105-107）**：`SessionManagerOptions` 新增 `forkSessionFn?`、`deleteSessionFn?`、`listSubagentsFn?`、`getSubagentMessagesFn?` 注入点（默认指向 SDK 模块级函数），与现有 `queryFn`/`getSessionMessagesFn` 模式一致；`QueryLike` 接口扩展 `rewindFiles`/`setPermissionMode` 方法签名。

**plan.json foundation-01**（任务 1.1-1.7，files 清单：`src/index.ts`、`package.json`、`tsconfig.json`、`session.ts`、`session-state.ts`、`test/session.test.ts`、`test/types.test.ts`、`scripts/e2e.ts`）：1.1 index.ts re-export；1.2 package.json main/module/exports/types/files/build；1.3 tsconfig outDir/declaration + 验证根 .gitignore 已含 dist/；1.4 SessionManagerOptions 4 注入点（默认 SDK 模块级函数）；1.5 QueryLike 扩展 rewindFiles/setPermissionMode；1.6 测试（注入 mock + QueryLike 结构类型校验 + index.ts 导出符号类型可达）；1.7 e2e.ts 改包名。

### 其他事实（对实现有用）

- 现有代码已从 SDK import 模块级函数 `query`（session.ts L21、model.ts L13）与 `getSessionMessages`（session.ts L21），新注入点默认值复用同一 import 模式。
- 当前 git 工作树状态：`furina/changes.json` 已修改（登记 sdk-engine-interfaces change 元数据）；`docs/engine/`、`furina/changes/` 未跟踪；`packages/sdk/claude` 的 src/test 已全部提交（最近提交 e6a4bf9、ae803d6、b46d5cd）。
