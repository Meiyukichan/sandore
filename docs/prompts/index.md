# sandore 工作流 Prompt 模板索引

本目录收录 sandore 工作流引擎（`packages/sandore`）中**全部** LLM 提示词模板，
一模板一文件，含完整占位符参数。改动引擎模板时请同步更新对应文件。

| # | 文件 | 模板 | 来源（源码） | 触发场景 | 输出解析 |
|---|------|------|--------------|----------|----------|
| 1 | `step-execute.md` | Step 主执行提示词 `buildPromptText` | `microflow/src/step-runner.ts:244` | prompt/agent/skill/mcp 四路 Step 子代理执行 | 自由文本（子代理最终输出） |
| 2 | `step-fill-params.md` | 参数模板填充提示词 `buildFillParamsPrompt` | `microflow/src/step-runner.ts:279` | agent 定义含 `agentParamsTemplate` 时，先填充「当前 Step 参数」 | 填充后的模板文本 |
| 3 | `step-previous-outputs.md` | 前置 Steps 输出子节 `renderPreviousOutputs` | `microflow/src/step-runner.ts:179` | 被模板 1/2 共用（有前置输出时注入） | —（子节） |
| 4 | `branch-evaluate-single.md` | 逐条条件分支评估 `buildBranchPrompt` | `microflow/src/branch-evaluator.ts:152` | **⚠️ 遗留接口（生产走批量，仅 spec 覆盖，2026-08-25 已标注并清理代码）** | `extractShouldExecute` → `{"shouldExecute": bool}` |
| 5 | `branch-evaluate-batch.md` | 批量条件分支评估 `buildBatchBranchPrompt` | `microflow/src/branch-evaluator.ts:195` | Step 级多分支条件一次 fork 批量判断（**生产唯一路径**；变量替换 + 降级上下文注入） | `extractShouldExecuteBatch` → `{"shouldExecute": [id...]}` |
| 6 | `branch-evaluate-batch-correction.md` | 批量分支解析失败纠正 `buildShouldExecuteCorrectionHint` | `microflow/src/branch-evaluator.ts` | 批量判断输出不可解析，同 fork 子代理 followup 重试（上限 2 次；带失败原因） | 同 5 |
| 7 | `loop-break.md` | 循环跳出判断 `buildBreakPrompt` | `microflow/src/branch-evaluator.ts:247` | 循环 `breakCondition`（agent/prompt/skill/mcp） | `extractBreakResult` → `{"shouldBreak": bool}` |
| 7a | `loop-break-correction.md` | 循环跳出解析失败纠正 `buildBreakCorrectionHint` | `microflow/src/branch-evaluator.ts` | 解析失败，同 fork 子代理 followup 重试（上限 2 次；带失败原因） | 同 7 |
| 8 | `finalize-assess-phase-a.md` | Phase A 收尾评估 `buildAssessPrompt` | `microflow/src/finalize-manager.ts` | Step 执行后收尾 Phase A（**只 ask 判定**，v6 结构；真 fork/临时会话） | `parseAssessResult` → `{hasAsk, askQuestion}` |
| 9 | `finalize-phase-b.md` | Phase B 收尾 `buildPhaseBFinalizePrompt` | `microflow/src/finalize-manager.ts` | Phase B 真 fork 子代理收尾（透传变量 + 执行总结模板） | `parseFinalizeResult` → `{passThroughVars, compressedOutput}` |
| 10 | `finalize-phase-b-retry.md` | Phase B JSON 重试纠正 `buildFinalizeRetryHint` | `microflow/src/finalize-manager.ts` | Phase B 输出不可解析，同 fork 子代理 followup 重试（上限 3 次；带失败原因） | 同 9 |
| 11 | `finalize-gate-secondary.md` | secondary 门禁审查 `buildSecondaryGatePrompt` | `microflow/src/finalize-manager.ts` | Phase C secondary 门禁（`gates.secondary.enabled=true`，唯一门禁 AI 通道；v6 结构） | `parseSecondaryGate` → `{gateStatus: done|error, gateDetail}` |
| 11a | `finalize-gate-secondary-correction.md` | secondary 门禁解析失败纠正 `buildSecondaryGateCorrectionHint` | `microflow/src/finalize-manager.ts` | 门禁输出不可解析，同子代理 followup 重试（上限 2 次；带失败原因） | 同 11 |
| 12 | `finalize-step-context.md` | 收尾输入信息块 `buildStepContextBlock` | `microflow/src/finalize-manager.ts` | 被模板 8/9/11 共用（v6 `<ReferenceInfo>`；Phase B 仅降级注入） | —（子节） |
| 13 | `stage-branch-evaluate.md` | Stage 级批量路由判断 `buildStageBatchBranchPrompt` | `workflow/src/dag-navigator.ts:350` | Stage `branch.condition`（AI 条件**一次批量评估**，一次性会话 + StageContract 摘要必注入） | `extractShouldExecuteBatch` → `{"shouldExecute": ["branchId", ...]}` |
| 14 | `stage-contract-summary.md` | Stage 完成契约摘要 `summarizeStageContract` | `workflow/src/dag-navigator.ts:391` | 模板 13 的 context；shell 条件 stdin | —（子节） |

## 占位符约定

- 模板全文中的 `{{参数名}}` 表示运行时注入的占位符（参数表见各文件头部）。
- `（可选，条件满足时注入）` 标注的节并非每次出现。
- 透传变量 `{{${xxx}}}` 在构建前经 `replacePassThroughVars` 替换（含循环上下文变量）。
- 固定文案与源码逐字一致（含空行、缩进、`` ` `` 反引号、``` json 围栏）。
- **XML 标签命名（全目录规范，2026-08-25 定）**：统一**全驼峰（PascalCase）**，如 `<UserInstruction>` / `<ReferenceInfo>` / `<Reference>` / `<Params>` / `<Output>` / `<Artifacts>` / `<Artifact>`；属性名小驼峰（如 `title="..."`）。后续所有模板的 XML 标签一律遵循。

## 备注

- 宿主主代理（实例宿主会话）为纯 DSH 默认 preset，sandore 不注入任何角色提示词（`workflow-engine.ts:493`）。
- primary 门禁为纯代码产物校验（零 AI），无提示词。
- ask 提问走 DSH `ask_user_question` 工具（child-scope，见 `workflow/src/ask-tool.ts`），非提示词模板。
- 模板输出解析函数（`extract*`/`parse*`）均为纯代码，不在此目录。
