# title-01 宿主会话标题补设需求 — 参考实现探索

## 一、需求理解

- **What**：探明「宿主会话标题补设」所需的全部参考事实——DSH 官方 `@deepseek-ai/dsh-session-title` 服务的 `ctx.sessionTitle` 精确 API（尤其 `rename(session, title)` 的签名、返回值、`source` 语义、与 fallback 自动标题的优先级关系）；sandore 工作流引擎 `startInstance` 当前创建宿主 `Session` 的方式；`SandoreEngineRuntime` / `SandoreEngineStub` 两处 `static inject` 现状；既有测试对 `ctx.agents.create` / `ctx.sessionTitle` 的 stub 与断言模式；以及 `workflow/package.json` 是否已声明 `@deepseek-ai/dsh-session-title`。
- **Boundaries**：仅限 sandore 仓库 `packages/sandore/workflow`、`packages/sandore/microflow`（接缝类型）与已安装的 DSH 依赖（`node_modules` 内 `@deepseek-ai/dsh-session-title` / `dsh-agent` / `dsh-session`），不涉及实现方案。
- **Goal**：为后续「宿主会话标题补设」需求提供可核对的参考实现事实与现状基线，不产生任何方案或改动建议。

---

## 二、DSH `@deepseek-ai/dsh-session-title` 的 `ctx.sessionTitle` 精确 API

来源（已安装依赖，仅探索不修改）：
`D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-session-ti_e8048167f372a65732e2cb4509960da9/node_modules/@deepseek-ai/dsh-session-title/`

- 包版本：`0.1.0-rc.6`
- peerDependencies：`@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-projection`、`@deepseek-ai/cordis@^4.0.1`（均 `^0.1.0-rc.6` 或 `^4.0.1`）
- 导出入口 `"."` → `lib/index.js`，类型 `lib/types/index.d.ts`

### 2.1 服务声明与 ctx 键

`lib/types/index.d.ts` 中声明：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTitle: SessionTitleService;
  }
}
```

`SessionTitleService`（`lib/index.js`）关键声明：

```js
static inject = ["sessions"];  // 仅注入 sessions
static Config = z.object({
  fallbackMaxWords: z.number().step(1).min(1).required(),  // 必填，无默认值
  fallbackMaxBytes: z.number().step(1).min(1).required(),  // 必填，无默认值
  maxTitleBytes: z.number().step(1).min(1).required(),      // 必填，无默认值
});
```

构造器 `super(ctx, "sessionTitle")`，即 Cordis 服务名/ctx 键为 `sessionTitle`。构造时还会 `ctx.inject(["sessionProjections"], ...)` 注册 `title` 投影键，并监听 `session/event`、`llm/stream`、`session/disposed`。

### 2.2 `rename(session, title)` 签名与返回值

`lib/types/index.d.ts`：

```ts
rename(session: Session, title: string): SessionTitleSnapshot;
```

要点：
- **同步方法**（非 Promise）。
- 第一个参数是 `Session`（`@deepseek-ai/dsh-session` 的 live session 对象），第二个参数是原始标题字符串。
- **返回值**：`SessionTitleSnapshot`——被接受并折叠后的最新标题快照，形状为：

```ts
interface SessionTitleSnapshot extends SessionTitleEventData {
  readonly eventSeq: number;   // 最新 session/title 事件的 seq
  readonly updatedAt: number;  // 最新 session/title 事件的时间戳
}
interface SessionTitleEventData {
  readonly title: string;        // 规范化后非空标题
  readonly messageSeqs: number[]; // 显式 rename 时恒为 []
  readonly source: SessionTitleSource;
}
```

- **抛错**：
  - 标题规范化后为空 → 抛 `SessionTitleInvalidError`（`Error` 子类，`name === "SessionTitleInvalidError"`）。这是唯一「归因于输入」的失败，调用方把它翻译成 wire 上的 `title-invalid` 时按此类判断。
  - session 不在 live store（`ctx.sessions.get(session.id) !== session`）→ 抛普通 `Error`（`session "..." is not live in this store`）。
  - 服务已 dispose → 抛普通 `Error`（`session-title service disposed`）。

`rename` 内部行为（`lib/index.js`）：
1. `assertServiceActive()`；
2. 校验 session 是 store 中的 live 实例；
3. `normalizeSessionTitle(title, maxTitleBytes)` 规范化（去终端控制序列、去方向性控制字符、空白折叠、UTF-8 安全截断）；
4. 规范化后为空 → 抛 `SessionTitleInvalidError`；
5. `supersede(state, "user rename superseded automatic title generation")` 中止在途自动生成；
6. `session.append("session/title", { title, messageSeqs: [], source: { kind: "user" } })`；
7. `return this.get(session)`（读回折叠后的快照）。

### 2.3 `source` 语义

`SessionTitleSource`（`lib/types/index.d.ts`）：

```ts
type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'provider'; readonly provider: SessionTitleProviderId; readonly model?: SessionTitleModelProvenance }
  | { readonly kind: 'user' };  // 显式用户 rename：钉住标题
