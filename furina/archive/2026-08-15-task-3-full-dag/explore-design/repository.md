# Task 3 完整 DAG — 仓库材料探索报告

> 探索类型：repository
> 目标仓库：`D:\project-code\llm\sandore`（sandore DSH 插件仓库）+ `D:\project-code\llm\deepseek-harness`（DSH 参考源码）
> 任务来源：`docs/design/task-3-full-dag/work.md`
> 输出文件：`furina/changes/task-3-full-dag/explore-design/repository.md`

---

## 一、需求理解（Phase 2）

### 1. What（要理解什么）

Task 3 在 Task 2 线性执行（shell/prompt Step + Stage 级线性推进）之上，补齐**完整 DAG 执行能力**：

1. **agent/skill/mcp Step**：agent 类型用 `ctx.subagents.startContinuable()` 创建**可续接子代理**承载完整多轮会话，`child.whenIdle()` 等待本轮完成，`finalAssistantOutput(child.session.events)` 读取最终输出；skill/mcp 用工作流级 `skills`/`mcps` 数组做名称校验 + prompt 前缀。
2. **分支评估**（BranchEvaluator）：两阶段 start/collect，agent 分支用 `ctx.llm.stream()`、shell 分支用 `ctx.shell.run()`；`extractExpectation`/`matchesExpectation`。
3. **循环/嵌套循环**（LoopManager）：`activeLoopStack`/`activeLoopIterationStack`、ID 后缀、`checkLoopBreak`（maxIterations + breakCondition）、扁平 `executedSteps` + `loopIteration`/`loopMeta`。
4. **Finalize 拆分**：`FinalizeAssessor`（fork 会话完成判定 + 透传变量提取 + ask 转换）+ `GateEvaluator`（独立新 session 双门审查）。

产出落在两个包：

- `packages/sandore/microflow/`：`step-runner.ts`（补 agent/skill/mcp）、`branch-evaluator.ts`（新）、`loop-manager.ts`（新）、`finalize-manager.ts`（新）、`file-utils.ts`（新：变量替换 + glob→regex + OutputTo 产物搜索）。
- `packages/sandore/workflow/`：`dag-navigator.ts`（补 `resolveNextNodes`，优先级 Loop > Branches > Next > `tryAdvanceStage` 跨阶段隔离）。

### 2. Boundaries（探索范围）

- 范围：sandore 仓库当前代码状态（Task 2 已落地文件）+ `./furina/` 归档（Task 1/Task 2 历史参考）+ Task 3 权威规格（`docs/design/task-3-full-dag/design.md`）+ `docs/engine/dsh-workflow.md` §5.3/§5.3A/§5.2 + `docs/design/overall-design.md` D1–D9/§4.3.1 + DSH 源码中 Task 3 所需 `ctx.*` 服务（`ctx.subagents`/`ctx.agents`/`ctx.sessions.fork`/`ctx.llm.stream`）。
- 不在范围：交互（问答/权限/askUserQuestion 的回复路径）、暂停/恢复/重试、崩溃恢复、宿主主代理、前端 UI（Task 4/5）。

### 3. Goal（探索目的）

准确掌握 Task 3 的落点与 DSH API 真实面，回答：

- Task 2 已落地代码的确切状态（哪些文件/字段已就绪，哪些是 Task 3 的新增/改造点）。
- agent Step 可续接子代理的精确 DSH API（`startContinuable`/`whenIdle`/`finalAssistantOutput`/`followup`/`interrupt`）。
- Finalize fork 会话的 DSH fork 原语（`ctx.sessions.fork`）真实签名。
- 分支/循环评估临时推理（`ctx.llm.stream()`）与 shell 分支（`ctx.shell.run()`）的现状可复用面。
- 当前依赖声明缺口（Task 3 需新增的 peerDependencies）。

---

## 二、仓库材料配置与历史参考（Phase 3）

### 2.1 仓库材料配置

`furina config show exploration.repository` 返回单元素：

```json
[{ "path": "./furina/", "type": "directory", "description": "The location of Furina Artifacts ... archived changes and ongoing changes ..." }]
```

探索 `./furina/` 结果：

