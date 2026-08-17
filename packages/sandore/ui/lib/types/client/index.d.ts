/** sandore Client UI 入口：挂载 sandore Remote 命名空间、注册 sidebar 工作流入口与 shell.overlay 全局工作流 UI。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Client 插件依赖的 cordis 服务键。 */
export declare const inject: string[];
/** 挂载 sandore 远程命名空间、注册 locale 字典与工作流入口/overlay。 */
export declare function apply(ctx: ClientContext): Promise<void>;
//# sourceMappingURL=index.d.ts.map