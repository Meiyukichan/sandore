# Phase B 收尾提示词（buildPhaseBFinalizePrompt）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts`（`buildPhaseBFinalizePrompt`）
> 场景：Phase B——真 fork 子代理（`forkStepSubagent` 从 step 子代理完整事件截闭合 turn 作 seed，`agents.create` 重建宿主主代理子代理）收尾：**透传变量提取 + 输出压缩**。供 `assessForked` / `degradeFinalize` 使用。
> 与 Phase A（finalize-assess-phase-a.md）分工：**不含 hasAsk 判断**——Phase A 已完成 ask 判定，Phase B 只做透传变量提取 + 输出压缩（Phase B 为权威——Phase A 结果不复用）。
> 输出：`parseFinalizeResult` → `{"passThroughVars": {...}, "compressedOutput": "..."}`；解析失败最多 3 次 followup 纠正（见 finalize-phase-b-retry.md）。
> **2026-08-25：本文件头部为修正版（v6 结构，对齐 Phase A），下半部分为原版 v1（保留供对照）。**

## 修正版（2026-08-25 讨论定稿）

### 模板全文（修正版，fork 版——无参考信息节）

```text
当前 Step 已执行完成。请完成本次收尾处理。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次收尾处理要达成的**唯一目标**。
- `## 透传变量` —— 需要提取的透传变量列表。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
1. 提取透传变量值：对每个列出的透传变量，根据当前 Step 的执行上下文（输出、工具调用与中间结果）提取其值并写入 passThroughVars。
2. 执行总结：按 `## 输出模板` 的 Markdown 模板，把当前 Step 执行输出完整总结写入 compressedOutput。

## 透传变量
（无透传变量，passThroughVars 返回空对象）
- {{name1}}: {{description1}}
- {{name2}}: {{description2}}

## 输出模板（compressedOutput 按此 Markdown 模板书写）
注意：compressedOutput 是后续 Step 的唯一上下文来源，必须完整保留关键信息，禁止过度压缩。
```md
# 任务要求
本次 Step 要达成的目标：原始指令的要点与验收标准。

# 执行过程
实际执行的关键步骤：调用的工具与操作的文件路径、读取与写入的内容、产生的中间结果、关键决策及其依据、遇到的异常与处理方式。

# 最终成果
本次 Step 的完整产出：生成/修改的文件与路径、核心数据与结论、验证方式与结果（包含所有关键信息，不得比原始输出更简短）。

# 未完成与遗留
未达成的部分、原因与已完成的进展、对后续 Step 的依赖与建议。
```
 
## 返回格式
请将结果以 ```json 代码围栏包裹输出，围栏内只放 JSON，不要包含任何其他文字或解释。
示例：
```json
{"passThroughVars": {}, "compressedOutput": "..."}
```

## 红线规则
- 禁止编辑、创建或删除任何文件
```

### 降级版（fork 不可用时注入参考信息）

fork 降级（`degradeFinalize`：配置缺省 / 事件源缺失 / 无闭合 turn / 创建抛错 → `llm.stream` 临时会话，无 fork 历史）时，提示词插入 `## 参考信息` 点与节（v6 `<ReferenceInfo>` 块，含当前 Step 输入/输出/产物），对齐 batch/loop-break 的降级处理：

```text
- `## 你的任务` —— 本次收尾处理要达成的**唯一目标**。
- `## 参考信息` —— 当前 Step 的执行输入与输出，按需查阅。
- `## 透传变量` —— 需要提取的透传变量列表。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
1. 提取透传变量值：对每个列出的透传变量，根据 `## 参考信息` 中的信息提取其值并写入 passThroughVars。
2. 执行总结：按 `## 输出模板` 的 Markdown 模板，把 <Output> 完整总结写入 compressedOutput。

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

## 透传变量
…
```

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{input}}` / `{{output}}` | `FinalizeStepContext` | 当前 Step 的执行输入/输出（**仅降级版**参考信息节；fork 版上下文在会话里不注入） |
| `{{file}}` | `FinalizeStepContext.artifacts` | 当前 Step 产物文件（仅降级版） |
| `{{name}}` / `{{description}}` | `passThroughVars`（Step 定义） | 每个透传变量 `- {{name}}: {{description}}` 一行；无变量时注入 `（无透传变量，passThroughVars 返回空对象）` |

