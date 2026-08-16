## Exploration Result

Phase 3（`furina-codebase` 探索 `codebases` 列表）：`furina config show project.sourcecode codebases` 返回唯一元素 `{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}`。`docs/codebase` 目录当前为空（仅 `.`/`..`，无文件）。本任务的 `exploreContent` 指向 `packages/sandore/workflow/src/*` 与 `packages/sandore/microflow/src/*` 源码，与空的 `docs/codebase` 无关，故 Phase 3 无可输出内容，全部落点见下方 Supplementary Exploration Result。

## Supplementary Exploration Result

> 说明：sandore 项目为 pnpm monorepo，工作流引擎源码实际位于 `packages/sandore/workflow/src`（非仓库根 `workflow/src`），`stage-executor.ts`/`finalize-manager.ts` 位于 `packages/sandore/microflow/src`。以下路径均为绝对路径下的对应文件。

### ① seam.ts：`ctx.userQuestions` 上下文键与 `UserQuestions` 接口（最小形状）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`

- Cordis 模块增强（第 26–30 行）声明两个上下文键：
  ```ts
  interface Context {
    sandoreEngine: SandoreEngine;
    userQuestions: UserQuestions;
  }
  ```
- `UserQuestions` 接口（第 112–115 行）为当前「最小形状」，返回值退化为 `Promise<unknown>`：
  ```ts
  export interface UserQuestions {
    ask(request: UserQuestionsRequest): Promise<unknown>;
  }
  ```
- `UserQuestionsRequest` 入参（第 105–110 行）：`questions: unknown[]`（未收窄）、可选 `agent?: Agent`、`signal?: AbortSignal`。
- `Agent` 从 `../../microflow/src/subagents.ts` 以 `import type` 引入（第 13 行）。
- 依赖注入：`SandoreEngineStub.inject`（第 143 行）已含 `'userQuestions'`：
  `['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions']`。
- 事件双声明已含交互事件（第 42–43 行 Cordis `Events`，第 60–61 行 Session `SessionEventMap`）：
  - `'sandore/question'(info: DagRunInfo, question: PendingQuestion): void;`
  - `'sandore/permission'(info: DagRunInfo, permission: PendingPermission): void;`
- `SandoreEngine` 抽象类已声明实例级回复方法（第 85–88 行）：
  - `replyQuestion(instanceId, requestId, answers: unknown): Promise<void>`
  - `replyPermission(instanceId, requestId, reply: 'once' | 'always' | 'reject'): Promise<void>`

### ② schema.ts：`pendingInteractions` 结构化 schema（question/permission union）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

- `AskUserQuestionPayloadSchema`（第 192–204 行）——对齐 DSH `ask_user_question`，注意用 **snake_case `multi_select`**：
  ```ts
  z.object({
    questions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
      multi_select: z.boolean().optional(),
    })),
  })
  ```
- `PendingInteractionStatusSchema`（第 207 行）：`z.enum(['pending', 'replied', 'rejected'])`。
- `PendingQuestionEntrySchema`（第 210–221 行）——question 变体，字段为 `kind: 'question'` + `payload`：
  ```ts
  { id, stageId, stepId, sessionId, requestId,
    kind: z.literal('question'),
    status: PendingInteractionStatusSchema,
    payload: AskUserQuestionPayloadSchema,
    answer: z.array(z.array(z.string())).optional(),
    createdAt: z.string() }
  ```
- `PendingPermissionPayloadSchema`（第 224–229 行）：`{ permission: string, patterns?: string[], metadata?: Record<string,unknown>, tool?: string }`。
- `PendingPermissionEntrySchema`（第 232–243 行）——permission 变体：
  ```ts
  { id, stageId, stepId, sessionId, requestId,
    kind: z.literal('permission'),
    status, payload: PendingPermissionPayloadSchema,
    answer: z.enum(['once','always','reject']).optional(),
    createdAt }
  ```
- 运行时状态表 `WorkflowTaskStateSchema.pendingInteractions`（第 373 行）：
  ```ts
  pendingInteractions: z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema]))
  ```
- 相关：`FinalizeAssessResultSchema`（第 246–253 行）含 `completionType: z.enum(['completed','ask'])`、`askQuestion: AskUserQuestionPayloadSchema.optional()`、`passThroughVars: Record<string,string>`、`forkSessionId`、`assessmentRaw`；`FinalizeMetaSchema`（第 270–280 行）含 `status: enum(['evaluating','completed','ask'])`、`completionType?`、`assessResult?`、`gateResult?`。

