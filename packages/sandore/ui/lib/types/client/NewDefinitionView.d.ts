import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowOverlayFace } from './workflow-face.ts';
/** NewDefinitionView 接收的 props。 */
export interface NewDefinitionViewProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 业务 face（DagEditor 的 RPC 面）。 */
    face: WorkflowOverlayFace;
    /** 保存成功后刷新左列表（由 overlay 逐级透传）。 */
    onSaved(id: string): void;
}
/** 渲染新建工作流向导。 */
export declare function NewDefinitionView({ t, face, onSaved }: NewDefinitionViewProps): import("react").JSX.Element;
//# sourceMappingURL=NewDefinitionView.d.ts.map