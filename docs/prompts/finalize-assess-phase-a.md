# Phase A 收尾评估提示词（buildAssessPrompt）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts`（`buildAssessPrompt`）
> 场景：Step 执行后收尾 Phase A——**ask 判定**（判断 Step 输出本身是否是在向用户提问）；评估者继承 step 完整执行历史（真 fork 子代理，`forkStepSubagent` 从事件重建；fork 失败降级临时会话）。
> 输出：`parseAssessResult` 解析 → `{"hasAsk": bool, "askQuestion": {"questions": [...]}}`；Phase A 只消费 `hasAsk`/`askQuestion`，透传变量提取与输出压缩是 Phase B 的职责。
> 说明：`askQuestion` 的 questions 数组每项必须有稳定 id 与具体 question（红线）；`hasAsk=true` 但无载荷为假 ask，回落 completed。
> **2026-08-26：本文件头部为语义收紧版（判断对象唯一 = 输出本身是否在提问，参考信息只注入 Output），下半部分为 2026-08-25 修正版与 v1（保留供对照）。**

## 收紧版（2026-08-26 定稿）

### 背景（为什么收紧）

真实案例：Step 输出为「已读取 counts.json 的内容：{...}」（正常结果），Phase A 却误判 `hasAsk=true` 并编造无关问题「请问您希望开发的图书管理页面包含哪些核心功能？……」。根因：旧任务节「判断是否需要向用户提问确认后继续」语义模糊 + 参考信息注入 Input（用户指令/上下文）——模型从**上下文需求**（要继续开发需澄清功能范围）推断提问，而非看**输出本身**是否在提问。收紧：判断对象唯一 = 输出文本本身；参考信息只注入 Output。

### 模板全文（收紧版）

```text
当前 Step 已执行完成。请判断当前 Step 的输出是否是在向用户提问。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次 ask 判断要达成的**唯一目标**。
- `## 参考信息` —— 当前 Step 的执行输出（Output），按需查阅。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
根据 `## 参考信息` 中当前 Step 的输出，判断它**本身**是否就是在向用户提问（询问用户、等待用户回答后继续）。
- hasAsk: true —— 输出本身就是一句提问（如「请问您的具体需求是什么？」）；
- hasAsk: false —— 输出是正常结果（完成报告、数据、文件路径等）。
**唯一判断依据是输出文本本身是否就是一句提问**；不得根据任务是否完成、是否走偏或任何上下文需要推断是否需要提问。
若 hasAsk: true，askQuestion 的 question 应**提取自输出中的问题**（取原文或简洁概括），不得编造与输出无关的问题。

## 参考信息
<ReferenceInfo>
  <Reference title="当前 Step 的执行输出">
    <Output>
      {{output}}
    </Output>
  </Reference>
</ReferenceInfo>

## 返回格式
请将结果以 ```json 代码围栏包裹输出，围栏内只放 JSON，不要包含任何其他文字或解释。
示例（输出是正常结果，不是提问）：
```json
{"hasAsk": false, "askQuestion": {"questions": []}}
```
示例（输出本身就是提问）：
```json
{"hasAsk": true, "askQuestion": {"questions": [{"id": "550e8400-e29b-41d4-a716-446655440000", "question": "请问您的具体需求是什么？"}]}}
```

## 红线规则
- 仅当输出本身是提问时 hasAsk: true；不得根据任务是否完成或上下文需要推断提问
- askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question
```

### 占位符参数（收紧版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{output}}` | `FinalizeStepContext.output` | 当前 Step 的执行输出（**唯一判断依据**；v6 `<ReferenceInfo>` 块，escapeXml 转义；空输出注入 `(无输出)`） |

### 设计要点（收紧版）

- **判断对象唯一 = 输出本身（2026-08-26）**：任务节从「判断是否需要向用户提问确认后继续」改为「判断输出本身是否就是在向用户提问」——**不是**判断任务是否完成/走偏，也**不**从上下文推断；hasAsk=true 仅当输出文本本身就是一句等待用户回答的提问。
- **askQuestion 提取而非生成**：question 提取自输出中的问题原文/概括，禁止编造与输出无关的问题（旧版「生成 askQuestion 载荷」导致模型凭空编问句）。
- **参考信息只注入 Output（2026-08-26）**：不注入 Input/Artifacts——输入/上下文（用户指令、用户原始需求、前置输出）会带偏判断（误判案例的根因之一）。与 2026-08-25 版差异见下表。
- **职责精简（2026-08-25 延续）**：Phase A 只做 ask 判断——透传变量提取与输出压缩是 Phase B 职责（Phase B 注释明确「不复用 Phase A 结果」）。
- **结构骨架对齐 v6**：时序开场 + 头部三点 + 分节；删除固定角色声明。
- **红线两条**：判断边界（仅输出本身是提问）+ askQuestion 稳定性（客观格式约束）。

