# Stage 级批量路由判断提示词（buildStageBatchBranchPrompt）

> 源码：`packages/sandore/workflow/src/dag-navigator.ts:350`（`buildStageBatchBranchPrompt`，private）
> 场景：Stage 级多条 AI 条件分支（agent/prompt/skill/mcp）**一次批量评估**（对齐 Step 级 branch-evaluate-batch）；`branchId` = 分支 `next`（唯一且与路由目标一致），`executeCondition` 取 condition 的 `promptText`。当前 Stage 完成后按定义序选下一 Stage：shell 条件本地逐条执行（`matchesExpectation(label)`，不经本模板）；AI 条件一次批量调用。
> 会话：**一次性会话**（`ctx.llm.stream`，不 fork——Stage 无单一 step 会话可 fork），StageContract 摘要**必注入**作 context（无 fork 历史，摘要是唯一判断依据）。provider/model 三层回退（首个 AI 分支条件定义 → 引擎配置 → ctx.llm 目录兜底）。
> 输出：`extractShouldExecuteBatch` 三层解析 → `{"shouldExecute": ["branchId1", "branchId2"]}`；解析失败/会话失败整批降级（空数组 → 条件不通过，走默认分支/数组顺序兜底）。
> **2026-08-26：本文件头部为批量版（v6，对齐 branch-evaluate-batch），下半部分为原单条版（2026-08-25 修正版，保留供对照）。**

## 批量版（2026-08-26 定稿）

### 模板全文（批量版）

```text
当前 Stage 已执行完成。请根据当前 Stage 的完成契约，判断下列分支中哪些满足其执行条件。必须先明确以下四点，再开始执行：
- `## 你的任务` —— 本次 Stage 路由判断要达成的**唯一目标**。
- `## 分支执行条件` —— 需要判断的分支及其执行条件。
- `## 参考信息` —— 当前 Stage 的完成契约，按需查阅。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
根据 `## 分支执行条件` 与 `## 参考信息` 中当前 Stage 的完成契约，判断哪些分支满足其执行条件。**唯一目标**：找出所有满足执行条件的分支，返回其 branchId 列表。

## 参考信息
<ReferenceInfo>
  <Reference title="当前 Stage 完成契约">
    {{contractSummary}}
  </Reference>
</ReferenceInfo>

## 分支执行条件
```json
[
    {
        "branchId": "{{branchId1}}",
        "executeCondition": "{{executeCondition1}}"
    },
    {
        "branchId": "{{branchId2}}",
        "executeCondition": "{{executeCondition2}}"
    }
]
```

## 返回格式
请仅返回 JSON，格式如下：
```json
{"shouldExecute": ["branchId1", "branchId2"]}
```

其中，`shouldExecute` 为满足其 `executeCondition` 条件的分支的 `branchId` 列表；没有任何分支满足时返回空数组 `[]`。
```

### 占位符参数（批量版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{branchId}}` | `branch.next` | 分支 id（与路由目标一致） |
| `{{executeCondition}}` | `condition.value.promptText` | 各分支 AI 条件命令的提示词文本 |
| `{{contractSummary}}` | `summarizeStageContract`（见 `stage-contract-summary.md`） | 当前 Stage 完成契约摘要（Stage 名/状态/产物/透传变量），**escapeXml 转义后**注入 `<ReferenceInfo>` |

### 设计要点（批量版）

- **结构骨架对齐 v6**：时序开场（当前 Stage 已执行完成）+ 头部四点职责列表 + 分节；删除固定角色声明（一次性会话无工具，同 Phase A 原则）。
- **批量评估一次调用**：所有 AI 条件分支一次 `llm.stream`（对齐 branch-evaluate-batch），返回满足条件的 branchId 数组；与逐条版差异见下表。定义序首个命中者胜出（默认分支按位置参与竞争），无命中按定义数组顺序兜底。
- **四点 = 你的任务 / 分支执行条件 / 参考信息 / 返回格式**：参考信息**必注入**（Stage 级无 fork——一次性会话无历史，StageContract 摘要是唯一判断依据，非降级才注入）。
- **无红线节**：一次性会话（`llm.stream`）无工具，「禁止编辑文件」等约束为空话（同 Phase A/阶段判断处理）。
- **executeCondition 透传**：不替换 `${xxx}` 透传变量（Stage 条件为静态配置文本；与 Step 级 executeCondition 的 replacePassThroughVars 替换不同——Stage 无 per-step 变量上下文）。

### 与单条版差异摘要

| # | 项 | 单条版（2026-08-25） | 批量版 |
|---|-----|-----|--------|
| 1 | 调用次数 | 每条 AI 条件分支一次 `llm.stream` | **一次调用**评估全部 AI 条件分支 |
| 2 | 返回格式 | `{"shouldExecute": true/false}` | `{"shouldExecute": ["branchId1", ...]}` |
| 3 | 任务节 | `{{taskText}}`（条件配置文本） | 固定文本 + **唯一目标**加粗 |
| 4 | 头部 | 三点（你的任务/参考信息/返回格式） | 四点（+ 分支执行条件） |
| 5 | 节顺序 | 你的任务 → 参考信息 → 返回格式 | 你的任务 → 参考信息 → 分支执行条件 → 返回格式 |
| 6 | 解析失败 | 按 false（条件不通过） | 整批空数组（全部条件不通过，走兜底） |

---

