# 新版工作流 UI 实现计划（new-ui 落地）

> 依据：`new-ui.md`（最终方案）、`layout-prototype.html`（布局原型 v7）、
> `dsh-workflow-ui-prototype.html`（DSH 风格参考）、`task-5-frontend/design.md`+`work.md`（既有规格）。
> 范围：**仅 `packages/sandore/ui` Client 端重构**，不改引擎 / Host RPC——UI 只能消费
> 现有 27 个 `sandore.*` RPC + 13 个 `sandore/*` 事件 + `WorkflowTaskState` 快照。

---

## 0. 结论速览

- 入口：`sidebar.footer.action` 按钮 → **`shell.overlay` 浮层**（root scope、全局、不挂会话；覆盖 conversation 列、sidebar 保持可见可点）。
- 工作台双栏：左 = 工作流列表（实例/编排 toggle + 搜索 + 新增），右 = 编辑区（模式条 + 编排态 DagEditor 画布 / 执行态 RunView 三栏）。
- 执行态三栏：树形导航（左）+ 统一时间线 + 状态驱动输入区（中）+ 文件预览（右，默认隐藏）。
- 全部 DSH 风格：`--dsw-*` theme token、`ui-primitives`（Button/Pill/Input/DisclosureRow/StateDot/Modal/CodeBlock/MarkdownText/MessageText/icons）、CSS Modules、i18n `sandore` 命名空间。

---

## 1. 与设计稿的差异裁定（真实数据约束）

设计稿是「非常粗糙的原稿」，其中若干 RPC/事件在当前引擎中**不存在**，以下逐条裁定：

| # | 设计稿说法 | 现状 | 裁定 |
|---|---|---|---|
| 1 | D6：`sidebar.footer.action` → `shell.overlay` | slot 存在（list, root scope） | **采纳**。overlay 开关用插件自有模块 store |
| 2 | 不用 `conversation.view` tab | 暂停任务已实现 WorkflowView.tsx（conversation.view「工作流」tab） | **删除** WorkflowView.tsx/.module.css，tab 移除 |
| 3 | 不注册 `conversation.chat.node` sandore-step | 渲染器已实现并测试 | **保留渲染器**：它渲染在「宿主会话」自己的 chat 页（侧栏 `工作流实例 xxx`），不混入用户主对话；new-ui.md 的「不注册」理由是主对话干净，宿主会话页保留节点有实际价值。事件折叠定义 `conversationEvents.register` 亦保留 |
| 4 | DagEditor 用 React Flow + Dagre | 原型是手绘 DAG（绝对定位节点卡 + SVG 贝塞尔线 + 工具条） | **采用 `@xyflow/react` + `@dagrejs/dagre`**（new-ui.md §4 定稿）。**两层 DAG**：第一层 Stage DAG 仅串行/并行/条件分支（**无循环**，dynamic-workflow-engine.md）；点击 Stage 卡片下钻到该 Stage 的 Step DAG（微流程，**支持循环回边**，虚线标识）；面包屑返回 |
| 5 | `sendDiscussionMessage(payload)` / `pauseInstance` / `createInstance(definitionId)` / `getArtifact(id)` | 不存在（无 discussion RPC；实例启动是 `startInstance({jobId, originalInput})`；产物只回路径） | 输入区动作映射真实 RPC：running→`pauseAll`；paused→`resumeAll` / `resumeStep`（@Step 定点）；failed→`retryStep`（@Step 目标 + 三模式）+ 广播 `resumeAll`。**不做**「向实例发消息」（无此通道），输入只作为恢复/重试指令 |
| 6 | `sandore/step-message`、`sandore/discussion-message` 事件 | 不存在（13 事件无此二者）；引擎不写 `sessionMessages` | 时间线由 `getInstanceState` **轮询派生**（运行中 5s）：`executedSteps` 的 `output` 文本块作 returnPrompt、`error` 作失败详情、running 卡显示「运行中」+ 查看详情跳子会话；user 气泡仅 `originalInput` |
| 7 | 预览文件内容 | 产物 `ArtifactEntry.files` 只是路径字符串，无内容 RPC | 预览面板显示 returnPrompt（文本/markdown）与文件**路径**元信息；「读文件内容」记为后续（需新增 RPC） |
| 8 | 测试运行 `createInstance(definitionId)` | `startInstance` 需要 Job | 定义「▶ 测试运行」：找该 `workflowId` 的第一个 Job，无则 `createJob({name:'测试-<name>', workflowId})` → `startInstance({jobId, originalInput:'测试运行'})` → 自动切执行态并选中新实例 |
| 9 | 拖拽分隔条 5 处（含 sidebar/details） | sidebar/details 是 DSH 原生 | 插件内做 3 处：列表|编辑区、树形|中栏、中栏|预览；照搬 AppFrame `DragHandle` 模式（pointer capture + rAF） |

