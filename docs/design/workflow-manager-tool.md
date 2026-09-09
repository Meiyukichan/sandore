# sandore 工作流统一管理工具（workflow manager tool）—— 调研结论与实现方案

> 状态：调研 + 双代理复核 + 需求决策全部完成（2026 评审已拍板，见 §6），可进入实现。范围：本文件为最终方案（含关键代码片段）；实现步骤见 §5。
> 目标：参照 DSH 的动态工作流 `workflow` 模型工具，把 sandore 注册为**一个**模型可直接调用的工具，用**一个 schema 字段（action）**区分 4 大类操作，并为编排配套「库浏览」（`lib-list`/`lib-get`，§2.3）。

---

## 0. TL;DR（结论摘要）

| # | 你要的能力 | 落地形态 | 底层直接复用什么 |
|---|---|---|---|
| 1 | 工作流定义详情查询（可定点 workflow/stage/step，stage/step 需合并） | `action='get-def'` | `sandorePersistence.definitions` + `parseWorkflowYaml` + 引擎/UI 同款「流控位 × 顶层定义」合并语义 |
| 2 | 工作流定义编排（定点 update workflow/stage/step） | `action='update-def'` | 同一份 yaml 的解析→节点替换→`serializeWorkflowYaml`→`definitions.put`（对齐 `remote.updateYaml` 路径） |
| 3 | 运行工作流（把当前会话主代理 session id 等信息传入实例创建） | `action='run'` | `sandoreEngine.startInstance(DagStartRequest)`——**`hostSessionId` 字段引擎早已支持**（见 §1.4） |
| 4 | 查询工作流当前状态（可定点 stage/step 的执行状态与结果） | `action='get-state'` | `sandoreEngine.getInstanceState`（内存优先）→ `persistence.state` 兜底（同 `getInstanceState` RPC 语义） |
| 5 | 库浏览：查询已有 工作流定义 / Step 库(UI「Agent 库」) / 微流程库(UI「Microflow 库」)——编排引用的数据源（2026 评审新增） | `action='lib-list'` / `'lib-get'` | `persistence.definitions/steps/microflows` + definitions 引用反扫（对齐 `remote.listSteps/listMicroflows/getStep/getMicroflow` 语义） |

**注册方式结论**：不是再往 `packages/tool` 堆一个「实例内工具」，而是在 workflow 引擎插件 `[Service.init]` 里仿照 `ask-tool.ts` 的 `registerGlobalAskTool` 做**全局 `ctx.tools.register` + execute 期 gate**——插件装上后，任何顶层主代理会话的模型就能直接调用；不需要改 agent preset、不需要改 RPC/UI。

**你问的「能不能传 sessionid」结论**：能，而且这是引擎的一等能力。`DagStartRequest.hostSessionId`（`packages/workflow/types.ts:139-161`）就是干这个的：传了 → 复用调用方已存在的宿主主代理会话作为本实例 hostAgent（不新建）；没传 → 引擎以 `instanceId` 为会话 id 新建一个独立的宿主会话（= 现在 Web UI「新建实例」的行为）。工具内通过 `exec.agent.session` 拿到当前会话。详见 §1.4。

**寻址规则结论**：stage/step 的 id 只在单个 workflow 的 yaml 内唯一（同 id 可以被多个 workflow 内联/展开成快照），所以 stage/step 级操作一律必传 `workflowId`——这正是你提的硬约束；step 在同一 workflow 内还可能出现在多个 stage 流控位里：**读取**（get-def/get-state）可只给 stepId（多 slot 时返回全部）；**编辑**（update-def）**必传 stageId** 消歧（见 §1.3、§2.3）。

**三级分离复核结论（2026 评审，双代理源码复核确认）**：单个 workflow 的全部定义始终**完整、自包含**在 `definitions` 表记录的 yaml 内（stages 流控位 + 顶层 `steps[]` 全量定义）；`steps`/`microflows` 库表只是工作流保存时 best-effort 复制出来的**快照辅助容器**；编排期「引用/挂载」= 把库内容**复制**进目标 workflow 的 yaml；引擎运行期对库表**零读取**、库条目后续修改**无反向通道**影响已保存 workflow（详见 §1.2 补强）。

---

## 1. 调研证据

### 1.1 DSH 的 `workflow` 模型工具是怎么注册的（参考对象）

参考源码：`deepseek-harness/packages/workflow/tool-workflow/src/index.ts`（本会话可直接调用的 `workflow` 工具即是它）。

关键机制（逐条对应到文件行）：

1. **宿主插件级注册**：插件 `inject = ['tools', 'workflowEngine', 'systemPrompt']`（声明于 DSH 源 `index.ts:29`）；`apply` 为 `index.ts:204-334`，其中 `ctx.tools.register(defineTool({ ... }))` 自 `:216` 起。即注册是「host 插件全局注册」，模型在所有会话都能看到该工具。
2. **工具定义形状**：`name / description / parameters / output / execute / presentCall / presentResult`。注意（审计精确化）：DSH 源文件里 parameters/output 写的是 **per-property `required: true` 简写 DSL**（`index.ts:219-265`）——规范化（required 字符串数组只在 object 节点、output 用 `additionalProperties: false` + `type: 'json'` 子集）发生在注册前：`defineTool` 转换（dsh-tools `schema.ts:566-567`）+ `tools.register` 对 output.schema 跑 `assertSupportedJsonSchema`（dsh-tools `index.ts:1036`，子集规则 `json-schema.ts:200-224`）。**sandore 因绕开 defineTool 直传普通对象，才必须自带规范化形态**（与 `ask-tool.ts:119-120/150-151` 注释闭环）。`output.render` 负责把结果转 `ContentBlock[]`。
3. **execute 上下文**：`execute(args, exec)`，`exec.agent` = 调用方代理、`exec.signal` = 当前 turn 取消信号（`index.ts:271-289`）。执行体把 `parent: exec.agent`、`signal` 传进引擎 `ctx.workflowEngine.start(...)`，await 结果后统一 `dispose`；非 `completed` 的 stopReason 映射成工具错误。
4. **使用政策跟随工具**：`ctx.systemPrompt.section(...)` 注册一条 prompt section 说明「只在用户明确要求 workflow/大规模多代理编排时用」（`index.ts:211-215`）。
5. **描述即契约**：DESCRIPTION 里完整写明 meta/script/hooks 语义（`index.ts:137-149`），模型靠描述学会调用。

DSH 侧注册代码骨架（引用形状，非 sandore 最终代码）：

```ts
// deepseek-harness/packages/workflow/tool-workflow/src/index.ts:216-333（节选）
ctx.tools.register(defineTool({
  name: toolName,                       // 默认 'workflow'
  description: DESCRIPTION,
  parameters: {
    script: { type: 'string', required: true, description: '…' },
    meta:   { type: 'object', required: true, properties: { … } },
    // …
  },
  output: {
    schema: { type: 'object', additionalProperties: false, required: ['runId', …], properties: { … } },
    render: (args, value) => [{ type: 'text', text: renderResult(…) }],
  },
  async execute(args, exec) {
    const parent = exec.agent
    if (!parent) throw new Error('workflow tool requires a calling agent')
    const run = ctx.workflowEngine.start({ script: args.script, meta: args.meta, parent, signal: exec.signal })
    // … await run.result → 返回 { runId, agentsStarted, result }
  },
}))
```

**sandore 侧的既有惯例**（与 DSH 的形状差异，需遵守，避免引入风格断层）：

