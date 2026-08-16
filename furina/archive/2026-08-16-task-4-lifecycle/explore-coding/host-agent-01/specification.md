# Task 4 host-agent-01 参考实现与落点探索

## 一、需求理解（Explore Content 转写）

- **What**：Task 4 `host-agent-01` 要把 sandore 工作流「宿主 Session」从**裸 `ctx.sessions.create` 会话**升级为**真正的宿主主代理**。具体两件事：
  1. 新建 `packages/sandore/workflow/src/host-agent.ts`，提供宿主主代理 create/resume 共用的 `createHostAgentSetup` 工厂——生成「同参同闭包」的 `setup(agentCtx)` 回调，其内经 `agentCtx.tools.register` 逐个注册 `createSandoreTools({ instanceId, engine })` 返回的 8 个 `sandore_*` 工具，并经 `agentCtx.systemPrompt.section` 注入编排器角色说明。
  2. 改造 `workflow-engine.ts` 的 `startInstance`：`ctx.sessions.create` 裸 Session → `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup })` 创建真 Agent；`ActiveInstance` 增 `hostAgent` 字段持有 live 引用；`runnerConfig` 把 `hostAgent` 注入 `StepRunnerConfig.hostAgent`；主代理创建后不自动发首轮 prompt（仅 mint 不 run）。
- **Boundaries**：范围限定在 sandore monorepo 内 `workflow` 包（`host-agent.ts` 新建、`workflow-engine.ts` 改造）、`tool` 包已实现的 `createSandoreTools`、`microflow` 的接缝类型（`subagents.ts` / `step-runner.ts`），以及 DSH 参考源码 `deepseek-harness` 中 `agents.create/resume`、`AgentSetup`、`systemPrompt.section`、`tools.register` 的权威形状。不涉及 interaction/lifecycle/recovery 等 Task 4 后续任务。
- **Goal**：定位 host-agent-01 的确切「落点」（要改的每一处代码位置、现有签名/类型）、确认参考实现的权威形状，并如实记录当前基线与目标之间的缝隙。

## 二、现状（sandore 仓内落点）

### 2.1 `host-agent.ts` 与 `createHostAgentSetup` 均不存在

- `packages/sandore/workflow/src/` 目录下现有文件：`persistence.ts`、`remote.ts`、`index.ts`、`errors.ts`、`yaml-parser.ts`、`shell.ts`、`dag-navigator.ts`、`schema.ts`、`types.ts`、`workflow-engine.ts`、`engine-surface.ts`、`seam.ts`（Glob `packages/sandore/workflow/src/**`）。
- **无 `host-agent.ts`、无 `host-agent.spec.ts`**（Glob `packages/sandore/workflow/src/host-agent*` → No files found）。
- 全仓搜索 `createHostAgentSetup` 仅命中 `furina/changes/task-4-lifecycle/plan.json`（task 3.1 任务名）与本次探索内容——**无任何既有参考实现**，工厂函数名与实现均为本次新建。
- 计划状态：`plan.json` 中 `host-agent-01` 为 `"status": "in_progress"`，前置 `seam-01`、`tools-01` 均为 `"status": "done"`（其产物已落地，见下）。

### 2.2 `workflow-engine.ts` 的待改点

文件：`packages/sandore/workflow/src/workflow-engine.ts`

1. **`ActiveInstance` 接口（L43-48）**：当前字段为 `controller` / `session` / `definition` / `state`，**无 `hostAgent` 字段**。
2. **`startInstance`（L148-169）**：当前为**同步方法** `startInstance(request: DagStartRequest): DagRun`，关键行：
   - L163 `const session = this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } });` ← 待升级为 `ctx.agents.create(...)`。
   - L164 `const active: ActiveInstance = { controller, session, definition, state };` ← 待增 `hostAgent`。
   - L166-167 `void this.persistState(active); void this.execute(instanceId);`（fire-and-forget）。
3. **`static inject`（L139）**：`['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']` —— **缺 `agents`**（要用 `ctx.agents.create` 需在此注入；对比 `seam.ts` 的 `SandoreEngineStub.inject`（L143）已含 `'agents'`、`'userQuestions'`）。
4. **`runnerConfig(definition)`（L405-414）**：返回 `{ defaultTimeoutMs, defaultProvider?, defaultModel?, skills, mcps, agents }` —— **无 `hostAgent`**。它在 `runInstance`（L269）被构造，随后传给 `WorkflowDagNavigator` / `StageExecutor` / `FinalizeManager`。
5. **import**：L16 `import type { Session } from '@deepseek-ai/dsh-session';`，L17 `import { SessionId } from '@deepseek-ai/dsh-session';`。`hostAgent` 字段的类型 `Agent` 需从 `../../microflow/src/subagents.ts` 引入。

