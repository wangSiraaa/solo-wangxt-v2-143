import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from 'recast-navigation';
import { buildNavMesh, computeAgentPath, snapCandidates } from '../src/lib/navmesh.ts';
import { mergePrimitives } from '../src/lib/geometry.ts';
import { PRESETS } from '../src/lib/scenes.ts';
import type { BuildSettings, ProjectData, Vec3 } from '../src/types.ts';

await init();

const build = async (proj: ProjectData, overrides: Partial<BuildSettings> = {}) => {
  const settings = { ...proj.settings, ...overrides };
  const mesh = mergePrimitives(proj.primitives);
  return buildNavMesh(mesh, settings);
};

const find = (proj: ProjectData, start: Vec3, end: Vec3, overrides: Partial<BuildSettings> = {}) =>
  build(proj, overrides).then((built) => computeAgentPath(built, start, end));

test('桥下净空：矮角色(1.4)可穿桥洞直达，路径贴地不上桥', async () => {
  const proj = PRESETS.find((p) => p.id === 'bridge')!.project();
  const r = await find(proj, proj.start!, proj.end!, { height: 1.4 });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  const maxY = Math.max(...r.path.map((p) => p[1]));
  assert.ok(maxY < 1.0, `穿洞路径不应上桥，实际最高 ${maxY.toFixed(2)}`);
});

test('桥下净空：高角色(2.0)穿不过洞，必须登台阶上桥翻越', async () => {
  const proj = PRESETS.find((p) => p.id === 'bridge')!.project();
  const r = await find(proj, proj.start!, proj.end!, { height: 2.0 });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  const maxY = Math.max(...r.path.map((p) => p[1]));
  assert.ok(maxY > 2.0, `高角色应上桥（最高>2），实际 ${maxY.toFixed(2)}`);
});

test('桥下净空：调高角色高度后旧穿洞路径失效、产生翻越新路径', async () => {
  const proj = PRESETS.find((p) => p.id === 'bridge')!.project();
  const low = await find(proj, proj.start!, proj.end!, { height: 1.4 });
  const tall = await find(proj, proj.start!, proj.end!, { height: 2.0 });
  assert.equal(low.kind, 'ok');
  assert.equal(tall.kind, 'ok');
  if (low.kind !== 'ok' || tall.kind !== 'ok') return;
  const yLow = Math.max(...low.path.map((p) => p[1]));
  const yTall = Math.max(...tall.path.map((p) => p[1]));
  assert.ok(yTall - yLow > 1.0, '参数变化应显著改变路径几何');
});

test('窄门：默认角色(r0.4,climb0.3)可穿窄门直达', async () => {
  const proj = PRESETS.find((p) => p.id === 'door')!.project();
  const r = await find(proj, proj.start!, proj.end!);
  assert.equal(r.kind, 'ok');
});

test('窄门：胖角色(r0.6)挤不过窄门，且宽门有0.5门槛 => 不可达', async () => {
  const proj = PRESETS.find((p) => p.id === 'door')!.project();
  const r = await find(proj, proj.start!, proj.end!, { radius: 0.6 });
  assert.equal(r.kind, 'unreachable');
});

test('窄门：胖角色提高 climb 后可跨过宽门门槛绕行', async () => {
  const proj = PRESETS.find((p) => p.id === 'door')!.project();
  const r = await find(proj, proj.start!, proj.end!, { radius: 0.6, climb: 0.6 });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  const viaWide = r.path.some((p) => Math.abs(p[0] - 3) < 1.2 && Math.abs(p[2]) < 1.2);
  assert.ok(viaWide, '应经宽门跨过门槛');
});

test('窄门：2.4m 高角色两扇门都过不去（窄门净高2.2太矮、宽门门槛+门楣净空不足）', async () => {
  const proj = PRESETS.find((p) => p.id === 'door')!.project();
  for (const climb of [0.3, 0.6, 0.8]) {
    const r = await find(proj, proj.start!, proj.end!, { height: 2.4, climb });
    assert.equal(r.kind, 'unreachable', `climb=${climb} 时高个仍应被挡住`);
  }
});

test('多层平台：默认30°坡度限制，45°陡坡不可登上B台 => 分离不可达', async () => {
  const proj = PRESETS.find((p) => p.id === 'multi')!.project();
  const r = await find(proj, proj.start!, proj.end!);
  assert.equal(r.kind, 'unreachable');
});

test('多层平台：坡度上限放到50°后可经45°坡登上B台', async () => {
  const proj = PRESETS.find((p) => p.id === 'multi')!.project();
  const r = await find(proj, proj.start!, proj.end!, { maxSlopeDeg: 50 });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  const maxY = Math.max(...r.path.map((p) => p[1]));
  assert.ok(maxY > 2.5, `应登顶B台，实际 ${maxY.toFixed(2)}`);
});

test('多层平台：孤立C台与地面不连通（至少3个独立区）', async () => {
  const proj = PRESETS.find((p) => p.id === 'multi')!.project();
  const built = await build(proj, { maxSlopeDeg: 60 });
  assert.ok(built.regionCount >= 3, `至少 3 个连通区，实际 ${built.regionCount}`);
});

test('多层平台：25°引坡默认就连通地面与A台', async () => {
  const proj = PRESETS.find((p) => p.id === 'multi')!.project();
  const built = await build(proj);
  const r = computeAgentPath(built, [-4, 0.2, -7], [-4, 1.6, 2]);
  assert.equal(r.kind, 'ok', '地面应可通过25°坡到达A台顶');
});

test('网外吸附：远离导航网时给出每个连通区的吸附点与距离', async () => {
  const proj = PRESETS.find((p) => p.id === 'multi')!.project();
  const built = await build(proj, { maxSlopeDeg: 60 });
  const candidates = snapCandidates(built, [0, 0.2, 20]);
  assert.ok(candidates.length >= 1);
  for (const c of candidates) {
    assert.ok(c.distance3d > 0);
    assert.ok(c.distanceXZ > 0);
    assert.equal(typeof c.region, 'number');
  }
});

test('工程导出：JSON 同时保留源图元与全部生成参数', () => {
  const proj = PRESETS.find((p) => p.id === 'bridge')!.project();
  const json = JSON.stringify(proj);
  const back = JSON.parse(json) as ProjectData;
  assert.equal(back.version, 1);
  assert.ok(back.primitives.length >= 5);
  for (const key of ['radius', 'height', 'climb', 'maxSlopeDeg', 'cellSize'] as (keyof BuildSettings)[]) {
    assert.equal(typeof back.settings[key], 'number', `缺少设置 ${key}`);
  }
  const firstBox = back.primitives.find((p) => p.kind === 'box');
  assert.ok(firstBox && 'center' in firstBox && 'size' in firstBox, '源图元几何需保留');
});
