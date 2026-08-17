import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client';
import type { InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
import type { RunViewRemote } from './RunView.tsx';
import type { SaveDefinition } from './sandore-save.ts';
import type { OpenDiscussion } from './open-discussion.ts';
/** WorkflowPanel 接收的普通业务 props（由 WorkflowButton 从 slot face 与 owner 组装）。 */
export interface WorkflowPanelProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 工作区成员表（供 InstanceList 按工作区分组）。 */
    workspaces: readonly WorkspaceView[];
    /** 拉取实例摘要（RPC 已解包）。 */
    listInstances(): Promise<InstanceSummary[]>;
    /** 拉取定义列表（RPC 已解包）。 */
    listDefinitions(): Promise<WorkflowDefinitionEntry[]>;
    /** 删除定义（RPC 已解包）。 */
    deleteDefinition(id: string): Promise<boolean>;
    /** DagEditor 保存回调（由 createSandoreSave 产出）。 */
    save: SaveDefinition;
    /** 按 instanceId 生成 RunView 的「打开讨论」回调（由 createOpenDiscussion 产出）。 */
    openDiscussion(instanceId: string): OpenDiscussion;
    /** RunView 所需的最小 RPC 访问面。 */
    remote: RunViewRemote;
}
/** 渲染 WorkflowPanel。 */
export declare function WorkflowPanel({ t, workspaces, listInstances, listDefinitions, deleteDefinition, save, openDiscussion, remote }: WorkflowPanelProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowPanel.d.ts.map