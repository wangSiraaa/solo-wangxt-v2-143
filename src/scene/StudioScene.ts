import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  CSS2DRenderer,
  CSS2DObject,
} from 'three/addons/renderers/CSS2DRenderer.js'
import type { BuiltNavMesh } from '../nav/recast'
import type { GeometryDef, SnapCandidate, Vec3 } from '../types'
import { islandColor } from '../types'
import { toThreeGeometry } from '../nav/geometry'

export type Tool = 'select' | 'start' | 'end' | 'add-box'

export type ClickHit = {
  y: number
  objectName: string
}

export type SceneClickEvent = {
  point: Vec3
  hits: ClickHit[]
  alt: boolean
  button: number
}

const v3tmp = new THREE.Vector3()

export class StudioScene {
  readonly renderer: THREE.WebGLRenderer
  private readonly labelRenderer: CSS2DRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly raycaster = new THREE.Raycaster()
  private readonly groundPlane: THREE.Mesh

  private sourceGroup = new THREE.Group()
  private navGroup = new THREE.Group()
  private markerGroup = new THREE.Group()
  private pathGroup = new THREE.Group()
  private snapGroup = new THREE.Group()

  private geometries = new Map<string, GeometryDef>()
  private meshes = new Map<string, THREE.Mesh>()
  private selectedId: string | null = null

  private startMarker: THREE.Object3D | null = null
  private endMarker: THREE.Object3D | null = null
  private agent: THREE.Group | null = null
  private agentRadius = 0.3
  private agentHeight = 1.8

  private pathCurve: THREE.CatmullRomCurve3 | null = null
  private walkRaf = 0
  private walkCb: (() => void) | null = null

  tool: Tool = 'select'
  onPick: ((e: SceneClickEvent) => void) | null = null
  onSelect: ((id: string | null) => void) | null = null
  onDrag: ((id: string, x: number, z: number) => void) | null = null

  private topDownMode = false
  private dragging: { id: string; plane: THREE.Plane; offset: THREE.Vector3 } | null = null
  private pressInfo: { x: number; y: number } | null = null
  private pressHitTop = false

  constructor(private container: HTMLElement) {
    const w = container.clientWidth
    const h = container.clientHeight

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.renderer.shadowMap.enabled = false
    container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    this.labelRenderer.setSize(w, h)
    this.labelRenderer.domElement.style.position = 'absolute'
    this.labelRenderer.domElement.style.top = '0'
    this.labelRenderer.domElement.style.pointerEvents = 'none'
    container.appendChild(this.labelRenderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#0f1420')

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500)
    this.camera.position.set(26, 26, 30)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.target.set(0, 0, 0)

    // 灯光
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x30363d, 1.1)
    const dir = new THREE.DirectionalLight(0xffffff, 1.6)
    dir.position.set(20, 40, 18)
    this.scene.add(hemi, dir)

    // 无限大的拾取地面（不可见，仅保证空地点击仍有落点）
    this.groundPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    this.groundPlane.rotation.x = -Math.PI / 2
    this.groundPlane.name = '__ground'
    this.scene.add(this.groundPlane)

    // 参考网格（仅视觉）
    const grid = new THREE.GridHelper(80, 80, 0x3a4358, 0x232b3c)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.55
    this.scene.add(grid)

