import { chromium } from "playwright"
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on("pageerror", e => console.log("[pageerror]", e.message))
await page.goto("http://127.0.0.1:3090/", { waitUntil: "domcontentloaded" })
await page.waitForTimeout(2500)
await page.locator("[data-sandore-btn]").click()
await page.waitForTimeout(600)
const rows = page.locator("[data-sandore-wf-list] ul li")
const c = await rows.count()
if (c > 0) {
  await rows.nth(0).locator("button").first().click()
  await page.waitForTimeout(2500)
  const nav = page.locator("[data-sandore-tree-nav]")
  if (await nav.count() > 0) {
    // 检查每一行的标题是否完整显示（scrollWidth vs clientWidth）
    const labels = nav.locator("[data-member-label], [data-disclosure-row] span")
    const truncated = []
    const count = await labels.count()
    for (let i = 0; i < count; i++) {
      const el = labels.nth(i)
      const r = await el.evaluate(e => {
        const text = (e.textContent ?? "").trim()
        if (!text || text.length < 3) return null
        const isClipped = e.scrollWidth > e.clientWidth + 1
        return isClipped ? text : null
      })
      if (r) truncated.push(r)
    }
    console.log("truncated labels:", JSON.stringify(truncated))
    const navText = (await nav.textContent()) ?? ""
    console.log("write file visible:", navText.includes("write file"))
  }
}
await browser.close()
