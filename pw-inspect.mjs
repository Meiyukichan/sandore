// Playwright 检查 sandore 工作流 UI：面板内容 + 列表项 + 点击行为
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('GOTO_ERR', e.message))
await page.waitForTimeout(3000)

const btn = await page.waitForSelector('[data-sandore-btn]', { timeout: 15000 }).catch(() => null)
if (!btn) { console.log('NO_BUTTON'); await browser.close(); process.exit(0) }
await btn.click()
await page.waitForTimeout(1500)

const panel = await page.waitForSelector('[data-sandore-panel]', { timeout: 5000 }).catch(() => null)
if (!panel) { console.log('NO_PANEL'); await browser.close(); process.exit(0) }

// 面板文本
const panelText = await page.evaluate(() => document.querySelector('[data-sandore-panel]').innerText.slice(0, 1000))
console.log('PANEL_TEXT:', JSON.stringify(panelText))

// 面板内所有按钮文本（列表项）
const btns = await page.evaluate(() =>
  [...document.querySelectorAll('[data-sandore-panel] button')].map(b => b.innerText.slice(0, 60)))
console.log('PANEL_BUTTONS:', JSON.stringify(btns))

// 面板几何
const rect = await page.evaluate(() => {
  const r = document.querySelector('[data-sandore-panel]').getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
})
console.log('PANEL_RECT:', JSON.stringify(rect))

await page.screenshot({ path: 'dsh-sandore-panel2.png' })

// 点击第一个列表项（如果有），看右边是否变化
const firstRow = await page.$('[data-sandore-panel] button[class]')
if (firstRow) {
  const before = await page.evaluate(() => document.body.innerText.length)
  await firstRow.click()
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => document.body.innerText.length)
  console.log('CLICK_ROW: before=' + before + ' after=' + after)
  await page.screenshot({ path: 'dsh-sandore-after-click.png' })
}
await browser.close()
