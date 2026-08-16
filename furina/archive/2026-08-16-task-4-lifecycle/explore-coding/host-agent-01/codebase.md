## Exploration Result

`codebases list` 仅含一个元素 `docs/codebase`（描述为当前项目 codebase 目录），该目录实际为空（`ls` 无任何文件），`furina-codebase` 无可用结果。本次探索结果全部来自 Phase 4 手动补充探索（直接读取源码与计划/规格文件）。

## Supplementary Exploration Result

### 需求理解

**What**：Task 4 `host-agent-01` 的参考实现与落点，即把 `workflow-engine.ts` 的 `startInstance` 从「裸 `ctx.sessions.create` 创建宿主 Session」升级为「`ctx.agents.create({ sessionId, meta: { cwd }, setup })` 创建真 Agent（宿主主代理）」，并让 `ActiveInstance.hostAgent` 持有 live 引用、经 `runnerConfig` 注入 `StepRunnerConfig.hostAgent`。探索目标是定位 7 处落点与当前实现形状，以及存量测试中会被改动击中的断言。

**Boundaries**：`packages/sandore` 内 4 个包（workflow / microflow / tool）+ `workflow/tests/mocks`，外加 `furina/changes/task-4-lifecycle/{proposal,design,plan.json,specs/host-agent/spec.md}` 作为参考实现依据。

**Goal**：为 `host-agent-01`（plan.json 中 status=`in_progress`，dependencies=seam-01/tools-01）梳理当前实现形状与同步更新点，不改任何代码。

**Project Context**：sandore 是 monorepo 下第 4 个包域（microflow/workflow/tool/ui）。依赖方向统一为 workflow → microflow（microflow 对 workflow 仅 `import type`）、tool → workflow（type-only）。Task 3 已完成 Stage 级线性主循环，Task 4 补生命周期；`host-agent-01` 是 Task 4 的第 3 个任务（在 seam-01、tools-01 之后）。

---

### ① workflow-engine.ts 的 startInstance 当前实现

文件：`packages/sandore/workflow/src/workflow-engine.ts`

**`startInstance`（第 148–169 行）当前流程**：
1. `this.persistence()` 判空（第 149–152 行）
2. `persistence.definitions.get(request.workflowId)` 读定义，缺失抛 `NODE_NOT_FOUND`（第 153–156 行）
3. `parseWorkflowYaml(record.yaml)`（第 157 行）
4. `instanceId = makeInstanceId()`（第 158 行；`makeInstanceId` 定义在第 63–71 行，格式 `YYYYMMDD-HHmmss-xxx`，xxx = `crypto.randomUUID()` 去横线前 3 位）
5. `createdAt = now()`、`cwd = request.cwd ?? '/tmp'`（第 159–160 行）
6. `state = makeInitialState({ instanceId, request, definition, createdAt, cwd })`（第 161 行；`makeInitialState` 第 74–104 行，含 seam-01 已改名的 `pausedChildIds: []`）
7. `controller = new AbortController()`（第 162 行）
8. **`ctx.sessions.create` 位置（第 163 行）**：
   ```ts
   const session = this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } });
   ```
   这是当前「裸 Session 创建」点 —— host-agent-01 需替换为 `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup })`。
9. **`ActiveInstance` 组装（第 164 行）**：`const active: ActiveInstance = { controller, session, definition, state };`
10. `this.instances.set(instanceId, active)`（第 165 行）
11. `void this.persistState(active)`（第 166 行，fire-and-forget 持久化）
12. `void this.execute(instanceId)`（第 167 行，fire-and-forget 启动执行）
13. `return { instanceId, status: 'running' }`（第 168 行）

**`ActiveInstance` 结构（第 42–48 行）**：
```ts
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly definition: WorkflowDefinition;
  state: WorkflowTaskState;
}
```
目前**无 `hostAgent` 字段** —— host-agent-01 需增 `hostAgent`（并按 design.md 第 46 行增 `hostHandle` 等，但本任务仅要求 `hostAgent`）。

**`SessionId` 来源**：第 17 行 `import { SessionId } from '@deepseek-ai/dsh-session';` —— 来自 dsh-session 包的品牌字符串构造函数（以 `SessionId(instanceId)` 函数调用形式使用）。注意 microflow/src/subagents.ts 另有一个本地 `export type SessionId = string`（第 16 行），两者需区分（host-agent 工厂在 workflow 包使用 dsh-session 的 `SessionId`）。