    this.scene.add(this.sourceGroup, this.navGroup, this.snapGroup, this.pathGroup, this.markerGroup)

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove)
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('resize', this.onResize)

    this.animate()
  }

  // ---------------- 源几何 ----------------

  setGeometries(defs: GeometryDef[]) {
    this.geometries = new Map(defs.map((d) => [d.id, d]))
    // 重建所有源网格
    for (const m of this.meshes.values()) {
      this.sourceGroup.remove(m)
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
    this.meshes.clear()

    for (const def of defs) {
      const mesh = new THREE.Mesh(
        toThreeGeometry(def),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(def.color),
          roughness: 0.85,
          metalness: 0.05,
          transparent: true,
          opacity: def.visible ? 1 : 0.12,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      )
      mesh.userData.defId = def.id
      mesh.userData.defName = def.name
      this.sourceGroup.add(mesh)
      this.meshes.set(def.id, mesh)
    }
    if (this.selectedId && !this.meshes.has(this.selectedId)) this.selectedId = null
    this.applySelection()
  }

  setSelected(id: string | null) {
    this.selectedId = id
    this.applySelection()
  }

  private applySelection() {
    for (const [id, mesh] of this.meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.emissive = new THREE.Color(id === this.selectedId ? 0x3b82f6 : 0x000000)
      mat.emissiveIntensity = id === this.selectedId ? 0.6 : 0
    }
  }

  // ---------------- 导航网 ----------------

  private navMeshMesh: THREE.Mesh | null = null

  setNavMesh(built: BuiltNavMesh | null) {
    if (this.navMeshMesh) {
      this.navGroup.remove(this.navMeshMesh)
      this.navMeshMesh.geometry.dispose()
      ;(this.navMeshMesh.material as THREE.Material).dispose()
      this.navMeshMesh = null
    }
    if (!built) return

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(built.renderPositions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(built.renderColors, 3))
    geo.setIndex(new THREE.BufferAttribute(built.renderIndices, 1))
    geo.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.1,
      transparent: true,
      opacity: this.navOpacity,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      depthWrite: true,
    })
    this.navMeshMesh = new THREE.Mesh(geo, mat)
    this.navMeshMesh.renderOrder = 2
    this.navGroup.add(this.navMeshMesh)
  }

  private navOpacity = 0.72
  setNavOpacity(v: number) {
    this.navOpacity = v
    if (this.navMeshMesh) {
      ;(this.navMeshMesh.material as THREE.MeshStandardMaterial).opacity = v
    }
  }

  // ---------------- 起终点 / 吸附候选 ----------------

  setEndpoints(start: Vec3 | null, end: Vec3 | null) {
    if (this.startMarker) {
      this.disposeObjectLabels(this.startMarker)
      this.markerGroup.remove(this.startMarker)
      this.startMarker = null
    }
    if (this.endMarker) {
      this.disposeObjectLabels(this.endMarker)
      this.markerGroup.remove(this.endMarker)
      this.endMarker = null
    }
    if (start) this.startMarker = this.makeEndpointMarker(start, '#22c55e', '起')
    if (end) this.endMarker = this.makeEndpointMarker(end, '#ef4444', '终')
  }

  /**
   * CSS2DObject 从场景图移除时其 DOM 元素不会自动删除，
   * 必须手动移除，否则切换工程后旧标签残留在屏幕上。
   */
  private disposeObjectLabels(root: THREE.Object3D) {
    root.traverse((o) => {
      const label = o as CSS2DObject
      if ((label as unknown as { isCSS2DObject?: boolean }).isCSS2DObject && label.element) {
        label.element.remove()
      }
    })
  }

  private makeEndpointMarker(p: Vec3, color: string, text: string): THREE.Object3D {
    const g = new THREE.Group()
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.1, 24),
      new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.35 }),
    )
    cone.position.y = 0.9
    g.add(cone)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.04, 10, 32),
      new THREE.MeshBasicMaterial({ color }),
    )
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.04
    g.add(ring)
    g.position.set(p[0], p[1], p[2])

    const label = document.createElement('div')
    label.className = 'endpoint-label'
    label.textContent = text
    label.style.color = color
    const labelObj = new CSS2DObject(label)
    labelObj.position.set(0, 2.0, 0)
    g.add(labelObj)

    this.markerGroup.add(g)
    return g
  }

  /**
   * 显示起终点在网外时的吸附候选：每个连通分量一个候选点 + 虚线 + 距离标签。
   */
  setSnapCandidates(
    point: Vec3 | null,
    candidates: SnapCandidate[],
    onMesh: boolean,
  ) {
    // 这个方法针对单个端点；为简单起见，调用方分别传入，组按调用顺序重建
    if (!point || onMesh) return

    for (const c of candidates) {
      const color = islandColor(c.componentId)

      // 候选点圆环
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.38, 0.05, 8, 28),
        new THREE.MeshBasicMaterial({ color }),
      )
      ring.rotation.x = Math.PI / 2
      ring.position.set(c.point[0], c.point[1] + 0.05, c.point[2])
      this.snapGroup.add(ring)

      // 从输入点到候选点的虚线
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...point),
        new THREE.Vector3(...c.point),
      ])
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineDashedMaterial({
          color,
          dashSize: 0.35,
          gapSize: 0.2,
          transparent: true,
          opacity: 0.9,
        }),
      )
      line.computeLineDistances()
      this.snapGroup.add(line)

      // 距离标签
      const label = document.createElement('div')
      label.className = 'snap-label'
      label.textContent = `分量 ${c.componentId + 1} · ${c.distance.toFixed(2)}m`
      label.style.borderColor = color
      label.style.color = color
      const obj = new CSS2DObject(label)
      obj.position.set(c.point[0], c.point[1] + 0.9, c.point[2])
      this.snapGroup.add(obj)
    }
  }

  clearSnapCandidates() {
    for (const child of [...this.snapGroup.children]) {
      this.snapGroup.remove(child)
      // 同时移除 CSS2D 标签 DOM
      this.disposeObjectLabels(child)
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose()
        const m = child.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    }
  }

  // ---------------- 路径与角色 ----------------

  setPath(path: Vec3[] | null) {
    this.stopWalk()
    for (const child of [...this.pathGroup.children]) {
      this.pathGroup.remove(child)
      child.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
    }
    this.pathCurve = null
    if (!path || path.length < 2) {
      this.removeAgent()
      return
    }

    const points = path.map((p) => new THREE.Vector3(p[0], p[1] + 0.12, p[2]))
    this.pathCurve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.05)
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(this.pathCurve, Math.max(32, points.length * 6), 0.12, 8, false),
      new THREE.MeshStandardMaterial({
        color: 0xfde047,
        emissive: 0xa16207,
        emissiveIntensity: 0.35,
        roughness: 0.4,
      }),
    )
    this.pathGroup.add(tube)

    // 路径节点小球
    for (const p of points) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xfde047 }),
      )
      s.position.copy(p)
      this.pathGroup.add(s)
    }

    this.ensureAgent()
    this.placeAgent(0)
  }

  private ensureAgent() {
    if (this.agent) return
    const g = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, Math.max(0.2, 1.8 - 0.6), 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.5 }),
    )
    body.position.y = 0.9
    body.name = 'body'
    const baseRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.03, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x93c5fd }),
    )
    baseRing.rotation.x = Math.PI / 2
    baseRing.position.y = 0.02
    g.add(body, baseRing)
    this.pathGroup.add(g)
    this.agent = g
    this.applyAgentDimensions()
  }

  setAgentSize(radius: number, height: number) {
    this.agentRadius = radius
    this.agentHeight = height
    this.applyAgentDimensions()
  }

  private applyAgentDimensions() {
    if (!this.agent) return
    const body = this.agent.getObjectByName('body') as THREE.Mesh
    if (!body) return
    body.geometry.dispose()
    body.geometry = new THREE.CapsuleGeometry(
      this.agentRadius,
      Math.max(0.05, this.agentHeight - this.agentRadius * 2),
      6,
      16,
    )
    body.position.y = this.agentHeight / 2
  }

  private removeAgent() {
    if (this.agent) {
      this.pathGroup.remove(this.agent)
      this.agent.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
      this.agent = null
    }
  }

  private placeAgent(t: number) {
    if (!this.agent || !this.pathCurve) return
    const p = this.pathCurve.getPointAt(Math.min(1, Math.max(0, t)))
    this.agent.position.copy(p)
    if (t < 1) {
      const p2 = this.pathCurve.getPointAt(Math.min(1, t + 0.005))
      v3tmp.subVectors(p2, p)
      if (v3tmp.lengthSq() > 1e-6) {
        this.agent.rotation.y = Math.atan2(v3tmp.x, v3tmp.z)
      }
    }
  }

  get hasPath(): boolean {
    return !!this.pathCurve
  }

  playWalk(durationMs = 6000, onDone?: () => void) {
    this.stopWalk(false)
    if (!this.pathCurve) return
    const start = performance.now()
    this.walkCb = onDone ?? null
    const tick = (now: number) => {
      const t = (now - start) / durationMs
      this.placeAgent(t >= 1 ? 1 : t)
      if (t >= 1) {
        this.walkRaf = 0
        this.walkCb?.()
        this.walkCb = null
        return
      }
      this.walkRaf = requestAnimationFrame(tick)
    }
    this.walkRaf = requestAnimationFrame(tick)
  }

  stopWalk(notify = true) {
    if (this.walkRaf) {
      cancelAnimationFrame(this.walkRaf)
      this.walkRaf = 0
      if (notify && this.walkCb) this.walkCb()
      this.walkCb = null
    }
  }

  resetAgent() {
    this.placeAgent(0)
  }

  // ---------------- 视角 ----------------

  setTopDown(on: boolean) {
    this.topDownMode = on
    if (on) {
      this.controls.enableRotate = false
      this.controls.minPolarAngle = 0
      this.controls.maxPolarAngle = 0
      this.camera.position.set(0, 46, 0.0001)
      this.controls.target.set(0, 0, 0)
    } else {
      this.controls.enableRotate = true
      this.controls.minPolarAngle = 0
      this.controls.maxPolarAngle = Math.PI
      if (Math.abs(this.camera.position.x) < 0.01 && Math.abs(this.camera.position.z) < 0.01) {
        this.camera.position.set(26, 26, 30)
      }
    }
    this.controls.update()
  }

  /** 世界坐标 → 视口 CSS 像素（供测试/调试点击） */
  worldToScreen(p: Vec3): { x: number; y: number } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((-v.y + 1) / 2) * rect.height,
    }
  }

  focusView() {
    const box = new THREE.Box3()
    let any = false
    for (const mesh of this.meshes.values()) {
      const def = this.geometries.get(mesh.userData.defId as string)
      if (def?.visible) {
        box.expandByObject(mesh)
        any = true
      }
    }
    if (!any) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const dist = Math.max(size.x, size.z) * 1.4 + 10
    this.controls.target.copy(center)
    if (this.topDownMode) {
      this.camera.position.set(center.x, dist, center.z)
    } else {
      this.camera.position.set(center.x + dist * 0.7, dist * 0.75, center.z + dist * 0.8)
    }
    this.controls.update()
  }

  // ---------------- 拾取与拖拽 ----------------

  private updateRaycaster(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
  }

  private sourceIntersections(): THREE.Intersection[] {
    const meshes = [...this.meshes.values()].filter((m) => {
      const def = this.geometries.get(m.userData.defId as string)
      return def?.visible
    })
    return this.raycaster.intersectObjects(meshes, false)
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    this.pressInfo = { x: e.clientX, y: e.clientY }
    this.updateRaycaster(e)
    const hits = this.sourceIntersections()
    const top = hits[0]

    // 选择工具下，俯视模式中按住可在 xz 平面拖拽物体（临时禁用轨道相机，避免抢事件）
    if (this.tool === 'select' && top && this.topDownMode) {
      const mesh = top.object as THREE.Mesh
      const defId = mesh.userData.defId as string
      const def = this.geometries.get(defId)
      if (def) {
        const planeY = def.position[1]
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY)
        const p = new THREE.Vector3()
        if (this.raycaster.ray.intersectPlane(plane, p)) {
          this.selectedId = defId
          this.applySelection()
          this.onSelect?.(defId)
          this.dragging = {
            id: defId,
            plane,
            offset: new THREE.Vector3(def.position[0] - p.x, 0, def.position[2] - p.z),
          }
          this.controls.enabled = false
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          return
        }
      }
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) {
      // 光标样式
      this.updateRaycaster(e)
      const over = this.sourceIntersections().length > 0
      this.renderer.domElement.style.cursor =
        this.tool === 'select' ? (over ? 'move' : '') : 'crosshair'
      return
    }
    this.updateRaycaster(e)
    const p = new THREE.Vector3()
    if (this.raycaster.ray.intersectPlane(this.dragging.plane, p)) {
      const nx = p.x + this.dragging.offset.x
      const nz = p.z + this.dragging.offset.z
      this.onDrag?.(this.dragging.id, nx, nz)
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.dragging) {
      this.controls.enabled = true
      this.dragging = null
      return
    }
    if (e.button !== 0 || !this.pressInfo) return
    const moved = Math.hypot(e.clientX - this.pressInfo.x, e.clientY - this.pressInfo.y)
    this.pressInfo = null
    // 拖拽过 OrbitControls 则不放置端点
    if (moved > 5) return
    this.handleClick(e)
  }

  private handleClick(e: PointerEvent) {
    this.updateRaycaster(e)
    const hits3d = this.sourceIntersections()
    const hits: ClickHit[] = hits3d.map((i) => ({
      y: i.point.y,
      objectName: (i.object.userData.defName as string) ?? '?',
    }))

    // 落点：Alt+点击循环选择下一层表面（桥底等场景）
    let point: THREE.Vector3
    if (hits3d.length === 0) {
      point = new THREE.Vector3()
      if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point)) {
        return
      }
    } else {
      const sorted = [...hits3d].sort((a, b) => a.point.y - b.point.y)
      // 从最上层开始；Alt 时降到下一层
      const idx = e.altKey ? Math.min(1, sorted.length - 1) : sorted.length - 1
      point = sorted[idx].point
    }

    if (this.tool === 'select') {
      const id = hits3d.length ? (hits3d[0].object.userData.defId as string) : null
      this.selectedId = id
      this.applySelection()
      this.onSelect?.(id)
      return
    }

    this.onPick?.({
      point: [point.x, point.y, point.z],
      hits,
      alt: e.altKey,
      button: e.button,
    })
  }

  // ---------------- 生命周期 ----------------

  private onResize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
  }

  private animate = () => {
    requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
  }

  dispose() {
    this.stopWalk()
    window.removeEventListener('resize', this.onResize)
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove)
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp)
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labelRenderer.domElement.remove()
  }
}
