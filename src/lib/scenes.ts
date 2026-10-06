import type { BuildSettings, Primitive, ProjectData, Vec3 } from '../types';
import { genId } from './geometry';

export interface Preset {
  id: string;
  label: string;
  description: string;
  project: () => ProjectData;
}

export const DEFAULT_SETTINGS: BuildSettings = {
  radius: 0.4,
  height: 1.8,
  climb: 0.3,
  maxSlopeDeg: 30,
  cellSize: 0.1,
};

const box = (name: string, center: Vec3, size: Vec3): Primitive =>
  ({ id: genId('box'), kind: 'box', name, center, size });

/** 楔体斜坡，axis 指定上升轴，dir 指定高端朝向（+1 正方向 / -1 负方向） */
const ramp = (
  name: string, centerX: number, centerZ: number, width: number, length: number,
  baseY: number, highY: number, axis: 'x' | 'z' = 'z', dir: 1 | -1 = 1,
): Primitive =>
  ({ id: genId('ramp'), kind: 'ramp', name, centerX, centerZ, width, length, baseY, highY, axis, dir });

const makeProject = (
  name: string,
  primitives: Primitive[],
  start: Vec3 | null,
  end: Vec3 | null,
  settings: BuildSettings = DEFAULT_SETTINGS,
): ProjectData => {
  const now = new Date().toISOString();
  return { version: 1, name, primitives, settings, start, end, createdAt: now, updatedAt: now };
};

/**
 * 场景一：桥下净空
 * - 34x30 地面，中部一道厚 0.6 横墙，仅留 4m 宽桥洞（x -2..2），洞顶 1.75
 * - 墙顶之上是悬空桥廊（薄0.3板，行走面 3.0），桥北/桥南各一座 10 级台阶梯
 *   （每级高 0.3 = 默认可爬高度，沿 x 升至 3.0），梯顶经架空引道接桥廊
 * - 矮角色(height 1.4)可穿桥洞；高角色(2.0)净空不足，必须登台阶上桥翻越
 * - 起点放在桥北梯道入口，终点正对桥洞南侧
 */
function bridgeScene(): ProjectData {
  const p: Primitive[] = [];
  p.push(box('地面', [0, -0.1, 0], [34, 0.2, 30]));

  const LINTEL = 1.75;
  // 横墙：门洞 x[-2,2]，墙厚 0.6，实体高 1.75
  p.push(box('墙-左段', [-9, LINTEL / 2, 0], [14, LINTEL, 0.6]));
  p.push(box('墙-右段', [9, LINTEL / 2, 0], [14, LINTEL, 0.6]));
  // 门楣：y 1.75..2.7（托住桥廊板底）
  p.push(box('桥洞门楣', [0, (LINTEL + 2.7) / 2, 0], [4, 2.7 - LINTEL, 0.6]));

  // 桥廊薄板（行走面 3.0）：南北两块，z 各覆盖 -1.2..1.8
  p.push(box('桥廊板-北', [0, 2.85, 0.3], [4.4, 0.3, 3]));
  p.push(box('桥廊板-南', [0, 2.85, -0.3], [4.4, 0.3, 3]));

  // 整体台阶梯：10 级，每级高 0.3、深 0.8，总高 3.0、总长 8.0；
  // 高端（最高一级）在 -X 侧，与梯顶平台 x=1.0 相接；dir=-1
  const STEP_H = 0.3, N = 10, STEP_D = 0.8;
  const STAIR_LEN = N * STEP_D; // 8.0
  const ZC = 6.3;
  const stairs = (
    name: string, centerZ: number,
  ): Primitive => ({
    id: genId('stairs'), kind: 'stairs', name,
    // 高端在 x=1.0 => 包围 u[-1,1]（dir=-1 时世界 x = centerX - u）：
    // centerX=0 时世界 x in [-4,4]，dir=-1 高端(u=+4)在 x=-4 —— 不对，
    // 需要高端(u=+L/2)在 x=1.0，dir=-1 => x=centerX-u => centerX-4=1.0 => centerX=5
    centerX: 5, centerZ, width: 4, length: STAIR_LEN,
    totalHeight: STEP_H * N, steps: N, axis: 'x', dir: -1,
  });
  for (const side of [1, -1] as const) {
    const tag = side === 1 ? '北' : '南';
    const z = side * ZC;
    p.push(stairs(`${tag}台阶梯(10级)`, z));
    // 顶部平台（高3.0）：x[-2.2,1.0]，与最高台阶相接
    p.push(box(`${tag}梯顶平台`, [(-2.2 + 1.0) / 2, 1.5, z], [3.2, 3.0, 3]));
    // 架空引道薄板：从梯顶平台 z 到桥廊 z=1.8，x[-2.2,1.0]
    p.push(box(
      `${tag}架空引道`,
      [-0.6, 2.85, side * (1.8 + (ZC - 1.8) / 2)],
      [3.2, 0.3, ZC - 1.8],
    ));
  }

  return makeProject(
    '桥下净空',
    p,
    [9.8, 0.2, 10], // 起：桥北、台阶梯入口附近地面
    [0, 0.2, -10], // 终：正对桥洞南侧
  );
}