### 2.3 `StepRunnerConfig.hostAgent` 已就位（microflow）

文件：`packages/sandore/microflow/src/step-runner.ts`

- `StepRunnerConfig`（L51-63）**已含** `readonly hostAgent?: Agent;`（L62），注释「宿主主代理（子代理 parent）；缺省时使用最小桩对象」。
- `resolveParent()`（L510-512）：`return this.config.hostAgent ?? createHostAgentStub();` —— 当前引擎未传 `hostAgent`，实际走 `createHostAgentStub()`（L117-127，`id:'sandore-host'`、`session:{events:[]}`、`status:'idle'`、`whenIdle` 空实现）。
- 结论：`StepRunnerConfig.hostAgent` 消费端已就绪，缺的只是引擎把真实宿主主代理注入。

### 2.4 `microflow/src/subagents.ts` 接缝类型（create/resume/setup 的结构面）

文件：`packages/sandore/microflow/src/subagents.ts`

- `Agent`（L37-46）：`{ id: SessionId, options, session, inbox: { hasPending }, status: 'idle'|'running', ctx: unknown, whenIdle(): Promise<void> }` —— 即 `hostAgent` 的类型。
- `AgentHandle`（L49-52）：`{ agent: Agent; dispose(): Promise<void> }` —— `agents.create/resume` 的返回。
- `AgentSetupCommit`（L55-57）：`{ commit(): void }`。
- `AgentSetupContext`（L60-63）：`{ tools: { register(tool: unknown): void }; systemPrompt: { section(content: string): void } }`。
- `AgentSetup`（L66-68）：`(agentCtx: AgentSetupContext) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`。
- `CreateAgentOptions`（L71-85）：`{ sessionId: SessionId; meta?: { cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset? }; seed?; agentOptions?; signal?; setup?: AgentSetup }`。
- `ResumeAgentOptions`（L88-93）：`{ resumeSessionId: SessionId; agentOptions?; signal?; setup?: AgentSetup }`。
- `AgentRegistry`（L96-100）：`get(id) / create(options): Promise<AgentHandle> / resume(options): Promise<AgentHandle>`。
- `SessionId`（L16）：`export type SessionId = string`（与 `@deepseek-ai/dsh-session` 的 `SessionId` 品牌字符串结构兼容）。
- Cordis 模块增强（L240-245）：声明 `ctx.agents: AgentRegistry`、`ctx.subagents: SubagentRuntime`。

### 2.5 `createSandoreTools` 已实现（tool 包）

文件：`packages/sandore/tool/src/index.ts`

- `createSandoreTools(options: { instanceId, engine }): SandoreToolDefinition[]`（L277-349）返回 **8 个工具**，名称与转调映射：
  - `sandore_getState` → `engine.getState(instanceId)`（只读，任意状态可用）
  - `sandore_startInstance` → `engine.startInstance(request)`（L299 同步调用，返回 `{ ok: true, run }`）
  - `sandore_abortInstance` → `engine.abortInstance(instanceId)`（终态 no-op）
  - `sandore_pauseStep` → `engine.pauseStep(instanceId, stepId)`
  - `sandore_resumeStep` → `engine.resumeStep(instanceId, stepId, resumePrompt?)`
  - `sandore_pauseAllSteps` → `engine.pauseAllSteps(instanceId)`
  - `sandore_resumeAllPaused` → `engine.resumeAllSteps(instanceId, resumePrompt?)`
  - `sandore_retryStep` → `engine.retryStep(instanceId, stepId, mode, message)`
- `SandoreToolDefinition`（L56-65）是 `defineTool` 形状最小结构面：`{ name, description, parameters, output: { schema, render }, execute(args, exec) }`。
- 每个工具 `execute` 闭包捕获 `instanceId`，经 `withErrorHandling` 把 `SandoreError` 摘要透传为结构化错误结果；completed 实例的 resume/retry/pause 类工具返回 no-op。
- 依赖方向：tool → workflow 仅 `import type`（无运行时 import）。

### 2.6 `seam.ts` / `engine-surface.ts` 的 `startInstance` 签名

