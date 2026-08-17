# sandore 前端 UI 最终方案

> 本文记录经多轮讨论收敛后的前端布局方案，替代 `task-5-frontend/design.md` 中 D6/D8 的部分决策。
> 配套原型见 `task-5-frontend/layout-prototype.html`。

---

## 1. 设计决策回顾

### 1.1 D9（宿主 Session）：保留原设计——独立宿主 Agent

工作流引擎在启动实例时，通过 `ctx.agents.create({ sessionId: SessionId(instanceId), setup: createHostAgentSetup(...) })` 创建**独立宿主 Agent**（`workflow-engine.ts:206`）。Step 子代理的 `parent` = 宿主 Agent，而非当前会话的 AI。

**为什么不能用 D9-改（宿主 = 当前会话）**：DSH 的 `notifySettlement`（`continuation.ts:1400`）在子代理完成时无条件向 parent 投递结果——如果 parent = 当前会话 AI 且空闲，`followup(message)` 会自动启动新 turn，导致主会话被工作流内部消息意外唤醒。独立宿主 Agent 隔离了这一行为。

- 工作流启动后，宿主 Agent 独立运行，不干扰当前会话。
- 当前会话的 AI 可以继续自由对话，用户通过独立 UI 观察和干预工作流。
- `completed` 后宿主 Agent 不降级——它就是工作流实例的编排器，生命周期与实例绑定。

### 1.2 D8（讨论面板）：独立讨论，不混入主对话

讨论面板**不**使用 `conversation.chat.node` 的 `sandore-step` 节点。主对话流保持干净——只有人机对话，无工作流节点混入。

讨论数据从 `sandore/*` session 事件（`step-start` / `step-completed` / `step-failed` 等）自绘，`step-completed` 事件 payload 已内联子代理最终结果。用 ui-primitives 的 `MarkdownText` / `MessageText` 自绘消息流，不读 chat 视图。

### 1.3 D6（UI 入口）：独立 UI via `shell.overlay`

工作流 UI **不跟随会话走**——"其实我这个工作流不应该跟着会话走，因为实际上没有太强的因果关系"。

- 入口 = `sidebar.footer.action` 按钮（设置上方，root scope）。
- 点击 → `shell.overlay` 浮层展开，覆盖 conversation 中栏（sidebar 仍可见），全局独立。
- 不用 `conversation.view` tab（session-maybe scope，与「管理 UI 应全局」有张力）。
- 不用 `conversation.chat.node`（干扰默认对话）。

### 1.4 执行态布局：统一时间线（参考 workflow-lab-3）

执行态不分离「执行轨迹」和「讨论」——**一个统一时间线**，step 卡片和 user 气泡按时间顺序交错排列，完全参考 workflow-lab-3 的 `WorkflowDiscussionPanel` 设计。

---
## 2. 整体布局结构

```
DSH AppFrame 三栏（ui-layout/AppFrame.tsx）
├── sidebar（左栏，DSH 原生，可拖拽调宽/折叠）
│   ├── 工作区列表 / 会话列表
│   └── footer
│       ├── [🔀 工作流] 按钮（sidebar.footer.action，root scope）★
│       └── 设置按钮
│
├── conversation（中栏，minmax(0,1fr)）
│   └── 干净的人机对话（无工作流节点混入）
│
└── shell.overlay 浮层（root scope，全局，不挂会话）★
    └── 工作流 overlay（覆盖 conversation 列，sidebar 可见）
        ├── overlay-header（标题 + 关闭按钮）
        └── overlay-body（双栏工作台）
            ├── 左栏：工作流列表（~300px，可拖拽）
            │   ├── header：搜索 + 实例/编排 toggle + 新增
            │   └── body：实例列表 / 定义列表（全局数据）
            ├── 可拖拽分隔条（DragHandle）
            └── 右栏：编辑区（flex-1）
                ├── 模式切换条（编排 / 执行）
                ├── 编排态 DagEditor
                └── 执行态 RunView（三栏：树形导航 + 统一时间线 + 文件预览）
```

### 布局示意

