// 打开会话后检查 trajectory 视图 composer 行为
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3080'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

await page.locator('[role="treeitem"]', { hasText: '工作流完成态' }).first().click({ timeout: 5000 })
await page.waitForTimeout(1500)

async function dump(tag) {
  const info = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map(t => ({ text: t.textContent?.trim(), selected: t.getAttribute('aria-selected') }))
    const seat = document.querySelector('[data-composer-seat]')
    const seatRect = seat ? (() => { const r = seat.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })() : null
    const textarea = seat ? seat.querySelector('textarea, [contenteditable]') : null
    const inputVisible = textarea ? (() => { const r = textarea.getBoundingClientRect(); return r.width > 0 && r.height > 0 })() : false
    const overlayAttr = document.querySelector('[data-conversation-composer-overlay]') !== null
    const viewRoot = document.querySelector('[data-conversation-composer-overlay]')
    const viewRect = viewRoot ? (() => { const r = viewRoot.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })() : null
    return { tabs, seatRect, inputVisible, overlayAttr, viewRect }
  })
  console.log(`=== ${tag} ===`)
  console.log(JSON.stringify(info, null, 2))
}

await dump('对话视图')

await page.locator('[role="tab"]', { hasText: '轨迹' }).click({ timeout: 5000 })
await page.waitForTimeout(1500)
await dump('轨迹视图')

browser.close()
