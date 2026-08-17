/** sidebar.footer.action 工作流入口：设置上方的按钮 + 点击展开 WorkflowPanel。 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { InstanceSummary, PingResponse, WorkflowDefinitionEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
import type { SaveDefinition } from './sandore-save.ts';
import type { OpenDiscussion } from './open-discussion.ts';
import type { RunViewRemote } from './RunView.tsx';
/**
 * 注册进 slot 的业务 face：sandore RPC 调用面。
 * 列表类 RPC（listInstances/listDefinitions/deleteDefinition/ping）已解包为纯值/异常；
 * RunView 所需的 remote 保留 `RemoteResult` 面（RunView 内部自行 unwrap）。
 */
export interface WorkflowButtonFace {
    /** 健康检查往返，返回解包后的 `PingResponse`；失败抛 `SandoreRemoteError`。 */
    ping(): Promise<PingResponse>;
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
/** sidebar.footer.action 的组件 props（owner + 注入 face + locale）。 */
export type WorkflowButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>;
/** 渲染工作流入口按钮，点击切换 WorkflowPanel 展开/收起。 */
export declare function WorkflowButton({ wide, useWorkspaces, t, listInstances, listDefinitions, deleteDefinition, save, openDiscussion, remote, }: WorkflowButtonProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowButton.d.ts.map