---

## 2. 组件树与布局

```
WorkflowButton (sidebar.footer.action) ──点击──► overlayStore.open()
WorkflowOverlay (shell.overlay, id 'sandore-overlay', root scope)
├─ overlay-header：标题「工作流」 + 刷新(🔄) + 关闭(✕)
└─ overlay-body（position 计算 left=sidebar 实测宽，覆盖 conversation+details 列）
   ├─ WorkflowList（左 300px，可拖宽 200–500px）
   │  ├─ header：标题 + 实例/编排 toggle（Pill 组）+ 搜索(Input) + 新增(Button)
   │  └─ body：InstanceList（默认态，3s 轮询，按工作区分组）| DefinitionList（编排态）
   ├─ DragHandle（data-side="list"）
   └─ EditorPane（右，flex-1）
      ├─ editor-mode-bar：标题(当前项名) + 编排/执行 toggle + ▶测试运行 + 💾保存 + ⬇导出
      └─ 内容区：编排态 → DagEditor；执行态 → RunView
```

**RunView（三栏）**：

```
├─ TreeNav（左 240px，可拖宽 180–400px）：workflow→stage→step→result/artifact 折叠树
│    ├─ 行 = chevron + 状态点 + 名称；todo 态默认折叠；叶子点击 → 打开右栏预览
├─ DragHandle（data-side="tree"）
├─ 中栏（flex-1）：UnifiedTimeline（滚动）+ DiscussionInput（底部，状态驱动）
├─ DragHandle（data-side="preview"，随右栏显示/隐藏）
└─ PreviewPanel（右 380px，可拖宽 280–600px，默认 hidden）
```

---

## 3. 文件清单（`packages/sandore/ui/src/client/`）

| 文件 | 动作 | 说明 |
|---|---|---|
| `index.ts` | 重写 | 注册 footer 按钮 + `shell.overlay`(WorkflowOverlay) + 保留 conversationEvents + chat.node |
| `WorkflowButton.tsx` | 小改 | face 改 `onOpenWorkflow()` → `overlayStore.open()`；样式复用 |
| `WorkflowOverlay.tsx` | 新增 | overlay 主体：header + 双栏；sidebar 宽实测（ResizeObserver）驱动 `--wf-left` |
| `WorkflowOverlay.module.css` | 新增 | 浮层/双栏/拖拽分隔条样式 |
| `WorkflowList.tsx` | 新增 | 左列表壳（header toggle/搜索/新增 + 内容区） |
| `InstanceList.tsx` / `DefinitionList.tsx` | 复用（微调） | 行样式对齐新原型（name + meta + badge）；`onOpen` 回调改为「选中」 |
| `EditorPane.tsx` | 新增 | 模式条 + 编排/执行内容切换 + 测试运行/保存动作 |
| `DagEditor.tsx` | 重写 | DAG 画布（节点卡 + SVG 贝塞尔边 + 工具条 + Stage/Step tab）+ 选中节点 Step 编辑侧栏 + YAML 预览折叠 + 保存/测试运行 |
| `DagEditor.module.css` | 重写 | 画布点阵背景、节点卡、工具条、侧栏、预览折叠 |
| `dag-editor-model.ts` | 扩展 | 增纯函数：`layoutStages()`（分层网格自动布局）、画布坐标模型；既有 Step 编辑模型保留 |
| `RunView.tsx` | 重写 | 三栏装配 + 5s 轮询 + `useRunState`（RPC + 派生树/时间线） |
| `TreeNav.tsx` / `tree-nav.module.css` | 新增 | 折叠树（DisclosureRow 风格） |
| `UnifiedTimeline.tsx` / `timeline.module.css` | 新增 | step 卡片 + user 气泡 + 滑动窗口 |
| `DiscussionInput.tsx` / `input.module.css` | 新增 | 状态驱动输入区（running 暂停 / paused 发送恢复 / failed 重试三模式 + @Step 选择） |
| `PreviewPanel.tsx` / `preview.module.css` | 新增 | returnPrompt/路径元信息预览 |
| `DragHandle.ts` | 新增 | 照 AppFrame 模式（pointer capture + rAF，~40 行） |
| `run-view-model.ts` | 扩展 | 增纯函数：`buildRunTree(state, artifacts)`、`buildTimeline(state)` |
| `locales.ts` | 增补 | ~30 键（overlay/mode/tree/preview/input 状态等） |
| `WorkflowView.tsx` / `.module.css` | 删除 | conversation.view tab 不再使用 |
| `WorkflowButton.module.css` / `WorkflowPanel.module.css` | 复用 | 后者仍被 InstanceList/DefinitionList 引用 |

