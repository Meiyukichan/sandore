# Design: task-5-frontend

> 权威需求来源：`docs/design/task-5-frontend/work.md` + `docs/design/task-5-frontend/design.md`（自包含权威规格，已含本次头脑风暴对齐的 4 项新决策）。本设计文档为实现层面的技术决策文档，与上述文档互补不冲突。

## Context

- Task 1–4 已交付 Host 侧全部能力：`SandoreRemote`（27 个 RPC，`super(ctx,'sandore')` + `@Remote`）、13 个 `sandore/*` Session 事件双声明且 `step-completed` 已内联 `output: ContentBlock[]`、宿主 Session id == instanceId、8 个 `sandore_*` 工具。
- `ui` 包现状 = Task 1 原型：`WorkflowButton.tsx` + 占位 `WorkflowPanel.tsx` + 本地 JSON 桩 `host.ts`（仅 `sandore.ping`）；`inject = ['slots','locale']`；5 个目标组件（InstanceList/DefinitionList/DagEditor/RunView/DagStepNodeView）全部缺失。
- DSH 参考范本（`D:\project-code\llm\deepseek-harness`，只读不改）：`ui-cordis`（footer 按钮 + 展开面板 `wide ? css.layer : css.rail`）、`ui-workflow-run`（Chat 节点三件套）、`ui-workspace`（WorkspaceBrowser 观感，header/分组私有不可 import）、`ui-primitives`（StateDot/DisclosureRow/Button/Input/Modal/MarkdownText/MessageText/icons）、`ui-trajectory`（conversation.view 先例——本设计不采用）、`packages/api/remotes/src/client/index.ts`（`$mount` 集中装配范本）、`examples/web-cordis/cordis.yml`（`- insert:` 格式）。
- 硬约束：纯插件零 DSH 源码修改；零外部 Agent SDK；UI 复用 DSH 优先；DAG 可视化不引入 React Flow；`host.call` 是动态插件专属 API，持久化插件不可用（决策已定，见 D-1）。

## Goals / Non-Goals

**Goals:**

- 「列表 → 编排 → 执行 → 讨论 → 交互」全链路在 DSH Web 可用（work.md 验证标准）
- RPC 接线对齐 DSH 官方 Typert 范式（`./remote` 生成贡献 + `$mount` + `ctx.remote.sandore.*`）
- `sandore-step` 讨论节点照抄 `ui-workflow-run` 三件套，在宿主 Session chat 视图渲染
- 4 包固化为仓库内 `cordis.yml` 静态组合，移除动态桩原型
- UI 视觉/交互融入 DSH web（ui-primitives/theme token/locale/标准 hook）

**Non-Goals:**

- 不改引擎执行语义（Task 1–4 已定）；不改 RPC 方法签名（纯加法的事件 payload 增字段除外）
- 不做 React Flow 完整 DAG 编辑（后续增强）；不重建独立讨论面板 API（`getDiscussion`/`addChatMessage` 已被 D8/D9 取代）
- 不改任何 DSH 仓库源码；不引入第三方 UI/网络库（无 axios/fetch/React Flow/i18next）
- 不做 `@xxx` mention 源扩展（D8 探索结论：用「子对话页 Send」原生交互取代）

## Decisions

### D-1 RPC 接线：Typert 生成贡献（对齐官方范式）

