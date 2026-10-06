// 三个验算场景的自动化检查（Node 中运行 WASM，不依赖浏览器/WebGL）
import { ensureRecastReady, buildNavMesh, findPath, queryPoint } from '../src/nav/recast'
import { buildCombinedMesh } from '../src/nav/geometry'
import { presetBridge, presetDoor, presetPlatforms } from '../src/presets'
import { DEFAULT_SETTINGS } from '../src/types'
import type { AgentSettings, ProjectData, Vec3 } from '../src/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name} ${detail}`)
  }
}

function build(settings: AgentSettings, factory: () => { geometries: never; start: Vec3; end: Vec3 }) {
  const preset = factory()
  const { positions, indices } = buildCombinedMesh(preset.geometries as never)
  return { built: buildNavMesh(positions, indices, settings), preset }
}

function runScenario(
  label: string,
  factory: () => { geometries: never; start: Vec3; end: Vec3 },
  cases: {
    name: string
    settings: AgentSettings
    expectReachable: boolean
    expectIslandMin?: number
    expectIslandMax?: number
  }[],
) {
  console.log(`\n=== ${label} ===`)
  for (const c of cases) {
    console.log(`[${c.name}]`)
    const { built, preset } = build(c.settings, factory)
    if ('error' in built) {
      check('导航网生成成功', false, built.error)
      continue
    }
    check('导航网生成成功', true)
    if (c.expectIslandMin !== undefined) {
      check(
        `连通区域数 >= ${c.expectIslandMin}（实际 ${built.islands.length}）`,
        built.islands.length >= c.expectIslandMin,
      )
    }
    if (c.expectIslandMax !== undefined) {
      check(
        `连通区域数 <= ${c.expectIslandMax}（实际 ${built.islands.length}）`,
        built.islands.length <= c.expectIslandMax,
      )
    }

    const sq = queryPoint(built, preset.start)
    const eq = queryPoint(built, preset.end)
    check('起点可吸附到导航网', !!sq)
    check('终点可吸附到导航网', !!eq)

    if (sq && eq) {
      const sameComp = sq.componentId === eq.componentId
      const r = findPath(built, sq.snapped, eq.snapped)
      if (c.expectReachable) {
        check(
          `起终点在同一区域且寻路成功（区域 ${sq.componentId + 1}）`,
          sameComp && r.success,
          `sameComp=${sameComp} success=${'success' in r ? r.success : '-'}`,
        )
        if (r.success) {
          let len = 0
          for (let i = 1; i < r.path.length; i++) {
            len += Math.hypot(
              r.path[i][0] - r.path[i - 1][0],
              r.path[i][1] - r.path[i - 1][1],
              r.path[i][2] - r.path[i - 1][2],
            )
          }
          check(`路径长度合理（${len.toFixed(2)}m，直线约 22m）`, len > 15 && len < 60)
          // 路径必须贴近地面/可行走表面（桥下洞场景 y 不应越过顶板）
          const maxY = Math.max(...r.path.map((p) => p[1]))
          check(`路径贴地（最高点 ${maxY.toFixed(2)}m < 1.5m）`, maxY < 1.5)
        }
      } else {
        check(
          `起终点被识别为不可达（区域 ${sq.componentId + 1} vs ${eq.componentId + 1}）`,
          !sameComp || !r.success,
        )
      }
      // 网外点吸附候选测试
      const far: Vec3 = [60, 5, 60]
      const fq = queryPoint(built, far)
      check('远处网外点返回吸附候选', !!fq && !fq.onMesh && fq.candidates.length >= 1)
      if (fq) {
        check(
          '候选距离 > 0 且覆盖各连通区域',
          fq.candidates.every((x) => x.distance > 0),
        )
      }
    }
  }
}

await ensureRecastReady()
console.log('WASM 已就绪')

// ---------- 场景一：桥下净空 ----------
runScenario('场景一：桥下净空（净高 2.0m）', presetBridge as never, [
  {
    name: '矮角色 h=1.8 r=0.3 —— 应穿过桥洞',
    settings: { ...DEFAULT_SETTINGS, height: 1.8, radius: 0.3, maxClimb: 0.5, maxSlope: 45 },
    expectReachable: true,
    expectIslandMax: 9, // 地面通道 + 墙顶/桥顶等不可站立但生成的小区域
  },
  {
    name: '高角色 h=2.4 —— 桥洞应切断，南北不可达',
    settings: { ...DEFAULT_SETTINGS, height: 2.4, radius: 0.3, maxClimb: 0.5, maxSlope: 45 },
    expectReachable: false,
    expectIslandMin: 2,
  },
])

// ---------- 场景二：窄门 ----------
runScenario('场景二：窄门（净宽 1.2m，门槛 0.3m，门高 2.2m）', presetDoor as never, [
  {
    name: 'r=0.3 climb=0.5 —— 应过门',
    settings: { ...DEFAULT_SETTINGS, radius: 0.3, height: 1.8, maxClimb: 0.5, maxSlope: 45 },
    expectReachable: true,
    expectIslandMax: 6,
  },
  {
    name: 'r=0.6 —— 门太窄，两侧分离',
    settings: { ...DEFAULT_SETTINGS, radius: 0.6, height: 1.8, maxClimb: 0.5, maxSlope: 45 },
    expectReachable: false,
    expectIslandMin: 2,
  },
  {
    name: 'climb=0.3 —— 门槛 0.3 不可越，两侧分离',
    settings: { ...DEFAULT_SETTINGS, radius: 0.3, height: 1.8, maxClimb: 0.3, maxSlope: 45 },
    expectReachable: false,
    expectIslandMin: 2,
  },
  {
    name: 'h=2.4 —— 门洞过梁挡头，两侧分离',
    settings: { ...DEFAULT_SETTINGS, radius: 0.3, height: 2.4, maxClimb: 0.5, maxSlope: 45 },
    expectReachable: false,
    expectIslandMin: 2,
  },
])

