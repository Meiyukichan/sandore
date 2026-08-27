# Step 主执行提示词（buildPromptText）

> 源码：`packages/sandore/microflow/src/step-runner.ts:244`（`buildPromptText`）
> 场景：prompt / agent / skill / mcp 四路 Step 统一走可续接子代理执行，共用本模板。
> 输出：自由文本（子代理最终输出，经 settle 采集）。
> 说明：子代理提问走 child-scope `ask_user_question` 工具，模板不再注入提问引导节。
> **2026-08-25：本文件头部为修正版（v6 讨论定稿），下半部分为原版 v1（保留供对照）。**

## 修正版 v6（2026-08-25 讨论定稿）

### 设计决策（要点）

1. **删除固定角色声明**：不再注入「你是严谨准确的Step执行Agent」——身份由用户 promptText 决定，避免与用户任务文本中的身份指令冲突。
2. **头部 = 行动引导 + 职责列表**：以「必须先明确以下三点，再开始执行」开场（行动导向：先理解后执行）；三节按职责区分（唯一验收目标 / 约束 / 上下文），无序列表呈现（无优先级暗示）——不注入角色声明，不使用「按优先级排列」叙事，不加行为默认项（如实说明/禁止编造为模型默认行为，不显式声明）。
3. **用户指令 XML 隔离（防注入）**：`## 用户指令` + `<UserInstruction>` 包裹任务文本并统一转义——用户文本中的 `##` 标题、`<`/`>` 等不再混入框架节。
4. **参考信息纯 XML 化**：`<ReferenceInfo>` root + `<Reference title="...">` 平铺自描述块；移除动态标签 `<{{stepId}}>`（XML 永远合法）。XML 标签统一全驼峰命名（`UserInstruction` / `ReferenceInfo` / `Reference` / `Params` / `Output` / `Artifacts` / `Artifact`）。
5. **主执行不规定输出格式**：子代理最终回复为自由输出——结构化压缩是收尾 Phase A/B 的职责（`compressedOutput` 结构见 `finalize-assess-phase-a.md` / `finalize-phase-b.md`），主执行模板不设 `## 输出要求` 节，避免职责重复。
6. **框架不做行为要求（设计原则）**：sandore 注入内容只负责三件事——组织（XML/MD 分区）、来源区分（用户 vs 框架）、防注入（转义）；不夹带任何框架行为要求（不施压「必须完成/尽力完成」、不设行为红线「禁止编造」、不规定输出格式）。模型行为引导完全由用户指令与 DSH preset 系统提示词承担。
7. **正文节序与头部列表一致**：`## 用户指令` → `## 任务规则` → `## 参考信息`（目标 → 约束 → 上下文），头部三点顺序与正文节序严格对应。

### 模板全文（修正版）

```text
你正在执行工作流中的一个 Step。必须先明确以下三点，再开始执行：
- `## 用户指令` —— 用户提供的当前任务指令，是本次 Step 要达成的**唯一验收目标**。
- `## 任务规则` —— 用户配置的约束，执行时**不得违反**。
- `## 参考信息` —— 执行上下文，按需查阅。

## 用户指令
<UserInstruction>
{{taskText}}
</UserInstruction>

（可选）## 任务规则
- **{{key}}**: {{content}}

## 参考信息
<ReferenceInfo>
  <Reference title="你正在执行的Step: {{name}} (id: {{id}})">
    （可选）<Params>
      {{paramsText}}
    </Params>
  </Reference>

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
```

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 用户 Step 指令文本（经 `buildTaskText`） | 注入 `<UserInstruction>`；prompt 类型原样，agent/skill/mcp 名称命中定义数组时加前缀「使用 Agent：/使用 skill：/使用 MCP：」（**前缀保留**——防止纯名称输入的歧义，见「已定决策」） |
| `{{id}}` / `{{name}}` | 执行段 `executed.id` / `step.name` | **当前 Step** 的 id / name——`{{id}}` 为**执行段唯一 id**（executed.id，纯 UUID，区别于定义 stepId）；`{{name}}` 为 `step.name`（缺省回退 `step.id` 定义 id）；title 形态 `你正在执行的Step: {{name}} (id: {{id}})`，展示于 `<ReferenceInfo>` 首个块 |
| `{{originalInput}}` | 引擎 `request.originalInput` | 用户原始需求（整个工作流的整体目标；本 Step 的验收目标见 `## 用户指令`） |
| `{{paramsText}}` | agentParamsTemplate 填充结果 | （可选）仅 agent 定义含 `agentParamsTemplate` 时注入；置于「你正在执行的Step」块内 `<Params>` 子标签，无则块为空 |
| `{{name}}` / `{{id}}` | `PreviousStepOutput` | **前置 Step** 的 name / id（展示于前置块 title `前置Step: {{name}} (id: {{id}}) 的输出和产物`，与当前 Step 块命名一致） |
| `{{returnPrompt}}` | `PreviousStepOutput.returnPrompt` | 前置 Step 输出摘要 |
| `{{file}}` | `PreviousStepOutput.files` | 前置 Step 产物文件路径 |
| `{{key}}` / `{{content}}` | `resolvedRules` | （可选）任务规则键值对 |

### 渲染规则（修正版）

