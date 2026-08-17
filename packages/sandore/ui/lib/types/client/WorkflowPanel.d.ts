import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client';
import type { InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
/** 工作流打开目标：实例（RunView）或定义（DagEditor）。 */
export type WorkflowOpenTarget = {
    readonly kind: 'instance';
    readonly instanceId: string;
} | {
    readonly kind: 'definition';
    readonly definitionId?: string;
    readonly initialYaml?: string;
};
/** WorkflowPanel 接收的普通业务 props。 */
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
    /** 点击工作流项 → 打开右侧编辑区（宿主会话 + 工作流 tab）。 */
    onOpen(target: WorkflowOpenTarget): void;
}
/** 渲染 WorkflowPanel（sidebar 内列表）。 */
export declare function WorkflowPanel({ t, workspaces, listInstances, listDefinitions, deleteDefinition, onOpen }: WorkflowPanelProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowPanel.d.ts.map