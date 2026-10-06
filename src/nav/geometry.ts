import * as THREE from 'three'
import type { BoxDef, GeometryDef, RampDef, Vec3 } from '../types'

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/**
 * 把一个几何体定义转换为三角形列表（世界空间，单位米）。
 * 盒体使用 24 顶点的立方体（面法线无歧义，Recast 体素化更稳定）。
 * 斜坡为三角棱柱：在 +z 方向以 maxClimb/slope 决定的坡度抬升。
 */
export function geometryToTriangles(
  def: GeometryDef,
): { positions: Float32Array; indices: Uint32Array } {
  if (def.kind === 'box') return boxToTriangles(def)
  return rampToTriangles(def)
}

function boxToTriangles(def: BoxDef): { positions: Float32Array; indices: Uint32Array } {
  const [cx, cy, cz] = def.position
  const [sx, sy, sz] = def.size
  const hx = sx / 2,
    hy = sy / 2,
    hz = sz / 2

  // 8 个角点
  const c: Vec3[] = [
    [cx - hx, cy - hy, cz - hz], // 0
    [cx + hx, cy - hy, cz - hz], // 1
    [cx + hx, cy - hy, cz + hz], // 2
    [cx - hx, cy - hy, cz + hz], // 3
    [cx - hx, cy + hy, cz - hz], // 4
    [cx + hx, cy + hy, cz - hz], // 5
    [cx + hx, cy + hy, cz + hz], // 6
    [cx - hx, cy + hy, cz + hz], // 7
  ]

  const positions: number[] = []
  const indices: number[] = []
  const addQuad = (a: number, b: number, d: number, e: number, normal: Vec3) => {
    // 朝外方向
    const base = positions.length / 3
    for (const idx of [a, b, d, e]) positions.push(...c[idx])
    // 用叉积校验缠绕方向，保证法线朝预期方向
    let tri: [number, number, number] = [base, base + 1, base + 2]
    const p0 = new THREE.Vector3(...positions.slice(tri[0] * 3, tri[0] * 3 + 3))
    const p1 = new THREE.Vector3(...positions.slice(tri[1] * 3, tri[1] * 3 + 3))
    const p2 = new THREE.Vector3(...positions.slice(tri[2] * 3, tri[2] * 3 + 3))
    const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0))
    if (n.dot(new THREE.Vector3(...normal)) < 0) {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    } else {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  // 底 -y
  addQuad(0, 3, 2, 1, [0, -1, 0])
  // 顶 +y
  addQuad(4, 5, 6, 7, [0, 1, 0])
  // -z
  addQuad(0, 1, 5, 4, [0, 0, -1])
  // +z
  addQuad(3, 7, 6, 2, [0, 0, 1])
  // -x
  addQuad(0, 4, 7, 3, [-1, 0, 0])
  // +x
  addQuad(1, 2, 6, 5, [1, 0, 0])

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
}

function rampToTriangles(def: RampDef): { positions: Float32Array; indices: Uint32Array } {
  // flip 直接通过顶点坐标（z 镜像）处理，三角形连接顺序保持不变：
  // 反射只改变法线 z 分量符号，坡面朝上 / 墙面朝外的缠绕对两种朝向都成立。
  const [px, py, pz] = def.position
  const s = def.flip ? -1 : 1
  const hw = def.width / 2

  // 本地 6 顶点（低端在 z=0，高端在 z=±length）
  const c: Vec3[] = [
    [px - hw, py, pz], // 0 低左
    [px + hw, py, pz], // 1 低右
    [px - hw, py, pz + s * def.length], // 2 高左底
    [px + hw, py, pz + s * def.length], // 3 高右底
    [px - hw, py + def.height, pz + s * def.length], // 4 高左顶
    [px + hw, py + def.height, pz + s * def.length], // 5 高右顶
  ]

  const positions: number[] = []
  const indices: number[] = []

  // 每个面给出 4 个（或 3 个）角点与期望的外法线方向（未翻转空间），
  // 用叉积校验缠绕，保证 Recast 坡度过滤看到的是朝上/朝外的正面。
  const addQuad = (a: number, b: number, d: number, e: number, normal: Vec3) => {
    const base = positions.length / 3
    for (const idx of [a, b, d, e]) positions.push(...c[idx])
    let tri: [number, number, number] = [base, base + 1, base + 2]
    const p0 = new THREE.Vector3(...positions.slice(tri[0] * 3, tri[0] * 3 + 3))
    const p1 = new THREE.Vector3(...positions.slice(tri[1] * 3, tri[1] * 3 + 3))
    const p2 = new THREE.Vector3(
      ...positions.slice(tri[2] * 3, tri[2] * 3 + 3),
    )
    const n = new THREE.Vector3()
      .subVectors(p1, p0)
      .cross(new THREE.Vector3().subVectors(p2, p0))
    if (n.dot(new THREE.Vector3(...normal)) < 0) {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    } else {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  const addTri = (a: number, b: number, d: number, normal: Vec3) => {
    const base = positions.length / 3
    for (const idx of [a, b, d]) positions.push(...c[idx])
    const p0 = new THREE.Vector3(...positions.slice(base * 3, base * 3 + 3))
    const p1 = new THREE.Vector3(...positions.slice((base + 1) * 3, (base + 1) * 3 + 3))
    const p2 = new THREE.Vector3(...positions.slice((base + 2) * 3, (base + 2) * 3 + 3))
    const n = new THREE.Vector3()
      .subVectors(p1, p0)
      .cross(new THREE.Vector3().subVectors(p2, p0))
    if (n.dot(new THREE.Vector3(...normal)) < 0) {
      indices.push(base, base + 2, base + 1)
    } else {
      indices.push(base, base + 1, base + 2)
    }
  }

  // 坡面（朝上）：四边形 0,1,5,4
  addQuad(0, 1, 5, 4, [0, 1, 0])
  // 底面（朝下）：0,2,3,1
  addQuad(0, 2, 3, 1, [0, -1, 0])
  // 高端墙（未翻转时朝 +z）：2,4,5,3
  addQuad(2, 4, 5, 3, [0, 0, 1])
  // 左端面（朝 -x）：0,4,2
  addTri(0, 4, 2, [-1, 0, 0])
  // 右端面（朝 +x）：1,3,5
  addTri(1, 3, 5, [1, 0, 0])

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
}

/** 合并所有可见几何的三角形 */
export function buildCombinedMesh(geometries: GeometryDef[]): {
  positions: Float32Array
  indices: Uint32Array
} {
  const positions: number[] = []
  const indices: number[] = []
  let vertexOffset = 0
  for (const def of geometries) {
    if (!def.visible) continue
    const { positions: p, indices: idx } = geometryToTriangles(def)
    positions.push(...p)
    for (const i of idx) indices.push(i + vertexOffset)
    vertexOffset += p.length / 3
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
}

/** 从盒体/斜坡创建 Three.js 渲染用 BufferGeometry */
export function toThreeGeometry(def: GeometryDef): THREE.BufferGeometry {
  const { positions, indices } = geometryToTriangles(def)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  g.computeVertexNormals()
  g.computeBoundingBox()
  return g
}
