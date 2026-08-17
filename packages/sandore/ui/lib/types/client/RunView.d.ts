import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ArtifactEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
import type { RetryMode } from './run-view-model.ts';
/** RunView 所需的最小 `ctx.remote.sandore` 访问面。 */
export interface RunViewRemote {
    getInstanceState(instanceId: string): Promise<RemoteResult<unknown>>;
    getArtifacts(instanceId: string, stageId?: string): Promise<RemoteResult<ArtifactEntry[]>>;
    abortInstance(instanceId: string): Promise<RemoteResult<void>>;
    pauseAll(input: {
        instanceId: string;
    }): Promise<RemoteResult<void>>;
    resumeAll(input: {
        instanceId: string;
        resumePrompt?: string;
    }): Promise<RemoteResult<void>>;
    pauseStep(input: {
        instanceId: string;
        stepId: string;
    }): Promise<RemoteResult<void>>;
    resumeStep(input: {
        instanceId: string;
        stepId: string;
        resumePrompt?: string;
    }): Promise<RemoteResult<void>>;
    retryStep(input: {
        instanceId: string;
        stepId: string;
        mode: RetryMode;
        message: string;
    }): Promise<RemoteResult<void>>;
    replyQuestion(input: {
        instanceId: string;
        requestId: string;
        answers: unknown;
    }): Promise<RemoteResult<void>>;
    replyPermission(input: {
        instanceId: string;
        requestId: string;
        reply: 'once' | 'always' | 'reject';
    }): Promise<RemoteResult<void>>;
}
/** RunView 接收的普通业务 props（instanceId + 打开讨论回调 + remote 访问面 + locale）。 */
export interface RunViewProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 目标工作流实例 id（宿主 Session id == instanceId）。 */
    instanceId: string;
    /** 打开讨论回调：跳宿主会话 chat 视图（`ctx.sessions.open(instanceId)`）。 */
    openDiscussion: () => void;
    /** `ctx.remote.sandore` 的最小 RPC 访问面（返回 `RemoteResult`，经 `unwrap` 解包）。 */
    remote: RunViewRemote;
}
/** 渲染 RunView。 */
export declare function RunView({ t, instanceId, openDiscussion, remote }: RunViewProps): import("react").JSX.Element;
//# sourceMappingURL=RunView.d.ts.map