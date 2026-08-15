# 记忆探索结果（memory）

## 一、需求理解（Phase 2）

- **What（要理解什么）**：`docs/design/task-3-full-dag/work.md` 要求在 Task 2 线性执行（shell/prompt）之上补齐完整 DAG 能力——agent/skill/mcp Step（用 `ctx.subagents.startContinuable()` 可续接子代理承载）+ 分支评估（BranchEvaluator 两阶段 start/collect）+ 循环/嵌套循环（LoopManager 扁平化 + ID 后缀 + 跳出检测）+ Finalize 拆分（FinalizeAssessor fork 会话完成判定/透传变量提取/ask 转换 + GateEvaluator 独立新 session 双门审查）。本探索梳理项目内与 Task 3 直接相关的「设计决策记忆」与已核实的 DSH 源码范式落点。
- **Boundaries（范围）**：仅 Task 3 完整 DAG。**不含**交互管理（问答/权限的 WorkflowInteractionManager）、暂停/恢复/重试、崩溃恢复（`ctx.agents.resume`）、宿主主代理、SSE 前端推送——这些是 Task 4；也不含前端 UI（Task 5）。核心记忆来源是 `docs/design/task-3-full-dag/design.md`（权威规格）、`docs/engine/dsh-workflow.md`（§5.2 引擎移植映射 / §5.3 Step 执行器映射 / §5.3A SDK 全量映射）、`docs/design/overall-design.md`（D1–D9、§4.3.1 存储域）、`docs/engine/dynamic-workflow-engine.md`（引擎 v2.6 技术设计），以及 DSH 源码 `D:\project-code\llm\deepseek-harness`。
- **Goal（目标）**：为 Task 3 的实现/设计提供事实依据——明确产出文件清单、agent/skill/mcp Step 会话模式（可续接子代理）、分支/循环/finalize 的执行时序与判定规则，以及它们在 DSH 源码中的既有范式落点（`startContinuable`/`whenIdle`/`finalAssistantOutput`/`sessions.fork`/`llm.stream`）。
- **Project Context**：Task 1、Task 2 已完成并归档（`furina/archive/2026-08-15-task-1-skeleton/`、`furina/archive/2026-08-15-task-2-minimal-engine/`）。当前 `furina/changes/task-3-full-dag/` 为新 change（`artifacts` 为空，尚未产出 proposal/design/specs/plan）。Task 3 在 `microflow`（Stage 内部执行能力补全）+ `workflow`（DAG 调度）两包内产出，`tool`/`ui` 本 Task 不涉及。

## 二、项目现状（当前状态事实）

