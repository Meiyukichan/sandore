# 工作流执行段快照 + 用户消息时间线 — 变更计划

> 版本: 1.0 | 状态: 待实施 | 最后更新: 2026-08-18
> 关联设计: [`overall-design.md`](overall-design.md)（总体设计）、[`dynamic-workflow-engine.md`](../engine/dynamic-workflow-engine.md)（引擎 v2.6 技术设计）

---

## 1. 背景与动机

### 1.1 现状问题

讨论页（RunView）当前的消息来源只有**状态快照**（`WorkflowTaskState`）：

- `originalInput` → 初始用户气泡
- `executedSteps[]` → 每 Step 一张卡片

三个真实缺陷：

1. **用户消息无处展示**。暂停恢复、失败重试时你发的指令，引擎只把它存进 `executedSteps[].resumePrompt`（单字段、覆盖写），`buildTimeline` 不读它——用户输入在讨论页完全消失。
2. **executedSteps 不允许"执行段"重复**。`onPersist` 按唯一执行 id **upsert**：暂停 → 继续、失败 → 重试都是**同一条记录原地改状态**（`paused→running→completed`）。时间线上只有一张卡，暂停/继续/重试的**历史快照全部丢失**，无法呈现"暂停 → 用户继续 → 继续执行"的序列。
3. **无统一时间轴**。executedSteps 只有可选的 `startedAt`/`updatedAt`，排序依赖数组插入序，无法与用户消息按时间归位。

### 1.2 目标模型

讨论页消息 = 三部分，统一时间戳合并排序：

```
用户消息（userMessages）  +  执行段（executedSteps）  +  宿主主代理对话（后续再做）
        │                          │                          │
        └──────────────►  统一 createdAt 时间轴  ◄────────────┘
```

**本期只做前两部分**；宿主主代理对话（完成态工作流继续对话）作为后续增量，不在本计划范围内。

### 1.3 核心决策

> **executedSteps 从"每 Step 一条"改为"每次执行段一条"（attempt 模型）。**
>
> 暂停/失败保留该段的定格快照；继续/重试在**该 Step 的既有记录基础上创建一条新段**推入 executedSteps。每条段有唯一执行 id + `attemptIndex` + `createdAt`。

这与 v2.6 原设计（`executedSteps[]` 扁平数组）一致，且与**重试 fork/revert 已产生新子代理会话（新 childId）**的现有行为对齐——当前"会话已换、记录不换"正是撕裂点。

---

## 2. Schema 变更

### 2.1 `ExecutedStepDefaultSchema` 字段调整

```ts
// schema.ts
export const ExecutedStepDefaultSchema = z.object({
  // ...既有字段...
  /** 本执行段开始时间（ISO；统一时间轴的排序键）。 */
  createdAt: z.string().optional(),
  /** 执行段序号（同 stepId 第几次执行；0-based，缺省 0 = 首次执行）。 */
  attemptIndex: z.number().int().nonnegative().optional(),
  // pausedAt 保留（暂停定格时刻）；resumedAt / resumePrompt / type 移除（见下）
})
```

- `attemptIndex` 可选：兼容旧快照（旧数据无该字段，视为 0）。
- **暂停细节字段调整**：
  - `pausedAt` 保留：暂停定格时刻（段快照展示"暂停于 xx"）。
  - `resumedAt` / `resumePrompt` **移除**：恢复时刻由新段的 `createdAt` 表达；恢复消息统一存 `userMessages`，段内不留冗余。
  - 旧快照中的 `resumedAt`/`resumePrompt` 在重新持久化时被 zod 剥离（zod object 默认 strip 未知字段）。
- **`type: z.literal('default')` 移除**：
  - **性质**：v2.6 遗留的判别联合标签——旧版用 `type` 区分 `ExecutedStepDefault` 与已删除的 `ExecutedStepLoop`；V2.3 移除 Loop 后该字段成为"单值枚举"死字段。
  - **现状**：引擎/UI 全仓库无任何代码读取 `type`（仅 schema 声明与 spec 构造出现），纯冗余。
  - **清理**：从 schema、`makeInitialState`、`stage-executor` 构造、spec 中一并移除 `type: 'default'`。旧快照残留 `type` 字段被 zod strip，自动兼容。
- **执行段 `id` 改为纯 UUID**：
  - **当前问题**：`executedSteps[].id` 由 `synthesizeChildId(step.id)` 生成（`step-{stepId}-{8位hex}`），而 stepId 本身已是 `step-{uuid}` → 出现 `step-step-{uuid}-{hex}` 双层前缀，且与 `sessionMeta.childId` 共用同一生成器、语义混淆。
  - **改为**：执行段唯一 id 用**纯 UUID**（`globalThis.crypto.randomUUID()`），每次执行段（首次执行 / 暂停恢复新段 / 重试新段）各生成一个新的 UUID。
  - **与 childId 解耦**：`executedSteps[].id` = 纯 UUID（段标识）；`sessionMeta.childId` 保持合成占位或真实子代理会话 id（`onChildStarted` 更新）——两者不再混用。
  - **涉及**：`stage-executor.ts`（`newExecId()`：routing/command 节点 id）、`lifecycle-manager.ts` `commitResumeSegment`（恢复段 id）、`recovery-manager.ts`（重试新段 id）。`synthesizeChildId` 仅保留给 `sessionMeta.childId` 占位与 revert/fork 新会话 id。
  - **兼容**：旧快照的 `step-step-…` id 是字符串，schema 无格式约束，直接兼容；新段写入后即纯 UUID。

### 2.2 `WorkflowTaskStateSchema` 新增 `userMessages`