**`runnerConfig` 方法（第 405–414 行）**：
```ts
private runnerConfig(definition: WorkflowDefinition): StepRunnerConfig {
  return {
    defaultTimeoutMs: this.config.defaultTimeoutMs ?? 7200000,
    ...(this.config.defaultProvider === undefined ? {} : { defaultProvider: this.config.defaultProvider }),
    ...(this.config.defaultModel === undefined ? {} : { defaultModel: this.config.defaultModel }),
    skills: definition.skills,
    mcps: definition.mcps,
    agents: definition.agents,
  };
}
```
当前**不包含 `hostAgent`** —— host-agent-01 需在此注入 `hostAgent` 到 `StepRunnerConfig.hostAgent`。

**`runInstance` 主循环启动点（第 256–394 行）**：
- 第 265 行 `active.state = { ...active.state, status: 'running', updatedAt: now() }` → `persistState` → `emitStart`
- 第 269 行 `const runnerConfig = this.runnerConfig(definition);`（hostAgent 注入落点之一）
- 第 270–277 行 构造 `WorkflowDagNavigator`、取 `loopManager`、`new FinalizeManager(this.ctx, runnerConfig)`
- 第 278 行 `let stageId = navigator.currentNodeId;`
- 第 280 行 `while (stageId !== '') { ... }` —— Stage 级线性主循环入口
- 第 296–330 行 `new StageExecutor({ runnerConfig, ... })`（runnerConfig 传入执行器）

**`execute`（第 231–254 行）**：fire-and-forget 的 async 包装，调 `runInstance(active)`，引擎级意外故障落 `failed` 终态。

**注入清单差异**：`SandoreEngineRuntime.inject`（第 139 行）为 `['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']` —— **不含 `agents`/`userQuestions`**；而 `SandoreEngineStub.inject`（seam.ts 第 143 行）已含 `'agents'`、`'userQuestions'`（seam-01 已加）。host-agent-01 需要把 `agents` 补进 Runtime 的 inject。

---

### ② microflow/src/step-runner.ts 的 StepRunnerConfig.hostAgent 与 resolveParent

文件：`packages/sandore/microflow/src/step-runner.ts`

**`StepRunnerConfig`（第 51–63 行）**：
```ts
export interface StepRunnerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly skills?: readonly string[];
  readonly mcps?: readonly string[];
  readonly agents?: readonly string[];
  /** 宿主主代理（子代理 parent）；缺省时使用最小桩对象。 */
  readonly hostAgent?: Agent;   // 第 62 行，已存在
}
```

**`createHostAgentStub`（第 117–127 行）**：缺省 parent 桩，`id: 'sandore-host'`、`options: {}`、`session: { events: [] }`、`inbox: { hasPending: false }`、`status: 'idle'`、`ctx: undefined`、`whenIdle: async () => {}`。注释强调每次返回新对象，避免跨 run 共享可变 `session.events`。

**`resolveParent`（第 509–512 行）**：
```ts
private resolveParent(): Agent {
  return this.config.hostAgent ?? createHostAgentStub();
}
```

**`runSubagent`（第 431–465 行）**：agent/skill/mcp 走 `ctx.subagents.startContinuable({ provider, label, request: { prompt, parent: this.resolveParent(), agentOptions }, signal })`（第 445–454 行，第 450 行 `parent: this.resolveParent()`）→ `ctx.agents.get(started.childId)` → `await child.whenIdle()` → `finalAssistantOutput(child.session.events)`。

即：`StepRunnerConfig.hostAgent` 字段与 `resolveParent` 逻辑**已经就位**，只差 `workflow-engine.ts` 的 `runnerConfig` 把 live 引用注入进来。

---

### ③ microflow/src/subagents.ts 的最新形状（seam-01 已扩展）

文件：`packages/sandore/microflow/src/subagents.ts`

关键结构（均为本地结构类型声明，非 DSH 运行时依赖）：

