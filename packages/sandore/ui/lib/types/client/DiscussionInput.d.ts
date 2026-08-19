import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { PendingPermissionEntry, PendingQuestionEntry } from '@deepseek-ai/dsh-sandore-workflow/schema';
import { type AnswerItem, type DagRunStatus, type ExecutedStep, type RetryMode } from './run-view-model.ts';
import type { ModelDirectoryFace, ObservableFace, PermissionSelectValue } from './model-faces.ts';
/** DiscussionInput 接收的 props。 */
export interface DiscussionInputProps {
    /** 类型化翻译函数。 */
    t: TranslateNS<'sandore'>;
    /** 实例生命周期状态。 */
    status: DagRunStatus;
    /** 已执行 Step 列表（供 @Step 选择、失败默认目标与接管面板 step 名反查）。 */
    steps: readonly ExecutedStep[];
    /** 待答问题条目（接管 QuestionComposer）。 */
    questions: readonly PendingQuestionEntry[];
    /** 待批权限条目（接管 ApprovalPanel）。 */
    permissions: readonly PendingPermissionEntry[];
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
    /** 回复问答（整批回答）。 */
    onReplyQuestion(requestId: string, answers: AnswerItem[]): void;
    /** 回复权限（once/always/reject）。 */
    onReplyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): void;
    /** 中止实例（running/paused 态 trailing 的 ghost 按钮）。 */
    onAbort?(): void;
    /** 目标工作流实例 id（宿主 Session id；模型目录/权限/命令都绑定它）。 */
    instanceId: string;
    /** 复用 DSH `ctx.modelDirectories` 的每会话模型目录。 */
    modelDirectory(sessionId: string): ModelDirectoryFace;
    /** 当前实例会话的权限投影（`projections.permissions`）。 */
    sessionPermissions: ObservableFace<PermissionSelectValue | undefined>;
    /** 对实例会话执行命令（`/permission <id>`）。 */
    runCommand(sessionId: string, line: string): Promise<boolean>;
    /** 权限投影缺失回退：查询当前权限预设与可用列表。 */
    queryPermission(): Promise<PermissionSelectValue | undefined>;
}
/** 渲染执行详情底部（composer 或接管面板）。 */
export declare function DiscussionInput({ t, status, steps, questions, permissions, pending, onPauseAll, onResumeAll, onResumeStep, onRetryStep, onReplyQuestion, onReplyPermission, onAbort, instanceId, modelDirectory, sessionPermissions, runCommand, queryPermission }: DiscussionInputProps): import("react").JSX.Element;
//# sourceMappingURL=DiscussionInput.d.ts.map