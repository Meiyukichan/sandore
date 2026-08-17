## Exploration Result

探索范围：DSH（`D:\project-code\llm\deepseek-harness`）的 `@deepseek-ai/dsh-session-title` 服务确切 API；sandore（`D:\project-code\llm\sandore`）`workflow` 包的 `startInstance` 宿主 Session 创建、`SandoreEngineRuntime`/`SandoreEngineStub` 的 `static inject`、既有测试 stub 模式、`workflow/package.json` 依赖。全部结论基于实际代码。

### 1. DSH `@deepseek-ai/dsh-session-title` 的 `ctx.sessionTitle` 确切 API

包源码：`D:\project-code\llm\deepseek-harness\packages\session\session-title\src\index.ts`（服务类 `SessionTitleService`），类型同包 `src/types.ts`，Cordis 面文档：`docs\subsystems\session-title.zh.md`。包名确认为 `@deepseek-ai/dsh-session-title`（`packages/session/session-title/package.json`，name 字段）。

`ctx.sessionTitle` 由 declaration merge 声明（`index.ts` 第 88–92 行）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTitle: SessionTitleService
  }
}
```

服务依赖声明：`static inject = ['sessions']`（`index.ts` 第 262 行，仅依赖 session store）。

#### `rename(session, title)` 签名与返回值

```ts
rename(session: Session, title: string): SessionTitleSnapshot
```

- 参数 1 `session` 是 `@deepseek-ai/dsh-session` 的 `Session`（活会话）；参数 2 `title` 是原始用户输入字符串。
- 实现（`index.ts` 第 363–383 行）流程：
  1. `assertServiceActive()`——服务已卸载则抛 `Error('session-title service disposed')`。
  2. 校验 `this.ctx.sessions.get(session.id) !== session` 时抛 `Error('session "..." is not live in this store')`（要求是 store 中活的会话）。
  3. `normalizeSessionTitle(title, maxTitleBytes)` 归一化（折叠空白、字节上限截断）；归一化后为空则抛 `SessionTitleInvalidError('session title must contain visible characters')`。
  4. `this.supersede(state, 'user rename superseded automatic title generation')`——中止所有 in-flight 自动标题生成。
  5. `session.append('session/title', { title: normalized, messageSeqs: [], source: { kind: 'user' } })`。
  6. 返回 `this.get(session)`（即 `foldSessionTitle` 折出的最新快照，理论上必为 `undefined` 之外）。
- 返回值类型 `SessionTitleSnapshot`（`index.ts` 第 70–76 行）：

```ts
interface SessionTitleSnapshot extends SessionTitleEventData {
  readonly eventSeq: number
  readonly updatedAt: number
}
// SessionTitleEventData（第 61–68 行）：
interface SessionTitleEventData {
  readonly title: string          // 归一化后的非空标题文本
  readonly messageSeqs: number[]  // 显式 rename 时恒为空数组
  readonly source: SessionTitleSource
}
```

#### `source` 语义（`SessionTitleSource`，`index.ts` 第 48–58 行）

三种判别联合：

```ts
type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'provider'; readonly provider: SessionTitleProviderId; readonly model?: SessionTitleModelProvenance }
  | { readonly kind: 'user' }  // 显式用户 rename：pins the title
```

- `fallback`：内置确定性回退标题（取首条合格人类消息文本，`fallbackSessionTitle` 派生，含 `fallbackMaxWords`/`fallbackMaxBytes` 上限）。
- `provider`：已注册可选标题提供方生成（携带 provider id 与可选 model 路由）。
- `user`：显式 `rename` 产生，`messageSeqs` 恒为空。**pins the title（钉住标题）——停止调度自动生成。**

#### 何时优先于 fallback 自动标题

- `rename` 产生的 `user` 标题天然压过 fallback/自动标题：
  - `ensureFallback`（`index.ts` 第 755–789 行）仅在 `this.get(session) === undefined`（尚无任何标题）时才会派生并追加 fallback；已有标题（含 user 源）时直接返回现有标题，**fallback 绝不覆盖已有标题**。
  - `onUserMessage`（第 462–486 行）每次新用户消息时先检查 `if (this.get(session)?.source.kind === 'user') return`——只要最新标题是 user 源，后续任何人类提示都不再调度自动生成（provider 或 fallback 都不调度）。
  - `rename` 内部 `supersede(...)` 会中止正在进行中的自动 provider 生成（`rename.spec.ts` 的 `supersedes in-flight automatic generation` 用例断言：迟到的 provider 结果被中止、不会覆盖 user 标题）。
- 唯一"解钉"方式是显式 `refresh(session, signal?)`（`index.ts` 第 392–426 行），它会重新派生 fallback 或重跑 provider。
- 因此：`startInstance` 中 `ctx.sessionTitle.rename(handle.session, '工作流实例 xxx')` 后，`source=user` 标题天然优先于 DSH 的 fallback 自动摘要。

补充：`SessionTitleService` 还有 `get(session): SessionTitleSnapshot | undefined`（读取最新折叠标题）、`refresh(session, signal?)`、`register(provider)` 三个方法（见 `docs\subsystems\session-title.zh.md` 的 Cordis API 目录，与源码一致）。

### 2. sandore `startInstance` 当前如何创建宿主 Session

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`，`SandoreEngineRuntime.startInstance`（第 187–220 行）。