- `SessionId`（第 16 行）：`export type SessionId = string;`
- `MessageId`（第 19 行）：`string`
- `AgentOptions`（第 22–26 行）：`{ provider?; model?; maxTokens? }`
- `AgentStatus`（第 29 行）：`'idle' | 'running'`
- `Session`（第 32–34 行）：`{ readonly events: readonly SessionEvent[] }`
- `Agent`（第 37–46 行）：`{ id: SessionId; options: AgentOptions; session: Session; inbox: { hasPending: boolean }; status: AgentStatus; ctx: unknown; whenIdle(): Promise<void> }`
- `AgentHandle`（第 49–52 行）：`{ agent: Agent; dispose(): Promise<void> }`
- `AgentSetupCommit`（第 55–57 行）：`{ commit(): void }`
- `AgentSetupContext`（第 60–63 行）：`{ tools: { register(tool: unknown): void }; systemPrompt: { section(content: string): void } }`
- `AgentSetup`（第 66–68 行）：`(agentCtx: AgentSetupContext) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`
- **`CreateAgentOptions`（第 71–85 行）**：
  ```ts
  export interface CreateAgentOptions {
    readonly sessionId: SessionId;
    readonly meta?: {
      readonly cwd?: string;
      readonly parentSession?: SessionId;
      readonly seedLength?: number;
      readonly origin?: 'subagent';
      readonly delegationDepth?: number;
      readonly agentPreset?: string;
    };
    readonly seed?: readonly SessionEvent[];
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
  }
  ```
- **`ResumeAgentOptions`（第 88–93 行）**：`{ resumeSessionId: SessionId; agentOptions?; signal?; setup?: AgentSetup }`
- `AgentRegistry`（第 96–100 行）：`{ get(id): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }`
- `ToolRestriction`（第 103–106 行）、`ContinuableStartRequest`（第 109–116 行，含 `parent: Agent`）、`ContinuableStartSpec`（第 119–124 行）、`ContinuableStart`（第 127–130 行）
- `SubagentFollowupOptions`（第 133–136 行）：`{ source: MessageSource; signal: AbortSignal }`
- `SubagentInterruptAuthority`（第 139–141 行）：`{ kind:'user'; parentSessionId } | { kind:'ancestor'; agent: Agent }`
- `SubagentStartRequest`（第 144–153 行）、`SubagentRun`（第 156–161 行）、`SubagentResult`（第 164–168 行）、`SubagentStopReason`（第 171 行）
- `SubagentListEntry`（第 174–177 行）
- `SubagentRuntime`（第 180–186 行）：`startContinuable / followup / interrupt / listChildren(parentSessionId, signal?) / start`
- `SessionEvent`（第 209–211 行）、`finalAssistantOutput`（第 223–238 行）
- cordis 模块增强（第 240–245 行）：`ctx.subagents: SubagentRuntime; ctx.agents: AgentRegistry`

---

### ④ tool/src/index.ts 的 createSandoreTools 签名与返回值（tools-01 已落地）

文件：`packages/sandore/tool/src/index.ts`

- `CreateSandoreToolsOptions`（第 26–31 行）：`{ readonly instanceId: string; readonly engine: SandoreEngineSurface }`
- `SandoreToolDefinition`（第 56–65 行）：`{ name; description; parameters: Record<string, unknown>; output: { schema; render(args, value): ContentBlock[] }; execute(args, exec): Promise<unknown> }`
- `SandoreToolResult`（第 42–53 行）：`{ ok: boolean; reason?; error?: SandoreErrorSummary; state?: DagInstanceState; run?: DagRun }`
- **`createSandoreTools`（第 277 行）**：`export function createSandoreTools(options: CreateSandoreToolsOptions): SandoreToolDefinition[]` —— 返回 8 个工具，名称与转调映射：
  `sandore_getState→getState` / `sandore_startInstance→startInstance` / `sandore_abortInstance→abortInstance` / `sandore_pauseStep→pauseStep` / `sandore_resumeStep→resumeStep` / `sandore_pauseAllSteps→pauseAllSteps` / `sandore_resumeAllPaused→resumeAllSteps` / `sandore_retryStep→retryStep`
- 每个工具 `execute` 闭包捕获 `instanceId`，全部转调 `engine` 实例级方法；对 completed 实例的 resume/retry/pause 返回结构化 no-op；engine 抛 `SandoreError` 摘要透传为 `error`。
- 依赖方向：tool 对 workflow 仅 `import type`（第 17–23 行），无运行时 import。

