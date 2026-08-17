import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { PreviewTarget } from './workflow-store.ts';
/** PreviewPanel 接收的 props。 */
export interface PreviewPanelProps {
    /** 类型化翻译函数。 */
    t: TranslateNS<'sandore'>;
    /** 预览目标（null = 关闭/隐藏）。 */
    target: PreviewTarget | null;
    /** 关闭预览。 */
    onClose(): void;
}
/** 渲染右栏预览。 */
export declare function PreviewPanel({ t, target, onClose }: PreviewPanelProps): import("react").JSX.Element | null;
//# sourceMappingURL=PreviewPanel.d.ts.map