1. **统一 XML 转义**：所有进入 XML 标签的内容（`<UserInstruction>` / `<Reference>` / `<Output>` / `<Artifact>` 内文本）先转义 `&` → `&amp;`（必须最先）、`<` → `&lt;`、`>` → `&gt;`；Markdown 节（`## 任务规则` 键值）不转义。
2. **强调规则**：Markdown 区域的关键性质词加粗（`**唯一验收目标**`、`**不得违反**`），节名引用用反引号（`` `## 用户指令` ``）；**XML 属性（title）与 XML 内容内不加 Markdown**——属性值中的 `**`/反引号会被模型当字面文本。引导语（如「必须先明确以下三点」）与中性说明（如「按需查阅」）不加粗。
3. **可选节按条件注入**：`<Params>` 子标签（paramsText 存在时）、前置 `Reference` 块（每个前置输出一块）、`## 任务规则`（resolvedRules 非空时）。
4. 无前置输出时 `<ReferenceInfo>` 内为「你正在执行的Step」+「用户原始需求」两块。
5. **正文节序**：`## 用户指令` →（可选）`## 任务规则` → `## 参考信息`，与头部列表顺序一致。

### 与 v1 差异摘要

| # | 项 | v1（现状） | v6（修正版） |
|---|-----|-----------|-------------|
| 1 | 角色声明 | 头部固定「你是严谨准确的Step执行Agent」 | 删除（身份交给用户） |
| 2 | 头部 | 引用错误节名「## 前置Steps输出」+ 固定角色声明 | 职责分类列表（唯一验收目标/约束/上下文）+ 行动引导 |
| 3 | 任务节 | `## 你的任务` 裸放用户文本 | `## 用户指令` + `<UserInstruction>` XML 隔离 + 转义 |
| 4 | 参考信息 | MD 标题混动态 XML 标签（`<{{stepId}}>`） | `<ReferenceInfo>` root + `<Reference title>` 平铺块；动态标签移除 |
| 5 | 输出格式 | 无 | 维持无（输出压缩为收尾 Phase A/B 职责，主执行保持自由输出） |
| 6 | 转义 | 无 | 全部 XML 内容统一转义 |
| 7 | 节序 | 任务规则在参考信息之后 | 用户指令 → 任务规则 → 参考信息（与头部三点顺序一致） |
| 8 | 标签命名 | 小写/动态混合 | 全驼峰统一 |

### 已定决策（2026-08-25）

- **「使用 Agent：/使用 skill：/使用 MCP：」前缀：保留**。用户仅输入一个 agent/skill/mcp 名称时（如「code-reviewer」），前缀告知模型「这是一个 agent 引用」——消歧价值大于「任务文本原样」。
- **`<UserInstruction>` 标签名：保留**（与 `## 用户指令` 节名一一对应，模型语义最稳）。

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/step-runner.ts:244`（`buildPromptText`）
> 场景：prompt / agent / skill / mcp 四路 Step 统一走可续接子代理执行，共用本模板。
> 输出：自由文本（子代理最终输出，经 settle 采集）。
> 说明：子代理提问走 child-scope `ask_user_question` 工具，模板不再注入提问引导节。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | `buildTaskText`（step-runner.ts:211） | Step 的 `command.value.promptText`（先经 `replacePassThroughVars` 替换 `${xxx}`）；agent 类型加前缀 `使用 Agent：`、skill 加 `使用 skill：`、mcp 加 `使用 MCP：`（名称命中定义数组时），prompt 类型原样 |
| `{{originalInput}}` | 引擎 `request.originalInput` | 用户原始需求（实例启动输入） |
| `{{paramsText}}` | agentParamsTemplate 填充结果（`fillParams` 临时会话输出） | （可选）仅 agent 定义含 `agentParamsTemplate` 时注入 `### 当前Step参数` 节 |
| `{{前置Steps输出与产物}}` | `renderPreviousOutputs`（见 `step-previous-outputs.md`） | （可选）有前置输出时注入 |
| `{{任务规则}}` | `resolvedRules`（3 级合并 step ∪ stage → workflow.rules） | （可选）非空时注入 `## 任务规则` 节 |

## 模板全文

```text
你是严谨准确的Step执行Agent，你的任务是参考`## 参考信息`和`## 前置Steps输出`中的信息，
准确完成`## 你的任务`中的要求。

## 你的任务
{{taskText}}

## 参考信息
### 用户原始需求
{{originalInput}}

（可选，agent 定义含 agentParamsTemplate 时注入：）
### 当前Step参数
{{paramsText}}

（可选，有前置输出时注入，见 step-previous-outputs.md：）
{{前置Steps输出与产物}}

（可选，resolvedRules 非空时注入：）
## 任务规则
- **{{规则键1}}**: {{规则内容1}}
- **{{规则键2}}**: {{规则内容2}}
```

## 拼接顺序（源码逐元素）

1. `PROMPT_MAIN_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 参考信息` → `### 用户原始需求` → `{{originalInput}}`
4. （可选）`### 当前Step参数` → `{{paramsText}}`
5. （可选）`renderPreviousOutputs`：空行 → `## 前置Steps输出与产物` → 每前置 `### 前置Step: {{name}} ({{id}})` → `<{{id}}>` → `  <output>`（内容每行 4 空格缩进）→ `  </output>` → `  <artifacts>` → `    - {{file}}` → `  </artifacts>` → `</{{id}}>`
6. （可选）`## 任务规则` → 每键 `- **{{key}}**: {{content}}`（置于前置输出之后，对齐基准）
