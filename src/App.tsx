import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavScene } from './components/NavScene';
import { PRESETS, presetById } from './lib/scenes';
import type { BuildSettings, ProjectData, Vec3 } from './types';
import { buildNavMesh, computeAgentPath, snapCandidates, type BuiltNavMesh, type PathStatus } from './lib/navmesh';
import { mergePrimitives, meshToObj } from './lib/geometry';
import { idbListProjects, idbSaveProject, idbLoadProject, idbDeleteProject, type ProjectMeta } from './lib/storage';

type Placement = 'start' | 'end' | null;

const cloneProject = (p: ProjectData): ProjectData => JSON.parse(JSON.stringify(p));

export default function App() {
  const [project, setProject] = useState<ProjectData>(() => cloneProject(PRESETS[0].project()));
  const [activePreset, setActivePreset] = useState<string>(PRESETS[0].id);
  const [built, setBuilt] = useState<BuiltNavMesh | null>(null);
  const [pathStatus, setPathStatus] = useState<PathStatus | null>(null);
  const [pathLength, setPathLength] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [placing, setPlacing] = useState<Placement>(null);
  const [selectedRegion, setSelectedRegion] = useState<number | null>(null);
  const [saved, setSaved] = useState<ProjectMeta[]>([]);
  const [projectId, setProjectId] = useState<string>('current');
  const [tab, setTab] = useState<'params' | 'scenes' | 'project'>('params');
  const rebuildTimer = useRef<number | null>(null);

  const settings = project.settings;
  const setSetting = useCallback(<K extends keyof BuildSettings>(key: K, value: BuildSettings[K]) => {
    setProject((p) => ({ ...p, settings: { ...p.settings, [key]: value }, updatedAt: new Date().toISOString() }));
  }, []);

  // 合并网格
  const mesh = useMemo(() => mergePrimitives(project.primitives), [project.primitives]);

  // 重新生成导航网（参数/几何变化防抖）
  const rebuild = useCallback(async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const b = await buildNavMesh(mesh, settings);
      setBuilt(b);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
      setBuilt(null);
    } finally {
      setBuilding(false);
    }
  }, [mesh, settings]);

  useEffect(() => {
    if (rebuildTimer.current) window.clearTimeout(rebuildTimer.current);
    rebuildTimer.current = window.setTimeout(() => { void rebuild(); }, 150);
    return () => { if (rebuildTimer.current) window.clearTimeout(rebuildTimer.current); };
  }, [rebuild]);

  // 重新计算路径
  useEffect(() => {
    if (!built || !project.start || !project.end) {
      setPathStatus(null);
      setPathLength(null);
      return;
    }
    const status = computeAgentPath(built, project.start, project.end);
    setPathStatus(status);
    if (status.kind === 'ok') {
      let len = 0;
      for (let i = 1; i < status.path.length; i++) {
        const a = status.path[i - 1], b = status.path[i];
        len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      setPathLength(len);
    } else setPathLength(null);
  }, [built, project.start, project.end]);

  const loadPreset = (id: string) => {
    const preset = presetById(id);
    if (!preset) return;
    setActivePreset(id);
    setProject(cloneProject(preset.project()));
    setProjectId(`preset-${id}`);
    setSelectedRegion(null);
  };

  const onPlace = useCallback((which: 'start' | 'end', p: Vec3) => {
    // y 吸附到导航网表面
    let y = 0.1;
    if (built) {
      const n = built.query.findClosestPoint({ x: p[0], y: 1, z: p[2] }, { halfExtents: { x: 1, y: 6, z: 1 } });
      if (n.success) y = n.point.y;
    }
    const point: Vec3 = [+p[0].toFixed(2), +y.toFixed(2), +p[2].toFixed(2)];
    setProject((pr) => ({ ...pr, [which]: point, updatedAt: new Date().toISOString() }));
    setPlacing(null);
  }, [built]);

  const startSnap = useMemo(
    () => (built && project.start ? snapCandidates(built, project.start) : []),
    [built, project.start],
  );
  const endSnap = useMemo(
    () => (built && project.end ? snapCandidates(built, project.end) : []),
    [built, project.end],
  );

  // 持久化
  const refreshSaved = useCallback(() => { void idbListProjects().then(setSaved); }, []);
  useEffect(() => { refreshSaved(); }, [refreshSaved]);
  const saveProject = async () => {
    const id = projectId.startsWith('preset-') ? `proj-${Date.now()}` : projectId;
    await idbSaveProject(project, id, activePreset);
    setProjectId(id);
    refreshSaved();
  };
  const loadSaved = async (id: string) => {
    const p = await idbLoadProject(id);
    if (p) { setProject(p); setProjectId(id); setActivePreset(''); setSelectedRegion(null); }
  };
  const removeSaved = async (id: string) => { await idbDeleteProject(id); refreshSaved(); };

  // 导出
  const download = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };
  const exportProject = () => download(`${project.name}.navmesh.json`, JSON.stringify(project, null, 2), 'application/json');
  const exportObj = () => download(`${project.name}-source.obj`, meshToObj(mesh), 'text/plain');
  const importProject = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result)) as ProjectData;
        if (!p.primitives || !p.settings) throw new Error('文件缺少 primitives/settings');
        setProject(p); setProjectId(`proj-imported-${Date.now()}`); setActivePreset('');
      } catch (e) { alert(`导入失败: ${e instanceof Error ? e.message : e}`); }
    };
    reader.readAsText(file);
  };

  const path3d = pathStatus?.kind === 'ok' ? pathStatus.path : null;
  const maxPathY = path3d ? Math.max(...path3d.map((p) => p[1])) : null;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', font: '13px/1.5 system-ui, sans-serif', color: '#cfd8dc' }}>
      {/* 左侧面板 */}
      <div style={{ width: 320, background: '#161c22', borderRight: '1px solid #26323a', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #26323a' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#fff' }}>导航网编辑器</div>
          <div style={{ fontSize: 11, color: '#78909c', marginTop: 2 }}>recast-navigation WASM · React · Three.js</div>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid #26323a' }}>
          {([['params', '代理参数'], ['scenes', '场景'], ['project', '工程']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ flex: 1, padding: '8px 0', background: tab === k ? '#1f2a33' : 'transparent', color: tab === k ? '#4fc3f7' : '#90a4ae', border: 'none', borderBottom: tab === k ? '2px solid #4fc3f7' : '2px solid transparent', cursor: 'pointer' }}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {tab === 'params' && (
            <div>
              <Slider label="角色半径 radius" value={settings.radius} min={0.1} max={1.2} step={0.05} unit="m"
                onChange={(v) => setSetting('radius', v)} />
              <Slider label="角色高度 height" value={settings.height} min={0.8} max={3.0} step={0.1} unit="m"
                onChange={(v) => setSetting('height', v)} />
              <Slider label="可爬台阶 climb" value={settings.climb} min={0} max={1.0} step={0.05} unit="m"
                onChange={(v) => setSetting('climb', v)} />
              <Slider label="最大坡度 slope" value={settings.maxSlopeDeg} min={10} max={60} step={1} unit="°"
                onChange={(v) => setSetting('maxSlopeDeg', v)} />
              <Slider label="体素尺寸 cell" value={settings.cellSize} min={0.05} max={0.3} step={0.05} unit="m"
                onChange={(v) => setSetting('cellSize', v)} />

              <Section title="连通区">
                <div style={{ fontSize: 12, color: '#90a4ae' }}>
                  共 <b style={{ color: '#4fc3f7' }}>{built?.regionCount ?? '-'}</b> 个可行区域
                  {built && ` · ${built.indices.length / 3} 三角形`}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  <RegionChip label="全部" active={selectedRegion == null} onClick={() => setSelectedRegion(null)} />
                  {built && Array.from({ length: built.regionCount }, (_, i) => i + 1).map((r) => (
                    <RegionChip key={r} label={`区${r}`} color={REGION_HEX[(r - 1) % REGION_HEX.length]}
                      active={selectedRegion === r} onClick={() => setSelectedRegion(r === selectedRegion ? null : r)} />
                  ))}
                </div>
              </Section>
            </div>
          )}

          {tab === 'scenes' && (
            <div>
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => loadPreset(p.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, padding: 10,
                    background: activePreset === p.id ? '#1f3240' : '#1b232b', color: '#cfd8dc',
                    border: `1px solid ${activePreset === p.id ? '#4fc3f7' : '#2c3942'}`, borderRadius: 6, cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, color: '#fff' }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: '#78909c', marginTop: 2 }}>{p.description}</div>
                </button>
              ))}
            </div>
          )}

          {tab === 'project' && (
            <div>
              <Section title="当前工程">
                <input value={project.name} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))}
                  style={inputStyle} />
                <div style={{ fontSize: 11, color: '#607d8b', marginTop: 4 }}>
                  {project.primitives.length} 个源图元 · ID {projectId}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <Btn onClick={saveProject}>保存到浏览器</Btn>
                  <Btn onClick={exportProject}>导出 JSON</Btn>
                  <Btn onClick={exportObj}>导出源网格 OBJ</Btn>
                </div>
                <label style={btnFileStyle}>
                  导入 JSON
                  <input type="file" accept=".json" style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) importProject(f); }} />
                </label>
              </Section>
              <Section title="已保存（IndexedDB）">
                {saved.length === 0 && <div style={{ color: '#607d8b', fontSize: 12 }}>暂无</div>}
                {saved.map((m) => (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #222d34' }}>
                    <button onClick={() => loadSaved(m.id)} style={{ background: 'none', border: 'none', color: '#4fc3f7', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}>
                      {m.name}
                      <div style={{ color: '#607d8b', fontSize: 10 }}>{new Date(m.updatedAt).toLocaleString()}</div>
                    </button>
                    <button onClick={() => removeSaved(m.id)} style={{ background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer' }}>删除</button>
                  </div>
                ))}
              </Section>
            </div>
          )}
        </div>

        {/* 起终点 */}
        <div style={{ padding: 12, borderTop: '1px solid #26323a' }}>
          <EndpointRow label="起点" color="#66bb6a" point={project.start}
            placing={placing === 'start'} onPick={() => setPlacing(placing === 'start' ? null : 'start')}
            onClear={() => setProject((p) => ({ ...p, start: null }))} candidates={startSnap} />
          <EndpointRow label="终点" color="#ef5350" point={project.end}
            placing={placing === 'end'} onPick={() => setPlacing(placing === 'end' ? null : 'end')}
            onClear={() => setProject((p) => ({ ...p, end: null }))} candidates={endSnap} />
        </div>
      </div>

      {/* 主视图 */}
      <div style={{ flex: 1, position: 'relative' }}>
        <NavScene
          primitives={project.primitives}
          built={built}
          path={path3d}
          start={project.start}
          end={project.end}
          showNavMesh
          showSource
          selectedRegion={selectedRegion}
          placing={placing}
          onPlace={onPlace}
        />

        {/* 顶部状态栏 */}
        <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Badge>{project.name}</Badge>
          {building && <Badge color="#26323a">生成中…</Badge>}
          {buildError && <Badge color="#5d1f1f">生成失败</Badge>}
        </div>

        {/* 路径结果面板 */}
        <div style={{ position: 'absolute', top: 12, right: 12, width: 300 }}>
          <ResultPanel
            status={pathStatus}
            length={pathLength}
            maxY={maxPathY}
            hasStart={!!project.start}
            hasEnd={!!project.end}
          />
        </div>

        {/* 操作提示 */}
        <div style={{ position: 'absolute', bottom: 10, left: 12, fontSize: 11, color: '#546e7a' }}>
          左键拖拽平移 · 滚轮缩放 · 右键拖拽旋转 · 点击“起点/终点”后在地图上点选放置（吸附到导航网）
        </div>
      </div>
    </div>
  );
}