- `engine-surface.ts` `SandoreEngineSurface.startInstance(request: DagStartRequest): DagRun`（L14）—— 同步签名。
- `seam.ts` 抽象 `SandoreEngine.startInstance`（L79）与 `SandoreEngineStub.startInstance`（L145）同签名为同步 `DagRun`。
- 事实性张力：`ctx.agents.create` / `ctx.agents.resume` 均返回 `Promise<AgentHandle>`（见 2.4），而当前 `startInstance` 是同步返回 `DagRun`、`createSandoreTools` 内 `sandore_startInstance` 也同步调用 `engine.startInstance`（tool/src/index.ts L299）。这是本次「startInstance 升级为真 Agent」需要面对的签名/异步边界（当前状态如实记录，不在此处给出方案）。

## 三、参考实现（DSH 权威形状）

源码目录：`D:\project-code\llm\deepseek-harness\packages\core\agent\src`

### 3.1 `AgentSetup` / `AgentSetupCommit`

`packages/core/agent/src/index.ts`：
- `AgentSetupCommit`（L56-62）：`{ commit(): void }` —— 发布前同步校验/提交，`commit()` 抛错则回滚。
- `AgentSetup`（L69-71）：`(agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void` —— 注意 DSH 的 `agentCtx` 是**完整 `Context`**，而 sandore 接缝收窄为 `AgentSetupContext` 结构面（subagents.ts L60-63）。

### 3.2 `CreateAgentOptions` / `ResumeAgentOptions`（setup 语义）

`packages/core/agent/src/index.ts`：
- `CreateAgentOptions`（L80-133）：`sessionId` / `meta?`（`cwd`/`parentSession`/`seedLength`/`origin`/`delegationDepth`/`agentPreset`）/ `seed?` / `agentOptions?` / `signal?` / `setup?`。
- **setup 时序**（L114-132）：工厂在 mint `agentCtx` 之后、发布 session/agent 之前 await setup；setup 内注册的一切（scoped tools、prompt sections、listeners）在 `session/created` / `agent/created` / 首轮 prompt 组装前就绪；**setup 抛错 / commit 抛错 / owner disposal → 整体回滚，不发布任一 id**。注释明确「**Setup composes, it never drives**」——这是「主代理创建后不自动发首轮 prompt」的 DSH 语义依据。
- `ResumeAgentOptions`（L139-156）：`{ resumeSessionId, agentOptions?, signal?, setup? }` —— 持久化先加载，再 mint agentCtx 并 await setup，`resume` 会**重跑 setup**（重注册工具/system prompt）。
- `AgentRegistry.create`（L405）/ `resume`（L424）：`async create(options): Promise<AgentHandle>` / `async resume(options): Promise<AgentHandle>`。

### 3.3 `Agent` 形状

`packages/core/agent/src/runtime-types.ts`：
- `Agent`（L64-104）：`{ id: SessionId, options, session, inbox: Inbox, status: 'idle'|'running', ctx: Context, cancel(), whenIdle(), runMaintenance(), ... }`。
- `AgentStatus`（L50）：`'idle' | 'running'`（无 paused）。
- 事件（L155-290）：`agent/created`、`agent/disposed`、`agent/status`、`agent/inbox/inserted`、`agent/session-start`、`agent/pre-step`、`agent/request`、`agent/turn-stopping`、`agent/error` 等。

### 3.4 `systemPrompt.section` 与 `tools.register` 真实签名（与 sandore 接缝的差异）

- `ctx.systemPrompt.section`（`packages/core/system-prompt/src/index.ts:381`）：`section(section: PromptSection): () => void` —— 入参是 **`PromptSection` 对象**（测试用法为 `{ name, order, text }`），返回 disposer 函数。
- `ctx.tools.register`（`packages/core/tools/src/index.ts:1037`）：`register(definition: ToolDefinition): () => void` —— 入参 `ToolDefinition`，返回 disposer。
- **事实性差异**：sandore 接缝 `AgentSetupContext`（subagents.ts L60-63）将两者收窄为 `systemPrompt: { section(content: string): void }`（入参 string、返回 void）与 `tools: { register(tool: unknown): void }`。DSH 真实 `agentCtx` 是完整 `Context`，其 `systemPrompt.section` 需 `{ name, order, text }` 对象入参。二者形状不一致——如实记录，不在此处给方案。

### 3.5 设计文档中的既有示例（docs/engine/dsh-workflow.md）