```
┌─────────┬──────────────────────────────────────────────────┐
│ sidebar │ overlay（覆盖 conversation 列，sidebar 可见）      │
│         │                                                  │
│ 工作区   │ ┌──────────┬───────────────────────────────────┐│
│ 会话列表 │ │ 工作流列表 │ 编辑区                              ││
│         │ │          │                                     ││
│         │ │ ▸ 实例    │ ┌编排态 / 执行态 toggle─────────────┐││
│         │ │ ▸ 编排    │ │                                   │││
│ ─────── │ │          │ │ 编排态: DagEditor (React Flow DAG) │││
│ 🔀工作流 │ │ [实例列表] │ │ 执行态: 三栏 RunView (见 §5)       │││
│ ⚙设置   │ │          │ │                                   │││
│         │ └──────────┘ └───────────────────────────────────┘││
│         └────────────────────────────────────────────────────┘│
└─────────┴──────────────────────────────────────────────────────┘
```

---

## 3. Slot 注册

`ui` 的 Client 插件 `apply(ctx)` 只注册一个 slot：

```ts
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui: dict')
  // 工作流入口按钮（sidebar.footer.action，root scope，设置上方）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    locale: NS,
    inject: () => ({
      hooks: { open: createOverlayStore() },  // overlay 开关状态（自包含 client 状态）
    }),
  }, WorkflowButton))
}
```

**不注册** `conversation.view` tab。
**不注册** `conversation.chat.node` sandore-step 节点。

---

## 4. 编排态 DagEditor

### 4.1 布局
```
┌────────────────────────────────────────────────────────┐
│ editor-mode-bar: [标题]  [编排|执行 toggle]  [▶测试运行] [💾] [⬇] │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────┐         ┌──────┐         ┌──────┐          │
│  │Stage │──────▶│Stage │──────▶│Stage │          │
│  │数据  │        │分析  │        │报告  │          │
│  │采集  │        │处理  │        │生成  │          │
│  │      │        │      │        │      │          │
│  │ ✓ 拉 │        │ ✓ 静 │        │ ○ 汇 │          │
│  │ ✓ 解 │        │ ● AI │        │ ○ 生 │          │
│  │      │        │ ○ 安 │        │      │          │
│  └──────┘        └──────┘        └──────┘          │
│                                                        │
│  [🎯自动布局] [＋] [－] [⤢适应]                        │
│                                                        │
│  [Stage DAG | Step DAG]  ← 切换标签                    │
└────────────────────────────────────────────────────────┘
```

### 4.2 实现

- **DAG 可视化**：引入 `@xyflow/react` + `@dagrejs/dagre`，在 sandore ui 包内使用，不影响 DSH 核心。
- **节点**：Stage 节点卡片（name + type badge + step 列表带状态点）；Step DAG 模式下钻到 Step 级节点。
- **连线**：Dagre 自动布局，贝塞尔曲线连线。
- **交互**：拖拽节点、选中节点 → 右侧弹出 Step 编辑面板（命令/输入/输出/门禁/分支/循环）。
- **YAML 预览**：底部折叠面板，实时显示当前编排的 YAML 定义。
- **保存**：`ctx.remote.sandore.updateYaml(definitionId, yaml)` 保存定义。
- **测试运行**：`ctx.remote.sandore.createInstance(definitionId)` 创建实例 → 自动切到执行态。

### 4.3 依赖

```json
// packages/sandore/ui/package.json → dependencies（非 peerDependencies）
{
  "dependencies": {
    "@xyflow/react": "^12.0.0",
    "@dagrejs/dagre": "^1.1.0"
  }
}
```

这两个包打进 sandore ui 的 client bundle，不影响 DSH 核心包。

### 4.4 数据流

```
点定义 → ctx.remote.sandore.getYaml(definitionId) → 解析为 Stage/Step 结构 → 渲染 DAG
拖拽/编辑 → 更新本地状态 → YAML 预览实时刷新
保存 → ctx.remote.sandore.updateYaml(definitionId, yaml) → 确认
```

---

## 5. 执行态 RunView（三栏）

### 5.1 布局
```
┌──────────┬──────────────────────────────┬──────────────┐
│ 树形导航  │ 统一时间线 + 输入区域         │ 文件预览      │
│ (左)     │ (中)                         │ (右, 可选)   │
│          │                              │              │
│ ▼ 工作流  │ ┌ Step card ──────────────┐  │ 点击产物后   │
│   ▼ S1   │ │ ✓ 拉取仓库代码 ✓完成    │  │ 出现         │
│     ▼ s1 │ │ 已克隆 sandore 仓库...  │  │              │
│       📝│ └─────────────────────────┘  │ # 文件内容   │
│       📄│ ┌ Step card ──────────────┐  │              │
│     ▶ s2 │ │ ● AI 代码审查 ●运行中   │  │              │
│   ▶ S2   │ │ AI: 正在分析...        │  │              │
│          │ │ ⚡ read DagEditor.tsx   │  │              │
│          │ └─────────────────────────┘  │              │
│          │ [输入区域: @Step + textarea]  │              │
└──────────┴──────────────────────────────┴──────────────┘
```

