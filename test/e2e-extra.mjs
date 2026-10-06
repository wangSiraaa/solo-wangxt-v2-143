// 补充：网外点吸附候选的 3D 标签 + 导入 JSON 往返
import puppeteer from 'puppeteer'
import { homedir } from 'node:os'
import { writeFileSync } from 'node:fs'

const browser = await puppeteer.launch({
  headless: true,
  executablePath: `${homedir()}/chromium-root/run-chromium.sh`,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 950 })

const results = []
const check = (n, c, e = '') => { results.push(c); console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : ' — ' + e}`) }

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle0' })
await page.waitForFunction(() => document.querySelector('.badge')?.textContent?.includes('导航网就绪'), { timeout: 45000 })

// 俯视模式下，在视口右上角远离场景中心的空地点击放置一个点（地面边界外或平台孤立区附近）
const clickBtn = async (t) => page.evaluate((t) => {
  const it = document.evaluate(`//button[contains(., '${t}')]`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
  it.snapshotItem(0).click()
}, t)

await clickBtn('多层平台')
await new Promise(r => setTimeout(r, 1500))
await clickBtn('二维俯视')
await new Promise(r => setTimeout(r, 500))
await clickBtn('放起点')

// 在地面范围（±17）之外放置起点：投影世界点 (20,1,20)，必然在网外
await clickBtn('放起点')
const far = await page.evaluate(() => (window).__navScene.worldToScreen([20, 1, 20]))
await page.mouse.click(far.x, far.y)
await clickBtn('选择 / 拖拽')
await new Promise(r => setTimeout(r, 800))

// 终点保留预设的（在平台上），起点放在远处 —— 若起点落在地面外或另一个区域，
// 横幅应出现吸附候选 chip 或不可达说明
const banner = await page.$eval('.banner', el => el.textContent || '')
const hasSnap = banner.includes('吸附候选') || banner.includes('区域')
check('放置点后横幅给出区域/吸附信息', hasSnap, banner.slice(0, 150))

// 起点保留预设的（在平台上），把终点放到孤立高台（世界坐标约 (-9,2.5,-8)）。
// 通过暴露的 __navScene.worldToScreen 精确投影。
await clickBtn('放终点')
const sp = await page.evaluate(() => (window).__navScene.worldToScreen([-9, 2.6, -8]))
await page.mouse.click(sp.x, sp.y)
await clickBtn('选择 / 拖拽')
await new Promise(r => setTimeout(r, 800))
const banner2 = await page.$eval('.banner', el => el.textContent || '')
check('起点/终点在不同区域时给出不可达或吸附说明',
  banner2.includes('不可达') || banner2.includes('吸附'), banner2.slice(0, 150))

await page.screenshot({ path: new URL('./screenshots/07-snap-candidates.png', import.meta.url).pathname })

// 导入往返：通过文件输入直接注入导出的 JSON
const exported = await page.evaluate(async () => {
  // localStorage 草稿即可作为导入源的等价物；这里直接读当前 project 并经 file input 写回
  return localStorage.getItem('navmesh-studio-autosave')
})
check('localStorage 存在自动保存草稿', !!exported)

const fileInput = await page.$('input[type=file]')
if (fileInput && exported) {
  const path = '/tmp/roundtrip.navmesh.json'
  writeFileSync(path, JSON.stringify({ project: JSON.parse(exported) }))
  await fileInput.uploadFile(path)
  await new Promise(r => setTimeout(r, 1500))
  const badge = await page.$eval('.badge', el => el.textContent || '')
  check('导入 JSON 后重新生成导航网', badge.includes('导航网就绪'), badge)
}

await browser.close()
if (results.some(r => !r)) process.exit(1)
console.log('补充测试完成')