---

## 4. 样式约定

- 全部颜色/圆角/阴影走 `--dsw-*` token（自动明暗适配）；CSS Modules；每组件一 css。
- 分隔条：7px 宽，hover/拖动时 2px accent 高亮（照 AppFrame `.drag-handle`）。
- 状态色：`done→state-success`、`run→state-info + pulse 动画`、`todo→label-disabled`、`fail→state-error`、`paused→state-warning`。
- 卡片：`border-l1 + radius-md + bg-elevated`；列表行 hover `bg-hover`、选中 `accent-bg`。
- 图标：ui-primitives 图标（IconBranchOutline16 等）+ 少量字符（⏸ ▶ ✕ ↻）对齐原型。
- 输入区状态驱动（running 禁用 / paused 可发送 / failed 重试模式行 + 发送）。

---

## 5. 数据流

- **overlay 开关 / 选中态 / 编辑模式**：模块级轻量 store（`getSnapshot/subscribe/set`，不依赖 dsh-client-runtime 具名导出——其 ModuleLoader bundle 无法被 bundler 静态分析，此前已验证）。
- **列表**：`listInstances`（现有 3s 轮询）/ `listDefinitions`（加载一次 + 保存/删除后刷新）。
- **RunView**：`getInstanceState` 轮询（`running/interacting` 5s，终态停）+ 手动刷新；树与时间线由纯函数从 state 派生；交互（暂停/恢复/重试/问答/权限）调 RPC 后立即刷新。
- **DagEditor**：`getYaml(id)` → 模型 → 画布；编辑 → 本地模型 → YAML 预览实时；保存 `updateYaml` / 新建 `createDefinition`。
- **打开讨论**：step 卡「查看详情」/树「跳子会话」→ `sessions.open(childId 或 instanceId)`。

---

## 6. 验证（dev profile，端口 3090，Playwright）

1. 点「工作流」按钮 → overlay 出现（覆盖 conversation，sidebar 可见、仍可点击切换会话）。
2. 左列表默认实例态 → 点实例 → 右编辑区切执行态 RunView 三栏（树 + 时间线 + 输入区）。
3. 左列表切「编排」→ 定义列表 → 点定义 → DagEditor 画布（节点卡 + 连线 + YAML 预览）。
4. 拖拽 3 处分隔条生效；预览右栏随树叶子点击出现/关闭。
5. 「▶测试运行」→ 新实例出现并自动进执行态。
6. 关闭按钮关闭 overlay；再次点击按钮重新打开。

---

## 7. 实施顺序

1. 基础设施：`DragHandle.ts` + 模块 store + `locales.ts` + `index.ts` + `WorkflowButton`。
2. `WorkflowOverlay` + `WorkflowList`（复用列表组件）。
3. `EditorPane` + `DagEditor` 画布重写（含 `dag-editor-model.layoutStages`）。
4. `RunView` 三栏重写（TreeNav / UnifiedTimeline / DiscussionInput / PreviewPanel + `run-view-model` 扩展）。
5. 构建 ui 包 → 重启 dev(3090) → Playwright 验证 → 修复。

