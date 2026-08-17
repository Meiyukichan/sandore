import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { DagBranch } from '@deepseek-ai/dsh-sandore-workflow/schema';
import { type CommandType, type MergedStep } from './dag-editor-model.ts';
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
 * @param stageSteps - 当前 Stage 内全部合并 step（含 branches 流控），用于计算回环环上节点。
 * @param currentId - 当前编辑节点 id。
 * @param conditionTypes - 判断条件命令可选类型（缺省 = 全部五类型；Stage 层 shell/prompt）。
 */
export declare function FlowEditor({ t, flow, targets, onChange, stageSteps, currentId, conditionTypes }: {
    readonly t: TranslateNS<'sandore'>;
    readonly flow: FlowFields;
    readonly targets: readonly FlowTarget[];
    readonly onChange: (flow: FlowFields) => void;
    /** 当前 Stage 内全部合并 step（含 branches）；缺省时不做环上节点过滤。 */
    readonly stageSteps?: readonly MergedStep[] | undefined;
    /** 当前编辑节点 id（用于计算回环区间）。 */
    readonly currentId?: string | undefined;
    /** 判断条件命令可选类型（缺省 = 全部五类型）。 */
    readonly conditionTypes?: readonly CommandType[] | undefined;
}): import("react").JSX.Element;
//# sourceMappingURL=FlowEditor.d.ts.map