## 原单条版（2026-08-25 修正版，保留供对照）

> 源码：`packages/sandore/workflow/src/dag-navigator.ts`（`buildStageBranchPrompt`，private，**2026-08-26 批量改造时删除**）
> 场景：Stage 级 `branch.condition`（AI 条件：agent/prompt/skill/mcp）——当前 Stage 完成后逐条评估是否推进到目标 Stage；**一次性会话**（`ctx.llm.stream`，不 fork——Stage 无单一 step 会话可 fork），StageContract 摘要拼进提示词作 context。provider/model 三层回退（条件定义 → 引擎配置 → ctx.llm 目录兜底）。
> 输出：`extractShouldExecute` 解析 → `{"shouldExecute": bool}`；解析失败按 false（条件不通过走兜底）；shell 条件走 `matchesExpectation(label)` 不经过本模板。
> **2026-08-25：本文件头部为修正版（v6 结构），下半部分为原版 v1（保留供对照）。**

### 模板全文（单条修正版）

```text
当前 Stage 已执行完成。请判断是否应推进到目标 Stage。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次 Stage 路由判断要达成的**唯一目标**。
- `## 参考信息` —— 当前 Stage 的完成契约，按需查阅。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
{{taskText}}

## 参考信息
<ReferenceInfo>
  <Reference title="当前 Stage 完成契约">
    {{contractSummary}}
  </Reference>
</ReferenceInfo>

## 返回格式
请仅返回 JSON，格式如下：
```json
{"shouldExecute": true}
```
或
```json
{"shouldExecute": false}
```
其中，`shouldExecute` 表示是否应推进到该分支的目标 Stage。
```

### 占位符参数（单条修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 条件 `value.promptText` | Stage 分支判断任务（原样注入） |
| `{{contractSummary}}` | `summarizeStageContract`（见 `stage-contract-summary.md`） | 当前 Stage 完成契约摘要（Stage 名/状态/产物/透传变量） |

### 设计要点（单条修正版）

- **结构骨架对齐 v6**：时序开场（当前 Stage 已执行完成——判断发生在 Stage 完成后）+ 头部三点 + 分节；删除固定角色声明（「你是严谨准确的工作流 Stage 路由 Agent」）。
- **三点 = 你的任务 / 参考信息 / 返回格式**（无用户指令——路由判断任务为条件配置；参考信息 = Stage 完成契约摘要，**必注入**——一次性会话无 fork 历史，摘要是唯一判断依据）。
- **参考信息 v6 化**：StageContract 摘要文本包进 `<ReferenceInfo>`/`<Reference title="当前 Stage 完成契约">` 块（对齐全目录 PascalCase 规范）。
- **返回格式围栏两例**（对齐 loop-break 的 shouldBreak 形态）。
- **红线已删**：一次性会话（`llm.stream`）无工具——「禁止编辑文件」「禁止过度思考」为空话（同 Phase A 处理）。

### 与 v1 差异摘要

| # | 项 | v1 | 单条修正版 |
|---|-----|-----|--------|
| 1 | 角色声明 | 「你是严谨准确的工作流 Stage 路由 Agent」 | 删除（不注入角色） |
| 2 | 头部 | 角色声明直接开场 | 时序开场 + 行动引导 + 三点职责列表 |
| 3 | 分节 | 你的任务 / 当前 Stage 完成契约 / 返回格式 / 红线 | 你的任务 / 参考信息（v6 ReferenceInfo）/ 返回格式 |
| 4 | 返回格式 | 行内一行 | ```json 围栏两例 + 解释行 |
| 5 | 红线 | 两条 | 删除（一次性会话无工具，空话） |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/workflow/src/dag-navigator.ts:303`（`buildStageBranchPrompt`，private，**2026-08-26 批量改造时删除**）
> 场景：Stage 级 `branch.condition`（AI 条件：agent/prompt/skill/mcp）——当前 Stage 完成后评估是否推进到目标 Stage；**一次性会话**（`ctx.llm.stream`，不 fork——Stage 无单一 step 会话可 fork），StageContract 摘要拼进提示词作 context。provider/model 三层回退（条件定义 → 引擎配置 → ctx.llm 目录兜底）。
> 输出：`extractShouldExecute` 解析 → `{"shouldExecute": bool}`；shell 条件走 `matchesExpectation(label)` 不经过本模板。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 条件 `value.promptText` | Stage 分支判断任务（原样注入） |
| `{{contractSummary}}` | `summarizeStageContract`（见 `stage-contract-summary.md`） | 当前 Stage 完成契约摘要（Stage 名/状态/产物/透传变量） |

## 模板全文

```text
你是严谨准确的工作流 Stage 路由 Agent，你的任务是根据当前 Stage 的完成契约与分支条件，判断是否应推进到该分支的目标 Stage。

## 你的任务
{{taskText}}

## 当前 Stage 完成契约
{{contractSummary}}

## 返回格式
请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否应推进到该分支的目标 Stage。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断分支并返回结果
```

## 拼接顺序（源码逐元素）

1. `STAGE_BRANCH_PROMPT_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 当前 Stage 完成契约` → `{{contractSummary}}` → 空行
4. `## 返回格式` → shouldExecute JSON 要求行（「是否应推进到该分支的目标 Stage」措辞）
5. 空行 → `## 红线规则` → `STAGE_BRANCH_RED_LINES` 两条
