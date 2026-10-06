// 真实浏览器端到端冒烟测试：加载页面 → WASM 生成 → 寻路 → 参数变化使路径失效
// 运行：先 build，再 node test/e2e.mjs（由 package.json 的 test:e2e 启动 preview）
import puppeteer from 'puppeteer'
import { homedir } from 'node:os'
import { mkdirSync, existsSync } from 'node:fs'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173'
const SHOTS = new URL('./screenshots/', import.meta.url).pathname
mkdirSync(SHOTS, { recursive: true })

// 环境变量 CHROME_PATH 优先；否则用仓库内无 root 安装的 arm64 Chromium 包装脚本
const CHROME_PATH =
  process.env.CHROME_PATH || `${homedir()}/chromium-root/run-chromium.sh`

const launchOpts = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader'],
  dumpio: false,
}
if (existsSync(CHROME_PATH)) launchOpts.executablePath = CHROME_PATH

const browser = await puppeteer.launch(launchOpts)
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 950 })

const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})

const results = []
function check(name, cond, extra = '') {
  results.push([name, cond, extra])
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : ' — ' + extra}`)
}

async function badgeText() {
  await page.waitForSelector('.badge', { timeout: 15000 })
  return page.$eval('.badge', (el) => el.textContent || '')
}

async function bannerText() {
  await page.waitForSelector('.banner', { timeout: 5000 })
  return page.$eval('.banner', (el) => el.textContent || '')
}

async function waitUntil(fn, { timeout = 20000, label = 'condition' } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function clickButton(text) {
  const handle = await page.evaluateHandle((t) => {
    const it = document.evaluate(
      `//button[contains(., '${t}')]`,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    )
    return it.snapshotItem(0)
  }, text)
  const el = handle.asElement()
  if (!el) throw new Error(`button not found: ${text}`)
  await el.click()
  await new Promise((r) => setTimeout(r, 150))
  return el
}

// ---------- 1. 加载 ----------
await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 })

await page.waitForFunction(
  () => document.querySelector('.badge')?.textContent?.includes('导航网就绪'),
  { timeout: 45000 },
)
const badge = await badgeText()
check('WASM 加载并生成导航网', badge.includes('导航网就绪'), badge)

// 初始桥场景已带起终点，默认 h=1.8 应直接有路径
await waitUntil(async () => (await bannerText()).includes('路径已生成'), { label: '初始路径' })
let banner = await bannerText()
check('桥下净空：h=1.8 默认参数路径可达', banner.includes('路径已生成'), banner.slice(0, 120))

// 图例中应有多个连通区域
const legendRows = await page.$$eval('.legend-row', (els) => els.length)
check('显示连通区域图例', legendRows >= 1, `${legendRows} 个区域`)

await page.screenshot({ path: `${SHOTS}/01-bridge-reachable.png` })

// ---------- 2. 高度增加使旧路径失效 ----------
const agentSliders = () => page.$$('.sidebar.right input[type=range]')
const sliders = await agentSliders()
check('找到 4 个角色参数滑杆', sliders.length === 4, `实际 ${sliders.length}`)
// radius=0 height=1 climb=2 slope=3；高度 1.8 → 2.4（step 0.1，按 6 次）
await sliders[1].focus()
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
await waitUntil(async () => (await bannerText()).includes('不可达'), { label: '高角色不可达' })
banner = await bannerText()
check('身高调到 2.4：桥洞切断，报告分离区域不可达', banner.includes('不可达'), banner.slice(0, 120))
check('不可达横幅包含区域编号说明', /区域\s*\d/.test(banner))
await page.screenshot({ path: `${SHOTS}/02-bridge-too-tall-disconnected.png` })

// 恢复 1.8，路径应恢复
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
await waitUntil(async () => (await bannerText()).includes('路径已生成'), { label: '恢复可达' })
check('身高恢复 1.8：路径重新可达', (await bannerText()).includes('路径已生成'))