---

### ⑥ 测试 mock 的回放能力与 hostAgent 相关支持（seam-01 已扩展）

**`workflow/tests/mocks/agents.ts`（FakeAgentRegistry，seam-01 已扩展）**：
- `FakeSession`（第 27–33 行）：`events: SessionEvent[]` + `append(event)` —— 注意其事件形状是 microflow 的 `SessionEvent`（`assistant/message`/`assistant/chunk`），与 sessions.ts mock 的 `{ type, data }` 形状不同。
- `assistantMessageEvent` / `assistantChunkEvent` 助手（第 36–61 行）
- `FakeAgent`（第 64–83 行）：`id/options/session/inbox/ctx/status`，`whenIdle()` 立即 resolve；构造函数可注入自定义 session
- `makeSetupContext()`（第 86–91 行）：`tools.register` / `systemPrompt.section` 均为 no-op 记录
- **`FakeAgentRegistry`（第 94–141 行）**：
  - `get(id)` 查 Map
  - `create(options)`：**先 `createCwds.push(options.meta?.cwd)` 记录 meta.cwd** → `runSetup(options.setup)` → `new FakeAgent(options.sessionId, options.agentOptions)` 并登记 → 返回 `{ agent, dispose }`（dispose 从 Map 删除）
  - `resume(options)`：`runSetup(options.setup)` → 按 `resumeSessionId` get-or-create agent 并登记
  - `register(agent)`：显式登记（DAG 测试用于预埋真实 childId）
  - `runSetup(setup?)`：若 setup 存在则 `setupCount += 1`、`await setup(makeSetupContext())`、`commit?.commit()`
  - 回放字段：`createCwds: Array<string | undefined>`、`setupCount: number`

**`workflow/tests/mocks/sessions.ts`（FakeSessionStore）**：
- `FakeSession`（第 10–17 行）：`events: Array<{ type: string; data: unknown }>` + `append(type, data)` 返回 `{ type, seq, time, data }`
- `FakeSessionStore`（第 20–51 行）：`create(id?)` / `get(id)` / `list()` / `fork(source, boundary?, childSessionId?)`（seam-01 新增 fork，供 revert/fork 重试使用）
- **无 hostAgent 相关字段**（本 mock 是纯 session 仓库，不含 agent 语义）。

**`workflow/tests/mocks/subagents.ts`（FakeSubagents，seam-01 已扩展）**：
- `startContinuable(spec)`：记录 `spec` 到 `continuableStarts`，返回 `{ childId: 'child-N', messageId: 'msg-N' }`，并把 `spec.request.parent.id` 记入 `childParent` Map、状态记 `running`
- `followup(parent, childId, content, options)`：记录 + 状态置 `running`
- `interrupt(targetSessionId, authority)`：记录 + 状态置 `interrupted`
- `listChildren(parentSessionId, signal?)`：按 `childParent.get(id) === parentSessionId` 过滤（seam-01 新增）
- `childStatus(childId)` 查询辅助、`start(name, request)` 一次性子代理
- **无显式 hostAgent 字段**；hostAgent 的可观测点在于 `startContinuable` 的 `spec.request.parent.id` 与 `followup`/`interrupt` 的 parent/authority 记录 —— host-agent-01 后 parent.id 应从 `'sandore-host'`（桩）变为真实 instanceId。

---

### ⑦ workflow-engine.spec.ts 对 startInstance 的既有断言（改 agents.create 后需同步更新点）

文件：`packages/sandore/workflow/src/workflow-engine.spec.ts`

**harness（第 305–339 行）**：已 `ctx.provide('agents', new FakeAgentRegistry())`、`ctx.provide('subagents', new FakeSubagents())`、`ctx.provide('sessions', new FakeSessionStore())` 等，并返回 `{ sessions, subagents, agents, ... }`。

**关键断言与受影响点**：

1. **「事件双发」断言（第 481–494 行，`linear execution` 测试内）—— 主改动点**：
   ```ts
   const session = sessions.get(run.instanceId);
   expect(session?.events.map(event => event.type)).toEqual([ 'sandore/start', ... ]);
   ```
   当前从 `sessions`（FakeSessionStore）按 `run.instanceId` 取宿主 Session。改为 `ctx.agents.create` 后，宿主 session 不再进入 `sessions` 仓库，而是存在于 `FakeAgentRegistry.create` 产出的 `FakeAgent.session`（`FakeSession`，事件形状为 microflow `SessionEvent`）。该断言需改为从 host agent 读取（如 `agents.get(run.instanceId)?.session`），且事件形状/append 语义不同，需同步调整。

