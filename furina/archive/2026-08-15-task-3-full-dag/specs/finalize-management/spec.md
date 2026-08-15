# Spec: finalize-management — Step 收尾拆分（Assessor + GateEvaluator）

## ADDED Requirements

### Requirement: FinalizeAssessor 会话策略
系统 SHALL 按.Step 类型选择 Assessor 会话：session 类型（agent/prompt/skill/mcp）经 `ctx.sessions.fork(stepSessionId)`（boundary 省略，取源最后一条事件，避免 OPEN_TURN）创建 fork 会话执行评估；shell 类型经 `ctx.llm.stream()` 临时会话（shell stdout 作为输入）执行评估。fork 失败 SHALL 降级为临时会话并记录 `finalizeMeta.errorDetail`。

#### Scenario: session 类型 Step fork 会话
- **WHEN** agent Step 收尾评估
- **THEN** `ctx.sessions.fork(stepSessionId)` 创建 fork 会话，评估在 fork 会话上执行，`FinalizeAssessResult.forkSessionId` 为 fork 会话 ID

#### Scenario: fork 失败降级
- **WHEN** `sessions.fork` 抛错（如源会话事件不足）
- **THEN** 降级为 `ctx.llm.stream()` 临时会话完成评估，Step 不失败，`finalizeMeta.errorDetail` 记录降级原因

### Requirement: 完成判定与透传变量提取
系统 SHALL 在 Assessor 评估中完成两件事并合并为一个 JSON 返回：① 完成判定 `completionType: 'completed' | 'ask'`；② 透传变量提取（`passThroughVars: Record<string, string>`）。评估提示词 SHALL 含 `<stepContext>`（input/output/artifacts XML 块）、透传变量列表（name + description）、返回 JSON 格式与红线规则。解析 SHALL 三级回退（JSON → regex → 原始输出）。

#### Scenario: 提取透传变量
- **WHEN** Step 定义了透传变量 `projectName` 且评估输出 `"passThroughVars": {"projectName": "sandore"}`
- **THEN** `FinalizeAssessResult.passThroughVars.projectName = 'sandore'`，并回写引擎 `passThroughVars`（保留 `refresh` 标志）

#### Scenario: completionType 判定为 ask
- **WHEN** 评估输出 `"completionType": "ask"` 且含合法 `askQuestion`
- **THEN** `FinalizeAssessResult.completionType = 'ask'`，`askQuestion` 字段携带问题载荷

### Requirement: ask 转 AskUserQuestionPayload
系统 SHALL 在 `completionType='ask'` 时将 `askQuestion` 转换为 `AskUserQuestionPayload`（`questions[]` 每项含 `id`（stable id）、`question`、`header?`、`options?`（`{label, description?}`）、`multi_select?`，对齐 DSH `ask_user_question` schema），并将 Step 标记为 `interacting` 状态。Task 3 范围内 SHALL 仅产出载荷与状态标记（不实现用户回复等待循环——属 Task 4）。

#### Scenario: ask 载荷构造
- **WHEN** 评估输出含 `askQuestion.questions = [{id: 'q1', question: '选择分支', options: [{label: 'A'}]}]`
- **THEN** 构造的 `AskUserQuestionPayload.questions[0]` 保留 id/question/options 字段，Step 状态置为 `interacting`

### Requirement: GateEvaluator 独立 session 双门审查
系统 SHALL 由 GateEvaluator 恒开独立新临时会话（`ctx.llm.stream()`，与 Assessor 完全隔离）执行门禁：primary gate（校验产物文件存在 + 基本完成度 → `{"taskStatus": "done|error", "errorDetail"}`）；secondary gate（`secondaryEnabled=true` 时注入 `secondaryPrompt` 完整审查 → `{"gateStatus": "done|error", "gateDetail"}`）。`gatesPassed=true` 后 SHALL 再验证所有 outputTo 文件存在，任一缺失则覆盖为 `gatesPassed=false`。

#### Scenario: primary 门禁通过
- **WHEN** 配置 primary 门禁、产物文件存在且评估返回 `taskStatus: 'done'`
- **THEN** `GateEvalResult.gatesPassed = true`、`primaryPassed = true`

#### Scenario: 产物存在性覆盖门禁结果
- **WHEN** AI 门禁返回通过但某 outputTo 产物文件不存在
- **THEN** `gatesPassed` 覆盖为 `false`，`errorDetail` 说明缺失文件

### Requirement: finalizeStep 编排
系统 SHALL 按以下编排收尾：① 跳过检查（无未解析透传变量 + 无门禁 → 直接 `{type:'done', completionType:'completed'}`，零 AI 调用）；② assessor.assess；③ `completionType='ask'` → 注入 askQuestion 载荷 + Step 置 `interacting` + 返回 `{type:'ask'}`；`'completed'` → 继续；④ 有 enabled 门禁时 gateEvaluator.evaluate；⑤ `gatesPassed` 判定 → done/error；⑥ 回写 passThroughVars（保留 refresh）；⑦ 同步 finalizeMeta 到 executedSteps；⑧ persistState。

#### Scenario: 无变量无门禁跳过 finalize
- **WHEN** Step 无透传变量且未配置门禁
- **THEN** finalize 零 AI 调用直接返回 done

#### Scenario: ask 中断门禁
- **WHEN** Assessor 判定 `ask` 且配置了门禁
- **THEN** 返回 `{type:'ask'}`，Step 置 `interacting`，门禁评估不执行（待用户回复后继续，Task 4 范围）

### Requirement: FinalizeMeta 扩展与结果类型
系统 SHALL 扩展 `FinalizeMeta`：新增 `completionType?: 'completed'|'ask'`、`assessResult?: FinalizeAssessResult`、`gateResult?: GateEvalResult`；SHALL 定义 `FinalizeAssessResult`（completionType/passThroughVars/askQuestion?/errorDetail?/forkSessionId/assessmentRaw）、`GateEvalResult`（gatesPassed/primaryPassed/secondaryPassed?/gateDetails?/errorDetail?/gateSessionId/assessmentRaw）、`FinalizeOutcome`（done/ask/error 三态联合类型）。错误码 SHALL 补 `FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST`。

#### Scenario: finalizeMeta 完整记录
- **WHEN** Step 完成完整 finalize（assess + gate 均执行）
- **THEN** executedSteps 该条目的 `finalizeMeta` 含 `status`、`completionType`、`assessResult`、`gateResult`、`gateSessionId`
