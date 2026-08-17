# Task 2 引擎最小可用 — 设计文档

> 版本: 1.0 | 基于: dsh-workflow.md v0.1.0 + dynamic-workflow-engine.md v2.6.0 | 最后更新: 2025-07-20

---

## 本文档范围

本文档从两份源设计文档（`dsh-workflow.md` 和 `dynamic-workflow-engine.md`）中提取与 **Task 2 引擎最小可用** 相关的全部内容，重新组织为一份自包含的设计文档。

**Task 2 定位**：实现引擎最小可用——类型体系 + YAML 解析（V1/V2 + Zod）+ 定义/Job/实例 CRUD + 存储域持久化（work.json 状态快照）+ **线性工作流执行**（StageExecutor + shell/prompt Step，无分支/循环/agent）。验证标准：能跑通一个「shell Step → prompt Step」的线性工作流到 completed。

**提取来源**：
- `dsh-workflow.md`：§5.2、§5.3、§5.4、§5.6、§7.2、附录 A、附录 B
- `dynamic-workflow-engine.md`：§3（全部）、§4.1、§4.3、§4.4、§4.5、§4.6、§5.1、§5.9、§6.0–§6.2、§8、§11、§15

**不在本文档范围内**（后续 Task 才涉及）：
- 分支/循环（BranchEvaluator、WorkflowLoopManager）
- 并发分支执行
- 暂停/恢复/重试
- 崩溃恢复（WorkflowRecoveryManager）
- 交互管理（WorkflowInteractionManager）
- 默认挂载会话（DefaultSessionManager）
- SSE 事件流（WorkflowSseManager、SdkSseManager）
- 前端 UI（Client 插件）

---

## 目录

