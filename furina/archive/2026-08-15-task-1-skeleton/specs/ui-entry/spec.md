# Spec: ui-entry — sidebar 工作流入口

## ADDED Requirements

### Requirement: sidebar.footer.action 按钮注册
`packages/sandore/ui`（`@deepseek-ai/dsh-client-ui-sandore`）的 Client 插件 SHALL 通过 `ctx.slots.inject('sidebar.footer.action', ...)` 注册 id 为 `sandore-btn` 的工作流按钮，位于设置上方，不修改 DSH ui-sidebar 源码。

#### Scenario: 按钮显示
- **WHEN** ui 包挂载到 DSH web 组合
- **THEN** sidebar 的 footer action 区（设置上方）出现「工作流」按钮

#### Scenario: 适配宽窄两种 rail 模式
- **WHEN** sidebar 处于 `wide=false`（56px 窄栏 rail）或宽栏模式
- **THEN** 按钮均正常渲染（owner props `wide` 适配）

### Requirement: 点击展开 WorkflowPanel
点击工作流按钮 SHALL 切换 WorkflowPanel 的展开/收起状态，面板开关为插件自有 client 状态（自包含，无跨 scope 联动）。

#### Scenario: 面板展开与收起
- **WHEN** 用户点击「工作流」按钮
- **THEN** WorkflowPanel 展开显示占位内容（header 含「编排」toggle +「新增」按钮 + 三态列表占位）；再次点击收起

### Requirement: Client 包声明
`packages/sandore/ui/package.json` SHALL 声明 `"type": "module"`、`exports["./client"]`（指向 client 构建产物）、`dsh.client`（`platform: "web"` + inject 清单），并含 Host 半空入口 `src/index.ts`。

#### Scenario: package.json 声明
- **WHEN** 检查 `packages/sandore/ui/package.json`
- **THEN** 含 `exports` 的 `./client` 子路径、`dsh` 字段的 `client.platform: "web"` 与 inject 数组，且 `src/index.ts` 存在（Host 半空 apply）

### Requirement: host.call RPC 往返
WorkflowPanel（或按钮点击链路）SHALL 能发起 `host.call('sandore.ping')` 并展示/日志返回的 JSON，验证端到端链路。

#### Scenario: ping 往返
- **WHEN** WorkflowPanel 内触发 ping 调用（如点击验证按钮或挂载时）
- **THEN** `host.call('sandore.ping')` 返回 JSON 桩数据且无错误

### Requirement: UI 复用 DSH 风格
WorkflowPanel SHALL 优先复用 DSH `ui-primitives`/theme/locale/标准 hook；不能复用之处照 DSH 风格自绘（仿 workspace 面板风格），MUST NOT import DSH 内部私有组件。

#### Scenario: 样式风格
- **WHEN** 检查 WorkflowPanel 实现
- **THEN** 使用 DSH 公开扩展点（ui-primitives/theme/locale/hook）或 DSH 风格自绘，无 DSH 私有模块 import
