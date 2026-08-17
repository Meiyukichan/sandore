/**
 * workflow 包构建（多入口）。
 *
 * - `index`：Node 侧宿主入口（`src/index.ts` 打包为 `lib/index.js`），同时由
 *   typert generator 从 `SandoreRemote` 的 `@Remote` 装饰器生成
 *   `lib/typert.host.js/.d.ts` 与 `lib/typert.remote-client.js/.d.ts`。
 * - `schema`/`yaml`：浏览器安全子路径（`./schema`、`./yaml`），仅依赖 `zod`/`yaml`
 *   （`platform: 'neutral'`，不注入 Node 假设），供 Client 侧 DagEditor 导入定义层
 *   schema 与 `parseWorkflowYaml`/`serializeWorkflowYaml`。
 * @module @deepseek-ai/dsh-sandore-workflow/tsdown.config
 */
import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

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
    plugins: [typertPlugin({ faces: ['host'] })],
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
  },
])
