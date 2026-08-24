import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphEdge, GraphNode } from '../types.js';
import { KIND_STYLES, STATUS_STYLES, TYPE_COLORS } from '../theme.js';
import type { PositionMap } from '../layout.js';

interface MemoryNodeData extends Record<string, unknown> {
  title: string;
  type: GraphNode['type'];
  tier: GraphNode['tier'];
  status: GraphNode['status'];
  scope: string;
  importance: number;
  reliability: number;
}

type MemoryFlowNode = Node<MemoryNodeData, 'memory'>;

function MemoryCard({ data, selected }: NodeProps<MemoryFlowNode>) {
  const status = STATUS_STYLES[data.status];
  return (
    <div
      className={`memory-card${selected ? ' is-selected' : ''}`}
      style={{
        borderColor: status.color,
        borderStyle: status.borderStyle,
        opacity: 0.5 + 0.5 * data.reliability,
      }}
      title={`${data.type} · ${data.tier} · ${data.status} · scope:${data.scope}`}
    >
      <Handle type="target" position={Position.Left} className="card-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="card-handle" isConnectable={false} />
      <div className="card-top">
        <span className="type-chip" style={{ backgroundColor: TYPE_COLORS[data.type] }}>
          {data.type}
        </span>
        <span className="card-importance">imp {data.importance}</span>
      </div>
      <div className="card-title">{data.title}</div>
      <div className="card-rel">
        <div className="rel-bar">
          <span style={{ width: `${Math.round(data.reliability * 100)}%` }} />
        </div>
        <span className="rel-num">{Math.round(data.reliability * 100)}%</span>
      </div>
    </div>
  );
}

const nodeTypes = { memory: MemoryCard };

interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: PositionMap;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const toFlowNode = (
  node: GraphNode,
  positions: PositionMap,
  selectedId: string | null,
): MemoryFlowNode => ({
  id: node.id,
  type: 'memory',
  position: positions.get(node.id) ?? { x: 0, y: 0 },
  selected: node.id === selectedId,
  data: {
    title: node.title,
    type: node.type,
    tier: node.tier,
    status: node.status,
    scope: node.scope,
    importance: node.importance,
    reliability: node.reliability,
  },
});

const toFlowEdge = (edge: GraphEdge): Edge => {
  const kind = KIND_STYLES[edge.kind];
  return {
    id: `${edge.fromId}->${edge.toId}:${edge.kind}`,
    source: edge.fromId,
    target: edge.toId,
    animated: edge.kind === 'contradicts',
    style: {
      stroke: kind.color,
      strokeWidth: 1.5,
      strokeDasharray: kind.lineStyle === 'dashed' ? '6 4' : undefined,
    },
    markerEnd: kind.arrow ? { type: MarkerType.ArrowClosed, color: kind.color } : undefined,
  };
};

export function GraphView({ nodes, edges, positions, selectedId, onSelect }: GraphViewProps) {
  const flowNodes = useMemo(
    () => nodes.map((node) => toFlowNode(node, positions, selectedId)),
    [nodes, positions, selectedId],
  );
  const flowEdges = useMemo(() => edges.map(toFlowEdge), [edges]);

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
        minZoom={0.1}
        maxZoom={2}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#26304f" />
        <MiniMap pannable zoomable bgColor="#0e142a" maskColor="rgba(11,16,32,0.75)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
