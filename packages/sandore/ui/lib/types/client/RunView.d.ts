import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ArtifactEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
import { type RetryMode } from './run-view-model.ts';
import type { ModelDirectoryFace, ObservableFace, PermissionSelectValue } from './model-faces.ts';
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
/** RunView 接收的普通业务 props（instanceId + 跳会话回调 + remote 访问面 + locale）。 */
export interface RunViewProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 目标工作流实例 id（宿主 Session id == instanceId）。 */
    instanceId: string;
    /** 跳会话回调（agent 标题 → DSH 现成子代理会话页）。 */
    openSession(id: string): void;
    /** `ctx.remote.sandore` 的最小 RPC 访问面（返回 `RemoteResult`，经 `unwrap` 解包）。 */
    remote: RunViewRemote;
    /** 某会话的共享模型目录（复用 DSH `ctx.modelDirectories`）。 */
    modelDirectory(sessionId: string): ModelDirectoryFace;
    /** 某会话的权限投影（`projections.permissions`）。 */
    permissions(sessionId: string): ObservableFace<PermissionSelectValue | undefined>;
    /** 对某会话执行一行命令（`/permission <id>`）。 */
    runCommand(sessionId: string, line: string): Promise<boolean>;
    /** 权限投影缺失回退：经 `/permission`（无参）查询。 */
    queryPermission(sessionId: string): Promise<PermissionSelectValue | undefined>;
}
/** 渲染 RunView（树形导航 + 执行详情页）。 */
export declare function RunView({ t, instanceId, openSession, remote, modelDirectory, permissions: sessionPermissionsOf, runCommand, queryPermission }: RunViewProps): import("react").JSX.Element;
//# sourceMappingURL=RunView.d.ts.map