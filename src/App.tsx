import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type {
  AgentSettings,
  GeometryDef,
  ProjectData,
  QueryOutcome,
  Vec3,
} from './types'
import { DEFAULT_SETTINGS, islandColor } from './types'
import { uid } from './nav/geometry'
import { buildCombinedMesh } from './nav/geometry'
import {
  buildNavMesh,
  disposeNavMesh,
  ensureRecastReady,
  findPath,
  queryPoint,
  type BuiltNavMesh,
} from './nav/recast'
import { StudioScene, type Tool } from './scene/StudioScene'
import { Panel, SliderRow, NumberField } from './ui/Controls'
import {
  buildPresetProject,
  presetBridge,
  presetDoor,
  presetPlatforms,
} from './presets'
import { deleteProject, listProjects, saveProject } from './storage'

type BuildState =
  | { status: 'loading' }
  | { status: 'building'; ms?: number }
  | { status: 'ready'; ms: number; polyCount: number; islandCount: number; tileCount: number }
  | { status: 'error'; message: string }

const AUTOSAVE_KEY = 'navmesh-studio-autosave'

function freshProject(name: string, p?: { geometries: GeometryDef[]; start: Vec3 | null; end: Vec3 | null }): ProjectData {
  return {
    version: 1,
    id: uid(),
    name,
    updatedAt: Date.now(),
    geometries: p?.geometries ?? [],
    settings: { ...DEFAULT_SETTINGS },
    start: p?.start ?? null,
    end: p?.end ?? null,
  }
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<StudioScene | null>(null)
  const builtRef = useRef<BuiltNavMesh | null>(null)

  const [ready, setReady] = useState(false)
  const [project, setProject] = useState<ProjectData>(() => {
    const preset = buildPresetProject(uid(), '桥下净空（示例）', presetBridge())
    return preset
  })
  const [tool, setTool] = useState<Tool>('select')
  const [topDown, setTopDown] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [build, setBuild] = useState<BuildState>({ status: 'loading' })
  const [outcome, setOutcome] = useState<QueryOutcome>({ kind: 'idle' })
  const [pathLength, setPathLength] = useState<number>(0)
  const [navOpacity, setNavOpacity] = useState(0.72)
  const [savedProjects, setSavedProjects] = useState<ProjectData[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [walking, setWalking] = useState(false)

  const projectRef = useRef(project)
  projectRef.current = project
  const toolRef = useRef(tool)
  toolRef.current = tool

  // ---------- Recast WASM ----------
  useEffect(() => {
    ensureRecastReady().then(() => setReady(true))
  }, [])

  // ---------- 场景 ----------
  useEffect(() => {
    if (!containerRef.current) return
    const scene = new StudioScene(containerRef.current)
    sceneRef.current = scene
    // 测试 / 调试用：从浏览器控制台或自动化脚本投影世界坐标到屏幕
    ;(window as unknown as { __navScene: StudioScene }).__navScene = scene
    scene.onSelect = (id) => setSelectedId(id)
    scene.onDrag = (id, x, z) => {
      setProject((p) => ({
        ...p,
        geometries: p.geometries.map((g) =>
          g.id === id ? { ...g, position: [x, g.position[1], z] } : g,
        ),
      }))
    }
    scene.onPick = (e) => {
      const t = toolRef.current
      if (t !== 'start' && t !== 'end') return
      const p = projectRef.current
      const point: Vec3 = [e.point[0], e.point[1] + 0.15, e.point[2]]
      setProject({
        ...p,
        start: t === 'start' ? point : p.start,
        end: t === 'end' ? point : p.end,
      })
    }
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    sceneRef.current?.setGeometries(project.geometries)
  }, [project.geometries])

  useEffect(() => {
    sceneRef.current?.setEndpoints(project.start, project.end)
  }, [project.start, project.end])

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.tool = tool
  }, [tool])

  useEffect(() => {
    sceneRef.current?.setSelected(selectedId)
  }, [selectedId])

  useEffect(() => {
    sceneRef.current?.setTopDown(topDown)
  }, [topDown])

  useEffect(() => {
    sceneRef.current?.setNavOpacity(navOpacity)
  }, [navOpacity])

  useEffect(() => {
    sceneRef.current?.setAgentSize(project.settings.radius, project.settings.height)
  }, [project.settings.radius, project.settings.height])

  // ---------- 自动重建导航网（防抖） ----------
  const [rebuildToken, setRebuildToken] = useState(0)
  useEffect(() => {
    if (!ready) return
    const handle = setTimeout(() => setRebuildToken((t) => t + 1), 220)
    return () => clearTimeout(handle)
  }, [ready, project.geometries, project.settings])

  useEffect(() => {
    if (!ready || rebuildToken === 0) return
    let cancelled = false
    setBuild((b) => ({ status: 'building', ms: b.status === 'ready' ? b.ms : undefined }))
    // 让 UI 先渲染
    const id = setTimeout(() => {
      const t0 = performance.now()
      const { positions, indices } = buildCombinedMesh(projectRef.current.geometries)
      const result = buildNavMesh(positions, indices, projectRef.current.settings)
      if (cancelled) {
        if ('navMesh' in result) disposeNavMesh(result)
        return
      }
      const t1 = performance.now()
      if ('error' in result) {
        disposeNavMesh(builtRef.current)
        builtRef.current = null
        sceneRef.current?.setNavMesh(null)
        setBuild({ status: 'error', message: result.error })
        return
      }
      disposeNavMesh(builtRef.current)
      builtRef.current = result
      sceneRef.current?.setNavMesh(result)
      setBuild({
        status: 'ready',
        ms: t1 - t0,
        polyCount: result.polyRefs.length,
        islandCount: result.islands.length,
        tileCount: result.tileCount,
      })
    }, 30)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [rebuildToken, ready])

  // ---------- 寻路查询 ----------
  useEffect(() => {
    const built = builtRef.current
    const scene = sceneRef.current
    if (!scene) return
    scene.clearSnapCandidates()
    if (!built || build.status !== 'ready') {
      scene?.setPath(null)
      setOutcome(build.status === 'error' ? { kind: 'no-navmesh' } : { kind: 'idle' })
      return
    }
    const { start, end } = projectRef.current
    if (!start || !end) {
      scene.setPath(null)
      setOutcome({ kind: 'idle' })
      return
    }

    const sq = queryPoint(built, start)
    const eq = queryPoint(built, end)

    // 吸附候选可视化（两端各自显示）
    if (sq && !sq.onMesh) scene.setSnapCandidates(start, sq.candidates, false)
    if (eq && !eq.onMesh) scene.setSnapCandidates(end, eq.candidates, false)

    if (!sq || !eq) {
      scene.setPath(null)
      setOutcome({ kind: 'no-navmesh' })
      return
    }

    if (sq.componentId !== eq.componentId) {
      scene.setPath(null)
      setOutcome({
        kind: 'disconnected',
        startComp: sq.componentId,
        endComp: eq.componentId,
        startOnMesh: sq.onMesh,
        endOnMesh: eq.onMesh,
        startSnaps: sq.candidates,
        endSnaps: eq.candidates,
      })
      return
    }

    const r = findPath(built, sq.snapped, eq.snapped)
    if (r.success) {
      scene.setPath(r.path)
      let len = 0
      for (let i = 1; i < r.path.length; i++) {
        len += Math.hypot(
          r.path[i][0] - r.path[i - 1][0],
          r.path[i][1] - r.path[i - 1][1],
          r.path[i][2] - r.path[i - 1][2],
        )
      }
      setPathLength(len)
      setOutcome({
        kind: 'ok',
        path: r.path,
        startOnMesh: sq.onMesh,
        endOnMesh: eq.onMesh,
        startSnaps: sq.candidates,
        endSnaps: eq.candidates,
        startComp: sq.componentId,
        endComp: eq.componentId,
      })
    } else {
      scene.setPath(null)
      setOutcome({
        kind: 'disconnected',
        startComp: sq.componentId,
        endComp: eq.componentId,
        startOnMesh: sq.onMesh,
        endOnMesh: eq.onMesh,
        startSnaps: sq.candidates,
        endSnaps: eq.candidates,
      })
    }
  }, [build, project.start, project.end])

  // ---------- 自动保存（localStorage 草稿 + IndexedDB） ----------
  const [dirty, setDirty] = useState(false)
  const updateProject = useCallback((patch: Partial<ProjectData>) => {
    setProject((p) => ({ ...p, ...patch }))
    setDirty(true)
  }, [])

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }))
    setDirty(true)
  }, [])

  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => {
      const toSave = { ...projectRef.current, updatedAt: Date.now() }
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(toSave))
      setDirty(false)
    }, 600)
    return () => clearTimeout(t)
  }, [project, dirty])

  // 启动时恢复草稿
  useEffect(() => {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (raw) {
      try {
        const data = JSON.parse(raw) as ProjectData
        if (data && data.version === 1 && Array.isArray(data.geometries)) {
          setProject(data)
        }
      } catch {
        // ignore
      }
    }
    listProjects().then(setSavedProjects)
  }, [])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2600)
  }

  // ---------- 几何编辑 ----------
  const selectedGeom = project.geometries.find((g) => g.id === selectedId) ?? null

  const updateGeom = (id: string, patch: Partial<GeometryDef>) => {
    setProject((p) => ({
      ...p,
      geometries: p.geometries.map((g) => ({ ...g, ...(g.id === id ? patch : {}) })) as GeometryDef[],
    }))
    setDirty(true)
  }

  const addBox = () => {
    const def: GeometryDef = {
      id: uid(),
      kind: 'box',
      name: `盒体 ${project.geometries.filter((g) => g.kind === 'box').length + 1}`,
      position: [0, 0.5, 0],
      size: [4, 1, 4],
      color: '#8b93a7',
      visible: true,
    }
    updateProject({ geometries: [...project.geometries, def] })
    setSelectedId(def.id)
    setTool('select')
  }

  const addRamp = () => {
    const def: GeometryDef = {
      id: uid(),
      kind: 'ramp',
      name: `斜坡 ${project.geometries.filter((g) => g.kind === 'ramp').length + 1}`,
      position: [0, 0, 0],
      length: 6,
      width: 4,
      height: 1.5,
      flip: false,
      color: '#9aa3b8',
      visible: true,
    }
    updateProject({ geometries: [...project.geometries, def] })
    setSelectedId(def.id)
    setTool('select')
  }

  const removeGeom = (id: string) => {
    updateProject({ geometries: project.geometries.filter((g) => g.id !== id) })
    if (selectedId === id) setSelectedId(null)
  }

  const loadPreset = (which: 'bridge' | 'door' | 'platforms') => {
    sceneRef.current?.stopWalk()
    const factory =
      which === 'bridge' ? presetBridge : which === 'door' ? presetDoor : presetPlatforms
    const name =
      which === 'bridge' ? '桥下净空（示例）' : which === 'door' ? '窄门（示例）' : '多层平台（示例）'
    const p = buildPresetProject(uid(), name, factory())
    setProject(p)
    setSelectedId(null)
    setDirty(true)
    setTool('select')
  }

  // ---------- IndexedDB 工程 ----------
  const persistToIDB = async () => {
    const toSave = { ...projectRef.current, updatedAt: Date.now() }
    await saveProject(toSave)
    setSavedProjects(await listProjects())
    setDirty(false)
    showToast(`已保存工程「${toSave.name}」到 IndexedDB`)
  }

  const loadIDB = async (id: string) => {
    const p = await listProjects()
    const found = p.find((x) => x.id === id)
    if (found) {
      setProject(found)
      setSelectedId(null)
      showToast(`已载入「${found.name}」`)
    }
  }

  const removeIDB = async (id: string) => {
    await deleteProject(id)
    setSavedProjects(await listProjects())
  }

  // ---------- 导出 / 导入（保留源网格 + 生成设置） ----------
  const exportProject = () => {
    const built = builtRef.current
    const payload = {
      format: 'navmesh-studio-project',
      exportedAt: new Date().toISOString(),
      project: projectRef.current,
      // 生成设置同时平铺保留，方便外部工具直接读取
      generationSettings: {
        ...projectRef.current.settings,
        walkableHeightVoxels: Math.max(
          2,
          Math.round(projectRef.current.settings.height / projectRef.current.settings.cellHeight),
        ),
        walkableRadiusVoxels: Math.max(
          0,
          Math.round(projectRef.current.settings.radius / projectRef.current.settings.cellSize),
        ),
        walkableClimbVoxels: Math.max(
          0,
          Math.round(projectRef.current.settings.maxClimb / projectRef.current.settings.cellHeight),
        ),
      },
      // 烘焙出的导航网三角面（仅供外部预览，不是重新生成的依据）
      bakedNavMesh: built
        ? {
            positions: Array.from(built.renderPositions),
            indices: Array.from(built.renderIndices),
            triangleComponent: Array.from(built.triangleComponent),
            islandCount: built.islands.length,
          }
        : null,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name.replace(/\s+/g, '_')}.navmesh.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importProject = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result))
        const p: ProjectData = data.project ?? data
        if (!p || !Array.isArray(p.geometries) || !p.settings) {
          showToast('导入失败：文件格式不正确')
          return
        }
        p.id = uid()
        setProject(p)
        setSelectedId(null)
        setDirty(true)
        showToast(`已导入「${p.name}」`)
      } catch {
        showToast('导入失败：JSON 解析错误')
      }
    }
    reader.readAsText(file)
  }

  // ---------- 角色行走 ----------
  const playWalk = () => {
    const s = sceneRef.current
    if (!s?.hasPath) return
    setWalking(true)
    s.playWalk(Math.max(2500, pathLength * 900), () => setWalking(false))
  }

  const islands = builtRef.current?.islands ?? []
  const outcomeSnap = useMemo(() => outcome, [outcome])

  return (
    <div className="app">
      <aside className="sidebar left">
        <div className="brand">
          <span className="brand-dot" />
          NavMesh Studio
          <small>浏览器内导航网编辑工具</small>
        </div>

        <Panel title="工具">
          <div className="tool-grid">
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>
              选择 / 拖拽
            </button>
            <button className={tool === 'start' ? 'active start-btn' : 'start-btn'} onClick={() => setTool('start')}>
              放起点
            </button>
            <button className={tool === 'end' ? 'active end-btn' : 'end-btn'} onClick={() => setTool('end')}>
              放终点
            </button>
          </div>
          <p className="tip">
            俯视模式下可拖拽移动几何；放置端点时点击表面取最上层落点，
            <kbd>Alt</kbd>+点击取下方一层。
          </p>
          <div className="btn-row">
            <button onClick={addBox}>+ 盒体</button>
            <button onClick={addRamp}>+ 斜坡</button>
          </div>
          <div className="btn-row">
            <button onClick={() => setTopDown((v) => !v)}>
              {topDown ? '退出俯视 (2D)' : '二维俯视'}
            </button>
            <button onClick={() => sceneRef.current?.focusView()}>居中视角</button>
          </div>
          <div className="btn-row">
            <button onClick={() => { updateProject({ start: null }); }}>清除起点</button>
            <button onClick={() => { updateProject({ end: null }); }}>清除终点</button>
          </div>
        </Panel>

        <Panel title="验算场景">
          <div className="btn-col">
            <button onClick={() => loadPreset('bridge')}>桥下净空（身高切断通道）</button>
            <button onClick={() => loadPreset('door')}>窄门 + 门槛（半径 / 台阶）</button>
            <button onClick={() => loadPreset('platforms')}>多层平台（坡度 / 悬空层）</button>
          </div>
        </Panel>

        <Panel title="场景对象">
          <ul className="geom-list">
            {project.geometries.map((g) => (
              <li
                key={g.id}
                className={g.id === selectedId ? 'selected' : ''}
                onClick={() => { setSelectedId(g.id); setTool('select') }}
              >
                <span className="geom-kind">{g.kind === 'box' ? '▣' : '◣'}</span>
                <span className="geom-name">{g.name}</span>
                <button
                  className="mini"
                  title={g.visible ? '隐藏' : '显示'}
                  onClick={(e) => { e.stopPropagation(); updateGeom(g.id, { visible: !g.visible }) }}
                >
                  {g.visible ? '👁' : '–'}
                </button>
                <button
                  className="mini danger"
                  title="删除"
                  onClick={(e) => { e.stopPropagation(); removeGeom(g.id) }}
                >
                  ✕
                </button>
              </li>
            ))}
            {project.geometries.length === 0 && <li className="empty">场景为空，请添加几何或载入示例</li>}
          </ul>
        </Panel>
      </aside>

      <main className="viewport" ref={containerRef}>
        <div className="topbar">
          <div className="build-status">
            {build.status === 'loading' && <span className="badge">正在加载 WASM…</span>}
            {build.status === 'building' && <span className="badge warn">正在生成导航网…</span>}
            {build.status === 'ready' && (
              <span className="badge ok">
                导航网就绪 · {build.polyCount} 多边形 · {build.islandCount} 个连通区域 ·{' '}
                {build.tileCount} tile · {build.ms.toFixed(0)}ms
              </span>
            )}
            {build.status === 'error' && <span className="badge err">生成失败：{build.message}</span>}
          </div>
          <div className="topbar-actions">
            <label className="opacity-control">
              导航网不透明度
              <input
                type="range" min={0.15} max={1} step={0.05}
                value={navOpacity}
                onChange={(e) => setNavOpacity(parseFloat(e.target.value))}
              />
            </label>
          </div>
        </div>

        <ResultBanner
          outcome={outcomeSnap}
          pathLength={pathLength}
          walking={walking}
          onPlay={playWalk}
          onStop={() => { sceneRef.current?.stopWalk(); setWalking(false) }}
          onReset={() => sceneRef.current?.resetAgent()}
        />

        {islands.length > 0 && (
          <div className="island-legend">
            <div className="legend-title">连通区域（按面积排序）</div>
            {islands.map((isl) => (
              <div className="legend-row" key={isl.componentId}>
                <span className="legend-swatch" style={{ background: islandColor(isl.componentId) }} />
                区域 {isl.componentId + 1}
                <small>
                  {isl.area.toFixed(1)} m² · {isl.triangleCount} 三角面
                </small>
              </div>
            ))}
          </div>
        )}

        <div className="hint-bottom">
          左键拖拽旋转/平移视角{topDown ? '已锁定（俯视）' : ''} · 右键平移 · 滚轮缩放
        </div>
      </main>

      <aside className="sidebar right">
        <Panel title="角色代理 / 生成设置">
          <div className="group-label">决定可通行区域的四个角色参数</div>
          <SliderRow label="角色半径" value={project.settings.radius} min={0.1} max={1.2} step={0.05} unit=" m"
            onChange={(v) => updateSettings({ radius: v })} />
          <SliderRow label="角色高度" value={project.settings.height} min={0.6} max={3.2} step={0.1} unit=" m"
            onChange={(v) => updateSettings({ height: v })} />
          <SliderRow label="可爬台阶" value={project.settings.maxClimb} min={0} max={1.2} step={0.05} unit=" m"
            onChange={(v) => updateSettings({ maxClimb: v })} />
          <SliderRow label="最大坡度" value={project.settings.maxSlope} min={5} max={75} step={1} unit=" °"
            onChange={(v) => updateSettings({ maxSlope: v })} />

          <div className="group-label">Recast 体素参数</div>
          <div className="grid-2">
            <NumberField label="水平体素 cs" value={project.settings.cellSize} step={0.05} min={0.05} unit="m"
              onChange={(v) => updateSettings({ cellSize: Math.max(0.02, v) })} />
            <NumberField label="垂直体素 ch" value={project.settings.cellHeight} step={0.05} min={0.05} unit="m"
              onChange={(v) => updateSettings({ cellHeight: Math.max(0.02, v) })} />
            <NumberField label="tile 尺寸" value={project.settings.tileSize} step={16} min={16} unit="vx"
              onChange={(v) => updateSettings({ tileSize: Math.max(16, Math.round(v)) })} />
            <NumberField label="最小区域" value={project.settings.minRegionArea} step={1} min={0} unit="m²"
              onChange={(v) => updateSettings({ minRegionArea: Math.max(0, v) })} />
          </div>
          <button className="ghost" onClick={() => updateSettings({ ...DEFAULT_SETTINGS })}>
            恢复默认设置
          </button>
        </Panel>

        {selectedGeom && (
          <Panel title="对象属性" right={
            <button className="mini danger" onClick={() => removeGeom(selectedGeom.id)}>删除</button>
          }>
            <ObjectEditor def={selectedGeom} onChange={(patch) => updateGeom(selectedGeom.id, patch)} />
          </Panel>
        )}

        <Panel title="工程（IndexedDB）">
          <input
            className="project-name"
            value={project.name}
            onChange={(e) => updateProject({ name: e.target.value })}
          />
          <div className="btn-row">
            <button onClick={persistToIDB}>保存工程</button>
            <button className="ghost" onClick={exportProject}>导出 JSON</button>
          </div>
          <label className="import-btn">
            导入 JSON
            <input
              type="file" accept="application/json,.json" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importProject(f); e.target.value = '' }}
            />
          </label>
          <ul className="project-list">
            {savedProjects.map((sp) => (
              <li key={sp.id}>
                <span className="proj-name" title={sp.name}>{sp.name}</span>
                <small>{new Date(sp.updatedAt).toLocaleString()}</small>
                <button className="mini" onClick={() => loadIDB(sp.id)}>载入</button>
                <button className="mini danger" onClick={() => removeIDB(sp.id)}>✕</button>
              </li>
            ))}
            {savedProjects.length === 0 && <li className="empty">尚无已保存工程（编辑内容会自动存草稿）</li>}
          </ul>
        </Panel>
      </aside>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function ResultBanner(props: {
  outcome: QueryOutcome
  pathLength: number
  walking: boolean
  onPlay: () => void
  onStop: () => void
  onReset: () => void
}) {
  const { outcome } = props

  const snapBlock = (
    title: string,
    onMesh: boolean,
    snaps: { componentId: number; distance: number }[],
  ) => (
    <div className="snap-block">
      <strong>{title}：</strong>
      {onMesh ? (
        <span className="ok-text">落在导航网上</span>
      ) : (
        <span className="warn-text">
          在网外 — 吸附候选：
          {snaps.slice(0, 6).map((s, i) => (
            <span
              key={i}
              className="snap-chip"
              style={{ borderColor: islandColor(s.componentId), color: islandColor(s.componentId) }}
            >
              区域{s.componentId + 1} · {s.distance.toFixed(2)}m
            </span>
          ))}
        </span>
      )}
    </div>
  )

  if (outcome.kind === 'idle') {
    return (
      <div className="banner info">
        选择「放起点 / 放终点」工具，在地形表面点击放置。路径沿 Detour 多边形走廊搜索，
        不是表面直线。
      </div>
    )
  }
  if (outcome.kind === 'no-navmesh') {
    return <div className="banner err">当前参数下没有可用导航网，请放宽角色参数或调整场景。</div>
  }

  if (outcome.kind === 'disconnected') {
    return (
      <div className="banner err">
        <div className="banner-title">不可达：起终点位于分离的连通区域</div>
        <div>
          起点在区域 <b style={{ color: islandColor(outcome.startComp) }}>{outcome.startComp + 1}</b>，
          终点在区域 <b style={{ color: islandColor(outcome.endComp) }}>{outcome.endComp + 1}</b>。
          Detour 多边形图中不存在连通走廊（桥洞过低 / 门太窄 / 没有可攀爬连接等）。
        </div>
        {snapBlock('起点', outcome.startOnMesh, outcome.startSnaps)}
        {snapBlock('终点', outcome.endOnMesh, outcome.endSnaps)}
      </div>
    )
  }

  return (
    <div className="banner ok">
      <div className="banner-title">
        路径已生成 · 长度 {props.pathLength.toFixed(2)} m · 位于区域 {outcome.startComp + 1}
        {!outcome.startOnMesh || !outcome.endOnMesh ? '（端点已自动吸附到最近多边形）' : ''}
      </div>
      {snapBlock('起点', outcome.startOnMesh, outcome.startSnaps)}
      {snapBlock('终点', outcome.endOnMesh, outcome.endSnaps)}
      <div className="banner-actions">
        {props.walking ? (
          <button onClick={props.onStop}>停止演示</button>
        ) : (
          <button onClick={props.onPlay}>▶ 角色沿路径行走</button>
        )}
        <button className="ghost" onClick={props.onReset}>角色归位</button>
      </div>
    </div>
  )
}

