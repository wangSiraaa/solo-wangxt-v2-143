import {
  Detour,
  type DetourMeshTile,
  type DetourPoly,
  NavMesh,
  NavMeshQuery,
  init as initRecast,
} from 'recast-navigation'
import { generateTiledNavMesh } from 'recast-navigation/generators'
import type { AgentSettings, NavIsland, SnapCandidate, Vec3 } from '../types'

let initPromise: Promise<void> | null = null
export function ensureRecastReady(): Promise<void> {
  if (!initPromise) initPromise = initRecast()
  return initPromise
}

export type BuiltNavMesh = {
  navMesh: NavMesh
  query: NavMeshQuery
  /** 所有多边形引用（跨 tile） */
  polyRefs: number[]
  /** polyRef -> 连通分量 id */
  componentByPoly: Map<number, number>
  islands: NavIsland[]
  /** 用于渲染的三角化几何（顶点/索引，逐三角形展开） */
  renderPositions: Float32Array
  renderColors: Float32Array
  renderIndices: Uint32Array
  /** 每个三角形所属分量（与 renderIndices 三角形对应） */
  triangleComponent: Uint16Array
  tileCount: number
}

function v3(x: number, y: number, z: number): Vec3 {
  return [x, y, z]
}

function toObj(p: Vec3): { x: number; y: number; z: number } {
  return { x: p[0], y: p[1], z: p[2] }
}

/**
 * 由源几何生成 tiled 导航网，并计算连通分量。
 * 连通分量直接沿 Detour 的 link（多边形邻接图）BFS 得到 ——
 * 这是导航网自身的拓扑，而不是在表面上画直线。
 */
export function buildNavMesh(
  positions: Float32Array,
  indices: Uint32Array,
  settings: AgentSettings,
): BuiltNavMesh | { error: string } {
  if (positions.length === 0) return { error: '场景中没有可见几何' }

  // walkableHeight / walkableClimb 在 Recast 中以体素为单位，生成器会换算
  const result = generateTiledNavMesh(positions, indices, {
    cs: settings.cellSize,
    ch: settings.cellHeight,
    tileSize: settings.tileSize,
    walkableSlopeAngle: settings.maxSlope,
    walkableHeight: Math.max(2, Math.round(settings.height / settings.cellHeight)),
    walkableClimb: Math.max(0, Math.round(settings.maxClimb / settings.cellHeight)),
    walkableRadius: Math.max(0, Math.round(settings.radius / settings.cellSize)),
    minRegionArea: settings.minRegionArea,
    mergeRegionArea: settings.minRegionArea,
  })

  if (!result.success || !result.navMesh) {
    return { error: result.error || '导航网生成失败（参数可能过于严格）' }
  }

  const navMesh = result.navMesh

  // ---- 收集所有 tile 与 poly，沿 link 图 BFS 得到连通分量 ----
  const polyRefs: number[] = []
  const maxTiles = navMesh.getMaxTiles()
  let tileCount = 0
  for (let ti = 0; ti < maxTiles; ti++) {
    const tile = navMesh.getTile(ti)
    const header = tile.header()
    if (!header) continue
    tileCount++
    const polyCount = header.polyCount()
    const base = navMesh.getPolyRefBase(tile)
    for (let pi = 0; pi < polyCount; pi++) {
      const poly = tile.polys(pi)
      if (poly.getType() === 1) continue // 跳过 off-mesh connection
      polyRefs.push(base | pi)
    }
  }

  const componentByPoly = floodFillComponents(navMesh, polyRefs)

  // ---- 提取 detail mesh 三角几何，按分量着色 ----
  const comps = [...new Set(componentByPoly.values())].sort((a, b) => a - b)
  const compIndexMap = new Map<number, number>()
  comps.forEach((c, i) => compIndexMap.set(c, i))

  const islandAccum = new Map<
    number,
    { polyCount: number; representative: Vec3; tris: number; area: number }
  >()

  const renderPositions: number[] = []
  const renderColors: number[] = []
  const renderIndices: number[] = []
  const triCompList: number[] = []
  let outVertexBase = 0

  const ISLAND_PALETTE = [
    [0.22, 0.74, 0.97],
    [0.98, 0.57, 0.24],
    [0.29, 0.87, 0.5],
    [0.96, 0.45, 0.71],
    [0.65, 0.55, 0.98],
    [0.98, 0.8, 0.08],
    [0.18, 0.83, 0.75],
    [0.97, 0.44, 0.44],
  ]

  for (let ti = 0; ti < maxTiles; ti++) {
    const tile = navMesh.getTile(ti)
    const header = tile.header()
    if (!header) continue
    const polyCount = header.polyCount()
    const base = navMesh.getPolyRefBase(tile)
    for (let pi = 0; pi < polyCount; pi++) {
      const poly = tile.polys(pi)
      if (poly.getType() === 1) continue
      const ref = base | pi
      const rawComp = componentByPoly.get(ref) ?? 0
      const comp = compIndexMap.get(rawComp) ?? 0
      const color = ISLAND_PALETTE[comp % ISLAND_PALETTE.length]

      const detail = tile.detailMeshes(pi)
      const vertCount = poly.vertCount()
      let acc = islandAccum.get(comp)
      if (!acc) {
        acc = { polyCount: 0, representative: [0, 0, 0], tris: 0, area: 0 }
        islandAccum.set(comp, acc)
      }
      acc.polyCount++
      acc.representative = polyCentroid(tile, poly)

      for (let dti = 0; dti < detail.triCount(); dti++) {
        const detailTrisBase = (detail.triBase() + dti) * 4
        const triVerts: Vec3[] = []
        for (let k = 0; k < 3; k++) {
          const dv = tile.detailTris(detailTrisBase + k)
          let x: number, y: number, z: number
          if (dv < vertCount) {
            const vi = poly.verts(dv) * 3
            x = tile.verts(vi)
            y = tile.verts(vi + 1)
            z = tile.verts(vi + 2)
          } else {
            const vi = (detail.vertBase() + dv - vertCount) * 3
            x = tile.detailVerts(vi)
            y = tile.detailVerts(vi + 1)
            z = tile.detailVerts(vi + 2)
          }
          triVerts.push(v3(x, y, z))
        }
        const [a, b, c] = triVerts
        renderPositions.push(...a, ...b, ...c)
        renderColors.push(...color, ...color, ...color)
        renderIndices.push(
          outVertexBase,
          outVertexBase + 1,
          outVertexBase + 2,
        )
        triCompList.push(comp)
        acc.area += triArea(a, b, c)
        acc.tris++
        outVertexBase += 3
      }
    }
  }

  const islands: NavIsland[] = []
  for (const [comp, acc] of islandAccum) {
    islands.push({
      componentId: comp,
      polyRefs: polyRefs.filter((r) => (compIndexMap.get(componentByPoly.get(r) ?? -1) ?? -1) === comp),
      representative: acc.representative,
      vertexCount: acc.polyCount,
      triangleCount: acc.tris,
      area: acc.area,
    })
  }
  // 用面积从大到小排序更直观，但 componentId 保持 BFS 编号
  islands.sort((a, b) => b.area - a.area)

  const query = new NavMeshQuery(navMesh)
  query.defaultQueryHalfExtents = {
    x: settings.radius * 2 + 0.5,
    y: settings.height,
    z: settings.radius * 2 + 0.5,
  }

  return {
    navMesh,
    query,
    polyRefs,
    componentByPoly: new Map(
      [...componentByPoly.entries()].map(([r, c]) => [r, compIndexMap.get(c) ?? c]),
    ),
    islands,
    renderPositions: new Float32Array(renderPositions),
    renderColors: new Float32Array(renderColors),
    renderIndices: new Uint32Array(renderIndices),
    triangleComponent: new Uint16Array(triCompList),
    tileCount,
  }
}

