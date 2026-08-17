# Spec: sandore-step-node

## ADDED Requirements

### Requirement: ConversationNodeDefinition 折叠 step 事件
`ui` Client 插件 SHALL 注册 `ConversationNodeDefinition`（`kind: 'sandore-step'`，`target: 'chat'`）：`match` 命中 `sandore/step-start|step-completed|step-failed|step-paused|step-resumed|step-retried` Session 事件；`start`/`update` 将同一 Step 的多事件折叠为一个节点状态（`{stepId, childId, name, status, loopIteration?, output?, error?}`）；同一 `stepId` 在循环中多次迭代 SHALL 生成独立节点（节点 id 由 `stepId` + `loopIteration` 路径派生）。

#### Scenario: 事件折叠为节点
- **WHEN** 宿主 Session 事件日志含某 Step 的 `step-start` → `step-completed` 序列
- **THEN** 该 Step 折叠为单个 `sandore-step` 节点，状态为 completed，内联 output

#### Scenario: 循环迭代独立节点
- **WHEN** 循环 Step 两次迭代各触发 step-start/step-completed
- **THEN** 产生两个独立 `sandore-step` 节点（可按 `#1`/`#2` 迭代标签区分）

### Requirement: keyed 渲染器注册与数据类型声明
`ui` SHALL 以三件套注册渲染器（照抄 `ui-workflow-run` 范式）：
1. `ctx.conversationEvents.register(sandoreStepDefinition)`（`inject` 含 `'conversationEvents'`）
2. `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key: 'sandore-step', locale: NS, inject: () => ({ openSession: (id) => ctx.sessions.open(id) }) }, DagStepNodeView))`
3. `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'sandore-step': DagStepChatData } }`

#### Scenario: 注册完成
- **WHEN** `ui` Client 插件 apply 完成
- **THEN** 宿主 Session chat 视图内 `sandore-step` 类节点由 `DagStepNodeView` 渲染（keyed 分派生效）

### Requirement: 节点渲染规则
`DagStepNodeView` SHALL 按状态渲染（ui-primitives 自绘，DSH 风格）：
- running：状态徽章 + 名称，无结果消息
- completed：内联该 Step 最后 assistant 结果（`step-completed` payload 的 `output: ContentBlock[]`，经 `MessageText`/`MarkdownText` 薄胶水渲染）
- failed：错误样式（红框语义）+ error 详情
- paused：暂停样式（琥珀语义）+ 会话快照提示
- 节点显示 `name`（来自补齐后的事件 payload）与循环迭代标签（`#1.2` 形态，来自 `loopIteration`）

#### Scenario: 完成态内联结果
- **WHEN** 节点状态为 completed 且 payload 含 output
- **THEN** 节点内联渲染该结果消息（Markdown 形态）

#### Scenario: 失败态错误展示
- **WHEN** 节点状态为 failed
- **THEN** 节点呈现错误样式与 error 文本

### Requirement: 点击跳转子会话
点击 `sandore-step` 节点 SHALL 调用 `openSession(childId)`（注入的 `ctx.sessions.open`），跳转到该 Step 子代理 Session 的完整对话页（DSH 原生 UI，composer 自动提供暂停/继续/fork 生命周期控件）。

#### Scenario: 跳转子会话
- **WHEN** 用户点击某个 completed 的 Step 节点
- **THEN** DSH 打开该 Step 的子会话页（childId）

### Requirement: 节点级重试控件
failed 或 completed 的 `sandore-step` 节点 SHALL 提供「重试」控件（选择 continue/revert/fork 模式 + message，`message` 为必填字符串、无附言传空串，与 `retryStep` RPC 的 zod schema `message: z.string()` 一致），提交经 `ctx.remote.sandore.retryStep({instanceId, stepId, mode, message})`；instanceId 由节点所在宿主 Session id（== instanceId）提供。

#### Scenario: 节点重试
- **WHEN** 用户在某 failed Step 节点选择 continue 模式重试
- **THEN** 调用 `retryStep` 成功后后续 `step-start` 事件折叠出新节点状态
