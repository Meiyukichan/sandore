import type { GlobalStandardProps, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkflowOverlayFace } from './workflow-face.ts';
/** WorkflowOverlay 的组件 props：注入 face + locale + 全局标准 prop（useWorkspaces）。 */
export type WorkflowOverlayProps = InjectFace<WorkflowOverlayFace> & PropsLocale<'sandore'> & GlobalStandardProps;
/** 渲染 shell.overlay 全局工作流 UI（关闭时渲染 null）。 */
export declare function WorkflowOverlay({ useWorkspaces, listInstances, listDefinitions, startInstance, listModelDirectory, pickDirectory, deleteDefinition, deleteInstance, getYaml, save, remote, openSession, modelDirectory, permissions, runCommand, queryPermission, t, }: WorkflowOverlayProps): import("react").JSX.Element | null;
//# sourceMappingURL=WorkflowOverlay.d.ts.map