```

- `fallback`：内置确定性回退标题（取首条符合条件的用户 `user/message` 文本的开头若干词）。
- `provider`：唯一可选的异步提供方生成，携带 provider id 与可选 `model` 溯源。
- `user`：显式 `rename`，**钉住（pin）标题**——后续自动生成停止调度。

### 2.4 `rename`（user 来源）何时优先于 fallback 自动标题

优先级规则（来自 `lib/index.js` 的 `onUserMessage` / `ensureFallback` / `refresh`）：

1. **user 来源钉住**：`onUserMessage` 中 `if (this.get(session)?.source.kind === "user") return;`——一旦存在 `source.kind === "user"` 的标题，后续任何用户消息都**不再调度自动修订**（既不调度 provider，也不调度 fallback）。
2. **fallback 只在无标题时物化**：`ensureFallback` 开头 `if (current !== void 0) return current;`——只要已有任何标题（含 user/provider），就不追加 fallback。
3. **唯一解钉是显式 `refresh`**：`refresh` 在无 provider 分支里，若 `current?.source.kind === "user"`，会调用 `appendFallback(session, first)` **覆盖**被钉住的 user 标题（追加一条 `source: { kind: "fallback" }` 的 `session/title`）。`rename` 的 JSDoc 也明确：「an explicit `refresh` remains the deliberate unpin」。

即优先级链：**显式 `rename`（user）> provider 自动生成 / fallback 自动回退**；fallback 仅在会话尚无任何标题时才物化；`rename` 会同步中止在途自动生成并钉住。

### 2.5 其他服务方法（与本需求相关的补充事实）

- `get(session): SessionTitleSnapshot | undefined` — 折叠最新已接受标题（live 或 replay 日志）。
- `refresh(session, signal?): Promise<SessionTitleSnapshot | undefined>` — 显式重跑 provider 或物化 fallback（解钉手段）。
- `register(provider): () => Promise<void>` — 注册唯一可选 provider，返回 Cordis effect disposer；第二次注册立即抛错。
- `session/title` 事件是 **log-only**（不进入 `deriveMessages()` / 系统提示 / 工具 schema / 请求前缀），通过 `session.append` 追加。
- fork 出的会话原样继承种子中的标题事件。

---

## 三、sandore `startInstance` 当前如何创建宿主 Session

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

`startInstance`（约 187–220 行）创建宿主的完整链路：

```ts
const handle = await this.ctx.agents.create({
  sessionId: SessionId(instanceId),
  meta: { cwd },
  setup: createHostAgentSetup({ instanceId, engine: this }),
});
const hostAgent = handle.agent;
// agents.create 已把宿主 Session 发布进 ctx.sessions，此处读回 live 会话用于事件双发。
const session = this.ctx.sessions.get(SessionId(instanceId));
if (session === undefined) {
  throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
}
```

事实要点：
- `ctx.agents.create` 返回 **`AgentHandle`**，其结构（`subagents.ts` 接缝，见下）只有 `{ agent, dispose() }`——**没有 `handle.session` 字段**。
- 宿主 `Session` 不是从 handle 读，而是 **`this.ctx.sessions.get(SessionId(instanceId))` 读回**：`agents.create` 发布时会把宿主 Session 放进 `ctx.sessions` store。
- `session` 的类型是 `Session`（`import type { Session } from '@deepseek-ai/dsh-session'`，见文件头第 17 行），即 DSH `SessionStore` 中的 live session（类 `Session`，非 Service，`lib/types/index.d.ts` 定义）。它提供了 `events`、`append(type, data)`、`id`、`seq`、`requestHeader()`、`deriveMessages()` 等。
- `ActiveInstance.session` 字段类型同样是 `Session`（第 57 行）。
- 注意：`hostAgent`（`handle.agent`）本身也带 `session`（DSH `Agent` 接口有 `readonly session: Session`），但当前引擎**没有**用 `handle.agent.session`，而是统一用 `ctx.sessions.get(...)` 读回。

### 3.1 微流接缝中的 `AgentHandle` / `Session` 结构

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`

