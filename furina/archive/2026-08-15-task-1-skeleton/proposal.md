# Proposal: task-1-skeleton — 工作流引擎 DSH 插件骨架

## Why

sandore DAG 工作流引擎（v2.6）需要作为 DeepSeek Harness (DSH) 的纯插件落地（分发给其他 DSH web 用户），但当前仓库是 greenfield（仅设计文档，无任何代码）。Task 1 是落地第一步：建立可编译、可挂载、可端到端验证的最小骨架，为后续引擎执行逻辑（Task 2–5）提供 Service seam、事件词汇与 UI 入口。

## What Changes

- **新增根 monorepo 工作区**（前置条件）：根 `package.json`（`private: true`、`packageManager: pnpm@11.7.0`、`engines: node >=22`、scripts `typecheck`/`build`）+ `pnpm-workspace.yaml`（`packages: ['packages/sandore/*']`）+ `tsconfig.base.json`
- **新增 `packages/sandore/workflow/`**（`@deepseek-ai/dsh-sandore-workflow`）：Service seam + Provider 桩 + RPC 三者合一
  - 抽象类 `SandoreEngine extends Service`（service key `sandoreEngine`），11 个实例级抽象方法
  - 13 个 `sandore/*` 事件双声明：Cordis `Events`（`info: DagRunInfo` 首参）+ Session `SessionEventMap`（纯数据载荷，必需）
  - 13 个基础类型定义（`DagRunInfo`/`DagStartRequest`/…/`DagResultInfo`），`step-completed.output: ContentBlock[]`（来自 `@deepseek-ai/dsh-llm`）
  - 空 Provider 桩（schemastery `static Config` + `static inject`）
  - 最小 RPC：`TypertRemoteService + @Remote`（`super(ctx, 'sandore')` + `@Remote('ping')` → `sandore.ping`）
- **新增 `packages/sandore/microflow/`**（`@deepseek-ai/dsh-sandore-microflow`）：空占位（package.json + tsconfig.json），后续 Task 填充 StageExecutor/StepRunner
- **新增 `packages/sandore/tool/`**（`@deepseek-ai/dsh-sandore-tool`）：空占位（package.json + tsconfig.json），后续 Task 填充 `sandore_*` 模型工具
- **新增 `packages/sandore/ui/`**（`@deepseek-ai/dsh-client-ui-sandore`）：Client 插件，注册 `sidebar.footer.action` 工作流按钮（设置上方）+ 点击展开 WorkflowPanel 占位；`host.call('sandore.ping')` 往返验证

不修改任何 DSH 源码；零外部 Agent SDK（引擎/后端全用 DSH 的 `ctx.*` 服务）。

## Capabilities

### New Capabilities

- `monorepo-workspace`: 根 monorepo 工作区配置（根 package.json、pnpm-workspace.yaml、tsconfig.base.json），支撑 `pnpm run typecheck`/`pnpm run build` 对 4 个 sandore 包生效
- `engine-seam`: `ctx.sandoreEngine` Service seam——抽象类（11 个实例级方法）+ `sandore/*` 13 事件双声明（Cordis `Events` + Session `SessionEventMap`）+ 13 个基础类型 + 空 Provider 桩（Config/inject 声明）
- `engine-rpc`: Host RPC 最小链路——`TypertRemoteService + @Remote('ping')` 暴露 `sandore.ping`，返回桩数据，供 Client `host.call('sandore.ping')` 往返验证
- `ui-entry`: 工作流管理 UI 入口——`sidebar.footer.action` 按钮注册（设置上方）+ 点击展开 WorkflowPanel 占位（含「编排」toggle +「新增」按钮 + 三态列表占位）

### Modified Capabilities

（无——仓库 greenfield，无既有能力）

## Impact

- **代码**：仓库从零新增 `<repo-root>/package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`packages/sandore/{workflow,microflow,tool,ui}/`
- **依赖**：各包以 peerDependencies 声明 `@deepseek-ai/*`（npm public scope，`0.1.0-rc.5`：`cordis`、`dsh-session`、`dsh-llm`、`dsh-typert-protocol`、`dsh-agent`、`dsh-storage`）；开发依赖 `typescript`/`tsdown`/`tsx` 从 npm 解析，不用 `file:`/`link:` 指向本地 DSH 源码
- **外部系统**：无（纯插件，不改 DSH 源码，不发布 npm）
- **验证门槛**：`pnpm run typecheck` 通过；挂载后 sidebar 设置上方出现「工作流」按钮；`host.call('sandore.ping')` 往返 JSON 正常