- `furina/changes.json`：当前 active change = `task-3-full-dag`（`features: 0`、`todo: 0`、`artifacts: []`）；archive = `task-1-skeleton`、`task-2-minimal-engine`（均已 closed）。
- `furina/changes/task-3-full-dag/` 目录当前为空（本探索产出目录 `explore-design/` 为新建）。
- `furina/archive/2026-08-15-task-1-skeleton/` 与 `furina/archive/2026-08-15-task-2-minimal-engine/` 含完整归档（proposal/design/api/plan/specs/explore-design/explore-coding）。

### 2.2 历史归档要点（Task 3 沿用）

> 由 `furina/archive/2026-08-15-task-2-minimal-engine/design.md` + `explore-design/repository.md` 汇总。

- **命名空间（Task 1 确立，贯穿所有 Task）**：`ctx.sandoreEngine`（Service）/ `sandore/*`（13 事件，**Session 事件**，`session.append` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`）/ `sandore.*`（RPC）/ `sandore_*`（工具，Task 4）/ 4 包。
- **Task 2 已交付并验证**：类型体系（Zod schema 三层）+ YAML V1/V2 解析 + 定义/Job/实例 CRUD + `sandore` 存储域三表持久化 + shell/prompt Step 线性执行。
- **Task 2 明确留白给 Task 3**：agent/skill/mcp Step（`ctx.subagents.startContinuable()`）、分支/循环（BranchEvaluator/LoopManager）、finalize（FinalizeAssessor/GateEvaluator）、门禁、透传变量提取。
- **关键决策（D3）**：Step 的「AI 会话」用 `ctx.subagents.startContinuable()` 可续接子代理（非临时 `ctx.llm.stream()`）；分支评估/finalize 的一次性只读临时会话用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`。

---

## 三、sandore 仓库现状（Task 2 已落地代码，Task 3 承接面）

`packages/sandore/` 已存在 4 个包，其中 `workflow`/`microflow` 已有实质实现：

```
packages/sandore/
├── workflow/src/
│   ├── index.ts          # 默认导出 SandoreEngineRuntime；re-export types/errors/schema/yaml/shell/seam/dag-navigator
│   ├── types.ts          # 13 基础类型 + 深层类型（CommandConfig 等已从 schema.ts 收紧）
│   ├── schema.ts         # 三层 Zod Schema + 派生 TS 类型（定义/运行时/存储）
│   ├── yaml-parser.ts    # parseWorkflowYaml / serializeWorkflowYaml（V1/V2 + Zod + 引用完整性）
│   ├── persistence.ts    # SandorePersistence：sandore 域三表（definitions/jobs/state）
│   ├── remote.ts         # SandoreRemote：定义/Job/实例 CRUD + 产物 + Provider 转发
│   ├── workflow-engine.ts# SandoreEngineRuntime：Stage 级线性主循环
│   ├── dag-navigator.ts  # WorkflowDagNavigator：nodeIndex + tryAdvanceStage（仅 Stage 级线性）
│   ├── seam.ts           # SandoreEngine 抽象类 + 13 事件双声明 + SandoreEngineStub
│   ├── shell.ts          # ctx.shell 本地结构类型接缝（resolve/run/start + ShellRunResult）
│   └── errors.ts         # re-export microflow 的 SandoreError
├── microflow/src/
│   ├── index.ts          # export errors / step-runner / stage-executor
│   ├── stage-executor.ts # StageExecutor：Stage 内 steps 数组顺序线性执行
│   ├── step-runner.ts    # StepRunner：仅 shell/prompt（agent/skill/mcp 抛 unsupported）
│   ├── errors.ts         # SandoreError + SandoreErrorCode + isFatalSandoreError
│   └── internal.ts       # describeError / textSummary（包内工具，不公开）
├── workflow/tests/mocks/ # FakeLlm / FakeShell / FakeSession(Store) / MemoryStorageDomain
├── tool/                 # 空占位（package.json + tsconfig.json）
└── ui/                   # Client 插件（Task 5，本 Task 不涉及）
```

### 3.1 Task 3 改造/新增点的精确现状

