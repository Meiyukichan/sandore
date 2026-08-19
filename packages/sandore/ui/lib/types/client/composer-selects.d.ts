import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { ModelDirectoryFace, PermissionSelectValue } from './model-faces.ts';
/** 渲染模型触发器 + 两级菜单（复用 DSH 的模型目录数据面）。 */
export declare function ModelSelectSandore({ t, directory, locked }: {
    readonly t: TranslateNS<'sandore'>;
    readonly directory: ModelDirectoryFace;
    readonly locked: boolean;
}): import("react").JSX.Element | null;
/** 渲染权限触发器 + 菜单 + 完全访问确认（行为照 DSH PermissionSelect）。 */
export declare function PermissionSelectSandore({ t, value, locked, runCommand, queryValue }: {
    readonly t: TranslateNS<'sandore'>;
    readonly value: PermissionSelectValue | undefined;
    readonly locked: boolean;
    readonly runCommand: (line: string) => Promise<boolean>;
    /** 权限投影缺失时的回退查询（`/permission` 无参报告）。 */
    readonly queryValue: () => Promise<PermissionSelectValue | undefined>;
}): import("react").JSX.Element | null;
//# sourceMappingURL=composer-selects.d.ts.map