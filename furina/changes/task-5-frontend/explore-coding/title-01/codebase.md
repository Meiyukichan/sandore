## Exploration Result

探索范围：DSH 的 `@deepseek-ai/dsh-session-title` 服务确切 API（`ctx.sessionTitle`）；sandore `workflow` 包的 `startInstance` 宿主 Session 创建方式、`SandoreEngineRuntime`/`SandoreEngineStub` 的 `static inject`、既有测试 stub/断言模式、`workflow/package.json` 依赖。全部结论基于实际代码取证（本机 `node_modules` 内 `@deepseek-ai/dsh-session-title@0.1.0-rc.6` 源码 + sandore `packages/sandore/` 源码）。

### 1. DSH `@deepseek-ai/dsh-session-title` 的 `ctx.sessionTitle` 确切 API

包源码（本机已安装，版本 `0.1.0-rc.6`）：
`node_modules/.pnpm/@deepseek-ai+dsh-session-ti_e8048167f372a65732e2cb4509960da9/node_modules/@deepseek-ai/dsh-session-title`
- 服务类 `SessionTitleService`（`lib/types/index.d.ts` 第 141 行起，实现 `lib/types/index.js`）。
- Cordis 面声明（`lib/types/index.d.ts` 第 62–66 行）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTitle: SessionTitleService
  }
}
```

- 依赖注入：`static inject = ['sessions']`（`lib/types/index.js` 第 91 行，仅依赖 session store）。
- 配置 schema（`lib/types/index.js` 第 92–96 行，三项均必填、正整数）：

```ts
static Config = z.object({
  fallbackMaxWords: z.number().step(1).min(1).required(),
  fallbackMaxBytes: z.number().step(1).min(1).required(),
  maxTitleBytes: z.number().step(1).min(1).required(),
})
```

构造时还会校验 `fallbackMaxBytes <= maxTitleBytes`（第 114–116 行），三项缺一/非法即抛错（库不提供默认值）。

#### `rename(session, title)` 签名与返回值

```ts
rename(session: Session, title: string): SessionTitleSnapshot
```

- 参数 1 `session` 是 `@deepseek-ai/dsh-session` 的活 `Session`；参数 2 `title` 是原始用户输入字符串。
- 实现（`lib/types/index.js` 第 187–208 行）流程：
  1. `assertServiceActive()`——服务已卸载则抛错。
  2. 校验 `this.ctx.sessions.get(session.id) !== session` 时抛 `Error('session "..." is not live in this store')`（要求是 store 中活的会话）。
  3. `normalizeSessionTitle(title, maxTitleBytes)` 归一化（折叠空白、去终端控制序列、按 UTF-8 字节上限截断且不切断码点）；归一化后为空则抛 `SessionTitleInvalidError('session title must contain visible characters')`（`SessionTitleInvalidError.name === 'SessionTitleInvalidError'`）。
  4. `this.supersede(state, 'user rename superseded automatic title generation')`——中止所有 in-flight 自动标题生成。
  5. `session.append('session/title', { title: normalized, messageSeqs: [], source: { kind: 'user' } })`。
  6. 返回 `this.get(session)`（即 `foldSessionTitle` 折出的最新快照，`SessionTitleSnapshot`）。
- 返回值类型 `SessionTitleSnapshot`（`lib/types/index.d.ts` 第 38–52 行）：

```ts
interface SessionTitleEventData {
  readonly title: string          // 归一化后的非空标题文本
  readonly messageSeqs: number[]  // 显式 rename 时恒为空数组
  readonly source: SessionTitleSource
}
interface SessionTitleSnapshot extends SessionTitleEventData {
  readonly eventSeq: number
  readonly updatedAt: number
}
```

#### `source` 语义（`SessionTitleSource`，`lib/types/index.d.ts` 第 27–36 行）

三种判别联合：

```ts
type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'provider'; readonly provider: SessionTitleProviderId; readonly model?: SessionTitleModelProvenance }
  | { readonly kind: 'user' }  // 显式用户 rename：pins the title