```ts
/** 用户消息（原始需求 / 恢复 / 重试，统一时间轴渲染）。 */
export const UserMessageRecordSchema = z.object({
  id: z.string(),                 // usr-{uuid}
  kind: z.enum(['input', 'resume', 'retry']),
  /** 目标：'broadcast'（广播）或 Step 定义 id（定点）；input 时为 ''。 */
  target: z.string(),
  content: z.string(),            // 用户消息文本
  createdAt: z.string(),          // ISO，统一时间轴排序键
})

export const WorkflowTaskStateSchema = z.object({
  // ...既有字段...
  userMessages: z.array(UserMessageRecordSchema).optional(),
})
```

- **原始需求也进 `userMessages`**（`kind:'input'`，引擎 startInstance 时写入一条，`target:''`）——统一由 `userMessages` 承载所有用户消息，时间轴渲染不再依赖 `originalInput` 单字段。
- `originalInput` 字段**保留**（引擎内部/兼容旧快照），但 UI 时间线优先从 `userMessages` 渲染用户消息。
- `userMessages` 可选：兼容旧快照（缺省空数组，此时 UI 回退用 `originalInput` 渲染首个气泡）。

---

## 3. 引擎层变更

### 3.0 宿主主代理创建（`host-agent.ts` / `workflow-engine.ts` startInstance）

**当前问题**：`createHostAgentSetup` 注册 8 个 `sandore_*` 编排工具 + 一段"编排器主代理"角色提示词，**没有挂 DSH 默认主代理的能力**（系统提示词 / skills / 工具）——宿主会话是"阉割版"，且工具/角色提示词与"通用助手"定位冲突。

**改为：宿主主代理 = 纯 DSH 默认主代理**（与工作区默认对话完全一致）：

```
ctx.agents.create({
  sessionId: SessionId(instanceId),
  meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
  setup: async (agentCtx) => {
    await ctx.agentPresets.mount(agentCtx)   // 唯一动作：挂 DSH 默认 preset（系统提示词/skills/工具全进来）
  },
})
```

**不叠加任何 sandore 工具、不注入角色提示词**——理由：

- 引擎驱动执行、UI 走 RPC，8 个 sandore 编排工具没有任何"必需"消费场景（暂停/恢复/重试/状态都有按钮）；工具 schema 反而占模型上下文、暗示"你是编排器"。
- 角色提示词 `sandore-host` 与 DSH 默认系统提示词并存会造成角色冲突（"通用助手" vs "编排器"），尤其破坏完成后自由对话的自然延续。
- 唯一必须保留的是 **`hostAgent` 引用**（不是注册！）：引擎用它的身份做 `subagents.interrupt`/`followup` 的 authority/parent——这是 DSH 机制要求，与工具注册无关。

要点：

- **`agentPresets.mount(agentCtx)`（无 id = 默认 preset）**：与工作区普通会话走同一组装路径——宿主主代理获得与普通对话一致的系统提示词、skills、工具集。
- **`ctx.agentPresets` 服务缺失时**（无 preset 部署）：跳过 mount（与 apiproxy `composeAgent` 的 `presets === undefined` 分支一致）。
- **`meta.agentPreset`：须在 `ctx.agents.create` 调用前 resolve**（探索确认：会话边界在 setup 前快照 meta，setup 内记录不可行——对齐 `api-proxy.ts:1196-1217` 的 `composeAgent`：先 `presets.resolve(presetId)` 得 resolvedId，再传 `meta.agentPreset` + setup 内 mount）。实现：`startInstance` 里 `const resolvedId = (await ctx.get('agentPresets')?.resolve())?.id`，`meta: { cwd, ...(resolvedId ? { agentPreset: resolvedId } : {}) }`。
- **崩溃恢复 `agents.resume` 的 setup 同样**只 mount（保持冷恢复后能力一致）。
- **类型前置**：sandore 接缝 `AgentSetupContext`（`microflow/subagents.ts:68-71`）只有 `tools`/`systemPrompt`，缺 `agentPresets` 声明与真实 `Context`——改 setup 前先补类型（host-agent.ts 的 setup 需要访问 `ctx.agentPresets`，需经 `agentCtx` 真实 Context 或注入）。

### 3.1 子代理能力（`step-runner.ts` / microflow subagents）

**① 工具继承 + 系统提示词：子代理必须与宿主主代理完全一致（DSH 默认能力）。**

DSH 的 `applyChildComposition(childCtx, parent, composition)`（`subagent/child-agent.ts`）在子代理创建窗口内执行：

```
childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)   // 子代理 join 父（宿主主代理）的同一 preset 组合
childCtx.systemPrompt.context({ name: 'subagent:delegation', ... }) // 委托角色说明
```

- `composeFrom` 让子代理 **join 宿主主代理挂载的同一 preset**（即 DSH 默认 preset）——宿主主代理的工具、**系统提示词（含 deepseek 默认系统提示词）**、skills **自动出现在子代理里**（同 generation，不是重新 resolve）。
- **硬性要求**：子代理与主代理同源——能调用主代理的所有工具、携带 deepseek 系统提示词注入。宿主主代理是纯默认 preset（3.0）后，子代理经 `composeFrom` **天然一致**，无 sandore 工具/提示词需要额外处理。
- sandore 现状：`startContinuable({ request: { parent: hostAgent } })`——parent 已是宿主主代理，`composeFrom` 生效，无需改动即获得继承。**实施时验证**：子代理 session 实际可见的工具/系统提示词与宿主主代理一致（含 DSH 默认 preset 的 tool-ask-user 等模型工具）。

**② 子代理执行中提问：`ask_user_question` 的直接使用被 DSH 拦截，需 sandore 转发。**