三栏横向排列（`flex-direction:row`），类似 VSCode 的目录树 + 编辑器 + 预览。三栏都可拖拽调整宽度。右栏默认隐藏，点击树形导航里的产物后出现。

### 5.2 左栏：树形导航（DSH DisclosureRow 风格）

多层折叠树，参考 DSH `ui-workflow-run` 的 `DisclosureRow` 风格（chevron + 缩进 + 可折叠）：

```
▼ 🔵 数据分析流水线              ← 第一层：工作流实例
  ▼ ✓ 数据采集                  ← 第二层：Stage
    ▼ ✓ 拉取仓库代码            ← 第三层：Step
      📝 返回结果               ← 第四层：叶子节点（点击 → 右栏预览）
      📄 analysis-report.md  12.4 KB
    ▼ ✓ 解析依赖树
      📝 返回结果
      📄 dependency-tree.json  3.2 KB
  ▼ ● 分析处理
    ▼ ✓ 静态分析
      📝 返回结果
      📄 lint-results.json  8.7 KB
    ▶ ● AI 代码审查
      📝 返回结果 (等待中)
    ○ 安全扫描
  ▶ ○ 报告生成
```
**层级结构**：

| 层级 | 类型 | 说明 |
|------|------|------|
| 第一层 | `workflow` | 工作流实例（名称 + 运行状态） |
| 第二层 | `stage` | Stage（名称 + 完成状态） |
| 第三层 | `step` | Step（名称 + done/running/todo 状态） |
| 第四层 | `result` | 子代理返回结果（📝 图标，点击 → 右栏预览返回文本） |
| 第四层 | `artifact` | 产物文件（📄 图标 + 文件名 + 大小，点击 → 右栏预览文件内容） |

**状态点**：
- `done` → 绿色实心点
- `running`/`active` → 蓝色脉冲点（`animation: pulse 1.5s infinite`）
- `todo` → 灰色点

**折叠行为**：
- 有子节点的行：点击整行 toggle `collapsed` class
- todo 状态的 Stage/Step 默认折叠（未开始的不展开）
- 叶子节点（result/artifact）：点击 → `selectPreview(id)` 打开右栏

**实现**：

```tsx
function TreeNav({ instanceId }: { instanceId: string }) {
  const tree = useTreeData(instanceId)  // 从 ctx.remote.sandore.getInstanceState() 构建
  return (
    <div className="run-tree-col">
      <div className="tree-header"><span className="tree-title">导航</span></div>
      <div className="tree-body">
        {tree.map(node => <TreeNode key={node.id} node={node} depth={0} />)}
      </div>
    </div>
  )
}
function TreeNode({ node, depth }: { node: TreeNode; depth: number }) {
  const [collapsed, setCollapsed] = useState(node.status === 'todo' && depth > 0)
  const hasChildren = node.children?.length > 0
  return (
    <div className={`tree-node ${collapsed ? 'collapsed' : ''}`}>
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 16 }}
           onClick={() => hasChildren && setCollapsed(!collapsed)}>
        <span className="tree-chevron">{hasChildren ? '▼' : ''}</span>
        <span className={`tree-dot ${node.status}`} />
        <span className="tree-label">{node.name}</span>
      </div>
      {hasChildren && !collapsed && (
        <div className="tree-children">
          {node.children.map(child =>
            child.type === 'result' || child.type === 'artifact'
              ? <TreeLeaf key={child.id} leaf={child} depth={depth + 1} />
              : <TreeNode key={child.id} node={child} depth={depth + 1} />
          )}
        </div>
      )}
    </div>
  )
}
```

**数据构建**：从 `ctx.remote.sandore.getInstanceState(instanceId)` 返回的 `stageInfos[]` 构建。每个 Stage 的 `stepInfos[]` 映射为 Step 节点；Step 完成后从 `step-completed` 事件 payload 提取 `returnPrompt` 作为返回结果叶子节点；从 `ctx.remote.sandore.getArtifacts(stepId)` 获取产物列表。
### 5.3 中栏：统一时间线 + 输入区域

