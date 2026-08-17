/** sidebar.footer.action 工作流入口：点击切换 shell.overlay 全局工作流 UI（设置上方）。 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** 注册进 slot 的业务 face：切换工作流 overlay 开关的回调。 */
export interface WorkflowButtonFace {
    /** 点击「工作流」：切换 shell.overlay 全局工作流 UI 开关（开→关、关→开）。 */
    onToggleWorkflow(): void;
}
/** sidebar.footer.action 的组件 props（owner + 注入 face + locale）。 */
export type WorkflowButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>;
/** 渲染工作流入口按钮，点击切换全局工作流 overlay 开关；overlay 打开时按钮高亮。 */
export declare function WorkflowButton({ wide, t, onToggleWorkflow }: WorkflowButtonProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowButton.d.ts.map