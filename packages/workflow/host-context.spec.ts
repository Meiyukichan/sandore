/**
 * `host-context.ts` 的单元测试（架构决策 4 + 呈现形态）：overlay 新建路径在 run 之前
 * 注入给宿主主代理的协作上下文——要点不可少（调用 run / 不动手 / 四种协作手段 /
 * 提问审批落点 / 不重复 run + 结束后汇报），以及注入消息的 **DSH 上下文注入 source**
 * （`kind !== 'user'` ⇒ 客户端渲染成左侧「上下文注入」行，而非右侧用户气泡）。
 * @module @meiyukichan/dsh-sandore/workflow/src/host-context.spec
 */
import { describe, expect, it } from 'vitest';

import { buildHostContextInjection, HOST_CONTEXT_PLUGIN, hostContextSource } from './host-context.ts';

describe('buildHostContextInjection（架构决策 4）', () => {
  const text = buildHostContextInjection({
    workflowId: 'wfl-123',
    workflowName: '代码评审',
    originalInput: '请评审 src/a.ts 的改动',
  });

  it('opens with the 用户指令 section naming the workflow and quoting the original input', () => {
    expect(text).toContain('## 用户指令');
    expect(text).toContain('用户选择用工作流「代码评审」执行下面这个任务，请调用 sandore_workflow_run 启动它：');
    expect(text).toContain('请评审 src/a.ts 的改动');
  });

  it('carries the launch parameters the model must copy (workflowId is a required tool argument)', () => {
    expect(text).toContain('workflowId = "wfl-123"');
  });

  it('states the collaboration rules with the four tool affordances and the ask/permission landing', () => {
    expect(text).toContain('## 工作流协作规则');
    expect(text).toContain('不要自己动手完成该任务，但你可以继续处理其它周边任务');
    expect(text).toContain('sandore_workflow_status');
    expect(text).toContain('sandore_workflow_send_message');
    expect(text).toContain("action: 'pause'");
    expect(text).toContain("action: 'continue'");
    expect(text).toContain('引擎会自动选择继续现有子代理或重建');
    expect(text).toContain('工作流运行期间的提问与审批会出现在本会话，请照常作答');
    // 步骤**名称 → stepId** 的换算要求：用户只会说名称，模型不应凭猜测编 id
    // （`sandore_workflow_send_message` 的 targets 收的是 stepId）。
    expect(text).toContain('请先用 `sandore_workflow_status`（detail: steps）查出对应的 stepId 再发，不要凭猜测填 id');
  });

  it('forbids a duplicate run and asks for a final report through status', () => {
    expect(text).toContain('同一任务结束前不要重复调用 sandore_workflow_run');
    expect(text).toContain('结束后用 sandore_workflow_status 读取结果并汇报给用户');
  });

  it('states an explicit reporting policy that forbids mid-run per-step progress reports', () => {
    // 真机反馈：主代理在工作流仍在运行时自行发了一条「进展更新（工作流仍在运行中）…」。
    // 注入文本必须给出明确口径，而不是任由模型把 status 当轮询手段。
    expect(text).toContain('## 汇报口径（重要）');
    expect(text).toContain('不要在运行过程中逐 Step 主动汇报进展');
    expect(text).toContain('按需读取');
    expect(text).toContain('不要定期轮询');
    // 允许发言的三种情形都要写清（终态 / 用户询问 / 需决策的问题）。
    expect(text).toContain('工作流已结束');
    expect(text).toContain('用户主动询问');
    expect(text).toContain('需要用户决策的问题');
  });

  it('stays a pure function (same input → same output, no state carried across calls)', () => {
    const again = buildHostContextInjection({
      workflowId: 'wfl-123',
      workflowName: '代码评审',
      originalInput: '请评审 src/a.ts 的改动',
    });
    expect(again).toBe(text);
  });
});

describe('hostContextSource（DSH 上下文注入契约：kind !== user ⇒ 左侧注入行）', () => {
  it('builds the official plugin+notice source shape', () => {
    expect(hostContextSource('实例已结束')).toEqual({
      kind: 'plugin',
      plugin: HOST_CONTEXT_PLUGIN,
      form: 'notice',
      summary: '实例已结束',
    });
    // 关键判据：客户端按 `source.kind !== 'user'` 决定渲染成左侧「上下文注入」行
    // （ui-chat conversation-nodes/message.ts:50），故这里必须是 plugin（不是 user）。
    expect(hostContextSource('x').kind).not.toBe('user');
  });

  it('bounds the summary with the official helper (notice collapsed row ≤120 chars)', () => {
    const source = hostContextSource('x'.repeat(400));
    expect(source.summary.length).toBe(120);
    expect(source.summary.endsWith('…')).toBe(true);
  });

  it('keeps the producer name stable so the row label reads as this plugin', () => {
    expect(HOST_CONTEXT_PLUGIN).toBe('dsh-sandore');
  });
});
