/**
 * 外部依赖包 CSS module 的空桩（vitest 别名专用，见 `vitest.config.ts`）。
 *
 * 用途：宿主 UI 包（`@deepseek-ai/dsh-client-ui-primitives` 等）以 built lib 被消费时，
 * 其 bundle 里带裸 `.module.css` import，vitest 的 node 外部化加载器解不了 `.css`
 * （`Unknown file extension`）。把这些 import 统一替换成本模块后，`css.anyClass`
 * 返回类名字符串：取值不抛、渲染不炸，行为契约（DOM 锚点/属性/文本）不受影响。
 *
 * 只影响**测试期**；构建（tsc + tsdown）与运行时都按原样处理真正的 CSS module。
 * @module @meiyukichan/dsh-sandore/tests/css-module-stub
 */

/** 类名仓：任意键都返回同名类名（与 CSS module 的取值语义同形）。 */
const classNames = new Proxy<Record<string, string>>({}, {
  get: (target, key: string) => (key === '__esModule' ? undefined : (target[key] ?? key)),
})

export default classNames