| 位置 | 现状 |
|---|---|
| `packages/sandore/microflow/src/step-runner.ts` | **Task 2 仅 shell/prompt 两种**：`run()` 按 `command.type` switch，`default` 抛 `SandoreError('unsupported step command type', 'STEP_EXECUTION')`；shell 走 `ctx.shell.resolve`→`run`，prompt 走三层 provider/model 回退 + `ctx.llm.stream()` + `BlockAssembler`。`StepRunner(ctx, config)` 构造；`StepRunRequest { step, workdir, originalInput, previousOutputs, signal }`；`StepRunResult { output: ContentBlock[] }`。**Task 3 需增补 agent 类型**（`ctx.subagents.startContinuable()` + `child.whenIdle()` + `finalAssistantOutput`）与 skill/mcp（`workflow.skills`/`workflow.mcps` 名称校验 + prompt 前缀）。 |
| `packages/sandore/microflow/src/stage-executor.ts` | **Task 2 线性执行**：`execute()` 按 `stageDef.steps` 数组顺序 for 循环，逐个 `StepRunner.run()`，失败即 break 中止；`synthesizeChildId(stepId)` 生成**合成** childId（`step-{stepId}-{execId 前 8 位}`，非真实子代理）；`sessionMeta: { childId, synthetic: true, command }`。每个 Step 完成后经 `onPersist` 钩子通知引擎逐 Step 持久化。**Task 3 改为 DAG 调度**（分支/循环），Stage 内不再纯线性。 |
| `packages/sandore/microflow/src/index.ts` | export `errors.ts` / `step-runner.ts` / `stage-executor.ts`；`internal.ts`（`describeError`/`textSummary`）不进入公开 API。 |
| `packages/sandore/microflow/src/errors.ts` | `SandoreError extends HarnessError`（`fatal` 标志）+ `SandoreErrorCode`（含 `STEP_TIMEOUT`/`STEP_EXECUTION` 等）；`isFatalSandoreError`。 |
| `packages/sandore/workflow/src/dag-navigator.ts` | **当前仅 Stage 级线性推进**：`DagNodeRef { kind: 'stage'|'step', stage, step?, id, name, next?, condition?, branches?, loop? }` 已定义，`buildNodeIndex` 已把 stage/step 的 `next`/`condition`/`branches`/`loop` 挂进节点视图；但**尚无 `resolveNextNodes`**，`tryAdvanceStage()` 只跟 `Stage.next`（无 next 按数组顺序推断）。**Task 3 产出 `resolveNextNodes`**：优先级 Loop > Branches > Next > `tryAdvanceStage`（跨阶段隔离）。 |
| `packages/sandore/workflow/src/schema.ts` | **Zod 三层已齐**：`CommandConfigSchema` 五类型 discriminated union（agent/prompt/shell/skill/mcp 全定义）；`DagBranchSchema`（`expectation?`/`next`/`label?`）、`DagLoopSchema`（`breakCondition?`/`breakExpectation?`/`next?`/`maxIterations`/`exitTo?`）、`InputFromItemSchema`（`path`/`regex`）、`OutputToItemSchema`、`PassThroughVarSchema`（`refresh?`）、`GatesSchema`（primary/secondary）、`FinalizeMetaSchema`（`status: evaluating|completed|ask` + `gateSessionId?`）、`BranchMetaSchema`（`status: evaluating|completed`）均已在 Task 2 定义。`WorkflowTaskStateSchema` 已含 `activeLoopStack[]`/`activeLoopIterationStack[]`/`activeLoopNodeId`/`visitCounts`/`passThroughVars`/`pausedStepIds`/`stageContracts`。 |
| `packages/sandore/workflow/src/types.ts` | 13 个基础 browser-safe 类型已齐；`ExecutedStepDefault` 已含 `loopIteration?: number[]`/`loopMeta?: BranchMeta`/`branchMeta?`/`finalizeMeta?`/`output?: ContentBlock[]`/`sessionMeta?`/`visitCount` 等字段。 |
| `packages/sandore/workflow/src/workflow-engine.ts` | `SandoreEngineRuntime`：`startInstance`/`getState`/`abortInstance` 已实现；Stage 级线性主循环 `runInstance`（StageExecutor 执行 Stage → 收集 StageContract → `tryAdvanceStage`）。`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep` 8 个方法抛 `INVALID_OPERATION`（Task 4）。事件双发（`ctx.emit` + 宿主 Session `append`）已实现。 |
| `packages/sandore/workflow/src/seam.ts` | `SandoreEngine` 抽象类 11 实例级方法 + 13 个 `sandore/*` 事件双声明（Cordis `Events` + `SessionEventMap`）+ `SandoreEngineStub`（`static Config` schemastery、`static inject` = 7 项）。 |
| `packages/sandore/workflow/tests/mocks/` | 已备 `llm.ts`（`FakeLlm`/`textChunks`）、`shell.ts`（`FakeShell`）、`sessions.ts`、`storage-domain.ts`。**无 `subagents` mock**——Task 3 的 agent Step 测试需新增可续接子代理 mock（`startContinuable` + fake Agent with `whenIdle`/`session.events`/`finalAssistantOutput`）。 |
| `docs/design/task-3-full-dag/design.md` | Task 3 权威规格（1003 行：Command 映射、InputFrom/OutputTo、分支/循环、Finalize 拆分、类型、验证标准）。 |
| `docs/engine/dsh-workflow.md` | 插件化核心设计（§5.2 引擎移植映射、§5.3 Step 执行器映射、§5.3A SDK 全量映射）。 |
| `docs/engine/dynamic-workflow-engine.md` | 引擎 v2.6 技术设计（类型体系、DAG 执行、分支/循环/Finalize 的详细字段/方法/时序）。 |

## 三、核心硬约束（不可违反）