#### 3.1.1 `microflow/src/step-runner.ts`（需补 agent/skill/mcp）

现状：`StepRunner.run()` 按 `command.type` 分发，`switch` 只处理 `shell`/`prompt`，`default` 抛 `SandoreError('unsupported step command type ...', 'STEP_EXECUTION')`。

- 已有：`StepRunnerConfig`（`defaultTimeoutMs`/`defaultProvider`/`defaultModel`）、`PreviousStepOutput`、`StepRunRequest`（`step/workdir/originalInput/previousOutputs/signal`）、`StepRunResult`（`output: ContentBlock[]`）。
- 已有：结构化提示词 `buildPromptText`（主头部 + `## 你的任务` + `## 参考信息` + `## 前置Steps输出与产物`，含 `<id><output>缩进</output><artifacts>` 块）。
- 已有：provider/model 三层回退 `resolveProviderModel`。
- **Task 3 需改造**：agent 类型走 `ctx.subagents.startContinuable()` + `child.whenIdle()` + `finalAssistantOutput()`；skill/mcp 做名称校验（`workflow.skills`/`workflow.mcps` 数组）+ prompt 前缀；产物收集 `OutputTo` 与 `${uuid}_output.json`（验证标准要求）。

#### 3.1.2 `microflow/src/stage-executor.ts`（需引入 Stage 内 DAG 流控）

现状：`StageExecutor.execute()` 用 `for (const step of stageDef.steps)` **顺序**执行，无 branch/loop/inputFrom 就近匹配/OutputTo 产物搜索。

- 现状 `synthesizeChildId()`：`childId = step-{stepId}-{execId 前 8 位}`，`sessionMeta = { childId, synthetic: true, command: type }`——Task 3 agent Step 需改为真实子代理 SessionId + `synthetic: false`。
- 现状 `collectPassThroughVars` 仅把 Step 定义里的 `passThroughVars` 声明原样复制为运行时值（未做 finalize 提取）。
- **Task 3 需改造**：Stage 内 Step DAG 调度（`resolveNextNodes` 驱动分支/循环）、`inputFrom` 解析（`stg-x`/`stg-x.step-x`/`stg-x.step-x.opt-x` 就近匹配）、`outputTo` 产物收集（glob/regex 文件搜索）。

#### 3.1.3 `workflow/src/dag-navigator.ts`（需补 `resolveNextNodes`）

现状：只有 `tryAdvanceStage()`（当前 Stage completed 后跟随 `Stage.next` 或按定义数组顺序推断），`buildNodeIndex` 已把 Stage/Step 的 `next/condition/branches/loop` 装入 `DagNodeRef`，但**分支/循环调度未实现**。

- `DagNodeRef` 已含 `condition`/`branches`/`loop` 字段。
- **Task 3 需补**：`resolveNextNodes` 优先级 **Loop > Branches > Next > `tryAdvanceStage`（跨阶段隔离）**（work.md 明确产出点）。

#### 3.1.4 `workflow/src/workflow-engine.ts`（Stage 级主循环 + 事件）

现状：`runInstance` 以 Stage 级 `while (stageId !== '')` 线性循环；`StageStepHooks` 只含 `onStepStart/onStepCompleted/onStepFailed`；`onPersist` 逐 Step 追加 `executedSteps` 并持久化。

- 事件双发已实现（`emitContained` + `session.append`），13 事件中 Task 3 实际用到：`sandore/step-completed` 的 `output` 已是 `ContentBlock[]`（seam.ts 中 Cordis `Events` 与 Session `SessionEventMap` 均已声明 `output`，**与 work.md「step-completed 增补 output」已就位**）。
- **Task 3 需改造**：Step 执行改为真实子代理（childId 从合成改为 `startContinuable` 返回的 `childId`）；`step-completed` 的 `output` 取 `finalAssistantOutput(childSession.events)`；透传变量从 finalize 提取回写 `passThroughVars`。

#### 3.1.5 schema.ts / types.ts（大部分已就绪，两处缺口）

已就绪：