#### 5.3.1 统一时间线（workflow-lab-3 风格）

**一个时间线**，step 卡片和 user 气泡按时间顺序交错排列：

```
┌ Step card ──────────────────────────────────────────────┐
│ ✓ 拉取仓库代码  ✓完成                          14:02:01 │
│ 已克隆 sandore 仓库，共 1,247 个文件，主分支 commit a3f1c2 │
│ ▶ 查看详情                                                │
└──────────────────────────────────────────────────────────┘
┌ Step card ──────────────────────────────────────────────┐
│ ✓ 解析依赖树  ✓完成                          14:02:15 │
│ 识别到 4 个工作区包：workflow / microflow / tool / ui     │
│ ▶ 查看详情                                                │
└──────────────────────────────────────────────────────────┘
              ┌─────────────────────────┐
              │ 重点看 ui 包的布局组件   │  你
              └─────────────────────────┘
┌ Step card ──────────────────────────────────────────────┐
│ ● AI 代码审查  ●运行中                        14:03:30 │
│ AI: 正在分析 DagEditor.tsx 与 RunView.tsx 的布局结构...  │
│ ⚡ read  DagEditor.tsx (437 lines)                       │
│ ⚡ read  RunView.tsx (630 lines)                         │
│ AI: 发现 3 个布局问题：1) 固定宽度无拖拽 2) 无 DAG 可视化  │
│ AI: 正在生成改进建议... ●                                 │
└──────────────────────────────────────────────────────────┘
```

**Step 卡片**（GitHub comment-card 风格）：
```tsx
function StepCard({ item }: { item: TimelineStepItem }) {
  return (
    <div className="tl-step-card">
      <div className="tl-step-header">
        <div className={`tl-avatar ${item.status}`}>
          {item.status === 'done' ? '✓' : item.status === 'running' ? '●' : '✕'}
        </div>
        <span className="tl-name" onClick={() => openSession(item.childId)}>
          {item.name}
        </span>
        <StatusBadge status={item.status} />
        <span className="tl-time">{item.time}</span>
      </div>
      <div className="tl-step-body">
        {item.returnPrompt ? (
          // completed step → 显示返回摘要 + 可展开
          <>
            <div className="tl-step-return">
              <MessageText content={item.returnPrompt} />
            </div>
            <div className="tl-step-expand-btn" onClick={() => expandStep(item.childId)}>
              ▶ 查看详情
            </div>
          </>
        ) : item.messages ? (
          // running step → 内嵌实时子代理消息流
          <div className="tl-step-live">
            {item.messages.map(msg => <StepMessage key={msg.seq} msg={msg} />)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
```

**Step 卡片 body 渲染规则**（参考 workflow-lab-3）：
| Step 状态 | body 内容 |
|-----------|-----------|
| `done` | `returnPrompt`（markdown 摘要）+ "▶ 查看详情"按钮（展开完整子代理消息） |
| `running` | 内嵌实时子代理消息流（AI 消息 + 工具调用，只读，DSH 消息样式） |
| `failed` | 错误信息 + 可展开错误详情 |

**User 气泡**（右对齐）：

```tsx
function UserBubble({ item }: { item: TimelineUserItem }) {
  return (
    <div className="tl-user-bubble">
      <div className="tl-u-content">
        <MessageText content={item.content} />
      </div>
      <div className="tl-u-avatar">你</div>
    </div>
  )
}
```

**实时消息渲染**：running step 的内嵌消息流复用 DSH 子代理消息样式（`MessageText` + tool call 行），只读模式——只看消息，不输入。数据来自 `sandore/step-message` session 事件（实时推送）。

**消息项组件**：
```tsx
function StepMessage({ msg }: { msg: StepMessage }) {
  if (msg.role === 'ai') {
    return (
      <div className="tl-msg">
        <div className="tl-m-avatar ai">AI</div>
        <div className="tl-m-body">
          <div className="tl-m-text">
            <MessageText content={msg.text} />
            {msg.running && <span className="badge running"><span className="bdot" /></span>}
          </div>
        </div>
      </div>
    )
  }
  if (msg.role === 'tool') {
    return (
      <div className="tl-msg">
        <div className="tl-m-avatar tool">⚡</div>
        <div className="tl-m-body">
          <div className="tl-m-tool">
            <span className="tl-m-tool-name">{msg.name}</span>
            <span className="tl-m-tool-out">{msg.output}</span>
          </div>
        </div>
      </div>
    )
  }
  return null
}
```