- `packages/workflow/ask-tool.ts` 是 sandore 目前唯一的「全局注册工具」前例：
  - 不 import `@deepseek-ai/dsh-tools` 运行时（注释明确「结构兼容 DSH `ToolDefinition` 的普通对象，遵循 sandore 接缝哲学」，`ask-tool.ts:27-31`）；
  - `registerGlobalAskTool(ctx, host)` 用 `ctx.get('tools')` 取全局注册表（`tools` 服务缺失时静默跳过，返回空 disposer，`ask-tool.ts:204-213`），在引擎 `[Service.init]` 里以 `ctx.effect(...)` 挂载（`workflow-engine.ts:360`）；
  - 「全局注册 + execute 期 gate」取代已删除的 child-scope 注入通道：execute 里校验调用方身份，不命中抛清晰错误（`ask-tool.ts:174-190`）；
  - parameters/output 用**规范化 JSON Schema**：`required` 只在 object 节点上用字符串数组（`ask-tool.ts:118-172`，注释：旧 `required: true` 子属性简写「非标准，传给 LLM 不可靠」）。
- `packages/tool/index.ts` 的 8 个实例级 `sandore_*` 工具（`createSandoreTools`）是**另一种形态**：per-instance 闭包工具，设计给「实例宿主主代理」用，`execute` 全部转调 `SandoreEngineSurface`；但 2026-08 探索已定它们**默认不注册**（`host-agent.ts:14-19`：按钮/RPC 已覆盖，工具 schema 反而占模型上下文）。本需求不沿这条路走，而是走 ask-tool 的全局注册路。

### 1.2 定义域数据模型：「定义和流程分开、查询需合并」的确切含义

sandore 存储域 `sandore` 有 4 张表（`persistence.ts:4-9, 51-78`）：

| 表 | 键 | value | 角色 |
|---|---|---|---|
| `definitions` | `wfl-{uuid}`（workflowId） | `WorkflowDefinitionRecord { yaml, name, version, description?, createdAt, updatedAt }` | 工作流定义，**唯一事实来源**，yaml 全文封顶 65536 字符 |
| `state` | instanceId | `WorkflowTaskState` | 实例持久化快照 |
| `steps` | stepId | `StepRecord` | Step 库（UI 名「Agent 库」）：纯定义子集，无 inputFrom/branches |
| `microflows` | stageId | `MicroflowRecord` | Microflow 库（UI 名「Microflow 库」）：stage 形状子集（steps 流控位 + rules/gates…），**无 Stage 级 branches** |

yaml 内的工作流定义本身是「分离式」的（`schema.ts:143-197`）：

- `WorkflowDefinition { id, name, version, …, stages: WorkflowStage[], steps?: WorkflowStep[] }`
- `WorkflowStage { id, name, …, steps: StageStep[], branches? }`，其中 **`StageStep` 只是流控位 `{ id, branches?, inputFrom? }`**（`schema.ts:165-169`，注释：V2 分离式，仅 id + 流控 branches；完整定义在顶层 `steps[]` 按 id 交叉引用）；
- `WorkflowStep`（顶层 `steps[]` 元素）才是完整定义：`{ id, name?, command?, inputFrom?, outputTo?, passThroughVars?, timeout?, … }`（`schema.ts:143-155`）。

「查询需要合并」的**引擎侧权威语义**在 `workflow-engine.ts:1906-1929`（续跑播种时）有注释和代码：

```ts
// workflow-engine.ts:1918-1923
// 分离式合并：stage.steps 仅流控位（id + branches），完整定义（command/映射等）
// 在顶层 definition.steps，按 id 取合并视图供续跑（resumeSubagentStep 需要 command）。
const definitionStep = active.definition.steps?.find(s => s.id === stepDef.id);
const mergedStep: WorkflowStep = definitionStep === undefined
  ? { id: stepDef.id }
  : { ...definitionStep };
```

UI 侧同一语义的合并函数（DagEditor 画布读取完整字段用）：

```ts
// packages/client/dag-editor-model.ts:28-34
export type MergedStep = WorkflowStep & { branches?: DagBranch[] }

/** 构造某 Stage 的合并 Step 视图：definition.steps[id] 定义字段 + stage.steps[id].branches 流控字段。 */
export function mergedStepsOf(definition: WorkflowDefinition, stage: WorkflowStage): MergedStep[] {
  // 顺序 = Stage 流控位顺序；每个 slot：{ ...definition.steps[id] ?? { id }, branches: slot.branches }
}
```

两个库表与 workflow yaml 的关系：工作流保存时**自动**把内联 stages/steps 按同 id `putIfAbsent` 快照进库（best-effort——触发点在 `remote.ts:136-138`（createDefinition）与 `:188-191`（updateYaml），实现 `persistence.ts:131-172`）；库条目支持独立 get/upsert/delete（库管理 RPC 区块 `remote.ts:253-396`，REFERENCED 守卫同区）；yaml 运行时**自包含**（执行只用 yaml 内数据，不查库表；库表只是复用/速览容器，删除被引用条目会被 `REFERENCED` 挡住）。

**因此对本工具的设计推论**：

- 查/改定义都以「把 `definitions` 表记录 yaml `parseWorkflowYaml(...)` 成 `WorkflowDefinition` 对象」为起点/终点；
- 「合并」指引擎/UI 同款的 **merged step 视图（流控位 branches × 顶层全量定义）**——不要给模型返回原始的两个分离数组让它自己拼；
- stage 级定义 = yaml 中的 `WorkflowStage` 节点本身（其 branches 是 Stage 级出边）；若库表存在同 id 条目，可在返回里附「inLibrary」引用提示（库内容 ≠ 内联内容时的说明），但**不**用库内容覆盖 yaml（避免误导——运行以 yaml 为准）。

**复核补强（2026 评审，子代理源码复核结论）**——「自包含」是**写入路径保证 + 无反向通道**，而非解析/运行期强校验：

- 定义装载只在两处 parse yaml：`startInstance`（`workflow-engine.ts:487-491`）与 `recoverInstance`（`:720-724`）；引擎全程不读 `steps`/`microflows` 表（引擎 persistence 访问点全集 = definitions.get(487/720)、state.get(645/661/713/965)、state.entries()(814)、saveWorkflowState(1677)）；microflow 包只 `import type` workflow schema，从不 import persistence。
- 库表全部写入源 = 工作流保存副作用（`writeDefinitionToLibraries` best-effort 快照，`persistence.ts:138-172`；`remote.ts:135/191` 调用）或 UI「同步到库」显式 upsert；client 绑定 = 把库内容**复制**进编辑态定义（`expandStepBinding` dag-editor-model.ts:481-547、`expandMicroflowBinding` :426-468），保存时整份 yaml 全量写 definitions（DagEditor runSave → serializeWorkflowYaml）。**库条目后续修改不存在任何反向通道**进入已保存 workflow——唯一入口是用户再次显式绑定+保存（新快照）。
- 但 yaml-parser 的引用校验（`validateReferences`，`yaml-parser.ts:175-250`）只查 id 唯一性与引用目标存在，**不强制**每个流控位在顶层 steps[] 有完整定义；引擎对缺定义的 slot 静默退化 `{id}`（`stage-executor.ts:381-383`、`workflow-engine.ts:1921-1923`），真执行到无 command 的 step 才抛 `step '…' has no command`（STEP_EXECUTION，`step-runner.ts:466-468`）。→ **工具描述必须写明**：get-def 的合并视图可能缺 command（旧/异常数据）；update-def 删掉顶层定义会得到「校验通过但跑不动」的工作流，写前应提示「每个被引用的流控位必须有顶层完整定义」。
- 库 key 前缀（`step-{uuid}`/`stg-{uuid}`）只是注释性约定（`persistence.ts:70-78`、`domain.ts:29`），schema 对 id 仅 `z.string()`（schema.ts:541/564），自动入库原样保留 yaml 内任意 id（remote.spec.ts:1236-1237 的 step-1/stg-1 实证）——库浏览/寻址不要假设前缀格式。
- 删除保护（REFERENCED）＝ 任一 definitions yaml 出现该 id 即禁删（`remote.ts:262-288, 342-351, 387-395`），引用关系永远由 definitions 反扫得出，库表无外键/引用图；删除引用方 workflow 定义即解除（remote.spec.ts:1206-1228）。
- 「合并」同款语义还有两处实现锚点：`stage-executor.ts:376-384`、`step-navigator.ts:284-298`——工具合并 helper 须与之行为一致（测试 cross-assert）。

