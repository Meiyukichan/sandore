## Exploration Result

> 参考材料配置 `exploration.reference=[]` 为空；以下探索直接依据 exploreContent 指定的两个来源：
> ① 当前项目 `D:/project-code/llm/sandore/packages/sandore`；② DSH 参考源码 `D:/project-code/llm/deepseek-harness`。

### ① seam.ts —— ctx.userQuestions 声明与 UserQuestions 接口（当前最小形状）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`

- Cordis `Context` 扩展（第 26-30 行）：
  ```ts
  declare module '@deepseek-ai/cordis' {
    interface Context {
      sandoreEngine: SandoreEngine;
      userQuestions: UserQuestions;
    }
  }
  ```
- `UserQuestionsRequest`（第 106-110 行）——`ask` 入参的最小形状：
  ```ts
  export interface UserQuestionsRequest {
    readonly questions: unknown[];   // 尚未收紧为结构化条目
    readonly agent?: Agent;          // 来自 ../../microflow/src/subagents.ts
    readonly signal?: AbortSignal;
  }
  ```
- `UserQuestions`（第 113-115 行）：
  ```ts
  export interface UserQuestions {
    ask(request: UserQuestionsRequest): Promise<unknown>;   // 返回 unknown，非 AskUserQuestionAnswer
  }
  ```
- `sandore/question` 事件双声明（与 Session 双发对应）：
  - Cordis `Events`：`'sandore/question'(info: DagRunInfo, question: PendingQuestion): void`（第 42 行）
  - `SessionEventMap`：`'sandore/question': { question: PendingQuestion }`（第 60 行，payload 为对象、无 info）
- inject 差异（关键）：`SandoreEngineStub.inject` 含 `userQuestions`（第 143 行）；但 `SandoreEngineRuntime.inject`（workflow-engine.ts 第 143 行）不含 `userQuestions`，当前为 `['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'fs', 'storageDomain']`。

### ② schema.ts —— pendingInteractions 结构化 schema（seam-01 已收紧为 union）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

- `AskUserQuestionPayloadSchema`（第 193-204 行），字段用蛇形 `multi_select`（注释「对齐 DSH ask_user_question」）：
  ```ts
  { questions: [{ id: string, question: string, header?: string,
                   options?: [{ label: string, description?: string }],
                   multi_select?: boolean }] }
  ```
- `PendingInteractionStatusSchema`（第 207 行）：`z.enum(['pending', 'replied', 'rejected'])`。
- `PendingQuestionEntrySchema`（第 210-221 行）——question 变体：
  `id`、`stageId`、`stepId`、`sessionId`、`requestId`、`kind: z.literal('question')`、`status`、`payload: AskUserQuestionPayloadSchema`、`answer?: z.array(z.array(z.string()))`（string[][]）、`createdAt`。
- `PendingPermissionPayloadSchema`（第 224-229 行）：`permission: string`、`patterns?: string[]`、`metadata?: Record<string, unknown>`、`tool?: string`。
- `PendingPermissionEntrySchema`（第 232-243 行）——permission 变体：
  `id`、`stageId`、`stepId`、`sessionId`、`requestId`、`kind: z.literal('permission')`、`status`、`payload: PendingPermissionPayloadSchema`、`answer?: z.enum(['once', 'always', 'reject'])`、`createdAt`。
- `pendingInteractions` 挂载点（`WorkflowTaskStateSchema` 第 373 行）：
  ```ts
  pendingInteractions: z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema]))
  ```
- 收尾第 1 部分 `FinalizeAssessResultSchema`（第 246-253 行）：`completionType: z.enum(['completed', 'ask'])`、`passThroughVars: Record<string,string>`、`askQuestion?: AskUserQuestionPayloadSchema`、`errorDetail?`、`forkSessionId`、`assessmentRaw`。
- `FinalizeMetaSchema`（第 270-280 行）：含 `status: z.enum(['evaluating','completed','ask'])`、`completionType?: z.enum(['completed','ask'])`、`assessResult?`、`gateResult?`。

既有 schema 测试 `schema.spec.ts`（第 168-207 行）已覆盖 union 解析：一条 question 条目 + 一条 permission 条目 round-trip、`pendingInteractions[0].kind === 'question'`、`answer === 'once'`、空数组可解析。

