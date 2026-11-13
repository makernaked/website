"use client";

import dynamic from "next/dynamic";

// The editor depends on browser APIs (canvas, localStorage, DOMParser), so it is client-only.
const StringArtApp = dynamic(() => import("./StringArtApp"), {
  ssr: false,
  loading: () => <div className="h-dvh bg-neutral-950" />,
});

export default function StringArtLoader() {
  return <StringArtApp />;
}
