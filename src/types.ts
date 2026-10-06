// 共享类型定义

export type Vec3 = [number, number, number]

/** 轴对齐盒体（源几何） */
export type BoxDef = {
  id: string
  kind: 'box'
  name: string
  position: Vec3 // 中心
  size: Vec3
  color: string
  visible: boolean
}

/** 斜坡（三角棱柱，沿 z 方向抬升） */
export type RampDef = {
  id: string
  kind: 'ramp'
  name: string
  position: Vec3 // 低端边缘中点（底边）
  length: number // 沿 z 方向的水平投影长度
  width: number
  height: number // 高端相对低端的高差
  flip: boolean // true 时向 -z 方向抬升
  color: string
  visible: boolean
}

export type GeometryDef = BoxDef | RampDef

/** Recast 生成设置（角色代理参数 + 体素参数） */
export type AgentSettings = {
  radius: number
  height: number
  maxClimb: number
  maxSlope: number
  // 高级 / 生成参数
  cellSize: number
  cellHeight: number
  tileSize: number
  minRegionArea: number
}

export type EndpointType = 'start' | 'end'

export type ProjectData = {
  version: 1
  id: string
  name: string
  updatedAt: number
  geometries: GeometryDef[]
  settings: AgentSettings
  start: Vec3 | null
  end: Vec3 | null
}

/** 导航网连通分量信息 */
export type NavIsland = {
  componentId: number
  polyRefs: number[]
  /** 分量上的代表点（用于标记） */
  representative: Vec3
  vertexCount: number
  triangleCount: number
  area: number
}

export type SnapCandidate = {
  componentId: number
  point: Vec3
  distance: number
}

export type QueryOutcome =
  | { kind: 'idle' }
  | {
      kind: 'ok'
      path: Vec3[]
      startOnMesh: boolean
      endOnMesh: boolean
      startSnaps: SnapCandidate[]
      endSnaps: SnapCandidate[]
      startComp: number
      endComp: number
    }
  | {
      kind: 'disconnected'
      startComp: number
      endComp: number
      startOnMesh: boolean
      endOnMesh: boolean
      startSnaps: SnapCandidate[]
      endSnaps: SnapCandidate[]
    }
  | {
      kind: 'no-navmesh'
    }

export const DEFAULT_SETTINGS: AgentSettings = {
  radius: 0.3,
  height: 1.8,
  maxClimb: 0.5,
  maxSlope: 45,
  cellSize: 0.2,
  cellHeight: 0.2,
  tileSize: 64,
  minRegionArea: 1,
}

export const ISLAND_COLORS = [
  '#38bdf8', // 天蓝
  '#fb923c', // 橙
  '#4ade80', // 绿
  '#f472b6', // 粉
  '#a78bfa', // 紫
  '#facc15', // 黄
  '#2dd4bf', // 青
  '#f87171', // 红
]

export function islandColor(componentId: number): string {
  return ISLAND_COLORS[componentId % ISLAND_COLORS.length]
}