### 与 2026-08-25 修正版差异摘要

| # | 项 | 2026-08-25 修正版 | 2026-08-26 收紧版 |
|---|-----|-----|--------|
| 1 | 任务节 | 「判断是否需要向用户提问确认后继续」 | 「判断输出**本身**是否就是在向用户提问」+ 明确排除按任务完成度/上下文推断 |
| 2 | askQuestion | 「生成 askQuestion 载荷」 | 「**提取自输出中的问题**，不得编造」 |
| 3 | 参考信息 | `<Input>` + `<Output>` + `<Artifacts>` | **只 `<Output>`**（Input/Artifacts 不注入） |
| 4 | 红线 | 一条（askQuestion 稳定性） | 两条（+ 仅输出本身是提问才 hasAsk:true） |
| 5 | 示例 | question: `"..."` | question: `"请问您的具体需求是什么？"`（贴近输出原文形态） |

---

## 修正版（2026-08-25 讨论定稿，保留供对照）

### 模板全文（修正版）

```text
当前 Step 已执行完成。请判断是否需要向用户提问。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次 ask 判断要达成的**唯一目标**。
- `## 参考信息` —— 当前 Step 的执行输入与输出，按需查阅。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
根据 `## 参考信息` 中当前 Step 的执行输出，判断是否需要向用户提问确认后继续（hasAsk: true = 需要提问；false = 不需要，直接进入后续收尾）。
若需要提问（hasAsk: true），生成 askQuestion 载荷：questions 数组每项必须有稳定的 id 和具体的 question。

## 参考信息
<ReferenceInfo>
  <Reference title="当前 Step 的输入和输出">
    <Input>
      {{input}}
    </Input>
    <Output>
      {{output}}
    </Output>
    <Artifacts>
      <Artifact>{{file1}}</Artifact>
      <Artifact>{{file2}}</Artifact>
    </Artifacts>
  </Reference>
</ReferenceInfo>

## 返回格式
请将结果以 ```json 代码围栏包裹输出，围栏内只放 JSON，不要包含任何其他文字或解释。
示例（不需要提问）：
```json
{"hasAsk": false, "askQuestion": {"questions": []}}
```
示例（需要提问）：
```json
{"hasAsk": true, "askQuestion": {"questions": [{"id": "550e8400-e29b-41d4-a716-446655440000", "question": "..."}]}}
```

## 红线规则
- askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question
```