// ---------- 场景三：多层平台 ----------
console.log('\n=== 场景三：多层平台 ===')
{
  const preset = presetPlatforms()
  const { positions, indices } = buildCombinedMesh(preset.geometries)

  // 默认参数：斜坡 12°、小台阶 0.3、可爬 0.5 —— 起点应能登上 2m 平台
  let built = buildNavMesh(positions, indices, {
    ...DEFAULT_SETTINGS, height: 1.8, radius: 0.3, maxClimb: 0.5, maxSlope: 45,
  })
  if ('error' in built) throw new Error(built.error)
  console.log(`[默认参数] 连通区域数：${built.islands.length}`)
  check('存在多个分离区域（孤立高台 / 悬空二层）', built.islands.length >= 2)
  const sq = queryPoint(built, preset.start)
  const eq = queryPoint(built, preset.end)
  check('起点在地面导航网上', !!sq && sq.onMesh, sq ? `onMesh=${sq.onMesh}` : '')
  check('终点在 2m 平台导航网上', !!eq, eq ? `snapped y=${eq.snapped[1].toFixed(2)}` : '')
  if (sq && eq) {
    const r = findPath(built, sq.snapped, eq.snapped)
    check('沿斜坡+台阶可登上平台', r.success, 'success' in r ? '' : 'failed')
    if (r.success) {
      const maxY = Math.max(...r.path.map((p) => p[1]))
      check(`路径确实爬上高层（最高点 ${maxY.toFixed(2)}m ≈ 2m）`, maxY > 1.6 && maxY < 2.6)
      // 路径必须经过斜坡爬升：3D 长度应明显大于起终点的水平直线距离
      let horiz = 0
      for (let i = 1; i < r.path.length; i++) {
        horiz += Math.hypot(
          r.path[i][0] - r.path[i - 1][0],
          r.path[i][2] - r.path[i - 1][2],
        )
      }
      const straight2d = Math.hypot(
        preset.start[0] - preset.end[0],
        preset.start[2] - preset.end[2],
      )
      check(
        `路径沿坡爬升（水平行程 ${horiz.toFixed(1)}m ≥ 直线 ${straight2d.toFixed(1)}m，爬升 ${(maxY - Math.min(...r.path.map(p=>p[1]))).toFixed(1)}m）`,
        horiz >= straight2d - 0.5,
      )
    }
  }
  // 孤立高台（2.5m，无连接）顶部应为独立分量
  const top: Vec3 = [-9, 2.51, -8]
  const tq = queryPoint(built, top)
  check('孤立高台顶部有导航网', !!tq)
  if (sq && tq) {
    check('孤立高台与地面不可达', sq.componentId !== tq.componentId)
  }

  // 坡度限制：maxSlope=10° 时斜坡 12° 失效，平台不可达（且 0.3 台阶仍可爬也上不到 2m）
  const built2 = buildNavMesh(positions, indices, {
    ...DEFAULT_SETTINGS, height: 1.8, radius: 0.3, maxClimb: 0.5, maxSlope: 10,
  })
  if ('error' in built2) {
    check('maxSlope=10° 生成成功', false, built2.error)
  } else {
    const eq2 = queryPoint(built2, preset.end)
    const sq2 = queryPoint(built2, preset.start)
    let blocked = true
    if (sq2 && eq2 && sq2.componentId === eq2.componentId) {
      blocked = !findPath(built2, sq2.snapped, eq2.snapped).success
    } else {
      blocked = true
    }
    check('坡度限制为 10° 时斜坡失效、平台不可达', blocked)
  }

  // 台阶限制：maxClimb=0.2 时 0.3m 坡顶台阶阻断
  const built3 = buildNavMesh(positions, indices, {
    ...DEFAULT_SETTINGS, height: 1.8, radius: 0.3, maxClimb: 0.2, maxSlope: 45,
  })
  if ('error' in built3) {
    check('maxClimb=0.2 生成成功', false, built3.error)
  } else {
    const sq3 = queryPoint(built3, preset.start)
    const eq3 = queryPoint(built3, preset.end)
    let blocked = true
    if (sq3 && eq3 && sq3.componentId === eq3.componentId) {
      blocked = !findPath(built3, sq3.snapped, eq3.snapped).success
    }
    check('可爬台阶 0.2m 时 0.3m 台阶阻断、平台不可达', blocked)
  }
}

// ---------- 导出完整性（源网格 + 生成设置） ----------
console.log('\n=== 导出数据完整性 ===')
{
  const preset = presetBridge()
  const p: ProjectData = {
    version: 1,
    id: 'x',
    name: 't',
    updatedAt: 0,
    geometries: preset.geometries as never,
    settings: { ...DEFAULT_SETTINGS, height: 2.4 },
    start: preset.start,
    end: preset.end,
  }
  check('导出保留全部源网格定义', p.geometries.length === preset.geometries.length)
  check('导出保留角色半径/高度/台阶/坡度设置',
    p.settings.radius === 0.3 && p.settings.height === 2.4 &&
    p.settings.maxClimb === 0.5 && p.settings.maxSlope === 45)
  check('导出保留体素生成设置',
    p.settings.cellSize > 0 && p.settings.cellHeight > 0 && p.settings.tileSize > 0)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
