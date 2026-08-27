# `<stepContext>` XML 块（buildStepContextBlock）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts:351`（`buildStepContextBlock`）
> 场景：被三个收尾提示词共用——Phase A（finalize-assess-phase-a.md）、Phase B（finalize-phase-b.md）、secondary 门禁（finalize-gate-secondary.md）。
> 说明：input/output 内容每行 4 空格缩进；`artifacts` 为空时 `<artifacts>` 内无行。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{input}}` | `FinalizeStepContext.input` | Step 输入（用户原始需求/上游信息，每行 4 空格缩进） |
| `{{output}}` | `FinalizeStepContext.output` | Step 执行输出（当前 step 子代理返回结果文本，每行 4 空格缩进） |
| `{{artifact}}` | `FinalizeStepContext.artifacts` | Step 产物文件路径（每个 `- {{artifact}}` 一行） |

## 模板全文

```text
<stepContext>
  <input>
    {{input 每行 4 空格缩进}}
  </input>
  <output>
    {{output 每行 4 空格缩进}}
  </output>
  <artifacts>
    - {{artifact1}}
    - {{artifact2}}
  </artifacts>
</stepContext>
```

## 拼接顺序（源码逐元素）

1. `<stepContext>` → `  <input>` → `{{input}}`（每行前加 4 空格）→ `  </input>`
2. `  <output>` → `{{output}}`（每行前加 4 空格）→ `  </output>`
3. `  <artifacts>` → 每产物 `    - {{artifact}}` → `  </artifacts>` → `</stepContext>`
