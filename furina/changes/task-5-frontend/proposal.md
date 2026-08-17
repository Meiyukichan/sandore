# Proposal: task-5-frontend

## Why

Task 1–4 已交付 sandore 的全部 Host 侧能力（引擎、RPC、事件、工具），但 `ui` 包仍停留在 Task 1 的 ping 占位（本地 JSON 桩 + 三态占位列表），用户在 DSH Web 上无法浏览/编排/执行工作流，也无法在宿主会话里看到 Step 讨论节点。Task 5 是收尾任务：补全完整前端 UI 并把 4 个插件包固化为 `cordis.yml` 静态组合，使「列表 → 编排 → 执行 → 讨论 → 交互」全链路在 DSH Web 可用。

## What Changes

- **RPC 接线（决策：Typert 官方范式）**：`workflow` 包新增 `./remote` 导出（typert 生成 `lib/typert.remote-client.js`，需 tsdown 构建配置）；`ui` Client 插件 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)` 后以 `ctx.remote.sandore.*` 调用 27 个 RPC。移除 Task 1 的本地 `host.call` JSON 桩（动态插件原型）。
- **事件 payload 补齐**：6 个 `sandore/step-*` Session 事件（start/completed/failed/paused/resumed/retried）payload 补 `name: string`（必填）+ `loopIteration?: number[]`（可选），使 `sandore-step` 讨论节点折叠态自包含（设计 §5.3.1），前端零 RPC 补偿。`SessionEventMap` 与 Cordis `Events` 双声明同步更新。
- **宿主会话标题补设**：`workflow` 包 host 侧最小增量——`inject` 补 `sessionTitle`，创建宿主 Session 后 `ctx.sessionTitle.rename(handle.session, '工作流实例 ${instanceId}')`（`source=user` 优先于 DSH 默认 fallback 自动标题，侧边栏可辨识）。
- **`ui` 包完整前端**（7 个组件，D6/D7/D8 决策落地）：
  - `WorkflowButton.tsx`（已有，微调）——`sidebar.footer.action` 入口按钮
  - `WorkflowPanel.tsx`（重写）——仿 workspace 风格展开面板：header 搜索/编排 toggle/新增 + **两级下钻**（列表态窄 rail ↔ 编辑/执行态宽展开 layer，照 `ui-cordis` 的 `wide ? css.layer : css.rail`）
  - `InstanceList.tsx` / `DefinitionList.tsx`（新增）——默认态实例列表（按工作区分组，`workspace.sessionIds` 成员表）/ 编排态定义列表
  - `DagEditor.tsx`（新增）——Stage DAG 简化可视化（ui-primitives 节点列表 + 连线示意，无 React Flow）+ Step 编辑 + YAML 预览/保存（`updateYaml`）
  - `RunView.tsx`（新增）——执行轨迹（executedSteps/stageInfos 只读）/ 产物面板（`getArtifacts` 运行中 5s 轮询）/ 交互控件（暂停/恢复/重试/问答/权限）+「打开讨论」按钮（`ctx.sessions.open(instanceId)`）
  - `DagStepNodeView.tsx`（新增）——`conversation.chat.node` keyed `sandore-step` 讨论节点（照抄 `ui-workflow-run` 三件套：`ConversationNodeDefinition` + `conversationEvents.register` + `ChatNodeDataMap` 声明合并），内联最后结果消息（`step-completed` payload 的 `output`），点击跳转子会话
- **挂载固化**：仓库新建 `cordis.yml`（`- insert:` 块静态组合 `workflow` + `microflow` + `tool` + `ui` 4 包，格式照 DSH `examples/web-cordis/cordis.yml`），移除动态插件原型路径。
- **`ui` 包声明补全**：`inject` 数组补 `sessions`/`conversationEvents`（+ D8 所需），`package.json` 的 `dsh.client.inject` 补 `dsh-client-ui-conversation` 等，peerDeps 同步。

## Capabilities

### New Capabilities

- `rpc-wiring`: Typert RPC 客户端接线——workflow 包 `./remote` 导出与 typert 构建产物、ui 侧 `$mount` + `ctx.remote.sandore.*` 调用、动态桩移除
- `event-payload-enrichment`: `sandore/step-*` 事件 payload 补 `name`/`loopIteration`（引擎侧写入 + 双声明同步），供讨论节点折叠态自包含
- `host-session-title`: 宿主会话标题补设（`sessionTitle.rename`，workflow 包 inject 增量）
- `workflow-panel`: WorkflowPanel 展开面板 + 两级下钻承载（header 搜索/编排/新增 + InstanceList/DefinitionList 三态列表 + 按工作区分组）
- `dag-editor`: DagEditor 编排器（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存）
- `run-view`: RunView 执行详情（轨迹/产物/交互控件/打开讨论）
- `sandore-step-node`: `sandore-step` 讨论节点（`conversation.chat.node` keyed 三件套 + 内联结果 + 子会话跳转）
- `static-composition`: `cordis.yml` 静态组合固化（4 包 insert + ui 包声明补全）

### Modified Capabilities

（无——Task 1–4 已交付能力的 spec 级行为不变；本变更全部为新增能力）

## Impact

- **代码**：`packages/sandore/ui/src/**`（重写/新增 7 组件 + locales 扩充）、`packages/sandore/workflow/src/{workflow-engine,seam,remote}.ts`（事件 payload + sessionTitle 最小增量 + `./remote` 导出）、`packages/sandore/{workflow,ui}/package.json`（exports/tsdown/dsh.client.inject/peerDeps）、仓库根 `cordis.yml`（新建）
- **API**：`sandore/step-*` Session 事件 payload 增字段（向后兼容的加法）；无 RPC 方法变更
- **依赖**：`ui` 包新增 peer `@deepseek-ai/dsh-client-ui-conversation`、`dsh-client-runtime`（sessions/conversationEvents）；`workflow` 构建引入 tsdown + typert generator（devDependency）
- **硬约束**：纯插件不改任何 DSH 源码；零外部 Agent SDK；UI 能复用 DSH 就复用（ui-primitives/theme/locale/标准 hook），不能复用就照 DSH 风格自绘；DAG 可视化不引入 React Flow
