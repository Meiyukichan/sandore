# Task 3 完整 DAG — 代码库探索结果

## Exploration Result（Phase 3 — furina-codebase explore）

无结果。`docs/codebase`（`furina config show project.sourcecode codebases` 返回的 codebase 目录）为空目录，尚未生成 code-document tree，因此 `furina-codebase` 的 `explore` 指令（层级导航 toc.md → spec）无可命中项，直接进入补充探索。

## Supplementary Exploration Result（Phase 4 — 手工补充探索）

### 一、需求理解（Phase 2）

1. **What**：Task 3 在 Task 2「shell/prompt 线性执行」基础上，补齐完整 DAG 能力：① agent/skill/mcp 类型 Step（用 `ctx.subagents.startContinuable()` 可续接子代理承载）；② 分支评估（BranchEvaluator，两阶段 start/collect）；③ 循环/嵌套循环（LoopManager，扁平 executedSteps + ID 后缀 + loopIteration）；④ Finalize 拆分（FinalizeAssessor fork 会话完成判定/透传变量/ask + GateEvaluator 独立 session 门禁审查）。

2. **Boundaries**：探索范围限定在 `packages/sandore/`（当前工程）的 `microflow`（Stage 内部执行）与 `workflow`（DAG 调度）两个包，以及 `docs/` 下的设计文档；DSH 参考源码 `D:\project-code\llm\deepseek-harness`（`packages/subagent/subagent`、`packages/core/agent`、`packages/core/session`）仅作为 API 落点核实。

3. **Goal**：摸清 Task 2 已实现的基线，定位 Task 3 需要新建/改造的文件与能力缺口，并核实 DSH `ctx.*` 关键原语（`startContinuable`/`whenIdle`/`finalAssistantOutput`/`sessions.fork`/`llm.stream`）的真实签名，作为实现依据。

4. **Project Context**：sandore 是 DSH 的持久化 Cordis 插件（4 包：`workflow`/`microflow`/`tool`/`ui`）。命名约定：`ctx.sandoreEngine`（Service）、`sandore/*`（13 个 Session/Cordis 事件）、`sandore_*`（模型工具）、`sandore.*`（RPC）。硬约束：**零外部 Agent SDK**，Step 会话/推理/Shell/文件全用 DSH `ctx.*` 服务；权限无 `permissionMode`，Step 子代理继承宿主 Session 的 permission preset（approval 固定 `never`）。依赖方向单向 `workflow → microflow`（microflow 对 workflow 仅 `import type`）。持久化：`work.json` → 存储域 `state` 表，`chat.json` → Session 事件日志。

---

### 二、当前实现状态（Task 2 基线）

#### 2.1 workflow 包（Stage 编排 + RPC + 持久化）

