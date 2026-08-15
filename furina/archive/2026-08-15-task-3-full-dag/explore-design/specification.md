# Furina Explore — Exploration Results

# Explore Content

严格准确按照 `docs/design/task-3-full-dag/work.md` 的内容和要求，完成 Task 3（完整 DAG）的任务。

## 需求理解（Phase 2）

### What
在 Task 2 线性执行（shell/prompt Step）之上补齐完整 DAG 能力，具体包括：
- **agent / skill / mcp Step**：用 DSH 的**可续接子代理**（`ctx.subagents.startContinuable()`）承载，`child.whenIdle()` 等待轮完成，`finalAssistantOutput(child.session.events)` 读输出；skill/mcp 走工作流级 `skills`/`mcps` 数组名称校验 + prompt 前缀。
- **分支评估（BranchEvaluator）**：两阶段 start/collect，agent 分支用 `ctx.llm.stream()`，shell 分支用 `ctx.shell.run()`；`extractExpectation`/`matchesExpectation`。
- **循环/嵌套循环（LoopManager）**：`activeLoopStack`/`activeLoopIterationStack`、4 位 hex ID 后缀、`checkLoopBreak`（maxIterations + breakCondition）、扁平 `executedSteps` + `loopIteration`/`loopMeta`。
- **Finalize 拆分（FinalizeManager）**：`FinalizeAssessor`（fork 会话完成判定 + 透传变量提取 + ask 转换）+ `GateEvaluator`（独立新 session 双门审查）。
- **DAG 调度（dag-navigator）**：`resolveNextNodes` 优先级 Loop > Branches > Next > `tryAdvanceStage`（跨阶段隔离）。

### Boundaries
- 范围限定在 `packages/sandore/`（纯插件）内：产出集中于 `microflow/`（`step-runner.ts`/`branch-evaluator.ts`/`loop-manager.ts`/`finalize-manager.ts`/`file-utils.ts`）+ `workflow/`（`dag-navigator.ts` 补全 DAG 调度）。
- 硬约束：不改任何 DSH 源码；零外部 Agent SDK（`@codeagent/sdk` 等），全用 DSH `ctx.*` 服务。
- 命名沿用：`ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具）/ `sandore.*`（RPC）/ 4 包。
- 生命周期类能力（暂停/恢复/重试/崩溃恢复/宿主主代理）属 Task 4，不在本任务范围。

### Goal
理解 Task 3 的实现规格（Command 映射、InputFrom/OutputTo、分支/循环、Finalize 拆分、验证标准），以及现有 Task 2 代码结构与 DSH `ctx.*` 服务的真实 API 形状，为严格按 work.md 实现 Task 3 提供完整、准确、可落地的上下文。

# Explore Type

specification

# Exploration Results

> 输出文件：`D:\project-code\llm\sandore\furina\changes\task-3-full-dag\explore-design\specification.md`
>
> 说明：`furina config show exploration.specification` 返回空数组 `[]`，无外部配置的规格材料。本探索以 work.md「必读」清单（design.md / dsh-workflow.md / overall-design.md / DSH 源码）为规格材料，并结合当前仓库 Task 2 已落地的实现。

---

## 1. Task 3 权威规格摘要（`docs/design/task-3-full-dag/design.md`）

### 1.1 五类 Command 的 DSH 实现映射
| Command | sandore 实现 | DSH 实现 |
|---|---|---|
| `agent`（AI Agent + 参数模板） | 子代理 createSession + sendChat | `ctx.subagents.startContinuable()` 创建可续接子代理，`followup` 发后续提示词 |
| `prompt` | 同上 | `ctx.llm.stream()` 或可续接子代理 |
| `skill` | SDK 技能名 | `ctx.skill` 或保持为 prompt 前缀（校验 `workflow.skills` 数组） |
| `mcp` | SDK MCP 名 | `ctx.mcp` 或保持为 prompt 前缀（校验 `workflow.mcps` 数组） |
| `shell`（简单命令） | `child_process.exec` | `ctx.shell.resolve()` + `ctx.shell.run()`（`bash -c`） |
| `shell`（stdin 注入/流式） | exec + stdin 写入 | `ctx.subprocess.spawn()`（原始 stdio） |

### 1.2 关键决策 D3
- **Step 的 AI 会话**用 `ctx.subagents.startContinuable()` 的**可续接子代理**（非临时 `ctx.llm.stream()`）：支持多轮会话、工具调用、权限、问答、暂停/恢复、崩溃恢复（`ctx.agents.resume({ resumeSessionId })`）。
- **分支评估 / finalize 的临时 AI 会话**（一次性、只读、红线约束）用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`。

