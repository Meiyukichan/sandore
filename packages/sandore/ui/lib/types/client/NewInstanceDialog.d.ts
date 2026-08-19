import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowOverlayFace } from './workflow-face.ts';
/** NewInstanceDialog 接收的 props。 */
export interface NewInstanceDialogProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 业务 face（RPC 已解包）。 */
    face: WorkflowOverlayFace;
    /** 关闭弹窗。 */
    onClose(): void;
    /** 创建成功回调（携带实例 id，供宿主切执行态并选中）。 */
    onCreated(instanceId: string): void;
}
/** 渲染「新增实例」弹窗。 */
export declare function NewInstanceDialog({ t, face, onClose, onCreated }: NewInstanceDialogProps): import("react").JSX.Element;
//# sourceMappingURL=NewInstanceDialog.d.ts.map