1. [Task 2 做什么](#1-task-2-做什么)
2. [类型体系与数据模型](#2-类型体系与数据模型)
3. [YAML 解析](#3-yaml-解析)
4. [定义/Job/实例 CRUD + 持久化](#4-定义job实例-crud--持久化)
5. [线性工作流执行](#5-线性工作流执行)
6. [RPC 接口](#6-rpc-接口)
7. [验证标准](#7-验证标准)
8. [附录 A：关键 DSH API 参考](#附录-a关键-dsh-api-参考)
9. [附录 B：文件对照表](#附录-b文件对照表)

---

## 1. Task 2 做什么

### 1.1 目标拆解

Task 2 需要实现以下子模块：

| 子模块 | 说明 | 来源 |
|--------|------|------|
| **类型体系** | 全部 Zod Schema + TypeScript 类型（WorkflowDefinition/Stage/Step/状态等） | dynamic-workflow-engine §3 |
| **YAML 解析** | V1/V2 双格式 YAML → WorkflowDefinition + Zod 验证 | dynamic-workflow-engine §3.1 |
| **定义/Job/实例 CRUD** | 创建/读取/更新/删除工作流定义、Job、实例 | dsh-workflow §5.6, §7.2 |
| **存储域持久化** | work.json 状态快照 → DSH storageDomain（schema 验证 KV） | dsh-workflow §5.4 |
| **线性工作流执行** | StageExecutor + shell/prompt Step 执行器（无分支/循环/agent） | dynamic-workflow-engine §5.9, §6.0–§6.2 |

### 1.2 命名空间（决策 D1）

DSH 已占用 `ctx.workflowEngine`、`workflow/*` 事件、`tool-workflow` 工具名。新引擎使用独立命名空间：

| 概念 | DSH 中命名 |
|------|-----------|
| 引擎 Service | `ctx.sandoreEngine`（`SandoreEngine`） |
| 事件前缀 | `sandore/*` |
| 包名 | `@deepseek-ai/dsh-sandore-workflow` |

> 来源：dsh-workflow §2.3 决策 D1

### 1.3 硬约束：零外部 Agent SDK，全用 DSH 组件

> 来源：dsh-workflow §1.3

原 sandore 引擎的 `engine/internal/sdk/` 层封装了 `@codeagent/sdk`。移植到 DSH 时，**这层 SDK 封装整体删除**——所有 AI 会话、Shell 命令、文件读写、模型推理等能力，**全部改由 DSH 自身的 Cordis 服务实现**。

理由：
1. DSH 本身就是 agent harness，已具备 `ctx.agents`/`ctx.subagents`/`ctx.llm`/`ctx.shell`/`ctx.fs` 等完整能力
2. 权限/沙箱/审计统一在 DSH 内
3. 会话模型一致
4. 可维护性

---

## 2. 类型体系与数据模型

> 来源：dynamic-workflow-engine §3（全部）

### 2.1 定义层 — YAML 结构

工作流通过 YAML 定义，支持 **V1（三级：Stage→Scenario→Task）** 和 **V2（两级：Stage→Step）** 两种格式，解析器自动转换。

```
WorkflowDefinition
  ├── id, name, version, description
  ├── engine?, skills[], mcps[], agents[]   ← V2 扩展字段
  │     engine: string (引擎标识)
  │     skills: string[] (技能列表)
  │     mcps: string[] (MCP 工具列表)
  │     agents: string[] (Agent 列表)
  ├── settings: WorkflowSettings
  │     ├── defaultTimeout: number (分钟, 默认 120)
  │     └── maxConcurrentAgents: number (默认 4)    ← V2.5 新增
  ├── rules?: Record<string, string>        ← V2 扩展字段（键值对规则）
  ├── gates?                                ← V2 扩展字段（门控配置）
  │     ├── maxRetries?: number
  │     ├── maxTokens?: number
  │     ├── primary?: { enabled: boolean }
  │     ├── secondary?: { enabled: boolean, prompt?: string }
  │     └── need_confirm?: boolean
  ├── stages[]: WorkflowStage
  │     ├── id, name
  │     ├── rules?: string[]                ← V2.4 新增：Stage 级规则
  │     ├── gates?: GatesSchema             ← V2.4 新增：Stage 级门控
  │     ├── steps[]: WorkflowStep
  │     │     ├── id, name
  │     │     ├── command?: CommandConfig       ← V2 命令配置
  │     │     ├── inputFrom[]: InputFromItem
  │     │     ├── outputTo[]: OutputToItem
  │     │     ├── passThroughVars[]: PassThroughVar  ← { name, value, description, refresh? }
  │     │     ├── timeout: number
  │     │     ├── next: string
  │     │     ├── defaultExpectation?: string   ← V2 默认分支期望
  │     │     ├── condition?: CommandConfig     ← 分支条件
  │     │     ├── branches[]: DagBranch
  │     │     ├── loop: DagLoop
  │     │     ├── rules?: string[]              ← V2.4 新增：Step 级规则
  │     │     └── gates?: GatesSchema           ← V2.4 新增：Step 级门控
  │     ├── next, defaultExpectation?, condition?, branches[], loop (同上，Stage 级 DAG)
  └── steps[]?: WorkflowStep[]              ← V2 顶级 Step 定义（与 stages 交叉引用）
```

#### CommandConfig 五种类型（V2）

| 类型 | 字段 | 用途 |
|------|------|------|
| `agent` | `promptText` (Agent 名称) + `agentParamsTemplate?` + `providerId?` + `modelId?` | AI Agent + 自动参数填充 |
| `prompt` | `promptText` + `providerId?` + `modelId?` | 纯提示词模板 |
| `shell` | `command` | Shell 命令执行 |
| `skill` | `promptText` (Skill 名称) | 技能调用（promptText 存储技能名称） |
| `mcp` | `promptText` (MCP 名称) | MCP 工具调用（promptText 存储 MCP 名称） |

> **V2.4 变更**：`agent` 类型从 `agentTemplate` 改为 `promptText` 存储 Agent 名称。`skill`/`mcp` 类型使用 `promptText` 存储对应名称。Runner 根据 commandType 构建不同的 prompt 前缀（`使用 Agent：{name}` / `使用 skill：{name}` / `使用 MCP：{name}`），并校验名称是否在 workflow 级 `agents`/`skills`/`mcps` 数组中。

#### DagBranch

```typescript
{ expectation?: string; next: string; label?: string }
```

- `expectation`：分支期望值，AI 输出的 `branchExpectation` 与之匹配。**省略 `expectation` 表示并行分支**，该分支始终执行
- `next`：匹配后跳转的目标节点 ID

#### DagLoop

```typescript
{ breakCondition?: CommandConfig; breakExpectation?: string; next?: string; maxIterations: number; exitTo?: string }
```

- `breakCondition`：AI 评估是否跳出循环
- `next`：循环内跳转目标（优先级高于 `step.next` 和分支评估结果）
- `maxIterations`：最大迭代次数（硬上限）
- `exitTo`：跳出后跳转的目标节点 ID（V2.4.2: 改为可选，省略时由 `tryAdvanceStage()` 自然推进）

#### DEFAULT_SETTINGS

```typescript
const DEFAULT_SETTINGS: WorkflowSettings = {
  defaultTimeout: 120,
  maxConcurrentAgents: 4,
}
```

> **V2.5**: `maxConcurrentAgents`（默认 4）保留在 Settings 中但已**停用**，所有 Step 立即入队执行，不再有信号量限制。

### 2.2 运行时状态 — WorkflowTaskState

持久化到 `work.json` 的完整状态对象：

```
WorkflowTaskState
  ├── taskId (= instanceId), jobId, workflowId, cwd
  ├── status: 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'
  ├── originalInput: string (用户原始需求)
  ├── currentStageId: string
  ├── executedSteps[]: ExecutedStepDefault (扁平数组, V2.3移除ExecutedStepLoop)
  │     ├── { type:'default', id, stepId?, stageId, name, status, command?, inputFrom?,
  │     │     outputTo?, passThroughVars?, sessionMeta?, finalizeMeta?, visitCount, branchMeta?,
  │     │     error?, pausedAt?, resumedAt?, resumePrompt?, sessionMessages?, pauseEntryId?,
  │     │     loopIteration?: number[], loopMeta?: BranchMeta,
  │     │     retryHistory?: RetryRecord[], parentSessionId?: string }
  │     │     │     (V2.4: retryHistory 由引擎本体添加; stepId: 无后缀原始 Step ID)
  ├── stageInfos[]: StageInfo (全量 stage 列表, 含状态)
  ├── pendingInteractions[] (当前待处理的问答/权限)
  ├── pendingQueue[]: string (待执行节点 ID 队列)
  ├── visitCounts: Record<string, number> (仅含 loop 节点的访问计数)
  ├── passThroughVars: Record<string, {value, description}> (透传变量, .passthrough() 允许 refresh 字段)
  ├── permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default' (V2.3新增)
  ├── activeLoopIterationStack: number[] (V2.3新增, 嵌套循环迭代路径)
  ├── activeLoopNodeId: string | null (legacy, 兼容旧数据)
  ├── activeLoopStack[]: string (嵌套循环栈)
  ├── pausedChildIds[]: string (当前暂停的 Step 的子代理 SessionId 列表；Task 4 由原 pausedStepIds[] 改名，值=childId，见 task-4 §2.9)
  ├── userChatMessages[]: { id, stageId, message } (用户聊天消息, @stepId 路由)
  ├── stageContracts: Record<string, StageContract> (V2.6新增: 已完成Stage的产物契约)
  ├── defaultSessionMeta?: DefaultSessionMeta (V2.6新增: 默认挂载会话元数据)
  └── createdAt, updatedAt
```

**关键变化**：
- `executedScenarios[]` → `executedSteps[]`（扁平数组，无嵌套 tasks）
- **V2.3：`ExecutedStepLoop` 类型完全移除** — 循环迭代通过扁平 `ExecutedStepDefault[]` + `loopIteration: number[]` + `loopMeta: BranchMeta` 字段表示
- `visitCounts` 仅持久化含 `loop` 字段的节点（减少数据量）
- `activeLoopNodeId` 保留为 legacy 兼容，新逻辑使用 `activeLoopStack[]` + `activeLoopIterationStack[]`

### 2.3 辅助 Schema 与类型

#### StepSessionMeta — SDK 会话文件追踪

```typescript
StepSessionMeta {
  sessionId: string      // SDK 会话 ID
  inputJson: string      // {uuid}_input.json 文件名
  outputJson: string     // {uuid}_output.json 文件名
  partsJson: string      // {uuid}_parts.json 文件名
}
```

#### FinalizeMeta — 步骤收尾状态

```typescript
FinalizeMeta {
  status: 'evaluating' | 'completed'
  sessionId?: string     // 临时会话 ID
  directory?: string     // 临时会话目录
  errorDetail?: string   // 失败原因
}
```

#### BranchMeta — 分支/循环评估元数据

```typescript
BranchMeta {
  result?: string        // 评估输出
  sessionId?: string     // 评估会话 ID
  directory?: string     // 评估会话目录
  status: 'evaluating' | 'completed'
  expectation?: string   // 匹配的期望值
}
```

#### WorkflowMessages — 消息聚合结构

```typescript
WorkflowMessages {
  originalInput: string
  stages: Record<stageId, {
    input: any
    steps: Record<stepId, { input: any; output: any }>
    output: any
  }>
}
```

#### StepOutputEntry — 单步输出条目

```typescript
StepOutputEntry {
  stepId: string
  output: any
}
```

#### RetryRecord — 重试历史记录（V2.3 新增）

```typescript
RetryRecord {
  mode: 'continue' | 'revert' | 'fork'   // 重试模式
  timestamp: string                       // ISO 时间戳
  userMessage: string                     // 用户重试消息
  revertMessageId?: string               // revert 模式下的消息 ID
  result: 'running' | 'completed' | 'failed'  // 重试结果
}
```

#### StepExecutionMode — 步骤执行模式（V2.4 新增）

```typescript
type StepExecutionMode = 'normal' | 'retry' | 'recover' | 'resume';

StepExecutionOptions {
  mode: StepExecutionMode;
  retryMode?: 'continue' | 'revert' | 'fork';  // retry 模式参数
  retryUserMessage?: string;                   // retry 模式的用户消息
  revertMessageId?: string;                    // retry revert 模式的消息 ID
  recoverSessionId?: string;                   // recover 模式参数
  recoverResumePrompt?: string;                // recover 模式参数
}
```

#### Gates — 门控配置（V2.3 增强, V2.4: 3 级合并）

```typescript
Gates {
  maxRetries?: number
  maxTokens?: number
  primary?: { enabled: boolean }
  secondary?: { enabled: boolean, prompt?: string }  // V2.3: 新增 prompt 字段
  need_confirm?: boolean
}
```

> **V2.4 变更**：`Gates` 和 `rules` 字段可在 Workflow、Stage、Step 三个层级定义。引擎通过 `resolveStepGates(stepDef, stageDef)` 进行 3 级 field-level deep merge（step > stage > workflow）。

#### StageInfo — 阶段信息（V2.3 新增类型）

```typescript
StageInfo {
  id: string
  name: string
  status: 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
}
```

#### StepStatusEnum — Step 状态枚举

```typescript
type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
```

> `StageInfo.status`、`ExecutedStepDefault.status`、`ChatStepData.status` 共用 `StepStatusEnum`。

#### ChatState — 持久化到 `chat.json` 的增量消息列表（V2.5 新增）

```typescript
ChatStepData {
  name: string
  status: StepStatus
  returnPrompt: string
  sessionId: string
  stageId: string
  stageName: string
  loopIteration?: number[]
  finalizeMeta?: FinalizeMeta | null
  branchMeta?: BranchMeta | null
  loopMeta?: BranchMeta | null
  pausedAt?: string
  resumedAt?: string
  resumePrompt?: string
  sessionMessages?: { type: 'text'|'tool'|'reasoning'; text?; tool?; args?; output? }[]
}

ChatUserData {
  at: string
  domain: string
  content: string
}

ChatMessage {
  id: string              // stepId for step, usr-{uuid} for user
  type: 'step' | 'user'
  data: ChatStepData | ChatUserData
  createdAt: string
  updatedAt: string
}

ChatState {
  taskId, jobId, workflowId, cwd
  status: 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'
  originalInput: string
  messages: ChatMessage[]
  pendingInteractions: any[]
  createdAt, updatedAt
}
```

### 2.4 V2.6 新增类型

#### StageContract — Stage 产物契约（V2.6 新增）

Stage 作为独立可抽象节点时，对外暴露的产物契约。Stage 内部 Step DAG 执行完成后，由 `StageExecutor` 收集本 Stage 所有 outputTo 产物 + 解析后的透传变量，组装为 `StageContract`。

```typescript
StageContract {
  stageId: string
  stageName: string
  status: StepStatus                  // 复用 StepStatusEnum
  artifacts: Array<{                  // 本 Stage 所有 Step 的产物聚合
    stepId: string                    // 产出该产物的 Step ID（原始 ID）
    outputToId: string                // outputTo ID
    files: string[]                   // 产物文件绝对路径
    returnPrompt?: string             // Step 的 returnPrompt 摘要
  }>
  passThroughVars: Record<string, {   // 本 Stage finalize 提取的透传变量
    value: string
    description: string
    refresh?: boolean
  }>
  contractArtifacts: Record<string, string[]>  // 契约命名产物（供后续 Stage 引用）
  completedAt: string
  errorDetail?: string                // Stage 级失败原因
}
```

> **契约引用语法**：后续 Stage 的 `inputFrom` 可使用 `${stage.stg-xxx.artifact-name}` 引用前置 Stage 的契约产物。`resolveCrossStageInput()` 负责解析此路径。

#### FinalizeAssessResult — 收尾第 1 部分结果（V2.6 新增）

```typescript
FinalizeAssessResult {
  completionType: 'completed' | 'ask'     // 完成判定
  passThroughVars: Record<string, string>  // 提取的透传变量值（name → value）
  askQuestion?: AskUserQuestionPayload     // completionType='ask' 时存在
  errorDetail?: string                     // 评估失败原因
  forkSessionId: string                    // fork 会话 ID
  assessmentRaw: string                    // AI 原始输出
}

AskUserQuestionPayload {                   // 对齐 DSH harness ask_user_question 工具 schema
  questions: Array<{
    id: string                             // stable id，用于路由回复
    question: string                       // 具体问题
    header?: string                        // 可选短标题
    options?: Array<{
      label: string                        // 选项标签
      description?: string                 // 选项说明
    }>
    multi_select?: boolean                 // 是否允许多选，默认 false
  }>
}
```

#### GateEvalResult — 收尾第 2 部分结果（V2.6 新增）

```typescript
GateEvalResult {
  gatesPassed: boolean                    // 门禁是否通过
  primaryPassed: boolean                  // primary gate 结果
  secondaryPassed?: boolean               // secondary gate 结果（仅 enabled 时）
  gateDetails?: {
    primary: { enabled: boolean; passed: boolean }
    secondary: { enabled: boolean; passed: boolean; prompt?: string }
  }
  errorDetail?: string                    // 门禁失败原因
  gateSessionId: string                   // 门禁审查 session ID
  assessmentRaw: string                   // AI 原始输出
}
```

#### DefaultSessionMeta — 默认挂载会话元数据（V2.6 新增）

```typescript
DefaultSessionMeta {
  sessionId: string                       // SDK 会话 ID
  instanceId: string                      // 关联的实例 ID
  status: 'active' | 'idle' | 'closed'    // 会话状态
  mountedAt: string                       // 挂载时间（工作流完成后）
  lastActivityAt: string                  // 最后活动时间（用于空闲清理）
  messageCount: number                    // 组合注入的 chat.json 消息数
}
```

#### FinalizeMeta 变更（V2.6）

```typescript
FinalizeMeta {
  status: 'evaluating' | 'completed' | 'ask'
  sessionId?: string                      // fork 会话 ID（第 1 部分）
  gateSessionId?: string                  // 门禁会话 ID（第 2 部分，V2.6 新增）
  directory?: string
  errorDetail?: string
  // V2.6 新增字段
  completionType?: 'completed' | 'ask'    // 完成判定结果
  assessResult?: FinalizeAssessResult     // 第 1 部分完整结果
  gateResult?: GateEvalResult             // 第 2 部分完整结果
}
```

### 2.5 Step 状态机

```
                    ┌──────────┐
          ┌────────►│ blocked  │
          │         └────┬─────┘
          │              │ (入队)
          │         ┌────▼─────┐
          │         │  ready   │
          │         └────┬─────┘
          │              │ (开始执行)
          │         ┌────▼─────┐
          │    ┌───►│ running  │◄──────────┐
          │    │    └────┬─────┘            │
          │    │         │ (问答/权限)       │ (回复后)
          │    │    ┌────▼──────┐           │
          │    │    │interacting│───────────┘
          │    │    └───────────┘
          │    │         │
          │    │    ┌────▼─────┐
          │    │    │completed │
          │    │    └──────────┘
          │    │
          │    │    ┌──────────┐
          │    └───►│  failed  │
          │         └──────────┘
          │
          │    ┌──────────┐     ┌──────────┐
          ├───►│  paused  │◄───►│ running  │ (暂停/恢复)
          │    └──────────┘     └──────────┘
          │
          │    ┌──────────┐
          └───►│ aborted  │
               └──────────┘
```

`paused` 状态是 V2 新增的，Step 可在运行中被暂停（SDK session.abort），恢复后继续执行。

### 2.6 DagNodeRef — 统一节点视图

```typescript
interface DagNodeRef {
  kind: 'stage' | 'step';
  stage: WorkflowStage;       // 始终可用
  step?: WorkflowStep;        // 仅 kind='step'
  id: string;                 // nodeId
  name: string;
  next?: string;
  condition?: CommandConfig;
  branches?: DagBranch[];
  loop?: DagLoop;
}
```

**设计意图**：Stage 和 Step 在 DAG 调度层面没有本质区别——都有 `next`/`condition`/`branches`/`loop`。统一为 `DagNodeRef` 后，`resolveNextNodes()` 不需要区分节点类型，简化了调度逻辑。

---

## 3. YAML 解析

> 来源：dynamic-workflow-engine §3.1（类型转换函数部分）

### 3.1 V1/V2 双格式解析

工作流通过 YAML 定义，支持 V1（三级：Stage→Scenario→Task）和 V2（两级：Stage→Step）两种格式。解析器自动检测格式并转换。

**类型转换函数**：

```typescript
commandToPromptType(cmd: CommandConfig): PromptConfig
  // prompt → PromptTemplate, shell → Bash, agent → AgentTemplate,
  // skill → SkillTemplate, mcp → McpTemplate, 其他 → PromptTemplate

promptToCommandType(prompt: PromptConfig): CommandConfig
  // PromptTemplate → prompt, Bash → shell, AgentTemplate → agent,
  // SkillTemplate → skill, McpTemplate → mcp, 其他 → prompt
```

### 3.2 Zod Schema 验证

所有类型定义使用 Zod Schema 进行运行时验证。YAML 解析后通过 Zod schema 校验，确保数据结构正确。

> 补充：在 DSH 插件化方案中，YAML 解析逻辑保留不变，解析后的 `WorkflowDefinition` 直接用于引擎初始化。

---

## 4. 定义/Job/实例 CRUD + 持久化

### 4.1 持久化映射（决策 D4）

> 来源：dsh-workflow §5.4

| sandore 持久化 | DSH 映射 | 说明 |
|---|---|---|
| SQLite `harness_workflows` 表 + YAML 定义文件 | **存储域 `definitions` 表** | key = `workflowId`，value = `WorkflowDefinitionRecord`（YAML 文本 + 元数据），`entries()` 列全部定义 |
| SQLite `harness_workflow_jobs` 表 + jobs.json 实例索引 | **存储域 `jobs` 表**（实例清单从 `state` 表派生） | key = `jobId`，value = `JobRecord`，`entries()` 列全部 Job |
| `work.json`（完整引擎状态） | **存储域 `state` 表**：`ctx.storageDomain.open(sandoreDomainSpec)` | 用 schema 验证的 KV 存储，key = `{instanceId}`，value = 引擎状态快照（Zod 校验），崩溃恢复时整体读出 |
| `chat.json`（增量讨论） | **DSH Session 事件日志**（`ctx.sessions` + `ctx.sessionPersistence`） | 每个 instance 对应一个「工作流宿主 Session」，Step 消息/用户消息以 `session.append('sandore/…', data)` 写入宿主 log（**Session 事件，非 ctx.emit 纯 Cordis 事件**），由 `sessionPersistence` 持久化 |
| `{uuid}_input/output/parts.json` | 实例目录文件（`ctx.fs` 写入） | 保留文件式产物/输入/输出，便于产物面板读取 |

> **决策 D4**：`work.json` 用 `storageDomain` 的 `state` 表，`chat.json` 用 Session 事件日志；SQLite 两张表 + YAML 定义文件 + jobs.json 实例索引一并迁入 `definitions`/`jobs` 表。
> - 统一 `ctx.storageDomain.open(spec)` 定义一个 `sandore` 域（`tables: { definitions, jobs, state }` 三表，Zod 校验），替代 v2.6 的「SQLite 两张表 + YAML 定义文件 + jobs.json + 实例目录 work.json」四层分散存储；`Database` 单例（`node:sqlite`）/`Workflow Mapper`/`Logger`（winston）删除。
> - `work.json`（引擎运行时状态：executedSteps/pendingQueue/passThroughVars/…）写入 `state` 表（key = instanceId），崩溃恢复时按 instanceId 读出。
> - `chat.json`（讨论消息流）用 DSH Session 事件日志重构。

### 4.2 存储位置（原始）

```
~/.harness/data/
  ├── harness.sqlite3.db            # SQLite 数据库 (DatabaseSync, WAL 模式)
  │     ├── harness_workflows       # Workflow 定义元数据
  │     └── harness_workflow_jobs   # Job 元数据
  └── workflows/
        ├── defines/{id}.yaml       # YAML 定义文件
        └── jobs/{jobId}/{instanceId}/
              ├── work.json         # 完整运行时状态
              ├── chat.json         # 增量讨论数据
              ├── {uuid}_input.json # Step 输入
              ├── {uuid}_parts.json # Step parts (发送给模型的)
              └── {uuid}_output.json# Step 输出 + 产物
```

### 4.3 双文件持久化

> 来源：dynamic-workflow-engine §11

引擎维护两个持久化文件：

| 文件 | 内容 | 写入模式 |
|------|------|---------|
| `work.json` | 完整引擎状态 (WorkflowTaskState) | 全量覆盖 |
| `chat.json` | 增量讨论数据 (ChatState) | 追加式 |

`persistState()` 同时调用 `saveWorkflowState()` 和 `syncChatState()`。

**持久化时机**：引擎在以下关键时刻调用 `persistState()`：
- 节点入队/出队
- Step 状态变化 (running/completed/failed/interacting/paused/resumed)
- 问答/权限事件
- 分支评估状态变化 (evaluating/completed)
- 循环迁移/跳出
- 透传变量更新
- finalize 状态变化
- 暂停/恢复操作

### 4.4 Workflow 定义 CRUD API

> 来源：dynamic-workflow-engine §19.6

| 函数 | 签名 | 说明 |
|------|------|------|
| `createWorkflowDef` | `(data: CreateWorkflowDefInput) → WorkflowRecord` | 创建定义 + DB + 初始 YAML |
| `listWorkflowDefs` | `() → WorkflowRecord[]` | 列出所有定义 |
| `getWorkflowDef` | `(id: string) → WorkflowRecord & { yaml: string }` | 获取定义 + YAML 内容 |
| `updateWorkflowDef` | `(id, data: UpdateWorkflowDefInput) → WorkflowRecord` | 更新定义元数据 |
| `deleteWorkflowDef` | `(id: string) → void` | 删除 DB + YAML |
| `getWorkflowYaml` | `(id: string) → string` | 读取 YAML 内容 |
| `updateWorkflowYaml` | `(id: string, yaml: string) → void` | 写入 YAML + 更新 timestamp |
| `importWorkflowFromYaml` | `(yamlAbsPath: string) → { id, name, action }` | 从 YAML 文件导入定义（V1 自动转换） |

输入校验：`CreateWorkflowDefSchema` / `UpdateWorkflowDefSchema` (Zod)。

### 4.5 Job CRUD API

> 来源：dynamic-workflow-engine §19.6

| 函数 | 签名 | 说明 |
|------|------|------|
| `createJobDef` | `(data: CreateJobInput) → JobRecord` | 创建 Job，自动生成 UUID，校验 workflowId 存在 |
| `listJobDefs` | `(workflowId?: string) → JobRecord[]` | 列出 Job，可选按 workflowId 过滤 |
| `getJobDef` | `(id: string) → JobRecord` | 获取单个 Job |
| `updateJobDef` | `(id, data: UpdateJobInput) → JobRecord` | 更新 Job |
| `deleteJobDef` | `(id: string) → void` | 删除 Job |

输入校验：`CreateJobSchema` / `UpdateJobSchema` (Zod)。

### 4.6 实例生命周期 API

> 来源：dynamic-workflow-engine §19.6

```typescript
listInstances(jobId: string)  // 列出实例，从活跃引擎或 work.json 丰富状态
startInstance(jobId: string, data: CreateInstanceInput)  // data: { originalInput, cwd?, stagePath?, permissionMode? }
deleteInstance(jobId: string, instanceId: string): void  // 删除 jobs.json 条目 + 实例目录
getInstanceState(jobId: string, instanceId: string): WorkflowTaskState  // 三层回退
abortInstance(jobId: string, instanceId: string): { instanceId, status }  // 验证非终态 → engine.abort()
```

输入校验：`CreateInstanceSchema` (Zod)，定义 `originalInput`(必填)、`cwd`、`stagePath`、`permissionMode` 字段。

**startInstance 流程**：

1. 生成时间戳实例 ID：`YYYYMMDD-HHmmss-xxx`
2. 创建实例目录 + `addJobInstance()` 写入 jobs.json
3. 读取并解析 Workflow YAML → `WorkflowDefinition`
4. 创建 `WorkflowEngineV2(definition, originalInput, { jobId, instanceId, cwd, permissionMode })`
5. `workflowManager.register()` 注册
6. 连接终态事件 → `scheduleCleanup`
7. `engine.execute()` (异步，fire-and-forget)
8. 返回实例元数据 + 初始引擎状态

**getInstanceState 三层回退**：

1. `workflowManager` 内存活跃引擎 → `engine.getState()`
2. `WorkflowEngineV2.loadState()` 从 work.json
3. Legacy: 直接读 work.json / 平面 JSON

### 4.7 产物查询 API

> 来源：dynamic-workflow-engine §19.6

```typescript
getInstanceArtifacts(jobId, instanceId, stageId?): InstanceArtifactsData
```

- 从活跃引擎或持久化状态加载
- 遍历扁平 `executedSteps` 数组构建产物条目
- 读取 `sessionMeta.outputJson` 指定的文件获取 `returnPrompt` + `artifacts`

---

## 5. 线性工作流执行

### 5.1 引擎核心移植映射

> 来源：dsh-workflow §5.2

`sandore` 引擎核心（`WorkflowEngineV2` + 9 个子管理器）整体移植为 `workflow`，但**底层依赖全部替换**：

| sandore 引擎模块 | DSH 移植要点 |
|---|---|
| `WorkflowEngineV2`（Stage 级编排 + 委托层） | 保留逻辑；`execute()` 改为 Stage 级编排（调用 `StageExecutor`）；完成后宿主 Session 自然降级为自由对话（**不再需要 DefaultSessionManager 额外挂载**，见 §5.1A/D9） |
| `StageExecutor`（Stage 内部执行） | 直接复用，输入改为 `StageExecutionInput`（含 `contractArtifacts` + `passThroughVars`） |
| `WorkflowStepRunner`（Step 执行） | **重点改造**：Agent 会话改用 `ctx.subagents.startContinuable()`；Shell 改用 `ctx.shell.run()`/`ctx.subprocess.spawn()`；产物收集改用 `ctx.fs` |
| `BranchEvaluator`（分支/循环评估） | 临时 AI 会话改用 `ctx.llm.stream()` 或轻量子 agent |
| `WorkflowFinalizeManager`（FinalizeAssessor + GateEvaluator） | fork 会话改用 `ctx.sessions.create({ seed })` 或子 agent fork；门禁 session 用临时 agent |
| `WorkflowDagNavigator`（DAG 导航 + StageContract） | 保留逻辑，`resolveCrossStageInput()` 保留 |
| `WorkflowLoopManager` / `WorkflowRecoveryManager` / `WorkflowSseManager` / `WorkflowInteractionManager` / `WorkflowLifecycleManager` | 保留逻辑；SSE/事件改为 DSH 事件系统；交互改为 DSH 交互服务 |
| `StatePersistence`（work.json + chat.json） | **重点改造**：改为 DSH 存储域（见 §4.1） |

### 5.1A 事件发射约定（D5：`ctx.emit` + `session.append` 双发）

> 来源：dsh-workflow §5.5。`sandore/*` 有**双重角色**，引擎在每次状态变化时**双发**：

| 通道 | 载荷 | 用途 |
|---|---|---|
| `ctx.emit('sandore/…', info, …)` | `(info: DagRunInfo, stepId, childId, …)`（observe-only emit + 数据快照，首参 `DagRunInfo`） | Cordis 进程内事件——引擎内部模块 `ctx.on('sandore/…')` 监听（为 Task 4 interaction/lifecycle/recovery 铺路） |
| `hostSession.append('sandore/…', payload)` | `{ stepId, childId, … }`（扁平可序列化对象） | Session 事件——写宿主 Session log，驱动前端 `ConversationNodeDefinition` 折叠（D8 讨论面板）+ apiproxy `session/event` 帧透传 |

**关键**：
- `session.append` 是**必需**（D8 讨论面板折叠 + apiproxy 透传的前提，不能只有 `ctx.emit`）
- `ctx.emit` 是 D5 的「引擎内部触发源」，对齐 DSH `tool-workflow` 范式（`ctx.on('workflow/*')` 触发源 + `session.append('tool-workflow/*')` 写 log）；Task 2 虽暂无内部消费者，但**从第一天建立正确范式**，Task 4 交互/生命周期模块直接 `ctx.on('sandore/…')` 复用
- 统一封装 `emitSandoreEvent(type, info, payload)` 辅助函数：`ctx.emit` 传 `(info, …)` 多参数，`session.append` 传扁平可序列化对象，避免每个发射点手写两遍

**childId 占位（Task 2 shell/prompt 无子代理）**：
- Task 2 的 shell（`ctx.shell.run`）/ prompt（`ctx.llm.stream`）均无子代理 Session，但 `step-start`/`step-completed`/`step-failed` 的 `childId` 是必填 string
- **占位规则**：`childId = step-{stepId}-{execId}`（`execId` = 本次执行的唯一短 id，如 `randomUUID().slice(0, 8)`），并写入 `executedSteps[].sessionMeta = { childId, synthetic: true, command: 'shell' | 'prompt' }`
- **`synthetic: true` 标记**：让 Task 5 前端 renderer 区分「占位 childId」vs「真实子代理 SessionId」——`synthetic=true` 时点击 `sandore-step` 节点**不跳转**（无子对话页，避免 `ctx.sessions.open(占位id)` 报错），仅内联展示结果
- **Task 3 迁移**：agent 类型用 `ctx.subagents.startContinuable()` 的真实 SessionId，`synthetic: false`；shell/prompt 保持合成占位

**step-* 事件补 `name`/`loopIteration`（D8 折叠态需要）**：
- `name`：step 定义的 `name`（引擎执行 Step 时闭包内有 step 定义，零成本取出）
- `loopIteration`：`loopManager.buildLoopIterationPath()`（Task 3 已实现，返回 `number[]` 或 `undefined`）
- 所有 6 个 `step-*` 事件（start/completed/failed/paused/resumed/retried）都携带 `name`（必填）+ `loopIteration?`（可选），前端 `ConversationNodeDefinition` 折叠时直接取，无需 RPC 补偿

### 5.2 Step 执行器映射（关键）

> 来源：dsh-workflow §5.3

sandore 的五种 Command 类型映射到 DSH 服务：

| Command 类型 | sandore 实现 | DSH 实现 |
|---|---|---|
| `agent`（AI Agent + 参数模板） | `@codeagent/sdk` createSession + sendChat + SSE | `ctx.agents.create({ sessionId, ... })` 创建子 agent，`send()` 发送提示词，事件经 DSH 事件系统 |
| `prompt`（纯提示词） | 同上 | `ctx.llm.stream()` 或 `ctx.agents.create()` |
| `skill`（技能调用） | SDK 技能名 | DSH `ctx.skill`（技能注册表）或保持为 prompt 前缀 |
| `mcp`（MCP 工具调用） | SDK MCP 名 | DSH `ctx.mcp`（如有）或保持为 prompt 前缀 |
| `shell`（简单命令） | `child_process.exec` | `ctx.shell.resolve()` + `ctx.shell.run()`（`bash -c`，返回 stdout/stderr 文本） |
| `shell`（需 stdin 注入/流式/终端，v2.4.2 特性） | `child_process.exec` + stdin 写入 | `ctx.subprocess.spawn()`（底层进程，支持原始 stdio/进程树/终端会话） |

> **shell Step 的 stdin 注入**：v2.4.2 的 `resolveRawInputOutputs()` 将 `inputFrom` 解析的 Step 输出 JSON 数组写入子进程 stdin。DSH 中 `ctx.shell.run()` 是高层 `bash -c`（无 stdin 注入），需改用 `ctx.subprocess.spawn()`（提供原始 stdio 流）。简单命令用 `ctx.shell.run()`，需 stdin 交互/流式输出/终端会话用 `ctx.subprocess.spawn()`。
>
> **shell Step 的沙箱**：DSH 的 shell 执行受沙箱约束（`ctx.sandbox`，`SandboxMode = 'read-only'|'workspace-write'|'danger-full-access'`；`ctx.shell.get sandboxMode()`）。工作流 Step 的 shell 命令默认走当前组合的沙箱模式，产物写入需 `workspace-write` 及以上。这与 sandore 引擎的 `permissionMode` 是正交的两个维度：`permissionMode` 控制 AI Agent 的权限自动回复，`sandboxMode` 控制 shell/fs 的系统级限制。

#### Task 2 简化：仅实现 shell + prompt

Task 2 的验证标准是「shell Step → prompt Step」线性工作流到 completed，因此：
- **shell**：实现 `ctx.shell.run()` 调用
- **prompt**：实现 `ctx.llm.stream()` 调用
- agent/skill/mcp 暂不实现

#### Step 会话的生命周期（对齐 DSH 可续接子代理模型）

```
Step 开始（agent/prompt/skill/mcp 类型）
    │
    ▼
const started = await ctx.subagents.startContinuable({ ... })  // 创建可续接子代理，返回 { childId, messageId }
    │  （parent = 工作流宿主 agent，origin: 'subagent'；首条提示词随 request.prompt 投递，resolve 在 inbox 接受时）
    ▼
const child = ctx.agents.get(started.childId)                  // hold 住 live Agent 引用
    │
    ▼
await child.whenIdle()                                          // ★ 等待当前轮完成（权威 per-turn 原语，见下）
    │
    ▼
读取输出：finalAssistantOutput(child.session.events)            // 从子代理 Session 事件读最后一条非空 assistant
    │  （等价原 readOutput；child 引用先 hold 住，因为叶子子代理 settle 后会被 dispose）
    │
    ▼ 暂停 / 恢复 / 重试
ctx.subagents.interrupt(childId, {kind:'ancestor', agent:hostAgent})  // 暂停（等价原 session.abort + 保留会话）
ctx.subagents.followup(hostAgent, childId, content, {source,signal})  // 恢复 / 重试 continue
ctx.sessions.fork(childId, turn边界) + ctx.agents.create({seed})      // 重试 revert/fork（产生新 session id）
```

> **决策 D3（含「等待轮完成」机制，经探索确认）**：Step 的「AI 会话」用 `ctx.subagents.startContinuable()` 创建可续接子代理。**等待轮完成用 `child.whenIdle()`**——这是 DSH 权威的 per-turn 等待原语（one-shot driver 内部 `child.followup(); await child.whenIdle(); readResult()` 同源；ACP bridge 也用它等宿主会话一轮）。
>
> **关键坑位（引擎实现必须遵守）**：
> 1. **「先 followup 再 whenIdle」**：`whenIdle()` 不标识具体轮，idle 也可能是「还没开始」；顺序必须是 startContinuable/followup 之后才 await。
> 2. **hold 住 child 引用**：叶子子代理（一步一子代理）在唯一轮结束后会 settle 并被 dispose，`whenIdle()` 返回时 `ctx.agents.get(childId)` 可能已 undefined——要先 `const child = ctx.agents.get(childId)` 拿引用，再读 `child.session.events`。
> 3. **turn 结束 ≠ Activation settle**：`subagent/end` 事件在 settle（销毁）时发（载荷 `{stopReason, lastAssistantMessage}`），不是每轮。叶子子代理唯一轮结束即 settle，所以「一步一子代理」场景下二者巧合等价；但**复用 childId 多轮时必须用 `turn/end` 关联**（ACP bridge 的 `agent/inbox/claimed` + `turn/end` 匹配模式）。
> 4. **settlement notice 副作用**：子代理 settle 时会 `parent.followup` 唤醒主代理（消耗 token），引擎需处理这个副作用（不要让主代理因工作流内部 Step 完成而被反复唤醒）。
>
> 而**分支评估 / finalize 的临时 AI 会话**（一次性、只读、红线约束）用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`（其 `SubagentRun.result` 是 Promise 可直接 await），避免为临时评估创建长期会话。

### 5.3 StageExecutor — Stage 内部独立执行器（V2.6）

> 来源：dynamic-workflow-engine §5.9

**职责**：Stage 内部 Step DAG 的独立执行器。将 Stage 内部执行逻辑从 `WorkflowEngineV2` 中解耦，使 Stage 可以作为独立可抽象的执行节点。

**接口定义**：

```typescript
interface StageExecutorOptions {
  stageDef: WorkflowStage              // Stage 定义（含 steps[] 流控 + 顶层 steps[] 定义交叉引用）
  workflowDef: WorkflowDefinition      // 完整工作流定义（用于解析 rules/gates 3 级合并）
  input: StageExecutionInput           // Stage 入参
  sharedState: StageSharedState        // 共享状态（透传变量、已执行步骤等）
  engine: WorkflowEngineV2             // 引擎引用（用于 SSE/InteractionManager/FinalizeManager 等共享子管理器）
}

interface StageExecutionInput {
  originalInput: string                // 用户原始需求
  contractArtifacts: Record<string, string[]>  // 前置 Stage 的产物契约
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  userChatMessages?: Array<{ id: string; stageId: string; message: string }>
  entryStepId?: string                 // 指定起始 Step（V3 微流程部分执行用，V2.6 默认第一个 Step）
}

interface StageSharedState {
  cwd: string
  instanceDir: string
  jobId: string
  taskId: string
  // permissionMode: PermissionMode  ← 迁移后废弃：权限由宿主 Session 的 permission preset 决定（Step 子代理继承父级）
}

interface StageExecutionResult {
  stageContract: StageContract         // Stage 产物契约
  executedSteps: ExecutedStepDefault[] // 本 Stage 执行的步骤（扁平）
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  status: StepStatus                   // Stage 整体状态
  errorDetail?: string
}
```

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `(options: StageExecutorOptions)` | 初始化 Stage 执行器 |
| `execute` | `async (): Promise<StageExecutionResult>` | 主入口：执行 Stage 内部 Step DAG，返回 StageContract + 执行结果 |
| `buildStageNodeIndex` | `(stageDef, workflowDef): Map<string, DagNodeRef>` | 构建本 Stage 内部的 nodeIndex（仅本 Stage 的 Step） |
| `processStageNode` | `async (nodeId: string): Promise<void>` | 处理 Stage 内部节点（委托引擎 `executeStepNode`） |
| `resolveStageNextNodes` | `async (node: DagNodeRef): Promise<void>` | Stage 内部下一节点解析（Loop→Branch→Next，仅同 Stage） |
| `isStageComplete` | `(): boolean` | 检查 Stage 内所有 Step 是否完成 |
| `finalizeStageContract` | `(): StageContract` | 收集 Stage 产物 + 透传变量，组装 StageContract |
| `resolveCrossStageInput` | `(path: string): any` | 解析 `${stage.stg-xxx.artifact-name}` 契约引用 |

**执行流程**：

```
StageExecutor.execute():

  1. buildStageNodeIndex(stageDef, workflowDef)
     → 构建本 Stage 内部 nodeIndex（仅 Step 节点）

  2. 入队起始 Step（input.entryStepId 或 Stage 第一个 Step）

  3. Stage 内部执行循环（类似 V2.5 runExecutionLoop，但仅限本 Stage）:
     a. 启动 pendingQueue 中的节点
     b. processStageNode(nodeId)
        ├── consumeNodeExecutionOptions
        ├── engine.executeStepNode(node, options)  // 复用引擎的 Step 执行编排
        │     └── runPostStepPipeline()             // 复用引擎的后处理（含 V2.6 拆分的 finalize）
        └── resolveStageNextNodes(node)             // 仅入队同 Stage 节点
     c. Promise.race 等待完成
     d. persistState()
     e. 队列空 + 无运行中 → 退出循环

  4. isStageComplete() → true

  5. finalizeStageContract()
     ├── 遍历本 Stage 的 executedSteps
     ├── 聚合 outputTo 产物 → contractArtifacts
     ├── 收集 finalize 提取的透传变量
     └── 组装 StageContract

  6. 返回 StageExecutionResult
```

> **与 V2.5 的关键差异**：
> - V2.6 的 `StageExecutor` 将 Stage 内部执行封装为独立单元，`WorkflowEngineV2` 只负责 Stage 间编排
> - `StageExecutor` 复用引擎的 `executeStepNode` / `runPostStepPipeline` / SSE / InteractionManager / FinalizeManager 等共享子管理器
> - V3 的 `MicroflowEngine` 可直接实例化 `StageExecutor` 执行微流程

### 5.4 WorkflowDagNavigator — DAG 导航

> 来源：dynamic-workflow-engine §5.1

**职责**：DAG 结构导航、节点执行、分支评估、阶段推进。V2.6 新增 Stage 抽象节点编排 + 产物契约解析。

**字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeIndex` | `Map<string, DagNodeRef>` | nodeId → 统一节点视图 |
| `pendingQueue` | `string[]` | 待执行节点 ID 队列 |
| `visitCounts` | `Map<string, number>` | 节点访问计数 |
| `currentStageId` | `string` | 当前 Stage ID |
| `nodeExecutionOptions` | `Map<string, StepExecutionOptions>` | 节点执行选项（内存 only，不持久化） |
| `stageContracts` | `Map<string, StageContract>` | V2.6 新增：stageId → 已完成 Stage 的产物契约 |
| `stageExecutorRef` | `StageExecutor \| null` | V2.6 新增：StageExecutor 引用 |

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `buildNodeIndex` | `(definition: WorkflowDefinition): void` | 遍历所有 Stage/Step 构建 nodeIndex |
| `processNode` | `async (nodeId: string): Promise<void>` | 处理节点：consumeNodeExecutionOptions → executeStepNode → resolveNextNodes |
| `resolveNextNodes` | `async (node: DagNodeRef): Promise<void>` | 核心调度：Loop→Branch→Next→无 |
| `enqueueNode` | `(nodeId: string, options?: StepExecutionOptions): void` | 入队节点（去重） |
| `consumeNodeExecutionOptions` | `(nodeId: string): StepExecutionOptions` | 取出并删除节点执行选项 |
| `enqueueStage` | `(stageId: string): void` | 入队 Stage 第一个 Step |
| `enqueueTargetNode` | `async (targetId: string): Promise<void>` | 智能入队：Stage→评估分支，Step→直接入队 |
| `evaluateBranches` | `async (node: DagNodeRef): Promise<string[]>` | 分支评估（Task 2 不实现） |
| `isStageAllDone` | `(stageId: string): boolean` | 检查 Stage 是否全部完成 |
| `tryAdvanceStage` | `async (): Promise<boolean>` | Stage 完成后推进到下一 Stage |
| `finalizeStageContract` | `(stageId: string): StageContract` | V2.6 新增：收集 Stage 产物 + 透传变量，组装 StageContract |
| `resolveCrossStageInput` | `(path: string): any` | V2.6 新增：解析产物契约引用路径 |
| `getStageContract` | `(stageId: string): StageContract \| undefined` | V2.6 新增：获取已完成 Stage 的产物契约 |
| `enqueueNextUnexecutedStep` | `(): string \| null` | 崩溃恢复：跟随 DAG next 指针入队 |
| `getRecentStepInput` | `(): string` | 读取所有 Step 的 parts.json |

#### resolveNextNodes 优先级（Task 2 简化：仅 Next）

完整优先级：
1. Loop（最高）
2. Branches
3. Next
4. 无 → 由 `tryAdvanceStage()` 处理

**Task 2 简化**：不实现 Loop 和 Branch，仅处理 Next 字段和无 next 情况。

#### tryAdvanceStage 流程（V2.6 增强）

```
1. isStageAllDone(currentStageId) → false 则返回 false
2. V2.6: finalizeStageContract(currentStageId) → 生成 StageContract，存入 stageContracts
3. V2.6: 发射 workflow.stage_contract_created 事件
4. 评估 Stage 级 condition + branches（Task 2 简化：仅跟 Stage.next）
5. 跟随 Stage.next 或推断下一 Stage
6. 入队下一 Stage 的第一个 Step → 返回 true
```

> **Stage 抽象节点的串行保证**：Stage 内部所有 Step 执行完成后，`isStageAllDone()` 返回 true，才触发 `tryAdvanceStage()`。

### 5.5 Step 执行器 — WorkflowStepRunner

> 来源：dynamic-workflow-engine §6.0–§6.2

`WorkflowStepRunner` 是单个 Step 的执行单元，约 1106 行代码，继承 `EventEmitter`，支持五种执行模式。

#### 6.0 构造函数与字段

```typescript
constructor(
  definition: WorkflowStepDef,
  directory: string,
  defaultTimeoutMs?: number,       // 默认 120 分钟
  instanceDir?: string,            // 默认 = directory
  sessionIdleWaiter?: SessionIdleWaiter,  // 引擎共享 SSE idle 等待器
  getPermissionMode?: () => PermissionMode,
  workflowArrays?: { skills?: string[]; mcps?: string[]; agents?: string[] }
)
```

**私有字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `definition` | `WorkflowStepDef` | Step 定义 |
| `directory` | `string` | 工作目录 |
| `instanceDir` | `string` | 实例目录 |
| `_status` | `WorkflowStepStatus` | pending/running/interacting/completed/failed/aborted/paused |
| `_sessionId` | `string \| undefined` | SDK 会话 ID |
| `_stepMessageId` | `string \| undefined` | 消息 UUID（用于文件命名） |
| `_stepInputMessages` | `Array<{type:'text', text:string}>` | 构建的输入消息 |
| `_childProcess` | `ReturnType<typeof exec> \| undefined` | Shell 子进程引用 |
| `aborted` | `boolean` | 中止标志 |
| `_paused` | `boolean` | 暂停标志 |
| `_resumePromise` | `Promise<void> \| null` | 恢复等待 Promise |
| `_resumeResolve` | `(() => void) \| null` | 恢复 Promise resolve |
| `defaultTimeoutMs` | `number` | 默认超时 |
| `_sessionIdleWaiter` | `SessionIdleWaiter \| undefined` | 共享 SSE idle 等待器 |
| `_getPermissionMode` | `() => PermissionMode` | 动态权限模式 getter |
| `stepId` | `string` | 原始 Step ID |
| `_jobRequirement` | `string` | Job 原始需求 |
| `_predecessorSteps` | `Array<...>` | 前置步骤信息 |
| `_otherValues` | `string[]` | 其他输入值 |
| `_userSupplementMessages` | `string[]` | 用户补充消息 |
| `_workflowSkills/Mcps/Agents` | `string[]` | 工作流级技能/MCP/Agent |
| `_resolvedRules` | `Record<string, string>` | 合并后的规则键值映射 |

**公有属性**：

| 属性 | 类型 | 说明 |
|------|------|------|
| `skipCollectOutput` | `boolean` | V2 引擎设为 true，跳过 Runner 内部的产物收集 |
| `actualStepId` | `string` | 带后缀的实际 Step ID |
| `stepId` | `string` | 原始 Step ID |
| `loopIteration` | `number` | 当前循环迭代序号（1-based），0 表示不在循环中 |
| `loopMaxIterations` | `number` | 最内层活跃循环的最大迭代数，0 表示不在循环中 |

#### 6.0a 公有方法清单

```typescript
// 基础查询
getStepId(): string
getStatus(): WorkflowStepStatus
getSessionId(): string | undefined
getStepMessageId(): string | undefined
isPaused(): boolean

// 执行
async start(): Promise<{output, outputFileName?}>  // 启动 Step（自动选择 Shell/Agent 模式）
abort(): void

// 暂停/恢复
pause(): void
async resume(resumePrompt?): Promise<void>

// 崩溃恢复
initPausedState(sessionId): Promise<void>
async recoverFromSession(sessionId, resumePrompt?): Promise<void>
async waitForResumeAndComplete(): Promise<void>

// 输出收集
async collectOutput(): Promise<{ output: any; outputFileName?: string }>

// 重试初始化
initForRetry(sessionId): void

// 交互回复
async replyQuestion(requestId, answers: string[][]): Promise<void>
async rejectQuestion(requestId): Promise<void>
async replyPermission(requestId, reply: 'once'|'always'|'reject'): Promise<void>

// 通知
notifyQuestion(data): void
async notifyPermission(data): Promise<void>

// 重试
async retry(mode: 'continue'|'revert'|'fork', userMessage: string, revertMessageId?: string): Promise<void>

// 规则设置
setResolvedRules(rules: Record<string, string>): void

// 工厂方法
static createStepStarter(runner): (stepId) => Promise<{output, outputFileName?}>
```

#### 6.0b 事件清单

| 事件名 | 数据 | 触发时机 |
|--------|------|---------|
| `started` | `{stepId, sessionId}` | Agent 会话创建成功 |
| `completed` | `{stepId, output, outputFileName?}` | Step 执行完成 |
| `failed` | `{stepId, error}` | Step 执行失败 |
| `aborted` | `{stepId}` | Step 被中止 |
| `paused` | `{stepId}` | Step 暂停 |
| `resumed` | `{stepId, resumePrompt}` | Step 恢复 |
| `question` | `{stepId, sessionId, requestId, questions}` | 问答请求 |
| `permission` | `{stepId, sessionId, requestId, permission, ...}` | 权限请求 |
| `interaction_resolved` | `{stepId}` | 交互解决后 |

#### 6.1 Shell 模式

```
1. replacePassThroughVars() ── 替换命令中的 ${xxx} 透传变量
2. 透传变量注入环境变量 ── 非空值的 passThroughVars 作为 env 注入（V2.4.2 新增）
3. 循环迭代环境变量 ── 在循环中时注入 in-loop-turn 和 all-loop-turn（V2.4.2 新增）
4. resolveRawInputOutputs() ── 从 inputFrom 解析的 Step 的 output.json 读取完整内容（V2.4.2 新增）
5. child_process.exec() 执行命令（cwd=directory, windowsHide=true, maxBuffer=10MB）
6. 将 inputFrom 结果作为 JSON 数组写入子进程 stdin（V2.4.2 新增, 含 EPIPE 错误抑制）
7. 成功: 收集 stdout 作为输出 → collectOutputArtifacts() 收集产物
8. 失败: 写入 {stepId}_output.json（含 error 字段）→ emit failed → reject
```

> **Task 2 DSH 映射**：
> - 简单命令：`ctx.shell.resolve()` + `ctx.shell.run()`（`bash -c`，返回 stdout/stderr 文本）
> - 需 stdin 注入/流式/终端：`ctx.subprocess.spawn()`（提供原始 stdio 流）

#### 6.2 Agent 会话模式 (prompt 类型 — Task 2 重点)

```
1. buildStepInputMessages() ── 构建输入消息
   ├── jobRequirement (原始需求)
   ├── 前置 Step 输出 (returnPrompt + artifacts)
   └── 其他输入信息

2. writeInputJson() ── 写入 {stepMessageId}_input.json

3. 构建结构化提示词 (V2.5: 单一 text part, sections 拼接):
   ├── [主头部] "你是严谨准确的Step执行Agent..." — 角色定位说明
   ├── [## 你的任务] — {promptText} (纯提示词)
   ├── [## 参考信息] — 含多个 ### 子标题 (V2.5: 4 个子节):
   │     ├── ### 用户原始需求 — _jobRequirement
   │     ├── ### 当前Step参数 — paramsText (仅 agent 类型有 agentParamsTemplate 时)
   │     ├── ### 其他输入信息 — _otherValues (列表)
   │     └── ### 用户补充信息【仅供参考】 — _userSupplementMessages (列表)
   ├── [## 前置Steps输出与产物] — 每个前置 Step 一个 ### 子标题:
   │     └── ### 前置Step: {name} ({id}) + <{id}><output>缩进</output><artifacts>文件列表</artifacts></{id}>
   └── [## 任务规则] — Record<string,string> 键值列表 (仅当有规则时)

4. writePartsJson() ── 写入 {stepMessageId}_parts.json

5. sendChat() ── 发送 parts

6. listenForEvents() ── 等待 session.idle

7. 暂停检查: 如果执行期间被暂停, 等待 _resumePromise

8. readOutput() ── 读取会话输出

9. collectOutputArtifacts() ── 根据 outputTo 收集产物 → emit completed → _status='completed'
```

> **Task 2 DSH 映射**（prompt 类型）：
> - 使用 `ctx.llm.stream()` 进行一次性推理（无需完整会话管理）
> - 或使用 `ctx.subagents.start()` 创建一次性子代理
> - 结构化提示词构建逻辑保留不变
>
> **provider/model 解析（三层回退，DSH 无 SDK 默认模型，需引擎自兜底）**：
> - **L1 定义优先**：Step 的 `providerId` + `modelId` **成对提供才用**（对齐 v2.6 的 `providerId && modelId` AND 逻辑——缺一个整体视为缺省，不拆开）
> - **L2 引擎 Config 兜底**：`static Config` 增加 `defaultProvider`/`defaultModel`（schemastery，成对配置才用；遵循 DSH「No hardcoded tunables」，不硬编码）
> - **L3 目录最后兜底**：`ctx.llm.listProviders()[0]` + `ctx.llm.listModels(provider)[0]`（保证「Config 也没配」时仍能跑，记 warn 日志）
> - 解析结果拼成 `GenerateOptions` 的 `provider`/`model` 字段传给 `ctx.llm.stream()`（DSH 的 `resolveCallFor` 要求 `config.model` 必需，无自动默认模型）

**结构化提示词模板** (V2.5 重构)：

```
[主头部]
你是严谨准确的Step执行Agent，你的任务是参考`## 参考信息`和`## 前置Steps输出`中的信息，
准确完成`## 你的任务`中的要求。

## 你的任务
{promptText — prompt 类型的任务描述}

## 参考信息
### 用户原始需求
{_jobRequirement}
### 当前Step参数
{paramsText — 仅 agent 类型有 agentParamsTemplate 时}
### 其他输入信息
- {_otherValues[0]}
- {_otherValues[1]}
### 用户补充信息【仅供参考】
- {_userSupplementMessages[0]}
- {_userSupplementMessages[1]}

## 前置Steps输出与产物
### 前置Step: {name} ({id})
<{id}>
  <output>
    {returnPrompt — 逐行缩进}
  </output>
  <artifacts>
    - {artifactFile1}
    - {artifactFile2}
  </artifacts>
</{id}>

## 任务规则
- **{ruleKey1}**: {ruleContent1}
- **{ruleKey2}**: {ruleContent2}
```

#### 6.0c 私有方法清单

| 方法 | 说明 |
|------|------|
| `executeBash()` | Shell 命令执行（child_process.exec），失败时 reject 中断 |
| `executeAgentSession()` | V2.5: 结构化提示词重构 — 主头部 + `## 你的任务` + `## 参考信息` + `## 前置Steps输出与产物` + `## 任务规则` |
| `fillParams()` | Agent 参数填充（临时 AI 会话） |
| `listenForEvents(sessionId)` | 等待会话完成（使用共享 SSE） |
| `readOutput(sessionId)` | V2.5: 优先从 jsonl 读取最后一条文本；回退到 SDK messages API |
| `buildStepInputMessages()` | 构建输入消息 |
| `writeInputJson()` | 写入 {uuid}_input.json |
| `writePartsJson(parts)` | 写入 {uuid}_parts.json |
| `readOriginalInput()` | 从 work.json 读取原始需求 |
| `readWorkState()` | 读取 work.json 完整状态 |
| `resolveInputMessages()` | 解析输入消息（inputFrom → 前置输出） |
| `resolveFromInputFrom(workState, inputFromItems)` | 按 inputFrom 路径解析 |
| `resolvePathSegments(workState, segments)` | 按 `.` 分割路径逐级定位 |
| `resolveFromPreviousSteps(workState)` | 无 inputFrom 时回退到前一步骤输出 |
| `replacePassThroughVars(str, workState)` | 替换 ${xxx} 透传变量 |
| `resolveRawInputOutputs()` | V2.4.2: Shell stdin 注入 |
| `collectOutputArtifacts(returnPrompt)` | 收集 outputTo 产物 + 写 output.json |
| `cleanupSession()` | 清理会话资源 |

### 5.6 引擎 V2.6 主执行循环（Stage 级编排）

> 来源：dynamic-workflow-engine §5.9（V2.6 引擎主循环变更）

V2.6 的 `WorkflowEngineV2.execute()` 主循环改为 Stage 级编排：

```
execute():
  1. 状态 → running, 启动共享 SSE
  2. 入队第一个 Stage
  3. Stage 编排循环:
     a. 取出当前 Stage → 创建 StageExecutor
     b. stageExecutor.execute() → 等待 Stage 内部执行完成
     c. 收集 StageExecutionResult → 存入 dagNavigator.stageContracts
     d. 发射 workflow.stage_completed 事件
     e. tryAdvanceStage() → 评估 Stage 级 condition/branches/next
     f. 有下一 Stage → 入队；无 → 完成
  4. 所有 Stage 完成 → status = completed
  5. 持久化 + 事件
```

> **Task 2 简化**：Stage 间流转仅跟 `Stage.next`，不评估 `condition`/`branches`。

### 5.7 引擎初始化

> 来源：dynamic-workflow-engine §4.1

```typescript
constructor(definition, originalInput, options: WorkflowEngineV2Options)
// WorkflowEngineV2Options 原含 permissionMode?: PermissionMode（迁移后废弃：权限由宿主 Session 的 permission preset 决定）
```

1. **创建子管理器**（传入 `this` 引用）：
   - `sseManager = new WorkflowSseManager(this)`
   - `interactionManager = new WorkflowInteractionManager(this)`
   - `lifecycleManager = new WorkflowLifecycleManager(this)`
   - `finalizeManager = new WorkflowFinalizeManager(this)` — V2.6: 内部创建 `FinalizeAssessor` + `GateEvaluator`
   - `loopManager = new WorkflowLoopManager(this)`
   - `dagNavigator = new WorkflowDagNavigator(this)` — V2.6: 内部创建 `stageContracts` Map
   - `recoveryManager = new WorkflowRecoveryManager(this)`
   - `defaultSessionManager = new DefaultSessionManager(this)` — V2.6 新增
2. **`dagNavigator.buildNodeIndex(definition)`**：遍历所有 Stage 和 Step，构建 `nodeIndex: Map<string, DagNodeRef>`
3. **`finalizeManager.initPassThroughVars(definition, jobId, taskId)`**：从定义中收集所有 `passThroughVars`，再从持久化状态恢复已解析的值
4. **`restoreExecutedSteps()`**：从 `work.json` 恢复已执行步骤和循环栈
5. **`lifecycleManager.subscribeToEventBus()`**：订阅全局 `WorkflowEventBus` 的暂停/恢复/中止事件

### 5.8 InputFrom 解析

> 来源：dynamic-workflow-engine §6.3

支持三种路径格式：

| 格式 | 含义 | 示例 |
|------|------|------|
| `stg-xxx` | Stage 级 | 该 Stage 所有 step 输出（倒序，最近优先） |
| `stg-xxx.step-xxx` | Step 级 | 最近匹配 Step 的所有输出 |
| `stg-xxx.step-xxx.opt-xxx` | OutputTo 级 | 特定 outputTo 的产物 |

还支持 `regex` / `glob` 模式匹配文件路径，以及 `${xxx}` 透传变量替换。

**就近匹配算法** (`resolvePathSegments`)：

1. 扁平化 `executedSteps`（递归展开循环容器），得到带索引的 `flatEntries`
2. 找到当前 Step 的 `currentFlatIdx`
3. **Stage 级**：返回该 Stage 下所有 Step（倒序，最近优先）
4. **Step 级**：从当前 Step 往前搜索，找到最近的匹配 ID
5. **OutputTo 级**：从当前 Step 前一个位置往前搜索，找到匹配 Step 后过滤特定 outputTo

**回退机制**：无 `inputFrom` 时，自动使用前一个 Step（`currentFlatIdx - 1`）的输出。

### 5.9 产物收集 — OutputTo 解析

> 来源：dynamic-workflow-engine §6.4

```typescript
outputTo: Array<{ id: string; path?: string; regex?: string }>
```

- `path`：文件路径（支持 glob 模式如 `artifacts/*.md`）
- `regex`：正则表达式匹配文件路径
- 引擎自动区分 glob 与 regex：包含 `*`/`?` 且无 regex 特征 → 视为 glob

产物收集结果写入 `{stepMessageId}_output.json`：

```json
{
  "sessionId": "...",
  "output": {
    "returnPrompt": "AI 返回的文本",
    "artifacts": [
      { "id": "opt-xxx", "value": ["/abs/path/to/file1.md", "/abs/path/to/file2.md"] }
    ]
  }
}
```

---

## 6. RPC 接口

### 6.1 Host RPC（替代 Express server）

> 来源：dsh-workflow §5.6

原 `server/express/` 的 REST 路由**不移植**，改为 Host RPC：

- **对外 API**：`workflow` 包注册一个 **Remote 服务**（`TypertRemoteService` + `@Remote`），暴露：
  - `listDefinitions()` / `createDefinition()` / `updateDefinition()` / `deleteDefinition()` / `getYaml()` / `updateYaml()`
  - `listJobs()` / `createJob()` / `listInstances()` / `startInstance()` / `deleteInstance()` / `abortInstance()`
  - `getDiscussion()` / `addChatMessage()`
  - `getArtifacts()`
  - `listProviders()` / `listModels()`（直接复用 `ctx.llm.listProviders()/listModels()`）
- **Client 调用**：前端通过 `host.call('sandore.listDefinitions', {})` 等 Package-private RPC。

### 6.2 完整 RPC 清单

> 来源：dsh-workflow §7.2

| 方法名 | 说明 | 对应原 Express 路由 |
|---|---|---|
| `listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml` | 定义 CRUD + YAML | `/api/workflows/defines/*` |
| `listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob` | Job CRUD | `/api/workflows/jobs/*` |
| `listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance` | 实例生命周期 | `/jobs/:id/instances/*` |
| `getDiscussion` / `addChatMessage` | 讨论/聊天 | `.../discussion` + `.../chat/message` |
| `getArtifacts` | 产物查询 | `.../artifacts` |
| `replyQuestion` / `replyPermission` | 交互回复 | `.../question/reply` + `.../permission/reply` |
| `pauseStep` / `resumeStep` / `pauseAll` / `resumeAll` / `retryStep` | 暂停/恢复/重试 | `.../pause` / `.../resume` / `.../retry` |
| `listProviders` / `listModels` | Provider/Model（复用 `ctx.llm`） | `/providers/*` |
| （D9 修正：无 default-session RPC——宿主 Session 自然延续） | — | — |

> **Task 2 范围**：仅需实现定义 CRUD + Job CRUD + 实例生命周期（start/list/get/delete/abort）+ 产物查询。暂停/恢复/重试/交互/默认会话为后续 Task。

### 6.3 Service Definition（`ctx.sandoreEngine`）

> 来源：dsh-workflow §5.1

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sandoreEngine: SandoreEngine
  }
  interface Events {
    'sandore/start'(info: DagRunInfo): void
    'sandore/stage-start'(info: DagRunInfo, stageId: string): void
    'sandore/stage-completed'(info: DagRunInfo, stageId: string, contract: StageContract): void
    'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void
    'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, name: string, output: ContentBlock[], loopIteration?: number[]): void
    'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, name: string, error: string, loopIteration?: number[]): void
    'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void
    'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, name: string, resumePrompt?: string, loopIteration?: number[]): void
    'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string, name: string, loopIteration?: number[]): void
    'sandore/question'(info: DagRunInfo, question: PendingQuestion): void
    'sandore/permission'(info: DagRunInfo, permission: PendingPermission): void
    'sandore/end'(info: DagRunInfo, result: DagResultInfo): void
    'sandore/aborted'(info: DagRunInfo): void
    // （D9 修正：无 default-session-mounted 事件——宿主 Session 自然延续）
  }
}

export abstract class SandoreEngine extends Service {
  constructor(ctx: Context) { super(ctx, 'sandoreEngine') }

  abstract startInstance(request: DagStartRequest): DagRun
  abstract recoverInstance(instanceId: string): Promise<DagRun>
  abstract abortInstance(instanceId: string): Promise<void>
  abstract replyQuestion(instanceId: string, requestId: string, answers: unknown): Promise<void>
  abstract replyPermission(instanceId: string, requestId: string, reply: 'once'|'always'|'reject'): Promise<void>
  abstract pauseStep(instanceId: string, stepId: string): Promise<void>
  abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>
  abstract pauseAllSteps(instanceId: string): Promise<void>
  abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>
  abstract retryStep(instanceId: string, stepId: string, mode: 'continue'|'revert'|'fork', message: string): Promise<void>
  abstract getState(instanceId: string): DagInstanceState
}
```

> **决策 D2**：Service 层只暴露「实例级」操作，工作流定义/Job 的 CRUD 放在 `workflow`（Host RPC 层）。

### 6.4 依赖注入清单与 Provider 声明

> 来源：dsh-workflow §8.3

```ts
class SandoreEngineRuntime extends SandoreEngine {
  static inject = [
    'sessions',           // 工作流宿主 Session
    'sessionPersistence', // 会话持久化
    'subagents',          // 可续接子代理（Step 执行）
    'llm',                // 分支评估/finalize 临时推理
    'shell',              // shell 类型 Step
    'fs',                 // 产物/文件读写
    'storageDomain',      // work.json 状态快照
  ]
  // 可选（用 ctx.get() 软依赖）：
  //   ctx.subprocess —— shell Step 需 stdin 注入/流式/终端时
  //   ctx.sandbox    —— 需要显式沙箱约束时

  static Config = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    maxConcurrentSteps: z.natural().default(0),   // 0 = 不限
    // prompt Step 缺省模型兜底（三层回退 L2，见 §6.2；成对配置才用，缺省 undefined → 走 L3 目录兜底）
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    // 注：无 permissionMode（权限修正后废弃——子代理继承宿主 Session 的 permission preset）
  })
}
```

---

## 7. 验证标准

Task 2 的验证标准是：**能跑通一个「shell Step → prompt Step」的线性工作流到 completed**。

具体验证路径：

1. **定义 CRUD**：创建一个包含两个 Stage 的工作流定义（Stage 1 含一个 shell Step，Stage 2 含一个 prompt Step），通过 YAML 解析 + Zod 验证
2. **Job CRUD**：创建 Job 关联该工作流定义
3. **实例启动**：启动实例，引擎执行 Stage 1 的 shell Step → shell 命令完成 → Stage 推进 → Stage 2 的 prompt Step → LLM 推理完成 → Stage 推进 → 所有 Stage 完成 → status = completed
4. **状态查询**：通过 `getInstanceState` 查询，确认 status = completed，executedSteps 包含两个已完成的 Step
5. **持久化验证**：通过 `storageDomain` 读取 work.json 状态快照，确认包含完整的执行记录

### 7.1 测试策略（vitest + 内存 mock，对齐 DSH）

> 仓库当前无测试框架。Task 2 起建立 vitest 测试，分两层：

| 层 | 范围 | mock 策略 |
|---|---|---|
| **纯单元测试** | YAML 解析（V1/V2 合法/非法 → 类型化错误）、Zod Schema 校验、InputFrom/OutputTo 路径解析、透传变量替换 | **零 mock**（纯函数，不依赖 DSH 服务） |
| **轻量集成测试** | 线性执行调度（StageExecutor + StepRunner：shell → prompt 到 completed）、CRUD + 持久化 | **内存 mock DSH 服务**：`SqliteStorageBackend(':memory:')`（或 storage-domain 的 `MemoryStorageBackend`）+ fake `ctx.llm` adapter（`registerAdapter`，stream 返回固定 `[{type:'text',text:…}]`）+ mock `ctx.shell`（`resolve`/`run` 返回固定 stdout） |

**约定**：
- 根 `package.json` 加 `"test": "vitest run"` + devDependency `vitest`（对齐 DSH 根仓库）；workflow/microflow 各带 `tests/*.spec.ts`
- **不引入 test-support 重量级集成测试**（`llm-mock-server`/`agent-loop-testkit`）：Task 2 最小可用阶段重点是「调度逻辑 + 类型化错误」，真实 cordis 组合 + 真实 LLM 的 e2e/snapshot 留到 Task 5 固化阶段
- 测试断言对齐验证路径：① 定义/Job CRUD 往返；② shell→prompt 线性流到 `completed` + `sandore/*` 事件按序；③ storageDomain 读回 state 快照；④ 非法 YAML/缺省 provider/model 抛类型化错误

---

## 附录 A：关键 DSH API 参考

> 来源：dsh-workflow 附录 A

| Service（ctx key） | 核心方法 | 用途 |
|---|---|---|
| `ctx.llm` | `stream(options)` / `prepareCall()` / `listProviders()` / `listModels()` / `resolveModelInfo()` | 模型推理（prompt Step + 分支/finalize 临时会话） |
| `ctx.subagents` | `startContinuable(spec)` / `start(name, req)` / `followup()` / `interrupt()` / `reportFrom()` / `listChildren()` | 可续接子代理（Step 执行）+ 一次性子代理 |
| `ctx.sessions` | `create(id, {seed})` / `append` / `flush` / `list` | Session 事件日志（chat.json 替代） |
| `ctx.sessionPersistence` | `create` / `append` / `load` / `inspect` / `prepare` / `readFrom` / `list` | 会话持久化（崩溃恢复） |
| `ctx.storageDomain` | `open(spec)` → schema 验证 KV（tables/global） | work.json 状态快照 |
| `ctx.shell` | `resolve(request)` / `run(spec)` / `start(spec)` / `get sandboxMode()` | Shell 执行（高层 `bash -c`） |
| `ctx.subprocess` | `resolveExecutable()` / `spawn()` / `spawnTerminal()` | 底层进程（stdin 注入/流式/终端） |
| `ctx.fs` | `readText` / `writeText` / `editText` / `listDir` / `stat` / `resolve` / `streamText` | 产物/文件 |
| `ctx.sandbox` | `confine(argv, policy)` | 沙箱约束 |
| `ctx.sessionProjections` | `register(unit)`（event 折叠） | 前端状态推送 |
| `ctx.agents` | `create()` / `resume()` / `get(id)` | 底层 agent 工厂 |

---

## 附录 B：文件对照表

> 来源：dsh-workflow 附录 B

| sandore（设计文档中的模块） | DSH 落点 |
|---|---|
| `engine/internal/engine/workflow-engine-v2.ts` | `packages/sandore/workflow/src/workflow-engine-v2.ts` |
| `engine/internal/engine/stage-executor.ts`（v2.6） | 同包 `stage-executor.ts` |
| `engine/internal/engine/workflow-step.ts` | 同包 `workflow-step.ts`（改用 ctx.subagents/ctx.shell/ctx.subprocess） |
| `engine/internal/engine/branch-evaluator.ts` | 同包 `branch-evaluator.ts`（改用 ctx.llm） |
| `engine/internal/engine/workflow-finalize-manager.ts` | 同包 `finalize-manager.ts`（FinalizeAssessor/GateEvaluator） |
| `engine/internal/engine/state-persistence.ts` | 同包 `persistence.ts`（存储域 + Session 事件） |
| `engine/internal/sdk/*`（@codeagent/sdk 封装） | **删除**，改用 ctx.subagents/ctx.llm/ctx.shell/ctx.subprocess/ctx.fs |
| `engine/api/*` + `server/express/*` | `packages/sandore/workflow/`（Remote/RPC） |
| `client/src/*`（React 前端） | `packages/sandore/ui/`（Client 插件） |