---

## 8. 实施状态（已落地）

- **入口/工作台**：`sidebar.footer.action` 按钮 → `shell.overlay`（`WorkflowOverlay`）；左 `WorkflowList`（实例/编排 toggle + 搜索 + 新增 + 选中高亮）+ 右 `EditorPane`（模式条 + 编排/执行 + ▶ 测试运行）。
- **编排态**：`DagEditor` **两层 DAG**（React Flow + Dagre）：Stage DAG 层（串行/并行/条件边——绿色=并行、琥珀色=条件带 expectation 标签，**无循环**）→ 点击 Stage 卡片下钻 Step DAG（微流程：next 串行 / branches 并行+条件 / **loop.next 循环回边虚线+流动动画**）；节点可拖拽、点击选中 → 右侧字段编辑面板；**拖拽连线**（source→target 设串行 next，n8n/Dify 同款）；工具条 自动布局（dagre 分层）/缩放/适应；MiniMap + 点阵背景；YAML 预览折叠 + 保存；测试运行 = 找/建 Job → `startInstance` → 自动切执行态选中新实例。
- **画布视觉（照抄 React Flow 官方 dagre 示例 theme）**：`reactflow-theme.css` 原样采用官方 `--xy-*` 变量（白底节点 `#ffffff`、粉色选中 `#f57dbd`、可见边色 `#b1b1b7`、官方 box-shadow/handle），`colorMode="system"` + `.react-flow.dark` 暗色版；**垂直布局**（官方示例默认 `rankdir:'TB'`，节点 target 上 / source 下，172×36 单行名称卡片）；边 `smoothstep` + `ArrowClosed`：串行 `next` 与并行分支（expectation 空/缺省）用默认灰色实线 `--xy-edge-stroke-default` 且**不 animated**（React Flow 的 `animated` 样式是流动虚线，仅条件分支/循环回边启用）；**条件分支**（expectation 非空）琥珀色虚线 `6 4` + 期望值边标签 + animated；循环回边红色虚线 + animated；**端口拖拽连接**（`connectOnClick={false}` 使按下端口即出现跟随鼠标的连线，`connectionLineStyle` 用常量灰 `#b1b1b7` 避免 DSH 设计令牌变量在画布作用域失效、线不可见，`connectionRadius={30}` 扩大端口命中区）+ **双击下钻/选中**；**连线语义**：首次连线设串行 `next`，同一 source 再次连线自动并入**并行 branches**（`{next}` 无 expectation，默认并行）；**新增节点默认落到画布中心空白处**（`screenToFlowPosition` 把视口中心换算为画布坐标作为落点；若中心被既有节点占用——如 fitView 已把节点居中——则沿十字/对角 60px 步长逐圈外扩找首个空白，不自动连线、不打乱既有布局；首次加载/切换层级仍走 dagre）；MiniMap + 点阵背景。
- **执行态**：`RunView` 三栏（`TreeNav` 折叠树 + `UnifiedTimeline` step 卡/user 气泡 + `DiscussionInput` 状态驱动输入区 + `PreviewPanel` 右栏预览 + 待处理问答/权限卡片）。
- **定义详情与流控编辑**：① 点击定义右侧**默认显示 `DefinitionDetail`**（name/version/description/settings，可编辑+保存），「进入编排」切两层 DAG；② **分支是唯一出边单元**（Stage 与 Step 统一 `branches: [{ next, condition?, loop? }]`，哪怕只有一个分支也放 branches，废弃节点级 next/condition/loop）：无 `condition` = 并行分支（始终走），有 `condition` = 条件分支（布尔判定：AI 输出 true/false，shell 走 matchesExpectation，true 才走），有 `loop` = 循环回边分支（`next` 指向更早节点，`loop` 控制迭代/跳出：maxIterations + breakCondition + breakExpectation + exitTo）；**优先级**：并行必走 + 条件匹配才走 → 命中回边分支循环、前进分支前进、无命中数组顺序兜底；③ Stage 面板 = 名称（占满+删除）+ FlowEditor（分支列表：目标 + 并行/条件 Pill + 判断条件命令卡片 + **无循环**，判断条件仅 shell/prompt）；Step 面板 = 名称 + 命令（五类型，必填默认 shell）+ FlowEditor（分支列表 + **循环折叠**）+ 输入/输出映射 + 透传变量（含强制刷新按钮）+ 门控（secondary）；④ 左侧画布**单击 Stage → 右侧同步显示**（`onNodeClick` 选中；双击下钻 Step DAG）；连线统一并入并行 branches，回环检查（`wouldCreateStageCycle` 从 branches[].next + loop.next 取边）拒绝回环。
- **分离式步骤结构（V2 按 dynamic-workflow-engine.md）**：`stages[].steps[]` 仅存**流控位** `{ id, branches? }`；完整 Step 定义（name/command/inputFrom/outputTo/passThroughVars/timeout/defaultExpectation/rules/gates）存**顶层 `steps[]`**，按 id 交叉引用。UI 侧新增 `MergedStep`（= `WorkflowStep & { branches? }`）与 `mergedStepsOf(definition, stage)` 合并视图供画布/编辑器读取；写入拆分：定义字段（改名/命令/映射/门控/透传）→ 顶层 `steps[]`，流控字段（branches）→ `stage.steps[].branches`（`updateStep` 拆两条落库）；`addStep` 同时追加两处（流控位 + 顶层定义，默认 shell 命令）；`removeSteps` 同步清理两处并清悬空 branches 引用。引擎（dag-navigator/stage-executor）运行时按 id 合并消费；旧合并式 YAML 不支持迁移。
- **构建期修复**（tsdown.config.ts）：① CSS Modules 类名改「文件名短 hash 前缀 + 原名」，根治多 `.module.css` 通用类名（`.layer` 等）与 DSH 全局类名冲突；② `process` shim 补具名导出（`env` 等），修内联 yaml 解析器 `node_process.env.LOG_TOKENS` 崩溃（点定义进 DagEditor 不再炸）；③ React Flow 样式 `@xyflow/react/dist/style.css` 由 cssModulesPlugin 精确拦截、原样注入 `<style>`（`@tsdown/css` 会提取成独立文件，ModuleLoader 不加载）；④ bundle intro 注入局部 `process` shim（React Flow 裸引用全局 `process`，否则 `process is not defined`）；⑤ 节点对象预置 `width/height`（React Flow v12 跳过 ResizeObserver 测量，否则节点 `visibility:hidden` 挂起、边不渲染）。
- **运行时修复**：overlay 左缘实测 sidebar 实际渲染宽度（`[data-slot="sidebar"]` 是 display:contents 0 宽 wrapper，沿祖先链取首个非零宽）；拖拽分隔条改**增量位移**语义（原累计位移被状态累加导致 300→520 漂移）；**画布删除**（`deleteKeyCode=['Backspace','Delete']`——React Flow v12 默认只认 Backspace，Delete 无效；`onNodesDelete`/`onEdgesDelete` 同步模型：Stage 层删 Stage、Step 层删 Step，并清理其余节点指向被删目标的 `next`/`branches[].next`/`loop.next` 悬空引用，删除后不再"复活"）。
- **验证（dev 3090，Playwright）**：按钮→overlay 定位正确（x=280 起、sidebar 可见）→ 实例列表→RunView 三栏（树/时间线/输入区，user 气泡 + step 卡输出文本）→ 树展开→result 叶子→预览面板（380px）→ 编排定义列表→点定义→**Stage DAG**（dagre 布局多节点 + 串行边 + 下钻提示）→ 点击 Stage → **Step DAG**（微流程节点 + 返回按钮）→ 拖拽 300→360 → 关闭 overlay。全程无控制台错误。
- **沿用**：`conversationEvents.register(sandoreStepDefinition)` + `conversation.chat.node` sandore-step 渲染器保留（宿主会话 chat 页展示 step 节点，不混入用户主对话）。

### 后续增强（本期未做）

- 产物文件**内容**预览（需新增 `sandore.getArtifactContent` 之类 RPC；现仅展示路径元信息）。
- 「导出」按钮（YAML 拷贝已可用）。
- 实例「新增」（需先建定义/Job，现按钮在实例态禁用并给提示）。
