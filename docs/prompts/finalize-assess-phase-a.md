# Phase A 收尾评估提示词（buildAssessPrompt）

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