### 1.3 寻址与「stage/step 必须带 workflowId」的根据

- workflow 级 id = `definitions` 表记录键 `wfl-{uuid}`（`remote.ts:125`）。
- stage/step 的 id 在 yaml 内定义；由于库条目可按同 id 被**多个工作流**引用/展开成内联快照（客户端 `expandMicroflowBinding/expandStepBinding` 完整范围 `dag-editor-model.ts:411-547`，把库 id 与字段以快照写进多个 workflow），**同 id 的 stage/step 可以同时存在于不同 workflow 的 yaml 中**——跨 workflow 不唯一。这就是你定「涉及 stage/step 时 workflowId 必传」的合理性，本方案完全照做。
- 进一步的歧义：同一个 workflow 内，同一 stepId 可能出现在**多个 stage 的流控位**（把同一库 step 插进不同 stage 即可）。定稿（Q4）：**读取**（get-def/get-state）step 级可只带 workflowId+stepId，多 slot 时返回全部、不报错；**编辑**（update-def）step 级**必传 stageId**（缺失 → INVALID_OPERATION，错误消息给出该 step 出现的候选 stageId 列表）。
- workflow 内部顶层 `steps[]` 中 step id 理论上也应唯一（按 id 交叉引用），但工具实现仍按「先定位引用、再取定义」做防御性校验。

### 1.4 运行实例 + 传当前会话 session id（问题 3 的完整答案）

证据链（hostSessionId 不是新概念，是引擎既有设计）：

1. `types.ts:139-161` `DagStartRequest`：

```ts
export interface DagStartRequest {
  workflowId: string
  originalInput: string
  cwd: string                     // 必填工作目录：hostAgent 据此 attach web workspace
  model?: StartModelSelection
  permission?: string             // read-only / workspace-write / danger-full-access
  /**
   * 可选：调用方（UI/上层）传入的**已存在宿主主代理会话** id——复用该会话作为
   * 本实例的 hostAgent（不新建）。省略时引擎以 SessionId(instanceId) 新建
   * hostAgent（保持历史行为）。复用场景 hostAgent.id = hostSessionId ≠ instanceId，
   * 冻结/解冻按 hostAgent.id 生效。…
   */
  hostSessionId?: string
}
```

2. RPC wire 层已透传：`wire.ts:133-146` `StartInstanceInputSchema`（含 `hostSessionId: z.string().optional()`）；`remote.ts:418-434` `startInstance` 组装 `DagStartRequest` 时 `...(parsed.hostSessionId === undefined ? {} : { hostSessionId: parsed.hostSessionId })`。remote.spec 锁定该转发行为（`remote.spec.ts:515-525`）。
3. 引擎两种模式（`workflow-engine.ts:498-555`）：
   - **未传**（= Web UI「新建实例」当前路径）：`hostSessionId = request.hostSessionId ?? instanceId`，`ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd, agentPreset }, setup: createHostAgentSetup(...) })` 新建独立宿主主代理会话 → 发布进 `ctx.sessions` → 补设标题 = originalInput → `attachHostAgentToWorkspace`；`reportToHost=false`（ask/permission 只走 discussion composer，`workflow-engine.ts:265-267`）。
   - **传入**：`ctx.agents.get(SessionId(hostSessionId))` 必须命中 live agent（否则 `NODE_NOT_FOUND`）、`ctx.sessions.get` 必须已发布（否则 `INVALID_OPERATION`）；复用后**不重设标题、不重复 attach workspace**（调用方负责）；实例冻结/解冻按 `hostAgent.id`（= hostSessionId）登记；`reportToHost=true`（ask/permission 上报宿主主代理，引擎级 `userQuestions.ask` 以 hostAgent 身份发起，UI 宿主会话可见可答）。
4. 引擎测试锁定这些语义：`workflow-engine.spec.ts:1255-1317`（reuse：no create 1255-1287、freeze applies、ghost host → reject 1309-1317）、`:2602-2633`（复用场景 ask 上报宿主）。
5. 工具侧怎么拿「当前会话」：DSH 工具注册表对模型驱动调用会注入 `exec.agent`（tool-workflow 断言 `exec.agent` 必在，`index.ts:272-278`）。sandore 既有代码以 `exec.agent.session` 访问会话对象（`ask-tool.ts:176` 读 `agent.session.header.parentSession`；引擎 `SessionId(...)` 包装 id）。所以 run 动作里：

```ts
// 目标工具 run 动作的 execute 片段（示意）
const agent = exec.agent
const session = agent?.session           // DSH Session（含 id/header）
const callerSessionId = session?.id      // 实现期以 Inspect/类型为准再确认字段名
```

**取舍（设计决策，Q3 已定）**：run 动作默认「复用调用方会话」——`attachSession` 默认 true（顶层会话自动传 `exec.agent.session.id` 为 hostSessionId），传 false 或非顶层会话则省略 = overlay（引擎新建独立宿主会话，与 UI 新建实例一致）：
- 复用：工作流 step 子代理锚定在当前会话下、ask/权限卡片上报到当前会话——「在当前对话里跑工作流」的体验；代价是**该宿主会话在工作流存活期间被引擎冻结**（`frozenHostAgents` 按 hostAgent.id 登记，`workflow-engine.ts:563-568`），且同一会话后续并发实例共享冻结登记。
- overlay：当前对话零副作用，实例有自己的宿主会话（web sidebar 可见、可交互），但提问不自动上报当前对话（走 discussion composer）。
- 本方案按 Q3 定稿：run 参数暴露 `attachSession?: boolean`（**默认 true**，顶层会话时自动传 `exec.agent.session.id`；传 false 或非顶层会话则省略 = overlay），代码里两种都通，语义差异写进工具描述。默认 true 贴合「把当前会话主代理 sessionid 传递给实例创建」，同时保留逃生口。

### 1.5 状态查询的数据源（问题 4 的依据）

- 全量快照：**「内存优先 → 持久化兜底 → 双无抛 `NODE_NOT_FOUND`」是 `remote.getInstanceState` RPC（`remote.ts:446-451`）的语义**；引擎侧 `getInstanceState`（`workflow-engine.ts:634-636`）**只读内存**（active.state 收尾中间态立即可见），未命中返回 undefined、不抛错。工具按 RPC 语义自行组合：`engine.getInstanceState(instanceId)` → undefined 时 `persistence.state.get(instanceId)` → 皆无抛 `NODE_NOT_FOUND`，无需新 RPC。
- 概要快照：`engine.getState(instanceId)` → `DagInstanceState { taskId, workflowId, status, originalInput, currentStageId, executedSteps, stageInfos, pendingQueue, createdAt, updatedAt }`（`types.ts:173-184`），内存优先、state 表兜底（`workflow-engine.ts:638-650`）。
- 定点数据都在 `WorkflowTaskState`（`schema.ts:479-518`，全字段表）里：
  - stage 定点：`state.stageInfos[id]`（id/name/status）+ `state.stageContracts[id]`（完成契约：artifacts/passThroughVars/contractArtifacts/completedAt/errorDetail，`schema.ts:461-476`）+ `executedSteps` 按 `stageId` 过滤；
  - step 定点：`state.executedSteps` 中按 `stepId`（+`stageId`/`attemptIndex`/`loopIteration`）过滤，字段含 `status/command/output: ContentBlock[]/artifacts/sessionMeta.childId（可深链到子代理会话）/finalizeMeta（收尾阶段）/error/retryHistory/sessionMessages/pauseEntryId/branchMeta/loopMeta/parentSessionId`（`schema.ts:417-452`；`types.ts:186-220` 同形）；
  - 同 stepId 多次执行（重试/循环）产生多个 segment：`attemptIndex`（0-based）+ `createdAt` 排序；默认返回最新段，可带 `attemptIndex` 精确取。
