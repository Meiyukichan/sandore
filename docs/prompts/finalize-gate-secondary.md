# secondary 门禁审查提示词（buildSecondaryGatePrompt）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts`（`buildSecondaryGatePrompt`）
> 场景：Phase C secondary 门禁（`gates.secondary.enabled=true`）——**唯一会跑门禁 AI 的通道**；经 `subagents.startContinuable` 建宿主主代理可续接子代理（agent loop + 工具 + preset 系统提示词；**无 seed**，prompt 携带 stepContext），settle 终态取输出，失败降级临时会话记 errorDetail。
> 框架：时序开场 + 三点 + `## 你的任务`（**用户 prompt 原样注入**，未配置时用中性 fallback，不内置「检查完成度/质量」要求）+ `## 参考信息`（v6 块，**必注入**——无 seed 无 fork 历史）+ 返回 JSON 格式。primary 门禁为纯代码产物校验（零 AI），无对应提示词。
> 输出：`parseSecondaryGate` → `{"gateStatus": "done" | "error", "gateDetail": "..."}`；`done` = 通过。
> **2026-08-25：本文件头部为修正版（v6 结构），下半部分为原版 v1（保留供对照）。**

## 修正版（2026-08-25 讨论定稿）

### 模板全文（修正版）

```text
当前 Step 已执行完成。请完成门禁审查。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 用户配置的门控审查要求，是本次审查的**唯一目标**。
- `## 参考信息` —— 当前 Step 的执行输入与输出，按需查阅。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
{{secondaryPrompt}}

## 审查要求
你必须**实际使用文件系统工具验证**（如 glob/read/stat 等）确认审查依据，而不是仅凭 Step 输出文本推断结论。
若审查要求涉及产物文件的存在性/内容，请先使用工具在当前项目目录中搜索确认，再给出结论。
只有当工具验证结果与审查要求不符时，才判定不通过。

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
请仅返回 JSON，格式如下：
```json
{"gateStatus": "done", "gateDetail": "..."}
```
或
```json
{"gateStatus": "error", "gateDetail": "..."}
```
其中，`gateStatus` 为审查结论（`done` = 通过，`error` = 不通过），`gateDetail` 为审查说明。
```

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{secondaryPrompt}}` | `gates.secondary.prompt` | 用户配置的门控审查要求（原样注入）；未配置时回退 `请根据门控审查要求审查当前 Step 的输出，并给出通过或不通过的结论。` |
| `{{input}}` / `{{output}}` | `FinalizeStepContext` | 当前 Step 的执行输入/输出（v6 `<ReferenceInfo>` 块；内容转义） |
| `{{file}}` | `FinalizeStepContext.artifacts` | 当前 Step 产物文件（每个 `<Artifact>{{file}}</Artifact>` 一行） |

### 设计要点（修正版）

- **结构骨架对齐 v6**：时序开场（当前 Step 已执行完成——门禁发生在收尾 Phase C）+ 头部三点 + 分节；删除固定角色声明（「你是严谨准确的Step门禁审查Agent」）。
- **三点 = 你的任务 / 参考信息 / 返回格式**（无用户指令——`## 你的任务` 为用户配置的审查要求原样注入）。
- **参考信息必注入**（与 Phase B 相反）：secondary 门禁子代理 **无 seed**（`startContinuable` 直接建，prompt 携带 stepContext）——无 fork 历史——参考信息 v6 块是审查的唯一 Step 上下文。
- **`## 审查要求` 保留**：三行工具验证引导（real-e2e 增强——门禁子代理有工具，必须基于文件系统事实而非文本推断；是门禁的实质执行方式，非主观行为要求）。
- **返回格式围栏化**：对齐 batch 形态（```json 围栏 + `done`/`error` 两例 + 解释行）。
- 红线规则：无（审查要求节已承载执行约束；「框架不做行为要求」原则下门禁子代理有 preset 兜底）。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 角色声明 | 「你是严谨准确的Step门禁审查Agent」 | 删除（不注入角色） |
| 2 | 头部 | 角色声明直接开场 | 时序开场 + 行动引导 + 三点职责列表 |
| 3 | 分节 | 审查要求 / 你的任务 / 返回格式（JSON） | 你的任务 / 审查要求 / 参考信息（v6 ReferenceInfo）/ 返回格式 |
| 4 | 参考信息 | `<stepContext>`（小写根标签） | v6 `<ReferenceInfo>`（全驼峰 + 转义） |
| 5 | 返回格式 | 行内一行 | ```json 围栏 + 两例 + 解释行 |

---

## 原版 v1（保留，供对照）

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
