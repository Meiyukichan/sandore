# Task 4 interaction-01 参考实现与落点探索

> 探索类型：specification
> 探索范围：sandore 工作流引擎 `packages/sandore/workflow` / `packages/sandore/microflow` 与 DSH 参考实现 `D:\project-code\llm\deepseek-harness`
> 说明：`furina config show exploration.specification` 返回空数组（无外部 specification materials 配置），以下结果直接来自 `exploreContent` 所列代码文件的实际读取。

## ① `workflow/src/seam.ts` — ctx.userQuestions 声明与 UserQuestions 接口

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`

- Cordis `Context` 声明（第 26-30 行）：
  ```ts
  declare module '@deepseek-ai/cordis' {
    interface Context {
      sandoreEngine: SandoreEngine;
      userQuestions: UserQuestions;
    }
    ...
  }
  ```
  上下文键 `userQuestions` 已声明，类型为本地 `UserQuestions` 接口。
- `UserQuestions` 接口（第 112-115 行，当前最小形状）：
  ```ts
  export interface UserQuestions {
    ask(request: UserQuestionsRequest): Promise<unknown>;
  }
  ```
- `UserQuestionsRequest` 接口（第 105-110 行）：
  ```ts
  export interface UserQuestionsRequest {
    readonly questions: unknown[];   // 最小面：questions 数组，元素类型尚未收紧
    readonly agent?: Agent;          // 活代理
    readonly signal?: AbortSignal;
  }
  ```
  `questions` 当前是 `unknown[]`，未与 `AskUserQuestionPayload`/DSH `AskUserQuestionItem` 对齐。
- `Agent` 类型来自 `import type { Agent } from '../../microflow/src/subagents.ts'`（第 13 行）。
- 事件双声明（Cordis `Events` 第 32-46 行 + `SessionEventMap` 第 49-65 行）已声明 `'sandore/question'(info, question: PendingQuestion)` 与 `'sandore/permission'(info, permission: PendingPermission)`，载荷分别取 `types.ts` 的 `PendingQuestion`/`PendingPermission`（非 schema 的 `PendingQuestionEntry`）。
- 注入列表：`SandoreEngineStub.inject`（第 143 行）包含 `'userQuestions'`：
  `['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions']`。
  注意：`SandoreEngineRuntime.inject`（见 ④）**不含** `'userQuestions'`。

## ② `workflow/src/schema.ts` — pendingInteractions 结构化 schema

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`

- `AskUserQuestionPayloadSchema`（第 192-204 行，对齐 DSH `ask_user_question`）：
  ```ts
  export const AskUserQuestionPayloadSchema = z.object({
    questions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        description: z.string().optional(),
      })).optional(),
      multi_select: z.boolean().optional(),
    })),
  })
  ```
- `PendingInteractionStatusSchema`（第 207 行）：`z.enum(['pending', 'replied', 'rejected'])`。
- `PendingQuestionEntrySchema`（第 209-221 行，question 变体）确切字段：
  ```ts
  export const PendingQuestionEntrySchema = z.object({
    id: z.string(),
    stageId: z.string(),
    stepId: z.string(),
    sessionId: z.string(),
    requestId: z.string(),
    kind: z.literal('question'),
    status: PendingInteractionStatusSchema,
    payload: AskUserQuestionPayloadSchema,
    answer: z.array(z.array(z.string())).optional(),   // string[][] 可选
    createdAt: z.string(),
  })
  ```
- `PendingPermissionPayloadSchema`（第 223-229 行）：
  ```ts
  const PendingPermissionPayloadSchema = z.object({
    permission: z.string(),
    patterns: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tool: z.string().optional(),
  })
  ```