- DSH 有现成模型工具 `ask_user_question`（`interaction/tool-ask-user`，走 `ctx.userQuestions.ask()`），且 UI 有现成接管面板（`ui-user-questions` 的 composer-takeover）。
- **障碍**：`userQuestions.ask()` 对**非根 agent（owned by another agent）一律抛 `DELEGATED_CALLER`**（`user-questions/src/index.ts`：`if (!agents.roots().includes(agent)) throw DELEGATED_CALLER`）。sandore 的 Step 子代理（parent = hostAgent，非根）**直接调用必然被拒**——这是 DSH 的设计（owned child 没有独立的人类应答者，防死锁）。
- `ContinuableStartSpec` 无自定义 setup/工具注入入口（工具继承固定走 `applyChildComposition`），所以不能给子代理"改造过的 ask 工具"。

**因此 sandore 采用"子代理问 → 引擎级 ask 转接"（与现有 `[[SANDORE_ASK]]` 标记块机制同族）：**

- 方案：给 Step 子代理注入一个 **`sandore_ask_user` 工具**（走 `registerContinuableSetup` 贡献，`activation-setup-registry.ts` 的 `ContinuableSetupContribution`，可给子代理挂额外工具），子代理执行中调用它时：
  1. 工具 `execute` 把问题**上报宿主主代理**（或直接进引擎 `interactions`），挂起子代理等待
  2. 引擎把问题转成 `PendingQuestionEntry`（`kind:'question'`，走现成 `interactions.ask` / `userQuestions` 管道）→ UI 在 composer 接管面板展示（与现有 ask 流程一致）
  3. 用户回答 → 答案经 `followup` 注回子代理，子代理收到回答后继续执行
- 这等价于把 `DELEGATED_CALLER` 绕过到"根侧应答"：子代理不直接问用户，而是**经宿主主代理这个根转发**。

> **实施顺序说明**：`ask_user_question` 转接依赖宿主主代理能力（3.0）与现有交互管道，且与 `[[SANDORE_ASK]]` 标记块机制可合并/替代（标记块是"收尾时发现需提问"，工具是"执行中主动提问"）。建议作为**独立增量**排在段模型（3.3–3.7）之后，不在本期第一批。

### 3.2 提示词结构对齐（对照 `docs/engine/dynamic-workflow-engine.md`）

**现状核实：sandore 各提示词结构与 v2.6 文档已一致**（实施时保持，不回归）：

| 环节 | v2.6 文档结构 | sandore 实现（`microflow/`） | 状态 |
|---|---|---|---|
| Step 执行（Agent 会话） | 主头部 + `## 你的任务` + `## 参考信息`（`### 用户原始需求`/`### 当前Step参数`）+ `## 前置Steps输出与产物`（`### 前置Step: {name} ({id})` + `<{id}><output>/<artifacts>`）+ `## 任务规则`（键值） | `step-runner.ts` `buildPromptText` 同构 | ✅ 一致 |
| 收尾评估（FinalizeAssessor） | `<stepContext>` XML（input/output/artifacts）+ `## 你的任务`（completionType 判定 + 透传变量提取）+ `## 透传变量` + `## 返回格式（JSON）`（`completionType`/`passThroughVars`/`askQuestion`）+ `## 红线规则` | `finalize-manager.ts` `buildAssessPrompt` 同构 | ✅ 一致 |
| 门禁审查（GateEvaluator） | Primary：`{"taskStatus": "done\|error", "errorDetail"}`；Secondary：注入 `secondaryPrompt` → `{"gateStatus": "done\|error", "gateDetail"}` | `buildPrimaryGatePrompt`/`buildSecondaryGatePrompt` 同构 | ✅ 一致 |
| 分支评估（BranchEvaluator） | 条件 prompt + 上下文 + 分支列表 + `{"branchExpectation"}` + 红线 | `branch-evaluator.ts` 同构（`{"shouldExecute": true/false}` + `branchExpectation` 解析） | ✅ 一致（输出字段按 DSH harness 布尔化，解析兼容） |
| 循环跳出（LoopManager） | `checkLoopBreak` 注入 breakCondition + `<input>/<output>/<artifacts>` + `{"shouldBreak"}` | `loop-manager.ts` 同构 | ✅ 一致 |

**约束**：任何提示词调整（如为子代理 ask 注入额外 section）必须保持上述结构——头部/子节标题/XML 块/返回格式 JSON 字段/红线规则不得偏离 v2.6 文档，避免污染变量提取与门禁判定。

### 3.4 实例启动（`workflow-engine.ts` startInstance）

- `makeInitialState` 后写入一条 `userMessages: [{ kind:'input', target:'', content: request.originalInput, createdAt: now() }]`——原始需求进入统一时间轴。

### 3.5 暂停 / 恢复（`lifecycle-manager.ts` / `stage-executor.ts`）

当前：`pauseStep`/`resumeStep` 经 `commitStepStatus` **原地改**同一条 executedStep。

改为（**段创建权归执行器，lifecycle 不建段**——探索确认原计划 §3.5"lifecycle 建段"与 §3.8"执行器同 id 复用"矛盾，定夺为执行器建段）：

- **`pauseStep(stepId)`**：定位"最后活跃段"（status `running`/`interacting`、`stepId` 匹配、`attemptIndex` 最大），原地冻结为 `paused`（保留 `pausedAt`）——**段不新增**。
- **`resumeStep(stepId, resumePrompt?)`**（lifecycle 只做协调，**不建段**）：
  1. `followup(childId, [resumePrompt ?? 默认])` 唤醒子代理（childId = 被暂停段 `sessionMeta.childId`，同一子代理会话）
  2. 移出暂停登记表
  3. **追加一条用户消息**：`userMessages.push({ id, kind:'resume', target: stepId, content: resumePrompt, createdAt })`（**段内不写 resumePrompt**）
  4. 发射 `sandore/step-resumed`；**新段的创建由执行器续跑时完成**（见下）