- `CommandConfigSchema` 五类型（agent/prompt/shell/skill/mcp）discriminated union 已完整定义。
- `WorkflowDefinitionSchema` 已含 `skills[]/mcps[]/agents[]`（默认 `[]`）——skill/mcp 名称校验的数据来源已就绪。
- `DagBranchSchema`（`expectation?/next/label?`）、`DagLoopSchema`（`breakCondition?/breakExpectation?/next?/maxIterations/exitTo?`）、`GatesSchema`（`primary/secondary`）已就绪。
- `WorkflowTaskStateSchema` 已含 `activeLoopStack[]/activeLoopIterationStack[]/activeLoopNodeId/visitCounts/pendingQueue/passThroughVars/pausedStepIds/stageContracts`。
- `ExecutedStepDefaultSchema` 已含 `loopIteration?: number[]`、`loopMeta?: BranchMeta`、`branchMeta?`、`finalizeMeta?`、`sessionMeta?`、`stepId?`。
- `BranchMetaSchema` 已含 `result/sessionId/directory/status('evaluating'|'completed')/expectation`。
- `types.ts` 已含 `AskUserQuestionPayload`（对齐 DSH `ask_user_question` schema）、`PendingQuestion`、`StageContract`。

缺口（Task 3 需补）：

- `FinalizeMetaSchema` 当前仅 `{ status: 'evaluating'|'completed'|'ask', sessionId?, gateSessionId?, directory?, errorDetail? }`，**缺** design.md §10.7 的 `completionType?`/`assessResult?`/`gateResult?`。
- `FinalizeAssessResult`/`GateEvalResult`/`FinalizeOutcome` 三个类型（design.md §10.4–10.6）**未在 types.ts/schema.ts 定义**（`ask` 完成类型的承载结构需新增）。

### 3.2 依赖声明现状（Task 3 缺口）

- `workflow/package.json` peerDeps 已含 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-typert-protocol` 等；**未声明 `@deepseek-ai/dsh-subagent`**（`finalAssistantOutput`/`ContinuableStartSpec`/`SubagentInterruptAuthority` 等类型的来源包）。
- `microflow/package.json` peerDeps 仅 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-llm`；Task 3 的 agent Step（`ctx.subagents` 接缝 + `finalAssistantOutput`）与 fork/finalize（`SessionId`/`SessionEvent`）需新增 `@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session` 相关声明（或按 `shell.ts` 的「本地结构类型接缝」范式自声明 `ctx.subagents`）。
- 现状 `ctx.subagents`/`ctx.agents` **尚无本地接缝文件**（`shell.ts` 只为 `ctx.shell` 声明了结构类型；`ctx.llm` 用 `dsh-llm` 真实类型）。Task 3 需按同一范式补齐。

---

## 四、Task 3 权威规格要点（`docs/design/task-3-full-dag/design.md`）

> 该文档从 `dsh-workflow.md` + `dynamic-workflow-engine.md` 提取重组为自包含规格（11 节）。以下仅列与实现落点直接相关要点。

### 4.1 Command 类型映射（§1）

| Command | sandore 实现 | DSH 实现 |
|---|---|---|
| `agent` | SDK createSession + sendChat + SSE | `ctx.subagents.startContinuable({...})` 子代理 + `send()`，事件经 DSH 事件系统 |
| `prompt` | 同上 | `ctx.llm.stream()` |
| `skill` | SDK 技能名 | DSH `ctx.skill` 或保持 prompt 前缀（校验 `workflow.skills` 数组，不匹配回退纯提示词） |
| `mcp` | SDK MCP 名 | DSH `ctx.mcp` 或保持 prompt 前缀（校验 `workflow.mcps` 数组，不匹配回退） |
| `shell`（简单） | `child_process.exec` | `ctx.shell.resolve()` + `ctx.shell.run()`（`bash -c`） |
| `shell`（stdin/流式/终端） | exec + stdin | `ctx.subprocess.spawn()`（原始 stdio） |

