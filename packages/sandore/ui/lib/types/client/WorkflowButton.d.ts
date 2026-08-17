/** sidebar.footer.action 工作流入口：点击后把主区切换到「工作流」双栏视图（不再展开面板）。 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** 注册进 slot 的业务 face：打开工作流视图的导航回调。 */
export interface WorkflowButtonFace {
    /** 点击「工作流」：确保有会话打开，并把主区切换到「工作流」视图 tab（双栏工作区）。 */
    onOpenWorkflow(): Promise<void>;
}
/** sidebar.footer.action 的组件 props（owner + 注入 face + locale）。 */
export type WorkflowButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>;
/** 渲染工作流入口按钮，点击打开右侧编辑区（conversation.view「工作流」tab）。 */
export declare function WorkflowButton({ wide, t, onOpenWorkflow }: WorkflowButtonProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowButton.d.ts.map