/**
 * 场景二：窄门
 * - 20x20 场地，中墙 z=0 上开两个门洞：
 *   窄门净宽 1.0 + 门槛高 0.35；宽门净宽 2.0 无门槛
 * - 两门均设门楣（窄 1.5 净高、宽 2.5 净高），考察“胖子挤不过”与“高个低头”
 */
function narrowDoorScene(): ProjectData {
  const p: Primitive[] = [];
  p.push(box('地面', [0, -0.1, 0], [20, 0.2, 20]));

  // 墙位于 z=0，厚 0.6，高 3
  // 窄门中心 x=-3：门洞 x -3.5..-2.5（净宽 1.0），无门槛（仅受宽度/高度限制）
  // 宽门中心 x=3：门洞 x 2..4（净宽 2.0），带 0.5 高门槛（受 climb 限制）
  p.push(box('墙-左段', [-6.75, 1.5, 0], [6.5, 3, 0.6]));
  p.push(box('墙-中段', [-0.25, 1.5, 0], [4.5, 3, 0.6]));
  p.push(box('墙-右段', [7, 1.5, 0], [6, 3, 0.6]));

  // 窄门门楣：净高 2.2（1.8m 角色可过，2.4m 高个过不去；净宽 1.0 挡住胖角色）
  p.push(box('窄门门楣(净高2.2)', [-3, 2.6, 0], [1, 0.8, 0.6]));
  p.push(box('宽门门楣(净高2.5)', [3, 2.75, 0], [2, 0.5, 0.6]));

  // 宽门门槛：高 0.5、与墙同厚；默认 climb=0.3 跨不过（此时两扇门都封死），
  // climb>=0.5 后可跨宽门
  p.push(box('宽门门槛0.5', [3, 0.25, 0], [2, 0.5, 0.6]));

  return makeProject(
    '窄门',
    p,
    [-3, 0.2, 5], // 起：正对窄门
    [-3, 0.2, -5], // 终：窄门另一侧（默认参数需绕向宽门）
  );
}

/**
 * 场景三：多层平台
 * - A 台：高 1.5，25° 斜坡可上下；B 台：高 3.0
 *   A->B 之间为 45° 陡坡，默认 30° 限制不可达，调大坡度上限后可达
 * - C 台：孤立高台(2.0)，任何斜坡都不连接 => 永远分离区域
 * - A 台上方有一块低吊顶（净高 1.2），高角色在 A 台上的可行区域会被挖空
 */
function multiLevelScene(): ProjectData {
  const p: Primitive[] = [];
  p.push(box('地面', [0, -0.1, 0], [24, 0.2, 22]));

  // A 台：顶面 y=1.5，中心 (-4, 2.2)，6x6.4（z[-1,5.4]，-Z 侧伸出 0.4 搭住引坡）
  p.push(box('A台(高1.5)', [-4, 0.75, 2.2], [6, 1.5, 6.4]));
  // 地面 -> A：25° 坡，高端坡面在 A 边 z=-1 处 y=1.5，楔体低端延到地面
  const runA = 1.5 / Math.tan((25 * Math.PI) / 180);
  p.push(ramp(
    'A台引坡(25°)', -4, -1 - runA / 2,
    3, runA + 0.6, -0.3, 1.5, 'z', 1,
  ));

  // B 台：顶面 y=3.0，中心 (3.4, 2)，x[0.4,6.4]；其侵蚀后可行边约 x=0.8，
  // 恰与 45° 坡可行顶端相接
  p.push(box('B台(高3.0)', [3.4, 1.5, 2], [6, 3, 6]));
  // A -> B：45° 陡坡。楔体 x[-1.4,0.9]，坡面两端各埋 0.4 到平台实体，中间 45°
  p.push(ramp('A到B陡坡(45°)', (-1.4 + 0.9) / 2, 2, 6, 2.3, 1.5 - 0.4, 3.0 + 0.4, 'x', 1));

  // C 台：孤立，顶 y=2.0，中心 (0, -7)，3x3
  p.push(box('C台(孤立高2.0)', [0, 1, -7], [3, 2, 3]));

  // A 台上方低吊顶：板底 2.7（A 顶 1.5 以上净高 1.2）
  p.push(box('吊顶板', [-4, 2.8, 2], [3, 0.2, 3]));
  p.push(box('吊顶柱1', [-5.3, 2.1, 0.7], [0.2, 4.2, 0.2]));
  p.push(box('吊顶柱2', [-2.7, 2.1, 0.7], [0.2, 4.2, 0.2]));

  return makeProject(
    '多层平台',
    p,
    [-4, 0.2, -7],
    [5, 3.2, 2],
  );
}

export const PRESETS: Preset[] = [
  { id: 'bridge', label: '桥下净空', description: '桥洞净高 1.5m，高角色须折返上桥', project: bridgeScene },
  { id: 'door', label: '窄门', description: '1.0m 窄门 + 0.35m 门槛 vs 2m 宽门', project: narrowDoorScene },
  { id: 'multi', label: '多层平台', description: '25°/45° 坡、孤立平台与低吊顶', project: multiLevelScene },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