> **决策 D3**：Step 的 AI 会话用 `ctx.subagents.startContinuable()` 可续接子代理（完整多轮：工具调用/权限/问答/暂停恢复/崩溃恢复，parent 归属 + 持久化，冷恢复 `ctx.agents.resume({ resumeSessionId })`）；分支评估/finalize 的一次性只读临时会话用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`。

### 4.2 Step 会话生命周期时序（§2，DSH 可续接子代理）

```
const started = await ctx.subagents.startContinuable({ ... })   // { childId, messageId }
const child = ctx.agents.get(started.childId)                   // hold 住 live Agent 引用
await child.whenIdle()                                          // ★ 权威 per-turn 原语
读取输出：finalAssistantOutput(child.session.events)            // 最后一条非空 assistant
```

> 四个坑位（设计文档明确）：① 先 followup 再 whenIdle（idle 可能「未开始」）；② hold 住 child 引用（叶子子代理 settle 后被 dispose）；③ `subagent/end` 是 settle（销毁）时发、非每轮，复用 childId 多轮须用 `turn/end` 关联；④ settlement notice 会 `parent.followup` 唤醒主代理（消耗 token，需处理副作用）。

### 4.3 SDK 能力全量映射（§3，零外部 SDK）

原 `engine/internal/sdk/`（client/session/sse-manager/utils）**整层删除**：`createSession → ctx.subagents.startContinuable()`；`sendChat → ctx.subagents.followup()`；`abortSession → ctx.subagents.interrupt(childId, {kind:'ancestor', agent:hostAgent})`；`forkSession → ctx.sessions.fork(childId, boundary?)`；`startTempSession → ctx.llm.prepareCall()+stream()`；权限规则 → DSH permission presets（子代理继承父级，approval 固定 `never`）。

### 4.4 输入/产物（§4/§5）

- `InputFrom` 路径：`stg-xxx`（Stage 级）/ `stg-xxx.step-xxx`（Step 级）/ `stg-xxx.step-xxx.opt-xxx`（OutputTo 级）；就近匹配算法 `resolvePathSegments`（扁平化 `executedSteps` 递归展开循环 → 从当前 Step 往前搜索，`idMatches` 支持后缀匹配 `actualId.startsWith(targetId+'-')`）；无 `inputFrom` 回退前一个 Step。
- `OutputTo`：`{ id, path?, regex? }`；glob（`*`/`?` 且无 regex 特征）vs regex 自动区分；`globToRegex`（`* → [^/]*`、`** → .*`、`? → [^/]`）；产物收集写 `{stepMessageId}_output.json`（结构 `{ sessionId, output: { returnPrompt, artifacts: [{id, value: string[]}] } }`）。
- 文件搜索函数落 `file-utils.ts`：`findFilesByGlob/findFilesByRegex/walkDir/globToRegex/escapeRegexChar` + 变量替换 `replaceVars`/`replacePassThroughVars`。

### 4.5 分支评估器（§7）

- 两阶段：`start(condition, contextMessage)` → `collect(partial)`；shell 分支 `ctx.shell.run()`（透传变量替换 + 环境变量注入 + stdin 注入），agent/prompt/skill/mcp 分支 `ctx.llm.stream()` 临时会话。
- 输出解析：`extractExpectation(raw)`（JSON `branchExpectation` → regex 回退 → 原始输出）；`extractBreakResult(raw)`（public，JSON `shouldBreak` → regex 回退）。
- `BranchEvalResult { output, sessionHandle }`；构造可带 `jobId/taskId/stepId`。

### 4.6 循环与嵌套循环（§8）

- 循环扁平化（V2.3）：无 `ExecutedStepLoop` 容器；迭代直接以 `ExecutedStepDefault`（`id = 原始ID-4位hex后缀`、`stepId = 原始ID`、`loopIteration = buildLoopIterationPath()` 如 `[1,2]`、`loopMeta`）入扁平 `executedSteps`。
- `WorkflowLoopManager` 字段：`activeLoopStack[]`/`activeLoopIterationStack[]`/`pendingLoopNodeId`/`pendingLoopMeta`/`stepIdSuffixMap`。
- `checkLoopBreak(node)` 优先级：① `visitCount >= maxIterations` 硬上限立即跳出；② `breakCondition` 两阶段评估（注入 `<input>/<output>/<artifacts>` XML 块），shell 模式 `matchesExpectation(breakResult, breakExpectation)`，agent 模式 `breakResult === 'true'`。
- `resolveNextNodes` 触发循环逻辑，`loopTo` 优先级：`loop.next` > 分支评估结果 > `node.next`（仅同阶段）。

### 4.7 Finalize 拆分（§9）

- **第 1 部分 FinalizeAssessor**：session 类型 Step fork 会话（`ctx.sessions.fork(stepSessionId, boundary?)`，boundary 不能落在未闭合 turn 内）+ 透传变量提取 + 完成判定（`completionType: 'completed'|'ask'`）+ ask 转换（`askQuestion` 对齐 DSH `ask_user_question` schema）；shell 类型 Step 用 `ctx.llm.stream()` 临时会话（shell stdout 作输入）。
- **第 2 部分 GateEvaluator**：独立新 session（`startTempSession`），primary gate（产物存在 + 基本完成度 → `{taskStatus:'done'|'error', errorDetail}`）/ secondary gate（`secondaryEnabled=true` 注入 `secondaryPrompt` → `{gateStatus:'done'|'error', gateDetail}`）。
- `finalizeStep` 编排：跳过检查 → assessor.assess → completionType 分支（ask 注入 InteractionManager → Step 进入 interacting；completed 继续门禁）→ gateEvaluator.evaluate → gatesPassed 判定 → 回写 passThroughVars → persistState。
- 结果类型：`FinalizeAssessResult`/`GateEvalResult`/`FinalizeOutcome`/`FinalizeMeta`（扩展字段，见 3.1.5 缺口）。

### 4.8 验证标准（§11 / work.md）

1. agent Step 可续接子代理真实跑一轮，`inputFrom` 引用前置输出正确，产物收集到 `{uuid}_output.json`。
2. 分支正确路由；循环迭代路径 `loopIteration` 正确（嵌套为数组 `[1,2]`）、maxIterations 硬上限生效。
3. Finalize：透传变量提取 + `completionType`（completed/ask）+ 门禁审查 + `ask → AskUserQuestionPayload`。
4. 完整 DAG 端到端：带分支 + 循环 + 门禁 + 透传变量的 YAML → 执行 → 正确路由/迭代/收尾 → 工作流完成。

---

## 五、DSH 源码关键 API 实证（Task 3 依赖，源码 `D:\project-code\llm\deepseek-harness`）

### 5.1 `ctx.subagents.startContinuable`（`packages/subagent/subagent/src/index.ts`）

```ts
async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
// ContinuableStart = { childId: SessionId, messageId: MessageId }
// ContinuableStartSpec = { provider: string, label: string, request, signal: AbortSignal }
//   request: Omit<SubagentStartRequest, 'label'|'signal'|'outputSchema'>
//   SubagentStartRequest 含 { label?, prompt: ContentBlock[], parent: Agent, signal, agentOptions?, persona?, toolFilter?, maxDepth?, ... }
```

- 在 inbox 接受初始提示词时 resolve（**不等待轮次开始**）；首条提示词随 `request.prompt` 投递。

### 5.2 `whenIdle`（`packages/core/agent-loop/src/agent.ts:195`）

```ts
async whenIdle(): Promise<void>   // 循环等待 activityDone 收敛；Activity 未开始时也会立即 idle
```

### 5.3 `finalAssistantOutput`（`packages/subagent/subagent/src/assistant-output.ts`，包 `@deepseek-ai/dsh-subagent`）

```ts
function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
// 规则：选最后一条非空 assistant/message 的 content；无则聚合 assistant/chunk text-delta 文本；都没有返回 undefined
```

### 5.4 `ctx.subagents.followup` / `interrupt`

```ts
followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>
//   SubagentFollowupOptions = { source: MessageSource, signal: AbortSignal }
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void
//   SubagentInterruptAuthority = { kind:'user', parentSessionId: SessionId } | { kind:'ancestor', agent: Agent }
```

- `followup` 对 absent child 自动从持久化 Session 冷恢复（崩溃恢复时无需显式 `ctx.agents.resume()`）。

### 5.5 `ctx.sessions.fork`（`packages/core/session/src/index.ts:1081`）

```ts
fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
// SessionForkSource = Session | SessionId
// boundary = inclusive source seq；省略 = 源当前最后一条事件；不能落在未闭合 turn 内（否则 OPEN_TURN 错误）
```

### 5.6 `ctx.llm.stream`（Task 2 已实证，复用）

`ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`GenerateOptions` 需 `provider`+`model`+`messages: Message[]`（可带 `signal`/`sessionId` 等）；chunk 聚合用 `block-start`/`text-delta`/`block-end`/`finish`（`finish.reason.kind === 'error'|'aborted'` 为终端失败）。sandore 已封装 `BlockAssembler` + `createUserMessage`（`@deepseek-ai/dsh-llm`）聚合 `ContentBlock[]`。

