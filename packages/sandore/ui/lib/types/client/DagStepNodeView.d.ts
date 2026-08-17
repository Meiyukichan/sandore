import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import { type RetryMode } from './run-view-model.ts';
/** 由插件自身服务访问注入的导航与重试动作。 */
export interface SandoreStepInjected {
    readonly openSession: (id: SessionId) => void;
    readonly retryStep: (input: {
        instanceId: string;
        stepId: string;
        mode: RetryMode;
        message: string;
    }) => Promise<void>;
}
/** keyed Chat 渲染器完整 props。 */
export type DagStepNodeViewProps = PropsRuntime<'conversation.chat.node', 'sandore-step'> & PropsLocale<'sandore'> & SandoreStepInjected;
/** 渲染单个 sandore Step 节点。 */
export declare function DagStepNodeView({ node, sessionId, openSession, retryStep, t }: DagStepNodeViewProps): import("react").JSX.Element;
//# sourceMappingURL=DagStepNodeView.d.ts.map