### ③ types.ts —— PendingQuestion / PendingPermission / AskUserQuestionPayload

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`

- `AskUserQuestionPayload`：从 schema re-export（第 26 行），即 schema 的 `z.infer<typeof AskUserQuestionPayloadSchema>`（蛇形 `multi_select`）。
- `PendingInteractionStatus = 'pending' | 'replied' | 'rejected'`（第 147 行）。
- `PendingQuestion`（第 150-159 行）——注意字段与 schema 变体**不一致**（无 `kind`/`payload`，用 `questions`）：
  ```ts
  { id, stageId, stepId, sessionId, requestId,
    questions: AskUserQuestionPayload, status: PendingInteractionStatus, answer?: string[][] }
  ```
- `PendingPermission`（第 168-180 行）：
  `{ id, stageId, stepId, sessionId, requestId, permission, patterns?, metadata?, tool?, status, answer?: 'once'|'always'|'reject' }`。
- `FinalizeOutcome`（第 162-165 行）三态 union：
  ```ts
  | { type: 'done'; completionType: 'completed'; assessResult?; gateResult? }
  | { type: 'ask'; assessResult: FinalizeAssessResult }
  | { type: 'error'; errorDetail; assessResult?; gateResult? }
  ```
- `DagInstanceState`（第 72-84 行）**不含** `pendingInteractions`——`getState` 投影未暴露待回复交互。

### ④ workflow-engine.ts —— interacting 分支接缝点 / 双发范式 / persistState / ActiveInstance

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

- `ActiveInstance`（第 46-52 行）：`{ controller: AbortController; session: Session; hostAgent: Agent; definition: WorkflowDefinition; state: WorkflowTaskState }`，存于 `instances = new Map<string, ActiveInstance>()`（第 145 行）。
- `persistState`（第 437-447 行）：`persistence()` 为 `ctx.get('sandorePersistence')`；`await persistence.saveWorkflowState(active.state)`，异常 `logger.warn` 吞掉。
- 双发范式：`emitContained(name, args)`（第 451-462 行）经 `this.ctx.events.dispatch('emit', [name, ...args])` 派发并逐回调 try/catch；`safeAppend(fn)`（第 464-470 行）try/catch 包裹 `session.append`。每个事件一个 `emitXxx` 方法同时走两路（如 `emitStart` 第 472-475 行）。现有 8 个 emit：start / stage-start / stage-completed / step-start / step-completed / step-failed / end / aborted；**尚无 `sandore/question` 的 emit 方法**。
- `runInstance` 的 interacting 分支（第 381-387 行）——Task 4 的接缝点：
  ```ts
  if (result.status === 'interacting') {
    // Step 收尾判定为 ask：Step 进入 interacting，等待用户回复（Task 4 接续）。
    this.markStageStatus(active, stageId, 'interacting');
    active.state = { ...active.state, status: 'interacting', updatedAt: now() };
    await this.persistState(active);
    return;
  }
  ```
  此处 `return` 前**未**向 `pendingInteractions` 追加条目、未 emit `sandore/question`、未调用 `ctx.userQuestions.ask`。
- `replyQuestion` / `replyPermission`（第 217-223 行）仍抛 `SandoreError('... not implemented', 'INVALID_OPERATION')`（8 个未实现方法之一）。
- `makeInitialState`（第 78-108 行）初始化 `pendingInteractions: []`。
- `toDagInstanceState`（第 110-127 行）投影时不包含 `pendingInteractions`。

### ⑤ stage-executor.ts / finalize-manager.ts —— completionType='ask' 的产出链

stage-executor：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`

- 命令 Step 完成后调 `finalizeManager.finalizeStep(...)`（第 335-344 行），入参含 `step`、`executedStep`（StepRunner 执行后 `executed.status='completed'` 且 `executed.output=result.output`）、可选 `stepSessionId`、`context: { input, output }`、`gates`、`workdir`、`passThroughVars`、`signal`。
- `finalizeOutcome.type === 'ask'`（第 346-350 行）：`await onPersist(executed)` 后 `return buildResult(..., 'interacting', passThroughVars, undefined)` 中止 Stage。askQuestion 载荷在此不显式出现——它已由 finalize-manager 写进 `executed.finalizeMeta.assessResult.askQuestion`。