### ③ types.ts：`PendingQuestion` / `PendingPermission` / `AskUserQuestionPayload`

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`

- `AskUserQuestionPayload` 是 **从 schema.ts re-export 的类型**（第 10–26 行 `import type` + `export type`），非本地定义。
- `PendingInteractionStatus = 'pending' | 'replied' | 'rejected'`（第 147 行）。
- `PendingQuestion`（第 149–159 行）——**注意字段名是 `questions`（不是 `payload`）**，是 `sandore/question` 事件的载荷类型，与 schema 的持久化条目 `PendingQuestionEntry`（用 `payload`）是两个不同形状：
  ```ts
  { id, stageId, stepId, sessionId, requestId,
    questions: AskUserQuestionPayload, status: PendingInteractionStatus,
    answer?: string[][] }
  ```
- `PendingPermission`（第 167–180 行）：扁平字段（非 `payload` 包裹）：
  ```ts
  { id, stageId, stepId, sessionId, requestId,
    permission: string, patterns?: string[], metadata?: Record<string,unknown>, tool?: string,
    status: PendingInteractionStatus, answer?: 'once' | 'always' | 'reject' }
  ```
- `StepStatus`（第 123 行）含 `'interacting'`；`ExecutedStepDefault.status`（第 93 行）用它。
- `FinalizeOutcome`（第 162–165 行）三态联合，ask 变体：`{ type: 'ask'; assessResult: FinalizeAssessResult }`（askQuestion 载荷经 `assessResult.askQuestion` 携带）。

### ④ workflow-engine.ts：`runInstance` interacting 分支 / emitContained / safeAppend / persistState / ActiveInstance

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

- `ActiveInstance`（第 46–52 行）：`{ controller: AbortController; session: Session; hostAgent: Agent; definition: WorkflowDefinition; state: WorkflowTaskState }`；实例表 `private readonly instances = new Map<string, ActiveInstance>()`（第 145 行）。
- `SandoreEngineRuntime.inject`（第 143 行）**不含 `'userQuestions'`**，仅 `['sessions','sessionPersistence','subagents','agents','llm','shell','fs','storageDomain']`（与 Stub 的 inject 存在缺口）。
- `runInstance` 的 interacting 分支（第 381–387 行，即 Task 4 的接缝点）：
  ```ts
  if (result.status === 'interacting') {
    // Step 收尾判定为 ask：Step 进入 interacting，等待用户回复（Task 4 接续）。
    this.markStageStatus(active, stageId, 'interacting');
    active.state = { ...active.state, status: 'interacting', updatedAt: now() };
    await this.persistState(active);
    return;
  }
  ```
  当前仅置 Stage/实例为 `interacting` + 持久化后 **直接 return**：不写入 `pendingInteractions`、不发射 `sandore/question`/`sandore/permission` 事件、不调用 `ctx.userQuestions.ask`。
- `persistState`（第 437–447 行）：`this.ctx.get('sandorePersistence')` → `persistence.saveWorkflowState(active.state)`（即 `state.put(taskId, state)` 全量覆盖，见 `persistence.ts` 第 65–67 行），异常仅 `logger.warn`。
- `emitContained`（第 451–462 行）：`this.ctx.events.dispatch('emit', [name, ...args])` 逐监听器包裹 `Promise.resolve(returned).catch(...)`，同步 throw 亦捕获，均降级为 `logger.warn`。
- `safeAppend`（第 464–470 行）：`try { fn() } catch { logger.warn }`。
- 双发范式：`emitStart`/`emitStageStart`/`emitStageCompleted`/`emitStepStart`/`emitStepCompleted`/`emitStepFailed`/`emitEnd`/`emitAborted`（第 472–510 行）均为 `emitContained(name, args)` + `safeAppend(() => session.append(name, payload))`。**当前尚无 `emitQuestion`/`emitPermission` 双发助手**。
- `makeInitialState` 初始化 `pendingInteractions: []`（第 96 行）。
- `toDagInstanceState`（第 110–127 行）投影出的 `DagInstanceState` **不含 `pendingInteractions`**（仅 taskId/jobId/workflowId/status/originalInput/currentStageId/executedSteps/stageInfos/pendingQueue/createdAt/updatedAt）。

### ⑤ stage-executor.ts / finalize-manager.ts：`completionType='ask'` 的产出与 `executedStep` 置 interacting

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`、`.../finalize-manager.ts`

- stage-executor.ts 第 334–350 行：Step 成功后调 `finalizeManager.finalizeStep(...)`，当 `finalizeOutcome.type === 'ask'`（第 346–350 行）：
  ```ts
  await this.options.onPersist?.(executed);   // executed.status 已被 finalizeManager 置为 'interacting'
  return this.buildResult(stageDef, executedSteps, 'interacting', passThroughVars, undefined);
  ```
  `StageExecutionResult` 只携带 `stageContract/executedSteps/passThroughVars/status/errorDetail`，**不单独携带 askQuestion**——askQuestion 载荷经 `executedSteps[].finalizeMeta.assessResult.askQuestion` 随 executedStep 一并落盘。