- 结果体积控制：`output`/`sessionMessages` 可能很大，工具默认只回摘要（长度/条数 cap），需要全文时用参数放开（§2.3 的 `includeDetail`）。

---

## 2. 目标设计

### 2.1 总体形态

- **一个全局模型工具**，注册名 **`sandore_workflow`**（Q1 已定：前缀延续 `sandore_*`；与 DSH 的 `workflow` 工具、与实例级 8 工具都不冲突）。
- **判别字段 `action`**（enum 6 值，JSON Schema 层面是普通可选 string + enum，**跨 action 的条件必填规则在 execute 内用 zod 校验**——纯 JSON Schema 表达不了「stage/step 必带 workflowId」这类条件，运行时校验并给可读错误）：
  - `'get-def'` —— 定义详情查询（含列表分支，供发现 workflowId）
  - `'update-def'` —— 定义编排（节点级 patch）
  - `'run'` —— 运行工作流（创建实例，可传当前会话 id）
  - `'get-state'` —— 实例状态查询（含列表分支 + stage/step 定点）
  - `'lib-list'` —— 库浏览：工作流定义 / Step 库(Agent) / 微流程库(Microflow) 摘要（编排引用数据源，2026 评审新增）
  - `'lib-get'` —— 库条目详情：Step/Microflow 单条完整记录 + 引用方明细（2026 评审新增）
- **注册接入点**：`SandoreEngineRuntime[Service.init]` 里，紧挨 `registerGlobalAskTool`（`workflow-engine.ts:356-361`）加一行 `this.ctx.effect(() => registerGlobalManagerTool(this.ctx, host), 'sandore: global sandore_workflow tool')`；`tools` 服务缺失（最小桩/测试 ctx）时静默跳过（复用 `registerGlobalAskTool` 的降级模式）。
- **execute 期 gate**（Q7 已定）：只允许「顶层主代理会话」调用（`exec.agent.session.header.parentSession` 为 undefined 的会话，即普通用户会话 / sandore overlay 宿主会话 / 复用宿主会话）；sandore step 子代理与普通委派子代理等非顶层代理调用一律抛清晰错误（对齐 ask-tool 反向 gate 的同一判定通道）。原因：定义编排/运行是用户级能力；如需放行后续加配置项。
- 不新增 RPC、不改 client、不改 engine-surface 公开签名（engine 三个公开方法 `startInstance/getState/getInstanceState` 已够用）。

### 2.2 工具参数 Schema（parameters）

遵循 ask-tool 的规范化 JSON Schema（required 数组只在 object 节点）：

```ts
// packages/workflow/manager-tool.ts（目标文件，节选）
export const WORKFLOW_MANAGER_TOOL_NAME = 'sandore_workflow'

export const WORKFLOW_MANAGER_PARAMETERS = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['get-def', 'update-def', 'run', 'get-state', 'lib-list', 'lib-get'],
      description:
        '操作类型：get-def=查询工作流/Stage/Step 定义（不传 workflowId 时返回定义列表）；' +
        'update-def=编辑定义节点；run=创建并启动一个工作流实例（可绑定当前会话）；' +
        'get-state=查询实例当前状态；lib-list=浏览已有 工作流/Step 库(Agent)/微流程库(Microflow)；' +
        'lib-get=读取单个库条目详情（供编排引用/借鉴）。',
    },
    workflowId: {
      type: 'string',
      description:
        '工作流定义 ID（wfl-…）。get-state 用于过滤实例列表；' +
        '**涉及 Stage/Step 的定义查改必传**（Stage/Step id 只在单个工作流内唯一）；run 必传。',
    },
    stageId: {
      type: 'string',
      description: 'Stage id（工作流内唯一）。get-def/get-state 定点用；update-def 定位 Step 时**必传**（Q4）。',
    },
    stepId: {
      type: 'string',
      description: 'Step id（工作流内顶层定义按 id 交叉引用）。get-def/get-state 定点 Step 用（多 stage slot 命中时返回全部）；update-def 定位 Step 时须与 stageId 同传。',
    },
    fields: {
      type: 'object',
      additionalProperties: true,
      description: 'update-def 的新值（按 level 决定替换范围，见工具描述；节点 id 不可变更）。',
    },
    originalInput: {
      type: 'string',
      description: 'run 必填：用户原始需求（成为实例宿主会话标题/需求）。',
    },
    cwd: {
      type: 'string',
      description:
        'run 用工作目录（必须为已存在目录；hostAgent 据此 attach web workspace）。' +
        '缺省取调用会话的 header.cwd。',
    },
    attachSession: {
      type: 'boolean',
      description:
        'run 可选，默认 true：把当前调用会话作为本实例宿主主代理（hostSessionId 复用）；' +
        'false 时引擎新建独立宿主会话（与 Web UI「新建实例」一致）。',
    },
    model: {
      type: 'object',
      additionalProperties: false,
      description: 'run 可选：本实例 L2 默认模型路由。',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
      },
    },
    permission: {
      type: 'string',
      enum: ['read-only', 'workspace-write', 'danger-full-access'],
      description: 'run 可选：实例权限预设（缺省继承宿主会话当前策略）。',
    },
    instanceId: {
      type: 'string',
      description: 'get-state 的实例 id（taskId）。缺省时返回实例摘要列表（可带 workflowId/status 过滤）。',
    },
    status: {
      type: 'string',
      description: 'get-state 列表分支的过滤：pending/running/interacting/completed/failed/aborted/paused。',
    },
    attemptIndex: {
      type: 'integer',
      description: 'get-state 定点 step 时指定执行段序号（缺省返回最新段）。',
    },
    lib: {
      type: 'string',
      enum: ['workflow', 'step', 'microflow'],
      description: 'lib-list/lib-get 的库类型：workflow=工作流定义、step=Step 库（UI「Agent 库」）、microflow=微流程库（UI「Microflow 库」）。lib-list 缺省三类全列。',
    },
    entryId: {
      type: 'string',
      description: 'lib-get 的库条目 id（steps/microflows 表记录键；与工作流 yaml 内 stage/step 节点引用的是同一个字符串 id）。',
    },
    includeDetail: {
      type: 'boolean',
      description: 'get-state 是否携带 output/会话消息等大字段（默认 false，只回摘要）。',
    },
  },
}
```

### 2.3 各 action 语义规格

#### `get-def` —— 定义详情查询（操作 1）

| 入参组合 | 行为 |
|---|---|
| 都不传 | 定义列表（发现用）：`[{ workflowId, name, version, description?, stageCount, stepCount, updatedAt }]`，来自 `definitions` 表遍历 + yaml 计数 |
| `workflowId` 仅此 | 该 workflow 的**完整合并定义**：`parseWorkflowYaml(record.yaml)` 原样结构化 JSON（stages 流控位 + 顶层 steps 全量定义都在一个对象里，模型可直接读懂/后续 patch 复用）；另附每 stage 的 `steps: mergedStepsOf` 视图 + 库引用提示 |
| `workflowId` + `stageId` | 定点 Stage：`{ stage: 该 WorkflowStage 节点, steps: mergedStepsOf(definition, stage), inLibrary?: { present: boolean } }`（库表存在同 id microflow 条目时 `present: true` 并附库条目的 name/updatedAt） |
| `workflowId` + `stepId`（±`stageId`） | 定点 Step：返回该 step 的 merged 定义（`{ ...definition.steps[stepId] ?? { id: stepId }, branches }`）+ 它出现在哪些 stage 流控位 + 库表引用提示。`stageId` 缺省且命中多个 slot 时返回全部（不报错，读取语义）；`workflowId`/`stageId`/`stepId` 任一不存在抛 `NODE_NOT_FOUND`（消息带 id 与定位上下文） |

