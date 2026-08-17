import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { CommandConfig } from '@deepseek-ai/dsh-sandore-workflow/schema';
import { type CommandType } from './dag-editor-model.ts';
/** 命令类型的本地化标签键。 */
export declare const COMMAND_LABEL_KEYS: {
    readonly shell: "editor.command.shell";
    readonly prompt: "editor.command.prompt";
    readonly agent: "editor.command.agent";
    readonly skill: "editor.command.skill";
    readonly mcp: "editor.command.mcp";
};
/** 渲染命令编辑（类型选择 + 对应 value 字段）。`types` 可限定可选类型（如条件判断仅 bash/prompt）。 */
export declare function CommandEditor({ command, onChange, t, types }: {
    readonly command: CommandConfig;
    readonly onChange: (command: CommandConfig) => void;
    readonly t: TranslateNS<'sandore'>;
    /** 允许选择的命令类型；缺省为全部五类型。 */
    readonly types?: readonly CommandType[] | undefined;
}): import("react").JSX.Element;
//# sourceMappingURL=CommandEditor.d.ts.map