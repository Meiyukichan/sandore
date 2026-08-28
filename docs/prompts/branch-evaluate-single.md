# 逐条条件分支评估提示词（buildBranchPrompt）

> **⚠️ 遗留接口（2026-08-25 确认）**：生产路径全部走批量评估（`evaluateConditions` → `buildBatchBranchPrompt`，见 `branch-evaluate-batch.md`）——本模板（单条 `startAi`/`evaluate` 两阶段接口）**无生产调用点**，仅 spec 直接测试覆盖。保留文档供对照/未来复用；改动生产行为请以批量模板为准。
>
> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:152`（`buildBranchPrompt`）
> 场景：Step 级单分支条件判断（agent/prompt/skill/mcp 四类 AI 条件，`startAi`/`evaluate` 两阶段接口）；判断走 fork 当前 step 会话 + 全量历史注入（fork 失败降级一次性临时会话）。
> 输出：`extractShouldExecute` 两层解析 → `{"shouldExecute": bool}`；解析失败触发重试或按 false 处理。
> 注意：与批量模板（branch-evaluate-batch.md）字段互不复用；循环跳出走专用 shouldBreak 模板（loop-break.md）。
> **2026-08-25：本文件头部为修正版（对齐 step-execute.md v6 结构骨架），下半部分为原版 v1（保留供对照）。**

## 修正版（2026-08-25 讨论定稿）

### 模板全文（修正版）

```text
当前 Step 已执行完成。请根据它的执行过程，判断下一步应路由到哪个分支。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次分支判断要达成的**唯一验收目标**。
- `## 候选分支` —— 需要判断的分支列表。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
{{taskText}}

## 候选分支
（无显式分支，请依据任务判断返回 shouldExecute）
- {{label1}}
- {{label2}}

## 返回格式
请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否执行当前候选分支。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断分支并返回结果
```

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 条件 `condition.value.promptText`（`BranchEvalOptions`） | 分支判断任务（原样注入；`${xxx}` 透传变量已替换） |
| `{{label}}` | `branch.label ?? branch.next` | 每个候选分支展示名；分支列表为空时注入 `（无显式分支，请依据任务判断返回 shouldExecute）` |

### 设计要点（修正版）

- **结构骨架对齐 step-execute v6**：头部「先明确以下三点」+ 分节；删除固定角色声明（「你是严谨准确的DAG分支评估Agent」）。
- **执行机制（时序约束开场）**：判断发生在 **Step 执行完成之后**（Phase D 路由）——主路径经 `forkStepSubagent` 从 step 子代理完整事件（live → persistence 回退）截闭合 turn 作 seed，`agents.create` 重建宿主主代理子代理，`followup` 驱动一轮；**判断者继承当前 step 的完整执行历史**（seed 重建），故开场表述为「当前 Step 已执行完成，请根据它的执行过程判断下一步路由」。降级（配置缺省/事件源缺失/无闭合 turn/创建抛错）走 `llm.stream` 临时会话（单条提示词、不传历史）。
- **三点 = 你的任务 / 候选分支 / 返回格式**（无用户指令/任务规则/参考信息——判断的「任务」是条件配置，执行上下文在 fork 会话里）。
- **红线规则暂保留**（讨论点）：判断子代理带完整工具，只读约束（禁止编辑文件）防误操作；「禁止过度思考」是效率引导——与 step-execute 的「框架不做行为要求」原则的边界待讨论（fork 子代理 vs 主执行子代理的差异）。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 角色声明 | 「你是严谨准确的DAG分支评估Agent」 | 删除（不注入角色） |
| 2 | 头部 | 角色声明直接开场 | 行动引导「先明确以下三点」+ 职责列表 |
| 3 | 分节 | 你的任务 / 候选分支 / 返回格式 / 红线 | 同左（仅头部变化 + 无上下文节） |
| 4 | 红线 | 两条 | 暂保留（讨论中） |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:152`（`buildBranchPrompt`）
> 场景：Step 级单分支条件判断（agent/prompt/skill/mcp 四类 AI 条件，`startAi`/`evaluate` 两阶段接口）；判断走 fork 当前 step 会话 + 全量历史注入（fork 失败降级一次性临时会话）。
> 输出：`extractShouldExecute` 两层解析 → `{"shouldExecute": bool}`；解析失败触发重试或按 false 处理。
> 注意：与批量模板（branch-evaluate-batch.md）字段互不复用；循环跳出走专用 shouldBreak 模板（loop-break.md）。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 条件 `condition.value.promptText`（`BranchEvalOptions`） | 分支判断任务（原样注入；`${xxx}` 透传变量已替换） |
| `{{label}}` | `branch.label ?? branch.next` | 每个候选分支展示名；分支列表为空时注入 `（无显式分支，请依据任务判断返回 shouldExecute）` |

## 模板全文

```text
你是严谨准确的DAG分支评估Agent，你的任务是根据分支条件与上下文，判断本次执行应路由到哪个分支。

## 你的任务
{{taskText}}

## 候选分支
（无显式分支，请依据任务判断返回 shouldExecute）
- {{label1}}
- {{label2}}

## 返回格式
请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否执行当前候选分支。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断分支并返回结果
```

## 拼接顺序（源码逐元素）

1. `BRANCH_PROMPT_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 候选分支`：无分支 → 占位提示行；有分支 → 每分支 `- {{label ?? next}}`
4. 空行 → `## 返回格式` → shouldExecute JSON 要求行
5. 空行 → `## 红线规则` → `BRANCH_RED_LINES` 两条