「合并」函数（host 侧，语义与 `dag-editor-model.mergedStepsOf`/引擎 `workflow-engine.ts:1921` 完全一致，host 不能 import client 包，故在 workflow 包内实现等价纯函数，测试里与 client 版做等价断言）：

```ts
// packages/workflow/manager-tool.ts（目标文件，节选）
export type MergedStepView = WorkflowStep & { branches?: DagBranch[] }

/** 分离式合并（对齐 client mergedStepsOf / engine 1918-1923）：slot 流控位 × 顶层完整定义。 */
export function mergedStepView(definition: WorkflowDefinition, slot: StageStep): MergedStepView {
  const full = definition.steps?.find(step => step.id === slot.id)
  return { ...(full ?? { id: slot.id }), ...(slot.branches === undefined ? {} : { branches: slot.branches }) }
}

export function mergedStageView(definition: WorkflowDefinition, stageId: string) {
  const stage = definition.stages.find(s => s.id === stageId)
  if (stage === undefined) throw new SandoreError(`stage '${stageId}' not found in workflow '${definition.id}'`, 'NODE_NOT_FOUND')
  return { stage, steps: stage.steps.map(slot => mergedStepView(definition, slot)) }
}
```

#### `update-def` —— 定义编排（操作 2）

单一事实来源仍是该 workflow 的 yaml：**读 → 在 `WorkflowDefinition` 对象上做节点 patch → `serializeWorkflowYaml` → 走与 `remote.updateYaml` 相同的落盘路径**（`definitions.put` 全量覆盖 + 元数据 name/version/description 从新 yaml 解析同步 + `writeDefinitionToLibraries` 自动补库）。

| 定位 | `fields` 语义 | 规则 |
|---|---|---|
| 仅 `workflowId` | workflow 元数据浅合并：`name/version/description/engine/skills/mcps/agents/settings/rules/gates` | 只合并这些顶层字段；`stages/steps` 结构字段忽略并提示（结构性改动请带 stage/step 定位或未来提供整 yaml 替换） |
| `workflowId`+`stageId` | **整节点替换**该 `WorkflowStage`（zod `WorkflowStageSchema` 校验） | `stage.id` 不可变更（传不同 id 抛 `INVALID_OPERATION`）；改出边请改 `branches`/`steps[].branches` 数组本身 |
| `workflowId`+`stageId`+`stepId`（Q4：**stageId 必传**） | **整节点替换**该 step：拆两段写回——纯定义字段（name/command/inputFrom/outputTo/passThroughVars/timeout/defaultExpectation/rules/gates）→ 顶层 `definition.steps[stepId]`（不存在可新建）；`branches`/`inputFrom` 流控字段 → 只改 `stageId` 命中的流控位 | `step.id` 不可变更；缺 `stageId` → `INVALID_OPERATION`（消息给出该 step 出现的候选 stageId 列表）；`stageId` 传了但该 stage 无此 slot → `NODE_NOT_FOUND` |

```ts
// packages/workflow/manager-tool.ts（目标文件，节选：落盘与元数据同步，对齐 remote.updateYaml 177-193）
async function persistDefinitionUpdate(persistence: SandorePersistenceSeam, workflowId: string, definition: WorkflowDefinition): Promise<void> {
  const existing = persistence.definitions.get(workflowId)
  if (existing === undefined) throw new SandoreError(`definition '${workflowId}' not found`, 'NODE_NOT_FOUND')
  const yaml = serializeWorkflowYaml(definition)          // 再次 parse 可 deep-equal 往返
  const now = new Date().toISOString()
  await persistence.definitions.put(workflowId, {
    yaml,
    name: definition.name,
    version: definition.version,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    createdAt: existing.createdAt,
    updatedAt: now,
  })
  await persistence.writeDefinitionToLibraries(definition) // 保存路径自动补写库表（putIfAbsent 语义同 UI）
}
```

注意：写前整定义走一次 `parseWorkflowYaml(serializeWorkflowYaml(next))` 的往返校验（或对最终对象跑 `WorkflowDefinitionSchema`），保证存进去的 yaml 一定合法（`DEFINITION_INVALID`/`YAML_PARSE` 类错误在写前抛出，记录保持旧值——与 `updateYaml` 的原子性一致）。校验 + 落盘 + 补库任一步失败都不留下半写状态（先校验后 put，KvTable put 单键原子）。另按复核结论（§1.2 补强）：校验**不强制**「流控位必须有顶层完整定义」——update 写前应额外检查并提示每个被引用 slot 在顶层 steps[] 存在定义且带 command（缺定义的工作流能保存但跑起来才报错），避免产出「能保存跑不动」的结果。

#### `lib-list` / `lib-get` —— 库浏览（操作 2 编排的引用数据源；2026 评审新增）

模型做编排（update-def）之前需要知道库里已有什么可引用/借鉴：工作流定义（`definitions` 表）、Step 库（`steps` 表，UI「Agent 库」）、微流程库（`microflows` 表，UI「Microflow 库」）。两个只读 action 复用 `remote.listDefinitions/listSteps/listMicroflows/getStep/getMicroflow` 的同款语义与形状，但**直接宿主侧读表**，不新增 RPC。

| action | 入参 | 行为 |
|---|---|---|
| `lib-list` | `lib?`: `'workflow'`/`'step'`/`'microflow'`（缺省三类全列） | 返回 `[{ kind, entries }]`：workflow 行 = 与 get-def 无参分支同一摘要（id/name/version/description?/stageCount/stepCount/updatedAt）；step/microflow 行 = `{ id, name, version?, referencedBy, updatedAt }`（对齐 UI 库列表行；referencedBy = 被多少工作流 yaml 引用） |
| `lib-get` | `lib`: `'step'`/`'microflow'` + `entryId` | 单条库条目**完整记录 JSON**（`StepRecord`/`MicroflowRecord` 字段：name/command/outputTo/passThroughVars/steps 等，供模型借鉴复制），另附 `referencedBy: [{ workflowId, name }]` 引用方明细与 createdAt/updatedAt；不存在 → `NODE_NOT_FOUND`（消息注明 UI 名：Agent 库/微流程库）。workflow 定义详情请用 `get-def`（workflowId） |

要点与约束（写进工具描述）：

- **引用关系实时反扫 definitions**（与删除保护同一判定）：遍历 definitions 表、逐条 parse yaml 收 id 命中（`remote.ts:262-288`）。建议把 `collectLibraryReferences`/`toSummary` 抽成 workflow 包共享纯函数，`remote.ts` 与新工具共用（remote.spec 行为锁定回归）；数据量 = 定义行数级，无需缓存。
- **库 ≠ 工作流内联，互不同步**（§1.2 复核结论）：库条目是保存时的独立快照；改库条目不影响任何已保存 workflow，改 workflow 内联也不自动更新库（除非 UI「同步到库」路径）。模型「借鉴」= 读取字段后写入目标 workflow（update-def），不要假设改库会同步到引用它的工作流。
- 库条目 key 无前缀约束（`step-{uuid}`/`stg-{uuid}` 仅是注释约定）：id 与 workflow yaml 内节点 id 是同一个字符串，三边同 id 才构成引用。
- UI 命名对照（描述里直接用这些词，模型对得上界面）：Step 库 =「Agent 库」，微流程库 =「Microflow 库」，工作流定义 = 定义列表。
- 后续可选扩展：把库条目「挂载（展开）」进目标工作流（= UI 绑定的工具版）留作后续候选动作——Q5' 已定**本版不做 bind**，模型借鉴 = lib-get 读字段 → update-def 写入目标工作流。

#### `run` —— 运行工作流（操作 3）

