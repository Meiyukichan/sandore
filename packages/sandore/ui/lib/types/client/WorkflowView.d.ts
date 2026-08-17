import type { GlobalStandardProps, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { InstanceSummary, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
import { type RunViewRemote } from './RunView.tsx';
import type { SaveDefinition } from './sandore-save.ts';
/** 编辑区打开目标：实例（RunView）或定义（DagEditor；id 省略为新建）。 */
export type WorkflowSelection = {
    readonly kind: 'instance';
    readonly id: string;
} | {
    readonly kind: 'definition';
    readonly id?: string;
    readonly initialYaml?: string;
};
/** WorkflowView 接收的业务 face（RPC 已解包；`useWorkspaces` 为全局标准 prop）。 */
export interface WorkflowViewFace {
    /** 拉取实例摘要（RPC 已解包）。 */
    listInstances(): Promise<InstanceSummary[]>;
    /** 拉取定义列表（RPC 已解包）。 */
    listDefinitions(): Promise<WorkflowDefinitionEntry[]>;
    /** 删除定义（RPC 已解包）。 */
    deleteDefinition(id: string): Promise<boolean>;
    /** 读取定义原始 YAML（RPC 已解包）。 */
    getYaml(id: string): Promise<string>;
    /** DagEditor 保存回调（`createSandoreSave` 接线）。 */
    save: SaveDefinition;
    /** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
    remote: RunViewRemote;
    /** 打开宿主会话（RunView「打开讨论」跳实例会话）。 */
    openSession(id: string): void;
}
/** WorkflowView 的组件 props：注入 face + locale + 全局标准 prop（useWorkspaces）。 */
export type WorkflowViewProps = InjectFace<WorkflowViewFace> & PropsLocale<'sandore'> & GlobalStandardProps;
/** 渲染 WorkflowView（双栏工作区）。 */
export declare function WorkflowView({ useWorkspaces, listInstances, listDefinitions, deleteDefinition, getYaml, save, remote, openSession, t, }: WorkflowViewProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowView.d.ts.map