（注：v1 的「禁止编辑、创建或删除任何文件」「禁止过度探索」两条红线已删除——Phase A 为 `llm.stream` 临时会话（无工具），两条为空话；仅保留客观格式约束。Phase B 为 fork 子代理（有工具），其 `ASSESS_RED_LINES` 仍保留前两条。）

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{input}}` / `{{output}}` | `FinalizeStepContext` | 当前 Step 的执行输入/输出（v6 `<ReferenceInfo>` 块，见 `finalize-step-context.md`；内容转义） |
| `{{file}}` | `FinalizeStepContext.artifacts` | 当前 Step 产物文件（每个 `<Artifact>{{file}}</Artifact>` 一行） |

### 设计要点（修正版）

- **职责精简（2026-08-25）**：Phase A **只做 ask 判断**——原模板要求的透传变量提取与输出压缩已被删除：消费端验证两者无落点（透传变量写回仅在 Phase B `commitFinalize('finalizing')`；previousOutputs 用 Phase B 的 compressedOutput；Phase B 注释明确「不复用 Phase A 结果」）——模型白白多花 token 的全被 Phase B 重做覆盖。
- **结构骨架对齐 v6**：时序开场（当前 Step 已执行完成）+ 头部三点 + 分节；删除固定角色声明（「你是严谨准确的Step执行后处理Agent」）。
- **三点 = 你的任务 / 输入信息 / 返回格式**（无用户指令——收尾任务为框架任务；无透传变量节——该节随提取任务一并移除）。
- **执行机制**：评估者继承 step 完整执行历史（真 fork：`forkStepSubagent` seed 重建 + followup 驱动；fork 失败降级临时会话仅凭 `<StepContext>` 输入）——ask 判定基于真实 I/O。
- **红线精简**：「禁止编辑文件/禁止过度探索」删除（`llm.stream` 临时会话无工具，空话）；仅保留「askQuestion 稳定性」（客观格式约束，与任务节同义但作为红线强调）。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 职责 | hasAsk + 透传变量提取 + 输出压缩（合并 JSON） | **只做 ask 判断**（hasAsk/askQuestion） |
| 2 | 角色声明 | 「你是严谨准确的Step执行后处理Agent」 | 删除（不注入角色） |
| 3 | 头部 | 角色声明直接开场 | 时序开场 + 行动引导 + 三点职责列表 |
| 4 | 分节 | 任务 / 透传变量 / 返回格式（JSON）/ 红线 | 任务 / 输入信息（StepContext）/ 返回格式 / 红线（透传变量节删除） |
| 5 | 返回格式 | 合并 JSON（含 passThroughVars/compressedOutput） | `{"hasAsk": false, "askQuestion": {"questions": []}}` |
| 6 | 输入信息 | `<stepContext>`（小写根标签 + `<input>`/`<output>`/`<artifacts>`） | v6 `<ReferenceInfo>`（`<Reference title>` + `<Input>`/`<Output>`/`<Artifacts>`/`<Artifact>` 全驼峰 + 转义） |
| 7 | 红线 | 三条（禁止编辑文件/禁止过度探索/askQuestion 稳定性） | 一条（askQuestion 稳定性；前两条为临时会话空话已删） |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts:376`（`buildAssessPrompt`）
> 场景：Step 执行后收尾 Phase A——ask 判定（是否需向用户提问）+ 透传变量提取 + 输出压缩，一个 LLM 调用返回合并 JSON；**临时会话**（`llm.stream` 直调、不 fork、不带 sessionId）。
> 输出：`parseAssessResult` 三级解析 → `{"hasAsk": bool, "passThroughVars": {...}, "askQuestion": {"questions": [...]}, "compressedOutput": "..."}`；Phase A 只消费 `hasAsk`/`askQuestion`，透传变量在 Phase B 写回。
> 说明：`askQuestion` 的 questions 数组每项必须有稳定 id 与具体 question（红线）；`hasAsk=true` 但无载荷为假 ask，回落 completed。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{stepContext}}` | `buildStepContextBlock`（见 `finalize-step-context.md`） | `<stepContext>` XML 块（input/output/artifacts） |
| `{{name}}` / `{{description}}` | `passThroughVars`（Step 定义） | 每个透传变量 `- {{name}}: {{description}}` 一行；无变量时注入 `（无透传变量，passThroughVars 返回空对象）` |

## 模板全文

```text
你是严谨准确的Step执行后处理Agent，在当前Step的会话分支中进行收尾评估。

{{stepContext}}

## 你的任务
1. 判断是否需要向用户提问确认后继续（hasAsk: true = 需要提问；false = 不需要，直接进入后续收尾）
2. 提取透传变量值：对每个列出的透传变量，从 <output> 中提取其值并写入 passThroughVars；若变量值就是 <output> 的完整文本，直接使用它。
3. 输出压缩：把 <output> 完整总结写入 compressedOutput，按以下结构组织：
   - 【任务要求】：本次 step 要求完成什么
   - 【执行过程】：实际做了什么（关键步骤、调用的工具/文件、产生的中间结果）
   - 【最终成果】：完整的最终产出总结（包含所有关键信息，不得比原始 <output> 更简短）
   注意：compressedOutput 是后续 step 的唯一上下文来源，必须完整保留关键信息，禁止过度压缩。

## 透传变量
（无透传变量，passThroughVars 返回空对象）
- {{name1}}: {{description1}}
- {{name2}}: {{description2}}

## 返回格式（JSON）
请将结果以 ```json 代码围栏包裹输出，围栏内只放 JSON，不要包含任何其他文字或解释。
示例：
```json
{"hasAsk": false, "passThroughVars": {}, "askQuestion": {"questions": []}, "compressedOutput": "..."}
```

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度探索
- askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question
```

## 拼接顺序（源码逐元素）

1. `ASSESS_PROMPT_HEADER`（上文首行）
2. 空行 → `{{stepContext}}` → 空行
3. `## 你的任务` → 三行任务（hasAsk / 透传变量提取 / 输出压缩三子项）
4. 空行 → `## 透传变量`：无变量 → 占位行；有 → 每变量 `- {{name}}: {{description}}`
5. 空行 → `## 返回格式（JSON）` → 围栏要求 → `示例：` → ``` json 围栏示例
6. 空行 → `## 红线规则` → `ASSESS_RED_LINES` 三条