finalize-manager：`D:/project-code/llm/sandore/packages/sandore/microflow/src/finalize-manager.ts`

- `FinalizeManager.finalizeStep`（第 608-664 行）编排：跳过检查（无未解析透传变量 + 无 enabled 门禁 → `{ type:'done', completionType:'completed' }`）→ `assessor.assess` → 若 `assessResult.completionType === 'ask'`（第 630-634 行）：
  ```ts
  executedStep.status = 'interacting';
  await persistFinalize(undefined);   // 回写 finalizeMeta（status:'ask'/completionType:'ask'/assessResult，无 gateResult）+ passThroughVars + onPersist
  return { type: 'ask', assessResult };
  ```
- askQuestion 载荷来源链：`FinalizeAssessor.assess`（第 443-474 行）用 LLM `ctx.llm.stream` 得到 raw → `parseAssessResult(raw)`（第 292-305 行，JSON → regex 回退 completionType → 原始回落）→ `parseAskQuestion`（第 153-187 行，逐项校验 `id`/`question` 为 string、`options` 经 `parseOptions`、`multi_select` 布尔才保留）→ 落入 `assessResult.askQuestion`。
- `buildFinalizeMeta`（第 368-375 行）：`status = assessResult.completionType === 'ask' ? 'ask' : 'completed'`，附 `completionType`、`assessResult`、可选 `gateResult`+`gateSessionId`。
- 结论：`executedStep` 置 `interacting` 的唯一位置是 finalize-manager 第 631 行；`stage-executor` 仅据 `FinalizeOutcome.type` 判定中止并返回 `status:'interacting'`；`workflow-engine` 据 `result.status` 置实例/Stage 为 interacting 后 return。

### ⑥ DSH 参考源码 —— user-questions / tool-ask-user / apiproxy question 帧

`ctx.userQuestions.ask` 真实签名 —— `D:/project-code/llm/deepseek-harness/packages/interaction/user-questions/src/index.ts`

- `AskUserQuestionRequest`（第 28-35 行）：`{ questions: AskUserQuestionItem[]; agent?: Agent; signal?: AbortSignal }`。
- `UserQuestionService extends Service`：`registerProvider(provider): () => void`（第 64-75 行，单 provider、重复注册抛 `DUPLICATE_PROVIDER`）；`ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>`（第 92-140 行），校验顺序：
  `signal.aborted` → `ASK_ABORTED`；`questions.length === 0` → `EMPTY_QUESTIONS`；`agent` 非 registry 精确 live 实例 → `CALLER_NOT_LIVE`；live agent 被其他 agent 拥有 → `DELEGATED_CALLER`；intent 校验 → `BAD_INTENT`；无 provider → `NO_PROVIDER`；最终 `return this.provider.ask(request)`。
- 错误类 `UserQuestionError extends HarnessError`（第 43-48 行）。

类型 —— `.../user-questions/src/types.ts`

- `AskUserQuestionOption`：`{ label: string; description?: string }`。
- `AskUserQuestionIntent`：tagged union `{ kind: 'plan-review'; approve: string }`。
- `AskUserQuestionItem`：`{ id; question; detail?; header?; options?: AskUserQuestionOption[]; multiSelect?: boolean; intent?: AskUserQuestionIntent }`（**驼峰 `multiSelect`**，另有 `detail`、`intent` 为 sandore 未对齐字段）。
- `AskUserQuestionAnswerItem`：`{ id: string; selected: string[]; custom?: string }`。
- `AskUserQuestionAnswer`：`{ answers: AskUserQuestionAnswerItem[] }`（sandore 侧对应存储形状是 `answer?: string[][]`，与 DSH 的 `answers: {id,selected,custom}[]` 不同）。

tool-ask-user —— `.../tool-ask-user/src/index.ts`

- 工具名 `ask_user_question`（第 21 行）；参数 `questions`（`id`/`question`/`header`/`options`/`multi_select`，第 23-57 行）；output schema `{ answers: [{ id, selected, custom? }] }`（第 58-79 行）。
- `execute`（第 80-98 行）调用 `ctx.userQuestions.ask({ questions: args.questions.map(...), agent: exec.agent, signal: exec.signal })`；**`multi_select` → `multiSelect` 映射发生在第 87 行**：
  ```ts
  ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
  ```
  回答映射回 `{ id, selected: [...answer.selected], custom? }`（第 92-97 行）。

