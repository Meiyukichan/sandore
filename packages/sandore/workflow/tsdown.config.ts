/**
 * workflow 包构建（多入口）。
 *
 * - `index`：Node 侧宿主入口（`src/index.ts` 打包为 `lib/index.js`）。`remote.ts`
 *   的 `SandoreRemote` 使用 `@Remote` 标准装饰器，tsdown 默认不会降级，故经
 *   `standardDecoratorPlugin`（`ts.transpileModule`，对齐 DSH typertPlugin 的
 *   transform 钩子）降级为 ES2024 的 `__esDecorate` 辅助代码。
 * - `schema`/`yaml`：浏览器安全子路径（`./schema`、`./yaml`），仅依赖 `zod`/`yaml`
 *   （`platform: 'neutral'`，不注入 Node 假设），供 Client 侧 DagEditor 导入定义层
 *   schema 与 `parseWorkflowYaml`/`serializeWorkflowYaml`。
 *
 * `./typert`/`./remote` 子路径的手写生成物（`lib/typert.host.*` 与
 * `lib/typert.remote-client.*`）为静态固化产物，不在本次 tsdown 中重生成
 * （`clean: false` 保留手写文件，不被删除或覆盖）。
 * @module @deepseek-ai/dsh-sandore-workflow/tsdown.config
 */
import { defineConfig } from 'tsdown'
import ts from 'typescript'

/** 匹配行首的类/方法装饰器语法（`@Remote('ping')` 等）。 */
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * 降级标准装饰器为 Node 可运行的 `__esDecorate` 辅助代码（对齐 DSH harness 的
 * `standardDecoratorPlugin` / typertPlugin transform 钩子；不生成任何 typert 产物）。
 */
function standardDecoratorPlugin() {
  return {
    name: 'sandore-standard-decorators',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [standardDecoratorPlugin()],
  },
  {
    entry: {
      schema: 'src/schema.ts',
      yaml: 'src/yaml-parser.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [standardDecoratorPlugin()],
  },
])
