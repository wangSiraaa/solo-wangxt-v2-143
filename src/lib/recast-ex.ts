import {
  RecastBuildContext, VerticesArray, TrianglesArray, TriangleAreasArray,
  createRcConfig, calcGridSize, allocHeightfield, createHeightfield,
  markWalkableTriangles, rasterizeTriangles, filterLowHangingWalkableObstacles, filterLedgeSpans,
  filterWalkableLowHeightSpans, allocCompactHeightfield, buildCompactHeightfield, freeHeightfield,
  erodeWalkableArea, buildDistanceField, buildRegions, buildRegionsMonotone, allocContourSet,
  buildContours, Recast, allocPolyMesh, buildPolyMesh, allocPolyMeshDetail, buildPolyMeshDetail,
  NavMeshCreateParams, createNavMeshData,
} from 'recast-navigation';
import type { TriMesh } from './geometry';

export type RegionAlgorithm = 'watershed' | 'monotone';

/**
 * 手工组装的 Solo 导航网生成管线（等价 generators.generateSoloNavMeshData，
 * 但可选择区域划分算法）。
 * watershed 对狭长坡道会产生退化区域；monotone 更稳定，故默认 monotone。
 */
export const generateSoloNavMeshDataEx = (
  mesh: TriMesh,
  config: Record<string, unknown>,
  algorithm: RegionAlgorithm = 'monotone',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const numTriangles = indices.length / 3;
  const ctx = new RecastBuildContext();

  const verticesArray = new VerticesArray();
  verticesArray.copy(positions);
  const trianglesArray = new TrianglesArray();
  trianglesArray.copy(indices);

  const bbMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const bbMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bbMin[k] = Math.min(bbMin[k], positions[i + k]);
      bbMax[k] = Math.max(bbMax[k], positions[i + k]);
    }
  }

  // createRcConfig 内部已合并默认值；这里只覆盖调用方参数
  const rcConfig = createRcConfig(config as Record<string, unknown>);
  rcConfig.minRegionArea = rcConfig.minRegionArea * rcConfig.minRegionArea;
  rcConfig.mergeRegionArea = rcConfig.mergeRegionArea * rcConfig.mergeRegionArea;
  rcConfig.detailSampleDist = rcConfig.detailSampleDist < 0.9 ? 0 : rcConfig.cs * rcConfig.detailSampleDist;
  rcConfig.detailSampleMaxError = rcConfig.ch * rcConfig.detailSampleMaxError;
  const grid = calcGridSize(bbMin, bbMax, rcConfig.cs);
  rcConfig.width = grid.width;
  rcConfig.height = grid.height;

  const heightfield = allocHeightfield();
  if (!createHeightfield(ctx, heightfield, rcConfig.width, rcConfig.height, bbMin, bbMax, rcConfig.cs, rcConfig.ch)) {
    throw new Error('无法创建高度场');
  }
  const triangleAreas = new TriangleAreasArray();
  triangleAreas.resize(numTriangles);
  markWalkableTriangles(ctx, rcConfig.walkableSlopeAngle, verticesArray, positions.length / 3, trianglesArray, numTriangles, triangleAreas);
  rasterizeTriangles(ctx, verticesArray, positions.length / 3, trianglesArray, triangleAreas, numTriangles, heightfield, rcConfig.walkableClimb);
  triangleAreas.destroy();
  verticesArray.destroy();
  trianglesArray.destroy();

  filterLowHangingWalkableObstacles(ctx, rcConfig.walkableClimb, heightfield);
  filterLedgeSpans(ctx, rcConfig.walkableHeight, rcConfig.walkableClimb, heightfield);
  filterWalkableLowHeightSpans(ctx, rcConfig.walkableHeight, heightfield);

  const compact = allocCompactHeightfield();
  if (!buildCompactHeightfield(ctx, rcConfig.walkableHeight, rcConfig.walkableClimb, heightfield, compact)) {
    throw new Error('紧凑高度场构建失败');
  }
  freeHeightfield(heightfield);

  erodeWalkableArea(ctx, rcConfig.walkableRadius, compact);
  buildDistanceField(ctx, compact);
  if (algorithm === 'monotone') {
    if (!buildRegionsMonotone(ctx, compact, rcConfig.borderSize, rcConfig.minRegionArea, rcConfig.mergeRegionArea)) {
      throw new Error('monotone 区域划分失败');
    }
  } else if (!buildRegions(ctx, compact, rcConfig.borderSize, rcConfig.minRegionArea, rcConfig.mergeRegionArea)) {
    throw new Error('区域划分失败');
  }

  const contourSet = allocContourSet();
  buildContours(ctx, compact, rcConfig.maxSimplificationError, rcConfig.maxEdgeLen, contourSet, Recast.RC_CONTOUR_TESS_WALL_EDGES);
  const polyMesh = allocPolyMesh();
  buildPolyMesh(ctx, contourSet, rcConfig.maxVertsPerPoly, polyMesh);
  const detail = allocPolyMeshDetail();
  buildPolyMeshDetail(ctx, polyMesh, compact, rcConfig.detailSampleDist, rcConfig.detailSampleMaxError, detail);

  for (let i = 0; i < polyMesh.npolys(); i++) {
    if (polyMesh.areas(i) === Recast.RC_WALKABLE_AREA) polyMesh.setAreas(i, 0);
    if (polyMesh.areas(i) === 0) polyMesh.setFlags(i, 1);
  }

  const params = new NavMeshCreateParams();
  params.setPolyMeshCreateParams(polyMesh);
  params.setPolyMeshDetailCreateParams(detail);
  params.setWalkableHeight(rcConfig.walkableHeight * rcConfig.ch);
  params.setWalkableRadius(rcConfig.walkableRadius * rcConfig.cs);
  params.setWalkableClimb(rcConfig.walkableClimb * rcConfig.ch);
  params.setCellSize(rcConfig.cs);
  params.setCellHeight(rcConfig.ch);
  params.setBuildBvTree((config.buildBvTree as boolean) ?? true);
  const result = createNavMeshData(params);
  if (!result.success) throw new Error('Detour 数据创建失败');
  return { navMeshData: result.navMeshData };
};
