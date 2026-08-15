# Design: task-1-skeleton — 工作流引擎 DSH 插件骨架

> 本设计是 `docs/design/task-1-skeleton/design.md`（Task 1 权威规格）与 `work.md`（任务清单）的实现级转写。规格冲突已在 brainstorm 阶段裁决并回写至源文档：`output: ContentBlock[]`、根 monorepo 前置、npm peerDependencies、`TypertRemoteService + @Remote`。
> `docs/design/task-1-skeleton/design.md`和`docs\design\task-1-skeleton\work.md` 这个当前阶段总体任务，写代码前都需要参考。

## Context

- sandore 仓库是 greenfield：仅 `docs/`、`AGENTS.md`、`furina/`，无任何 package.json / tsconfig / 源码。`packages/` 目录存在但为空。
- sandore 要作为 **DSH 纯插件**分发（硬约束：不改任何 DSH 源码；零外部 Agent SDK，全用 DSH `ctx.*` 服务）。
- DSH 基于 vendored **Cordis** DI 框架；`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 是 npm public scope（`0.1.0-rc.5`），DSH 本地源码未 build，仅作参考阅读。
- 权威范式（探索已实证，DSH 源码路径）：
  - Service Definition：`packages/workflow/workflow/src/index.ts`（`extends Service` + `super(ctx, key)` + `declare module '@deepseek-ai/cordis'` 合并 `Context`/`Events` + `emitWorkflowEvent` 安全发射）
  - Session 事件：`packages/workflow/tool-workflow/src/`（`ctx.on(...)` 触发源 + `session.append('ns/event', data)` 落盘 + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`）
  - footer 按钮 + 展开面板：`packages/extensions/ui-cordis/src/client/index.ts`（`ctx.slots.inject('sidebar.footer.action', ...)`）
  - RPC：`packages/feedback/message-feedback/src/index.ts`（`extends TypertRemoteService` + `super(ctx, 'namespace')` + `@Remote('method')`）
  - Client 包声明：ui-cordis package.json（`"type":"module"` + `exports["./client"]` + `dsh: { client: { platform: 'web', inject } }`）

## Goals / Non-Goals

**Goals:**

- 根 monorepo 工作区可编译：`pnpm install` → `pnpm run typecheck` 通过
- `packages/sandore/` 4 个包目录/package.json 声明正确（ESM、peerDependencies、ui 包 dsh.client）
- `ctx.sandoreEngine` 抽象类（11 个实例级方法）+ `sandore/*` 13 事件双声明（Cordis `Events` + Session `SessionEventMap`）类型正确
- 最小端到端链路：`sidebar.footer.action` 工作流按钮 → WorkflowPanel 占位 → `host.call('sandore.ping')` JSON 往返

**Non-Goals:**

- 真实引擎执行逻辑（Stage/Step/DAG 调度、microflow StageExecutor/StepRunner——Task 2/3）
- `sandore_*` 模型工具（Task 4）、完整前端（DagEditor/RunView/讨论面板——Task 5）
- 持久化三表（`definitions`/`jobs`/`state`）、权限实现、`SandoreError` 错误体系
- npm 发布、动态插件（`cordis_define`/`cordis_run`）原型脚本
- `conversation.chat.node` 讨论节点注册（Task 5；本 Task 仅实现 sidebar 入口）

## Decisions

### D-A：根 monorepo 配置形态

- 根 `package.json`：`{ name: "sandore", private: true, packageManager: "pnpm@11.7.0", engines: { node: ">=22" }, type: "module", scripts: { typecheck, build }, devDependencies: { typescript, tsdown, tsx } }`
- `pnpm-workspace.yaml`：`packages: ['packages/sandore/*']`
- `tsconfig.base.json`：strict、`moduleResolution: bundler`、`declaration: true`、`jsx: react-jsx`（ui 包需要）等，各包 tsconfig `extends` 之
- 备选「每包独立 npm 项目（无 workspace）」被否决：无法支撑根级 `pnpm run typecheck` 验证标准，且后续 Task 包间依赖（`tool`/`ui` → `workflow`）需要 workspace 协议解析。

### D-B：包依赖与版本策略

- 所有 `@deepseek-ai/*` 依赖以 **peerDependencies `0.1.0-rc.5`** 声明（npm 解析），devDependencies 同名安装以供 typecheck；不用 `file:`/`link:` 指向本地 DSH。
- `workflow` 包 peerDeps：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`（`ContentBlock`，type-only import）、`@deepseek-ai/dsh-typert-protocol`（`TypertRemoteService`/`Remote`）、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`（后两者为后续 Task 预留声明）。
- `ui` 包 peerDeps：`@deepseek-ai/cordis` + 相关 client 包（`dsh-client-*`）；ui 包的 client 半以 `@deepseek-ai/dsh-client-ui-sidebar/client` type-only import 引 slot 类型。
- 备选「本地 link」被否决：DSH 源码未 build（无 lib 产物），link 无类型可解析。

### D-C：seam 文件布局（workflow 包）