### 1.3 Step 会话生命周期（DSH 可续接子代理，design.md §2.1）
```
const started = await ctx.subagents.startContinuable({ ... })  // → { childId, messageId }
const child = ctx.agents.get(started.childId)                  // hold 住 live Agent 引用
await child.whenIdle()                                          // ★ 权威 per-turn 等待原语
finalAssistantOutput(child.session.events)                     // 最后一条非空 assistant 输出
```
等待轮完成的坑位（探索确认）：①「先 followup 再 whenIdle」（idle 可能「未开始」）；② hold 住 child 引用（叶子子代理 settle 后被 dispose）；③ `subagent/end` 是 settle 时发、非每轮；④ settlement notice 会 `parent.followup` 唤醒主代理（需处理副作用）。

### 1.4 InputFrom 解析（design.md §4）
三种路径格式：`stg-xxx`（Stage 级，倒序最近优先）/ `stg-xxx.step-xxx`（Step 级，就近匹配）/ `stg-xxx.step-xxx.opt-xxx`（OutputTo 级）；另支持 `regex`/`glob` 与 `${xxx}` 透传变量替换。就近匹配算法 `resolvePathSegments`：扁平化 `executedSteps` → 定位 `currentFlatIdx` → 逐级匹配（`idMatches` 支持后缀匹配 `actualId.startsWith(targetId + '-')`）；无 `inputFrom` 回退到前一个 Step。

### 1.5 OutputTo 解析（design.md §5）
`outputTo: Array<{ id; path?; regex? }>`；glob 与 regex 自动区分（含 `*`/`?` 且无 `\d`/`(?` 特征视为 glob）。产物收集结果写入 `{stepMessageId}_output.json`：
```json
{ "sessionId": "...", "output": { "returnPrompt": "...", "artifacts": [{ "id": "opt-xxx", "value": ["/abs/path/file.md"] }] } }
```
glob→regex：`*`→`[^/]*`、`**`→`.*`、`?`→`[^/]`、其余转义。

### 1.6 Finalize 拆分（design.md §9）
- **FinalizeAssessor（第 1 部分）**：session 类型 Step 用 `ctx.sessions.fork(stepSessionId, boundary)` fork 会话分支，shell 类型启动临时 AI 会话；做①透传变量提取 ②完成判定（`completionType: 'completed' | 'ask'`）；`ask` 转 `AskUserQuestionPayload`（对齐 DSH `ask_user_question` schema）。
- **GateEvaluator（第 2 部分）**：始终独立新 session（`startTempSession` → `ctx.llm.stream()`）；Primary Gate 返回 `{taskStatus, errorDetail}`，Secondary Gate（`secondaryEnabled`）返回 `{gateStatus, gateDetail}`；产物验证失败覆盖 `gatesPassed=false`。
- 编排流程 `finalizeStep`：可跳过（无未解析变量+无门禁）→ assess → 判定 ask（注入交互，返回 `{type:'ask'}`）或 completed → gate → `{type:'done'|'error'}`。

### 1.7 分支评估（design.md §7）
两阶段 `start(condition, contextMessage)` / `collect(partial)`；`extractExpectation`（JSON → regex `/"branchExpectation"\s*:\s*"([^"]+)"/` → raw.trim）；`extractBreakResult`（JSON → regex `/"shouldBreak"\s*:\s*(true|false)/i` → raw.trim，public，供 `checkLoopBreak` 调用）。构造参数 `(directory, defaultTimeoutMs?, jobId?, taskId?, stepId?)`。

### 1.8 循环（design.md §8）
- 扁平化（V2.3）：无 `ExecutedStepLoop` 容器，循环迭代直接以 `ExecutedStepDefault` 存于扁平 `executedSteps`，字段 `id=原始ID-后缀`、`stepId=原始ID`、`loopIteration: number[]`、`loopMeta`。
- 循环触发：`loop` 存在时 `resolveNextNodes` 触发；`loopTo` 优先级 `loop.next` > 分支评估结果 > `node.next`（仅同阶段）。
- 跳出 `checkLoopBreak`：硬上限 `visitCount >= maxIterations` → 立即跳出；否则 `breakCondition` 两阶段评估；shell 模式 `matchesExpectation`，agent 模式 `breakResult === 'true'`。
- 跳出后 `resetLoopVisitCounts(nodeId)` + `popActiveLoop()`（先 `activeLoopIterationStack.pop()` 再 `activeLoopStack.pop()`）。
- 迭代上下文注入（V2.4.2）：shell 环境变量 `in-loop-turn`/`all-loop-turn`；agent `${in-loop-turn}`/`${all-loop-turn}` 变量替换。

