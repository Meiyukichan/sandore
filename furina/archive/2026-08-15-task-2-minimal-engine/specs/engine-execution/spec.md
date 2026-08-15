# Spec: engine-execution — 线性工作流执行

## ADDED Requirements

### Requirement: WorkflowEngineV2 Provider
`packages/sandore/workflow/src/workflow-engine.ts` SHALL 提供 `SandoreEngineRuntime extends SandoreEngine`（default export），实现 Task 1 抽象类的实例级操作：Task 2 实现 `startInstance`/`getState`/`abortInstance` 3 个方法；其余 8 个（recover/replyQuestion/replyPermission/pause/resume/pauseAll/resumeAll/retryStep）抛 `SandoreError('INVALID_OPERATION', 'not implemented until Task 3/4')`。`static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`；`static Config`（schemastery）含 `defaultTimeoutMs`（默认 7200000）/`maxConcurrentSteps`（默认 0）/`defaultProvider?`/`defaultModel?`，无 `permissionMode`。

#### Scenario: 未实现方法类型化错误
- **WHEN** 调用 `pauseStep(instanceId, stepId)`
- **THEN** 抛 `SandoreError`，message 含 `not implemented`

#### Scenario: Task 1 Stub 保留
- **WHEN** 检查 `workflow` 包导出
- **THEN** `SandoreEngineStub` 仍可用（named export），default export 切换为 `SandoreEngineRuntime`

### Requirement: startInstance 启动流程
`startInstance(request: DagStartRequest): DagRun` SHALL 同步完成：读取 definitions 表该 workflowId 的 yaml → `parseWorkflowYaml` → 生成 `instanceId`（`YYYYMMDD-HHmmss-{3位随机}` 格式）→ 初始化 `WorkflowTaskState`（status=pending、stageInfos 全量初始化为 blocked、currentStageId=第一个 Stage）→ `state.put` 快照 → 注册内存运行表 → fire-and-forget `execute()` → 返回 `DagRun { instanceId, status: 'running' }`。定义不存在或 YAML 非法时抛 `SandoreError` 且不写 state 表。

#### Scenario: 定义缺失拒绝
- **WHEN** `startInstance` 的 workflowId 在 definitions 表不存在
- **THEN** 抛 `SandoreError`，state 表无新条目

#### Scenario: 返回即有快照
- **WHEN** `startInstance` 返回
- **THEN** `getState(instanceId)` 立即可读（至少含 pending/running 状态与 originalInput）

### Requirement: Stage 级线性编排主循环
`execute()` SHALL 按 Stage 顺序执行：status→running + `sandore/start` 事件 → 对每个 Stage：`sandore/stage-start` → 委托 StageExecutor 执行 Stage 内全部 Step → 组装 StageContract → `sandore/stage-completed` → `tryAdvanceStage()` 跟 `Stage.next`（无 next 的最后一个 Stage 完成即整体完成）→ 全部完成 status=completed + `sandore/end`。每个状态变化后 `persistState()`（state.put 全量覆盖）。

#### Scenario: 线性两 Stage 执行到 completed
- **WHEN** 用「Stage1 含 shell Step → Stage2 含 prompt Step」的定义启动实例并等待终态
- **THEN** `status === 'completed'`，`executedSteps` 含两条记录（status 均 completed），`stageInfos` 两个 Stage 均 completed

#### Scenario: Stage 顺序保证
- **WHEN** 记录事件发射顺序
- **THEN** 严格为 `start → stage-start(stg1) → step-start(step1) → step-completed(step1) → stage-completed(stg1) → stage-start(stg2) → step-start(step2) → step-completed(step2) → stage-completed(stg2) → end`

