import { chromium } from "playwright"
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on("pageerror", e => console.log("[pageerror]", e.message))
await page.goto("http://127.0.0.1:3090/", { waitUntil: "domcontentloaded" })
await page.waitForTimeout(2500)
await page.locator("[data-sandore-btn]").click()
await page.waitForTimeout(600)
const rows = page.locator("[data-sandore-wf-list] ul li")
await rows.nth(0).locator("button").first().click()
await page.waitForTimeout(2000)
const nav = page.locator("[data-sandore-tree-nav]")
const data = await nav.evaluate(root => {
  const out = []
  // workflow / stage / step：所有 disclosure 行
  const dRows = root.querySelectorAll("[data-disclosure-row]")
  dRows.forEach(row => {
    const chevron = row.querySelector("svg")
    const dot = row.querySelector("[data-state]")
    const spans = row.querySelectorAll("span")
    const title = spans[spans.length - 1]
    if (title) out.push({
      level: "row",
      chevron: !!chevron,
      titleLeft: Math.round(title.getBoundingClientRect().left),
      text: (title.textContent ?? "").slice(0, 12),
    })
  })
  root.querySelectorAll("[data-tree-leaf]").forEach(row => {
    const label = row.querySelector("span:nth-child(2)")
    if (label) out.push({ level: "leaf", titleLeft: Math.round(label.getBoundingClientRect().left), text: (label.textContent ?? "").slice(0, 12) })
  })
  return out
})
console.log(JSON.stringify(data, null, 1))
await browser.close()