### 5.7 测试基建现状（`packages/sandore/workflow/tests/mocks/`）

- `FakeLlm`（`textChunks()` 固定 chunk 流 + 可注入 `streamHandler`）、`FakeShell`（可注入 `resolveHandler`/`runHandler`）、`FakeSession`/`FakeSessionStore`（记录 `append`）、`MemoryStorageDomain`/`MemoryKvTable`（内存版三表）。
- **Task 3 需新增 mock**：`ctx.subagents`（`startContinuable`/`followup`/`interrupt`/`getProvider` 等）、`ctx.agents`（`get` 返回带 `whenIdle`/`session.events` 的 fake Agent）、`ctx.sessions.fork` 的 FakeSession 扩展。
- 测试框架：vitest（根 `vitest.config.ts`，include `packages/**/*.spec.ts`），现有 `step-runner.spec.ts` 以 `ctx.provide('llm'/'shell', …)` 注入 mock 的范式可沿用。

---

## 六、关键结论

1. **Task 2 已就绪的底座**：五类 `CommandConfig` schema、`skills/mcps/agents` 数组、`DagBranch/DagLoop/Gates` schema、`WorkflowTaskState` 的循环/透传/队列字段、`BranchMeta`/`loopIteration`/`loopMeta`/`finalizeMeta` 字段、13 事件（`step-completed` 已带 `output: ContentBlock[]`）、provider/model 三层回退、`ctx.shell` 接缝——均为 Task 3 的现成数据面，**主要工作在运行逻辑而非 schema**。