- `PendingPermissionEntrySchema`（第 231-243 行，permission 变体）确切字段：
  ```ts
  export const PendingPermissionEntrySchema = z.object({
    id: z.string(),
    stageId: z.string(),
    stepId: z.string(),
    sessionId: z.string(),
    requestId: z.string(),
    kind: z.literal('permission'),
    status: PendingInteractionStatusSchema,
    payload: PendingPermissionPayloadSchema,
    answer: z.enum(['once', 'always', 'reject']).optional(),
    createdAt: z.string(),
  })
  ```
- `WorkflowTaskStateSchema.pendingInteractions`（第 373 行）：
  ```ts
  pendingInteractions: z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema]))
  ```
- `FinalizeAssessResultSchema`（第 245-253 行）：
  ```ts
  export const FinalizeAssessResultSchema = z.object({
    completionType: z.enum(['completed', 'ask']),
    passThroughVars: z.record(z.string(), z.string()),
    askQuestion: AskUserQuestionPayloadSchema.optional(),
    errorDetail: z.string().optional(),
    forkSessionId: z.string(),
    assessmentRaw: z.string(),
  })
  ```
- `FinalizeMetaSchema`（第 269-280 行）含 `status: z.enum(['evaluating','completed','ask'])`、`completionType: z.enum(['completed','ask']).optional()`、`assessResult: FinalizeAssessResultSchema.optional()`、`gateResult: GateEvalResultSchema.optional()`。
- 派生类型（第 435-437 行）：`AskUserQuestionPayload`、`PendingQuestionEntry`、`PendingPermissionEntry` 均 `z.infer` 自上述 schema。