### Requirement: StageExecutor Stage 内部顺序执行
`packages/sandore/microflow/src/stage-executor.ts` SHALL 导出 `StageExecutor`：`execute(): Promise<StageExecutionResult>` 顺序执行 Stage 定义中的每个 Step（线性：按 steps 数组顺序，无分支跳转），每个 Step 委托 StepRunner；返回 `{ stageContract, executedSteps, passThroughVars, status, errorDetail? }`。`StageExecutionInput` 含 `originalInput`/`contractArtifacts`/`passThroughVars`/`entryStepId?`；`StageSharedState` 含 `cwd`/`instanceDir`/`jobId`/`taskId`（无 permissionMode）。

#### Scenario: Stage 内多 Step 顺序执行
- **WHEN** Stage 含 shell Step A（`echo hello`）与 shell Step B（引用 A 的输出）
- **THEN** A 先完成入 `executedSteps`，B 后执行，顺序与定义一致

#### Scenario: StageContract 组装
- **WHEN** Stage 全部 Step 完成
- **THEN** `stageContract.stageId`/`stageName`/`status='completed'` 正确，`artifacts` 聚合各 Step 的 outputTo 产物，`completedAt` 为 ISO 时间戳

### Requirement: StepRunner shell 执行器
`packages/sandore/microflow/src/step-runner.ts` SHALL 对 `command.type === 'shell'` 的 Step：`ctx.shell.resolve({ command: command.value.command, workdir: cwd, timeoutMs })` → `ctx.shell.run(spec)`；`exitCode === 0 && !timedOut && !aborted` 视为成功（`stdout.text` 包装为 text ContentBlock `[{ type: 'text', text: stdout.text }]` 作为输出，与 `sandore/step-completed` 事件载荷 `output: ContentBlock[]` 一致）；非零退出/超时/中止视为失败（`SandoreError('STEP_EXECUTION')`，含 stderr 摘要）。timeout 从 Step 定义（分钟）换算毫秒，缺省用 Config `defaultTimeoutMs`。

#### Scenario: shell 成功
- **WHEN** fake shell 返回 `{ exitCode: 0, stdout: { text: 'hello' } }`
- **THEN** Step 输出为 `[{ type: 'text', text: 'hello' }]`（ContentBlock[]），`executedSteps[].status === 'completed'`

#### Scenario: shell 非零退出失败
- **WHEN** fake shell 返回 `{ exitCode: 1, stderr: { text: 'boom' } }`
- **THEN** Step 失败，实例终态 `failed`，`executedSteps[].error` 含 'boom'，`sandore/step-failed` 事件发射

#### Scenario: shell 超时
- **WHEN** Step timeout 设为极小值且 fake shell 返回 `timedOut: true`
- **THEN** 失败错误码为 `STEP_TIMEOUT` 语义（error 含超时描述）

### Requirement: StepRunner prompt 执行器
`step-runner.ts` SHALL 对 `command.type === 'prompt'` 的 Step：构建结构化提示词（主头部 + `## 你的任务`（`command.value.promptText`）+ `## 参考信息`（用户原始需求）+ `## 前置Steps输出与产物`（前置 Step 的 returnPrompt 逐行缩进 + artifacts 文件列表））→ 按 LLM 三层回退解析 provider/model（Step 定义 `command.value.providerId`/`command.value.modelId` → Config `defaultProvider`/`defaultModel` → `ctx.llm.listProviders()[0]` + `listModels()[0]`）→ `ctx.llm.stream({ provider, model, messages: [user message] })` → 聚合 chunk（收集 `block-end` 的 block）为 `ContentBlock[]` 输出；`finish.reason.kind === 'error'` 抛 `SandoreError('STEP_EXECUTION')`。

#### Scenario: prompt 成功
- **WHEN** fake llm 流式返回 text block（'分析结果'）+ finish stop
- **THEN** Step 输出 `[{ type: 'text', text: '分析结果' }]`，`step-completed` 事件 payload 的 `output` 即该数组

#### Scenario: LLM 终端错误
- **WHEN** fake llm 返回 `finish.reason = { kind: 'error', failure }`
- **THEN** Step 失败，实例 `failed`，error 含 failure.message

