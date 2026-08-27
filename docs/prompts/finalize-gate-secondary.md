# secondary 门禁审查提示词（buildSecondaryGatePrompt）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts:485`（`buildSecondaryGatePrompt`）
> 场景：Phase C secondary 门禁（`gates.secondary.enabled=true`）——**唯一会跑门禁 AI 的通道**；经 `subagents.startContinuable` 建宿主主代理可续接子代理（agent loop + 工具 + preset 系统提示词；**无 seed**，prompt 携带 stepContext），settle 终态取输出，失败降级临时会话记 errorDetail。
> 框架：身份头部 + stepContext + `## 你的任务`（**用户 prompt 原样注入**，未配置时用中性 fallback，不内置「检查完成度/质量」要求）+ 返回 JSON 格式。primary 门禁为纯代码产物校验（零 AI），无对应提示词。
> 输出：`parseSecondaryGate` → `{"gateStatus": "done" | "error", "gateDetail": "..."}`；`done` = 通过。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{stepContext}}` | `buildStepContextBlock`（见 `finalize-step-context.md`） | `<stepContext>` XML 块 |
| `{{secondaryPrompt}}` | `gates.secondary.prompt` | 用户配置的门控审查要求（原样注入）；未配置时回退 `请根据门控审查要求审查当前 Step 的输出，并给出通过或不通过的结论。` |

## 模板全文

```text
你是严谨准确的Step门禁审查Agent，请按照用户给定的门控审查要求，对当前Step的输出进行审查。

{{stepContext}}

## 审查要求
你必须**实际使用文件系统工具验证**（如 glob/read/stat 等）确认审查依据，而不是仅凭 Step 输出文本推断结论。
若审查要求涉及产物文件的存在性/内容，请先使用工具在当前项目目录中搜索确认，再给出结论。
只有当工具验证结果与审查要求不符时，才判定不通过。

## 你的任务
{{secondaryPrompt}}

## 返回格式（JSON）
{"gateStatus": "done" | "error", "gateDetail": "..."}
```

## 拼接顺序（源码逐元素）

1. `SECONDARY_GATE_PROMPT_HEADER`（上文首行）
2. 空行 → `{{stepContext}}` → 空行
3. `## 审查要求` → 三行工具验证要求（2026-08-25 real-e2e 增强：引导门禁子代理实际使用工具验证，基于文件系统事实而非文本推断）
4. 空行 → `## 你的任务` → `{{secondaryPrompt}}`（fallback 见参数表）
5. 空行 → `## 返回格式（JSON）` → gateStatus/gateDetail 一行