- `src/types.ts`：13 个基础类型（`DagRunInfo`/`DagStartRequest`/`DagRun`/`DagRunStatus`/`DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StepStatus`/`标准`/`PendingQuestion`/`AskUserQuestionPayload`/`PendingPermission`/`DagResultInfo`）。`ExecutedStepDefault` 引用的深层依赖类型（`CommandConfig`/`InputFromItem`/`OutputToItem`/`PassThroughVar`/`StepSessionMeta`/`FinalizeMeta`/`BranchMeta`/`SessionMessage`/`RetryRecord`）以最小占位声明（`unknown` 或局部最小结构），Task 2/3 再收紧——避免 Task 1 膨胀。
- `src/index.ts`：`declare module` 两套事件合并 + `export abstract class SandoreEngine extends Service`（11 抽象方法）+ 空 Provider 桩（default export，schemastery `static Config`、`static inject`）。
- `src/remote.ts`：`class SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，`@Remote('ping')` 返回 `{ pong: true, service: 'sandore', time: string }` 桩数据。
- 备选「remote 并入 index.ts」被否决：RPC 层职责分离，后续 Task 2 的定义/Job CRUD RPC 会显著扩容 remote.ts。

### D-D：事件双声明结构

- Cordis `Events`：13 个事件，首参 `info: DagRunInfo`，可选触发源用。
- Session `SessionEventMap`：13 个同名事件，纯数据载荷（见权威规格 §5.1 第二段），**必需**（驱动 D8 讨论面板折叠 + apiproxy 透传）。
- `step-completed` 的 `output` 用 `ContentBlock[]`（`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`），对齐 DSH 权威先例 `dsh-workflow`。
- 两套声明写进同一个 `src/index.ts` 的两个 `declare module` 块，`tool-workflow` 先例即此布局。

### D-E：Provider 桩形态

- `export default class SandoreEngineStub extends SandoreEngine`（或与 seam 同文件）。11 个抽象方法抛 `UnsupportedOperationError`（或最小桩返回值），**不做真实逻辑**。
- `static Config = Schema.object({ defaultTimeoutMs: Schema.natural().default(7200000), maxConcurrentSteps: Schema.natural().default(0) })`——**无 `permissionMode`**（权限由宿主 Session permission preset 决定）。
- `static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`（可选 `ctx.subprocess`/`ctx.sandbox` 后续用 `ctx.get()` 软依赖）。
- schemastery 从 `@deepseek-ai/cordis` 导入（DSH 生态约定）。

### D-F：ui 包最小实现

- package.json：`"type": "module"`、`exports: { "./client": "./lib/client/index.js" }`、`dsh: { client: { platform: "web", inject: [...] } }`、peerDependencies。
- `src/index.ts`（Host 半，空 apply）：Client 插件包需 Host 半存在但 Task 1 无 Host 逻辑。
- `src/client/index.ts`：`export const inject = [...]` + `apply(ctx)` 里 `ctx.slots.inject('sidebar.footer.action', ...)` 注册按钮。
- `src/client/WorkflowButton.tsx`：按钮组件（适配 `wide` 宽/窄 rail 两种模式），点击切换面板开关（插件自有 client 状态，模块级状态或 React state 桥接——参考 ui-cordis 的 footer 按钮 + 展开 CordisPanel）。
- `src/client/WorkflowPanel.tsx`：占位面板（header 含「编排」toggle +「新增」按钮 + 三态列表占位），ui-primitives 自绘、仿 workspace 风格。

### D-G：tsconfig 与 typecheck

- `tsconfig.base.json`：`strict: true`、`module: ESNext`、`moduleResolution: bundler`、`declaration: true`、`declarationMap`、`skipLibCheck: true`、`jsx: react-jsx`、`noEmit` 由各包 tsconfig 控制。
- 根 typecheck 脚本：`pnpm -r run typecheck`（各包 `tsc --noEmit`），tsdown build 另置。
- `skipLibCheck: true` 是必要的：peer 依赖的 `@deepseek-ai/*` d.ts 可能依赖未安装的传递类型。

### D-H：验证方式

- `pnpm install && pnpm run typecheck`（CI 门槛）
- 挂载验证（人工/后续集成）：将 4 包加入 DSH web 组合的 `cordis.yml`，确认 sidebar 设置上方出现「工作流」按钮、点击展开面板、`host.call('sandore.ping')` 返回 JSON。Task 1 交付静态组合说明（见 ui/workflow 包 README 或注释），动态插件脚本不在产出内。

## Risks / Trade-offs

- [npm `0.1.0-rc.5` 包与本地 DSH 源码漂移] → 锁定精确版本 `0.1.0-rc.5`；DSH 源码仅作参考阅读；升级时整体 bump 并回归 typecheck。
- [peerDependencies + devDependencies 双声明导致版本漂移] → devDeps 与 peerDeps 版本严格一致；不使用 `workspace:*` 引 DSH 包。
- [`ExecutedStepDefault` 深层依赖类型用占位 `unknown`] → Task 1 仅需类型可编译；Task 2/3 实现引擎时收紧为真实结构，接口签名（11 方法/13 事件/13 类型名）不变。
- [ui 包 client slot API（`sidebar.footer.action` owner props `wide`）与 npm 包版本不匹配] → typecheck 会对 slot 注册签名把关；以 `@deepseek-ai/dsh-client-ui-sidebar/client` 的类型为准。
- [挂载验证依赖真实 DSH web 宿主，无法纯 CI 自动化] → Task 1 以 typecheck + 目录/声明检查为自动门槛，挂载验证留人工步骤并写入交付说明。
- [schemastery 从 cordis re-export 的 API 面] → 若 re-export 不含 `Schema`，则改从 `schemastery` 包直接声明 devDep；以 npm `0.1.0-rc.5` 的实际导出为准，实现时验证。

## Migration Plan

greenfield 新建，无迁移。回滚 = 删除新增文件/目录（git 未提交前可整体丢弃）。

## Open Questions

（无——4 个规格冲突点已在 brainstorm 裁决并回写源文档；其余细节以 `docs/design/task-1-skeleton/design.md` 为权威。）