- **`resumeAllSteps(resumePrompt?)`**：遍历登记表逐段 followup + 移表 + 建段（见下），**只追加一条** `userMessages`（`target: 'broadcast'`）——广播指令是实例级事件，不得复制进每个 Step（**探索发现现状会追加 N+1 条，必须改**）。
- **执行器续跑建段**（`stage-executor.ts` `resumePendingPaused` / `resumeSubagentStep`）：
  - 续跑时基于被暂停段**新建段对象**：`id: crypto.randomUUID()`、`attemptIndex+1`、`createdAt: now()`、`status:'running'`、`sessionMeta` 保持原 childId——**不再复用旧段 id**（探索确认现状 `resumePendingPaused` 复用旧段 id → onPersist 把 paused 旧段覆盖成 completed、新段永远 running，是 P0 发散 bug）。
  - 新段走 `finishCommandNode`（同 id 去重天然生效：新 id 追加、ask 续跑同 id 替换）。
- **`findStep` / 活跃段定位**（`lifecycle-manager.ts` / `workflow-engine.ts`）：按 `stepId` 过滤后取 `attemptIndex` 最大者（现状 `.find` 取第一个，恢复后再暂停会静默 no-op 或错配陈旧段）。

### 3.6 重试（`recovery-manager.ts`）

当前：`retryStep` 同 id 原地改（`retryHistory` 累积）。

改为：

- 以 failed 段为基底创建新段（`attemptIndex+1`、`id: crypto.randomUUID()`、`createdAt`），`retryHistory` 挂在新段上。
- `continue`：childId 不变；`revert`/`fork`：新子代理会话（新 childId）——新段的 `sessionMeta.childId` 用新会话 id，`parentSessionId` 记旧值（现有逻辑已如此）。
- **保留旧 failed 段定格快照**（含 `error` 明细），不原地改。
- **`commitRunningStep` 改为追加新段**（现状按 `item.id === step.id` 原地替换）；`failRetry`/`setRetryResult`/续跑后定位**改用新段 id**（探索发现现状按旧 id 定位会漏）。
- 追加 `userMessages.push({ kind:'retry', target: stepId, content: message, createdAt })`（**探索发现 appendUserMessage 声明了但从未调用，且 workflow-engine.ts 构造 RecoveryManager 缺传该必填参数 → 当前 tsc 必挂，必须先接线**）。

### 3.6A ask 收尾闭环（`finalize-manager` / `interaction-manager` / `workflow-engine` / RunView）

**目标**：收尾评估判定 `completionType='ask'` 时，Step 回退 `interacting` → ask 问题上报 → 讨论页提供用户选择 → 用户回答回传 Step/子代理 → 继续执行。

**现状**（已具备大半）：
- `FinalizeAssessor.assess` 返回 `completionType='ask'` + `askQuestion`
- 引擎 `finishCommandNode` 得 'ask' → `resumePendingAsk` 保留断点 → 引擎 `interacting` → `interactions.ask`（`ctx.userQuestions.ask`，hostAgent 身份）挂起等答案 → 用户回答 → `executor.execute()` 续跑（`finalizeStepAfterAsk` 重跑门禁 + 推进）

**缺口（本计划补齐）**：

1. **Step 状态回退 `interacting`**：引擎已把实例 `status='interacting'`，但需确保该 Step 段（executedSteps 条目）`status='interacting'`（当前 `finishCommandNode` 的 ask 分支仅 `onPersist`，未显式改段状态——实施时确认并在 ask 分支置 `executed.status='interacting'`）。
2. **ask 问题上报 → 讨论页展示**：`PendingQuestionEntry` 已含 `payload.questions`，前端 `QuestionCard`（composer 接管面板）已有渲染；需确保 RunView 的 `partitionInteractions` 从 `pendingInteractions` 取出 question 并驱动 `QuestionCard`（现状应已接，实施时验证端到端）。
3. **用户选择 → 回传子代理继续执行**（关键缺口）：
   - **收尾 ask（当前 Step 是 agent/skill/mcp 子代理会话）**：用户回答后，引擎续跑 `finalizeStepAfterAsk` 已能继续；但对**子代理 Step**，回答应 **`followup` 注回子代理会话**，让子代理基于回答继续（而不是只重跑门禁）。实施：`interactions.ask` resolve 后，若 Step 有真实 `sessionMeta.childId`，把回答文本 `followup(childId, [answerText])` 注回，再续跑。
   - **收尾 ask（shell/prompt 无真实会话）**：无子代理可回传，走现有 `finalizeStepAfterAsk`（重跑门禁 + 推进）。
4. **用户消息进 `userMessages` 时间轴**：用户对 ask 的回答作为一条用户消息写入 `userMessages`（`kind:'ask'` 或复用 `resume`？——建议新增 `kind:'answer'`），与恢复/重试消息统一按 createdAt 排序渲染（呼应 §2.2）。

> **与 §3.1② 的关系**：§3.1② 是"子代理**执行中**主动调 `sandore_ask_user` 工具提问"（后续增量）；本小节是"子代理**收尾**被判定 ask"（现有 FinalizeAssessor 机制）。两者共用 `interactions.ask` 管道与讨论页 `QuestionCard`，答案回传子代理的 `followup` 逻辑可复用。

**探索确认的 P0 修正（2026-08 探索，三份报告交叉验证）**：