function polyCentroid(tile: DetourMeshTile, poly: DetourPoly): Vec3 {
  let x = 0,
    y = 0,
    z = 0
  const n = poly.vertCount()
  for (let i = 0; i < n; i++) {
    const vi = poly.verts(i) * 3
    x += tile.verts(vi)
    y += tile.verts(vi + 1)
    z += tile.verts(vi + 2)
  }
  return [x / n, y / n, z / n]
}

function triArea(a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b[0] - a[0],
    aby = b[1] - a[1],
    abz = b[2] - a[2]
  const acx = c[0] - a[0],
    acy = c[1] - a[1],
    acz = c[2] - a[2]
  const cx = aby * acz - abz * acy
  const cy = abz * acx - abx * acz
  const cz = abx * acy - aby * acx
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2
}

/**
 * 沿 Detour 邻接 link 做 BFS。link.ref === 0 表示无邻接；
 * EXT_LINK 表示跨 tile 连接，同样被正确遍历。
 */
function floodFillComponents(navMesh: NavMesh, polyRefs: number[]): Map<number, number> {
  const componentByPoly = new Map<number, number>()
  let componentId = 0

  for (const startRef of polyRefs) {
    if (componentByPoly.has(startRef)) continue
    const queue = [startRef]
    componentByPoly.set(startRef, componentId)
    while (queue.length) {
      const ref = queue.pop()!
      const { poly, tile } = navMesh.getTileAndPolyByRefUnsafe(ref)
      let link = poly.firstLink()
      while (link !== Detour.DT_NULL_LINK) {
        const l = tile.links(link)
        const neighbor = l.ref()
        if (neighbor !== 0 && !componentByPoly.has(neighbor)) {
          // 确认邻居多边形仍然有效（tile 未被移除等）
          if (navMesh.isValidPolyRef(neighbor)) {
            componentByPoly.set(neighbor, componentId)
            queue.push(neighbor)
          }
        }
        link = l.next()
      }
    }
    componentId++
  }
  return componentByPoly
}