```ts
export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}

export interface Session {
  readonly events: readonly SessionEvent[];
}

export interface Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;    // 注意：接缝里 agent 也有 session
  readonly inbox: { readonly hasPending: boolean };
  readonly status: AgentStatus;
  readonly ctx: unknown;
  whenIdle(): Promise<void>;
}
```

该文件注释明确：`@deepseek-ai/dsh-agent` 未作为运行时依赖，这里按 DSH 公开 API 复刻最小结构类型。`SessionId` 在此接缝中是 `type SessionId = string`（与 DSH `SessionId` 品牌字符串结构兼容）。

---

## 四、`SandoreEngineRuntime` 与 `SandoreEngineStub` 的 `static inject`

### 4.1 `workflow-engine.ts`（`SandoreEngineRuntime`，第 173 行）

```ts
static inject = ['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'fs', 'storageDomain', 'sandorePersistence', 'userQuestions'];
```

### 4.2 `seam.ts`（`SandoreEngineStub`，第 145 行）

```ts
static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions'];
```

### 4.3 两处差异（重要）

- **Runtime 含 `sandorePersistence`，Stub 不含**（Stub 是 Provider 桩，不做持久化执行，但两者依赖集不一致）。
- 顺序略有差异：Runtime 为 `... 'subagents', 'agents', 'llm', ...`；Stub 为 `... 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', ...`。
- 两者均**未**声明 `sessionTitle`。
- 既有测试对 inject 的断言仅覆盖 `agents` 与 `userQuestions`（`workflow-engine.spec.ts` 第 496–501 行），未断言完整 inject 数组。

---

## 五、既有测试的 stub 与断言模式