1. **Step 段 interacting 已满足**：`finalize-manager.ts:625` 已在 `finalizeStep` 内显式 `executedStep.status='interacting'`（提交前已有代码），随 onPersist 落盘。计划原"缺口 1"过时；保留防御性：`stage-executor.ts` ask 分支（:582-588）显式 `executed.status='interacting'`。
2. **ask 回答丢弃（关键缺口确认）**：`workflow-engine.ts:629` `await interactions.ask(...)` **丢弃返回值**，回答只当解锁信号；`resumePendingAsk → finalizeStepAfterAsk` 用旧 output 重跑门禁，**子代理从未收到回答、新输出不被收集**。修复：
   - `workflow-engine.ts` interacting 分支：`const answer = await active.interactions.ask(...)` → 若 `ask.step.sessionMeta?.synthetic === false`（真实子代理），`followup(hostAgent, childId, [{type:'text', text: buildAnswerText(answer)}])` → 再 `executor.execute()`。
   - `stage-executor.ts resumePendingAsk`：有真实 childId 时先 `runner.resumeSubagent(...)` **重收集新 output** → 更新 `executed.output` → 以新 output 重跑完整 finalize（对齐 `[[SANDORE_ASK]]` 循环），加 ask 轮次上限。
   - 抽共享 `buildAnswerText(answer): string`（types.ts 的 AskUserQuestionAnswer → 文本）。
3. **pendingInteractions 全量历史 → 讨论页复弹卡死（P0）**：`interaction-manager.spec` 的 `syncState` 持久化 pending + resolvedEntries 全量；前端 `partitionInteractions` 不筛 status → 回答后 5s 轮询**再次弹接管面板**，二次提交 `replyQuestion` 抛 `INVALID_OPERATION` 无法关闭。修复：
   - 后端 `syncState()` 只持久化 `[...pendingQuestions.values(), ...pendingPermissions.values()]`（去掉 resolvedEntries）。
   - 前端 `partitionInteractions` 加 `status === 'pending'` 过滤（防御旧快照）。
4. **prompt 误进 fork（P0）**：`isSessionType` 含 'prompt'（`finalize-manager.ts:330-332`），而 prompt 无真实会话（sessionMeta 合成占位）→ 每次收尾评估 `sessions.fork(合成id)` 抛 `SESSION_NOT_FOUND` → 必降级。修复：`isSessionType` 去 'prompt'（或 FinalizeAssessor 仅 `synthetic===false` 时传 `stepSessionId`）。
5. **onChildStarted 落盘竞态**：`workflow-engine.ts:747` `void this.persistState(active)` fire-and-forget → 崩溃恢复快照 childId 仍为占位。修复：改 `await this.persistState(active)`。
6. **kind:'answer' 必须先进 schema**：`UserMessageRecordSchema.kind` 加 'answer'（现状无，直接写会被 state 表 zod 全量校验拒掉）；回答写入放 `workflow-engine.ts` interacting 分支（:629 接收 answer 后）。

### 3.7 引擎续跑定位（`workflow-engine.ts`）

- `resumeStageId` / `resumeInfo`：查找"最后活跃段"（`running`/`interacting` 中 `attemptIndex` 最大者），续跑播种用它。
- `onPersist`：**保持 upsert by id**——首次执行/新段（新 id）追加，ask 回复续跑（同 id）替换。段模型下"新段 = 新 id → 追加"天然成立，无需改 upsert 逻辑。
- `completedSteps` 播种：`resumeInfo` 收集已完成段；暂停段（paused）不参与 `previousOutputs` 重建（保留其定格快照即可）。

### 3.8 首次执行段（`stage-executor.ts`）

- `processCommandNode` / `processRoutingNode` 生成的 executedStep 补 `createdAt: now()`、`attemptIndex: 0`（或由 resumeFrom 播种传递）——**探索确认现状两处只写了 `id`（newExecId）未写 createdAt/attemptIndex**。
- `finishCommandNode` / `resumePendingAsk` / `resumePendingResume`：段级复用逻辑不变（同 id 去重），仅确保 `createdAt` 随段写入。
- **`resumePendingPaused` / `resumeSubagentStep`：改为基于旧段新建段对象**（`id: crypto.randomUUID()`、`attemptIndex+1`、`createdAt`，sessionMeta 保持 childId）——不再复用旧段 id（§3.5 段创建权归执行器）。
- **`types.ts` 同步**：`ExecutedStepDefault`（`workflow/src/types.ts:159-189`）加 `createdAt?`/`attemptIndex?`、删 `type`/`resumedAt`/`resumePrompt`——探索确认该类型与 schema 已漂移（缺新字段、仍含旧字段），而 stage-executor 从它 import 构造对象，不同步则 tsc 报错。
- **`processCommandNode` 的 `type:'default'` 同步删除**（探索确认现状 432/461 行仍写）。

### 3.8A 子代理消息持久化（`step-runner.ts` / `stage-executor.ts` / `workflow-engine.ts`）

**目标**：运行中的 Step 内嵌子代理消息框、失败/暂停的最后 N 条消息（execution-detail-prototype.html 的 `.agent-chat` / `.agent-last-list`）——当前 UI 已实现渲染，但数据源 `executedSteps[].sessionMessages` **引擎从不写入**，导致运行中显示占位、失败/暂停只有 fallback。

**根因**：与 fork session bug 同源——`sessionMeta.childId` 常为合成占位（`step-{stepId}-{hex}`），未指向真实子代理会话。

**改为**：

