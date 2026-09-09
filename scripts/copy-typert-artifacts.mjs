/**
 * 拷贝手写固化 typert 产物到 lib/（发布面 + client 产物相对引用面）。
 *
 * `packages/workflow/typert/typert.host.*` 与 `typert.remote-client.*` 为手写
 * 静态固化产物（git 跟踪，tsdown 不重新生成）：tsc 只产出 lib/{microflow,workflow,
 * tool,client}，tsdown 的 `clean: false` 不删除 lib 根下手写文件——本脚本在 build
 * 开头把四个文件拷贝到两处：
 * - `lib/`（根）：`./typert` / `./remote` exports 子路径指向这里（消费者入口）；
 * - `lib/workflow/typert/`：client tsc 产物（`lib/client/remote.js` 的相对引用
 *   `../workflow/typert/typert.remote-client.js`）在 tsdown 打包时解析到这里，
 *   保证 remote 运行时被内联进 client bundle（而非 unresolved external）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'

const TYPERT_FILES = [
  'typert.host.js',
  'typert.host.d.ts',
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
]

const TARGETS = ['lib', 'lib/workflow/typert']

// tsc 的 tsbuildinfo 落在仓库根（tsconfig.tsbuildinfo / tsconfig.client.tsbuildinfo），
// 不在 lib/ 里：手动清 lib/（如 `Remove-Item lib`）会造成「tsbuildinfo 说已构建、
// 磁盘无产物」的漂移（tsc -b 静默跳过 emit）。检测到 host 主产物缺失时一并清除
// tsbuildinfo，强制 tsc 全量重建；正常增量场景不干预。
if (!existsSync('lib/workflow/index.js')) {
  rmSync('tsconfig.tsbuildinfo', { force: true })
  rmSync('tsconfig.client.tsbuildinfo', { force: true })
}

for (const target of TARGETS) {
  mkdirSync(target, { recursive: true })
  for (const name of TYPERT_FILES) {
    copyFileSync(`packages/workflow/typert/${name}`, `${target}/${name}`)
  }
}
