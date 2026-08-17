import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { type SaveDefinition } from './sandore-save.ts';
/** DagEditor 接收的最小业务 props：初始定义 + 保存回调 + locale。 */
export interface DagEditorProps {
    /** 类型化翻译函数（sandore 命名空间）。 */
    t: TranslateNS<'sandore'>;
    /** 已有定义的原始 YAML；省略时进入新建（空白骨架）。 */
    initialYaml?: string | undefined;
    /** 已有定义 id；新建时省略（首次保存后由保存回调返回并回填）。 */
    initialId?: string | undefined;
    /** 保存回调：`id` 为 `undefined` 时走 `createDefinition`，否则走 `updateYaml`；返回持久化后的 id。 */
    save: SaveDefinition;
}
/** 渲染 DagEditor。 */
export declare function DagEditor({ t, initialYaml, initialId, save }: DagEditorProps): import("react").JSX.Element;
//# sourceMappingURL=DagEditor.d.ts.map