import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { DagBranch } from '@deepseek-ai/dsh-sandore-workflow/schema';
import { type CommandType } from './dag-editor-model.ts';
/** 流控目标节点（下拉选项）。 */
export interface FlowTarget {
    readonly id: string;
    readonly name: string;
}
/** 节点的流控字段集合（出边统一在 branches）。 */
export interface FlowFields {
    readonly branches?: readonly DagBranch[] | undefined;
}
/**
 * 渲染 Stage/Step 流控编辑器（分支列表：每条 = 类型下拉 + 只读目标 + 判断条件 + 循环）。
 * 循环由画布回环连线自动产生（loop 必填），详情不做手动添加。
 * @param conditionTypes - 判断条件命令可选类型（缺省 = 全部五类型；Stage 层 shell/prompt）。
 */
export declare function FlowEditor({ t, flow, targets, onChange, conditionTypes }: {
    readonly t: TranslateNS<'sandore'>;
    readonly flow: FlowFields;
    readonly targets: readonly FlowTarget[];
    readonly onChange: (flow: FlowFields) => void;
    /** 判断条件命令可选类型（缺省 = 全部五类型）。 */
    readonly conditionTypes?: readonly CommandType[] | undefined;
}): import("react").JSX.Element;
//# sourceMappingURL=FlowEditor.d.ts.map