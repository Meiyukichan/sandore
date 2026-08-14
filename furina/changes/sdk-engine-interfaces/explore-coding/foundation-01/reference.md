## Exploration Result

### 需求理解（Phase 2）

**What**：为 `@meiyukichan/claude-sdk`（packages/sdk/claude）建立包公共入口与构建配置（index.ts + package.json 的 main/module/exports/types/files/scripts.build + tsconfig outDir/declaration 产出 dist/），使 `import { createClaudeClient } from '@meiyukichan/claude-sdk'` 类型与运行时可解析；并落地 design.md D13 的依赖注入扩展（SessionManagerOptions 新增 forkSessionFn/deleteSessionFn/listSubagentsFn/getSubagentMessagesFn 注入点）与 QueryLike 接口扩展（rewindFiles/setPermissionMode 方法签名）。同步适配 scripts/e2e.ts 的引用方式（源码路径直引 → 包名）。

**Boundaries**：packages/sdk/claude 包（package.json / tsconfig.json / src / test）、scripts/e2e.ts 与其 package.json/tsconfig.json、根 .gitignore、根 tsconfig.base.json、@anthropic-ai/claude-agent-sdk 的 sdk.d.ts（node_modules）、furina/changes/sdk-engine-interfaces/ 的 package-entry/spec.md 与 design.md D11/D13、plan.json foundation-01 任务。

**Goal**：为 foundation-01 提供准确的现状盘点与底层 SDK 精确签名事实依据，明确实现所需的全部配置项与接口扩展点，并提前识别实现风险（现有测试 FakeQuery 的接口实现影响）。

---

### 1. 包公共入口现状

**package.json**（packages/sdk/claude/package.json）：
- `name: "@meiyukichan/claude-sdk"`、`version: "0.1.0"`、`type: "module"`。
- `scripts`: 仅 `test: vitest run`、`typecheck: tsc --noEmit`。**无 build 脚本**。
- `peerDependencies`: `@anthropic-ai/claude-agent-sdk: ">=0.3.0"`（实际安装版本 v0.3.226）。
- `devDependencies`: `typescript ^5.5.0`、`vitest ^2.1.9`。
- **缺失字段**：无 `main`、`module`、`exports`、`types`、`files`、`scripts.build`。即包目前无法被 `import { ... } from '@meiyukichan/claude-sdk'` 解析（无入口映射，也无 dist 产物）。

**tsconfig.json**（packages/sdk/claude/tsconfig.json）：
- `{ "extends": "../../../tsconfig.base.json", "include": ["src", "test"] }`。
- **无 `outDir`、`declaration`、`composite`**。`include` 同时含 `src` 与 `test`——若直接在根 tsconfig 加 `outDir`+`declaration` 跑 `tsc`，会连 test 一起编译进 dist（实现时需考虑分离 src-only 的 build tsconfig 或调整 include）。

**src 目录内容**：`client.ts`、`events.ts`、`model.ts`、`session.ts`、`session-state.ts`、`types.ts`。**无 index.ts**。

**peer 依赖 SDK 的 package.json 参考**（@anthropic-ai/claude-agent-sdk v0.3.226）：
- `main: "sdk.mjs"`、`types: "sdk.d.ts"`、`exports: { ".": { types, default } }`、`files: [...]`、`type: "module"`。该包**无 `module` 字段**（仅 main+types+exports）。design D11 要求本包额外补 `module`。

### 2. 依赖注入扩展现状

**SessionManagerOptions**（src/session.ts L117-126）现有字段：
- `cwd: string`（必填）
- `queryFn?: QueryFactory`（默认 SDK `query`）
- `getSessionMessagesFn?: GetSessionMessagesFn`（默认 SDK `getSessionMessages`）
- `initTimeoutMs?: number`
- **尚无 forkSessionFn/deleteSessionFn/listSubagentsFn/getSubagentMessagesFn**。

