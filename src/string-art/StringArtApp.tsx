"use client";

import { useEffect } from "react";
import CanvasView from "./CanvasView";
import Sidebar from "./Sidebar";
import { setState, useEditor } from "./store";
import Toolbar from "./Toolbar";

function Notice() {
  const notice = useEditor((s) => s.notice);
  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const t = setTimeout(() => setState({ notice: null }), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      role="status"
      className={`absolute top-8 left-1/2 z-10 flex max-w-xl -translate-x-1/2 items-start gap-3 rounded-md border px-3 py-2 text-sm shadow-lg ${
        notice.kind === "error" ? "border-red-500/40 bg-red-950/90 text-red-100" : "border-neutral-700 bg-neutral-900/95 text-neutral-200"
      }`}
    >
      <span>{notice.text}</span>
      <button type="button" className="text-neutral-400 hover:text-white" aria-label="Dismiss" onClick={() => setState({ notice: null })}>
        ✕
      </button>
    </div>
  );
}

export default function StringArtApp() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-neutral-950 font-sans text-neutral-200">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <CanvasView />
          <Notice />
        </main>
        <Sidebar />
      </div>
    </div>
  );
}