| 文件 | 现状 | 与 Task 3 的相关性 |
|---|---|---|
| `src/schema.ts` | **已含 Task 3 所需的全部定义层 schema**：`CommandConfigSchema`（agent/prompt/shell/skill/mcp 五类型 discriminatedUnion，agent 含 `agentParamsTemplate`/`providerId`/`modelId`）、`DagBranchSchema`（expectation?/next/label?）、`DagLoopSchema`（breakCondition?/breakExpectation?/next?/maxIterations/exitTo?）、`GatesSchema`（primary/secondary/need_confirm）、`WorkflowStepSchema`（含 `inputFrom`/`outputTo`/`passThroughVars`/`next`/`condition`/`branches`/`loop`/`rules`/`gates`）、`WorkflowDefinitionSchema`（含 `skills`/`mcps`/`agents`/`settings`/`rules`/`gates`）。运行时层 `WorkflowTaskStateSchema` 已含 `activeLoopStack`/`activeLoopIterationStack`/`activeLoopNodeId`/`visitCounts`/`passThroughVars`/`stageContracts` | 定义/运行时 schema 基本就绪，Task 3 仅需小幅扩展（见 §四 差距） |
| `src/types.ts` | `ExecutedStepDefault` 已含 `loopIteration?: number[]`/`loopMeta?`/`branchMeta?`/`finalizeMeta?`/`parentSessionId?`/`output?`；`AskUserQuestionPayload`/`PendingQuestion`/`PendingPermission` 已定义；`StageContract` 已定义（artifacts/passThroughVars/contractArtifacts） | 循环扁平化字段、ask 载荷类型已就位 |
| `src/dag-navigator.ts` | **仅 Stage 级线性推进**：`buildNodeIndex` 已建 Stage/Step 统一节点索引（`DagNodeRef` 含 `next`/`condition`/`branches`/`loop` 只读字段）；`tryAdvanceStage()` 只跟随 `stage.next` 或数组顺序。**无** `resolveNextNodes()`、无分支/循环调度、无跨阶段隔离 | Task 3 需在此新增 `resolveNextNodes`（Loop > Branches > Next > tryAdvanceStage） |
| `src/workflow-engine.ts` | Stage 级线性主循环：`StageExecutor.execute()` 执行整 Stage → 收集 StageContract → `tryAdvanceStage`。每个 Step 完成后经 `onPersist` 钩子逐 Step 追加 `executedSteps` 并 `persistState`。`childId = step-{stepId}-{execId前8位}` 合成占位。事件双发（`ctx.emit` + `session.append`），`step-completed` 已含 `output: ContentBlock[]`。其余 8 个实例级方法（recover/reply/pause/resume/retry）均抛 `not implemented` | Task 3 需把 Stage 级主循环升级为 DAG 调度（分支/循环/finalize），并接入真实子代理会话 |
| `src/seam.ts` | `SandoreEngine` 抽象类 + 13 个 `sandore/*` 事件双声明 + `SandoreEngineStub`；`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']` | 事件面已声明齐全，`step-completed` 已增补 `output`（work.md 要求已满足） |
| `src/persistence.ts` | `SandorePersistence` 打开 `sandore` 域三表（definitions/jobs/state），`saveWorkflowState` 全量覆盖 | 无需改动 |
| `src/remote.ts` | `SandoreRemote`：定义/Job/实例 CRUD + 产物/Provider 转发（Typert `@Remote`） | Task 3 不涉及（讨论/交互 RPC 属 Task 4） |
| `src/yaml-parser.ts` | V1→V2 转换 + `WorkflowDefinitionSchema` 校验 + `validateReferences`（已校验 `next`/`branches[].next`/`loop.next`/`loop.exitTo` 引用完整性） | 分支/循环节点的引用校验已就绪 |
| `src/shell.ts` | `ShellExecRequest` **已预留** `stdin?`/`env?` 字段（为 `ctx.subprocess.spawn()` stdin 注入预留）；`ShellExecutor` 本地结构类型（resolve/run/start） | shell Step 简单命令走 `ctx.shell`，stdin 注入需新增 subprocess 接缝 |
| `src/errors.ts` | re-export 自 microflow 的 `SandoreError` | 错误码缺口见 §四 |

#### 2.2 microflow 包（Stage 内部执行）

