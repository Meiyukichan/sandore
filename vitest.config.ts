import ts from 'typescript'
import { defineConfig } from 'vitest/config'

/** 匹配行首的类装饰器语法（`@Remote('ping')` 等）。 */
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * 在 Vite/oxc 默认转换前，用 TypeScript 转译标准装饰器为 Node 可运行的
 * `__esDecorate` 辅助代码（对齐 DSH harness 的 `standardDecoratorPlugin`）。
 */
function standardDecoratorPlugin() {
  return {
    name: 'sandore-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
        },
      })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n') }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['packages/**/*.spec.ts'],
    environment: 'node',
  },
})
