import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { type SaveDefinition } from './sandore-save.ts';
/** DefinitionDetail 接收的 props。 */
export interface DefinitionDetailProps {
    /** 类型化翻译函数。 */
    t: TranslateNS<'sandore'>;
    /** 已有定义 YAML；省略 = 新建。 */
    initialYaml?: string | undefined;
    /** 已有定义 id；省略 = 新建。 */
    initialId?: string | undefined;
    /** 保存回调（新建 createDefinition / 后续 updateYaml）。 */
    save: SaveDefinition;
    /** 保存成功（携带最新 YAML），供宿主刷新列表与选中态。 */
    onSaved?(yaml: string): void;
    /** 进入编排（切两层 DAG）。 */
    onEnterEdit(): void;
}
/** 渲染定义详情。 */
export declare function DefinitionDetail({ t, initialYaml, initialId, save, onSaved, onEnterEdit }: DefinitionDetailProps): import("react").JSX.Element;
//# sourceMappingURL=DefinitionDetail.d.ts.map