**默认值注入模式**（session.ts L143-148，新增注入点应沿用）：
```ts
this.queryFn = options.queryFn ?? query;
this.getSessionMessagesFn = options.getSessionMessagesFn ?? getSessionMessages;
```
当前 session.ts 顶部已从 SDK import：`getSessionMessages, query`（L21）。新增默认值需再 import `forkSession/deleteSession/listSubagents/getSubagentMessages`。

**QueryLike**（src/session-state.ts L118-125）现有方法：
```ts
export interface QueryLike {
  next(...args: [] | [unknown]): Promise<IteratorResult<SDKMessage, void>>;
  return(value?: unknown): Promise<IteratorResult<SDKMessage, void>>;
  throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>>;
  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void>;
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  close(): void;
}
```
**无 rewindFiles/setPermissionMode**。QueryLike 是"结构子集"接口，SDK Query 结构上可赋给本接口（注释 L116）。注意：若新增方法为**必填**，所有 `implements QueryLike` 的测试 FakeQuery 类必须同步补齐；若为**可选**则现有实现不受影响（见第 6 点分析）。

**QueryFactory**（session-state.ts L128-131）：
```ts
export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: SessionQueryOptions;
}) => QueryLike;
```

### 3. 底层 SDK 能力核验（sdk.d.ts 精确签名）

