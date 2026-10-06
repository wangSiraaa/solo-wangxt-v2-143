import { init as recastInit, NavMesh, NavMeshQuery } from 'recast-navigation';
import { generateSoloNavMeshDataEx } from './recast-ex';
import type { BuildSettings, Vec3 } from '../types';
import type { TriMesh } from './geometry';

let initPromise: Promise<void> | null = null;
export const ensureWasmReady = (): Promise<void> => {
  if (!initPromise) initPromise = recastInit();
  return initPromise;
};

/** 吸附候选：某个连通区上距目标最近的点 */
export interface SnapCandidate {
  region: number; // 连通区编号（1 起）
  point: Vec3; // 网上吸附点
  distance3d: number; // 三维直线距离
  distanceXZ: number; // 水平距离
  isOver: boolean; // 输入点是否已在该多边形正上方
}

export interface BuiltNavMesh {
  navMesh: NavMesh;
  query: NavMeshQuery;
  positions: Float32Array; // 调试网格顶点
  indices: Uint32Array; // 调试网格三角形索引
  regionOfTri: Int32Array; // 每个调试网格三角形所属连通区（0=未分配）
  regionCount: number;
  /** 每个连通区的代表性中心（取区内顶点平均 xz、最高 y） */
  regionCenters: Vec3[];
  bounds: { min: Vec3; max: Vec3 };
  /** 构建时使用的设置签名，用于判定路径是否过期 */
  signature: string;
}

export const settingsSignature = (s: BuildSettings): string =>
  JSON.stringify(s);

/**
 * 依据调试网格的共享边把三角形划分为连通区。
 * 多层平台的不同层即使顶点 xz 接近，只要没有共享边就不会连通。
 * 注：Detour 调试网格按多边形各自导出顶点，相邻多边形顶点不共享索引，
 * 因此先按量化位置焊接顶点。
 */