| 文件 | 现状 | 与 Task 3 的相关性 |
|---|---|---|
| `src/step-runner.ts` | **仅支持 shell/prompt**：`run()` 按 `command.type` 分发，`agent`/`skill`/`mcp` 落入 default 抛 `SandoreError('unsupported step command type', 'STEP_EXECUTION')`。shell 走 `ctx.shell.resolve` → `run`（无 stdin 注入）；prompt 走三层 provider/model 回退 + `ctx.llm.stream` + `BlockAssembler`。`buildPromptText` 已实现结构化提示词（主头部/任务/参考信息/前置Steps输出） | **Task 3 核心改造点**：agent 类型改用 `ctx.subagents.startContinuable` + `child.whenIdle()` + `finalAssistantOutput`；skill/mcp 加 skills/mcps 名称校验 + prompt 前缀 |
| `src/stage-executor.ts` | 按 `steps` 数组**线性**执行；`childId` 为合成占位（`synthesizeChildId`）；`toPreviousOutput` 的 `files` 恒为 `[]`（未收集产物）；`finalizeStageContract` 的 artifacts `files: []`；`collectPassThroughVars` 仅从 Step 定义收集（未从 AI 输出提取）；`onPersist` 逐 Step 回调 | Task 3 需接入分支/循环/finalize 编排（或下沉到 workflow 的 step 调度），产物收集接 file-utils |
| `src/errors.ts` | `SandoreErrorCode` 现有：`YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`PERSISTENCE_FAILED`。**缺** `FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST`（overall-design §4.4 列全） | Task 3 finalize/门禁需补错误码 |
| `src/index.ts` | export errors/step-runner/stage-executor | 需新增 branch-evaluator/loop-manager/finalize-manager/file-utils 导出 |

#### 2.3 测试基础设施（Task 3 单测复用）

- `workflow/tests/mocks/llm.ts`：`FakeLlm`（`listProviders`/`listModels`/`stream` 委托 `streamHandler`）+ `textChunks(text, reason)` 生成 block-start/text-delta/block-end/finish 流。
- `workflow/tests/mocks/shell.ts`：`FakeShell`（resolve/run 委托 handler）+ `successResult`。
- `workflow/tests/mocks/sessions.ts`：`FakeSession`（记录 append 事件）+ `FakeSessionStore`（create/get/list）。
- `workflow/tests/mocks/storage-domain.ts`：`MemoryKvTable`/`MemoryDomain`/`MemoryStorageDomain`。
- 现有 spec：`microflow/src/step-runner.spec.ts`、`workflow/src/{persistence,remote,schema,workflow-engine,yaml-parser}.spec.ts`。
- **缺口**：无 `subagents`/`agents` 的 mock（Task 3 agent Step 单测需新增 fake `startContinuable`/`whenIdle`/`finalAssistantOutput` 相关桩）；`FakeSession` 尚不支持 `fork`。

---

### 三、DSH 参考 API 落点（已核实 deepseek-harness 源码）

> 硬约束「纯插件，零外部 Agent SDK」要求全用 `ctx.*` 服务。以下签名从 `D:\project-code\llm\deepseek-harness` 实际源码核实。

| DSH 原语 | 实际签名/出处 | Task 3 用途 |
|---|---|---|
| `ctx.subagents.startContinuable` | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`，返回 `{ childId: SessionId, messageId: MessageId }`；`ContinuableStartSpec = { provider, label, request: Omit<SubagentStartRequest,'label'/'signal'/'outputSchema'>, signal }`；`SubagentStartRequest = { prompt: ContentBlock[], parent: Agent, signal, agentOptions?, maxDepth?, toolFilter?, persona? }`（`packages/subagent/subagent/src/continuation.ts` + `types.ts`）。**resolve 时机是 inbox 接受**，非 turn 开始 | agent/skill/mcp Step 创建可续接子代理，首条提示词随 `request.prompt` 投递 |
| `agent.whenIdle` | `whenIdle(): Promise<void>`（`Agent` 接口，`packages/core/agent/src/runtime-types.ts:93`）——当前整轮活动收敛到 quiescence 后 resolve，权威 per-turn 等待原语 | 等待 Step 子代理当前轮完成 |
| `finalAssistantOutput` | `finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] \| undefined`（`packages/subagent/subagent/src/assistant-output.ts:66`）——选最后一条非空 assistant message，无则回退累计 assistant 文本 | 读 Step 子代理最终输出 |
| `ctx.agents.get` / `create` / `resume` | `get(id): Agent`；`create({ sessionId, meta, seed, agentOptions, signal, setup })`；`resume({ resumeSessionId, agentOptions, signal, setup })`（`packages/core/agent`） | hold live child 引用；崩溃恢复 |
| `ctx.subagents.followup` | `followup(parent: Agent, childId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>`；options = `{ source: MessageSource, signal: AbortSignal }`（含冷恢复：absent child 自动 `coldResume`） | 恢复/重试 continue |
| `ctx.subagents.interrupt` | `interrupt(targetSessionId, authority: SubagentInterruptAuthority)`；authority = `{ kind:'ancestor', agent: Agent }` 或 `{ kind:'user', parentSessionId }` | 暂停 |
| `ctx.subagents.start` | `start(name, request: SubagentStartRequest): Promise<SubagentRun>`（一次性子代理） | 分支/finalize 一次性临时会话（备选） |
| `ctx.llm.stream` | `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（已在 step-runner.ts 使用，配 `BlockAssembler`） | 分支评估/finalize 门禁的一次性只读推理 |
| `ctx.sessions.fork` | `fork(source: SessionForkSource, boundary?: number, childSessionId?): Session`（`packages/core/session/src/index.ts:1081`） | FinalizeAssessor 的 fork 会话 |
| `ctx.shell.run` / `ctx.subprocess.spawn` | `ctx.shell.run(spec)`（高层 bash -c，无 stdin 注入）；`ctx.subprocess.spawn`（原始 stdio） | shell Step：简单命令走 shell，stdin 注入/流式走 subprocess（work.md 决策） |

**关键坑位（design.md §2.1 已明确，实现须遵守）**：① 等待轮完成 = 先 `followup` 再 `await child.whenIdle()`，再读 `finalAssistantOutput(child.session.events)`；② hold 住 child 引用（叶子子代理 settle 后被 dispose）；③ `subagent/end` 是 settle（销毁）时发而非每轮；④ settlement notice 会 `parent.followup` 唤醒主代理（消耗 token，需处理副作用）。

---

### 四、Task 3 差距清单（基线 → 目标）

**microflow 需新建 4 个文件 + 改造 1 个：**

1. `step-runner.ts`（改造）：
   - 新增 agent 类型执行路径：`ctx.subagents.startContinuable({ provider, label, request: { prompt, parent, ... } })` → `ctx.agents.get(childId)` → `child.whenIdle()` → `finalAssistantOutput(child.session.events)`。
   - 新增 skill/mcp：工作流级 `skills`/`mcps` 数组名称校验 + prompt 前缀（不匹配回退为纯提示词）；agent 类型校验 `workflow.agents` 数组。
   - promptText 先做 `${xxx}` 透传变量替换（`replacePassThroughVars`）。
   - shell 需 stdin 注入的场景改用 `ctx.subprocess.spawn()`。

2. `branch-evaluator.ts`（新建）：两阶段 start/collect；agent 分支用 `ctx.llm.stream()`，shell 分支用 `ctx.shell.run()`；`extractExpectation`（JSON→regex→raw）/`extractBreakResult`（public，供 checkLoopBreak）/`matchesExpectation`。

3. `loop-manager.ts`（新建）：`activeLoopStack`/`activeLoopIterationStack`、`getActualStepId`/`stripIdSuffix`/`loopIdSuffix`（4 位 hex）、`pushEntryToActiveLoop`（扁平 executedSteps + loopIteration + loopMeta）、`checkLoopBreak`（maxIterations 硬上限 + breakCondition 两阶段）、`buildLoopIterationPath`。

4. `finalize-manager.ts`（新建）：`FinalizeAssessor`（fork 会话 `ctx.sessions.fork` 完成判定 + 透传变量提取 + ask 转换）+ `GateEvaluator`（独立新 session 双门审查）。

5. `file-utils.ts`（新建）：`replacePassThroughVars`/`globToRegex`/`findFilesByGlob`/`findFilesByRegex`/`walkDir` + OutputTo 产物搜索（写入 `{uuid}_output.json`）。

**workflow 需改造 1 个：**

6. `dag-navigator.ts`（改造）：新增 `resolveNextNodes`（优先级 Loop > Branches > Next > `tryAdvanceStage` 跨阶段隔离）；`evaluateBranches` 接入 BranchEvaluator；循环触发（`DagNodeRef.loop` 存在时）。

**schema/错误码需小幅扩展：**

7. `schema.ts`：`FinalizeMetaSchema` 缺 `completionType`/`assessResult`/`gateResult`（design.md §10.7）；可补 `FinalizeAssessResult`/`GateEvalResult`/`FinalizeOutcome` 类型（当前 `types.ts` 尚无）。
8. `errors.ts`：补 `FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST` 错误码（overall-design §4.4）。

**验证标准（work.md）逐条对应：** agent Step 可续接子代理跑一轮 + inputFrom 引用前置输出 + 产物 `{uuid}_output.json`；分支路由 + `loopIteration`（嵌套 `[1,2]`）+ maxIterations 硬上限；Finalize 透传变量 + `completionType` + 门禁 + `ask` → `AskUserQuestionPayload`；带分支+循环+门禁+透传变量的完整 DAG YAML 端到端。