function ObjectEditor(props: { def: GeometryDef; onChange: (patch: Partial<GeometryDef>) => void }) {
  const d = props.def
  const setP = (axis: 0 | 1 | 2, v: number) => {
    const p = [...d.position] as Vec3
    p[axis] = v
    props.onChange({ position: p })
  }
  const nameInput = (
    <label className="field">
      <span className="field-label">名称</span>
      <input value={d.name} onChange={(e) => props.onChange({ name: e.target.value })} />
    </label>
  )

  if (d.kind === 'box') {
    const setS = (axis: 0 | 1 | 2, v: number) => {
      const s = [...d.size] as Vec3
      s[axis] = Math.max(0.05, v)
      props.onChange({ size: s })
    }
    return (
      <div>
        {nameInput}
        <div className="grid-3">
          <NumberField label="X" value={d.position[0]} step={0.5} onChange={(v) => setP(0, v)} />
          <NumberField label="Y" value={d.position[1]} step={0.5} onChange={(v) => setP(1, v)} />
          <NumberField label="Z" value={d.position[2]} step={0.5} onChange={(v) => setP(2, v)} />
        </div>
        <div className="grid-3">
          <NumberField label="长 X" value={d.size[0]} step={0.5} min={0.1} onChange={(v) => setS(0, v)} />
          <NumberField label="高 Y" value={d.size[1]} step={0.5} min={0.1} onChange={(v) => setS(1, v)} />
          <NumberField label="宽 Z" value={d.size[2]} step={0.5} min={0.1} onChange={(v) => setS(2, v)} />
        </div>
      </div>
    )
  }

  return (
    <div>
      {nameInput}
      <div className="grid-3">
        <NumberField label="X" value={d.position[0]} step={0.5} onChange={(v) => setP(0, v)} />
        <NumberField label="Y" value={d.position[1]} step={0.5} onChange={(v) => setP(1, v)} />
        <NumberField label="Z" value={d.position[2]} step={0.5} onChange={(v) => setP(2, v)} />
      </div>
      <div className="grid-2">
        <NumberField label="长度(水平)" value={d.length} step={0.5} min={0.1} unit="m"
          onChange={(v) => props.onChange({ length: Math.max(0.1, v) })} />
        <NumberField label="宽度" value={d.width} step={0.5} min={0.1} unit="m"
          onChange={(v) => props.onChange({ width: Math.max(0.1, v) })} />
        <NumberField label="高度" value={d.height} step={0.1} min={0.05} unit="m"
          onChange={(v) => props.onChange({ height: Math.max(0.05, v) })} />
        <label className="field">
          <span className="field-label">朝向</span>
          <select value={d.flip ? '1' : '0'} onChange={(e) => props.onChange({ flip: e.target.value === '1' })}>
            <option value="0">向 +z 抬升</option>
            <option value="1">向 -z 抬升</option>
          </select>
        </label>
      </div>
      <p className="tip">实际坡度 ≈ {((Math.atan2(d.height, d.length) * 180) / Math.PI).toFixed(1)}°</p>
    </div>
  )
}