1. **`childId` 必须为真实子代理会话 id**（agent/skill/mcp 经 `startContinuable` 返回 + `onChildStarted` 更新进 `sessionMeta.childId`）——这是消息收集与 fork 的前提。
2. **引擎收集子代理消息**（`step-runner.ts`，真实会话存在时）：
   - 从子代理会话事件（`child.session.events`）提取：`user/message`、`assistant/message`（text/reasoning/tool-call/tool-result 块）、`tool/call`、`tool/result`（DSH `core/session/src/types.ts:243-333` 事件类型），归一为 `SessionMessage[]`（`{type:'text'|'tool'|'reasoning', text?, tool?, args?, output?}`，schema 已有）。
   - **采集时机**（探索给出的最小实现）：`collectSubagentOutput` 的 `child.whenIdle()` 后采集，随 `StepRunResult` 带出 → `finishCommandNode` 写 `executed.sessionMessages` → onPersist 持久化（完成/失败/暂停定格；失败/暂停保留到最后 N 条）。
   - **运行中实时**（可选，本期可后置）：执行期间引擎挂 interval 轮询子代理事件更新段 `sessionMessages`（前端 5s 轮询可见滚动）；若本期不做，运行中内嵌框显示占位、失败/暂停仍能显示最后 N 条（定格）。
   - **注意**：`recovery-manager.ts:342` 的 `cleanStepResidue` 会清 `sessionMessages`——重试新段构造时保留它（不清）。
3. **写入路径**：`onPersist`（upsert by id）把 `sessionMessages` 随段快照持久化；shell/prompt（无真实会话）保持无 `sessionMessages`（前端走 fallback）。

**前端**（`UnifiedTimeline.tsx` 已就绪，数据到位即生效）：
- running/interacting → `item.messages` 全量内嵌可滚动框（`.agentChat`）
- failed/paused → 最后 5 条（`.agentLastList`，末条按失败/暂停色）
- 标题点击 → `openSession(childId)` 跳 DSH 子代理页（真实 childId）

> **与 §3.6A 关系**：ask 收尾后答案回传子代理、fork 会话、消息收集——三者都依赖真实 `childId`，应一并修复。

### 3.9 编排器骨架 id 统一（`dag-editor-model.ts`）

**已修**：`createBlankDefinition` 骨架 Stage 由硬编码 `'stg-1'` 改为 `newId('stg')`（`stg-{uuid}`）——与 `createStage` 的 uuid 生成一致，避免"骨架 stg-1 + 后续添加 stg-uuid"格式混杂。测试已更新（`dag-editor-model.spec.ts` 只断言长度/名称/空 steps，不依赖具体 id）。

---

## 4. UI 层变更

### 4.1 `run-view-model.ts` — `buildTimeline` 三路合并

```ts
export function buildTimeline(state: WorkflowTaskState): TimelineItem[] {
  const items: TimelineItem[] = []
  // 用户消息（原始需求 / 恢复 / 重试）统一来自 userMessages
  for (const msg of state.userMessages ?? []) {
    items.push({ kind: 'user', content: msg.content, time: msg.createdAt, meta: { kind: msg.kind, target: msg.target } })
  }
  // 兼容旧快照：无 userMessages 时回退 originalInput 渲染首个用户气泡
  if ((state.userMessages ?? []).length === 0 && state.originalInput !== '') {
    items.push({ kind: 'user', content: state.originalInput, time: state.createdAt })
  }
  for (const step of state.executedSteps) {
    items.push({ kind: 'step', /* ...既有字段... */ attemptIndex: step.attemptIndex ?? 0, time: step.createdAt })
  }
  // 统一时间轴：严格按 createdAt（ISO 可 parse）升序
  return items.sort((a, b) => timeOf(a) - timeOf(b))
}
```

- `TimelineStepItem` 新增 `attemptIndex: number`。
- **排序规则：严格按 `createdAt` 时间戳升序**（用户消息与执行段共享同一时间轴）。旧快照段缺失 `createdAt` 时，按数组序排在其同 Step 段之后（仅兼容迁移期；新写入的段必有 `createdAt`）。

### 4.2 `UnifiedTimeline.tsx`

- Step 卡片标题：多段时显示 `第 {attemptIndex+1} 次执行` 后缀（`attemptIndex > 0` 或同 stepId 存在多段时）。
- 用户气泡：`TimelineUserItem` 按 `meta.kind` 区分文案——`input` 原样显示；`resume` 可加"继续"标记、`retry` 可加"重试"标记（target 为 broadcast 时显示"全部"），不改变气泡基本样式。
- 卡片 body 按段状态展示（paused 显示暂停时间；completed 显示 output），保持现有结构。
- **子代理消息渲染（数据来自 §3.8A 持久化的 `sessionMessages`，UI 已就绪）**：
  - running/interacting → 内嵌可滚动消息框（全量 `messages`，`.agentChat`）
  - failed/paused → 最后 5 条列表（`.agentLastList`，末条按失败/暂停色）
  - 标题点击 → `openSession(childId)` 跳 DSH 子代理页（仅真实 childId，`synthetic !== true`）

### 4.3 树导航 / 交互

- `buildRunTree`：已按 `stepIdOf` 聚合，多段自动合并到同一 Step 节点（不改）。
- 暂停/重试按钮、`resumeStep`/`retryStep` 定位：一律指向**最后活跃段**（`stepIdOf` 匹配 + `attemptIndex` 最大），引擎侧已适配。

---

## 5. 事件与持久化

- `sandore/step-paused` / `step-resumed` / `step-retried` payload：**新增 `attemptIndex`**（可选），讨论节点（宿主会话 chat 折叠）可区分段。
- `sandore/*` Session 事件不变（`taskId`/`workflowId`/`stepId` 等既有载荷）。
- sqlite 无需迁移：新字段全部 `optional`，旧快照可读可写（zod 宽松校验）。

---

## 6. 兼容性与风险