```ts
// packages/workflow/manager-tool.ts（目标文件，节选：run 动作执行主干）
async function runInstance(host, args, exec): Promise<SandoreManagerToolResult> {
  const agent = exec.agent
  const session = agent?.session
  const callerSessionId = session?.id                    // 顶层主代理会话 id（gate 已保证）
  const request: DagStartRequest = {
    workflowId: args.workflowId,
    originalInput: args.originalInput,
    cwd: args.cwd ?? session?.header?.cwd ?? '',         // 都不存在 → 抛 INVALID_OPERATION
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.permission === undefined ? {} : { permission: args.permission }),
    ...(args.attachSession !== false && callerSessionId !== undefined
      ? { hostSessionId: callerSessionId }
      : {}),
  }
  if (request.cwd === '') {
    throw new SandoreError('run requires cwd (pass it, or call from a session whose header has cwd)', 'INVALID_OPERATION')
  }
  return { ok: true, data: await host.startInstance(request) } // DagRun { instanceId, status }
}
```

- 返回 `DagRun { instanceId, status }`（status 初值 `running`）；引擎 fire-and-forget（`startInstance` 内部 `void this.execute(...)`，`workflow-engine.ts:570`），**工具不阻塞等待完成**，后续用 `get-state` 轮询/定点查（与 UI 行为一致：状态靠 RPC/SSE 推送，工具侧就是查询）。
- 复用的宿主会话在工作流存活期被冻结——描述里写明该后果并给 `attachSession:false` 逃生口（§1.4 取舍表）。
- `workflowId` 不存在 → 引擎抛 `NODE_NOT_FOUND`（`workflow-engine.ts:487-490`）。**cwd 语义（审计修正）**：引擎对 cwd **不做 SandoreError 包装**——新建分支 `attachHostAgentToWorkspace`（`workflow-engine.ts:612-624`）经 workspaceRegistry.create 的 realpath/stat 校验，路径不存在抛底层 fs ENOENT、非目录抛普通 Error（DSH `packages/workspace/workspace/src/index.ts:157-163`）；**复用分支（attachSession=true）根本不校验 cwd**（attach 只在新建分支，`workflow-engine.ts:539`）。工具设计不受影响：默认取调用会话 header.cwd + 自设空串守卫（run 骨架），底层错误统一转 envelope `error.code/message`（§2.4）。另注意 `types.ts:144-148`/`wire.ts:137` 注释仍写旧语义「未命中已登记 workspace 抛 INVALID_OPERATION」，与引擎 604-621「自动注册、不再抛」矛盾——以引擎行为为准。

#### `get-state` —— 实例状态查询（操作 4）

| 入参组合 | 行为 |
|---|---|
| 仅 `instanceId`（缺省或显式，无 stageId/stepId） | 全量状态摘要：`{ instanceId, workflowId, status, workflowName?, originalInput, currentStageId, createdAt, updatedAt, stageInfos, executedSteps: [摘要行], pendingQueue, pendingInteractions: [类型/状态计数], userMessages: 尾部 N 条 }`。摘要行 = `{ stageId, stepId, name, status, attemptIndex, loopIteration, startedAt, updatedAt, error? , childSessionId? , phase? }` |
| 无 `instanceId` | 实例摘要列表（发现用）：遍历 `state` 表 `[{ instanceId, workflowId, originalInput, status, createdAt, updatedAt }]`，可带 `workflowId`/`status` 过滤（对齐 `remote.listInstances` 输出形状） |
| +`stageId` | 定点 stage：`stageInfos[id]` + `stageContracts[id]`（含 artifacts/passThroughVars）+ 该 stage 的 executedSteps 摘要行 |
| +`stepId`（±`stageId`，±`attemptIndex`） | 定点 step：过滤 `executedSteps`，默认最新执行段（按 `createdAt`+`attemptIndex`），返回 `{ 摘要行, output?（includeDetail 时 ContentBlock 数组）, artifacts, error, retryHistory, sessionMessages?（includeDetail 尾部 cap）, finalizeMeta, sessionMeta: { childId, synthetic, command } , parentSessionId, branchMeta/loopMeta }`；匹配 >1 段且未给 attemptIndex → 返回全部段的摘要并标注最新段（循环/重试场景） |

读取优先级（对齐 `remote.getInstanceState`）：`host.getInstanceState(instanceId)`（内存 active，中间态立即可见）→ undefined 时 `persistence.state.get(instanceId)`；两者皆无 → `NODE_NOT_FOUND`。输出默认裁剪大字段（output 每步默认只留文本长度 ≤2000 的尾部摘要 + 消息计数），`includeDetail:true` 放开；裁剪规则写进描述与返回的 `truncated` 标记，避免模型误以为拿到了全文。

### 2.4 结果信封、错误与模块骨架

沿用 sandore 工具结果信封风格（`packages/tool/index.ts:41-53` 的 `SandoreToolResult` 思路）并放宽为 data 承载：

```ts
export interface SandoreManagerToolResult {
  ok: boolean
  action: SandoreManagerAction
  data?: unknown                    // 成功载荷（见各 action 语义）
  reason?: string                   // ok=false 的可读原因
  error?: { code: string; message: string }   // SandoreError 摘要（复用 summarizeError 手法）
}
```

execute 统一骨架（条件必填/寻址规则的运行时校验集中在这里）：

```ts
export async function executeManagerTool(host: SandoreManagerToolHost, raw: unknown, exec: SandoreManagerToolExec) {
  try {
    const args = ManagerToolArgsSchema.parse(raw)          // zod：action 枚举 + 字段类型
    assertCallerIsTopLevel(exec)                            // gate
    switch (args.action) {
      case 'get-def':    return await doGetDef(host, args)
      case 'update-def': return await doUpdateDef(host, args)
      case 'run':        return await doRun(host, args, exec)
      case 'get-state':  return await doGetState(host, args)
      case 'lib-list':   return await doListLibraries(host, args)   // 只读 persistence.definitions/steps/microflows，不经 engine
      case 'lib-get':    return await doGetLibraryEntry(host, args) // 只读 persistence.steps/microflows + 引用反扫
    }
  } catch (err) {
    return errorEnvelope(err)   // zod issues → 映射到现有 SandoreErrorCode（如 INVALID_OPERATION/DEFINITION_INVALID）+ 中文摘要；不引入全集外的 code（microflow/errors.ts:20-40，15 码）
  }
}

// 硬约束一（§1.3）：涉及 stage/step 的操作必须带 workflowId。zod refine 示例：
const hasWorkflowIdRefinement = (args) => {
  if (args.stageId !== undefined || args.stepId !== undefined) {
    if (args.workflowId === undefined) {
      throw new SandoreError('stage/step 级操作必须携带 workflowId（stage/step id 只在单个工作流内唯一）', 'INVALID_OPERATION')
    }
  }
  // 硬约束二（Q4）：update-def 定位 step 必须同传 stageId（顶层定义单份、流控位按 stage 定位）
  if (args.action === 'update-def' && args.stepId !== undefined && args.stageId === undefined) {
    throw new SandoreError('update-def 的 step 级定位必须携带 stageId', 'INVALID_OPERATION')
  }
}
```

Host seam（最小结构面，engine 结构满足；全部只调公开方法，不需要扩 engine-surface）：

```ts
export interface SandoreManagerToolHost {
  startInstance(request: DagStartRequest): Promise<DagRun>
  getState(instanceId: string): DagInstanceState
  getInstanceState(instanceId: string): WorkflowTaskState | undefined
  persistence(): {                                          // 注册时由 ctx.get('sandorePersistence') 包一层
    definitions: KvTableSeam<string, WorkflowDefinitionRecord>
    steps: KvTableSeam<string, StepRecord>
    microflows: KvTableSeam<string, MicroflowRecord>
    state: KvTableSeam<string, WorkflowTaskState>
    writeDefinitionToLibraries(definition: WorkflowDefinition): Promise<void>
  } | undefined
}
```

注册函数（对齐 `registerGlobalAskTool` 的降级哲学）：

