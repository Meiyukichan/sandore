/**
 * 拷贝手写固化 typert 产物到 lib/（发布面）。
 *
 * `packages/workflow/typert/typert.host.*` 与 `typert.remote-client.*` 为手写
 * 静态固化产物（git 跟踪，tsdown 不重新生成）：tsc 只产出 lib/{microflow,workflow,
 * tool,client}，tsdown 的 `clean: false` 不删除 lib 根下手写文件——本脚本在 build
 * 尾部把四个文件拷贝到 lib/，使 `./typert` / `./remote` 子路径（exports 指向 lib）
 * 对消费者可用。
 */
import { copyFileSync, mkdirSync } from 'node:fs'

const TYPERT_FILES = [
  'typert.host.js',
  'typert.host.d.ts',
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
]

mkdirSync('lib', { recursive: true })
for (const name of TYPERT_FILES) {
  copyFileSync(`packages/workflow/typert/${name}`, `lib/${name}`)
}