export function labelConnectedRegions(
  srcPositions: Float32Array,
  srcIndices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array; regionOfTri: Int32Array; regionCount: number } {
  // 1) 焊接顶点（1mm 量化）
  const weld = new Map<string, number>();
  const remap: number[] = [];
  const packed: number[] = [];
  for (let i = 0; i < srcPositions.length / 3; i++) {
    const key = `${Math.round(srcPositions[i * 3] * 1000)},${Math.round(srcPositions[i * 3 + 1] * 1000)},${Math.round(srcPositions[i * 3 + 2] * 1000)}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = packed.length / 3;
      weld.set(key, id);
      packed.push(srcPositions[i * 3], srcPositions[i * 3 + 1], srcPositions[i * 3 + 2]);
    }
    remap.push(id);
  }
  const positions = Float32Array.from(packed);
  const indices = Uint32Array.from(srcIndices, (i) => remap[i]);

  const triCount = indices.length / 3;
  // 2) 边（焊接后顶点 id）-> 相邻三角形
  const edgeMap = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    for (const [u, w] of [[a, b], [b, c], [c, a]] as const) {
      const key = u < w ? `${u}|${w}` : `${w}|${u}`;
      const arr = edgeMap.get(key);
      if (arr) arr.push(t);
      else edgeMap.set(key, [t]);
    }
  }
  const adj: number[][] = Array.from({ length: triCount }, () => []);
  for (const tris of edgeMap.values()) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        adj[tris[i]].push(tris[j]);
        adj[tris[j]].push(tris[i]);
      }
    }
  }
  const regionOfTri = new Int32Array(triCount);
  let regionCount = 0;
  const stack: number[] = [];
  for (let s = 0; s < triCount; s++) {
    if (regionOfTri[s] !== 0) continue;
    regionCount++;
    regionOfTri[s] = regionCount;
    stack.push(s);
    while (stack.length) {
      const t = stack.pop()!;
      for (const n of adj[t]) {
        if (regionOfTri[n] === 0) {
          regionOfTri[n] = regionCount;
          stack.push(n);
        }
      }
    }
  }
  return { positions, indices, regionOfTri, regionCount };
}

export async function buildNavMesh(mesh: TriMesh, settings: BuildSettings): Promise<BuiltNavMesh> {
  await ensureWasmReady();
  if (mesh.indices.length === 0) throw new Error('场景中没有任何几何体');

  const cs = settings.cellSize;
  // 体素单位必须先四舍五入为整数：0.3/0.1=2.999... 若直接传入会被截断为 2，
  // 导致 0.3m 台阶（3 个体素高）被判为不可攀
  const res = generateSoloNavMeshDataEx(
    { positions: mesh.positions, indices: mesh.indices },
    {
      cs,
      ch: cs,
      walkableRadius: Math.max(0, Math.round(settings.radius / cs)),
      walkableHeight: Math.max(3, Math.round(settings.height / cs)),
      walkableClimb: Math.max(1, Math.round(settings.climb / cs)),
      walkableSlopeAngle: settings.maxSlopeDeg,
      // 场景边界外补一圈，防止贴边区域被裁掉
      borderSize: Math.ceil(settings.radius / cs) + 2,
      // 注意：生成器内部会把这两个值各自平方（area = size²，size 以体素计）。
      // 这里 size=10 => 100 体素(0.1m 时约 1m²)，只滤掉真正的碎片；
      // 直接传“体素面积”会意外丢掉桥面/小平台等合理小区域。
      minRegionArea: 10,
      mergeRegionArea: 16,
    },
    'monotone',
  );
  if (!res.navMeshData) throw new Error('导航网生成失败');

  const navMesh = new NavMesh();
  navMesh.initSolo(res.navMeshData);
  const query = new NavMeshQuery(navMesh, { maxNodes: 8192 });
  query.defaultQueryHalfExtents = { x: 4, y: 4, z: 4 };

  const [dbgPos, dbgIdx] = navMesh.getDebugNavMesh();
  const { positions, indices, regionOfTri, regionCount } = labelConnectedRegions(
    Float32Array.from(dbgPos),
    Uint32Array.from(dbgIdx),
  );

  const centers: Vec3[] = [];
  for (let r = 1; r <= regionCount; r++) {
    let sx = 0, sz = 0, maxY = -Infinity, n = 0;
    for (let t = 0; t < indices.length / 3; t++) {
      if (regionOfTri[t] !== r) continue;
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k];
        sx += positions[vi * 3];
        sz += positions[vi * 3 + 2];
        maxY = Math.max(maxY, positions[vi * 3 + 1]);
        n++;
      }
    }
    centers.push(n ? [sx / n, maxY, sz / n] : [0, 0, 0]);
  }

  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }

  return {
    navMesh,
    query,
    positions,
    indices,
    regionOfTri,
    regionCount,
    regionCenters: centers,
    bounds: { min, max },
    signature: settingsSignature(settings),
  };
}

// ---------- 纯几何：点到导航网三角形 ----------

const closestPointOnTriangle = (
  p: Vec3, a: Vec3, b: Vec3, c: Vec3,
): { point: Vec3; distSq: number } => {
  // Ericson, Real-Time Collision Detection, 5.1.5
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2];
  const d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];
  if (d1 <= 0 && d2 <= 0) return { point: a, distSq: dist3Sq(p, a) };

  const bp: Vec3 = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2];
  const d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];
  if (d3 >= 0 && d4 <= d3) return { point: b, distSq: dist3Sq(p, b) };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const q: Vec3 = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
    return { point: q, distSq: dist3Sq(p, q) };
  }

  const cp: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2];
  const d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];
  if (d6 >= 0 && d5 <= d6) return { point: c, distSq: dist3Sq(p, c) };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const q: Vec3 = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
    return { point: q, distSq: dist3Sq(p, q) };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const q: Vec3 = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
    return { point: q, distSq: dist3Sq(p, q) };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const q: Vec3 = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
  return { point: q, distSq: dist3Sq(p, q) };
};

const dist3Sq = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

export interface ClosestResult {
  point: Vec3;
  distance3d: number;
  region: number;
  tri: number;
}

/** 暴力遍历找最近三角形（场景规模 ≤ 数万三角形，足够流畅） */
export function closestPointOnNavMesh(built: BuiltNavMesh, p: Vec3): ClosestResult | null {
  const { positions, indices, regionOfTri } = built;
  if (indices.length === 0) return null;
  let best: ClosestResult | null = null;
  const va: Vec3 = [0, 0, 0], vb: Vec3 = [0, 0, 0], vc: Vec3 = [0, 0, 0];
  for (let t = 0; t < indices.length / 3; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    va[0] = positions[i0 * 3]; va[1] = positions[i0 * 3 + 1]; va[2] = positions[i0 * 3 + 2];
    vb[0] = positions[i1 * 3]; vb[1] = positions[i1 * 3 + 1]; vb[2] = positions[i1 * 3 + 2];
    vc[0] = positions[i2 * 3]; vc[1] = positions[i2 * 3 + 1]; vc[2] = positions[i2 * 3 + 2];
    const r = closestPointOnTriangle(p, va, vb, vc);
    if (!best || r.distSq < best.distance3d * best.distance3d) {
      best = { point: r.point, distance3d: Math.sqrt(r.distSq), region: regionOfTri[t], tri: t };
    }
  }
  return best;
}

/** 每个连通区各取一个最近点作为吸附候选 */
export function snapCandidates(built: BuiltNavMesh, p: Vec3): SnapCandidate[] {
  const { positions, indices, regionOfTri } = built;
  const bestPerRegion = new Map<number, { point: Vec3; d2: number }>();
  const va: Vec3 = [0, 0, 0], vb: Vec3 = [0, 0, 0], vc: Vec3 = [0, 0, 0];
  for (let t = 0; t < indices.length / 3; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    va[0] = positions[i0 * 3]; va[1] = positions[i0 * 3 + 1]; va[2] = positions[i0 * 3 + 2];
    vb[0] = positions[i1 * 3]; vb[1] = positions[i1 * 3 + 1]; vb[2] = positions[i1 * 3 + 2];
    vc[0] = positions[i2 * 3]; vc[1] = positions[i2 * 3 + 1]; vc[2] = positions[i2 * 3 + 2];
    const r = closestPointOnTriangle(p, va, vb, vc);
    const region = regionOfTri[t];
    const cur = bestPerRegion.get(region);
    if (!cur || r.distSq < cur.d2) bestPerRegion.set(region, { point: r.point, d2: r.distSq });
  }
  const out: SnapCandidate[] = [];
  for (const [region, v] of bestPerRegion) {
    const q = v.point;
    const dx = p[0] - q[0], dz = p[2] - q[2];
    out.push({
      region,
      point: q,
      distance3d: Math.sqrt(v.d2),
      distanceXZ: Math.hypot(dx, dz),
      isOver: dx * dx + dz * dz <= (0.05 * 0.05) && Math.abs(p[1] - q[1]) < 1.5,
    });
  }
  out.sort((a, b) => a.distance3d - b.distance3d);
  return out;
}

/**
 * 判定点是否“在网内”：优先在小垂直容差内匹配（避免多层场景被吸到别的高度层），
 * 找不到再放宽垂直搜索；水平偏差很小即视为在网内。
 */
export function isOnNavMesh(built: BuiltNavMesh, p: Vec3, tol = 0.6): boolean {
  const tryFind = (yHalf: number, maxDx: number) => {
    const nearest = built.query.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, {
      halfExtents: { x: tol, y: yHalf, z: tol },
    });
    if (!nearest.success) return false;
    const q = nearest.point;
    const dx = q.x - p[0], dz = q.z - p[2];
    return dx * dx + dz * dz <= maxDx * maxDx;
  };
  // 垂直 ±0.6 精确匹配；再放宽到 ±5
  return tryFind(0.6, 0.3) || tryFind(5, 0.3);
}

export type PathStatus =
  | { kind: 'ok'; path: Vec3[]; startRegion: number; endRegion: number }
  | { kind: 'unreachable'; startRegion: number; endRegion: number }
  | { kind: 'snap'; startCandidates: SnapCandidate[]; endCandidates: SnapCandidate[] }
  | { kind: 'empty' };

export function computeAgentPath(
  built: BuiltNavMesh,
  start: Vec3 | null,
  end: Vec3 | null,
  onTolerance = 0.45,
): PathStatus {
  if (!start || !end) return { kind: 'empty' };

  const startOn = isOnNavMesh(built, start, onTolerance);
  const endOn = isOnNavMesh(built, end, onTolerance);
  if (!startOn || !endOn) {
    return {
      kind: 'snap',
      startCandidates: snapCandidates(built, start),
      endCandidates: snapCandidates(built, end),
    };
  }

  // 用吸附到网上的精确点作为 Detour 输入，路径严格沿导航多边形。
  // 先小垂直半高匹配（避免在多层场景被吸到头顶/脚下另一层），失败再放宽
  const findNearest = (p: Vec3) =>
    built.query.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, { halfExtents: { x: 2, y: 0.6, z: 2 } }).success
      ? built.query.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, { halfExtents: { x: 2, y: 0.6, z: 2 } })
      : built.query.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, { halfExtents: { x: 2, y: 5, z: 2 } });
  const sNearest = findNearest(start);
  const eNearest = findNearest(end);
  if (!sNearest.success || !eNearest.success) {
    return { kind: 'snap', startCandidates: snapCandidates(built, start), endCandidates: snapCandidates(built, end) };
  }

  const sTri = closestPointOnNavMesh(built, [sNearest.point.x, sNearest.point.y, sNearest.point.z]);
  const eTri = closestPointOnNavMesh(built, [eNearest.point.x, eNearest.point.y, eNearest.point.z]);
  const startRegion = sTri?.region ?? 0;
  const endRegion = eTri?.region ?? 0;

  // 连通区不同 => 明确不可达，不向 Detour 请求
  if (startRegion !== endRegion) return { kind: 'unreachable', startRegion, endRegion };

  const result = built.query.computePath(
    { x: sNearest.point.x, y: sNearest.point.y, z: sNearest.point.z },
    { x: eNearest.point.x, y: eNearest.point.y, z: eNearest.point.z },
    { halfExtents: { x: 2, y: 4, z: 2 }, maxPathPolys: 1024, maxStraightPathPoints: 512 },
  );
  if (!result.success || result.path.length === 0) {
    return { kind: 'unreachable', startRegion, endRegion };
  }
  const path: Vec3[] = result.path.map((v) => [v.x, v.y, v.z]);
  return { kind: 'ok', path, startRegion, endRegion };
}

/** 路径总长度（用于展示） */
export function pathLength(path: Vec3[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
  }
  return len;
}
