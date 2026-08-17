# Spec: workflow-panel

## ADDED Requirements

### Requirement: footer 入口按钮展开 WorkflowPanel
`WorkflowButton`（`sidebar.footer.action`，`id: 'sandore-btn'`）点击 SHALL 展开/收起 `WorkflowPanel`；按钮渲染于 DSH 侧边栏设置按钮上方；`wide`（展开侧栏）与 rail（窄条）两态均 SHALL 可用（rail 态可显示图标按钮，面板以宽展开 layer 形态弹出）。

#### Scenario: 点击展开
- **WHEN** 用户点击「工作流」footer 按钮
- **THEN** WorkflowPanel 展开（首次进入默认态列表）

#### Scenario: rail 窄态可用
- **WHEN** 侧边栏处于窄 rail 形态
- **THEN** footer 按钮仍可见可点，面板以宽展开 layer 弹出（不受 rail 宽度约束）

### Requirement: header 提供搜索/编排/新增
WorkflowPanel header SHALL 提供搜索输入（客户端过滤当前列表）、「编排」toggle（默认态↔编排态）、「新增」按钮（默认态→新增实例入口、编排态→新增定义）。

#### Scenario: 切换编排态
- **WHEN** 用户点击「编排」toggle
- **THEN** 列表切换为定义列表（DefinitionList），「新增」语义变为新增定义

#### Scenario: 搜索过滤
- **WHEN** 用户在搜索框输入关键词
- **THEN** 当前列表（实例或定义）按名称/ID 客户端过滤

### Requirement: 两级下钻承载
WorkflowPanel SHALL 内部维护 view 状态栈：`list`（列表态）↔ `editor`（DagEditor，点定义进入）↔ `run`（RunView，点实例进入）；下钻态以宽展开 layer 渲染，返回按钮回退上一级；全程零新增 slot 注册（自包含 client 状态）。

#### Scenario: 下钻到编辑器
- **WHEN** 编排态下用户点击某工作流定义
- **THEN** 面板下钻为 DagEditor 宽展开态，显示该定义的编排内容

#### Scenario: 下钻到执行详情
- **WHEN** 默认态下用户点击某实例
- **THEN** 面板下钻为 RunView 宽展开态，显示该实例执行详情

#### Scenario: 返回列表
- **WHEN** 用户在下钻态点击返回按钮
- **THEN** 面板回退到列表态（保留列表态的编排 toggle/搜索状态）

### Requirement: 默认态实例列表按工作区分组
`InstanceList`（默认态）SHALL 经 `ctx.remote.sandore.listInstances()` 拉取实例，按工作区分组渲染：`useWorkspaces` 取 `WorkspaceView[].sessionIds` 成员表，`instanceId` 命中即归入对应 workspace 分组；不属于任何 workspace 的实例归「未分组」；每项显示实例状态（StateDot）、ID、Job/更新时间；面板打开期间 3s 轮询刷新。

#### Scenario: 分组渲染
- **WHEN** 实例 A 的 instanceId 存在于 workspace W1 的 sessionIds、实例 B 不属于任何 workspace
- **THEN** 列表在 W1 分组下显示 A，「未分组」下显示 B

#### Scenario: 轮询刷新
- **WHEN** 面板打开且处于默认态
- **THEN** 每 3s 调用 `listInstances` 刷新列表（收起面板/组件卸载即停止）

### Requirement: 编排态定义列表
`DefinitionList`（编排态）SHALL 经 `ctx.remote.sandore.listDefinitions()` 拉取定义并平铺渲染（名称/版本/描述/更新时间）；提供删除（确认后 `deleteDefinition`）；点击定义进入 DagEditor。

#### Scenario: 列出定义
- **WHEN** 用户切换到编排态
- **THEN** 列表显示全部工作流定义（名称、版本、描述、更新时间）

#### Scenario: 删除定义
- **WHEN** 用户对某定义执行删除并确认
- **THEN** 调用 `deleteDefinition(id)` 成功后列表移除该项；失败时呈现错误提示

### Requirement: 三态列表展示
列表 SHALL 呈现三态：loading（加载中指示）、empty（空态引导文案 + 「新增」入口）、error（RPC 失败错误提示 + 重试）。

#### Scenario: 空态
- **WHEN** `listInstances` 返回空数组
- **THEN** 列表显示空态文案与新增引导

#### Scenario: 错误态
- **WHEN** `listDefinitions` 返回 `{ok:false}`
- **THEN** 列表显示错误提示与重试按钮，不渲染伪造数据
