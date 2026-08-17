import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowOverlayFace } from './workflow-face.ts';
/** EditorPane 接收的 props。 */
export interface EditorPaneProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 业务 face（RPC 已解包）。 */
    face: WorkflowOverlayFace;
    /** 保存成功后刷新左列表（由 overlay 逐级透传）。 */
    onSaved(id: string): void;
}
/** 渲染右栏编辑区。 */
export declare function EditorPane({ t, face, onSaved }: EditorPaneProps): import("react").JSX.Element;
//# sourceMappingURL=EditorPane.d.ts.map