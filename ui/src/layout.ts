import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphEdge, GraphNode } from './types.js';

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 78;

export type PositionMap = Map<string, { x: number; y: number }>;

// Anchor centers for the 8 memory types on a 4×2 grid; the force simulation
// pulls each node toward its type anchor, so stores read as type regions
// instead of one column, while links still cluster across regions.
const TYPE_ORDER = [
  'preference',
  'decision',
  'fact',
  'procedure',
  'person',
  'project-state',
  'lesson',
  'session',
] as const;

const REGION_SPREAD = 420;
const COLS = 4;

const anchorFor = (type: string): { x: number; y: number } => {
  const index = Math.max(0, TYPE_ORDER.indexOf(type as (typeof TYPE_ORDER)[number]));
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { x: col * REGION_SPREAD, y: row * REGION_SPREAD };
};

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  type: string;
}

// Deterministic force-directed layout over the FULL graph; call once per graph
// payload so filtering never reshuffles positions. Seeded spiral init + fixed
// tick count keeps the result stable across refreshes.
export const computePositions = (
  nodes: GraphNode[],
  edges: GraphEdge[],
): PositionMap => {
  const layoutNodes: LayoutNode[] = nodes.map((node, index) => {
    const anchor = anchorFor(node.type);
    const angle = index * 2.399963; // golden angle
    const radius = 14 * Math.sqrt(index);
    return {
      id: node.id,
      type: node.type,
      x: anchor.x + radius * Math.cos(angle),
      y: anchor.y + radius * Math.sin(angle),
    };
  });
  const byId = new Map(layoutNodes.map((node) => [node.id, node]));
  const links = edges
    .filter((edge) => byId.has(edge.fromId) && byId.has(edge.toId))
    .map((edge) => ({ source: byId.get(edge.fromId)!, target: byId.get(edge.toId)! }));

  const simulation = forceSimulation(layoutNodes)
    .force(
      'link',
      forceLink(links).distance(150).strength(0.5),
    )
    .force('charge', forceManyBody().strength(-320))
    .force('collide', forceCollide().radius(72).iterations(2))
    .force('type-x', forceX<LayoutNode>((node) => anchorFor(node.type).x).strength(0.14))
    .force('type-y', forceY<LayoutNode>((node) => anchorFor(node.type).y).strength(0.1))
    .stop()
    .tick(320);

  const positions: PositionMap = new Map();
  for (const node of simulation.nodes()) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }
  return positions;
};