**滑动窗口**：参考 workflow-lab-3 的 `visibleCount` 机制——只渲染最近 N 条消息，向上滚动时加载更多。避免消息过多时的性能问题。
```tsx
const VISIBLE_COUNT = 50  // 初始可见消息数
const [visibleCount, setVisibleCount] = useState(VISIBLE_COUNT)
const visibleMessages = useMemo(() => messages.slice(-visibleCount), [messages, visibleCount])

// 滚动到顶部时加载更多
const handleScroll = (e: React.UIEvent) => {
  if (e.currentTarget.scrollTop === 0 && visibleCount < messages.length) {
    setVisibleCount(c => Math.min(c + VISIBLE_COUNT, messages.length))
  }
}
```

#### 5.3.2 输入区域（状态驱动）

底部输入区域，行为随工作流状态变化（完全参考 workflow-lab-3）：

| 状态 | textarea | placeholder | 按钮 | retry mode |
|------|----------|-------------|------|------------|
| `running` | disabled | "点击暂停按钮以暂停执行..." | 🟠 暂停按钮（可见） | 隐藏 |
| `paused` | enabled | "输入恢复指令，@step 定点恢复..." | 🔵 发送按钮（可见） | 隐藏 |
| `failed` | enabled | "输入消息，@step 重试失败步骤..." | 🔵 发送按钮（可见） | 显示（继续/Revert/Fork） |

**输入区域结构**：
```tsx
function DiscussionInput({ state, steps }: { state: RunState; steps: Step[] }) {
  const [text, setText] = useState('')
  const [targetStep, setTargetStep] = useState<string | null>(null)
  const [retryMode, setRetryMode] = useState<'continue' | 'revert' | 'fork'>('continue')

  const isRunning = state === 'running'
  const isFailed = state === 'failed'

  return (
    <div className="disc-input-area">
      {/* @Step 目标选择条 */}
      <div className="disc-mention-bar">
        <button className="disc-target-btn" onClick={() => setStepPickerOpen(true)}>
          {targetStep ? `@Step: ${getStepName(targetStep)} ▾` : '@Step ▾'}
        </button>
        <span className="disc-mention-hint">恢复/广播/重试</span>
      </div>

      {/* 文本输入 */}
      <textarea
        className="disc-textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={getPlaceholder(state)}
        disabled={isRunning}
      />

      {/* 重试模式选择器（仅 failed 状态显示）*/}
      {isFailed && (
        <div className="disc-retry-mode">
          <span className="disc-retry-label">重试方式</span>
          {(['continue', 'revert', 'fork'] as const).map(mode => (
            <button key={mode}
              className={`disc-retry-btn ${retryMode === mode ? 'active' : ''}`}
              onClick={() => setRetryMode(mode)}>
              {mode === 'continue' ? '继续' : mode === 'revert' ? 'Revert' : 'Fork'}
            </button>
          ))}
        </div>
      )}
      {/* 操作按钮 */}
      <div className="disc-actions">
        <select className="disc-provider">
          <option>默认模型</option>
          <option>glm-4</option>
          <option>deepseek</option>
        </select>
        <span className="spacer" />
        {isRunning ? (
          <button className="disc-pause-btn" onClick={handlePause} title="暂停">⏸</button>
        ) : (
          <button className="disc-send-btn" onClick={handleSend} title="发送">➤</button>
        )}
      </div>
    </div>
  )
}
```

**@Step 目标选择**：

- 点击 `@Step` 按钮 → 弹出步骤选择器（只列出 paused/failed 状态的步骤）
- 选中后，消息会以 `@step` mention 形式发送给宿主 Agent
- 语义：
  - `paused` 状态 → 定点恢复（从指定 Step 继续）
  - `failed` 状态 → 重试失败步骤
  - 不选 → 广播给所有 Step

**发送逻辑**：

```ts
async function handleSend() {
  const payload = {
    instanceId,
    message: text,
    targetStepId: targetStep,   // null = 广播
    retryMode: isFailed ? retryMode : undefined,
  }
  await ctx.remote.sandore.sendDiscussionMessage(payload)
  setText('')
}
```
### 5.4 右栏：文件预览