1. **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**——原 `engine/internal/sdk/`（client/session/sse-manager/utils 四文件）整体删除，全用 DSH `ctx.*` 服务（`ctx.subagents`/`ctx.agents`/`ctx.llm`/`ctx.shell`/`ctx.subprocess`/`ctx.sessions`/`ctx.fs`/`ctx.storageDomain`）。
2. **命名沿用 Task 1**：`ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具）/ `sandore.*`（RPC）/ 4 包。
3. **无 `permissionMode`**：`ContinuableStartSpec` 无权限字段，Step 子代理继承宿主 Session 的 permission preset（approval 固定 `never`）。
4. **13 事件**：沿用；`step-completed` 增补 `output`（`finalAssistantOutput` 子代理最终结果）。

## 四、命名空间决策（D1，沿用 Task 1）

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（Session 事件：`session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`） |
| RPC 方法 | `sandore.*`（`super(ctx, 'sandore')` + `@Remote('method')`） |
| 存储域 | `sandore`（`ctx.storageDomain.open(sandoreDomainSpec)`，definitions/jobs/state 三表） |
| ID 前缀 | `wfl-{uuid}` / `stg-{uuid}` / `step-{uuid}` / `opt-{uuid}` |

## 五、Task 3 产出与关键设计决策

### 5.1 产出文件清单（work.md）

- `packages/sandore/microflow/`：`step-runner.ts`（增 agent/skill/mcp）、`branch-evaluator.ts`、`loop-manager.ts`、`finalize-manager.ts`、`file-utils.ts`。
- `packages/sandore/workflow/`：`dag-navigator.ts`（增 `resolveNextNodes` 优先级 Loop > Branches > Next > `tryAdvanceStage`）。

### 5.2 关键决策（Task 3 直接相关）

- **D3**：agent 类型 Step 用**可续接子代理**（`ctx.subagents.startContinuable()`），非临时 `ctx.llm.stream()`；分支评估/finalize 的一次性只读临时会话用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`。
- **等待轮完成**：`child.whenIdle()` 是权威 per-turn 等待原语——先 `followup` 再 `await whenIdle`，再读 `finalAssistantOutput(child.session.events)`。
- **shell stdin 注入**：`ctx.subprocess.spawn()`（提供原始 stdio）；简单命令才用 `ctx.shell.run()`。
- **权限**：无 `permissionMode`；Step 子代理继承宿主 Session 的 permission preset（approval 固定 `never`）。
- **事件**：沿用 13 个 `sandore/*` 事件；`step-completed` 增补 `output`（`finalAssistantOutput` 最终结果）。
- **分支评估两阶段**：`BranchEvaluator` `start(condition, contextMessage)` + `collect(partial)`；agent 分支用 `ctx.llm.stream()`，shell 分支用 `ctx.shell.run()`（无会话，`sessionHandle = null`）。`extractExpectation`（JSON → regex 回退 → raw.trim）解析 `branchExpectation`；`matchesExpectation` 比对分支 `expectation`。`extractBreakResult`（public）解析 `shouldBreak`（JSON → regex `/\"shouldBreak\"\s*:\s*(true|false)/i` → raw.trim）。
- **循环扁平化（V2.3 重构）**：`ExecutedStepLoop` 容器已移除；循环迭代直接作为扁平 `ExecutedStepDefault[]` 存在，带 `id = 原始ID-4位hex后缀`、`stepId = 原始ID`、`loopIteration: number[]`（嵌套路径如 `[1,2]`）、`loopMeta: BranchMeta`。`WorkflowLoopManager` 字段 `activeLoopStack`/`activeLoopIterationStack`/`pendingLoopNodeId`/`pendingLoopMeta`/`stepIdSuffixMap`；`checkLoopBreak(node)` 硬上限 `visitCount >= maxIterations` → breakCondition 两阶段评估（agent 类型 `breakResult === 'true'` 跳出，shell 类型 `matchesExpectation(breakResult, breakExpectation)`）。
- **Finalize 拆分（V2.6 重构）**：第 1 部分 `FinalizeAssessor`（fork 会话完成判定 + 透传变量提取 + ask 转换，返回 `FinalizeAssessResult { completionType: 'completed'|'ask', passThroughVars, askQuestion?, forkSessionId, assessmentRaw }`）；第 2 部分 `GateEvaluator`（独立新 session 双门审查，primary/secondary，返回 `GateEvalResult { gatesPassed, primaryPassed, secondaryPassed?, errorDetail?, gateSessionId, assessmentRaw }`）。`finalizeStep` 编排：跳过检查 → assess → completionType='ask' 则注入 askQuestion（Step 进入 interacting）→ 'completed' 才继续 gate → gatesPassed 判定 → 更新 passThroughVars → persist。
- **ask 转换**：`completionType='ask'` → 提取 `askQuestion` → 构造 `AskUserQuestionPayload`（对齐 DSH harness `ask_user_question` schema：`questions[]` 含 `id`/`question`/`header?`/`options?`/`multi_select?`）→ 注入 `WorkflowInteractionManager`（Task 4 才实现注入，Task 3 仅产出 askQuestion 载荷结构）。
- **产物/输入路径解析**：`InputFrom` 三种路径（`stg-xxx` / `stg-xxx.step-xxx` / `stg-xxx.step-xxx.opt-xxx`）+ `regex`/`glob` 文件匹配 + `${xxx}` 透传变量替换；`OutputTo` glob→regex 转换（`*`→`[^/]*`、`**`→`.*`、`?`→`[^/]`）；产物写入 `{stepMessageId}_output.json`（`{ sessionId, output: { returnPrompt, artifacts[] } }`）。`file-utils.ts` 承载变量替换 + glob→regex + 产物搜索。

