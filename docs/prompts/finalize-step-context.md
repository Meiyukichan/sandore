# 收尾输入信息块（buildStepContextBlock，v6 `<ReferenceInfo>`）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts`（`buildStepContextBlock`）
> 场景：被三个收尾提示词共用——Phase A（finalize-assess-phase-a.md）、Phase B 降级版（finalize-phase-b.md）、secondary 门禁（finalize-gate-secondary.md）。
> 说明：v6 `<ReferenceInfo>` 框架（2026-08-25）——`<ReferenceInfo>` root + `<Reference title>` 自描述块 + `<Input>`/`<Output>`/`<Artifacts>`/`<Artifact>`（全驼峰）；内容统一转义（`escapeXml`）。替代 v1 的 `<stepContext>` 小写根标签（违反全目录 PascalCase 规范）。

## 模板全文

```text
<ReferenceInfo>
  <Reference title="当前 Step 的输入和输出">
    <Input>
      {{input 每行 6 空格缩进}}
    </Input>
    <Output>
      {{output 每行 6 空格缩进}}
    </Output>
    <Artifacts>
      <Artifact>{{file1}}</Artifact>
      <Artifact>{{file2}}</Artifact>
    </Artifacts>
  </Reference>
</ReferenceInfo>
```

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{input}}` | `FinalizeStepContext.input` | Step 输入（每行 6 空格缩进，经 `escapeXml` 转义） |
| `{{output}}` | `FinalizeStepContext.output` | Step 执行输出（每行 6 空格缩进，经 `escapeXml` 转义） |
| `{{file}}` | `FinalizeStepContext.artifacts` | Step 产物文件（每个 `<Artifact>{{file}}</Artifact>` 一行，经 `escapeXml` 转义） |

## 使用差异（消费方）

| 模板 | 注入时机 |
|------|----------|
| Phase A（ask 判定） | **必注入**（`## 参考信息` 节；评估需要 Step 输入输出） |
| Phase B（收尾） | **仅降级注入**（fork 成功上下文在会话里；降级 `degradeFinalize` 注入 `## 参考信息`） |
| secondary 门禁 | **必注入**（子代理无 seed 无 fork 历史，参考信息是唯一 Step 上下文） |