```

- `fallback`：内置确定性回退标题（取首条合格人类文本消息的前若干词，受 `fallbackMaxWords`/`fallbackMaxBytes` 上限约束）。
- `provider`：已注册可选标题提供方生成（携带 provider id 与可选 model 路由）。
- `user`：显式 `rename` 产生，`messageSeqs` 恒为空；**pins the title（钉住标题）——停止调度自动生成。**

#### 何时优先于 fallback 自动标题

- `rename` 产生的 `user` 标题天然压过 fallback/自动标题：
  - `onUserMessage`（`lib/types/index.js` 第 286–293 行）每次新用户消息先检查 `if (this.get(session)?.source.kind === 'user') return`——只要最新标题是 user 源，后续任何人类提示都不再调度自动生成（provider 与 fallback 都不调度）。
  - `rename` 内部 `supersede(...)` 中止正在进行中的自动 provider 生成（迟到的 provider 结果被 `assertCurrent` 判 stale 丢弃，无法覆盖 user 标题）。
  - `ensureFallback` 仅在会话尚无任何标题时才派生并追加 fallback；已有标题（含 user 源）时直接返回现有标题，**fallback 绝不覆盖已有标题**。
- 唯一“解钉”方式是显式 `refresh(session, signal?)`（`lib/types/index.js` 第 216–250 行），它会重新派生 fallback（覆盖被钉住的 user 标题，见第 229–235 行）或重跑 provider。
- 因此 `startInstance` 中 `ctx.sessionTitle.rename(session, '工作流实例 xxx')` 后，`source=user` 标题天然优先于 DSH 的 fallback 自动摘要。

补充：`SessionTitleService` 另有 `get(session): SessionTitleSnapshot | undefined`、`refresh(session, signal?): Promise<SessionTitleSnapshot | undefined>`、`register(provider): () => Promise<void>` 三个方法（`lib/types/index.d.ts` 第 156/176/183 行）。`rename` 是**同步**方法；`refresh` 是异步。

### 2. sandore `startInstance` 当前如何创建宿主 Session

文件：`packages/sandore/workflow/src/workflow-engine.ts`，`SandoreEngineRuntime.startInstance`（第 187–220 行）。

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

  **本地 `AgentHandle` 没有 `session` 字段**（`handle.session` 不存在）。真实 DSH `@deepseek-ai/dsh-agent` 的 `AgentHandle` 同样只有 `{ agent; dispose() }`（`node_modules/.../dsh-agent/lib/types/index.d.ts` 第 155–158 行）。DSH 的 `Agent` 接口有 `readonly session: Session` 字段（`node_modules/.../dsh-agent/lib/types/runtime-types.d.ts` 第 60–66 行），sandore 接缝的 `Agent` 接口同样有 `readonly session: Session`（`subagents.ts` 第 41 行）。即正确路径是 `handle.agent.session`，而非 `handle.session`。

- **当前代码对宿主 Session 的访问方式**：不通过 `handle.agent.session`，而是从 session store 读回（第 209–214 行）：

```ts
const hostAgent = handle.agent;
// agents.create 已把宿主 Session 发布进 ctx.sessions，此处读回 live 会话用于事件双发。
const session = this.ctx.sessions.get(SessionId(instanceId));
if (session === undefined) {
  throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
}
```

- **Session 类型**：`Session` 来自 `@deepseek-ai/dsh-session`（`workflow-engine.ts` 第 17 行 `import type { Session } from '@deepseek-ai/dsh-session';`，第 18 行 `import { SessionId } from '@deepseek-ai/dsh-session';`）。`ctx.sessions.get(id)` 返回 `Session | undefined`（`dsh-session/lib/types/index.d.ts` 第 393 行）。DSH `Session` 类（同文件第 106–267 行）关键面：`readonly header: SessionHeader`、`get id(): SessionId`、`get events(): readonly SessionEvent[]`、`get seq(): number`、`append(type, data, ...opts)`、`requestHeader()`、`deriveMessages()`。`SessionId` 是品牌字符串（`dsh-session/lib/types/types.d.ts` 第 6 行 `type SessionId = Branded<'SessionId'>`，第 12 行 `function SessionId(id: string): SessionId`）。`sessionTitle.rename` 的第一个参数正是这个 `Session` 类型。

- `recoverInstance`（第 309–317 行）用 `ctx.agents.resume({ resumeSessionId: SessionId(instanceId), setup: createHostAgentSetup({ instanceId, engine: this }) })` 冷恢复，同样 `handle.agent` + `ctx.sessions.get(...)` 读回 Session。

### 3. `SandoreEngineRuntime` 与 `SandoreEngineStub` 的 `static inject` 当前声明

- `SandoreEngineRuntime`（`workflow-engine.ts` 第 173 行）：

```ts
static inject = ['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'fs', 'storageDomain', 'sandorePersistence', 'userQuestions'];
```

- `SandoreEngineStub`（`seam.ts` 第 145 行）：

```ts
static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions'];
```

差异：Runtime 比 Stub 多 `'sandorePersistence'`，且两处数组顺序不同。两处当前**均无 `'sessionTitle'`**。`SandoreEngine` 抽象基类（含 11 个抽象实例方法）与 `SandoreEngineStub` 都在 `seam.ts`（第 75–190 行）；`seam.ts` 还 declaration merge 声明了 `ctx.sandoreEngine`、`ctx.userQuestions`（第 28–33 行）与 13 个 `sandore/*` 事件（Cordis `Events` + `@deepseek-ai/dsh-session/types` 的 `SessionEventMap`，第 34–67 行）。

### 4. 既有测试如何 stub `ctx.agents.create` / `ctx.sessionTitle` 及断言模式

测试文件：`packages/sandore/workflow/src/workflow-engine.spec.ts`；mock 在 `packages/sandore/workflow/tests/mocks/`。

- **注入方式**：`harness(config)`（spec 第 415–452 行）构造 `new Context()`，用 `ctx.provide(...)` 注入内存 mock：`storageDomain`、`llm`、`shell`、`sessions`、`sessionPersistence`、`subagents`、`agents`、`subprocess`、`userQuestions`、`fs`，再 `await ctx.plugin(SandoreEngineRuntime, config)` 取 `ctx.sandoreEngine`。
- **`ctx.agents.create` 的 stub**：`FakeAgentRegistry`（`tests/mocks/agents.ts` 第 96–164 行）。`create()` 记录 `options.meta?.cwd` 到 `createCwds`、`options.seed` 到 `createSeeds`，执行 `setup`（成功 `setupCount++`，失败抛 `setupError`），构造 `FakeAgent(options.sessionId, options.agentOptions)`，注册进内部 map，并**同步把宿主 Session 发布进 session store**（`this.sessions.create(options.sessionId)`，第 127–129 行，镜像 DSH `agents.create` 的行为），返回 `{ agent, dispose }`（即 `AgentHandle`）。`resume()` 同理返回 `{ agent, dispose }`。`FakeAgent`（第 66–85 行）实现 `Agent` 接缝（`id`/`options`/`session`/`inbox`/`status`/`whenIdle`），`session` 是 `FakeSession`。
- **`ctx.sessionTitle` 的 stub**：**当前不存在**。`tests/mocks/` 目录只有 `agents/llm/sessions/shell/storage-domain/subagents/subprocess/user-questions` 八个 mock，无 session-title mock；`packages/sandore` 全部 src/tests grep `sessionTitle|SessionTitle|session-title|rename(` 无命中；`harness()` 也未 `ctx.provide('sessionTitle', …)`。
- **断言模式**（startInstance 相关，spec 第 524–568 行等）：
  - `expect(agents.createCwds).toEqual(['/srv/app'])`（断言 `meta.cwd` 透传）
  - `expect(agents.setupCount).toBe(1)`（断言 setup 执行次数）
  - `const hostAgent = agents.get(run.instanceId); expect(hostAgent).toBeDefined(); expect(hostAgent?.status).toBe('idle'); expect(hostAgent?.inbox.hasPending).toBe(false)`（断言宿主代理已注册且 idle、无自动 prompt）
  - `agents.setupError = new Error('setup boom')` 后 `await expect(engine.startInstance(...)).rejects.toThrow('setup boom'); expect(persistence.state.size).toBe(0)`（setup 抛错回滚、state 表为空）
  - 事件双发断言：`const session = sessions.get(run.instanceId); expect(session?.events.map(e => e.type)).toEqual([...])`（宿主 Session 事件序）
  - seam inject 断言（spec 第 496–501 行）：`expect(SandoreEngineStub.inject).toContain('agents')`、`expect(SandoreEngineStub.inject).toContain('userQuestions')`、`expect(SandoreEngineRuntime.inject).toContain('agents')`、`expect(SandoreEngineRuntime.inject).toContain('userQuestions')`。

### 5. `workflow/package.json` 是否已有 `@deepseek-ai/dsh-session-title`

文件：`packages/sandore/workflow/package.json`。

- **`peerDependencies`（第 46–58 行）没有 `@deepseek-ai/dsh-session-title`**。现有：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-sandore-microflow`、`@deepseek-ai/dsh-session`（0.1.0-rc.6）、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/schemastery`。
- **`devDependencies`（第 59–71 行）同样没有 `@deepseek-ai/dsh-session-title`**（与 peerDependencies 同清单）。
- `dependencies` 只有 `yaml`、`zod`。

补充事实（相关，非本 package.json）：仓库根 `pnpm-lock.yaml` 已解析并记录 `@deepseek-ai/dsh-session-title@0.1.0-rc.6`（第 501 行起，peerDependencies 为 `cordis/dsh-brand/dsh-invariants/dsh-llm/dsh-session/dsh-session-projection`），但它是作为 `@deepseek-ai/dsh-session-query@0.1.0-rc.6` 的 peerDependency 被带入锁文件的（第 487–496 行），**不是任何 sandore workspace 包（`packages/**/package.json`）的直接依赖**（grep `packages/**/package.json` 无 `dsh-session-title` 命中）。因此该包虽已在根 `node_modules/.pnpm` 中安装，但 `workflow` 包若要用它，需自行补充声明。

### 关键事实缺口（与 design/plan 的差异，仅陈述现状）

- `docs/engine/dsh-workflow.md`（第 381 行）、`docs/design/task-5-frontend/design.md`（第 237 行）、`furina/changes/task-5-frontend/{design.md 第 50 行, proposal.md 第 11 行, plan.json 第 72 行, specs/host-session-title/spec.md 第 6 行}` 均写成 `ctx.sessionTitle.rename(handle.session, ...)`，但 `handle`（`AgentHandle`）实际**没有 `session` 字段**；宿主 Session 在当前代码中是通过 `ctx.sessions.get(SessionId(instanceId))` 读回的（或等价地 `handle.agent.session`）。这是当前代码与设计/plan 文案之间的既存不一致，探索仅如实记录。
- 当前引擎（`workflow-engine.ts`/`seam.ts`）**未调用** `sessionTitle`；`static inject` 两处均无 `'sessionTitle'`；测试无 `sessionTitle` stub。

## Supplementary Exploration Result

无需补充联网探索。本次目标的全部事实（DSH `session-title` API、sandore `startInstance`/inject/测试/package.json）均已在本机代码与 `node_modules` 源码中完整取证（版本 0.1.0-rc.6），本地源码比联网资料更权威，故未发起 websearch/context7 查询。