```ts
export function registerGlobalManagerTool(ctx: Context, host: SandoreManagerToolHost): () => void {
  const tools = (ctx as { get(name: string): unknown }).get('tools') as
    | { register(tool: unknown): () => void }
    | undefined
  if (tools === undefined) return () => {}   // 最小桩部署/测试 ctx：跳过
  return tools.register({
    name: WORKFLOW_MANAGER_TOOL_NAME,
    description: WORKFLOW_MANAGER_TOOL_DESCRIPTION,   // 长描述：四 action 语义 + 寻址规则 + attachSession 取舍（对齐 tool-workflow「描述即契约」）
    parameters: WORKFLOW_MANAGER_PARAMETERS,
    output: {
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, /* … */ } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args: unknown, exec: unknown) => executeManagerTool(host, args, exec as SandoreManagerToolExec),
  })
}
```

接入点（workflow-engine.ts `[Service.init]` 现第 356-361 行附近追加一行；persistence 在其上已注册，`ctx.get('sandorePersistence')` 惰性解析与引擎私有 `persistence()` 同一手法）：

```ts
// workflow-engine.ts [Service.init]（新增一行）
this.ctx.effect(() => registerGlobalManagerTool(this.ctx, {
  startInstance: (req) => this.startInstance(req),
  getState: (id) => this.getState(id),
  getInstanceState: (id) => this.getInstanceState(id),
  persistence: () => this.persistence(),   // persistence() 为 private（workflow-engine.ts:1971-1973 = ctx.get('sandorePersistence')）；在 [Service.init]（同类）内调用不受可见性限制，仅当把含 persistence() 的 host 对象传出类外时才需放开可见性或改用 ctx.get 闭包包装
}), 'sandore: global sandore_workflow manager tool')
```

### 2.5 与既有能力的边界（不重复造轮子）

| 能力 | 归属 | 说明 |
|---|---|---|
| 定义列表/增删改 YAML 文本/库条目 | 既有 Host RPC（`remote.ts`） | UI 走它；**新工具不新增 RPC**，execute 直接宿主侧调 persistence，避免经过 session 边界 |
| 实例生命周期细操作（abort/pause/resume/retry/replyQuestion/replyPermission/sendStepMessage/setPermissionMode） | 既有引擎公开方法 + RPC | 本工具 4 动作只到「状态查询」；如需「模型进一步指挥运行中实例」可后续扩 action 或复用 `packages/tool` 实例工具思路（§6 Q6 记一笔） |
| 实例内模型工具（8 个 `sandore_*`，packages/tool） | 未注册库 | 不冲突；若未来要「运行中实例的宿主会话也驱动自己」，另走 preset 挂载 |
| Web UI（TreeNav/RunView/DagEditor） | client 包 | 不动。工具产生的实例/定义变更会实时出现在 UI（同一 storage + 同一 SSE 事件） |

---

## 3. 风险与注意点

1. **update 并发 = last-write-wins**：与 UI 保存同一风险（无版本号/乐观锁）；工具描述提示「更新前先 get-def 拿最新」。
2. **运行中实例持有启动时解析的定义副本**（`startInstance` 里 parse 一次后进 `active.definition`）：update-def/删除定义都不影响已运行实例，只影响之后启动的实例。**删除 definition 的影响矩阵**（写进描述）：运行中实例无影响（只走内存 definition，落盘只写 state 表）；非终态实例崩溃/重启后 `recoverInstance` 需要 definitions 行（缺失 → `NODE_NOT_FOUND`，无法恢复，`workflow-engine.ts:720-723`）；终态实例的状态读取完全自包含于 state 快照（workflowName/description/executedSteps 的 name+command 副本都在，`schema.ts:484-487/418-452`）。
3. **cwd 必须真实存在**：引擎 workspaceRegistry.create 会校验目录（`workflow-engine.ts:612-624`）；从会话 header.cwd 继承可省掉大多数误传。
4. **hostSessionId 复用副作用**：宿主会话冻结、多实例共享冻结登记（§1.4）；工具描述写清代价并保留 `attachSession:false` 逃生口（Q3 已定：默认 attach=true）。
5. **输出体积**：get-state 全量含 output/sessionMessages/pendingInteractions 可能很胖，摘要默认 + includeDetail 开关必须实现（§2.3）。
6. **全局注册的可见面**：注册后所有会话（含 sandore step 子代理等被委派代理）的工具清单都会出现它；用 execute-gate 拒绝非顶层调用者。若注册表支持工具级过滤可再加（实现期用 Inspect 查 `tools` 服务能力，§6 Q7）。
7. **类型/构建纪律**：`manager-tool.ts` 放 workflow 包内**自动进 host 编译图**（tsconfig.json include = microflow/workflow/tool；tsconfig.client.json 只含 packages/client，不进 client 图）并 emit `lib/workflow/` 声明；**不要**在 `packages/workflow/index.ts` 显式 re-export（引擎内部 import 即可——re-export 与否只影响**公共导出 API 面**；tarball 因 `files:["lib",…]` 全目录发布、bundle 因引擎 import 本就物理包含该模块，`ask-tool.ts` 同先例）；不 import `@deepseek-ai/dsh-tools` 运行时（接缝哲学）；spec 与源码同目录（vitest include `packages/**/*.spec.ts` 自动收集）。
8. **库浏览是实时反扫**：lib-list/lib-get 每次遍历 definitions 并 parse yaml 计算引用（与 remote 库列表同成本，定义行数级可接受，不做缓存）；描述强调「库 ≠ 内联快照、无反向通道」，避免模型把库条目当成 workflow 的一部分去改。

---

## 4. 测试计划（`packages/workflow/manager-tool.spec.ts`，vitest，全 mock 无宿主依赖）

沿用 `remote.spec.ts`（fake ctx.services）/`tool/index.spec.ts`（engine fake）的既有风格；全局注册与 gate 断言参考 `workflow-engine.spec.ts:3158-3225`（**不存在 ask-tool.spec**）。

1. **寻址与合并（纯函数层）**
   - `mergedStepView`：slot branches × 顶层定义合并；顶层缺失回退 `{ id }` 骨架；与 client `mergedStepsOf` 输出等价（cross-import 断言）；
   - `mergedStageView`：stage 不存在抛 `NODE_NOT_FOUND`；steps 顺序 = 流控位顺序；
   - yaml fixture 往返：parse → patch → serialize → parse deep-equal。
2. **get-def**
   - 无参 → 列表摘要（含 stage/step 计数）；
   - workflowId → 完整定义 JSON + merged 视图存在；
   - workflowId+stageId / +stepId 定点命中；不存在的 id → NODE_NOT_FOUND；
   - stage/step 不带 workflowId → INVALID_OPERATION（硬约束用例）。
3. **update-def**
   - workflow 元数据合并（只改 name/version/description 不碰 stages）；
   - stage 整节点替换 + id 不可变错误 + 非法结构 → DEFINITION_INVALID 且**记录保持旧值**；
   - step 替换拆段写回（顶层定义字段 + 指定 stage slot 的 branches）；缺 stageId → INVALID_OPERATION；stageId 不含该 slot → NODE_NOT_FOUND；
   - 落盘路径：fake definitions.put 收到新 yaml、createdAt 保留、writeDefinitionToLibraries 被调用。
4. **run**
   - 组装 DagStartRequest：默认 attachSession=true 注入 hostSessionId=调用会话 id；false 则不注入；cwd 缺省取 session.header.cwd；全缺 → INVALID_OPERATION；
   - 转调 host.startInstance 并返回 DagRun；engine 抛 SandoreError → envelope error 透传。
5. **get-state**
   - 内存优先/持久化兜底/双无 → NODE_NOT_FOUND；
   - 列表分支 + workflowId/status 过滤；
   - stage 定点（stageInfos + stageContracts）；step 定点最新段、attemptIndex 精确段、多段全列；
   - includeDetail 默认裁剪标记。
6. **注册与 gate**
   - `registerGlobalManagerTool`：tools 缺失跳过（空 disposer）；注册对象形状（name/parameters.required 数组/output.schema 规范化）；
   - execute gate：parentSession 为 undefined 放行；子代理（有 parentSession）拒绝并可读信息。
