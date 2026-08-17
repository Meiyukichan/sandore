import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client';
import type { InstanceSummary } from '@deepseek-ai/dsh-sandore-workflow/remote';
/** InstanceList 接收的普通业务 props。 */
export interface InstanceListProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 工作区成员表（WorkspaceView[].sessionIds 为会话账号）。 */
    workspaces: readonly WorkspaceView[];
    /** 客户端过滤关键词（匹配 instanceId / jobId）。 */
    query: string;
    /** 拉取实例摘要（RPC 已解包）。 */
    listInstances(): Promise<InstanceSummary[]>;
    /** 点击实例行下钻 RunView。 */
    onOpen(instanceId: string): void;
}
/** 渲染 InstanceList。 */
export declare function InstanceList({ t, workspaces, query, listInstances, onOpen }: InstanceListProps): import("react").JSX.Element;
//# sourceMappingURL=InstanceList.d.ts.map