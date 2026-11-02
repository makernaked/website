"use client";

import { useRef } from "react";
import { objBounds, unionBounds } from "./geometry";
import { ART_ACCEPT, importFiles, openProject, pickFiles, saveProject } from "./io";
import {
  addReferenceShape,
  deleteSelection,
  duplicateSelection,
  getState,
  newProject,
  redo,
  setState,
  SHAPE_PRESETS,
  undo,
  useEditor,
} from "./store";
import { Btn, Icon, Segmented } from "./ui";
import { fit, home, zoomAt } from "./view";

function Divider() {
  return <div className="mx-1 h-5 w-px bg-neutral-800" />;
}

export default function Toolbar() {
  const units = useEditor((s) => s.units);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const snap = useEditor((s) => s.display.snap);
  const shapesMenu = useRef<HTMLDetailsElement>(null);

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-3">
      <div className="mr-3 flex items-baseline gap-2">
        <span className="font-title text-xl text-neutral-100">String Art</span>
        <span className="hidden text-[11px] tracking-wider text-neutral-500 uppercase lg:inline">Nail planner</span>
      </div>

      <Btn variant="ghost" title="New project" onClick={() => confirm("Start a new project? Unsaved work will be cleared.") && newProject()}>
        <Icon name="file" />
      </Btn>
      <Btn variant="ghost" title="Open project file" onClick={() => void openProject()}>
        <Icon name="open" />
      </Btn>
      <Btn variant="ghost" title="Save project file" onClick={saveProject}>
        <Icon name="save" />
      </Btn>
      <Divider />
      <Btn title="Import SVG or DXF artwork" onClick={async () => importFiles(await pickFiles(ART_ACCEPT, true))}>
        <Icon name="import" /> Import art
      </Btn>
      <details ref={shapesMenu} className="relative">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-sm hover:bg-neutral-700 [&::-webkit-details-marker]:hidden">
          <Icon name="shapes" /> Add shape
        </summary>
        <div className="absolute top-full left-0 z-20 mt-1 w-40 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
          {SHAPE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                addReferenceShape(p);
                shapesMenu.current?.removeAttribute("open");
              }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-800"
            >
              {p.label}
            </button>
          ))}
        </div>
      </details>
      <Divider />
      <Btn variant="ghost" title="Undo (⌘/Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Icon name="undo" />
      </Btn>
      <Btn variant="ghost" title="Redo (⌘/Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Icon name="redo" />
      </Btn>
      <Btn variant="ghost" title="Duplicate (⌘/Ctrl+D)" onClick={duplicateSelection} disabled={!hasSelection}>
        <Icon name="copy" />
      </Btn>
      <Btn variant="ghost" title="Delete (Del)" onClick={deleteSelection} disabled={!hasSelection}>
        <Icon name="trash" />
      </Btn>
      <Divider />
      <Btn
        variant="ghost"
        title={`Snap to ruler ticks: ${snap ? "on" : "off"} (hold Alt to bypass)`}
        active={snap}
        onClick={() => setState((s) => ({ display: { ...s.display, snap: !s.display.snap } }))}
      >
        <Icon name="magnet" />
      </Btn>

      <div className="ml-auto flex items-center gap-1">
        <Segmented
          value={units}
          options={[
            { value: "in", label: "in" },
            { value: "mm", label: "mm" },
          ]}
          onChange={(u) => setState({ units: u })}
        />
        <Divider />
        <Btn variant="ghost" title="Zoom out (−)" onClick={() => zoomAt(0.8)}>
          <Icon name="minus" />
        </Btn>
        <Btn variant="ghost" title="Zoom in (+)" onClick={() => zoomAt(1.25)}>
          <Icon name="plus" />
        </Btn>
        <Btn variant="ghost" title="Fit everything (F)" onClick={() => fit(unionBounds(getState().objects.map(objBounds)))}>
          <Icon name="fit" />
        </Btn>
        <Btn variant="ghost" title="Home: centre on origin (0 or Home)" onClick={home}>
          <Icon name="home" />
        </Btn>
      </div>
    </header>
  );
}
