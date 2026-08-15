# Task 5：前端 + 固化 — WorkflowList + DagEditor + RunView + 挂载固化

在 Task 1–4 的 Host 能力之上，实现完整的前端 UI（WorkflowList/DagEditor/RunView/讨论面板）+ 把插件固化到 `cordis.yml` 静态组合。

## 必读（按优先级）
1. `docs/design/task-5-frontend/design.md` —— Task 5 权威规格（UI 结构、技术栈、列表/编排/执行/讨论面板、数据流与 RPC、挂载固化）
2. `docs/engine/dsh-workflow.md` —— 插件化核心设计（§6 Client 端设计、§7 数据流与 RPC、§8 挂载集成）
3. `docs/design/overall-design.md` —— 总体设计（D6/D7/D8/D9）
4. DSH 源码 `D:\project-code\llm\deepseek-harness` 参考：`packages/client/ui-workspace`（WorkspaceBrowser 风格）、`packages/client/ui-primitives`、`packages/client/ui-workflow-run`（Chat 节点）、`packages/extensions/ui-cordis`（footer 按钮 + 展开面板）

## 硬约束（不可违反）
- **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**
- **UI 能复用 DSH 就复用**（`ui-primitives`/theme token/locale/标准 hook），不能复用就照着 DSH 风格自绘（AGENTS.md）

## 产出（`ui` 包 + 挂载固化）
1. `packages/sandore/ui/`（Client 插件，声明 `dsh.client` + `exports["./client"]`）：
   - `WorkflowButton.tsx` —— `sidebar.footer.action` 按钮（设置上方入口）
   - `WorkflowPanel.tsx` —— 展开面板（仿 workspace 风格：header 搜索/编排/新增 + 三态列表）
   - `InstanceList.tsx` / `DefinitionList.tsx` —— 默认态实例列表（按工作区分组）/ 编排态定义列表
   - `DagEditor.tsx` —— 编排器（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存）
   - `RunView.tsx` —— 执行详情（轨迹/产物/交互控件 + 「打开讨论」按钮）
   - `DagStepNodeView.tsx` —— `sandore-step` 讨论节点（`conversation.chat.node` keyed，D8）
2. 挂载固化：`cordis.yml` 静态组合 4 包（`workflow` + `microflow` + `tool` + `ui`），移除动态插件原型

## 关键决策
- **D6**：入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，自包含 client 状态）；**不用** `conversation.view` tab 作为主入口
- **D7**：前端复用 DSH 组件与设计语言（`ui-primitives`/theme/locale/消息渲染/交互卡片），与 DSH web 风格一致
- **D8**：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制——每个 Step 折叠为一个 `sandore-step` 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联最后结果消息，点击跳转子对话页
- **D9**：宿主主代理在 `completed` 后自然降级为自由对话（无 DefaultSessionManager）；`sandore_*` 工具仅挂宿主 Session
- **数据获取**：`host.call('sandore.*')` RPC（点号）+ DSH 事件订阅（`sandore/*` Session 事件 / `session/projection` 帧）；不用独立 axios/fetch
- **DAG 可视化**：先 `ui-primitives` 简化实现（节点列表 + 连线示意），React Flow 作为后续增强

## 验证标准（Task 5 完成门槛）
- 完整 UI 可用：列表 → 编排 → 执行 → 讨论 → 交互 全链路
- WorkflowList（定义/Job/实例 CRUD）、DagEditor（YAML 预览 + 保存）、RunView（轨迹/产物/交互控件）正常
- 讨论面板 `sandore-step` 节点正确渲染（复用 `ui-workflow-run`）
- 插件随 `cordis.yml` 静态组合稳定加载，启动即生效
- UI 视觉与交互融入 DSH web（复用 ui-primitives/theme/locale）

先读 `task-5-frontend/design.md` 全文，再开始实现。