默认隐藏（`hidden` class）。点击树形导航里的产物或返回结果后出现。

```tsx
function PreviewPanel({ data }: { data: PreviewData | null }) {
  if (!data) return null
  return (
    <div className="run-preview-col">
      <div className="preview-header">
        <span className="preview-title">{data.name}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
      </div>
      <div className="preview-body">
        <div className="preview-meta">
          <span>📄 {data.type}</span>
          {data.size && <span>{data.size}</span>}
        </div>
        <pre className="preview-file">{data.content}</pre>
      </div>
    </div>
  )
}
```

**预览内容类型**：
- `text`：纯文本（子代理返回结果摘要）
- `markdown`：markdown 渲染（用 `MarkdownText` 组件）
- `json`：JSON 格式化显示（`<pre>` + 等宽字体）

**关闭行为**：点击 ✕ 按钮 → 右栏隐藏 + 取消树形导航的 active 选中状态。

---
## 6. 拖拽机制

所有可拖拽分隔条照搬 DSH AppFrame 的 `DragHandle` 模式（pointer capture + rAF throttle，约 40 行）：

```ts
function makeDragHandle(el: HTMLElement, onDrag: (dx: number) => void) {
  if (!el) return
  let origin = 0, frame: number | null = null, latest = 0
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    origin = e.clientX
    latest = e.clientX
    el.classList.add('dragging')
  })
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return
    latest = e.clientX
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null
        onDrag(latest - origin)
      })
    }
  })
  const end = (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return
    el.releasePointerCapture(e.pointerId)
    if (frame !== null) { cancelAnimationFrame(frame); frame = null }
    onDrag(latest - origin)
    el.classList.remove('dragging')
  }
  el.addEventListener('pointerup', end)
}
```
**五个拖拽位置**：

| 位置 | 元素 | 范围 |
|------|------|------|
| sidebar 分隔条 | `handleSidebar` | 180–400px |
| 列表/编辑区分隔条 | `handleList` | 200–500px |
| 树形导航分隔条 | `handleTree` | 180–400px |
| 文件预览分隔条 | `handlePreview` | 280–600px |
| DSH 原生 details 分隔条 | `handleDetails` | DSH 原生 |

**不引入** `react-resizable-panels`——DragHandle 模式足够，且与 DSH 风格一致。

---

## 7. 数据流

### 7.1 编排态

```
用户在 overlay 右栏选「编排」模式
  │
  ├─ 左栏列表（编排 toggle）→ ctx.remote.sandore.listDefinitions()（全局数据）
  ├─ 点定义 → DagEditor → ctx.remote.sandore.getYaml(definitionId)
  │   → 解析为 Stage/Step 结构 → 渲染 React Flow DAG
  ├─ 拖拽/编辑节点 → 更新本地状态 → YAML 预览实时刷新
  ├─ 保存 → ctx.remote.sandore.updateYaml(definitionId, yaml)
  └─ 测试运行 → ctx.remote.sandore.createInstance(definitionId)
      → 自动切到执行态 → 新实例出现在左栏实例列表
```
### 7.2 执行态

```
用户在 overlay 右栏选「执行」模式（或从编排态点测试运行自动切换）
  │
  ├─ 左栏列表（实例 toggle）→ ctx.remote.sandore.listInstances()（全局数据）
  ├─ 点实例 → RunView 三栏加载
  │   ├─ 树形导航：ctx.remote.sandore.getInstanceState(instanceId)
  │   │   → 构建 Stage → Step → result/artifact 树
  │   ├─ 统一时间线：从 sandore/* session 事件自绘
  │   │   ├─ step-start → 新增 running step 卡片（开始内嵌实时消息）
  │   │   ├─ step-message → 追加到 running step 的消息流
  │   │   ├─ step-completed → step 变 done，body 切换为 returnPrompt + 查看详情
  │   │   ├─ step-failed → step 变 failed，body 显示错误信息
  │   │   └─ discussion-message → 插入 user 气泡
  │   ├─ 文件预览：ctx.remote.sandore.getArtifact(artifactId) / getStepResult(stepId)
  │   └─ 输入区域：ctx.remote.sandore.sendDiscussionMessage(payload)
  │       ├─ running → 暂停按钮 → ctx.remote.sandore.pauseInstance(instanceId)
  │       ├─ paused → 发送消息 → 宿主 Agent 接收 → 定点恢复/广播
  │       └─ failed → 发送消息 + retryMode → 重试失败步骤
  └─ 点 Step name → ctx.sessions.open(childId) 跳子代理会话
```
### 7.3 实时事件订阅