### 1.9 DAG 调度（work.md）
`resolveNextNodes` 优先级 **Loop > Branches > Next > `tryAdvanceStage`**（跨阶段隔离）。

### 1.10 关键类型（design.md §10）
`DagLoop { breakCondition?; breakExpectation?; next?; maxIterations; exitTo? }`；`DagBranch { expectation?; next; label? }`（省略 `expectation` 为并行分支）；`BranchMeta { result?; sessionId?; directory?; status; expectation? }`；`FinalizeAssessResult { completionType; passThroughVars; askQuestion?; errorDetail?; forkSessionId; assessmentRaw }`；`GateEvalResult { gatesPassed; primaryPassed; secondaryPassed?; gateDetails?; errorDetail?; gateSessionId; assessmentRaw }`；`FinalizeOutcome = {type:'done'|'ask'|'error', ...}`；`FinalizeMeta` 扩展含 `completionType?`/`assessResult?`/`gateResult?`。

---

## 2. 当前仓库 Task 2 已落地实现（实现 Task 3 的既有基础）

### 2.1 包结构（`packages/sandore/`）
```
microflow/src/{errors.ts, internal.ts, index.ts, stage-executor.ts, step-runner.ts, step-runner.spec.ts}
workflow/src/{errors.ts, index.ts, seam.ts, shell.ts, types.ts, schema.ts, dag-navigator.ts,
               workflow-engine.ts, persistence.ts, remote.ts, yaml-parser.ts, *.spec.ts}
workflow/tests/mocks/{llm.ts, sessions.ts, shell.ts, storage-domain.ts}
tool/ ui/（Task 1/5 骨架，本任务不涉及）
```

