/**
 * sandore 工具面的统一注册器（架构决策 3）。
 *
 * 五个模型工具，前缀一律 `sandore_workflow_`：
 * - `sandore_workflow`——定义 / Step 库 / Microflow 库读写（manager-tool.ts）
 * - `sandore_workflow_run`——唯一启动入口（run-tool.ts）
 * - `sandore_workflow_status`——实例状态查询（status-tool.ts）
 * - `sandore_workflow_send_message`——给 Step 子代理发消息（message-tool.ts）
 * - `sandore_workflow_control`——暂停 / 继续（control-tool.ts）
 *
 * 全部全局注册在引擎 ctx（`ctx.tools.register`），可见于所有会话；execute 期 gate
 * 拒绝委派子代理（见 tool-support.assertCallerIsTopLevel）。`tools` 服务缺失
 * （最小桩部署 / 测试 ctx）时逐个静默跳过，不阻塞引擎启动。
 * @module @meiyukichan/dsh-sandore/workflow/src/host-tools
 */
import type { Context } from '@deepseek-ai/cordis';

import { registerGlobalControlTool } from './control-tool.ts';
import { registerGlobalManagerTool } from './manager-tool.ts';
import { registerGlobalMessageTool } from './message-tool.ts';
import { registerGlobalRunTool } from './run-tool.ts';
import { registerGlobalStatusTool } from './status-tool.ts';
import type { SandoreToolHost } from './tool-support.ts';

/** 五个工具的注册名（拼接成的稳定清单，供测试/文档断言）。 */
export const SANDORE_WORKFLOW_TOOL_NAMES = [
  'sandore_workflow',
  'sandore_workflow_run',
  'sandore_workflow_status',
  'sandore_workflow_send_message',
  'sandore_workflow_control',
] as const;

/**
 * 注册全部 `sandore_workflow*` 工具。
 * @param ctx - 引擎上下文（`ctx.get('tools')` 取全局工具注册表）。
 * @param host - 工具宿主 seam（engine 公开方法 + persistence）。
 * @returns 撤销全部注册的 disposer。
 */
export function registerGlobalWorkflowTools(ctx: Context, host: SandoreToolHost): () => void {
  const disposers = [
    registerGlobalManagerTool(ctx, host),
    registerGlobalRunTool(ctx, host),
    registerGlobalStatusTool(ctx, host),
    registerGlobalMessageTool(ctx, host),
    registerGlobalControlTool(ctx, host),
  ];
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