```ts
// 在 RunView 组件中
useEffect(() => {
  const unsubscribe = ctx.sessions.subscribe(instanceId, (event) => {
    if (event.type === 'sandore/step-start') {
      // 新增 running step 卡片
      setTimeline(prev => [...prev, { type: 'step', status: 'running', messages: [], ...event.payload }])
    } else if (event.type === 'sandore/step-message') {
      // 追加消息到 running step
      setTimeline(prev => updateStepMessages(prev, event.payload.stepId, event.payload.message))
    } else if (event.type === 'sandore/step-completed') {
      // step 变 done
      setTimeline(prev => updateStepStatus(prev, event.payload.stepId, 'done', event.payload.returnPrompt))
    } else if (event.type === 'sandore/step-failed') {
      // step 变 failed
      setTimeline(prev => updateStepStatus(prev, event.payload.stepId, 'failed', event.payload.errorDetail))
    } else if (event.type === 'sandore/discussion-message') {
      // 插入 user 气泡
      setTimeline(prev => [...prev, { type: 'user', content: event.payload.content, time: event.payload.time }])
    }
  })
  return unsubscribe
}, [instanceId])
```

---
## 8. 依赖清单

### 8.1 新增依赖（仅 sandore ui 包）

```json
// packages/sandore/ui/package.json → dependencies
{
  "dependencies": {
    "@xyflow/react": "^12.0.0",
    "@dagrejs/dagre": "^1.1.0"
  }
}
```

这两个包仅用于编排态的 DAG 可视化，打进 sandore ui 的 client bundle，不影响 DSH 核心包。

### 8.2 复用 DSH 依赖（已在 peerDependencies 中）

| DSH 包 | 用途 |
|--------|------|
| `@deepseek-ai/dsh-client-ui-primitives` | Button/Pill/Input/DisclosureRow/Modal/StateDot/CodeBlock/MarkdownText/MessageText/icons |
| `@deepseek-ai/dsh-client-ui-slots` | Slot 注册（`sidebar.footer.action`、`shell.overlay`） |
| `@deepseek-ai/dsh-client-ui-sidebar` | sidebar footer action slot 声明 |
| `@deepseek-ai/dsh-client-ui-conversation` | 消息渲染组件参考 |
| `@deepseek-ai/dsh-client-runtime` | `ctx.remote`/`ctx.sessions`/`ctx.slots` |
| `@deepseek-ai/dsh-client-locale` | `ctx.locale` i18n |
| `@deepseek-ai/dsh-sandore-workflow` | `ctx.remote.sandore` RPC |
| `react` | ^18.2.0 |
### 8.3 不引入的依赖

| 包 | 原因 |
|----|------|
| `react-resizable-panels` | DragHandle 模式（~40 行）足够，且与 DSH 风格一致 |
| `tailwindcss` | 用 DSH theme token（`--dsw-*` CSS 变量）+ CSS Modules |
| `lucide-react` | 用 ui-primitives icons + emoji（原型阶段） |

---

## 9. 样式方案

### 9.1 CSS 变量（复用 DSH theme token）

所有颜色/圆角/阴影使用 DSH 的 `--dsw-*` CSS 变量，自动支持深色模式：

```css
:root {
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-elevated: #fafafa;
  --dsw-alias-bg-sunken: #f4f4f5;
  --dsw-alias-bg-hover: #f4f4f5;
  --dsw-alias-bg-active: #ececee;
  --dsw-alias-border-l1: #e4e4e7;
  --dsw-alias-border-l2: #ececef;
  --dsw-alias-label-primary: #18181b;
  --dsw-alias-label-secondary: #52525b;
  --dsw-alias-label-caption: #a1a1aa;
  --dsw-alias-label-disabled: #d4d4d8;
  --dsw-alias-accent-primary: #4a7eff;
  --dsw-alias-accent-bg: rgba(74,126,255,0.08);
  --dsw-alias-state-success: #22c55e;
  --dsw-alias-state-error: #ef4444;
  --dsw-alias-state-warning: #f59e0b;
  --dsw-alias-state-info: #3b82f6;
  --dsw-radius-sm: 6px;
  --dsw-radius-md: 8px;
  --dsw-radius-lg: 12px;
  --dsw-font-mono: 'SF Mono','Cascadia Code','Consolas',monospace;
}
```
### 9.2 CSS Modules

