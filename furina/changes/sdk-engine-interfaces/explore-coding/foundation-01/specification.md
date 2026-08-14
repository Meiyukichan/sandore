# Foundation-01 探索结果（specification）

## Phase 2 需求理解

- **What**：为 `@meiyukichan/claude-sdk`（packages/sdk/claude）建立包公共入口（`src/index.ts` + package.json main/module/exports/types/files/scripts.build + tsconfig outDir/declaration 产出 dist/），并落地 design.md D13 的依赖注入扩展（SessionManagerOptions 新增 4 个注入点 + QueryLike 扩展 rewindFiles/setPermissionMode 签名）。本 feature 只建骨架不改行为。
- **Boundaries**：packages/sdk/claude 包（package.json / tsconfig.json / src/* / test/*）、scripts/e2e.ts、根目录 .gitignore 与 monorepo tsconfig 组织、`@anthropic-ai/claude-agent-sdk/sdk.d.ts` 底层签名核验、furina/changes/sdk-engine-interfaces 下 package-entry spec.md 与 design.md D11/D13（及 plan.json foundation-01 任务）。
- **Goal**：摸清现状（无入口、无 build、DI 现状、FakeQuery 结构、monorepo 组织），核验底层 SDK 精确签名，为 foundation-01 实现（TDD）提供准确事实。

---

## 1. 包公共入口现状

**packages/sdk/claude/package.json（全文 17 行）**：
- `name: "@meiyukichan/claude-sdk"`、`version: "0.1.0"`、`"type": "module"`。
- `scripts`：仅 `test: "vitest run"`、`typecheck: "tsc --noEmit"`。**无 build**。
- `peerDependencies`：`@anthropic-ai/claude-agent-sdk: ">=0.3.0"`。
- `devDependencies`：`typescript ^5.5.0`、`vitest ^2.1.9`。
- **无 `main` / `module` / `exports` / `types` / `files` / `scripts.build` 字段**。

**packages/sdk/claude/tsconfig.json（全文 4 行）**：
- `{ "extends": "../../../tsconfig.base.json", "include": ["src", "test"] }`。**无 outDir / declaration / composite**。

**根 tsconfig.base.json（全文 9 行）**：
- `target: ES2022`、`module: ESNext`、`moduleResolution: bundler`、`strict: true`、`skipLibCheck: true`。

**src/ 无 index.ts**：现有公开入口分散在 `src/client.ts`（createClaudeClient/ClaudeClient/CreateClientOptions）、`src/session.ts`（SessionManager 等）、`src/types.ts`、`src/session-state.ts`、`src/events.ts`、`src/model.ts`。消费者只能源码路径直引（如 scripts/e2e.ts 引 `../packages/sdk/claude/src/client`）。

**参考：上游 `@anthropic-ai/claude-agent-sdk/package.json`**：`main: "sdk.mjs"`、`types: "sdk.d.ts"`、`exports: { ".": { types: "./sdk.d.ts", default: "./sdk.mjs" }, ... }`、`files: [...]`。本包可对齐该模式。

**结论**：要让 `import { createClaudeClient } from '@meiyukichan/claude-sdk'` 可解析，需（spec.md 与 design.md D11 的明确要求）：新增 `src/index.ts` re-export 全部公开 API；package.json 补 `main`（→ dist/index.js）、`module`、`exports`（import/require 均指向 dist）、`types`（→ dist/index.d.ts）、`files: ["dist"]`、`scripts.build: "tsc"`；tsconfig 增 `outDir: "dist"`、`declaration: true`。注意点：现 tsconfig `include: ["src","test"]`，若直接 `tsc` 会把 test 也编译进 dist，实现时需评估 build 专用配置（如 `tsconfig.build.json` 仅含 src，或 include 收窄）。

## 2. 依赖注入扩展现状

**SessionManagerOptions（src/session.ts L116-126）** 现有字段：
- `cwd: string`（必填）
- `queryFn?: QueryFactory`（默认 `query`）
- `getSessionMessagesFn?: GetSessionMessagesFn`（默认 `getSessionMessages`）
- `initTimeoutMs?: number`

构造器默认接线（L143-148）：`this.queryFn = options.queryFn ?? query; this.getSessionMessagesFn = options.getSessionMessagesFn ?? getSessionMessages;`

**需新增 4 个可选注入点**（design.md D13 / plan.json task 1.4）：`forkSessionFn?`、`deleteSessionFn?`、`listSubagentsFn?`、`getSubagentMessagesFn?`，构造器默认赋 SDK 模块级函数 `forkSession`/`deleteSession`/`listSubagents`/`getSubagentMessages`。当前 SessionManager **尚未使用这 4 个函数**（本 feature 只建骨架）。

**QueryLike 接口（src/session-state.ts L118-125）** 现有成员：
- `next(...): Promise<IteratorResult<SDKMessage, void>>`
- `return(...)` / `throw(...)`
- `[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void>`
- `interrupt(): Promise<SDKControlInterruptResponse | undefined>`
- `close(): void`

**需扩展方法签名**（design.md D13 / plan.json task 1.5）：`rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>`、`setPermissionMode(mode: PermissionMode): Promise<void>`。QueryLike 是结构子集接口，真实 SDK Query 天然满足；仅测试 Fake 需关注（见第 6 点）。

## 3. 底层 SDK 能力核验（sdk.d.ts 精确签名）

路径：`packages/sdk/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（SDK 版本 0.3.226，见其 package.json）。以下签名与行号均核验自该文件，且已在运行时 sdk.mjs 导出确认（`export{...TTt as listSubagents...ATt as getSubagentMessages...vTt as forkSession...ETt as deleteSession...}`）。

- **forkSession（L700）**：
  `export declare function forkSession(_sessionId: string, _options?: ForkSessionOptions): Promise<ForkSessionResult>;`
  - `ForkSessionOptions`（L705）= `SessionMutationOptions & { upToMessageId?: string; title?: string }`
  - `ForkSessionResult`（L715）= `{ sessionId: string }`
  - `SessionMutationOptions`（L4935）= `{ dir?: string; sessionStore?: SessionStore }`（sessionStore @alpha）

- **deleteSession（L530）**：
  `export declare function deleteSession(_sessionId: string, _options?: SessionMutationOptions): Promise<void>;`

- **listSubagents（L1009）**：
  `export declare function listSubagents(_sessionId: string, _options?: ListSubagentsOptions): Promise<string[]>;`
  - `ListSubagentsOptions`（L1014）= `{ dir?: string; sessionStore?: SessionStore }`

- **getSubagentMessages（L796）**：
  `export declare function getSubagentMessages(_sessionId: string, _agentId: string, _options?: GetSubagentMessagesOptions): Promise<SessionMessage[]>;`
  - `GetSubagentMessagesOptions`（L801）= `{ dir?: string; limit?: number; offset?: number; sessionStore?: SessionStore }`
  - 返回的 `SessionMessage` 即 `getSessionMessages` 的同款类型（session.ts 中 `import { SessionMessage as SDKStoredMessage }`）。

- **Query.setPermissionMode（L2377）**：
  `setPermissionMode(mode: PermissionMode): Promise<void>;`（仅 streaming input mode 可用；本适配层正是该模式）
  - `PermissionMode`（L2169）= `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`

- **Query.rewindFiles（L2563）**：
  `rewindFiles(userMessageId: string, options?: { dryRun?: boolean; }): Promise<RewindFilesResult>;`（需 `enableFileCheckpointing`）
  - `RewindFilesResult`（L2770）= `{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number; skippedLinks?: number }`

- **Query 接口（L2356）**：`export declare interface Query extends AsyncGenerator<SDKMessage, void>`，含 `interrupt()`（L2370）、`setPermissionMode()`（L2377）、`setModel()`（L2404）、`supportedModels()`（L2488）、`close()`（L2661）。

- **query 工厂（L2664）**：`export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options; }): Query;`

## 4. scripts/e2e.ts 现状与包名化

- **当前引用（L21-22）**：
  `import { createClaudeClient } from '../packages/sdk/claude/src/client';`
  `import type { GlobalEvent, QuestionInfo } from '../packages/sdk/claude/src/types';`
- **scripts/package.json**：`name: "claude-session-chat"`、`"type": "module"`，scripts `chat: "tsx conversation.ts"`、`e2e: "tsx e2e.ts"`；依赖 `@anthropic-ai/claude-agent-sdk: latest`；devDeps `@types/node ^26.2.0`、`tsx ^4.19.0`、`typescript ^5.5.0`。**无 `@meiyukichan/claude-sdk` 依赖**。
- **scripts/tsconfig.json**：`moduleResolution: bundler`、`types: ["node"]`、`include: ["conversation.ts","e2e.ts"]`。
- **关键发现**：scripts 目录**不在 pnpm workspace 内**（根 `pnpm-workspace.yaml` 仅 `packages/*` 与 `packages/sdk/*`；scripts 用 npm 的 package-lock.json，独立 npm 项目）。因此：
  - 改为 `import { createClaudeClient } from '@meiyukichan/claude-sdk'` 需要让包名在 scripts 上下文可解析。可行路径：① scripts/package.json 加 `"@meiyukichan/claude-sdk": "file:../packages/sdk/claude"`（依赖 build 产物 dist）；② tsconfig paths 映射到 src（dev 期免 build）；plan.json task 1.7 明确"build 产物或 tsconfig paths"两者之一。
  - 注意 e2e.ts 还引用 `type { GlobalEvent, QuestionInfo }`，包名化后需确认 index.ts 同样 re-export 这两个类型（否则类型导入需另改）。

## 5. 根 .gitignore 与 monorepo tsconfig 组织

- **根 .gitignore**：**已含 `dist/`**（第 ~14 行），另含 `coverage/`、`node_modules/`、`build/`、`.claude/` 等。spec.md 场景"dist 目录被 gitignore"已满足，无需改动。
- **monorepo tsconfig 组织**：根目录**无 tsconfig.json**，只有 `tsconfig.base.json`（基础编译选项）。**无 composite、无项目引用（references）**。因此 design.md D11 中"composite（若 monorepo 需）"判定为**当前不需要**（plan.json task 1.3 注明"composite 视 monorepo 需求"）。
- **工作区**：根 package.json（private，`test`/`typecheck` 为 `pnpm -r ...`）+ `pnpm-workspace.yaml`（`packages/*`、`packages/sdk/*`）。

## 6. FakeQuery（QueryLike 实现）与扩展影响

现测试共 4 个 `implements QueryLike` 的实现，**均无 rewindFiles / setPermissionMode**：
- `test/session.test.ts` L102 `FakeQuery`（含 next/return/throw/asyncIterator/interrupt/close + pushMessage/readInput 等）
- `test/events.test.ts` L230 `FakeQuery`（同构）
- `test/client.test.ts` L63 `FakeQuery`（额外含 `supportedModels`）
- `test/model.test.ts` L28 `FakeModelQuery`（额外含 `supportedModels`；src/model.ts L34 `interface ModelQuery extends QueryLike` 亦追加 supportedModels）

**类型检查影响**：若 QueryLike 新增的 `rewindFiles`/`setPermissionMode` 为**必填**成员，上述 4 个 Fake 全部类型检查失败，需逐个补 stub。plan.json foundation-01 acceptance_criteria 明确"**现有 FakeQuery 等实现能通过类型检查**"，因此实现时二选一：① 新方法在 QueryLike 中声明为**可选**（`rewindFiles?: ...` / `setPermissionMode?: ...`），与"结构子集"定位一致，Fake 免改；② 同步给 4 个 Fake 补 stub。真实 SDK Query 结构上始终满足（含必填的 rewindFiles/setPermissionMode）。
现有类型测试基座：`test/types.test.ts` 用 `expectTypeOf` 做编译期断言（tsc --noEmit 验证）；`npm run typecheck` = `tsc --noEmit` 同时覆盖 src+test。

## 7. spec.md 与 design.md D11/D13 具体要求

**specs/package-entry/spec.md（两则 ADDED requirement）**：
1. **Package public entry**：系统 SHALL 提供 `src/index.ts` 公共入口，re-export 全部公开 API；**至少** re-export `createClaudeClient`、`ClaudeClient` 类型、`CreateClientOptions` 等公开类型。消费者 MUST 能经包名 `@meiyukichan/claude-sdk` 引入（而非源码路径）。两个场景：`import { createClaudeClient } from '@meiyukichan/claude-sdk'` 后可 `createClaudeClient({ cwd })`；`import type { ClaudeClient, CreateClientOptions }` 类型校验通过。
2. **Package.json exports and build**：package.json MUST 配 `main`（→ dist/index.js）、`types`（→ dist/index.d.ts）、`exports`（`.` 映射到构建产物）、`files`（含 dist）、`scripts.build`（如 `tsc`）。tsconfig MUST 配 `outDir`、`declaration: true`。三个场景：`npm run build` 产出 dist/（含 index.js、index.d.ts 及子模块产物）；Node 依 main/exports 解析到 dist/index.js、TS 依 types 解析到 dist/index.d.ts；dist/ 不进入 git（.gitignore 已有）。

**design.md D11（L97-99）**：新增 `src/index.ts` re-export `createClaudeClient`、`ClaudeClient` 及全部公开类型；package.json 补 `main`（dist/index.js）、`module`、`exports`（import 指向 dist，require 指向 dist）、`types`（dist/index.d.ts）、`files: ["dist"]`、`scripts.build: "tsc"`；tsconfig 增 `outDir: "dist"`、`declaration: true`、`composite`（若 monorepo 需——现无 project references，判定不需要）。

**design.md D13（L105-107）**：`SessionManagerOptions` 新增 `forkSessionFn?`、`deleteSessionFn?`、`listSubagentsFn?`、`getSubagentMessagesFn?` 注入点（默认指向 SDK 模块级函数），与现有 `queryFn`/`getSessionMessagesFn` 模式一致；`QueryLike` 接口扩展 `rewindFiles`/`setPermissionMode` 方法签名。Risks 表另有佐证：`[forkSession/deleteSession 是模块级函数，与 Query 实例无关] → 需独立注入而非经 QueryLike。Mitigation：D13 的独立注入点解决。`（L118）与 `[包入口 BREAKING] → e2e.ts 改为包名引用`（L117）。

**plan.json foundation-01（7 tasks / 5 acceptance / 7 files）**：
- 变更文件：`src/index.ts`（新增）、`package.json`、`tsconfig.json`、`src/session.ts`（4 注入点）、`src/session-state.ts`（QueryLike 扩展）、`test/session.test.ts`、`test/types.test.ts`、`scripts/e2e.ts`。
- 验收含：build 产出 dist/index.js+index.d.ts；package.json 字段齐备；index.ts 导出可达（包名 import 类型+运行时可解析）；dist 不入 git；4 注入点默认指向 SDK 模块级函数且注入 mock 后使用注入值；QueryLike 类型含两方法且现有 FakeQuery 通过类型检查；e2e.ts 改包名导入。
- 依赖：`[]`（foundation-01 无前置），后续 `session-01`、`retry-01` 均依赖本任务（复用注入点与包入口）。

---

## 关键事实汇总（实现依据）

| 事项 | 事实 |
|---|---|
| 包现状 | 无 index.ts / main / module / exports / types / files / build；tsconfig 仅 extends base + include src,test |
| 根 .gitignore | 已含 `dist/`（无需改动） |
| monorepo | 无根 tsconfig.json、无 composite/项目引用；pnpm workspace 仅覆盖 packages/*（scripts 不在其中） |
| SDK 模块级函数 | `forkSession`(L700)、`deleteSession`(L530)、`listSubagents`(L1009)、`getSubagentMessages`(L796) 均已在 sdk.mjs 运行时导出，可直接作为默认注入实现 |
| Query 方法 | `rewindFiles(userMessageId, {dryRun?}) → RewindFilesResult`（L2563）、`setPermissionMode(mode: PermissionMode) → Promise<void>`（L2377）；PermissionMode = `'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'` |
| QueryLike 扩展风险 | 4 处 FakeQuery（session/events/client/model.test）无这两方法；必填会破坏类型检查 → 建议可选或同步补 stub |
| e2e.ts 包名化 | 需解决 scripts（独立 npm 项目、不在 workspace）对 `@meiyukichan/claude-sdk` 的解析：file: 依赖或 tsconfig paths |
| build 细节 | tsconfig include 含 test，直接 `tsc` 会把 test 编入 dist，需 build 专用配置收窄 include 为 src |