| 项 | 说明 |
|---|---|
| 旧快照兼容 | `attemptIndex`/`createdAt`/`userMessages` 全 optional；旧数据视为 attempt 0、无用户消息（UI 回退 originalInput）；旧快照残留的 `type`/`resumedAt`/`resumePrompt` 被 zod strip |
| upsert 语义 | 保持 `onPersist` upsert by id；新段新 id 自动追加 |
| 暂停段保留 | 旧 paused 段留在 `executedSteps`（含 `pausedAt` 定格时刻），`resumeInfo` 只找 `running`/`interacting`，不会重跑已暂停段 |
| 广播恢复 | `userMessages` 只追加一条 `broadcast`；各段**不写** `resumePrompt`（无冗余） |
| 旧字段清理 | `resumedAt`/`resumePrompt` 从 schema 移除；旧快照残留字段在重新持久化时被 zod 剥离 |
| UI 重复 | 用户消息是独立时间线实体（一次），不再从每段渲染，天然去重 |

---

## 7. 测试计划

| 文件 | 用例 |
|---|---|
| `host-agent.spec.ts` | setup 只做 `agentPresets.mount(agentCtx)`（默认 preset），不注册任何 sandore 工具、不注入角色提示词；无 agentPresets 服务时跳过 mount 不抛错 |
| `schema.spec.ts` | `attemptIndex`/`createdAt`/`userMessages` 可选、非法值拒绝、旧快照通过；`resumedAt`/`resumePrompt`/`type` 不再出现在 shape 中；`userMessages.kind` 枚举含 input/resume/retry |
| `stage-executor.spec.ts` | executedSteps id 为纯 UUID 且每次执行段唯一；`sessionMeta.childId` 与 `id` 解耦 |
| `lifecycle-manager.spec.ts` | 暂停冻结段（`pausedAt`）；恢复追加新段（新 id/attemptIndex+1/createdAt，`resumePrompt` 不写）；定点 `resume` userMessages target=stepId；广播只追加一条 `broadcast` |
| `recovery-manager.spec.ts` | 重试追加新段（保留旧 failed 段含 error）；fork/revert 新 childId 挂新段；`retry` userMessages target=stepId |
| `workflow-engine.spec.ts` | startInstance 写入 `input` userMessages；暂停→继续后 executedSteps 两条段（attemptIndex 0/1）；resumeInfo 定位最后活跃段；**ask 收尾：Step 段置 interacting、实例 interacting、回答后子代理 Step 收到 followup 续跑** |
| `step-runner.spec.ts`（子代理） | `startContinuable` parent=hostAgent 时子代理经 `composeFrom` 继承宿主工具；**子代理可见工具/系统提示词与宿主主代理一致（含 deepseek 默认提示词）**；`sandore_ask_user` 工具上报问题 → 引擎级 ask 转接 → 答案 followup 注回（本项属后续增量，见 §9）；**子代理消息收集 → `sessionMessages` 写入（text/tool 行归一）** |
| `finalize-manager.spec.ts` / `branch-evaluator.spec.ts` / `loop-manager.spec.ts` | 提示词结构回归：assess/gate/branch/loop 的输出 JSON 字段与 v2.6 文档一致（completionType/passThroughVars/askQuestion、taskStatus/gateStatus、branchExpectation/shouldExecute、shouldBreak） |
| `run-view-model.spec.ts` | buildTimeline 严格按 createdAt 升序（用户消息与段混合）；`input` 气泡来自 userMessages；旧快照回退 originalInput；多段卡片 attemptIndex；ask 回答作为 `answer` 用户消息渲染 |
| 端到端（dev） | 宿主会话具备 DSH 默认能力（系统提示词/skills/工具可用）；Step 子代理工具与宿主一致；暂停→发消息→继续：讨论页按时间显示 用户消息 + 两段卡；广播恢复只一条用户气泡；重试同理；**ask 收尾：讨论页 QuestionCard 展示问题 → 用户选择 → Step 续跑（子代理收到回答）** |

---

## 8. 实施顺序（探索修正后细案）

**第一批（编译收敛 + 段模型 + ask 闭环 + 时间线）：**

1. **schema.ts + types.ts 收敛**：schema 删 `type`/`resumedAt`/`resumePrompt`、`kind` 加 'answer'；`types.ts ExecutedStepDefault` 同步（加 createdAt/attemptIndex、删旧字段）；`stage-executor` 删 `type:'default'` 构造 ✅
2. **编译修复**：`workflow-engine.ts` 构造 RecoveryManager 补 `appendUserMessage` 接线（探索确认当前 tsc 必挂）；`makeInitialState` 写 `input` userMessages ✅
3. **段模型贯通**：
   - `lifecycle-manager`：`resumeStep` 去掉建段（只 followup/移表/消息/事件）；`resumeAllSteps` 只一条 broadcast 消息；`findStep` 找 attemptIndex 最大活跃段；**补 `commitPausedRegistry`（resumeStep/resumeAllSteps 删登记表后同步持久化 pausedChildIds + status）** ✅
   - `stage-executor`：`resumePendingPaused`/`resumeSubagentStep` 基于旧段**新建段对象**（纯 UUID + attemptIndex+1 + createdAt）；`processCommandNode`/`processRoutingNode` 补 createdAt/attemptIndex；**resumePendingAsk 重收集新 output + 完整 finalize + MAX_FINALIZE_ASK_ROUNDS 上限（§3.6A）** ✅
   - `workflow-engine`：`resumeStageId`/`resumeInfo`/`onChildStarted` 按 attemptIndex 最大活跃段；`onChildStarted` 落盘改 `await` ✅