### 2.2 关键现状
- **`step-runner.ts`**：目前仅 `shell` + `prompt` 两路。`runPrompt` 用 `BlockAssembler` 聚合 `ctx.llm.stream(options)`（options 含 provider/model/messages/signal），`finish.kind==='error'|'aborted'` 抛 `STEP_EXECUTION`。三层 provider/model 回退（Step 定义 → 引擎 Config → `ctx.llm` 目录）。**agent/skill/mcp 三类型抛 `unsupported step command type`**（Task 3 待补）。
- **`stage-executor.ts`**：目前按 `steps` 数组**线性**执行，`synthesizeChildId(stepId)` 合成占位 childId（`step-{stepId}-{execId前8位}`），`sessionMeta: { childId, synthetic: true, command }`；逐 Step `onPersist` 钩子持久化。**无分支/循环/Finalize**。
- **`dag-navigator.ts`**：已有 `DagNodeRef`（kind stage/step、next/condition/branches/loop 字段）+ `nodeIndex`；但 `tryAdvanceStage()` 仅 Stage 级线性推进，**无 `resolveNextNodes`（Loop/Branches/Next 优先级）**（Task 3 待补）。
- **`workflow-engine.ts`**：Stage 级线性主循环；`StageStepHooks`（onStepStart/onStepCompleted/onStepFailed）；`makeInitialState` 已含 `activeLoopStack`/`activeLoopIterationStack`/`activeLoopNodeId`/`pausedStepIds` 等循环/生命周期字段（Task 3 可复用）。`SandoreEngineRuntime.Config` 已含 `defaultProvider`/`defaultModel`。
- **`schema.ts`**：已含 `CommandConfigSchema`（agent/prompt/shell/skill/mcp 五类型 discriminated union）、`InputFromItemSchema`、`OutputToItemSchema`、`PassThroughVarSchema`、`DagBranchSchema`、`DagLoopSchema`、`GatesSchema`、`BranchMetaSchema`、`FinalizeMetaSchema`、`ExecutedStepDefaultSchema`（已含 `loopIteration`/`loopMeta`/`finalizeMeta`/`visitCount` 字段）、`WorkflowTaskStateSchema`（已含 `activeLoopStack`/`activeLoopIterationStack`/`activeLoopNodeId`/`passThroughVars`/`stageContracts`）。**注意**：`FinalizeMetaSchema` 目前仅 `{ status, sessionId?, gateSessionId?, directory?, errorDetail? }`，**缺 V2.6 扩展字段** `completionType?`/`assessResult?`/`gateResult?`（design.md §10.7，Task 3 待补）。
- **`types.ts`**：`ExecutedStepDefault` 已含 `loopIteration?`/`loopMeta?`/`finalizeMeta?`/`branchMeta?`/`visitCount`/`output?`；`PendingQuestion`/`AskUserQuestionPayload` 已定义。
- **`seam.ts`**：13 个 `sandore/*` 事件已双声明（Cordis `Events` + Session `SessionEventMap`）。`SandoreConfig` 已有 `defaultTimeoutMs`/`maxConcurrentSteps`/`defaultProvider`/`defaultModel`。
- **`shell.ts`**：`ShellExecRequest`/`ShellExecSpec`/`ShellRunResult`/`ShellExecutor` 结构类型已就位，`ShellExecRequest` 已含 `stdin?`/`env?` 字段（供分支/finalize 的 stdin 注入与环境变量注入）。
- **`errors.ts`（microflow）**：`SandoreError` + `isFatalSandoreError`；错误码含 `YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`PERSISTENCE_FAILED`。**缺 `FINALIZE_FAILED`/`GATE_FAILED`**（design.md §4.4，Task 3 可能需补）。
- **`yaml-parser.ts`**：V1/V2 双格式 + Zod + 引用完整性校验（`next`/`branches[].next`/`loop.next`/`loop.exitTo` 已校验存在性）。

### 2.3 测试 mocks 现状
`tests/mocks/` 已有 `FakeLlm`（`textChunks` + `streamHandler`）、`FakeSession`/`FakeSessionStore`、`FakeShell`、`MemoryKvTable`/`MemoryStorageDomain`。**缺 subagents/agents 的 mock**（Task 3 的 agent Step / 分支 / finalize 测试需要 mock `ctx.subagents.startContinuable`/`ctx.agents.get`/`child.whenIdle`/`finalAssistantOutput`/`ctx.sessions.fork`）。

---

## 3. DSH `ctx.*` 服务真实 API 形状（源自 `D:\project-code\llm\deepseek-harness` 源码）

### 3.1 `ctx.subagents`（`packages/subagent/subagent/src/index.ts` + `continuation.ts`）
- `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>` → `{ childId: SessionId, messageId: MessageId }`；resolve 时机为 inbox 接受（非轮次开始）。`ContinuableStartSpec = { provider: string; label: string; request: Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>; signal: AbortSignal }`。
- `SubagentStartRequest = { label?; prompt: ContentBlock[]; parent: Agent; signal; agentOptions?; outputSchema?; maxDepth?; toolFilter?; persona? }`（startContinuable 的 request 排除 label/signal/outputSchema）。
- `followup(parent: Agent, childId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>`；`SubagentFollowupOptions = { source: MessageSource; signal }`。absent child 自动冷恢复。
- `interrupt(targetSessionId, authority: SubagentInterruptAuthority): void`；authority = `{ kind:'user'; parentSessionId }` 或 `{ kind:'ancestor'; agent }`。
- `start(name, request): Promise<SubagentRun>`（一次性子代理）；`reportFrom(child, content, options)`；`listChildren`/`listDescendants`。
- **provider 名称**：默认注册为 `fork`（`subagent-fork-in-process`，`providerName` 默认 `'fork'`）与 `spawn`（`subagent-spawn-in-process`，默认 `'spawn'`）。`workflow-worker-thread` 用 `this.provider`（默认 `fork`）调 `ctx.subagents.start`。
- 关键导出：`finalAssistantOutput`、`AssistantOutputFold` 从 `@deepseek-ai/dsh-subagent` 导出。

### 3.2 `Agent`（`packages/core/agent/src/runtime-types.ts`）
- `ctx.agents.get(id)` → live `Agent`；`Agent.whenIdle(): Promise<void>`（当前整代理活动到静默才 resolve，不识别特定消息 settlement）；`Agent.status: 'idle'|'running'`；`Agent.session: Session`（`.events`、`.header.parentSession`）；`Agent.cancel(cause, { keepInbox? })`；`followup`/`steer`/`inject`/`send`/`runMaintenance`。
- `AgentStatus` 只有 `idle`/`running` 两态（**无 paused/interacting**）→ 引擎自建「暂停登记表」（Task 4）。

### 3.3 `finalAssistantOutput`（`packages/subagent/subagent/src/assistant-output.ts`）
- `finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined`：选**最后一条非空 assistant message**；无则累计 assistant 文本流；皆无返回 `undefined`。内部 `AssistantOutputFold.push(event)`（`assistant/message` / `assistant/chunk` text-delta）。

### 3.4 `ctx.llm`（`packages/llm/llm/src/index.ts`）
- `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`prepareCall(config, signal?): Promise<PreparedLlmCall>`（`PreparedLlmCall.stream` 分发一次）。`LlmRuntime` 另有 `listProviders`/`listModels`/`resolveModelInfo`。
- `StreamChunk`/`FinishReason`/`BlockAssembler`/`createUserMessage`/`ContentBlock`/`GenerateOptions` 均从 `@deepseek-ai/dsh-llm` 导出（step-runner.ts 已示范用法）。

### 3.5 `ctx.sessions`（`packages/core/session/src/index.ts`）
- `fork(source: Session | SessionId, boundary?: number, childSessionId?: SessionId): Session`。boundary 为**含端点**的源事件 seq（省略 = 源当前最后事件）；错误码 `SESSION_NOT_FOUND`/`SESSION_NOT_LIVE`/`SESSION_ALREADY_EXISTS`/`INVALID_BOUNDARY`/`OPEN_TURN`（boundary 不能落在未闭合 turn 内）。
- `create(id?, options?)` / `get(id): Session | undefined` / `append` / `flush` / `list`。`Session.events` 为事件数组。

### 3.6 `ctx.subprocess`（`packages/subprocess/subprocess-local/src/index.ts` + `subprocess/src/types.ts`）
- `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`；`resolveExecutable(command, env?, signal?)`。
- `SubprocessSpawnSpec = { argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs; signal?; env? }`；`SubprocessStdio = { stdin: SubprocessStdinMode; stdout; stderr }`；`SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }`（stdin 注入用 `{ data }` 批量形状）。shell Step 的 stdin 注入走此服务。

### 3.7 DSH workflow 参考范式（`packages/workflow/workflow` / `workflow-worker-thread`）
- `workflow-workflow/src/index.ts`：`WorkflowEngine extends Service`，`emitWorkflowEvent(name, ...args)` 含 listener 异常捕获（`ctx.events.dispatch('emit', ...)` + try/catch + Promise.catch）。sandore 的 `emitContained` 已复刻此范式。
- `workflow-worker-thread/src/host.ts`：`ctx.subagents.start(this.provider, { prompt, parent, signal, ...agentOptions })`，`run.result.then` 转发 `{ output, structured?, stopReason }`，`run.dispose()` 清理。这是「一次性子代理」范式；Task 3 的 Step 走 `startContinuable` 而非此。

---

## 4. 验证标准（Task 3 完成门槛，work.md / design.md §11）

1. **agent Step** 可续接子代理真实跑一轮，`inputFrom` 引用前置输出正确，产物收集到 `{uuid}_output.json`。
2. **分支**正确路由；**循环**迭代路径 `loopIteration` 正确（嵌套为数组 `[1,2]`）、`maxIterations` 硬上限生效。
3. **Finalize**：透传变量提取 + `completionType`（completed/ask）+ 门禁审查 + `ask` → `AskUserQuestionPayload`。
4. **完整 DAG 端到端**：带分支 + 循环 + 门禁 + 透传变量的 YAML → 执行 → 正确路由/迭代/收尾 → 工作流完成。

---

## 5. 与 Task 2 的差异点 / Task 3 待补清单（基于现状对比）

| 能力 | 现状（Task 2） | Task 3 待补 |
|---|---|---|
| Step 类型 | 仅 shell/prompt | 新增 agent（可续接子代理）/ skill / mcp（名称校验 + prompt 前缀） |
| 分支 | schema 已定义 branches，dag-navigator 无调度 | `branch-evaluator.ts` + `resolveNextNodes` 分支路由 |
| 循环 | schema 已定义 loop，状态字段已就位 | `loop-manager.ts` + `checkLoopBreak` + 迭代 ID 后缀 |
| Finalize | 无 | `finalize-manager.ts`（FinalizeAssessor fork + GateEvaluator 独立 session） |
| InputFrom/OutputTo | schema 已定义，仅线性 `toPreviousOutput` | `resolveFromInputFrom` + OutputTo 产物搜索（`file-utils.ts`） |
| DAG 导航 | `tryAdvanceStage` 线性 | `resolveNextNodes`（Loop > Branches > Next > tryAdvanceStage） |
| FinalizeMeta | 缺 V2.6 扩展字段 | 补 `completionType`/`assessResult`/`gateResult` |
| 错误码 | 缺 FINALIZE_FAILED/GATE_FAILED | 视需要补 |
| 测试 mocks | 缺 subagents/agents/fork | 补 `ctx.subagents`/`ctx.agents`/`ctx.sessions.fork` mock |