2. **Task 3 新建文件 4 个（microflow）**：`branch-evaluator.ts`、`loop-manager.ts`、`finalize-manager.ts`、`file-utils.ts`；**改造文件 2 个**：`microflow/src/step-runner.ts`（agent/skill/mcp）、`workflow/src/dag-navigator.ts`（`resolveNextNodes`），另需 `stage-executor.ts`/`workflow-engine.ts` 相应接入 DAG 流控与真实子代理 childId。

3. **schema/types 两处缺口**：`FinalizeMetaSchema` 需补 `completionType/assessResult/gateResult`；需新增 `FinalizeAssessResult`/`GateEvalResult`/`FinalizeOutcome` 类型（`AskUserQuestionPayload` 已存在）。

4. **依赖缺口**：`microflow`（仅 cordis+llm）与 `workflow`（缺 `@deepseek-ai/dsh-subagent`）需补 subagent/agent/session 相关 peerDependencies，或按 `shell.ts` 范式自声明 `ctx.subagents`/`ctx.agents` 结构接缝。

5. **DSH 原语已逐一确认**：`startContinuable`（inbox 接受即 resolve，返回 `{childId,messageId}`）→ `ctx.agents.get(childId)` hold 引用 → `child.whenIdle()` → `finalAssistantOutput(child.session.events)`；finalize fork 用 `ctx.sessions.fork(source, boundary?)`（boundary 不能落未闭合 turn）；分支/门禁临时推理用 `ctx.llm.stream()`。

6. **验证标准落点**：agent Step 真实子代理 + `inputFrom` 就近匹配 + `{uuid}_output.json` 产物 → §4.2/§4.4；分支路由 → §4.5；循环扁平化/ID 后缀/`loopIteration`/maxIterations → §4.6；Finalize 两部分 + ask → §4.7。
