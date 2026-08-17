import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowDefinition } from '@deepseek-ai/dsh-sandore-workflow/schema';
/** WorkflowDetailFields 接收的 props。 */
export interface WorkflowDetailFieldsProps {
    /** 类型化翻译函数。 */
    t: TranslateNS<'sandore'>;
    /** 当前编辑态定义（由宿主持有）。 */
    definition: WorkflowDefinition;
    /** 字段变更回调（宿主合并更新 definition）。 */
    onChange(next: WorkflowDefinition): void;
}
/** 渲染工作流详情字段表单（右侧面板默认视图）。 */
export declare function WorkflowDetailFields({ t, definition, onChange }: WorkflowDetailFieldsProps): import("react").JSX.Element;
//# sourceMappingURL=DefinitionDetail.d.ts.map