import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { BuiltNavMesh } from '../lib/navmesh';
import type { Primitive } from '../types';
import { boxGeometry, rampGeometry, stairsGeometry } from '../lib/geometry';

export interface SceneHandle {
  // 俯视交互由内部实现，暴露点击拾取
}

interface Props {
  primitives: Primitive[];
  built: BuiltNavMesh | null;
  path: [number, number, number][] | null;
  start: [number, number, number] | null;
  end: [number, number, number] | null;
  showNavMesh: boolean;
  showSource: boolean;
  selectedRegion: number | null;
  placing: 'start' | 'end' | null;
  onPlace: (which: 'start' | 'end', p: [number, number, number]) => void;
  onSelectPrimitive?: (id: string | null) => void;
}

// 每个连通区分配一个区分色
const REGION_COLORS = [
  0x4fc3f7, 0x81c784, 0xffb74d, 0xe57373, 0xba68c8, 0x4db6ac,
  0xaed581, 0xfff176, 0x64b5f6, 0xf06292, 0x7986cb, 0xa1887f,
];

export function NavScene(props: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.OrthographicCamera;
    sourceGroup?: THREE.Group;
    navGroup?: THREE.Group;
    pathLine?: THREE.Line;
    markers?: THREE.Group;
    raycaster?: THREE.Raycaster;
    groundMesh?: THREE.Mesh;
    dom?: HTMLDivElement;
    built?: BuiltNavMesh | null;
  }>({});

  // 初始化
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101418);
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    // 俯视：从正上偏斜一点（先纯俯视，支持旋转）
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    const sourceGroup = new THREE.Group();
    const navGroup = new THREE.Group();
    const markers = new THREE.Group();
    scene.add(sourceGroup, navGroup, markers);

    // 灯光（仅影响实体材质观感）
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(10, 20, 8);
    scene.add(dir);

    const raycaster = new THREE.Raycaster();

    const st = stateRef.current;
    st.renderer = renderer; st.scene = scene; st.camera = camera;
    st.sourceGroup = sourceGroup; st.navGroup = navGroup; st.markers = markers;
    st.raycaster = raycaster; st.dom = mount;

    // 网格地面参考
    const grid = new THREE.GridHelper(40, 40, 0x33414d, 0x1c2630);
    (grid.material as THREE.Material).transparent = true;
    grid.position.y = 0.001;
    scene.add(grid);

    // ===== 俯视相机控制（平移 + 缩放 + 旋转）=====
    const view = { scale: 1.2, rot: 0, tx: 0, tz: 0 };
    const applyCam = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      const aspect = w / h;
      const v = 8 * view.scale;
      camera.left = -v * aspect; camera.right = v * aspect;
      camera.top = v; camera.bottom = -v;
      camera.updateProjectionMatrix();
      // 相机固定在目标正上方俯视；屏幕“上”对应世界 -Z
      camera.position.set(view.tx, 80, view.tz);
      camera.up.set(0, 0, -1);
      camera.lookAt(view.tx, 0, view.tz);
      // 旋转由内容组承担（相机本身不转，避免双重旋转）
      sourceGroup.rotation.y = view.rot;
      navGroup.rotation.y = view.rot;
      markers.rotation.y = view.rot;
      grid.rotation.y = view.rot;
    };
    const resize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight, false);
      applyCam();
    };
    resize();
    window.addEventListener('resize', resize);

    let mode: 'none' | 'pan' = 'none';
    let lastX = 0, lastY = 0;
    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      mode = 'pan'; lastX = e.clientX; lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (mode !== 'pan') return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      // 屏幕像素 -> 世界坐标；相机固定俯视（屏幕右=+X，屏幕下=+Z），不随组旋转
      const worldPerPx = (16 * view.scale) / mount.clientHeight;
      view.tx -= dx * worldPerPx;
      view.tz -= dy * worldPerPx;
      applyCam();
    };
    const onUp = (e: PointerEvent) => {
      const moved = Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
      mode = 'none';
      if (moved < 4) handleClick(e);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.scale *= e.deltaY > 0 ? 1.1 : 0.9;
      view.scale = Math.max(0.2, Math.min(8, view.scale));
      applyCam();
    };
    // 右键旋转
    const onContext = (e: MouseEvent) => e.preventDefault();
    let rotStartX = 0, rotStartRot = 0, rotating = false;
    const onRDown = (e: PointerEvent) => {
      if (e.button !== 2) return;
      rotating = true; rotStartX = e.clientX; rotStartRot = view.rot;
    };
    const onRMove = (e: PointerEvent) => {
      if (!rotating) return;
      view.rot = rotStartRot + (e.clientX - rotStartX) * 0.01;
      applyCam();
    };
    const onRUp = () => { rotating = false; };

    const handleClick = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // 放置起终点：优先与导航网求交，否则与地面 y=0
      if (propsRef.current.placing) {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const hit = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, hit);
        if (hit) {
          // 旋转补偿（markers/source 随组旋转，求交在世界坐标，转回组坐标）
          const cos = Math.cos(-view.rot), sin = Math.sin(-view.rot);
          const lx = hit.x * cos - hit.z * sin;
          const lz = hit.x * sin + hit.z * cos;
          propsRef.current.onPlace(propsRef.current.placing, [lx, 0, lz]);
        }
        return;
      }
      // 选择图元
      const hits = raycaster.intersectObjects(sourceGroup.children, true);
      const obj = hits.find((h) => h.object.userData.primitiveId)?.object;
      propsRef.current.onSelectPrimitive?.(obj ? (obj.userData.primitiveId as string) : null);
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContext);
    dom.addEventListener('pointerdown', onRDown);
    window.addEventListener('pointermove', onRMove);
    window.addEventListener('pointerup', onRUp);

    const animate = () => {
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.removeEventListener('resize', resize);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('contextmenu', onContext);
      dom.removeEventListener('pointerdown', onRDown);
      window.removeEventListener('pointermove', onRMove);
      window.removeEventListener('pointerup', onRUp);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用 ref 保存最新 props，避免重建场景
  const propsRef = useRef(props);
  propsRef.current = props;

  // 源网格更新
  useEffect(() => {
    const st = stateRef.current;
    if (!st.sourceGroup) return;
    st.sourceGroup.children.length = 0;
    if (!props.showSource) return;
    for (const prim of props.primitives) {
      const g = prim.kind === 'box' ? boxGeometry(prim)
        : prim.kind === 'ramp' ? rampGeometry(prim)
        : stairsGeometry(prim);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geo.setIndex(g.indices);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: prim.kind === 'box' ? 0x90a4ae : prim.kind === 'ramp' ? 0xc9a227 : 0x8d6e63,
        roughness: 0.85, metalness: 0.05,
        transparent: true, opacity: 0.92,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.primitiveId = prim.id;
      st.sourceGroup.add(mesh);
      // 边线
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 20),
        new THREE.LineBasicMaterial({ color: 0x263238, transparent: true, opacity: 0.5 }),
      );
      mesh.add(edges);
    }
  }, [props.primitives, props.showSource]);

  // 导航网更新
  useEffect(() => {
    const st = stateRef.current;
    if (!st.navGroup) return;
    st.navGroup.children.length = 0;
    const built = props.built;
    if (!built || !props.showNavMesh) return;
    const { positions, indices, regionOfTri } = built;
    // 每个 region 一个 geometry
    const byRegion = new Map<number, number[]>();
    for (let t = 0; t < indices.length / 3; t++) {
      const r = props.selectedRegion == null ? regionOfTri[t] : (regionOfTri[t] === props.selectedRegion ? regionOfTri[t] : -1);
      if (r < 0) continue;
      const arr = byRegion.get(r) ?? [];
      arr.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
      byRegion.set(r, arr);
    }
    for (const [region, idx] of byRegion) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const color = REGION_COLORS[(region - 1) % REGION_COLORS.length];
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.6, metalness: 0.1,
        transparent: true, opacity: 0.55, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
      st.navGroup.add(new THREE.Mesh(geo, mat));
    }
  }, [props.built, props.showNavMesh, props.selectedRegion]);

  // 路径线
  useEffect(() => {
    const st = stateRef.current;
    if (!st.scene || !st.navGroup) return;
    // 移除旧线
    const old = st.scene.getObjectByName('agentpath');
    if (old) st.scene.remove(old);
    if (!props.path || props.path.length < 2) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(props.path.flat(), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xff5252, linewidth: 2 });
    const line = new THREE.Line(geo, mat);
    line.name = 'agentpath';
    // 路径放在 navGroup 内随旋转
    st.navGroup.add(line);
  }, [props.path]);

  // 起终点标记 + 角色代理圆柱
  useEffect(() => {
    const st = stateRef.current;
    if (!st.markers) return;
    st.markers.children.length = 0;
    const addMarker = (p: [number, number, number] | null, color: number, disc: boolean) => {
      if (!p) return;
      if (disc) {
        const geo = new THREE.CylinderGeometry(0.35, 0.35, 0.08, 24);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
        m.position.set(p[0], 0.05, p[2]);
        st.markers!.add(m);
      } else {
        const geo = new THREE.SphereGeometry(0.28, 20, 20);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
        m.position.set(p[0], Math.max(0.3, p[1]), p[2]);
        st.markers!.add(m);
      }
    };
    addMarker(props.start, 0x66bb6a, true);
    addMarker(props.end, 0xef5350, true);
  }, [props.start, props.end]);

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0, cursor: props.placing ? 'crosshair' : 'grab' }} />;
}