- finalize-manager.ts `FinalizeManager.finalizeStep`（第 608–664 行）：`assessResult.completionType === 'ask'` 时（第 630–634 行）：
  ```ts
  executedStep.status = 'interacting';
  await persistFinalize(undefined);   // 写 finalizeMeta + onPersist
  return { type: 'ask', assessResult };
  ```
  `persistFinalize`（第 624–628 行）执行 `executedStep.finalizeMeta = buildFinalizeMeta(assessResult, gateResult)` 并 `await request.onPersist?.(executedStep)`。
- `buildFinalizeMeta`（第 368–375 行）：`status: completionType==='ask' ? 'ask' : 'completed'`、`completionType`、`assessResult`（含 `askQuestion`）、可选 `gateResult/gateSessionId`。
- askQuestion 载荷来源链：LLM assess 输出 JSON → `parseAssessResult`（第 292–305 行）→ `parseAskQuestion`（第 153–187 行，从原始 JSON 读 **snake_case `multi_select`** 字段）→ `AssessParsed.askQuestion` → `FinalizeAssessor.assess` 返回的 `FinalizeAssessResult.askQuestion`（第 466–473 行）→ `executedStep.finalizeMeta.assessResult.askQuestion`。

### ⑥ DSH 参考实现（`D:/project-code/llm/deepseek-harness`）

**user-questions（`packages/interaction/user-questions/src/`）**

- `index.ts`：`UserQuestionService extends Service`（`super(ctx, 'userQuestions')`），真实签名为
  `ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>`（第 92 行），非 sandore 的 `Promise<unknown>`。
  `AskUserQuestionRequest = { questions: AskUserQuestionItem[]; agent?: Agent; signal?: AbortSignal }`（第 28–35 行）。
  `ask()` 前置校验：`ASK_ABORTED`（已 aborted）、`EMPTY_QUESTIONS`、`CALLER_NOT_LIVE`（agent 非 registry 精确 live 实例）、`DELEGATED_CALLER`（live agent 被其他 agent 拥有）、`BAD_INTENT`、`NO_PROVIDER`（无注册 provider）。
  provider 通过 `registerProvider(provider)` 单例注册（`DUPLICATE_PROVIDER`）。
- `types.ts`（wire-safe，无 cordis 依赖）：
  - `AskUserQuestionItem`：`{ id, question, detail?, header?, options?: AskUserQuestionOption[], multiSelect?: boolean, intent?: AskUserQuestionIntent }`（注意 **camelCase `multiSelect`**，且有 sandore 未引入的 `detail`/`intent` 字段）。
  - `AskUserQuestionOption`：`{ label, description? }`。
  - `AskUserQuestionAnswer`：`{ answers: AskUserQuestionAnswerItem[] }`。
  - `AskUserQuestionAnswerItem`：`{ id, selected: string[], custom? }`。
  - `AskUserQuestionIntent`：`{ kind: 'plan-review', approve: string }`。

**tool-ask-user（`packages/interaction/tool-ask-user/src/index.ts`）**

- 工具名 `ask_user_question`，入参 schema 用 **snake_case `multi_select`**（boolean，第 50–53 行），`options` items 为 `{ label, description }`。
- `execute`（第 80–99 行）映射：`question.multi_select !== undefined ? { multiSelect: question.multi_select } : {}`（第 87 行），即 **snake_case `multi_select` → camelCase `multiSelect`**；header/options 原样透传。返回 `{ answers: [{ id, selected, custom? }] }`。`exec.agent` 存在时以 `agent` 传入，`signal: exec.signal`。

**apiproxy 的 question/requested 帧（`packages/host/apiproxy/src/`）**

- `api/events.ts` `MuxFrame`（第 74–75 行）：
  - `{ type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }`
  - `{ type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }`