### 5.1 harness 注入模式

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`（第 414–452 行）

测试通过 `ctx.provide(key, value)` 注入内存 mock：

```ts
const ctx = new Context();
// ... persistence ...
ctx.provide('llm', llm as unknown as LlmRuntime);
ctx.provide('shell', shell as unknown as ShellExecutor);
ctx.provide('sessions', sessions as unknown as SessionStore);
ctx.provide('sessionPersistence', {});
ctx.provide('subagents', subagents);
ctx.provide('agents', agents);
ctx.provide('subprocess', subprocess);
ctx.provide('userQuestions', userQuestions);
ctx.provide('fs', {});
await ctx.plugin(SandoreEngineRuntime, config);
const engine = ctx.sandoreEngine;
```

**当前 harness 未 `ctx.provide('sessionTitle', ...)`，且全仓库 `packages/**` 无任何 `sessionTitle` 引用（Grep 0 命中）。**

### 5.2 `ctx.agents.create` 的 mock

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/agents.ts`

- `FakeAgentRegistry implements AgentRegistry`，`create(options)`：
  - 记录 `createCwds`（每次 `options.meta?.cwd`）与 `createSeeds`；
  - `runSetup(options.setup)`（记录 `setupCount`，可用 `setupError` 模拟 setup 抛错回滚）；
  - `new FakeAgent(...)` 并登记；
  - 若构造时传入 `FakeSessionStore`，则 `this.sessions.create(options.sessionId)` 把宿主 Session 登记进 session store（模拟 DSH 行为：`agents.create` 发布时 session 进入 store，引擎再 `ctx.sessions.get` 读回）；
  - 返回 `{ agent, dispose: async () => { this.agents.delete(agent.id); } }`。
- `FakeAgent` 自带 `readonly session: FakeSession`（`events` + `append`）。

### 5.3 `ctx.sessions` 的 mock

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/sessions.ts`

- `FakeSessionStore`：`create(id?)` / `get(id)` / `list()` / `fork(...)`。
- `FakeSession`：`events: FakeSessionEvent[]` + `append(type, data)`（记录 `{ type, seq, time, data }`）。

### 5.4 断言模式示例

`workflow-engine.spec.ts`（第 545–557 行）：

```ts
const run = await engine.startInstance({ workflowId: 'wfl-linear', jobId: 'job-1', originalInput: 'do it', cwd: '/srv/app' });
expect(agents.createCwds).toEqual(['/srv/app']);   // 断言 meta.cwd
expect(agents.setupCount).toBe(1);                  // 断言 setup 执行次数
const hostAgent = agents.get(run.instanceId);
expect(hostAgent).toBeDefined();
expect(hostAgent?.status).toBe('idle');
expect(hostAgent?.inbox.hasPending).toBe(false);
```

session 双发断言示例（第 1348 行附近）：

```ts
expect(sessions.get(run.instanceId)?.events.some(event => event.type === 'sandore/step-retried')).toBe(true);
```

即：断言模式为「读回 mock store 记录」+「断言记录列表/计数」，而非 spy 断言。对 `ctx.sessionTitle` 目前**尚无任何 mock、stub 或断言**——若后续需要，需新建 `FakeSessionTitle` 并通过 `ctx.provide('sessionTitle', ...)` 注入。

---

## 六、`workflow/package.json` 是否已有 `@deepseek-ai/dsh-session-title`

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/package.json`

- `peerDependencies`（第 46–58 行）与 `devDependencies`（第 59–71 行）**均无 `@deepseek-ai/dsh-session-title`**。
- 现有 session 相关依赖仅为 `@deepseek-ai/dsh-session: 0.1.0-rc.6`（两处都有）。
- 结论：`@deepseek-ai/dsh-session-title` 尚未声明为 workflow 包的任何依赖。

---

## 附：关键文件路径清单

- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`（startInstance 187–220 行；Runtime inject 173 行）
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`（Stub inject 145 行；`SandoreEngine` 抽象 75–105 行）
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`（`AgentHandle`/`Session`/`Agent` 接缝类型）
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`（harness 414–452 行；create 断言 545–557 行）
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/agents.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/sessions.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/package.json`
- DSH 依赖（只读）：
  - `D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-session-ti_e8048167f372a65732e2cb4509960da9/node_modules/@deepseek-ai/dsh-session-title/`（`lib/index.js`、`lib/types/index.d.ts`、`README.md`、`README.zh.md`、`package.json`）
  - `D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-agent@0.1._b4d21d21ca969d276a9ff06d3d7f5f09/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts`（`AgentHandle`、`AgentFactory`）
  - `D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-session@0._959f4648d9537c86268b5de534a89875/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts`（`Session` 类、`SessionStore`）
