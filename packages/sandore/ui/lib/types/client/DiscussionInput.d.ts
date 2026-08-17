import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { type DagRunStatus, type ExecutedStep, type RetryMode } from './run-view-model.ts';
/** DiscussionInput 接收的 props。 */
export interface DiscussionInputProps {
    /** 类型化翻译函数。 */
    t: TranslateNS<'sandore'>;
    /** 实例生命周期状态。 */
    status: DagRunStatus;
    /** 已执行 Step 列表（供 @Step 选择与失败默认目标）。 */
    steps: readonly ExecutedStep[];
    /** 动作进行中（禁用交互）。 */
    pending: boolean;
    /** 暂停全部（running 态主操作）。 */
    onPauseAll(): void;
    /** 广播恢复（文本作 resumePrompt）。 */
    onResumeAll(resumePrompt: string): void;
    /** 定点恢复指定 Step。 */
    onResumeStep(stepId: string, resumePrompt: string): void;
    /** 重试指定 Step（失败态）。 */
    onRetryStep(stepId: string, mode: RetryMode, message: string): void;
}
/** 渲染状态驱动输入区。 */
export declare function DiscussionInput({ t, status, steps, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep }: DiscussionInputProps): import("react").JSX.Element;
//# sourceMappingURL=DiscussionInput.d.ts.map