## ③ `workflow/src/types.ts` — PendingQuestion/PendingPermission/AskUserQuestionPayload

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`

- `AskUserQuestionPayload` 为 `schema.ts` 的 re-export（第 25-38 行），即 `{ questions: { id; question; header?; options?: {label; description?}[]; multi_select? }[] }`。
- `PendingQuestion` 接口（第 149-159 行）：
  ```ts
  export interface PendingQuestion {
    id: string
    stageId: string
    stepId: string
    sessionId: string
    requestId: string
    questions: AskUserQuestionPayload   // 直接字段名 questions，非 kind/payload
    status: PendingInteractionStatus
    answer?: string[][]
  }
  ```
  **与 schema 的差异**：`types.PendingQuestion` 用 `questions` 字段直接承载载荷、无 `kind`、无 `payload`、无 `createdAt`；schema 的 `PendingQuestionEntry` 用 `kind: 'question'` + `payload` + `createdAt`。二者尚未统一。
- `PendingPermission` 接口（第 167-180 行）：
  ```ts
  export interface PendingPermission {
    id: string
    stageId: string
    stepId: string
    sessionId: string
    requestId: string
    permission: string
    patterns?: string[]
    metadata?: Record<string, unknown>
    tool?: string
    status: PendingInteractionStatus
    answer?: 'once' | 'always' | 'reject'
  }
  ```
  （扁平字段，同样无 `kind`/`payload`/`createdAt`。）
- `FinalizeOutcome`（第 161-165 行，三态联合）：
  ```ts
  export type FinalizeOutcome =
    | { type: 'done'; completionType: 'completed'; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
    | { type: 'ask'; assessResult: FinalizeAssessResult }   // askQuestion 载荷嵌套在 assessResult.askQuestion
    | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
  ```
- 相关状态枚举：`DagRunStatus`（第 69 行）与 `StepStatus`（第 123 行）均含 `'interacting'`；`PendingInteractionStatus = 'pending' | 'replied' | 'rejected'`（第 147 行）。

## ④ `workflow/src/workflow-engine.ts` — runInstance interacting 分支 / 双发 / persistState / ActiveInstance

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`

- `ActiveInstance` 接口（第 45-52 行）：
  ```ts
  interface ActiveInstance {
    readonly controller: AbortController;
    readonly session: Session;
    readonly hostAgent: Agent;
    readonly definition: WorkflowDefinition;
    state: WorkflowTaskState;
  }
  ```
  实例注册表：`private readonly instances = new Map<string, ActiveInstance>()`（第 145 行）。
- `SandoreEngineRuntime.inject`（第 143 行）：`['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'fs', 'storageDomain']` — **不含 `userQuestions`**（与 Stub 注入列表不一致）。
- `runInstance` 中 interacting 分支（第 381-387 行，finalize ask 判定后 return 的接缝点）：
  ```ts
  if (result.status === 'interacting') {
    // Step 收尾判定为 ask：Step 进入 interacting，等待用户回复（Task 4 接续）。
    this.markStageStatus(active, stageId, 'interacting');
    active.state = { ...active.state, status: 'interacting', updatedAt: now() };
    await this.persistState(active);
    return;
  }
  ```
  当前仅置 Stage/实例 interacting 并 `return`，**未**写入 `state.pendingInteractions`、未发射 `sandore/question` 事件、未 `ctx.userQuestions.ask(...)`。
- `persistState`（第 437-447 行）：经 `this.persistence()`（`ctx.get('sandorePersistence')`）调用 `persistence.saveWorkflowState(active.state)`，异常捕获后 `ctx.logger.warn`（吞错不抛）。
- 事件双发范式：
  - `emitContained(name, args)`（第 451-462 行）：`this.ctx.events.dispatch('emit', [name, ...args])` 遍历回调逐个调用，同步 throw 与 Promise reject 均捕获为 `ctx.logger.warn`。
  - `safeAppend(fn)`（第 464-470 行）：try/catch 包裹 `fn()`（即 `session.append`），异常 `ctx.logger.warn`。
  - 每个 `emit*` 助手均先 `emitContained('sandore/xxx', [...])` 再 `safeAppend(() => session.append('sandore/xxx', {...}))`。
- 现有 emit 助手（第 472-510 行）：`emitStart` / `emitStageStart` / `emitStageCompleted` / `emitStepStart` / `emitStepCompleted` / `emitStepFailed` / `emitEnd` / `emitAborted`。**尚无** `emitQuestion` / `emitPermission`（尽管 seam.ts 已声明 `'sandore/question'` / `'sandore/permission'` 事件）。
- `replyQuestion` / `replyPermission`（第 217-223 行）当前抛 `SandoreError('... not implemented', 'INVALID_OPERATION')`。
- `runInstance` 主循环（第 272-410 行）：`while (stageId !== '')`，每 Stage 构造 `StageExecutor`（注入 `hooks` / `loopManager` / `finalizeManager` / `resolveNextNodes` / `visitCounts` / `onPersist`），`result = await executor.execute()` 后按 `result.status` 分支（failed / interacting / completed）。

## ⑤ `stage-executor.ts` / `finalize-manager.ts` — completionType='ask' 的产出

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\stage-executor.ts` 与 `finalize-manager.ts`

- `finalize-manager.ts` — `FinalizeAssessor.assess()`（第 443-474 行）返回 `FinalizeAssessResult`：`completionType`（`'completed'|'ask'`）、`passThroughVars`、可选 `askQuestion`、可选 `errorDetail`、`forkSessionId`、`assessmentRaw`。**askQuestion 载荷来源**：assess LLM 输出 JSON 的 `askQuestion` 字段，经 `parseAskQuestion`（第 153-187 行）收窄而来；`parseAskQuestion` 保留 snake_case `multi_select` 字段（第 174 行读取 `record['multi_select']`，第 180 行写回 `multi_select`），**未**做 `multiSelect` 映射。
- `FinalizeManager.finalizeStep()`（第 608-664 行）编排：
  1. `needsAssess = hasUnresolvedPassThroughVars(step)`、`hasGates = hasEnabledGates(request.gates)`；
  2. 若 `!needsAssess && !hasGates` → 直接 `{ type: 'done', completionType: 'completed' }`（零 AI 调用）；
  3. 否则 `assessor.assess(...)`；
  4. `persistFinalize(gateResult)` 内部：`executedStep.finalizeMeta = buildFinalizeMeta(assessResult, gateResult)` → `writeBackPassThroughVars(...)` → `await request.onPersist?.(executedStep)`；
  5. 若 `assessResult.completionType === 'ask'`（第 630-634 行）：`executedStep.status = 'interacting'` → `await persistFinalize(undefined)` → `return { type: 'ask', assessResult }`（跳过门禁）。
- `buildFinalizeMeta`（第 367-375 行）：`{ status: assessResult.completionType === 'ask' ? 'ask' : 'completed', completionType, assessResult, ...(gateResult ? { gateResult, gateSessionId: gateResult.gateSessionId } : {}) }`。
- **executedStep 置 interacting 的位置**：`finalize-manager.ts` 第 631 行 `executedStep.status = 'interacting'`，随后经 `onPersist` 持久化到 `state.executedSteps`；askQuestion 载荷随 `finalizeMeta.assessResult.askQuestion` 一起落在该 executedStep 上。
- `stage-executor.ts` — `execute()`（第 346-350 行）在 `finalizeOutcome.type === 'ask'` 时：
  ```ts
  if (finalizeOutcome.type === 'ask') {
    // Task 4 接交互等待循环；Task 3 仅置 interacting 标记并中止 Stage。
    await this.options.onPersist?.(executed);
    return this.buildResult(stageDef, executedSteps, 'interacting', passThroughVars, undefined);
  }
  ```
  `StageExecutionResult`（第 81-87 行）形状为 `{ stageContract, executedSteps, passThroughVars, status, errorDetail? }`，**不携带 askQuestion 载荷**——ask 载荷仅存在于 `executedSteps` 中对应 executedStep 的 `finalizeMeta.assessResult.askQuestion`（该 Step 同时 `status === 'interacting'`）。
- 现有 spec 断言（`finalize-manager.spec.ts` 第 458-479 行）：`marks the step interacting and skips the gate when assess returns ask`，断言 `outcome.type === 'ask'`、`executed.status === 'interacting'`、`llm.calls` 长度 1。

## ⑥ DSH 参考实现（`D:\project-code\llm\deepseek-harness`）

### user-questions（`packages/interaction/user-questions/src`）

- `index.ts`：
  - `ctx.userQuestions` 类型为 `UserQuestionService extends Service`（类，非接口），Service 名 `'userQuestions'`（第 51-55 行构造 `super(ctx, 'userQuestions')`）。
  - 真实签名：`ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>`（第 92 行）。
  - `AskUserQuestionRequest`（第 28-35 行）：`{ questions: AskUserQuestionItem[]; agent?: Agent; signal?: AbortSignal }`。
  - `UserQuestionProvider` 接口（第 38-40 行）：`ask(request): Promise<AskUserQuestionAnswer>`，经 `registerProvider(provider)` 注册（单活动 provider）。
  - `ask()` 校验（第 92-140 行）：`signal.aborted` → `ASK_ABORTED`；`questions.length === 0` → `EMPTY_QUESTIONS`；agent 非精确 live 实例 → `CALLER_NOT_LIVE`；agent 被其它 agent 持有 → `DELEGATED_CALLER`；intent 的 approve label 不匹配选项 → `BAD_INTENT`；无 provider → `NO_PROVIDER`。
- `types.ts`：
  - `AskUserQuestionOption`（第 9-14 行）：`{ label: string; description?: string }`。
  - `AskUserQuestionItem`（第 35-50 行）：`{ id: string; question: string; detail?: string; header?: string; options?: AskUserQuestionOption[]; multiSelect?: boolean; intent?: AskUserQuestionIntent }` —— 注意字段是 camelCase `multiSelect`，另有 `detail` 与 `intent` 两个 sandore 载荷没有的字段。
  - `AskUserQuestionIntent`（第 23-32 行）：`{ kind: 'plan-review'; approve: string }`。
  - `AskUserQuestionAnswerItem`（第 53-60 行）：`{ id: string; selected: string[]; custom?: string }`。
  - `AskUserQuestionAnswer`（第 63-66 行）：`{ answers: AskUserQuestionAnswerItem[] }`。

### tool-ask-user（`packages/interaction/tool-ask-user/src/index.ts`）

- 工具名 `ask_user_question`，`inject = ['tools', 'userQuestions']`（第 13-14 行）。
- 参数 schema 使用 snake_case `multi_select`（布尔，第 50-53 行）。
- execute 中的 **`multi_select` → `multiSelect` 映射**（第 81-91 行）：
  ```ts
  const result = await ctx.userQuestions.ask({
    questions: args.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...question.header !== undefined ? { header: question.header } : {},
      ...question.options !== undefined ? { options: question.options } : {},
      ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},  // 映射点
    })),
    ...exec.agent !== undefined ? { agent: exec.agent } : {},
    signal: exec.signal,
  })
  ```
- 输出 schema（第 58-78 行）：`{ answers: [{ id, selected: string[], custom? }] }`；`execute` 返回 `{ answers: result.answers.map(...) }`。

### apiproxy（`packages/host/apiproxy/src/api`）

- `events.ts` 的 `MuxFrame` union（第 69-108 行）含问答帧：
  - `{ type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }`（第 74 行）
  - `{ type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }`（第 75 行）
  - 另有 `approval/requested`、`approval/resolved` 帧。
- `questions.ts`（第 16-19 行）：`QuestionResponsePayload { sessionId: SessionId; answer: AskUserQuestionAnswer }`（一次 ask() 整批作答，不分题）。
- `questions.schema.ts`（第 14-26 行）：`askUserQuestionAnswerSchema = { answers: [{ id: string, selected: string[], custom? }] }`、`questionResponsePayloadSchema = { sessionId, answer }`。

## ⑦ `workflow/tests/mocks` — userQuestions mock 现状

目录：`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\`

现有 mock 文件（共 7 个）：`agents.ts`、`llm.ts`、`sessions.ts`、`shell.ts`、`storage-domain.ts`、`subagents.ts`、`subprocess.ts`。

**无 `userQuestions` mock**（若后续需 mock 需新建）。

`workflow-engine.spec.ts` 的 `harness()`（第 305-339 行）当前提供的服务为：`storageDomain`、`llm`、`shell`、`sessions`、`sessionPersistence`（`{}`）、`subagents`、`agents`、`subprocess`、`fs`（`{}`）——**未提供 `userQuestions`**。

## ⑧ `workflow-engine.spec.ts` 对 interacting 分支的既有断言

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.spec.ts`

- **无任何测试直接覆盖 `interacting` 分支**（`runInstance` 第 381-387 行）。
- 与 userQuestions / 注入相关的唯一断言（第 383-387 行）：
  ```ts
  it('declares agents and userQuestions in the seam inject list', () => {
    expect(SandoreEngineStub.inject).toContain('agents');
    expect(SandoreEngineStub.inject).toContain('userQuestions');
    expect(SandoreEngineRuntime.inject).toContain('agents');
  });
  ```
  （注意该断言只要求 Stub 含 `userQuestions`、Runtime 含 `agents`，未要求 Runtime 含 `userQuestions`。）
- 相关 schema 断言（`schema.spec.ts` 第 168-207 行）：`parses structured pending interaction entries` 验证 `pendingInteractions` 可解析 question/permission 两个变体（断言 `kind`、`status`、`answer`）；`still parses an empty pendingInteractions array` 验证空数组。
- 集成测试等待信号仅覆盖终态：`waitForEnd`（`sandore/end`）、`waitForAborted`（`sandore/aborted`）、`waitForStepStart`；无 `waitForQuestion` / `sandore/question` 等待助手。