- `api/events.schema.ts`：`askUserQuestionItemSchema`（第 20–32 行）用 camelCase `multiSelect`/`detail`/`intent`（`satisfies z.ZodType<Wire<AskUserQuestionItem>>`）；`question/requested` 帧 schema 要求 `questions: z.array(askUserQuestionItemSchema).min(1)`（第 51 行，空批在 host 层即失败）。
- `api-proxy.ts` 的 provider 注册（第 1369–1397 行）：`ctx.userQuestions.registerProvider({ ask(request){...} })`，`sessionId = request.agent?.id`（无 agent 则 reject `ASK_MISSING_AGENT`）；mint `rpcId = RpcId(randomUUID())`，`pendingQuestions.set(rpcId, pending)`，推 `{ rpcId, payload: { type:'question/requested', sessionId, questions: request.questions } }`；abort → `claimQuestion(pending,'cancelled')` + reject `ASK_ABORTED`。
- `claimQuestion`（第 1358–1367 行）：从 `pendingQuestions` 删除 + broadcast `question/resolved`（带 `questionRpcId` + `outcome`）。
- mux 打开时重放（第 3436–3444 行）：以相同 `rpcId` 重放仍 pending 的 `question/requested` 帧（refresh-recovery）。
- `respond` 端点（第 3696–3742 行）：按回显 `rpcId` 路由；question 分支经 `questionResponsePayloadSchema` 校验 → `matchesQuestions` → `claimQuestion(pending,'answered')` + `resolve(payload.answer)`。
- `matchesQuestions`（第 716–733 行）校验：`sessionId` 一致、`answers.length === questions.length`、逐条 `id` 一致、`selected` 无重复、单选时 `custom` 与 `selected` 互斥且 `selected.length <= 1`、`selected` 均为该 question options 的 label 子集。
- `api/questions.ts` / `questions.schema.ts`：`QuestionResponsePayload = { sessionId, answer: AskUserQuestionAnswer }`；`askUserQuestionAnswerSchema = { answers: [{ id, selected: string[], custom? }] }`（一次 ask 的整批 answer，不按 question 拆分）。

### ⑦ workflow/tests/mocks：userQuestions 是否已有 mock

文件目录：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/`

- 现有 mock 仅 7 个：`agents.ts`、`llm.ts`、`sessions.ts`、`shell.ts`、`storage-domain.ts`、`subagents.ts`、`subprocess.ts`。
- **不存在 `userQuestions.ts` mock**；`grep -rn "userQuestions" packages/sandore/workflow/tests` 无命中。
- `workflow-engine.spec.ts` 的 `harness()`（第 305–339 行）也未向 `ctx.provide('userQuestions', ...)` 注入任何实现。

### ⑧ workflow-engine.spec.ts 对 interacting 分支的既有断言

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`

- **无任何针对 interacting 分支的断言**：全文件没有断言 `status === 'interacting'`、`pendingInteractions`、`sandore/question` 或 `sandore/permission`。
- `recordSandoreEvents`（第 342–353 行）只注册 `sandore/start`、`stage-start`、`stage-completed`、`step-start`、`step-completed`、`step-failed`、`end`、`aborted` —— **未注册 question/permission 监听**。
- 唯一与 seam 相关断言（第 383–387 行）：
  ```ts
  it('declares agents and userQuestions in the seam inject list', () => {
    expect(SandoreEngineStub.inject).toContain('agents');
    expect(SandoreEngineStub.inject).toContain('userQuestions');
    expect(SandoreEngineRuntime.inject).toContain('agents');
  });
  ```
  注意该断言只要求 Stub 含 `userQuestions`，Runtime 的 inject 仅断言含 `agents`（与 ④ 中 Runtime.inject 未含 `userQuestions` 的事实一致）。
- 交互相关的既有单元测试在 microflow 侧：`finalize-manager.spec.ts` 第 458–479 行 `marks the step interacting and skips the gate when assess returns ask`，断言 `outcome.type === 'ask'`、`executed.status === 'interacting'`、`llm.calls` 为 1 次（assess 后短路门禁）。

### 落点小结（供 Task 4 interaction-01 定位，非实现建议）

- 交互等待的入口接缝：`workflow-engine.ts` `runInstance` 第 381–387 行（`result.status === 'interacting'` 后 `return`），以及 `StageExecutionResult` 中 askQuestion 载荷的实际存放点 `executedSteps[].finalizeMeta.assessResult.askQuestion`（snake_case `multi_select`）。
- 回复能力接口已声明但未实现：`SandoreEngine.replyQuestion/replyPermission`（seam.ts）、`SandoreEngineSurface`（engine-surface.ts）、Runtime 中均为 `INVALID_OPERATION` not implemented（workflow-engine.ts 第 217–223 行）；8 个 `sandore_*` 编排器工具（tool/src/index.ts）与 `remote.ts` 均未暴露回复入口。
- 持久化 shape 已就绪：`WorkflowTaskStateSchema.pendingInteractions` 为 question/permission union，且已有 schema.spec.ts 的结构化解析断言（第 168–203 行）；但事件载荷类型 `PendingQuestion`（types.ts，字段 `questions`）与持久化条目 `PendingQuestionEntry`（schema.ts，字段 `payload`）命名不一致。
- `ctx.userQuestions.ask` 当前最小形状返回 `Promise<unknown>`，DSH 真实签名为 `Promise<AskUserQuestionAnswer>`，且 DSH 用 camelCase `multiSelect`（tool 层完成 `multi_select`→`multiSelect` 映射）；sandore schema 目前停留在 snake_case `multi_select`。
