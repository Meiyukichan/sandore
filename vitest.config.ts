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

/**
 * 外部依赖包里的 CSS module 桩：宿主 UI 包（`@deepseek-ai/dsh-client-ui-primitives` 等）
 * 以 **built lib** 被消费，其 `lib/index.js` 里带裸 `.module.css` import，vitest 的
 * node 外部化加载器会以 `Unknown file extension ".css"` 直接失败（本仓源码侧的 .module.css
 * 由 vite 正常处理，不受影响）。这些样式对被测的**行为契约**无意义（类名只影响观感），
 * 故统一映射到一个空代理对象：`css.anyClass` 返回类名字符串，取值不抛、渲染不炸。
 *
 * 为什么不逐个 `vi.mock` 宿主包：mock 需要把包的每个命名导出都手写一遍，加一个图标
 * 就漏一个；按扩展名统一桩掉更稳，也不影响任何被测逻辑。
 */
const EXTERNAL_CSS_STUB = resolve('packages/tests/css-module-stub.ts')

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: [
      ...SELF_REFERENCE_ALIASES,
      { find: /^@deepseek-ai\/.*\.css$/, replacement: EXTERNAL_CSS_STUB },
    ],
  },
  test: {
    include: ['packages/**/*.spec.ts'],
    environment: 'node',
    server: {
      deps: {
        // 宿主 UI 包（`@deepseek-ai/dsh-client-ui-primitives` 等）的 built lib 里带裸
        // `.module.css` import：外部化加载（Node ESM require .css）会直接报
        // `Unknown file extension ".css"`。inline 进 vite 管线后由 vite 自己解析
        // CSS module（与本仓源码侧的 .module.css 同一条路径），无需逐包手写桩。
        inline: [/@deepseek-ai\/dsh-client-ui-.*/],
      },
    },
  },
})