// ---------------- 查询 ----------------

export type PointQueryResult = {
  onMesh: boolean
  polyRef: number
  snapped: Vec3
  /** 所有连通分量上的最近候选（按距离升序） */
  candidates: SnapCandidate[]
  componentId: number
}

/**
 * 查询一个点：是否落在导航网上；若在网外，给出每个连通分量上的吸附候选与距离。
 * 候选通过一次包围盒查询拿到所有多边形，再按连通分量分组取最近点。
 */
export function queryPoint(built: BuiltNavMesh, point: Vec3): PointQueryResult | null {
  const { query, islands, componentByPoly } = built

  // 覆盖整个关卡的包围盒查询，拿到所有多边形
  const all = query.queryPolygons(
    toObj(point),
    { x: 1000, y: 1000, z: 1000 },
    { maxPolys: 100000 },
  )

  // 分量 -> 最近点
  const bestByComp = new Map<number, { dist: number; p: Vec3; ref: number }>()
  if (all.success) {
    for (const ref of all.polyRefs) {
      const comp = componentByPoly.get(ref)
      if (comp === undefined) continue
      const r = query.closestPointOnPoly(ref, toObj(point))
      if (!r.success) continue
      const p = r.closestPoint
      const d = Math.hypot(p.x - point[0], p.y - point[1], p.z - point[2])
      const prev = bestByComp.get(comp)
      if (!prev || d < prev.dist) {
        bestByComp.set(comp, { dist: d, p: [p.x, p.y, p.z], ref })
      }
    }
  }

  const candidates: SnapCandidate[] = []
  for (const island of islands) {
    const best = bestByComp.get(island.componentId)
    if (best) {
      candidates.push({
        componentId: island.componentId,
        point: best.p,
        distance: best.dist,
      })
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)

  // 判断点是否真正位于某个多边形上方（isOverPoly），以及所属分量
  const nearest = query.findNearestPoly(toObj(point), {
    halfExtents: { x: 100, y: 50, z: 100 },
  })

  if (!nearest.success || nearest.nearestRef === 0) {
    return candidates.length
      ? {
          onMesh: false,
          polyRef: 0,
          snapped: candidates[0].point,
          candidates,
          componentId: candidates[0].componentId,
        }
      : null
  }

  const componentId = componentByPoly.get(nearest.nearestRef) ?? -1
  return {
    onMesh: nearest.isOverPoly,
    polyRef: nearest.nearestRef,
    snapped: [nearest.nearestPoint.x, nearest.nearestPoint.y, nearest.nearestPoint.z],
    candidates,
    componentId,
  }
}

export type PathResult =
  | { success: true; path: Vec3[] }
  | { success: false; reason: 'disconnected' | 'failed' }

/**
 * 在两个多边形之间寻路。Detour 若找不到完整多边形走廊会返回失败 ——
 * 分离区域因此被明确识别为不可达，而不是画出穿过缺口的直线。
 */
export function findPath(
  built: BuiltNavMesh,
  start: Vec3,
  end: Vec3,
): PathResult {
  const { query } = built

  const startPoly = query.findNearestPoly(toObj(start), {
    halfExtents: { x: 100, y: 50, z: 100 },
  })
  const endPoly = query.findNearestPoly(toObj(end), {
    halfExtents: { x: 100, y: 50, z: 100 },
  })

  if (!startPoly.success || !endPoly.success || startPoly.nearestRef === 0 || endPoly.nearestRef === 0) {
    return { success: false, reason: 'failed' }
  }

  const startComp = built.componentByPoly.get(startPoly.nearestRef)
  const endComp = built.componentByPoly.get(endPoly.nearestRef)
  if (startComp !== endComp) {
    return { success: false, reason: 'disconnected' }
  }

  // computePath 内部执行 findPath + findStraightPath（沿多边形走廊拉线），
  // 而非在几何表面画直线
  const r = query.computePath(
    startPoly.nearestPoint,
    endPoly.nearestPoint,
    { maxPathPolys: 4096, maxStraightPathPoints: 1024 },
  )

  if (!r.success || r.path.length === 0) {
    return { success: false, reason: r.success ? 'failed' : 'failed' }
  }

  const path: Vec3[] = r.path.map((p) => [p.x, p.y, p.z])
  return { success: true, path }
}

export function disposeNavMesh(built: BuiltNavMesh | null): void {
  if (!built) return
  try {
    built.query.destroy()
  } catch {
    // ignore
  }
}
