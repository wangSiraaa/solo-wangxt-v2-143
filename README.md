# NavMesh Studio · 浏览器内导航网编辑工具

给关卡设计师检查**角色能否穿过狭窄通道**的纯前端工具：在浏览器里摆放地形，
由 [`recast-navigation`](https://github.com/isaac-mason/recast-navigation-js) 的 WASM 构建
（Recast 体素化 + Detour 寻路），React + Three.js 渲染。**不依赖任何后端**，
工程保存在 IndexedDB（另有 localStorage 草稿自动保存）。

路径是 Detour 沿**导航多边形走廊**做 `findPath` + `findStraightPath` 得到的，
不是在地形表面画一条直线。

## 运行

```bash
npm install
npm run dev        # 开发服务器
# 或
npm run build && npm run preview
```

## 角色代理参数如何决定可通行区域

| 参数 | Recast 映射 | 对可行走区域的影响 |
| --- | --- | --- |
| 角色半径 r | `walkableRadius = round(r/cs)` 体素 | 从墙、门垛边缘按半径**侵蚀**可行走跨度，窄门净宽不足时通道消失 |
| 角色高度 h | `walkableHeight = round(h/ch)` 体素 | 体素化时过滤“脚下到头顶”净空不足的跨度，桥洞/门梁过低时被切断 |
| 可爬台阶 c | `walkableClimb = round(c/ch)` 体素 | 邻接跨度的高差超过它就不可走，门槛/台阶因此形成阻断 |
| 最大坡度 | `walkableSlopeAngle`（度） | 三角形法线与竖直方向夹角超过它即标记为不可行走，斜坡失效 |

`cs/ch`（水平/垂直体素尺寸）、tile 尺寸、最小区域面积等高级参数也可调。

## 功能

- **源几何编辑**：盒体 / 斜坡（三角棱柱，含真实坡度），位置尺寸参数化；俯视下可拖拽移动。
- **导航网可视化**：detail mesh 三角面叠加显示，按**连通分量**（沿 Detour 的多边形邻接 link 做 BFS）分色，图例给出面积/三角面数。
- **起终点查询**：
  - 点在网外时，列出**每个连通分量上的最近吸附候选与 3D 距离**（3D 场景里画虚线、圆环与距离标签，面板里列出芯片）。
  - 起终点分属不同分量时明确报告**不可达**，不会画出穿过缺口的线。
  - 可达时显示贴地折线路径，可播放**胶囊角色沿路径行走**演示。
- **三个验算场景**（一键载入）：桥下净空、窄门+门槛、多层平台（详见下）。
- **二维俯视操作**：切换正交俯视，在 xz 平面点选/拖拽。
- **工程持久化**：IndexedDB 多工程列表；编辑中自动写 localStorage 草稿，刷新不丢。
- **导出 / 导入 JSON**：导出同时保留**全部源网格定义**与**生成设置**（角色四参数 + 体素参数，附换算后的体素值），另带一份烘焙好的导航网三角面仅供外部预览。

## 三个验算场景与预期

1. **桥下净空**：通道净高 2.0 m。身高 1.8 m 能穿（南北同一区域，路径长约 22 m）；
   身高调到 2.4 m 时桥洞被低净空过滤切断，前后成为分离区域，报告不可达。
2. **窄门**：门垛净宽 1.2 m、门槛 0.3 m、梁底 2.3 m。
   - r=0.3 / climb=0.5 / h=1.8：可过；
   - r=0.6：半径侵蚀后门消失，两侧分离；
   - 可爬台阶 0.2：门槛不可越；
   - h=2.4：过梁挡头。
3. **多层平台**：12° 斜坡 + 0.3 m 坡顶台阶通向 2 m 平台；另有 0.8 m 矮台、
   **无连接的 2.5 m 孤立高台**、柱撑**悬空二层板**（其顶部是独立分量）。
   默认参数可沿坡登上平台；坡度限制 10° 或可爬台阶 0.2 m 时路径失效。

参数滑杆每次改动都会防抖重建导航网并重算路径——旧路径会随可行走区域变化而出现/消失。

## 代码结构

```
src/
  types.ts            数据类型与默认参数
  presets.ts          三个验算场景
  storage.ts          IndexedDB 封装
  nav/
    geometry.ts       盒体/斜坡 → 三角形（自动法线朝向校验）
    recast.ts         WASM 生成、连通分量 BFS、吸附候选、寻路
  scene/
    StudioScene.ts    Three.js 场景：渲染、拾取、俯视拖拽、路径/角色动画、3D 标签
  ui/Controls.tsx     表单控件
  App.tsx             状态、防抖重建、查询、IndexedDB/导入导出、面板布局
test/
  scenarios.ts        无头 WASM 逻辑验算（59 项断言）
  e2e.mjs             Puppeteer 端到端（19 项，含参数变化使路径失效、IndexedDB、导出、刷新恢复）
  e2e-extra.mjs       网外吸附候选与 JSON 导入往返
```

## 测试

```bash
npm test            # tsc 类型检查 + 59 项无头 WASM 验算
npm run test:e2e    # 需要 Chromium；可用 CHROME_PATH 指定可执行文件
```

E2E 通过 Puppeteer 驱动，会在 `test/screenshots/` 留下各场景截图。