`workflow` 包构建时由 tsdown + typert generator（`@deepseek-ai/dsh-typert-generator/tsdown`）从 `SandoreRemote` 的 `@Remote` 装饰器生成 `lib/typert.remote-client.js`；`package.json` 增加 `"./remote"` 导出。`ui` Client 插件 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)`（返回 disposer，经 `ctx.effect` 生命周期管理），调用面 = `ctx.remote.sandore.listInstances()` 等（返回 `RemoteResult<T>`，`{ok:true,value}|{ok:false,error}` 需解包）。

- 备选「保留 host.call 薄封装」被排除：`host.call` 是动态插件（`cordis-client-runner`）的 Package-private RPC，静态组合的持久化包无此运行时上下文；且偏离全部官方包范式。
- `ui` 的 `dsh.client.inject` 需含 `@deepseek-ai/dsh-api-remotes`（提供 `ctx.remote` 服务，见 `ui-cordis` 先例）；`inject` 数组加 `'remote'`（客户端服务名）。
- **构建产物落位**：sandore 仓库 4 包此前无 build 配置（仅 typecheck）。Task 5 为 `workflow` 与 `ui` 增加 tsdown 配置：`workflow` 产 `lib/**` + typert 生成物；`ui` 产 client bundle（`dsh.client` browser 产物，照 `ui-cordis` 的 `clientBundle()` 辅助或等价配置）。`microflow`/`tool` 保持现状（无 client 面，`workflow` 依赖其 src 直引）。

- **DagEditor 的 YAML 数据面**：`listDefinitions` 仅返回原始 `yaml` 文本；DagEditor 渲染 Stage/Step 结构与「编辑态模型序列化（格式与 `workflow/src/yaml-parser.ts` 往返一致）」需要浏览器侧可用的解析/序列化能力。`workflow` 包需以浏览器安全子路径（如 `./schema`/`./yaml`）导出定义层 zod schema 与 `parseWorkflowYaml`/`serializeWorkflowYaml`（`schema.ts` 当前顶部依赖 Node 侧 `dsh-storage-domain`，需将定义层 schema 与存储层 `defineDomain`/`domainTable` 拆分为浏览器安全模块）；`ui` 侧以同一导出复用逻辑，避免客户端另写一套导致 schema 漂移/往返失败。

### D-2 事件 payload 补齐：引擎侧一次写入

6 个 `step-*` 事件（start/completed/failed/paused/resumed/retried）payload 追加 `name: string`（必填，来自引擎闭包内的 `step.name`）与 `loopIteration?: number[]`（可选，末尾，来自 Task 3 的 loop 迭代路径）。改动点：`workflow-engine.ts` 的 `emitStep*` 系列签名 + `seam.ts` 双声明（Cordis `Events` + `SessionEventMap`）+ 既有测试断言同步。

- 备选「前端折叠时 RPC 拉定义补偿」被排除：事件驱动折叠要求同步可得，异步补偿造成 stepId→name 闪变 + 额外往返/缓存复杂度。
- 向后兼容：纯加法字段，事件消费者（无既有第三方）不受影响。

### D-3 宿主会话标题：`sessionTitle.rename` 补设

`workflow` 包 `static inject` 补 `'sessionTitle'`（`@deepseek-ai/dsh-session-title`）；`startInstance` 创建宿主 Session 后调用 `ctx.sessionTitle.rename(handle.session, `工作流实例 ${instanceId}`)`。`rename` 产生 `source: {kind:'user'}` 标题，天然优先于 fallback 自动摘要。i18n：标题格式走引擎侧固定中文文案（与 DSH 宿主侧标题服务语义一致，不做前端 locale 分支——标题是持久化数据，非渲染态）。

### D-4 DagEditor/RunView 承载：WorkflowPanel 两级下钻 + 宽展开

不新增 slot。WorkflowPanel 内部维护 `view` 状态栈：`list`（默认/编排列表态，窄面板形态）↔ `editor`（DagEditor）↔ `run`（RunView）。下钻态使用宽展开 layer（照 `ui-cordis` `CordisPanel` 的 `wide ? css.layer : css.rail` 双态形态，layer 定位脱离侧栏宽度约束、锚定 footer 按钮上方展开为宽浮层）。返回按钮回退栈。

- 备选 `conversation.view` tab（ui-trajectory 先例）被排除：session-maybe scope 下非会话上下文需兜底，且与 D6「管理 UI 应全局、贴近侧栏导航」冲突。
- 备选 `shell.overlay` 被排除：root 级全帧浮层是 modal 打断，与「融入 DSH web」的嵌入式风格偏差。
- RunView 的「打开讨论」按钮仍按设计 §5.2 跳 `ctx.sessions.open(instanceId)`（宿主 Session chat 视图里有 `sandore-step` 节点），与承载决策正交。

### D-5 讨论节点：照抄 `ui-workflow-run` 三件套

1. `conversationEvents.register(sandoreStepDefinition)`——`ConversationNodeDefinition`（`kind:'sandore-step'`，`target:'chat'`），`match` 命中 `sandore/step-start|step-completed|step-failed|step-paused|step-resumed|step-retried`（含 D-2 补齐后的 `name`/`loopIteration`），`start/update` 折叠状态机：同一 `stepId`（+ 循环重入时 `stepId#iteration` 派生键）的多事件合并为一个节点，`step-completed` 时存 `output`。
2. `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key:'sandore-step', locale:NS, inject: () => ({ openSession: id => ctx.sessions.open(id) }) }, DagStepNodeView))`。
3. `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'sandore-step': DagStepChatData } }`。
- 渲染规则（设计 §5.3.2）：running 无结果 / completed 内联 `output`（`MessageText`/`MarkdownText` 自绘薄胶水）/ failed 红框 + error / paused 琥珀框；点击节点 `openSession(childId)`；`sandore/end`、`sandore/start`、`sandore/question`、`sandore/permission` 事件由 DSH 原生消息 UI/`PendingWait` 体系承载，不折叠为节点（复用 `ui-user-questions` 的 `PendingQuestion`）。
- 重试（continue/revert/fork）控件：Step 节点上补按钮，经 `ctx.remote.sandore.retryStep` 调用（fork 走 `forkAt(seq)` 原生能力的语义由 `mode:'fork'` 承载）。

### D-6 数据获取与刷新策略

- 列表态：挂载/打开面板时 `listInstances`/`listDefinitions` 拉取 + 打开期间 3s 轮询（对齐原 sandore §23.3.2 语义）；搜索走客户端过滤（实例/定义元数据量级小，不需 `ctx.sessions.search`）。
- RunView：`getInstanceState` 首拉 + 5s 轮询（运行中）；产物 `getArtifacts` 同周期；交互控件动作（pause/resume/retry/reply）调用后立即手动刷新一次。
- 讨论节点：零轮询——纯事件驱动（Session 事件日志经 apiproxy `session/event` 帧透传，`ConversationNodeDefinition` 折叠天然去重）。
- 全部经 `ctx.remote.sandore.*`（D-1），无独立 HTTP 层。

### D-7 工作区分组

`InstanceList` 默认态按 workspace 分组：`useWorkspaces(state => state.items)` 取 `WorkspaceView[].sessionIds` 成员表，`instanceId ∈ sessionIds` → 归组；不在任何 workspace 的实例归「未分组」。编排态 `DefinitionList` 平铺（定义无 workspace 归属）。`ui` 的 `inject` 补 `workspaces`。

### D-8 挂载固化格式

仓库根新建 `cordis.yml`（sandore 仓库目前无任何 cordis.yml；此文件作为目标 DSH Web 组合的 patch 参考与固化声明）：

```yaml
- insert:
    - id: workflow
      name: '@deepseek-ai/dsh-sandore-workflow'
      config: { defaultTimeoutMs: 7200000, maxConcurrentSteps: 0 }
    - id: microflow
      name: '@deepseek-ai/dsh-sandore-microflow'
    - id: tool
      name: '@deepseek-ai/dsh-sandore-tool'
    - id: ui
      name: '@deepseek-ai/dsh-client-ui-sandore'
```

- 「移除动态插件原型」= 删除 `ui/src/client/host.ts` 的本地 JSON 桩与 `client/index.ts` 的桩接线，Task 1 注释中预埋的「接入 ctx.remote 后替换」即此处。
- `ui` 的 `dsh.client.inject` 补 `@deepseek-ai/dsh-api-remotes`（ctx.remote）、`@deepseek-ai/dsh-client-ui-slots`（slot 注册服务）、`@deepseek-ai/dsh-client-ui-conversation`（conversation.chat.node/chat.node 契约类型）；`@deepseek-ai/dsh-client-ui-primitives` 为组件库直 import 的 peer 依赖（非服务提供方），不入 `dsh.client.inject`；`peerDependencies` 同步补齐。

### D-9 测试策略

- Host 侧（vitest，仓库既有范式）：D-2 事件 payload 断言更新（6 事件含 name/loopIteration）；D-3 sessionTitle 调用断言（stub sessionTitle 服务）。
- Client 侧：组件测试以「类型正确 + 关键交互逻辑」为主（折叠状态机 `match/start/update` 纯函数单测——参照 `ui-workflow-run` 的 definition 可测形态；面板 view 栈 reducer 单测）。DOM 渲染测试依赖 DSH 测试基建（sandbox 不可用），以 typecheck + 纯逻辑单测为门槛。
- 全量验证：`pnpm -r typecheck` + vitest 全绿 + `cordis.yml` YAML 语法校验。

## Risks / Trade-offs

- [typert 生成物依赖 DSH 内部 generator 包版本] → 锁定 `@deepseek-ai/dsh-typert-generator` 与 protocol 同 workspace 版本（peer `workspace:^`）；若 generator API 不稳定，回退方案为手写 `TypertRemoteContribution` 描述符（纯数据结构，`{package, descriptors}`），仍走 `$mount` 官方消费面。
- [宽展开 layer 的定位/裁剪在 rail 窄态下的表现] → CSS 锚定 footer 按钮容器（照抄 ui-cordis 的 layer 定位）；rail 态禁用下钻（点列表项先展开 sidebar，UI 引导）。
- [事件 payload 加字段与既有测试断言冲突] → D-2 实施时全量跑 workflow 包测试同步断言（向后兼容加法，无消费者破坏）。
- [`step-completed` 内联 `output` 可能较大（ContentBlock[]）] → Session 事件日志本就承载消息体（DSH 消息事件同量级），且折叠后单节点单份；不做截断（保真优先，与 D8「绕开跨会话读 snapshot」决策一致）。
- [讨论节点折叠状态机的循环重入去重（同 stepId 多次迭代）] → 节点 id 派生键 `stepId` + `loopIteration.join('.')` 后缀；`match` 阶段区分（D-2 补齐的 `loopIteration` 即为此用）。
- [ui 包 client bundle 构建链路首次引入 tsdown] → 照抄 `ui-cordis` 的 `clientBundle()` 配置形态；`typecheck` 门槛保持，构建失败不阻塞 typecheck 验证。

## Migration Plan

1. 先落 Host 侧最小增量（D-2 事件 payload + D-3 sessionTitle + `./remote` 导出与构建），Host 测试全绿——保证 ui 开发时数据面已定形。
2. 再落 `ui` 包（locales → RPC 桥 → 面板/列表 → DagEditor/RunView → 讨论节点三件套），每步 typecheck。
3. 最后落 `cordis.yml` 固化 + 移除动态桩 + 全量验证。
- 回滚：各步独立提交，任一步回滚不影响已交付的 Task 1–4 能力（事件加字段向后兼容）。

## Open Questions

（无——4 项关键决策已在头脑风暴与用户对齐并落地设计文档；其余实现细节按 D-1~D-9 执行）
