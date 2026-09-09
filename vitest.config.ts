import { resolve } from 'node:path'
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

/**
 * 包自引用别名：client 源码/测试里的 `@meiyukichan/dsh-sandore/*` import 直接映射到本仓库
 * 源码（vitest 的 resolver 不解析 package.json exports 的包名自引用，且测试
 * 应针对源码而非构建产物）。类型子路径（schema/types）运行时被擦除，映射到
 * 源码文件仅作兜底；remote/typert 映射到手写固化 .js 产物。
 */
const SELF_REFERENCE_ALIASES = [
  { find: /^@meiyukichan\/dsh-sandore$/, replacement: resolve('packages/workflow/index.ts') },
  { find: /^@meiyukichan\/dsh-sandore\/types$/, replacement: resolve('packages/workflow/types.ts') },
  { find: /^@meiyukichan\/dsh-sandore\/schema$/, replacement: resolve('packages/workflow/schema.ts') },
  { find: /^@meiyukichan\/dsh-sandore\/yaml$/, replacement: resolve('packages/workflow/yaml-parser.ts') },
  { find: /^@meiyukichan\/dsh-sandore\/yaml-error$/, replacement: resolve('packages/workflow/yaml-error.ts') },
  { find: /^@meiyukichan\/dsh-sandore\/remote$/, replacement: resolve('packages/workflow/typert/typert.remote-client.js') },
  { find: /^@meiyukichan\/dsh-sandore\/typert$/, replacement: resolve('packages/workflow/typert/typert.host.js') },
]

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: SELF_REFERENCE_ALIASES,
  },
  test: {
    include: ['packages/**/*.spec.ts'],
    environment: 'node',
  },
})
