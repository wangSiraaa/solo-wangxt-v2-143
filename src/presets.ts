import type { GeometryDef, ProjectData, Vec3 } from './types'
import { DEFAULT_SETTINGS } from './types'
import { uid } from './nav/geometry'

/**
 * 三个验算场景：
 * 1. 桥下净空   —— 角色高度决定能否从桥下通过，过高时桥两侧成为分离区域
 * 2. 窄门       —— 半径决定能否过门；门槛测试可爬台阶高度
 * 3. 多层平台   —— 台阶/坡度决定能否登上不同高度层；悬空层为独立分量
 */

function box(
  name: string,
  position: Vec3,
  size: Vec3,
  color = '#8b93a7',
): GeometryDef {
  return { id: uid(), kind: 'box', name, position, size, color, visible: true }
}

function ramp(
  name: string,
  position: Vec3,
  length: number,
  width: number,
  height: number,
  flip = false,
  color = '#9aa3b8',
): GeometryDef {
  return { id: uid(), kind: 'ramp', name, position, length, width, height, flip, color, visible: true }
}

/** 场景一：桥下净空（封闭围墙 + 中央带顶通道） */
export function presetBridge(): { geometries: GeometryDef[]; start: Vec3; end: Vec3 } {
  const g: GeometryDef[] = []

  // 地面 30 x 30
  g.push(box('地面', [0, -0.25, 0], [30, 0.5, 30], '#6b7280'))

  // 左右两道长墙贯通整个场地（无法绕行），留出中央 3m 宽通道
  g.push(box('左侧墙体', [-6.5, 1.5, 0], [10, 3, 30], '#7c8499'))
  g.push(box('右侧墙体', [6.5, 1.5, 0], [10, 3, 30], '#7c8499'))

  // 通道两侧的短墙（把中央 3m 走廊围成真正的“桥洞”）
  g.push(box('桥洞左壁', [-1.75, 1.0, 0], [0.5, 2.0, 30], '#6c7488'))
  g.push(box('桥洞右壁', [1.75, 1.0, 0], [0.5, 2.0, 30], '#6c7488'))

  // 桥面（顶板）只覆盖通道中段：内净高 2.0m
  // 半径 0.3、身高 1.8 可穿；身高调到 2.2 时桥洞被切断，前后成为分离区域
  g.push(box('桥面板', [0, 2.6, 0], [4, 1.2, 12], '#9aa3c0'))

  // 起点在通道北侧，终点在南侧，唯一路线是穿过桥洞
  return {
    geometries: g,
    start: [0, 0.2, 11],
    end: [0, 0.2, -11],
  }
}

/** 场景二：窄门（墙体 + 可变宽度门洞 + 门槛） */
export function presetDoor(): { geometries: GeometryDef[]; start: Vec3; end: Vec3 } {
  const g: GeometryDef[] = []

  // 地面 30 x 30
  g.push(box('地面', [0, -0.25, 0], [30, 0.5, 30], '#6b7280'))

  // 一道横墙（沿 x 方向），中间开门洞。墙沿通行方向(z)做厚，
  // 保证“梁下净空不足”形成的阻断带不会被轮廓简化跨接
  const wallZ = 0
  const wallT = 1.6
  const halfWall = 15 // 与场地边界齐平，无法从墙端绕行
  const openingHalf = 0.9 // 门洞净宽 1.8m
  const segLen = halfWall - openingHalf
  g.push(box('西墙段', [-(openingHalf + segLen / 2), 1.25, wallZ], [segLen, 2.5, wallT], '#7c8499'))
  g.push(box('东墙段', [(openingHalf + segLen / 2), 1.25, wallZ], [segLen, 2.5, wallT], '#7c8499'))
  // 门洞过梁（梁底 2.3m：地面身高 1.8 可过、2.4 被挡；
  // 站在 0.3m 门槛顶上时净高仍有 2.0m，留足体素余量）
  g.push(box('门洞过梁', [0, 2.45, wallZ], [openingHalf * 2, 0.3, wallT], '#9aa3c0'))

  // 门槛：0.3m 高 —— 可爬台阶 0.5（≈3 体素）时可越过；调到 0.3（≈2 体素）则被挡住
  g.push(box('门槛', [0, 0.15, wallZ], [1.2, 0.3, 1.4], '#a58a5b'))

  // 门垛把净宽收窄到 1.2m：半径 0.3（体素侵蚀 0.4×2）能过，半径 0.6（侵蚀 0.6×2）不能
  g.push(box('西门垛', [-1.0, 1.15, wallZ], [0.8, 2.3, wallT], '#6c7488'))
  g.push(box('东门垛', [1.0, 1.15, wallZ], [0.8, 2.3, wallT], '#6c7488'))

  return {
    geometries: g,
    start: [0, 0.2, 8],
    end: [0, 0.2, -8],
  }
}

/** 场景三：多层平台（台阶、斜坡、悬空二层） */
export function presetPlatforms(): { geometries: GeometryDef[]; start: Vec3; end: Vec3 } {
  const g: GeometryDef[] = []

  // 地面 34 x 34
  g.push(box('地面', [0, -0.25, 0], [34, 0.5, 34], '#6b7280'))

  // 一层平台：高 2m，南侧用斜坡连接
  g.push(box('一层平台', [6, 1.0, -4], [10, 2.0, 10], '#7c8499'))
  // 斜坡长 8m、高 1.7 -> arctan(1.7/8)=12°，45° 可上；坡顶与平台间有 0.3m 小台阶
  g.push(box('坡顶小台阶', [6, 1.85, 2.0], [10, 0.3, 2], '#8f97ac'))
  g.push(ramp('登平台斜坡', [6, 0, 10], 8, 10, 1.7, true, '#9aa3b8'))

  // 两级台阶（0.4 + 0.4，maxClimb=0.5 可上）通向一个矮台
  g.push(box('矮台(0.8m)', [-8, 0.4, 4], [6, 0.8, 6], '#8a93a8'))
  g.push(box('一级台阶(0.4m)', [-8, 0.2, 7.6], [6, 0.4, 0.8], '#97a0b5'))

  // 高台：2.5m，无斜坡连接 —— 永远是独立分量
  g.push(box('孤立高台', [-9, 1.25, -8], [7, 2.5, 7], '#848ca1'))

  // 悬空二层（顶棚/悬挑）：板底净高 3.0m，身高 1.8/2.2 都能从下方穿过；
  // 板顶也生成一小块导航网，与地面不相连（独立分量）
  g.push(box('悬空二层板', [0, 3.5, -12], [12, 1.0, 8], '#9aa3c0'))
  // 两根支柱
  g.push(box('支柱A', [-5, 1.5, -15], [0.6, 3.0, 0.6], '#6c7488'))
  g.push(box('支柱B', [5, 1.5, -15], [0.6, 3.0, 0.6], '#6c7488'))

  // 起点地面，终点放在一层平台上
  return {
    geometries: g,
    start: [6, 0.2, 12],
    end: [6, 2.2, -4],
  }
}

export function buildPresetProject(
  id: string,
  name: string,
  p: { geometries: GeometryDef[]; start: Vec3; end: Vec3 },
): ProjectData {
  return {
    version: 1,
    id,
    name,
    updatedAt: Date.now(),
    geometries: p.geometries,
    settings: { ...DEFAULT_SETTINGS },
    start: p.start,
    end: p.end,
  }
}