## 六、DSH 源码范式落点（已核实的参考实现）

以下范式来自 DSH 源码 `D:\project-code\llm\deepseek-harness`，是 Task 3 design.md 代码块的事实依据：

1. **`ctx.subagents.startContinuable(spec)` 签名（已核实）**：`packages/subagent/subagent/src/index.ts`。`async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`，返回 `ContinuableStart = { childId: SessionId, messageId: MessageId }`。**resolve 时机是 inbox 接受首条提示词**（非 turn 开始、非消息进 Session log）；此前失败 reject 且不返回 id。`ContinuableStartSpec = { provider, label, request: Omit<SubagentStartRequest, 'label'|'signal'|'outputSchema'>, signal }`，`request` 含 `parent`（exact live Agent）、`prompt`（首条 ContentBlock[]）、`persona`（system 段）、`toolFilter?`、`maxDepth?`、`agentOptions?`（见 `continuation.ts`）。

2. **`ctx.subagents.followup` / `interrupt`（已核实）**：`followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>`，absent child 自动从持久化 Session 冷恢复；`options = { source: MessageSource, signal: AbortSignal }`。`interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void`，`authority = { kind: 'user', parentSessionId } | { kind: 'ancestor', agent }`——工作流引擎用 `{ kind: 'ancestor', agent: hostAgent }`（需持有 live 宿主 Agent 引用）。

3. **`Agent.whenIdle()`（已核实）**：`packages/core/agent/src/runtime-types.ts:93`。`whenIdle(): Promise<void>`「当前整个 agent 活动达到静止后 resolve」，是权威 per-turn 等待原语（continuation 内部 `watchSettlement`/`finishDisposal` 同源使用）。`Agent` 还暴露 `id: SessionId`、`options`、`session: Session`（含 `.events`）、`status: 'idle'|'running'`、`cancel(cause, { keepInbox })`、`followup(message)`/`steer`/`inject`。

4. **`finalAssistantOutput(events)`（已核实）**：`packages/subagent/subagent/src/assistant-output.ts`。`finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined`——选**最后一条非空 assistant message**（`assistant/message` 事件 content 非空），无则回退累积的 `text-delta` 文本；`AssistantOutputFold` 提供增量折叠版。`subagent/end.lastAssistantMessage` 与后端 run result 同规则。

5. **`ctx.sessions.fork`（已核实）**：`packages/core/session/src/index.ts:1081`。`fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`——复制 source 到 boundary（缺省为最后 event 的 `seq`，空日志返回空 seed），child `meta` 记录 `parentSession` + `seedLength`。**boundary 不能落在未闭合 turn 内**。Task 3 FinalizeAssessor 的 fork 会话与重试 revert/fork 均用它。

6. **`ctx.agents` 工厂（已核实）**：`continuation.ts` `materializeTracked` 展示——fresh create `ctx.agents.create({ sessionId, meta, seed, agentOptions, signal, setup })`，cold resume `ctx.agents.resume({ resumeSessionId, agentOptions, signal, setup })`，均返回 `AgentHandle`（`.agent` 即 live `Agent`）；`ctx.agents.get(id)` 查 live Agent。

7. **`ctx.subagents.start(name, request)`（已核实）**：`SubagentRuntime.start(name: string, request: SubagentStartRequest): Promise<SubagentRun>` 一次性 published 子代理（`packages/subagent/subagent/src/index.ts:414`），用于一次性只读临时会话的备选（D3 允许 `ctx.llm.stream()` 或一次性 `start()`）。

8. **`ctx.llm.stream(options)`（Task 2 已核实）**：`packages/llm/llm/src/index.ts` 的 `LlmRuntime.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`GenerateOptions { provider, model, messages, system?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }`；`BlockAssembler`/`createUserMessage` 已在 `step-runner.ts` 中使用。Task 3 分支/finalize 的一次性推理复用此路径。

## 七、Task 3 验证标准（完成门槛，来自 work.md）

1. **agent Step**：可续接子代理真实跑一轮，`inputFrom` 引用前置输出正确，产物收集到 `{uuid}_output.json`。
2. **分支**：正确路由到匹配分支。
3. **循环**：迭代路径 `loopIteration` 正确（嵌套为数组 `[1,2]`）、maxIterations 硬上限生效。
4. **Finalize**：透传变量提取 + `completionType`（completed/ask）+ 门禁审查 + `ask` → `AskUserQuestionPayload`。
5. **完整 DAG 端到端**：带分支 + 循环 + 门禁 + 透传变量的 YAML → 执行 → 正确路由/迭代/收尾 → 工作流完成。
