# 前置 Steps 输出和产物子节（renderPreviousOutputs）

> 源码：`packages/sandore/microflow/src/step-runner.ts:202`（`renderPreviousOutputs`）
> 场景：被 `buildPromptText`（step-execute.md）与 `buildFillParamsPrompt`（step-fill-params.md）共用；无前置输出时返回空（不注入）。
> **2026-08-25：本文件头部为修正版（v6，与 step-execute.md 同步），下半部分为原版 v1（保留供对照）。**

## 修正版 v6（2026-08-25 讨论定稿）

### 模板全文（修正版）

```text
  <Reference title="前置Step: {{name}} (id: {{id}}) 的输出和产物">
    <Output>
      {{returnPrompt 每行 6 空格缩进}}
    </Output>
    <Artifacts>
      <Artifact>{{file1}}</Artifact>
      <Artifact>{{file2}}</Artifact>
    </Artifacts>
  </Reference>
```

（多个前置 Step 依次重复整个块；`previousOutputs` 为空数组时不注入。块间空行分隔；在 `buildPromptText` 中置于 `<ReferenceInfo>` 内。）

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{name}}` | `PreviousStepOutput.name` | 前置 Step 名称（title 属性，经 `escapeXmlAttr` 转义） |
| `{{id}}` | `PreviousStepOutput.id` | 前置 Step id（title 属性 `id: {{id}}`，经 `escapeXmlAttr` 转义） |
| `{{returnPrompt}}` | `PreviousStepOutput.returnPrompt` | 前置 Step 输出摘要（`<Output>` 内容，经 `escapeXml` 转义，每行 6 空格缩进） |
| `{{file}}` | `PreviousStepOutput.files` | 前置 Step 产物文件路径（每个 `<Artifact>{{file}}</Artifact>` 一行，经 `escapeXml` 转义） |

### 设计要点（修正版）

- 标签全驼峰（`Reference` / `Output` / `Artifacts` / `Artifact`），符合全目录规范。
- title 直接描述块内容（「输出和产物」与 `<Output>` + `<Artifacts>` 一一对应）。
- 移除 v1 的动态容器标签 `<{{id}}>`——id 由 `title` 属性承载，XML 永远合法。
- 全部内容统一转义（`escapeXml` / `escapeXmlAttr`）。

### 与 v1 差异摘要

| # | 项 | v1 | v6 |
|---|-----|-----|-----|
| 1 | 容器 | MD 标题 `## 前置Steps输出与产物` + 动态标签 `<{{stepId}}>` | `<Reference title="前置Step: {{name}} (id: {{id}}) 的输出和产物">` |
| 2 | 内容 | `<output>` + `<artifacts>` 列表（`- {{file}}`） | `<Output>` + `<Artifacts>` + `<Artifact>`（全驼峰） |
| 3 | 转义 | 无 | `escapeXml` / `escapeXmlAttr` 统一转义 |
| 4 | 层级 | `### 前置Step:` MD 标题混 XML | 纯 XML 块，无 MD 混合 |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/step-runner.ts:179`（`renderPreviousOutputs`）
> 场景：被 `buildPromptText`（step-execute.md）与 `buildFillParamsPrompt`（step-fill-params.md）共用；无前置输出时返回空（不注入）。
> 说明：每个前置 Step 输出块以 `<{{stepId}}>` 为容器，output 内容每行 4 空格缩进，artifacts 为产物文件列表。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{name}}` | `PreviousStepOutput.name` | 前置 Step 名称 |
| `{{id}}` | `PreviousStepOutput.id` | 前置 Step id（同时作为 XML 容器标签） |
| `{{returnPrompt}}` | `PreviousStepOutput.returnPrompt` | 前置 Step 输出摘要文本（每行 4 空格缩进） |
| `{{file}}` | `PreviousStepOutput.files` | 前置 Step 产物文件路径（每个 `- {{file}}` 一行） |

## 模板全文

```text
## 前置Steps输出与产物
### 前置Step: {{name}} ({{id}})
<{{id}}>
  <output>
    {{returnPrompt 每行 4 空格缩进}}
  </output>
  <artifacts>
    - {{file1}}
    - {{file2}}
  </artifacts>
</{{id}}>
```

（多个前置 Step 依次重复整个块；`previousOutputs` 为空数组时整节不注入）