sandore ui 包使用 CSS Modules（`.module.css`），不引入 Tailwind。所有类名前缀 `sandore-` 避免冲突。

### 9.3 关键样式

**统一时间线 step 卡片**（GitHub comment-card 风格）：

```css
.tl-step-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-elevated);
  overflow: hidden;
}
.tl-step-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.tl-step-body { padding: 8px 12px 8px 44px; }
```

**树形导航**（DSH DisclosureRow 风格）：

```css
.tree-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: var(--dsw-radius-sm);
  cursor: pointer; font-size: 12px;
}
.tree-row:hover { background: var(--dsw-alias-bg-hover); }
.tree-chevron { transition: transform 0.15s; }
.tree-node.collapsed > .tree-row .tree-chevron { transform: rotate(-90deg); }
.tree-dot.run { animation: pulse 1.5s infinite; }
```

**输入区域**（状态驱动）：
```css
.disc-pause-btn {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--dsw-alias-state-warning); color: #fff;
  box-shadow: 0 4px 12px rgba(245,158,11,0.3);
}
.disc-send-btn {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--dsw-alias-accent-primary); color: #fff;
  box-shadow: 0 4px 12px rgba(74,126,255,0.3);
}
```

---

## 10. 文件结构

```
packages/sandore/ui/src/client/
├── index.ts                    # Client 插件入口（注册 sidebar.footer.action）
├── WorkflowButton.tsx          # sidebar footer 按钮（打开 overlay）
├── WorkflowOverlay.tsx         # shell.overlay 浮层（双栏工作台）
├── WorkflowList.tsx            # 左栏列表（实例/定义 toggle + 搜索 + 新增）
├── DagEditor.tsx               # 编排态 DAG 编辑器（React Flow + Dagre）
├── RunView.tsx                 # 执行态三栏（树形导航 + 时间线 + 预览）
├── TreeNav.tsx                 # 左栏树形导航
├── UnifiedTimeline.tsx         # 中栏统一时间线
├── StepCard.tsx                # step 卡片（GitHub comment-card 风格）
├── StepMessage.tsx             # step 内嵌实时消息项
├── DiscussionInput.tsx        # 底部输入区域（状态驱动）
├── PreviewPanel.tsx            # 右栏文件预览
├── DragHandle.ts               # 拖拽分隔条（照搬 AppFrame 模式）
├── useInstanceState.ts         # 实例状态 hook（RPC + 事件订阅）
├── useTimeline.ts              # 时间线数据 hook（事件 → 时间线数组）
├── locale.ts                   # i18n 字典
└── styles/
    ├── overlay.module.css
    ├── list.module.css
    ├── dag.module.css
    ├── run-view.module.css
    ├── tree-nav.module.css
    ├── timeline.module.css
    └── input.module.css
```
## 13. 需调整的原设计决策

| 决策 | 原设计（design.md） | 最终方案 |
|---|---|---|
| **D6**（UI 入口） | sidebar.footer.action 按钮 + 展开 WorkflowPanel（窄 rail + 宽展开 layer） | sidebar.footer.action 按钮 → `shell.overlay` 浮层（全局独立，不挂会话） |
| **D8**（讨论面板） | `sandore-step` 节点在 `conversation.chat.node` 主对话消息流混排 | 执行态中栏统一时间线（从 `sandore/*` 事件自绘，不读 chat 视图） |
| **D9**（宿主 Session） | 引擎 `ctx.agents.create()` 创建独立宿主 Session | **保留原设计**——独立宿主 Agent（D9-改 不可行，`notifySettlement` 会唤醒主会话） |
| **DagEditor** | 简化列表式 DAG（ui-primitives 自绘） | React Flow + Dagre（引入 `@xyflow/react` + `@dagrejs/dagre`） |
| **RunView** | 双面板（左轨迹+讨论 / 右详情+进度轴+产物） | 三栏（左树形导航 + 中统一时间线+输入 / 右文件预览） |
| **执行轨迹 + 讨论** | 分离（左轨迹 + 右讨论） | **统一时间线**（step 卡片 + user 气泡交错，参考 workflow-lab-3） |

其余决策（D1 引擎 Service / D5 事件 / D7 风格一致性）不变。