#### Scenario: 无可用 provider
- **WHEN** fake llm 的 `listProviders()` 返回空数组且定义与 Config 均未指定 provider
- **THEN** 抛 `SandoreError('STEP_EXECUTION')`，message 含 `no LLM provider available`

#### Scenario: 三层回退顺序
- **WHEN** Step 定义写 `command.value.providerId: 'a'`、Config 写 `defaultProvider: 'b'`、llm 注册 `['c']`
- **THEN** 实际调用使用 provider `'a'`（定义优先）

### Requirement: 事件双发与安全发射
引擎 SHALL 每次状态变化双发 `sandore/*` 事件：`ctx.emit('sandore/…', info, …)`（Cordis 触发源）+ `session.append('sandore/…', payload)`（宿主 Session log，载荷为 SessionEventMap 声明的纯数据形式）；发射使用安全包装（listener 异常被捕获记日志，不中断引擎）。宿主 Session 在 `startInstance` 时创建（若 `ctx.sessions` 可用）。

#### Scenario: 双发可观测
- **WHEN** 线性工作流执行完成
- **THEN** fake ctx.emit 记录到 10 个事件（上述顺序）；fake session.append 记录到对应同序 Session 事件

#### Scenario: listener 异常不中断
- **WHEN** 某个 ctx.emit listener 抛异常
- **THEN** 引擎继续执行到 completed，异常被记日志

### Requirement: childId 合成占位
Step 执行 SHALL 生成 `childId = 'step-' + stepId + '-' + execId`（execId 为 `crypto.randomUUID()` 前 8 位），写入 `executedSteps[].sessionMeta = { childId, synthetic: true, command: <commandType> }` 与 `step-start`/`step-completed`/`step-failed` 事件载荷。

#### Scenario: childId 格式
- **WHEN** stepId 为 `step-abc` 的 Step 执行
- **THEN** `childId` 匹配 `/^step-step-abc-[0-9a-f]{8}$/`，`sessionMeta.synthetic === true`

### Requirement: abortInstance 中止
`abortInstance(instanceId)` SHALL 对运行中实例：设置中止标志 → 触发运行中 Step 的 AbortSignal（shell kill / llm abort）→ 主循环退出 → status=aborted + `sandore/aborted` 事件 + persist。非运行态（completed/failed/aborted）抛 `SandoreError('INVALID_OPERATION')`。

#### Scenario: 运行中中止
- **WHEN** shell Step 挂起时 `abortInstance`，fake shell 响应 abort 返回 `aborted: true`
- **THEN** 终态 `aborted`，`sandore/aborted` 事件发射，state 快照状态为 aborted

#### Scenario: 已完成实例中止拒绝
- **WHEN** 对 completed 实例 `abortInstance`
- **THEN** 抛 `SandoreError('INVALID_OPERATION')`

### Requirement: 持久化读回
引擎 SHALL 在每个状态变化点（step 状态、stage 状态、实例状态、入队/出队）后 `persistState()`（state.put 全量覆盖）。Service 层 `getState(instanceId)`（Task 1 声明，返回 `DagInstanceState` 公开子集）从内存运行表优先读、state 表兜底读；RPC `getInstanceState` 从 state 表读出完整 `WorkflowTaskState`（含全部 `executedSteps` 与 `stageContracts` 等 `DagInstanceState` 子集不含的字段）。

#### Scenario: 完成后快照完整
- **WHEN** 线性工作流到 completed
- **THEN** state 表读回的快照：status=completed、`executedSteps.length === 2`、每条含 sessionMeta/output 记录、`stageContracts` 两个条目

#### Scenario: 失败后快照保留错误
- **WHEN** 第二个 Step 失败
- **THEN** state 表快照 status=failed，第二条 `executedSteps[].error` 非空，第一条保持 completed
