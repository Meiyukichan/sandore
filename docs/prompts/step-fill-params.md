# 参数模板填充提示词（buildFillParamsPrompt）

> 源码：`packages/sandore/microflow/src/step-runner.ts:279`（`buildFillParamsPrompt`）
> 场景：agent 定义含 `agentParamsTemplate` 时，先经 **fillParams 可续接子代理**（v6 改造：与 step-execute 同机制——`startContinuable` + DSH preset + 工具 + settle 收集输出，不再 llm.stream 临时会话）按模板填充参数，结果作为 `{{paramsText}}` 注入主执行提示词的 `<Params>` 子标签。
> 输出：填充后的模板文本（`{{paramsText}}`）；子代理失败/无输出时回退模板原文。
> **2026-08-25：本文件头部为修正版（对齐 step-execute.md v6 结构骨架 + fillParams 子代理化），下半部分为原版 v1（保留供对照）。**

## 修正版（2026-08-25 讨论定稿）

### 模板全文（修正版）

```text
你正在进行工作流中的一个 Step 执行前的参数填充任务。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次要完成的填充任务，是**唯一目标**。
- `## 参数模板` —— 需要按格式填充的模板。
- `## 参考信息` —— 填充依据（用户原始需求与前置 Step 输出），按需查阅。

## 你的任务
根据 `## 参数模板` 的格式，结合 `## 参考信息` 中的信息完成填充，
将模板内容按模板格式填充后返回。

## 参数模板
{{template}}

## 参考信息
<ReferenceInfo>
  <Reference title="用户原始需求（整个工作流的整体目标）">
    {{originalInput}}
  </Reference>

  （可选）<Reference title="前置Step: {{name}} (id: {{id}}) 的输出和产物">
    <Output>
      {{returnPrompt}}
    </Output>
    <Artifacts>
      <Artifact>{{file1}}</Artifact>
      <Artifact>{{file2}}</Artifact>
    </Artifacts>
  </Reference>
</ReferenceInfo>

## 输出要求
仅返回填充后的模板内容，不要包含任何解释、``` 围栏、标题或额外文字。
```

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{template}}` | agent 定义 `agentParamsTemplate` | 待填充的参数模板（含 `${xxx}` 占位符） |
| `{{originalInput}}` | 引擎 `request.originalInput` | 用户原始需求（整个工作流的整体目标） |
| `{{name}}` / `{{id}}` / `{{returnPrompt}}` / `{{file}}` | `renderPreviousOutputs`（见 `step-previous-outputs.md`） | （可选）按 `step.inputFrom` 过滤后的前置 Step 输出和产物（同 step-execute） |

### 设计要点（修正版）

- **结构骨架对齐 step-execute v6**：头部「先明确以下三点」+ 分节 + `<ReferenceInfo>` XML 参考信息。
- **`## 你的任务` 是框架任务**（非用户指令）：fillParams 无 `taskText`/`resolvedRules`——头部三点为「你的任务 / 参数模板 / 参考信息」。
- **`## 输出要求`**：子代理虽带 DSH preset，仍须明确「仅返回填充后的模板内容」——避免废话/围栏污染主执行提示词的 `<Params>` 块。
- **红线规则已移除**：fillParams 子代理与 step-execute 同机制（preset 行为引导兜底），遵循「框架不做行为要求」原则（v1 三条红线不再保留）。
- **执行机制（v6 改造）**：`fillParams` 经 `startContinuable` 跑可续接子代理（parent=宿主主代理、模型路由经 agentOptions），settle completed 取输出；error/aborted/无输出/启动抛错 → 回退模板原文（不失败）。
- 前置块与 step-execute 共用 `renderPreviousOutputs`（XML Reference 形态），并按 `step.inputFrom` 过滤。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 结构 | 直接 `## 输入信息` 开始 | 头部三点声明 + 分节（任务/模板/参考信息） |
| 2 | 参考信息 | `### 用户原始需求` MD 标题 + 前置块混排 | `<ReferenceInfo>` 纯 XML（与 step-execute 一致） |
| 3 | 输出要求 | 无 | `## 输出要求`（仅返回填充内容） |
| 4 | 红线 | 三条（禁止编辑文件/禁止过度探索/不要过度思考） | 移除（临时会话无工具，空话） |
| 5 | 前置块 | v1 MD 形态 | v6 XML Reference 形态 + inputFrom 过滤 |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/step-runner.ts:279`（`buildFillParamsPrompt`）
> 场景：agent 定义含 `agentParamsTemplate` 时，先经 fillParams 临时会话（`llm.stream` 直调）按模板填充参数，结果作为「### 当前Step参数」注入主执行提示词。
> 输出：填充后的模板文本（`{{paramsText}}`）。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{originalInput}}` | 引擎 `request.originalInput` | 用户原始需求 |
| `{{前置Steps输出与产物}}` | `renderPreviousOutputs`（见 `step-previous-outputs.md`） | （可选）有前置输出时注入 |
| `{{template}}` | agent 定义 `agentParamsTemplate` | 待填充的参数模板（含 `${xxx}` 占位符） |

## 模板全文

```text
## 输入信息
### 用户原始需求
{{originalInput}}

（可选，有前置输出时注入，见 step-previous-outputs.md：）
{{前置Steps输出与产物}}

## 参数模板
{{template}}

## 你的任务
你的唯一任务是根据这个参数模板，然后根据（## 输入信息）中的信息，
或者你可以进行一定程度的探索后，将参数模板的内容按照模板格式填充后返回这个结果！

## 红线规则
- 禁止编辑或者创建或者删除任何文件
- 禁止过度探索，你的任务是根据已有信息，做足够探索后尽快返回这个参数模板结果
- 不要过度思考，你的职责不是设计或者开发
```

## 拼接顺序（源码逐元素）

1. `## 输入信息` → `### 用户原始需求` → `{{originalInput}}`
2. （可选）`renderPreviousOutputs` 输出
3. 空行 → `## 参数模板` → `{{template}}` → 空行
4. `## 你的任务` → `FILL_PARAMS_TASK`（上文任务指令）→ 空行
5. `## 红线规则` → `FILL_PARAMS_RED_LINES` 三条