4. **recovery-manager 重试段模型**：追加新段（保留旧 failed 段）+ retry userMessages + failRetry/setRetryResult 用新段 id；**fork/revert 二次 commit 改 upsert（commitStep），修复同 id 段重复追加** ✅
5. **pendingInteractions 瘦身**：`syncState` 只持久化 pending；前端 `partitionInteractions` 加 status 过滤 ✅
6. **ask 收尾闭环**（§3.6A）：`workflow-engine` interacting 分支接收 answer → `buildAnswerText` → 真实子代理 followup 注回 → 写 `kind:'answer'` userMessages；`stage-executor resumePendingAsk` 重收集新 output 重 finalize（加轮次上限）；`finalize-manager isSessionType` 去 'prompt'（prompt 不进 fork）✅
7. **子代理消息持久化**（§3.8A）：`step-runner` 采集 `collectSessionMessages`（whenIdle 后）→ StepRunResult 带出 → finishCommandNode 写 `sessionMessages`；`cleanStepResidue` 保留 sessionMessages ✅
8. **host-agent 宿主主代理**（§3.0）：setup 只 `agentPresets.mount`；`meta.agentPreset` 在 create 前 resolve；补 AgentSetupContext 类型（agentPresets 最小面）；移除 8 个 sandore 工具与角色提示词 ✅
9. **UI 时间线**：`run-view-model buildTimeline` 三路合并严格 createdAt 排序 + attemptIndex + userMessages meta；`UnifiedTimeline` 段标题 + 用户气泡 kind 标记；`buildRunTree` 同 stepId 聚合；`lastActiveSegmentsOf`（DiscussionInput 按最后活跃段）✅
10. **spec 更新**：schema/lifecycle/recovery/workflow-engine/run-view-model（探索报告 §8 列出的必挂断言）+ 新建 stage-executor.spec（5 用例：纯 UUID id / 段唯一 / childId 解耦 / createdAt+attemptIndex / resumeFrom 播种）+ host-agent.spec 重写（纯 preset）+ interaction-manager.spec（pending-only 持久化）✅
11. `tsc --noEmit` → 构建（workflow→ui）→ 重启 dev → 端到端验证 ✅
    - 448 单测全过（含 workflow 172 / microflow 143 / ui 115 / tool 18；新增 stage-executor.spec 5 用例）
    - **e2e 全场景（dev 3090，真实 LLM + fork-in-process subagent provider）**：
      - shell/prompt/agent step 单步 completed；`userMessages` 写 `{kind:'input'}`；段 id 纯 UUID + createdAt/attemptIndex 落盘；时间线按 createdAt 升序
      - **暂停→继续两段**：段0 paused 定格（pausedAt）+ 登记表 → 段1 attemptIndex 1 completed（新 id + sessionMessages）+ `resume` userMessage
      - **广播恢复**：pauseAll 只暂停 running 段；resumeAll 只追加一条 `{kind:'resume', target:'broadcast'}` 消息；全部段续跑完成
      - **重试段模型**：失败段 attemptIndex 0 定格 + retry 新段 attemptIndex 1（retryHistory）+ `retry` userMessage
      - **ask 收尾闭环**：finalize 评估返回 ask → 实例/段 interacting → pendingInteractions question → replyQuestion → `{kind:'answer'}` 落盘 → completed；UI QuestionCard 渲染（问题文本 + 自定义输入 + 下一步导航）
      - **UI 时间线**：需求/继续 kind 徽标、第 N 次执行 attempt 标签、暂停提示、完成段输出、无 pageerror
    - **e2e 发现并修复的两个真实 bug**：
      1. **暂停判定错误形状依赖（P0）**：DSH `Agent.cancel()` 只 abort signal、agent-loop `kick()` 吞错 → `whenIdle()` 正常 resolve，interrupt 后 `collectSubagentOutput` 抛 `'subagent produced no assistant output'`（STEP_EXECUTION 非 CANCELLED）→ 误落 failed。修复：stage-executor 以**暂停登记表为权威**（isPausedStep 命中即 paused，不再依赖 isCancellationError）
      2. **resumeSubagentStep 异常冒泡（retry/resume 续跑）**：重收集输出失败异常直接冒泡，新段停 running 造成「实例 failed + 段 running」不一致。修复：catch 后按首次执行一致落 failed（onStepFailed + onPersist）
      3. **pause→完成竞态登记表残留**：interrupt 软信号下子代理仍自然完成 → 段 completed 但登记表残留，resume 卡死。修复：engine onPersist 中 completed 且非合成时 `lifecycle.clearPausedOnCompletion(childId)` 清登记
    - **dev 环境补 subagent provider**：sandore agent step 经 `startContinuable({ provider: route.provider })`（LLM provider id 即 subagent provider 名），dev patch 挂 `subagent-fork-in-process`（providerName: deepseek-official）——进程内、支持 continuable、子代理继承宿主 preset 组合

**第二批（后续增量）：** `sandore_ask_user` 工具注入 + 引擎级 ask 转接（§3.1②）；运行中子代理消息实时轮询（§3.8A 可选）。

---

## 9. 后续（不在本期）

- **宿主主代理对话**接入讨论页：RunView 订阅 `ctx.sessions.binding(instanceId)` 的宿主会话事件流（或引擎镜像 `state.hostMessages[]`），与 userMessages/executedSteps 统一排序——完成态工作流的继续对话届时展示。
- **子代理执行中提问（`sandore_ask_user`）**：`registerContinuableSetup` 给 Step 子代理注入 `sandore_ask_user` 工具 → 上报宿主主代理/引擎 `interactions` → 走现成 ask 管道（UI composer 接管面板）→ 答案 `followup` 注回子代理续跑。与现有 `[[SANDORE_ASK]]` 收尾标记块机制可合并/替代（标记块 = 收尾发现需提问；工具 = 执行中主动提问）。
