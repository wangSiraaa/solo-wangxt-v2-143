import type { BoxPrimitive, Primitive, RampPrimitive, Vec3 } from '../types';

export interface TriMesh {
  positions: number[]; // xyz * n，世界坐标
  indices: number[]; // 三角形索引（每 3 个一个三角形）
}

let idCounter = 0;
export const genId = (prefix = 'id'): string =>
  `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

const boxFaces = [
  [0, 2, 1], [0, 3, 2], // -z
  [4, 5, 6], [4, 6, 7], // +z
  [0, 1, 5], [0, 5, 4], // -y
  [3, 7, 6], [3, 6, 2], // +y
  [0, 4, 7], [0, 7, 3], // -x
  [1, 2, 6], [1, 6, 5], // +x
];

export function boxGeometry(b: BoxPrimitive): TriMesh {
  const [cx, cy, cz] = b.center;
  const [sx, sy, sz] = b.size;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const corners: Vec3[] = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
  ];
  return { positions: corners.flat(), indices: boxFaces.flat() };
}

/**
 * 斜坡楔体（三角棱柱）：沿上升轴 +Z 或 +X 上升。
 * 斜面从负方向端 y=baseY 升至正方向端 y=highY；底面恒为 y=baseY。
 * 三角绕序按 y-up、外表面朝外。
 */
export function rampGeometry(r: RampPrimitive): TriMesh {
  const axis = r.axis ?? 'z';
  const dir = r.dir ?? 1;
  // 统一在局部坐标计算：局部 u = 上升轴，w = 宽度轴；u 正方向端为高端
  const u0v = -r.length / 2;
  const u1v = r.length / 2;
  const w0v = -r.width / 2, w1v = r.width / 2;
  // dir=-1 时高端朝负方向：翻转 u 映射
  const U0 = dir === 1 ? u0v : u1v; // 低端
  const U1 = dir === 1 ? u1v : u0v; // 高端
  // 局部角点 -> 世界
  const toWorld = (u: number, y: number, w: number): Vec3 =>
    axis === 'z'
      ? [r.centerX + w, y, r.centerZ + u]
      : [r.centerX + u, y, r.centerZ + w];
  const v: Vec3[] = [
    toWorld(U0, r.baseY, w0v), // 0 低-宽左
    toWorld(U0, r.baseY, w1v), // 1 低-宽右
    toWorld(U1, r.highY, w1v), // 2 高-顶右
    toWorld(U1, r.highY, w0v), // 3 高-顶左
    toWorld(U1, r.baseY, w1v), // 4 高-底右
    toWorld(U1, r.baseY, w0v), // 5 高-底左
  ];
  // dir=-1 时反射会翻转绕序，整体反转索引
  let faces = dir === 1
    ? [
        [0, 2, 1], [0, 3, 2], // 斜面（顶面）
        [0, 1, 4], [0, 4, 5], // 底面
        [1, 2, 4], // 宽+侧三角面
        [0, 5, 3], // 宽-侧三角面
        [3, 4, 2], [3, 5, 4], // 高端竖面
      ]
    : [
        [0, 1, 2], [0, 2, 3],
        [0, 4, 1], [0, 5, 4],
        [1, 4, 2],
        [0, 3, 5],
        [3, 2, 4], [3, 4, 5],
      ];
  let positionsOut = v.flat();
  // axis='x' 时 u->x 的坐标反射会翻转手性：检测斜面法线，若朝下则整体反转绕序
  const tri = faces[0];
  const ay = positionsOut[tri[0] * 3 + 1], by = positionsOut[tri[1] * 3 + 1], cy = positionsOut[tri[2] * 3 + 1];
  // 用法线 y 分量符号判断（取斜面两邻边叉积）
  const p0 = tri.map((vi) => [positionsOut[vi * 3], positionsOut[vi * 3 + 1], positionsOut[vi * 3 + 2]]) as Vec3[];
  const n1y = (p0[1][0] - p0[0][0]) * (p0[2][2] - p0[0][2]) - (p0[1][2] - p0[0][2]) * (p0[2][0] - p0[0][0]);
  void ay; void by; void cy;
  // 更直接：斜面法线 y = (b-a)x(c-a).y
  const ux = p0[1][0] - p0[0][0], uy = p0[1][1] - p0[0][1], uz = p0[1][2] - p0[0][2];
  const vx = p0[2][0] - p0[0][0], vy = p0[2][1] - p0[0][1], vz = p0[2][2] - p0[0][2];
  const normalY = uz * vx - ux * vz;
  void n1y; void uy; void vy;
  const indicesOut = faces.flat();
  if (normalY < 0) {
    for (let t = 0; t < indicesOut.length; t += 3) {
      const tmp = indicesOut[t + 1];
      indicesOut[t + 1] = indicesOut[t + 2];
      indicesOut[t + 2] = tmp;
    }
  }
  return { positions: positionsOut, indices: indicesOut };
}

/**
 * 整体台阶几何：沿 u 轴逐级升高的实心阶梯。
 * 第 i 级（i=0..steps-1）是一个长 du 的盒，顶高 (i+1)*dh；
 * 整个阶梯是这些盒的并，用三角网格表达外表面。
 */
export function stairsGeometry(s: Extract<Primitive, { kind: 'stairs' }>): TriMesh {
  const n = s.steps;
  const du = s.length / n;
  const dh = s.totalHeight / n;
  const dir = s.dir ?? 1;
  const w0 = -s.width / 2, w1 = s.width / 2;
  // 阶梯侧轮廓（u,y）：从低端到高端逐级
  // 轮廓点（闭合）：(-L/2,0) -> 逐级 (u_i, i*dh) -> (L/2,H) -> (L/2,0)
  const loop: Array<[number, number]> = [];
  loop.push([-s.length / 2, 0]);
  for (let i = 0; i <= n; i++) {
    loop.push([-s.length / 2 + i * du, i * dh]);
  }
  loop.push([s.length / 2, 0]);
  const toWorld = (u: number, y: number, w: number): Vec3 =>
    s.axis === 'z'
      ? [s.centerX + w, y, s.centerZ + dir * u]
      : [s.centerX + dir * u, y, s.centerZ + w];

  const positions: number[] = [];
  const indices: number[] = [];
  const addQuad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    const base = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // 两侧面（w0 / w1）：轮廓扇形三角化
  for (const w of [w0, w1]) {
    const base = positions.length / 3;
    const verts: Vec3[] = loop.map(([u, y]) => toWorld(u, y, w));
    positions.push(...verts.flat());
    for (let i = 1; i < verts.length - 1; i++) {
      // 保证朝外：w=w1 与 w=w0 绕序相反
      if (w === w1) indices.push(base, base + i, base + i + 1);
      else indices.push(base, base + i + 1, base + i);
    }
  }
  // 踏面（每级水平顶面，法线 +Y）与踢面（竖面）
  // 四边形顶点按 (u0,w0)(u0,w1)(u1,w1)(u1,w0) 给出，
  // addQuad 的绕序在 dir=+1 时顶面朝上；dir=-1（u 被反射）时需反向
  for (let i = 0; i < n; i++) {
    const u0 = -s.length / 2 + i * du;
    const u1 = u0 + du;
    const yTop = (i + 1) * dh;
    const yLow = i * dh;
    const A = toWorld(u0, yTop, w0), B = toWorld(u0, yTop, w1),
      C = toWorld(u1, yTop, w1), D = toWorld(u1, yTop, w0);
    // 踏面
    if (dir === 1) addQuad(A, B, C, D); else addQuad(A, D, C, B);
    // 踢面（朝 -u 方向，即朝阶梯低端）
    const E = toWorld(u0, yLow, w1), F = toWorld(u0, yLow, w0),
      G = toWorld(u0, yTop, w0), H = toWorld(u0, yTop, w1);
    if (dir === 1) addQuad(E, F, G, H); else addQuad(E, H, G, F);
  }
  // 最高端竖面（朝 +u）
  {
    const A = toWorld(s.length / 2, 0, w1), B = toWorld(s.length / 2, 0, w0),
      C = toWorld(s.length / 2, s.totalHeight, w0), D = toWorld(s.length / 2, s.totalHeight, w1);
    if (dir === 1) addQuad(A, B, C, D); else addQuad(A, D, C, B);
  }
  // 底面（法线 -Y，方向不影响）
  addQuad(
    toWorld(-s.length / 2, 0, w0), toWorld(s.length / 2, 0, w0),
    toWorld(s.length / 2, 0, w1), toWorld(-s.length / 2, 0, w1),
  );
  return { positions, indices };
}

/** 将全部图元合并为单一三角形网格（用于 Recast 输入与射线检测） */
export function mergePrimitives(primitives: Primitive[]): TriMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const p of primitives) {
    const g = p.kind === 'box' ? boxGeometry(p) : p.kind === 'ramp' ? rampGeometry(p) : stairsGeometry(p);
    positions.push(...g.positions);
    for (const i of g.indices) indices.push(i + offset);
    offset += g.positions.length / 3;
  }
  return { positions, indices };
}

/** 导出 OBJ（源网格，不含导航设置；JSON 工程文件另含设置） */
export function meshToObj(mesh: TriMesh, name = 'source-mesh'): string {
  const lines: string[] = [`o ${name}`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(
      `v ${mesh.positions[i].toFixed(4)} ${mesh.positions[i + 1].toFixed(4)} ${mesh.positions[i + 2].toFixed(4)}`,
    );
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(`f ${mesh.indices[i] + 1} ${mesh.indices[i + 1] + 1} ${mesh.indices[i + 2] + 1}`);
  }
  return lines.join('\n');
}