const REGION_HEX = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#aed581', '#fff176', '#64b5f6', '#f06292', '#7986cb', '#a1887f'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#78909c', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: '#4fc3f7', fontVariantNumeric: 'tabular-nums' }}>{value.toFixed(2)} {unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ width: '100%', accentColor: '#4fc3f7' }} />
    </div>
  );
}

function Btn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ padding: '5px 10px', fontSize: 12, background: '#1e3a4c', color: '#4fc3f7', border: '1px solid #2c5066', borderRadius: 4, cursor: 'pointer' }}>{children}</button>;
}

const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', background: '#0f151a', color: '#cfd8dc', border: '1px solid #2c3942', borderRadius: 4, fontSize: 12 };
const btnFileStyle: React.CSSProperties = { display: 'inline-block', marginTop: 8, padding: '5px 10px', fontSize: 12, background: '#1e3a4c', color: '#4fc3f7', border: '1px solid #2c5066', borderRadius: 4, cursor: 'pointer' };

function RegionChip({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color?: string }) {
  return (
    <button onClick={onClick}
      style={{ padding: '3px 8px', fontSize: 11, borderRadius: 10, cursor: 'pointer',
        background: active ? (color ?? '#4fc3f7') : '#1b232b', color: active ? '#000' : '#90a4ae',
        border: `1px solid ${color ?? '#2c3942'}` }}>{label}</button>
  );
}