apiproxy 的 question/requested 帧 —— `.../packages/host/apiproxy/`

- `src/api/events.schema.ts`：`askUserQuestionItemSchema`（第 20-32 行，`multiSelect` 驼峰 + `intent` tagged union）。MuxFrame union 中：
  - `question/requested`（第 51 行）：`{ type, sessionId, questions: z.array(askUserQuestionItemSchema).min(1) }`；
  - `question/resolved`（第 52 行）：`{ type, sessionId, questionRpcId, outcome: 'answered' | 'cancelled' }`。
- `src/api/questions.ts` / `questions.schema.ts`：`QuestionResponsePayload { sessionId; answer: AskUserQuestionAnswer }`；`askUserQuestionAnswerSchema = { answers: [{ id, selected: string[], custom? }] }`。
- `src/api-proxy.ts`：
  - `PendingQuestion`（第 705-713 行）：`{ rpcId; sessionId; questions: AskUserQuestionItem[]; resolve(answer); reject(error); signal?; onAbort? }`。
  - `pendingQuestions = new Map<RpcId, PendingQuestion>()`（第 1130 行）。
  - provider 的 `ask`（第 1376-1395 行）：mint `rpcId = RpcId(randomUUID())`，构造 pending，`pendingQuestions.set`，注册 abort → `claimQuestion(pending,'cancelled')` + reject `ASK_ABORTED`，然后构造 `envelope = { rpcId, payload: { type: 'question/requested', sessionId, questions } }` push 到所有 `muxQueues`。
  - `claimQuestion`（第 1358-1365 行）：删除 pending、解绑 abort、broadcast `question/resolved`（outcome）。
  - mux 重连重放 pending questions（第 3436-3444 行，复用同一 `question/requested` 帧与稳定 rpcId）。
  - respond 处理器（第 3711-3742 行）：`questionResponsePayloadSchema.safeParse` → `matchesQuestions(payload, pending)`（第 716-733 行）校验：answers 数 === questions 数、id 顺序对应、selected 无重复、custom 非空串、非 `multiSelect` 时 selected ≤1 且不与 custom 并存、selected 全部落在 question.options 的 label 集合内；通过后 `claimQuestion(pending,'answered')` + `pending.resolve(payload.answer)`。

### ⑦ workflow/tests/mocks —— userQuestions mock 现状

目录：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/`

- **不存在** userQuestions mock。现有 7 个 mock 文件：`storage-domain.ts`、`llm.ts`、`shell.ts`、`subprocess.ts`、`sessions.ts`、`subagents.ts`、`agents.ts`。
- 全目录 grep `userQuestion|UserQuestions|ask` 无命中。
- `workflow-engine.spec.ts` 的 `harness()`（第 305-339 行）也未 `ctx.provide('userQuestions', ...)`；当前能加载是因为 `SandoreEngineRuntime.inject` 不含 `userQuestions`（仅 Stub 含）。

### ⑧ workflow-engine.spec.ts 对 interacting 分支的既有断言

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`

- **无**任何 interacting 分支断言。全部测试覆盖 completed / failed / aborted 三种终态（linear 执行、multi-step、失败、abort、DAG/循环/门禁）。
- `recordSandoreEvents`（第 342-353 行）只注册 `sandore/start`、`stage-start`、`stage-completed`、`step-start`、`step-completed`、`step-failed`、`end`、`aborted`；未注册 `sandore/question`、`sandore/permission`、`step-paused/resumed/retried`。
- 与 userQuestions 唯一相关的既有断言在「interface」块（第 383-387 行）：
  ```ts
  expect(SandoreEngineStub.inject).toContain('agents');
  expect(SandoreEngineStub.inject).toContain('userQuestions');
  expect(SandoreEngineRuntime.inject).toContain('agents');
  ```
  （未断言 Runtime 含 userQuestions。）

## Supplementary Exploration Result

无需补充：exploreContent 指定的本地源码（sandore + deepseek-harness）信息已完整覆盖全部 8 个探索点。`experimental.websearch=true`、`experimental.context7=true` 仅当 Phase 3 结果不足时启用，本次未启用。
