import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client';
import type { WorkflowOverlayFace } from './workflow-face.ts';
/** WorkflowList 接收的 props。 */
export interface WorkflowListProps {
    /** 类型化翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 工作区成员表（供 InstanceList 按工作区分组）。 */
    workspaces: readonly WorkspaceView[];
    /** 业务 face（列表类 RPC 已解包）。 */
    face: WorkflowOverlayFace;
    /** 刷新计数：变化时重挂载列表（保存/删除/手动刷新后）。 */
    refreshKey: number;
    /** 列表列宽（px，拖拽分隔条驱动）。 */
    width: number;
}
/** 渲染工作流 overlay 左栏列表。 */
export declare function WorkflowList({ t, workspaces, face, refreshKey, width }: WorkflowListProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowList.d.ts.map