function Badge({ children, color = '#1f2a33' }: { children: React.ReactNode; color?: string }) {
  return <span style={{ background: color, padding: '5px 10px', borderRadius: 4, fontSize: 12, border: '1px solid #2c3942' }}>{children}</span>;
}

function EndpointRow({ label, color, point, placing, onPick, onClear, candidates }: {
  label: string; color: string; point: Vec3 | null; placing: boolean;
  onPick: () => void; onClear: () => void;
  candidates: ReturnType<typeof snapCandidates>;
}) {
  const onMesh = point && candidates.length > 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: color, display: 'inline-block' }} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
        <button onClick={onPick} style={{ marginLeft: 'auto', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
          background: placing ? '#4fc3f7' : '#1b232b', color: placing ? '#000' : '#90a4ae', border: '1px solid #2c3942', borderRadius: 4 }}>
          {placing ? '点击地图…' : point ? '重新选点' : '选点'}
        </button>
        {point && <button onClick={onClear} style={{ fontSize: 11, background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer' }}>清除</button>}
      </div>
      {point ? (
        <div style={{ fontSize: 11, color: onMesh ? '#90a4ae' : '#ffb74d', paddingLeft: 14 }}>
          ({point[0]}, {point[1]}, {point[2]})
          {!onMesh && candidates.length === 0 && ' · 网外（无候选）'}
          {!onMesh && candidates.length > 0 && ` · 网外，最近 ${candidates[0].distance3d.toFixed(2)}m → 区${candidates[0].region}`}
        </div>
      ) : <div style={{ fontSize: 11, color: '#546e7a', paddingLeft: 14 }}>未设置</div>}
    </div>
  );
}

function ResultPanel({ status, length, maxY, hasStart, hasEnd }: {
  status: PathStatus | null; length: number | null; maxY: number | null;
  hasStart: boolean; hasEnd: boolean;
}) {
  let body: React.ReactNode = null;
  if (!hasStart || !hasEnd) body = <div style={{ color: '#607d8b' }}>设置起点和终点后计算路径</div>;
  else if (!status) body = <div style={{ color: '#607d8b' }}>…</div>;
  else if (status.kind === 'empty') body = <div style={{ color: '#ef5350' }}>导航网为空</div>;
  else if (status.kind === 'snap') {
    body = (
      <div>
        <div style={{ color: '#ffb74d', fontWeight: 600, marginBottom: 6 }}>起/终点在导航网外（分离区域）</div>
        <SnapList title="起点候选" c={status.startCandidates} />
        <SnapList title="终点候选" c={status.endCandidates} />
        <div style={{ fontSize: 11, color: '#78909c', marginTop: 6 }}>
          角色参数下可行区域不相连，不存在地面直线以外的路线
        </div>
      </div>
    );
  } else if (status.kind === 'unreachable') {
    body = (
      <div>
        <div style={{ color: '#ef5350', fontWeight: 700, fontSize: 14 }}>不可达（分离区域）</div>
        <div style={{ fontSize: 12, color: '#90a4ae', marginTop: 4 }}>
          起点在 <b>区{status.startRegion}</b>，终点在 <b>区{status.endRegion}</b>
        </div>
        <div style={{ fontSize: 11, color: '#607d8b', marginTop: 6 }}>
          半径/高度/台阶/坡度把通道切断了——路径严格沿导航多边形，不是表面直线
        </div>
      </div>
    );
  } else if (status.kind === 'ok') {
    body = (
      <div>
        <div style={{ color: '#81c784', fontWeight: 700, fontSize: 14 }}>可达 ✓</div>
        <div style={{ fontSize: 12, color: '#90a4ae', marginTop: 4 }}>
          区域 {status.startRegion} → {status.endRegion} · {status.path.length} 个路径点
        </div>
        <div style={{ fontSize: 12, color: '#90a4ae' }}>路径长度 {length?.toFixed(2)} m · 最高点 {maxY?.toFixed(2)} m</div>
      </div>
    );
  }
  return (
    <div style={{ background: 'rgba(17,24,30,0.92)', border: '1px solid #2c3942', borderRadius: 8, padding: 12, backdropFilter: 'blur(4px)' }}>
      {body}
    </div>
  );
}

function SnapList({ title, c }: { title: string; c: ReturnType<typeof snapCandidates> }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: '#78909c', marginBottom: 2 }}>{title}</div>
      {c.length === 0 && <div style={{ fontSize: 11, color: '#546e7a' }}>（附近无导航网）</div>}
      {c.slice(0, 4).map((x, i) => (
        <div key={i} style={{ fontSize: 11, color: '#b0bec5', display: 'flex', justifyContent: 'space-between' }}>
          <span>区{x.region} ({x.point[0].toFixed(1)}, {x.point[1].toFixed(1)}, {x.point[2].toFixed(1)})</span>
          <span style={{ color: '#4fc3f7' }}>{x.distance3d.toFixed(2)}m</span>
        </div>
      ))}
    </div>
  );
}
