import type { Vector3Tuple } from '@recast-navigation/core';

/** 轴对齐盒体障碍：center 为盒体中心，size 为全尺寸 */
export interface BoxPrimitive {
  id: string;
  kind: 'box';
  name: string;
  center: [number, number, number];
  size: [number, number, number];
}

/**
 * 斜坡（楔体）。底面中心 (centerX, centerZ) 位于 y=baseY；
 * 斜面沿上升轴方向（axis='z' 时为 +Z，axis='x' 时为 +X），
 * 长度沿上升轴、宽度沿另一水平轴。高侧（顶 highY）位于正方向端。
 */
export interface RampPrimitive {
  id: string;
  kind: 'ramp';
  name: string;
  centerX: number;
  centerZ: number;
  width: number;
  length: number; // 沿上升轴的水平投影长度
  baseY: number;
  highY: number;
  axis: 'x' | 'z';
  /** 高端朝向：+1 朝轴正方向（默认），-1 朝负方向 */
  dir?: 1 | -1;
}

/**
 * 整体台阶：沿上升轴逐级上升的实心阶梯。
 * (centerX,centerZ) 为包围盒底面中心；width 沿宽度轴，length 沿上升轴，
 * totalHeight 总升高，steps 级数（每级高 totalHeight/steps，深 length/steps），
 * dir=+1 时最高一级在正方向端。
 */
export interface StairsPrimitive {
  id: string;
  kind: 'stairs';
  name: string;
  centerX: number;
  centerZ: number;
  width: number;
  length: number;
  totalHeight: number;
  steps: number;
  axis: 'x' | 'z';
  dir?: 1 | -1;
}

export type Primitive = BoxPrimitive | RampPrimitive | StairsPrimitive;

export type Vec3 = [number, number, number];

/** 导航网生成参数（同时作为角色代理参数） */
export interface BuildSettings {
  radius: number; // 角色半径 (m)
  height: number; // 角色高度 (m)
  climb: number; // 可爬台阶高度 (m)
  maxSlopeDeg: number; // 最大可行坡度 (°)
  cellSize: number; // 体素尺寸 cs/ch (m)
}

export interface Endpoint {
  pos: Vec3 | null;
}

export interface ProjectData {
  version: 1;
  name: string;
  primitives: Primitive[];
  settings: BuildSettings;
  start: Vec3 | null;
  end: Vec3 | null;
  createdAt: string;
  updatedAt: string;
}

export type { Vector3Tuple };
