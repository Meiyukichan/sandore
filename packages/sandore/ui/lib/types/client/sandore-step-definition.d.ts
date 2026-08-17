/**
 * sandore-step 讨论节点定义：把 6 个 sandore/step-* Session 事件折叠为单个
 * keyed Chat 节点（kind `sandore-step`、target `chat`）。
 *
 * `match` 命中 `sandore/step-start|step-completed|step-failed|step-paused|
 * step-resumed|step-retried`；`start`/`update` 折叠为节点状态
 * `{stepId, childId, name, status, loopIteration?, output?, error?}`。同一
 * `stepId` 的循环多次迭代以 `stepId#loopIteration` 派生独立节点 id。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/sandore-step-definition
 */
import type { ConversationNodeDefinition, SessionId } from '@deepseek-ai/dsh-client-runtime/client';
/** 单个 sandore-step 节点的折叠状态（running/completed/failed/paused 四态）。 */
export type SandoreStepStatus = 'running' | 'completed' | 'failed' | 'paused';
/** step-completed output 中内联渲染所需的纯文本块。 */
export interface SandoreTextBlock {
    readonly type: 'text';
    readonly text: string;
}
/** keyed Chat 渲染器的 payload（经 buildViewNode 投影）。 */
export interface SandoreStepChatData {
    readonly stepId: string;
    readonly childId: SessionId;
    readonly name: string;
    readonly status: SandoreStepStatus;
    /** 循环迭代标签（如 `#1.2`），非循环 Step 缺省。 */
    readonly loopLabel?: string;
    /** completed 态的内联结果文本块（缺省表示无文本输出）。 */
    readonly output?: readonly SandoreTextBlock[];
    /** failed 态的错误详情。 */
    readonly error?: string;
}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ChatNodeDataMap {
        /** 单个 Step 的讨论节点 payload。 */
        'sandore-step': SandoreStepChatData;
    }
}
/** 折叠状态（与 step-* 事件 payload 对齐，output 收窄为纯文本块）。 */
interface SandoreStepState {
    readonly stepId: string;
    readonly childId: SessionId;
    readonly name: string;
    readonly status: SandoreStepStatus;
    readonly loopIteration?: readonly number[];
    readonly output?: readonly SandoreTextBlock[];
    readonly error?: string;
}
/** 由 stepId + 循环迭代路径派生稳定节点 id（`step-xxx` 或 `step-xxx#1.2`）。 */
export declare function nodeIdOf(stepId: string, loopIteration: readonly number[] | undefined): string;
/** 循环迭代路径 → 展示标签（`#1.2`），非循环返回 undefined。 */
export declare function loopLabelOf(loopIteration: readonly number[] | undefined): string | undefined;
/** 单个 Step 的讨论节点状态机（sandore 6 个 step-* 事件折叠）。 */
export declare const sandoreStepDefinition: ConversationNodeDefinition<SandoreStepState>;
export {};
//# sourceMappingURL=sandore-step-definition.d.ts.map