`docs/engine/dsh-workflow.md`：
- L351 关键结论：`sandore_*` 工具不能写进 preset 的 `cordis.yml`（standing mount 会共享闭包），正确做法是在创建宿主 Session 时经 `ctx.agents.create({ setup(agentCtx) })` 内 `agentCtx.tools.register(...)`，闭包捕获 instanceId，实现 per-session 工具绑定。
- L353-382 给出完整示例：`ctx.agents.create({ sessionId: hostSessionId, meta: { cwd, agentPreset: 'sandore-host' }, setup(agentCtx) { agentCtx.systemPrompt.section({ name: 'sandore-host', order: 116, text: ... }); agentCtx.tools.register(defineTool({ name: 'sandore_resumeAllPaused', ... })); ... } })`。
- L388-392：非 subagent origin 的 `agents.create` 会话会出现在侧边栏列表；`meta.cwd` 必填（否则重启后冷会话被 `session.list` 过滤）；冷会话点击只读回放，崩溃恢复需引擎显式 `ctx.agents.resume()`。

## 四、测试桩 / 测试落点

### 4.1 `FakeAgentRegistry`（packages/sandore/workflow/tests/mocks/agents.ts L94-141）

- `create(options)`：`this.createCwds.push(options.meta?.cwd)` 记录 meta.cwd → `await this.runSetup(options.setup)` → 构造 `FakeAgent` 注册。`resume(options)` 同样 `runSetup(options.setup)` 并回放。
- `runSetup`（L135-140）：`setupCount += 1`，`await setup(makeSetupContext())`，`commit?.commit()`。
- `makeSetupContext()`（L86-91）：`{ tools: { register: () => {} }, systemPrompt: { section: () => {} } }` —— 均为**空函数，未记录 register/section 调用**。host-agent 相关单测若需断言「8 工具被逐个注册」「system prompt 注入」，需扩展此 mock 记录调用（当前不能断言）。
- `FakeAgent`（L64-83）：`{ id, options, session: FakeSession, inbox: { hasPending: false }, ctx: undefined, status: 'idle' }`，`whenIdle()` 立即 resolve。

### 4.2 `FakeSessionStore`（packages/sandore/workflow/tests/mocks/sessions.ts L20-51）

- `create(id?)` 返回 `FakeSession` 并登记（当前 `startInstance` 的 `ctx.sessions.create` 走此桩）；另有 `get/list/fork`。host-agent-01 改造后，`startInstance` 不再走 `sessions.create`，宿主 Session 事件来自 Agent 的 `session`。

### 4.3 `workflow-engine.spec.ts` 既有断言

文件：`packages/sandore/workflow/src/workflow-engine.spec.ts`
- `harness()`（L305-339）：已 `ctx.provide('agents', agents)`（`FakeAgentRegistry`）与 `ctx.provide('sessions', sessions)`，并 `ctx.provide('subagents', subagents)`。
- `startInstance` 用例（L402-451）：`returns a run whose state is immediately readable via getState` 断言 `run.status === 'running'`；线性执行用例（L453-511）用 `sessions.get(run.instanceId)` 断言宿主 Session 事件双发序列。
- 现有断言（L383-386）「declares agents and userQuestions in the seam inject list」仅针对 `SandoreEngineStub.inject`（已含）—— **未覆盖 runtime 的 inject**。

## 五、关键缝隙汇总（现状 vs 目标，仅陈述事实）

1. `host-agent.ts` / `createHostAgentSetup` 尚不存在，需新建；无既有参考实现。
2. `ActiveInstance` 无 `hostAgent` 字段；`startInstance` 现为 `ctx.sessions.create` 裸会话、同步返回 `DagRun`。
3. `runnerConfig` 无 `hostAgent`；`StepRunnerConfig.hostAgent` 消费端与 `resolveParent()` fallback 已就位。
4. `SandoreEngineRuntime.static inject`（workflow-engine.ts L139）**缺 `agents`**（seam 的 Stub 已含）。
5. `ctx.agents.create` / `ctx.agents.resume` 返回 `Promise<AgentHandle>`，`AgentSetup` 回调 `agentCtx` 在 DSH 是完整 `Context`，而 sandore 接缝为 `AgentSetupContext` 结构面，且其 `systemPrompt.section` 形状（string vs `PromptSection` 对象）与 DSH 真实签名不一致。
6. `createSandoreTools` 已实现 8 工具（闭包捕获 instanceId），`sandore_startInstance` 内同步调用 `engine.startInstance`。
7. 测试桩 `FakeAgentRegistry` 已能回放 setup 并记录 `meta.cwd`，但 `makeSetupContext` 的 register/section 为空函数、不记录调用，需扩展方可断言「8 工具注册 + system prompt 注入」。