文件：`node_modules/.pnpm/@anthropic-ai+claude-agent-_3d6e0582a1149899b85c7d67a91390db/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

- **forkSession（L700）**：
  `export declare function forkSession(_sessionId: string, _options?: ForkSessionOptions): Promise<ForkSessionResult>;`
  - `ForkSessionOptions`（L705）= `SessionMutationOptions & { upToMessageId?: string; title?: string }`
  - `ForkSessionResult`（L715）= `{ sessionId: string }`——新会话 UUID，注释明确"Resumable via `query({ options: { resume: sessionId } })`"。
- **deleteSession（L530）**：
  `export declare function deleteSession(_sessionId: string, _options?: SessionMutationOptions): Promise<void>;`
  - 无返回值（Promise<void>）。文档说明：移除 `{sessionId}.jsonl` 与 `{sessionId}/` 子目录；会话不存在时 throw。
- **listSubagents（L1009）**：
  `export declare function listSubagents(_sessionId: string, _options?: ListSubagentsOptions): Promise<string[]>;`
  - 返回子 Agent ID 字符串数组。
  - `ListSubagentsOptions`（L1014）= `{ dir?: string; sessionStore?: SessionStore }`
- **getSubagentMessages（L796）**：
  `export declare function getSubagentMessages(_sessionId: string, _agentId: string, _options?: GetSubagentMessagesOptions): Promise<SessionMessage[]>;`
  - 返回 user/assistant 消息数组（按时间序）。
  - `GetSubagentMessagesOptions`（L801）= `{ dir?: string; limit?: number; offset?: number; sessionStore?: SessionStore }`
- **Query.setPermissionMode（L2377）**：
  `setPermissionMode(mode: PermissionMode): Promise<void>;`——仅 streaming input mode 可用（Query 接口控制请求注释，L2358-2360）。适配层当前正是 streaming input mode。
  - `PermissionMode`（L2169）= `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`（比 types.ts 现有注释提到的 3 值更宽）。
- **Query.rewindFiles（L2563）**：
  `rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;`——需 `enableFileCheckpointing`（Options 选项）启用。
  - `RewindFilesResult`（L2770）= `{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number; skippedLinks?: number }`
- **Query 接口**（L2356）：`export declare interface Query extends AsyncGenerator<SDKMessage, void>`，含 `interrupt(): Promise<SDKControlInterruptResponse | undefined>`（L2370）、`setModel(model?: string): Promise<void>`（L2404）、`setMcpPermissionModeOverride`（L2394）、`readFile`（L2532）等控制方法。
- **query 工厂**（L2664）：`export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;`
- **Options**（L1346，与本 feature 相关的子集）：`extraArgs?: Record<string, string | null>`（L1492）、`enableFileCheckpointing?: boolean`（L1508）、`resume?: string`（L1827）、`sessionId?: string`（L1833）、`resumeSessionAt?: string`（L1841）、`resumeDropsTurn?: string`（L1892）、`forkSession?: boolean`（L1524，内联 fork 选项）。
- **运行时导出已核验**：`node -e import('./sdk.mjs')` 确认 `query/getSessionMessages/forkSession/deleteSession/listSubagents/getSubagentMessages/renameSession` 均 `typeof === 'function'`（全部真实导出）。
- **附带发现（超出 foundation-01 范围，供后续 feature 参考）**：`GetSessionMessagesOptions`（L764）= `{ dir?; limit?; offset?; includeSystemMessages?; sessionStore? }`，**当前版本无 `before` 字段**。design.md D9 假设的 `before` 游标在 sdk.d.ts v0.3.226 中不存在，属于后续 session-01 需重新核验的点。

### 4. scripts/e2e.ts 引用方式

- **当前源码路径直引**：
  - L21：`import { createClaudeClient } from '../packages/sdk/claude/src/client';`
  - L22：`import type { GlobalEvent, QuestionInfo } from '../packages/sdk/claude/src/types';`
- **scripts/package.json**：`name: "claude-session-chat"`、`type: "module"`、`scripts: { chat: "tsx conversation.ts", e2e: "tsx e2e.ts" }`、`dependencies: { "@anthropic-ai/claude-agent-sdk": "latest" }`、`devDependencies: { "@types/node", "tsx", "typescript" }`。
- **scripts/tsconfig.json**：独立配置（未 extends 根 base），`compilerOptions: { target ES2022, module ESNext, moduleResolution bundler, strict, skipLibCheck, noEmit, types: ["node"] }`，`include: ["conversation.ts", "e2e.ts"]`。
- **关键点**：`scripts/` 目录不在 pnpm-workspace.yaml 的 glob（`packages/*` 与 `packages/sdk/*`）内，是独立非 workspace 包。改为 `from '@meiyukichan/claude-sdk'` 需要：① scripts 侧能解析到该包（在 scripts 的 node_modules 建立到 packages/sdk/claude 的依赖——本地 link/workspace: 协议或 file: 引用，且依赖 dist 构建产物）；或 ② 在 scripts/tsconfig.json 配 `paths` 映射到源码 `../packages/sdk/claude/src`。design.md D11 风险节亦指出此点（"build 产物在本地 dev 可经 tsconfig paths 或源码直引兼容；e2e.ts 同步适配"）。tsx 运行时解析需 build 产物或 tsx 自身解析 paths（tsx 支持 tsconfig paths）。**无 vitest.config/vite.config**（测试跑 vitest 默认配置）。

### 5. 根 .gitignore 与 monorepo tsconfig 组织

- **根 .gitignore 已含 `dist/`**（L13），另有 `coverage/`（L14）、`build/`（L16）。spec 的 "dist 被 gitignore" 场景已满足，无需新增。
- **tsconfig 组织**：
  - 根 `tsconfig.base.json`：`{ target: ES2022, module: ESNext, moduleResolution: "bundler", strict: true, skipLibCheck: true }`。
  - `packages/sdk/claude/tsconfig.json`：extends 根 base，include `["src","test"]`。
  - `scripts/tsconfig.json`：独立，不 extends。
  - **全仓无 `composite`、无 `references`、无 project references**（grep 确认 none）。design D11 的 "composite（若 monorepo 需）" 判断为**当前不需要**——本仓仅单包，无项目引用链；是否加 composite 不影响现有解析，但加 `composite: true` 会要求 `declaration` 同时开启（与 D11 目标一致），实现时可选。
- **workspace 组织**：pnpm-workspace.yaml globs 为 `packages/*` 与 `packages/sdk/*`；当前仅一个包 `packages/sdk/claude`。根 package.json 脚本 `test`/`typecheck` 为 `pnpm -r <cmd>`（递归执行）。

### 6. 现有测试如何构造 FakeQuery（QueryLike 实现）

四份测试文件各自定义 `implements QueryLike` 的 Fake 类，均**仅实现现有 6 个成员**，无 `rewindFiles`/`setPermissionMode`：

- **session.test.ts L102 `class FakeQuery implements QueryLike`**：`interrupt = vi.fn(async () => ({ still_queued: [] as string[] }))`（L114）、`close = vi.fn(...)`（L117）、`next/return/throw/[Symbol.asyncIterator]`（L159-182）。夹具 `createHarness`（L196）经 `queryFn: QueryFactory = (params) => { const fake = new FakeQuery(params.prompt); ... }` 注入 `SessionManager({ cwd, initTimeoutMs, queryFn, getSessionMessagesFn })`。
- **client.test.ts L63 `class FakeQuery implements QueryLike`**：在 session 版基础上额外加 `supportedModels = vi.fn(...)`（L79）。夹具 createHarness（L144）注入 `createClaudeClient({ cwd, queryFn })`。
- **events.test.ts L230 `class FakeQuery implements QueryLike`**：`interrupt = async () => ({ still_queued: [] as string[] })`（L240）、`close = ...`（L242）。夹具（L295）注入 SessionManager + GlobalEventManager。
- **model.test.ts L28 `class FakeModelQuery implements QueryLike`**：`close = vi.fn(() => {})`、`interrupt = vi.fn(async () => ({ still_queued: [] as string[] }))`、`supportedModels = vi.fn(...)`、`next/return/throw/[Symbol.asyncIterator]`（L46-60）。

**类型检查影响分析**：`QueryLike` 作为 `implements` 目标接口，一旦新增 `rewindFiles`/`setPermissionMode` **必填**方法，上述 4 个 `class ... implements QueryLike` 会全部报"缺少成员"类型错误，无法通过 `tsc --noEmit`。plan.json foundation-01 acceptance "现有 FakeQuery 等实现能通过类型检查" 意味着实现时必须二选一：① 新方法在 QueryLike 上声明为**可选**（`rewindFiles?(...)` / `setPermissionMode?(...)`）——现有实现不受影响，SDK Query 结构上仍可赋给 QueryLike；② 或把 4 个 Fake 类同步补齐这两个方法（测试侵入更大）。注意 spec 措辞仅说"QueryLike 接口类型包含 rewindFiles 与 setPermissionMode 方法签名"，未明确必填/可选，此为实现阶段的决策点。若选必填，SDK Query 赋给 QueryLike 的兼容性不变（SDK Query 本来就有这两个方法）。

**新增注入点的测试模式**：可沿用现有 `createHarness` 夹具模式，在 `SessionManagerOptions` 里注入 `forkSessionFn/deleteSessionFn/listSubagentsFn/getSubagentMessagesFn` 的 vi.fn mock，断言 SessionManager 使用注入值（foundation-01 任务 1.6）。

### 7. spec.md 与 design.md D11/D13 具体要求

**specs/package-entry/spec.md**（两份 Requirement）：
- **Package public entry**：系统 SHALL 提供 `src/index.ts` 作为包公共入口，re-export 全部公开 API；至少 re-export `createClaudeClient` 工厂、`ClaudeClient` 类型、`CreateClientOptions` 等公开类型。消费者 MUST 能经包名 `@meiyukichan/claude-sdk` 引入，而非源码路径。场景：`import { createClaudeClient } from '@meiyukichan/claude-sdk'` 可调用 `createClaudeClient({ cwd })`；`import type { ClaudeClient, CreateClientOptions }` 类型校验通过。
- **Package.json exports and build**：`package.json` MUST 配置 `main`（→ `dist/index.js`）、`types`（→ `dist/index.d.ts`）、`exports`（映射 `.` 到构建产物）、`files`（含 `dist`）、`scripts.build`（执行 TS 编译，如 `tsc`）。`tsconfig.json` MUST 配置 `outDir`、`declaration: true`。场景：`npm run build` 产出 dist（含 `index.js`、`index.d.ts` 及对应子模块产物）；Node 按 main/exports 解析到 `dist/index.js`、TS 按 types 解析到 `dist/index.d.ts`；`dist/` 不进入版本控制（已加入 .gitignore）。

**design.md D11（L97-99，包入口与构建）**：
新增 `src/index.ts`，re-export `createClaudeClient`、`ClaudeClient` 及全部公开类型。`package.json` 补 `main`（指向 dist/index.js）、`module`、`exports`（import 指向 dist，require 指向 dist）、`types`（指向 dist/index.d.ts）、`files: ["dist"]`、`scripts.build: "tsc"`。`tsconfig.json` 增 `outDir: "dist"`、`declaration: true`、`composite`（若 monorepo 需）。dist 加入 .gitignore。

**design.md D13（L107，依赖注入扩展）**：
`SessionManagerOptions` 新增 `forkSessionFn?`、`deleteSessionFn?`、`listSubagentsFn?`、`getSubagentMessagesFn?` 注入点（默认指向 SDK 模块级函数），与现有 `queryFn`/`getSessionMessagesFn` 模式一致，保证测试可注入 mock。`QueryLike` 接口扩展 `rewindFiles`/`setPermissionMode` 方法签名。

**相关上下文决策（供注入点/接口签名对齐参考）**：
- D6（session.delete）：`SessionManager` 注入 `deleteSessionFn`（默认 SDK `deleteSession`）。`session.delete(sessionId)` 先 `close()` 本地 SessionState（关闭 Query/通道/清理 Map），再调 `deleteSessionFn(resolvedId, { dir })` 删磁盘会话文件。区分于 `close()`（仅客户端内存清理）。
- D1（revert/fork 依赖 `forkSessionFn` + `rewindFiles`）：revert 采用"fork 到目标点 + 文件 rewind"。`forkSession(sessionId, { upToMessageId: messageID, dir })` 分叉新会话；原会话启用 `enableFileCheckpointing` 时对原会话 Query 调 `rewindFiles(messageID)`。D3 依赖 `Query.setPermissionMode`（per-prompt 运行时切换）。
- D7 依赖 `listSubagents`/`getSubagentMessages`（subtask part 映射，从 SDK 的 listSubagents/getSubagentMessages 提取子会话信息）。

**plan.json foundation-01**（已列任务 1.1-1.7）：
1.1 新增 src/index.ts re-export 全部公开 API；1.2 package.json 补 main/module/exports/types/files/scripts.build（exports 映射 import/require 均指向 dist）；1.3 tsconfig.json 增 outDir/declaration（composite 视 monorepo 需求），验证根 .gitignore 已含 dist/；1.4 SessionManagerOptions 增 4 注入点（默认 SDK 模块级函数 forkSession/deleteSession/listSubagents/getSubagentMessages）；1.5 QueryLike 增 rewindFiles/setPermissionMode（结构子集，与 SDK Query 一致）；1.6 测试（mock 注入 + QueryLike 结构类型校验 + index.ts 导出符号类型可达）；1.7 scripts/e2e.ts 改包名并验证本地 dev 可解析（build 产物或 tsconfig paths）。files 涉及：src/index.ts、src/session.ts、src/session-state.ts、test/session.test.ts、test/types.test.ts、scripts/e2e.ts、package.json、tsconfig.json。

---

## Supplementary Exploration Result

- `furina config show exploration.reference` 返回空数组（`exploration.reference=[]`），无预设参考材料配置，故按 exploreContent 直接探索项目实际代码与 SDK 类型定义。
- 未启用 `experimental.websearch` / `experimental.context7` 补充查询（本任务为本地代码 + 本地 SDK .d.ts 核验，信息已充分）。
