"use client";
// src/components/workflow/WorkflowCanvas.tsx
import { useEffect, useCallback, useRef } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type Viewport,
} from "reactflow";
import "reactflow/dist/style.css";

import { useWorkflowStore, useTemporalStore } from "@/store/workflow-store";
import { NodeSidebar } from "./NodeSidebar";
import { HistoryPanel } from "./HistoryPanel";
import { WorkflowHeader } from "./WorkflowHeader";
import { WorkflowToolbar } from "./WorkflowToolbar";
import { TextNode } from "@/components/nodes/TextNode";
import { ImageNode } from "@/components/nodes/ImageNode";
import { VideoNode } from "@/components/nodes/VideoNode";
import { LLMNode } from "@/components/nodes/LLMNode";
import { CropNode } from "@/components/nodes/CropNode";
import { ExtractFrameNode } from "@/components/nodes/ExtractFrameNode";
import type { FlowNode, FlowEdge, WorkflowRunRecord } from "@/types";
import { NODE_DEFS, HANDLE_COLORS } from "@/lib/node-definitions";
import { useToast } from "@/components/ui/use-toast";
import { Toaster } from "@/components/ui/toaster";

// Register custom node types
const nodeTypes = {
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  llm: LLMNode,
  crop: CropNode,
  extract: ExtractFrameNode,
};

interface Props {
  workflowId: string;
  initialNodes: FlowNode[];
  initialEdges: FlowEdge[];
  initialViewport: Viewport;
  initialRuns: WorkflowRunRecord[];
}

// Inner component that uses useReactFlow()
function Canvas({ workflowId, initialNodes, initialEdges, initialViewport, initialRuns }: Props) {
  const { fitView, getViewport } = useReactFlow();
  const { toast } = useToast();
  const saveTimer = useRef<NodeJS.Timeout | null>(null);

  const {
    nodes, edges, onNodesChange, onEdgesChange, onConnect,
    addNode, loadWorkflow, saveWorkflow, setViewport,
    sidebarOpen, historyOpen, toggleSidebar, toggleHistory,
    isRunning, selectedNodeIds, runs, setRuns,
  } = useWorkflowStore();

  const { undo, redo } = useTemporalStore.getState();

  // Load initial data
  useEffect(() => {
    loadWorkflow(workflowId, initialNodes, initialEdges, initialViewport);
    setRuns(initialRuns);
  }, [workflowId]);

  // Auto-save with debounce
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const vp = getViewport();
      setViewport(vp);
      saveWorkflow();
    }, 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [nodes, edges]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveWorkflow(); toast({ description: "Workflow saved ✓" }); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Drag from sidebar onto canvas
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/nextflow-node");
    if (!type || !NODE_DEFS[type]) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const vp = getViewport();
    const x = (e.clientX - rect.left - vp.x) / vp.zoom;
    const y = (e.clientY - rect.top - vp.y) / vp.zoom;
    addNode(type, { x: x - 120, y: y - 40 });
  }, [addNode, getViewport]);

  // Run workflow
  const runWorkflow = useCallback(async (scope: "FULL" | "SELECTED" | "SINGLE") => {
    const store = useWorkflowStore.getState();
    const targetIds = scope === "FULL"
      ? store.nodes.map((n) => n.id)
      : store.selectedNodeIds;

    if (!targetIds.length) {
      toast({ description: "No nodes selected", variant: "destructive" });
      return;
    }

    useWorkflowStore.setState({ isRunning: true });
    store.resetNodeStatuses();

    // Mark nodes as running
    targetIds.forEach((id) => store.setNodeStatus(id, "running"));

    try {
      const res = await fetch("/api/run/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId,
          nodeIds: targetIds,
          scope,
          nodes: store.nodes,
          edges: store.edges,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Execution failed");

      const run = data.run;

      // Update node statuses from results
      run.nodeRuns.forEach((nr:any) => {
        store.setNodeStatus(
          nr.nodeId,
          nr.status === "SUCCESS" ? "done" : "error",
          nr.output ?? undefined
        );
      });

      // Add to history
      store.addRun(run);

      const allOk = run.status === "SUCCESS";
      toast({
        description: allOk
          ? `✓ Workflow completed in ${(run.durationMs / 1000).toFixed(1)}s`
          : `⚠ Finished with errors`,
        variant: allOk ? "default" : "destructive",
      });
    } catch (err: any) {
      toast({ description: err.message ?? "Execution error", variant: "destructive" });
    } finally {
      useWorkflowStore.setState({ isRunning: false });
    }
  }, [workflowId, toast]);

  // Edge color by type
  const edgeOptions = {
    style: { strokeDasharray: "6 3" },
    animated: true,
  };

  const edgeColor = (edge: FlowEdge) => {
    // Determine color from source node handle
    return HANDLE_COLORS["text"];
  };

  return (
    <div className="flex flex-col h-screen bg-bg overflow-hidden">
      <WorkflowHeader
        onRunAll={() => runWorkflow("FULL")}
        onRunSelected={() => runWorkflow("SELECTED")}
        onUndo={undo}
        onRedo={redo}
        onToggleSidebar={toggleSidebar}
        onToggleHistory={toggleHistory}
        isRunning={isRunning}
        hasSelection={selectedNodeIds.length > 0}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <div
          className="transition-all duration-200 overflow-hidden flex-shrink-0"
          style={{ width: sidebarOpen ? 220 : 0 }}
        >
          <NodeSidebar onAddNode={addNode} />
        </div>

        {/* Canvas */}
        <div className="flex-1 relative overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(conn) => {
              const ok = onConnect(conn);
              if (!ok) toast({ description: "⚠ Type mismatch or circular connection blocked", variant: "destructive" });
            }}
            onDrop={onDrop}
            onDragOver={onDragOver}
            defaultViewport={initialViewport}
            minZoom={0.2}
            maxZoom={2.5}
            deleteKeyCode={["Delete", "Backspace"]}
            multiSelectionKeyCode="Shift"
            fitView={!initialNodes.length}
            className="bg-bg"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              color="#2a2a38"
            />
            <Controls className="react-flow__controls" />
            <MiniMap
              nodeColor={(node) => {
                const colors: Record<string, string> = {
                  text: "#7c6af7", image: "#ff8c42", video: "#4da6ff",
                  llm: "#3ddc97", crop: "#f5c842", extract: "#ff6eb4",
                };
                return colors[node.type ?? "text"] ?? "#444";
              }}
              maskColor="rgba(0,0,0,0.7)"
              className="react-flow__minimap"
            />

            {/* Empty state overlay */}
            {nodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                <div className="text-center">
                  <div className="text-5xl mb-4 opacity-20">◈</div>
                  <p className="text-text-3 text-sm">Drop nodes to build your workflow</p>
                  <p className="text-text-3 text-xs opacity-60 mt-1">Drag from the sidebar or click +</p>
                </div>
              </div>
            )}
            <WorkflowToolbar />
          </ReactFlow>
        </div>

        {/* Right history panel */}
        <div
          className="transition-all duration-200 overflow-hidden flex-shrink-0"
          style={{ width: historyOpen ? 268 : 0 }}
        >
          <HistoryPanel runs={runs} />
        </div>
      </div>

      <Toaster />
    </div>
  );
}

// Export wrapped in provider
export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