2. **`returns a run whose state is immediately readable`（第 415–425 行）**：`run.status === 'running'`、`getState(run.instanceId)` 读回 originalInput —— 不受 agents.create 影响，但可增补 `agents.createCwds` 含 cwd、`agents.setupCount` 递增等断言。

3. **`throws when the workflowId does not exist`（第 403–413 行）**：断言 `persistence.state.size === 0` —— 改动后仍成立（创建 agent 前即抛错），无需改动。

4. **`declares agents and userQuestions in the seam inject list`（第 383–386 行）**：断言 `SandoreEngineStub.inject` 含 `agents`/`userQuestions`（seam-01 已加）。但 `SandoreEngineRuntime.inject`（workflow-engine.ts 第 139 行）当前**不含** `agents`，host-agent-01 需同步补上，测试亦可增补对 Runtime inject 的断言。

5. **`synthesizes childId and sessionMeta`（第 556–574 行）**：断言 `sessionMeta.childId` 匹配 `/^step-step-abc-[0-9a-f]{8}$/` 且 `synthetic: true` —— 该语义由 shell/prompt 合成路径产生，不受 host agent 影响，预期不变。

6. **DAG 测试（第 700–778 行）**：`agents.register(child)` 预埋 `child-1` 供 agent Step 的 `ctx.agents.get('child-1')` 命中；改动后 `startInstance` 会额外调 `agents.create` 创建 id=instanceId 的宿主 agent，与 `child-1` 不冲突，但 `FakeSubagents.childParent` 中 agent Step 的 parent.id 会从 `'sandore-host'` 变为 instanceId（当前无断言直接校验 parent，属间接可观测点）。

**综上，host-agent-01 落到 workflow-engine.spec.ts 的最小同步点**：`sessions.get(run.instanceId)` 双发断言改走 host agent 的 session；可增补 `agents.createCwds` / `agents.setupCount` / `agents.get(instanceId)` 持有断言；`SandoreEngineRuntime.inject` 需补 `agents`（并对齐测试）。

---

### 参考实现依据（Task 4 host-agent-01 规格与计划）

- 规格：`furina/changes/task-4-lifecycle/specs/host-agent/spec.md`
  - 宿主主代理创建：`startInstance` 经 `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup })` 创建；setup 在发布前执行并注册 8 个 `sandore_*` 工具 + system prompt 注入；引擎持有 live `hostAgent` 存入 `ActiveInstance.hostAgent` 并注入 `StepRunnerConfig.hostAgent`。
  - 主代理不自动运行编排：创建后无首轮 prompt、status idle，编排仍由 `runInstance` 主循环驱动。
  - completed 后自然降级自由对话（无 DefaultSessionManager）。
  - 工具仅挂宿主 Session（per-instance 闭包隔离）。
  - 冷恢复：`ctx.agents.resume({ resumeSessionId, setup })`，setup 重跑；create/resume 共用同一工厂。
- 计划任务：`furina/changes/task-4-lifecycle/plan.json` 中 `host-agent-01`（status=`in_progress`，dependencies=`seam-01`/`tools-01`）：
  - 3.1 新建 `workflow/src/host-agent.ts`（`createHostAgentSetup` 工厂：工具注册 + system prompt 注入）
  - 3.2 改造 `workflow-engine.ts` `startInstance` 为 `ctx.agents.create`（含 meta/setup）
  - 3.3 `ActiveInstance` 增 `hostAgent` 字段
  - 3.4 `runnerConfig` 注入 `hostAgent` 到 `StepRunnerConfig.hostAgent`
  - 3.5 新建 `host-agent.spec.ts`
  - files：`host-agent.ts`、`host-agent.spec.ts`、`workflow-engine.ts`、`workflow-engine.spec.ts`
- 现状确认：`packages/sandore/workflow/src/` 下**尚无** `host-agent.ts` / `host-agent.spec.ts`（Glob 无命中），`createHostAgentSetup` 工厂待建。