- 创建调用（第 204–208 行）：

```ts
const handle = await this.ctx.agents.create({
  sessionId: SessionId(instanceId),
  meta: { cwd },
  setup: createHostAgentSetup({ instanceId, engine: this }),
});
const hostAgent = handle.agent;
```

- `ctx.agents.create` 返回 `AgentHandle`。sandore 本地接缝类型（`packages/sandore/microflow/src/subagents.ts` 第 50–53 行）：

```ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

  **本地 `AgentHandle` 没有 `session` 字段**；DSH 真实 `AgentHandle`（`deepseek-harness\packages\core\agent\src\index.ts` 第 172–175 行）同样只有 `{ agent, dispose }`。因此 `handle.session` 在 sandore 代码里不可用/不存在。

- **Session 的访问方式**：引擎用 `handle.agent`（`Agent`，其 `session` 字段是 `readonly session: Session`）拿代理，但**不通过 `handle.agent.session` 取宿主 Session**，而是从 session store 读回（第 211 行）：

```ts
const session = this.ctx.sessions.get(SessionId(instanceId));
if (session === undefined) {
  throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
}
```

  注释明确："agents.create 已把宿主 Session 发布进 ctx.sessions，此处读回 live 会话用于事件双发。"

- **Session 类型**：`Session` 来自 `@deepseek-ai/dsh-session`（`workflow-engine.ts` 第 17 行 `import type { Session } from '@deepseek-ai/dsh-session';`，`SessionId` 亦同源）。DSH `Session` 类（`deepseek-harness\packages\core\session\src\index.ts` 第 425 行起）关键面：`readonly header: SessionHeader`、`get id(): SessionId`、`get events(): readonly SessionEvent[]`、`get seq(): number`、`append(type, data, ...opts)`（追加事件）、`requestHeader(): EpochHeader | undefined`。`sessionTitle.rename` 的第一个参数正是这个 `Session` 类型。

- 注意：`recoverInstance`（第 309–312 行）用 `ctx.agents.resume({ resumeSessionId, setup })` 冷恢复，同样 `handle.agent` + `ctx.sessions.get` 读回 Session。

### 3. `SandoreEngineRuntime` 与 `SandoreEngineStub` 的 `static inject` 当前声明

- `SandoreEngineRuntime`（`workflow-engine.ts` 第 173 行）：

```ts
static inject = ['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'fs', 'storageDomain', 'sandorePersistence', 'userQuestions'];
```

- `SandoreEngineStub`（`seam.ts` 第 145 行）：

```ts
static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions'];
```

差异：Runtime 比 Stub 多 `'sandorePersistence'`，且数组顺序不同（Stub 无 `sandorePersistence`）。两处当前**均无 `'sessionTitle'`**。`SandoreEngine` 抽象基类与 `SandoreEngineStub` 均在 `seam.ts`；`seam.ts` 同时用 declaration merge 声明了 `ctx.sandoreEngine`、`ctx.userQuestions`（第 28–33 行）与 13 个 `sandore/*` 事件（Cordis `Events` + dsh-session `SessionEventMap`）。

### 4. 既有测试如何 stub `ctx.agents.create` / `ctx.sessionTitle` 及断言模式

测试文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.spec.ts`（1636 行）；mock 在 `packages\sandore\workflow\tests\mocks\`。

- **注入方式**：`harness(config)`（spec 第 415–452 行）构造 `new Context()`，用 `ctx.provide('agents', agents)` / `ctx.provide('sessions', sessions)` / `ctx.provide('llm', llm)` 等注入内存 mock，再 `await ctx.plugin(SandoreEngineRuntime, config)`，取 `ctx.sandoreEngine`。
- **`ctx.agents.create` 的 stub**：`FakeAgentRegistry`（`tests/mocks/agents.ts` 第 96–164 行）。`create()` 记录 `options.meta?.cwd` 到 `createCwds`、`options.seed` 到 `createSeeds`，执行 `setup`（`setupCount++`），构造 `FakeAgent(options.sessionId, options.agentOptions)`，注册进 map，并**同步把宿主 Session 发布进 session store**（`this.sessions.create(options.sessionId)`，第 127–129 行），返回 `{ agent, dispose }`。`resume()` 同理返回 `{ agent, dispose }`。`FakeAgent` 实现 `Agent` 接缝（`id`/`options`/`session`/`inbox`/`status`/`whenIdle`），`session` 是 `FakeSession`（带 `events` + `append`）。
- **`ctx.sessionTitle` 的 stub**：**当前不存在**。`tests/mocks/` 目录只有 `agents/llm/sessions/shell/storage-domain/subagents/subprocess/user-questions` 八个 mock，无 session-title mock；spec 中 grep `sessionTitle` 无命中。`harness()` 也未 `ctx.provide('sessionTitle', …)`。
- **断言模式**（startInstance 相关，spec 第 524–594 行）：
  - `expect(agents.createCwds).toEqual(['/srv/app'])`（断言 `meta.cwd` 透传）
  - `expect(agents.setupCount).toBe(1)`（断言 setup 执行次数）
  - `const hostAgent = agents.get(run.instanceId); expect(hostAgent).toBeDefined(); expect(hostAgent?.status).toBe('idle'); expect(hostAgent?.inbox.hasPending).toBe(false)`（断言宿主代理被注册且 idle 无自动 prompt）
  - `agents.setupError = new Error('setup boom')` 后 `await expect(engine.startInstance(...)).rejects.toThrow('setup boom'); expect(persistence.state.size).toBe(0)`（setup 抛错回滚，state 表为空）
  - 事件双发断言：`const session = sessions.get(run.instanceId); expect(session?.events.map(e => e.type)).toEqual([...])`（宿主 Session 事件序）
  - seam inject 断言（spec 第 496–501 行）：`expect(SandoreEngineStub.inject).toContain('agents')`、`expect(SandoreEngineRuntime.inject).toContain('userQuestions')` 等。
- 测试依赖真实 `@deepseek-ai/dsh-session` 的 `SessionStore` 类型（`workflow-engine.spec.ts` 第 8 行 `import type { SessionStore } from '@deepseek-ai/dsh-session'`），但 `sessions` mock 是 `FakeSessionStore`（`tests/mocks/sessions.ts`，`create/get/list/fork`）。

### 5. `workflow/package.json` 是否已有 `@deepseek-ai/dsh-session-title`

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\package.json`。

- **`peerDependencies`（第 46–58 行）没有 `@deepseek-ai/dsh-session-title`**。现有：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-sandore-microflow`、`@deepseek-ai/dsh-session`（0.1.0-rc.6）、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/schemastery`。
- **`devDependencies`（第 59–71 行）同样没有 `@deepseek-ai/dsh-session-title`**（与 peerDependencies 同清单）。
- `dependencies` 只有 `yaml`、`zod`。

补充事实（非本 package.json，但相关）：仓库根 `pnpm-lock.yaml`（`D:\project-code\llm\sandore\pnpm-lock.yaml` 第 501 行起）已解析并记录 `@deepseek-ai/dsh-session-title@0.1.0-rc.6`（integrity + peerDependencies `cordis/dsh-brand/dsh-invariants/dsh-llm/dsh-session/dsh-session-projection`），但它是作为 `@deepseek-ai/dsh-session-query@0.1.0-rc.6` 的 peerDependency 被带入锁文件的，并非 sandore 任何 package.json 的直接依赖；sandore 各包的 `node_modules/@deepseek-ai/`（如 workflow 包下）当前**未安装** `dsh-session-title`（仅 cordis/dsh-agent/dsh-llm/dsh-sandore-microflow/dsh-session/dsh-storage/dsh-storage-domain/dsh-subagent/dsh-subprocess/dsh-typert-protocol/schemastery）。

## Supplementary Exploration Result

无需补充探索。`experimental.websearch=true`、`experimental.context7=true`，但本次目标（DSH session-title API、sandore startInstance/inject/测试/package.json）均已在本地代码中完整取证，本地源码比联网资料更权威，故未发起 websearch/context7 查询。
