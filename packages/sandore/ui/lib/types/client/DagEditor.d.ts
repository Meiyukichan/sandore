import '@xyflow/react/dist/style.css';
import './reactflow-theme.css';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { DagRun, JobEntry } from '@deepseek-ai/dsh-sandore-workflow/remote';
import { type SaveDefinition } from './sandore-save.ts';
/** DagEditor 接收的最小业务 props：初始定义 + 保存回调 + locale。 */
export interface DagEditorProps {
    /** 类型化的翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 已有定义的原始 YAML；省略时进入新建（空白骨架）。 */
    initialYaml?: string | undefined;
    /** 已有定义 id；新建时省略（首次保存后由保存回调返回并回填）。 */
    initialId?: string | undefined;
    /** 保存回调：`id` 为 `undefined` 时走 `createDefinition`，否则走 `updateYaml`；返回持久化后的 id。 */
    save: SaveDefinition;
    /** 保存成功回调（携带持久化后的 id），供宿主刷新定义列表等。 */
    onSaved?: (id: string) => void;
    /** 按 workflowId 过滤拉取 Job 列表（「▶ 测试运行」用）。 */
    listJobs(workflowId?: string): Promise<JobEntry[]>;
    /** 创建 Job（「▶ 测试运行」无 Job 时用）。 */
    createJob(input: {
        name: string;
        workflowId: string;
        cwd?: string;
    }): Promise<JobEntry>;
    /** 启动实例（「▶ 测试运行」用）。 */
    startInstance(input: {
        jobId: string;
        originalInput: string;
        cwd?: string;
    }): Promise<DagRun>;
}
/** 渲染 DagEditor（两层 DAG 画布 + 编辑侧栏 + YAML 预览）。 */
export declare function DagEditor({ t, initialYaml, initialId, save, onSaved, listJobs, createJob, startInstance }: DagEditorProps): import("react").JSX.Element;
//# sourceMappingURL=DagEditor.d.ts.map