### 设计要点（修正版）

- **结构骨架对齐 v6**：时序开场（当前 Step 已执行完成）+ 头部三点 + 分节；删除固定角色声明（「你是严谨准确的Step执行后处理Agent」）。
- **三点 = 你的任务 / 透传变量 / 返回格式**（无参考信息——**fork 成功时评估者继承 step 完整执行历史，上下文在会话里**，参考信息节仅降级注入，对齐 batch/loop-break 模式）。
- **执行机制**：真 fork 子代理（`forkStepSubagent` seed 重建 + followup 驱动）；fork 失败降级临时会话（`degradeFinalize`）——降级版注入 `<ReferenceInfo>` 参考信息节（弥补无历史）。
- **红线保留一条**：Phase B 为 **fork 子代理（有工具）**——「禁止编辑、创建或删除任何文件」有实际意义（只读安全约束，防收尾评估误改文件）；「禁止过度探索」已删（主观性引导，不可客观验证）；v1 第三条「askQuestion 稳定性」已删（Phase B 输出无 askQuestion，不适配）。
- 透传变量提取/输出压缩为 Phase B 唯一职责（Phase A 已精简只 ask）。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 角色声明 | 「你是严谨准确的Step执行后处理Agent」 | 删除（不注入角色） |
| 2 | 头部 | 角色声明直接开场 | 时序开场 + 行动引导 + 三点职责列表 |
| 3 | 分节 | 任务 / 透传变量 / 返回格式（JSON）/ 红线 | 任务 / 透传变量 / 返回格式 / 红线（参考信息仅降级注入） |
| 4 | 输入信息 | `<stepContext>` 恒注入 | fork 版不注入；降级版注入 v6 `<ReferenceInfo>` |
| 5 | 红线 | 三条（含 askQuestion 稳定性） | 一条（禁止编辑、创建或删除任何文件；「禁止过度探索」主观性已删、askQuestion 稳定性不适配已删） |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts:417`（`buildPhaseBFinalizePrompt`）
> 场景：Phase B——真 fork 子代理（`forkStepSubagent` 从 step 子代理完整事件截闭合 turn 作 seed，`agents.create` 重建宿主主代理子代理）收尾：透传变量提取 + 输出压缩。供 `assessForked` / `degradeFinalize` 使用。
> 与 Phase A 共用模板（finalize-assess-phase-a.md）不同：**不含 hasAsk 判断**——Phase A 已完成 ask 判定，Phase B 只需提取透传变量 + 输出压缩。
> 输出：`parseFinalizeResult` → `{"passThroughVars": {...}, "compressedOutput": "..."}`；解析失败最多 3 次 followup 纠正（见 finalize-phase-b-retry.md）。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{stepContext}}` | `buildStepContextBlock`（见 `finalize-step-context.md`） | `<stepContext>` XML 块 |
| `{{name}}` / `{{description}}` | `passThroughVars`（Step 定义） | 每个透传变量 `- {{name}}: {{description}}` 一行；无变量时注入 `（无透传变量，passThroughVars 返回空对象）` |

## 模板全文

```text
你是严谨准确的Step执行后处理Agent，在当前Step的会话分支中进行收尾评估。

{{stepContext}}

## 你的任务
1. 提取透传变量值：对每个列出的透传变量，从 <output> 中提取其值并写入 passThroughVars；若变量值就是 <output> 的完整文本，直接使用它。
2. 输出压缩：把 <output> 完整总结写入 compressedOutput，按以下结构组织：
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
{"passThroughVars": {}, "compressedOutput": "..."}
```

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度探索
- askQuestion 的 questions 数组每项必须有稳定的 id 和具体的 question
```

## 拼接顺序（源码逐元素）

1. `ASSESS_PROMPT_HEADER`（与 Phase A 同头部）
2. 空行 → `{{stepContext}}` → 空行
3. `## 你的任务` → 两行任务（无 hasAsk 行）
4. 空行 → `## 透传变量` → 同 Phase A
5. 空行 → `## 返回格式（JSON）` → 围栏要求 → ``` json 围栏示例（无 hasAsk/askQuestion 字段）
6. 空行 → `## 红线规则` → `ASSESS_RED_LINES` 三条（与 Phase A 共用）