7. **lib-list / lib-get（2026 评审新增）**
   - lib-list：缺省三类全列；workflow 行与 get-def 无参分支同源同形状；step/microflow 行 referencedBy 计数与 `remote.listSteps/listMicroflows` 输出一致（同 fixture cross-assert）；
   - lib-get：step/microflow 完整记录 + 引用方明细；不存在的 id → NODE_NOT_FOUND；
   - 回归断言：库条目与工作流内联节点同 id 但内容独立（改库不改变已保存 definitions yaml）。

---

## 5. 实施步骤（评审通过后）

1. （推荐）把 `remote.ts` 的 `collectLibraryReferences`/`toSummary`（262-303）抽为 workflow 包共享纯函数（如 `library-views.ts`），`remote.ts` 改用之，remote.spec 行为锁定回归；
2. 新建 `packages/workflow/manager-tool.ts`（§2 骨架：schema 常量 + 纯函数 + host seam + 注册函数 + description，覆盖 6 个 action）；
3. 新建 `packages/workflow/manager-tool.spec.ts`（§4 用例）；
4. `workflow-engine.ts` `[Service.init]`（355-367 区块，effect 行 360 旁）追加注册行——host 对象在 init 内直接包 `ctx.get('sandorePersistence')` 闭包即可，无需动 persistence() 可见性；
5. `pnpm typecheck`、`pnpm test`、`pnpm build`；
6. dev 冒烟（AGENTS.md 命令）：`node --import tsx/esm D:\project-code\llm\deepseek-harness\apps\cli\src\bin.ts --profile web --patch D:\project-code\llm\sandore\cordis.yml --port 3090` → 打开 http://127.0.0.1:3090，在普通会话里直接让模型调用 `sandore_workflow` 走一遍全部 action（get-def/update-def/run/get-state/lib-list/lib-get）；
7. 不改 `cordis.patch.yml`/生产 profile（3080 不加载 sandore，保持干净）。

---

## 6. 决策记录（2026 评审逐项拍板）

- **Q1（已定）工具命名**：`sandore_workflow`。
- **Q2（已定）action 枚举值**：`get-def / update-def / run / get-state / lib-list / lib-get`（kebab 风格）。
- **Q3（已定）run 默认宿主策略**：`attachSession` 默认 true（顶层会话自动把本会话 id 作为 hostSessionId 传入；`attachSession:false` → overlay 新建，与 UI 一致）。
- **Q4（已定）step 级 update 定位**：`update-def` 定位 step **必传 stageId**（顶层定义字段单份更新；流控字段只改指定 stage 内 slot；不传 → INVALID_OPERATION，附候选 stageId 列表）。读取（get-def/get-state）不强制：多 slot 命中返回全部。
- **Q5（已纳入设计）**：编排需浏览库 → `lib-list`/`lib-get` 两个 action（§2.3「库浏览」）。
- **Q5'（已定）本版不做 bind 挂载**：模型借鉴路径 = `lib-get` 读条目 → `update-def` 把字段写进目标工作流；「库条目一键展开挂载」（UI 绑定工具版）留作后续候选动作。
- **Q6（已定）本版不做运行中实例指挥**：只到状态查询；abort/pause/resume/retry/replyQuestion/replyPermission 等指挥动作留后续扩 action。
- **Q7（已定）调用门禁**：非顶层代理（sandore step 子代理 / 普通委派子代理）一律拒绝，只允许无 parentSession 的顶层主代理会话调用。
- **Q8（已定）库浏览细节**：lib-list 缺省三类全列（workflow/step/microflow）；referencedBy 采用「任一 definitions yaml 出现该 id」的粗粒度口径（与删除保护一致，不识别内联/展开来源）。

---

## 7. 附录：关键源码索引（调研引用，全部已验证）

> 实现状态（2026 评审后）：§5 已执行完毕——新增 `packages/workflow/library-views.ts`（+`library-views.spec.ts`）、`packages/workflow/manager-tool.ts`（+`manager-tool.spec.ts`，27 用例）；`remote.ts` 改为复用共享纯函数；`workflow-engine.ts` `[Service.init]` 追加 `registerGlobalManagerTool` 注册行（effect 在 registerGlobalAskTool 之后，host = startInstance/getState/getInstanceState/managerPersistenceView）；`workflow-engine.spec.ts:3176-3184` 断言同步为「全局注册 2 工具」。验证：`pnpm typecheck`、`pnpm test`（960 passed）、`pnpm build` 全绿；dev 3090 冒烟见对话记录。硬约束实现注记：①定义寻址类 action（get-def/update-def）带 stage/step 必传 workflowId，get-state 按 instanceId 定点除外；②update-def 定位 step 必传 stageId（Q4）。

- DSH 参考：`deepseek-harness/packages/workflow/tool-workflow/src/index.ts:137-333`（注册/描述/execute/输出渲染）
- 全局注册前例：`packages/workflow/ask-tool.ts:100-213`；注册接入点 `packages/workflow/workflow-engine.ts:356-361`
- 分离式定义 schema：`packages/workflow/schema.ts:143-197`（Step/Stage/StageStep）、`:522-573`（记录层）；记录/运行时全字段 `schema.ts:417-518`
- 引擎合并语义：`packages/workflow/workflow-engine.ts:1906-1929`；UI 合并函数 `packages/client/dag-editor-model.ts:28-34`
- 库表与自动入库：`packages/workflow/persistence.ts:60-172`；库管理 RPC `packages/workflow/remote.ts:253-396`
- session 传递全链路：`packages/workflow/types.ts:139-161`、`wire.ts:133-146`、`remote.ts:418-434`、`workflow-engine.ts:265-267,482-572`、`workflow-engine.spec.ts:1255-1317,2602-2633`
- 状态读取：`workflow-engine.ts:634-650`（getInstanceState/getState）、`remote.ts:446-451`（内存优先+兜底）、`types.ts:173-231`、`schema.ts:479-518`
- 错误码：`packages/microflow/errors.ts:20-40`（SandoreErrorCode 全集）
- 工具信封与 schema 规范化惯例：`packages/tool/index.ts:41-215`（START_INSTANCE_SCHEMA 精确行 105-113）
- 定义装载与运行期合并锚点（复核补强）：`workflow-engine.ts:114/487/491/713-724/1213/1226-1254`、`stage-executor.ts:376-384/780-802`、`step-navigator.ts:284-298`；引用校验 `yaml-parser.ts:175-250`（validateReferences：不强制顶层完整定义）；无 command 执行报错 `step-runner.ts:466-468`
- 绑定/保存（client）：`packages/client/dag-editor-model.ts:411-547`（expand 复制进 yaml；full 范围 411-547）；展开产物 yaml 往返 deep-equal 断言 `dag-editor-model.spec.ts:294-316`；实例创建载荷组装在 `NewInstanceDialog.tsx:188-194` + `workflow-face.ts:28-35`（含 cwd/model/permission、**无 hostSessionId**）
- 库 key 前缀注释性约定：`persistence.ts:70-78`、`domain.ts:29-40`；definitions 表全部写入点 = `remote.ts:135/157/164/188`（数据源均为调用方 yaml 文本；自动入库触发点 `remote.ts:136-138/188-191`）
- 引擎注册区块精确行：`workflow-engine.ts:355-367`（ask-tool effect = 360、SSE effect = 365）；gate 测试 `workflow-engine.spec.ts:3158-3225`；ghost-host reject 用例至 `workflow-engine.spec.ts:1317`
- DSH Session 形状（run 动作取会话 id/cwd）：`deepseek-harness/packages/core/session/src/types.ts:91-102`（SessionHeader.id/cwd?/parentSession?）、`core/session/src/index.ts:451`（Session.id getter）、`core/agent/src/types.ts:14`（Agent.id）
