"use client";

import { buildDXF, buildGcode } from "./cnc";
import { objBounds } from "./geometry";
import { importDXF } from "./import-dxf";
import { importSVG } from "./import-svg";
import { addObjects, getState, loadProject, makeArtwork, notify, projectJSON } from "./store";
import { fit, isVisible } from "./view";

export function download(name: string, data: Blob | string, type = "text/plain") {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and resolves with the chosen files. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

export const ART_ACCEPT = ".svg,.dxf,image/svg+xml";

/** Imports SVG/DXF artwork files, or a project file if one is dropped. */
export async function importFiles(files: File[]) {
  const added = [];
  const warnings: string[] = [];
  for (const file of files) {
    const ext = file.name.toLowerCase().split(".").pop();
    try {
      const text = await file.text();
      if (ext === "json") {
        loadProject(text);
        notify(`Opened ${file.name}`);
        return;
      }
      const result =
        ext === "dxf" ? importDXF(text, getState().units) : ext === "svg" ? importSVG(text) : null;
      if (!result) {
        warnings.push(`${file.name}: only SVG and DXF files can be imported.`);
        continue;
      }
      const art = makeArtwork(file.name.replace(/\.[^.]+$/, ""), result.contours, result.hiddenLayers);
      if (!art) {
        warnings.push(`${file.name}: no shapes found.`);
        continue;
      }
      added.push(art);
      warnings.push(...result.warnings.map((w) => `${file.name}: ${w}`));
    } catch (e) {
      warnings.push(`${file.name}: ${e instanceof Error ? e.message : "could not be read."}`);
    }
  }
  if (added.length) {
    addObjects(added);
    const b = added.map(objBounds).reduce((a, c) => ({
      minX: Math.min(a.minX, c.minX),
      minY: Math.min(a.minY, c.minY),
      maxX: Math.max(a.maxX, c.maxX),
      maxY: Math.max(a.maxY, c.maxY),
    }));
    if (!isVisible(b)) fit(b);
  }
  if (warnings.length) notify(warnings.join(" "), added.length ? "info" : "error");
}

export async function openProject() {
  const [file] = await pickFiles(".json,application/json");
  if (!file) return;
  try {
    loadProject(await file.text());
    notify(`Opened ${file.name}`);
  } catch (e) {
    notify(e instanceof Error ? e.message : "Couldn't open that file.", "error");
  }
}

export function saveProject() {
  download("string-art-project.json", projectJSON(), "application/json");
}

export async function exportPDF() {
  try {
    const { buildPDF } = await import("./pdf");
    download("string-art-template.pdf", buildPDF(getState()));
  } catch (e) {
    notify(e instanceof Error ? e.message : "Couldn't create the PDF.", "error");
  }
}

export function exportGcode() {
  const s = getState();
  if (!s.pattern?.nails.length) return notify("Calculate the nail pattern first.", "error");
  download("string-art-nails.nc", buildGcode(s.pattern, s.gcode));
}

export function exportDXF() {
  const s = getState();
  if (!s.pattern?.nails.length) return notify("Calculate the nail pattern first.", "error");
  download("string-art-nails.dxf", buildDXF(s.pattern, s.gcode, s.settings.nailDiameter), "application/dxf");
}