// ---------- 3. 俯视模式 + 端点放置（网外吸附） ----------
await clickButton('二维俯视')
await new Promise((r) => setTimeout(r, 500))
// 选“放起点”工具，在视口空白地面位置点击
await clickButton('放起点')
const box = await page.$eval('.viewport', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
// 俯视下屏幕中心附近为场景中部；点击偏右下的空地
await page.mouse.click(box.x + box.w * 0.5 + 120, box.y + box.h * 0.5 + 120)
await clickButton('放终点')
await page.mouse.click(box.x + box.w * 0.5 - 120, box.y + box.h * 0.5 - 120)
await clickButton('选择 / 拖拽')
await new Promise((r) => setTimeout(r, 800))
const banner2 = await bannerText()
check('俯视下点击放置端点后出现判定结果',
  banner2.includes('路径已生成') || banner2.includes('不可达'), banner2.slice(0, 100))
await page.screenshot({ path: `${SHOTS}/03-topdown-editors.png` })
await clickButton('退出俯视 (2D)')

// ---------- 4. 窄门场景：半径增大导致失效 ----------
await clickButton('窄门')
// 等待重新生成并判定（默认参数应可达）
await waitUntil(async () => (await bannerText()).includes('路径已生成'), { timeout: 30000, label: '窄门默认可达' })
check('窄门：r=0.3 / 门槛 0.3 / climb=0.5 可达', (await bannerText()).includes('路径已生成'))
await page.screenshot({ path: `${SHOTS}/04-door-reachable.png` })

// 半径 0.3 → 0.6（6 次 ×0.05）
const sliders2 = await agentSliders()
await sliders2[0].focus()
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
await waitUntil(async () => (await bannerText()).includes('不可达'), { label: '宽角色被门挡住' })
check('窄门：半径调到 0.6 时门太窄、不可达', (await bannerText()).includes('不可达'))
// 恢复半径
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
await waitUntil(async () => (await bannerText()).includes('路径已生成'), { label: '窄门恢复' })

// 台阶 0.5 → 0.2（滑杆 min=0 step=0.05，按 6 次左）
const sliders3 = await agentSliders()
await sliders3[2].focus()
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
await waitUntil(async () => (await bannerText()).includes('不可达'), { label: '台阶不足' })
check('窄门：可爬台阶调到 0.2 时门槛不可越、不可达', (await bannerText()).includes('不可达'))
for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
await waitUntil(async () => (await bannerText()).includes('路径已生成'), { label: '台阶恢复' })

// ---------- 5. 多层平台：默认可达，坡度 10° 失效 ----------
await clickButton('多层平台')
await waitUntil(async () => (await bannerText()).includes('路径已生成'), { timeout: 30000, label: '平台可达' })
const bp = await bannerText()
check('多层平台：沿斜坡爬上 2m 层', bp.includes('路径已生成'), bp.slice(0, 100))
await page.screenshot({ path: `${SHOTS}/05-platforms-path.png` })

// 角色沿路径行走演示
await clickButton('角色沿路径行走')
await new Promise((r) => setTimeout(r, 1200))
const stopBtn = await page.evaluateHandle(() => {
  const it = document.evaluate(
    `//button[contains(., '停止演示')]`,
    document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null,
  )
  return it.snapshotItem(0)
})
check('角色行走演示启动（出现停止按钮）', !!stopBtn.asElement())
await page.screenshot({ path: `${SHOTS}/06-agent-walking.png` })
await clickButton('停止演示')

// 坡度 45 → 10（35 次 ×1°）
const sliders4 = await agentSliders()
await sliders4[3].focus()
for (let i = 0; i < 35; i++) await page.keyboard.press('ArrowLeft')
await waitUntil(async () => (await bannerText()).includes('不可达'), { label: '坡度限制失效' })
check('多层平台：最大坡度调到 10° 时斜坡失效、不可达', (await bannerText()).includes('不可达'))

// ---------- 6. IndexedDB 保存与列表 ----------
await clickButton('保存工程')
await new Promise((r) => setTimeout(r, 600))
const toast = await page.$eval('.toast', (el) => el.textContent).catch(() => '')
check('保存到 IndexedDB 出现提示', toast.includes('已保存'), toast)
const projRows = await page.$$eval('.project-list li', (els) =>
  els.map((e) => e.textContent || '').filter((t) => !t.includes('尚无')),
)
check('工程列表出现已保存条目', projRows.length >= 1, projRows.join(' | '))

// ---------- 7. 导出 JSON 下载 ----------
const client = await page.target().createCDPSession()
await client.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: SHOTS,
  eventsEnabled: true,
})
const downloadDone = new Promise((res) =>
  client.on('Browser.downloadProgress', (e) => e.state === 'completed' && res(e)),
)
await clickButton('导出 JSON')
const dl = await Promise.race([
  downloadDone.then(() => true),
  new Promise((r) => setTimeout(() => r(false), 8000)),
])
check('触发 JSON 导出下载', !!dl)

// ---------- 8. 刷新页面：localStorage 草稿恢复 + 重新构建 ----------
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForFunction(
  () => document.querySelector('.badge')?.textContent?.includes('导航网就绪'),
  { timeout: 45000 },
)
check('刷新后草稿恢复并重新生成导航网', (await badgeText()).includes('导航网就绪'))

check('页面无 JS 错误', errors.length === 0, errors.join('\n'))

await browser.close()

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) process.exit(1)
void existsSync
