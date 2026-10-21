import { createRequire } from "node:module";
import Module from "node:module";
import { describe, expect, it, vi } from "vitest";
import * as ObsidianMock from "./obsidian.mock";
const require = createRequire(import.meta.url);
const internals = Module as unknown as { _load: (...args: unknown[]) => unknown };
const load = internals._load;
internals._load = (request, ...args) => request === "obsidian" ? ObsidianMock : load.call(Module, request, ...args);
let registerMarkerEditor: (plugin: unknown, renderer: unknown) => void;
let visibleMarkerLayouts: (source: string, ranges: Array<{ from: number; to: number }>) => unknown[];
try { ({ visibleMarkerLayouts, registerMarkerEditor } = require("../src/marker-editor.cjs") as { visibleMarkerLayouts: typeof visibleMarkerLayouts; registerMarkerEditor: typeof registerMarkerEditor }); } finally { internals._load = load; }
const marker = "%% col-start %%\n%% col-break %%\nLeft\n%% col-end %%";
describe("Live Preview marker visibility", () => {
  it("does not register an extension when public Live Preview fields are unavailable", () => {
    const registerEditorExtension = vi.fn();
    registerMarkerEditor({ registerEditorExtension }, vi.fn());
    expect(registerEditorExtension).not.toHaveBeenCalled();
  });
  it("renders complete outer regions when the selection is outside", () => {
    expect(visibleMarkerLayouts(`Before\n${marker}`, [{ from: 0, to: 0 }])).toHaveLength(1);
  });
  it("renders implicit and single-column compact layouts and reveals their selected source", () => {
    for (const body of ["Only column", "First\n%% col %%\nSecond"]) {
      const source = `Before\n%% cols %%\n${body}\n%% endcols %%`;
      expect(visibleMarkerLayouts(source, [{ from: 0, to: 0 }])).toHaveLength(1);
      expect(visibleMarkerLayouts(source, [{ from: 22, to: 22 }])).toHaveLength(0);
      expect(visibleMarkerLayouts(`\`\`\`text\n${source}\n\`\`\``, [])).toHaveLength(0);
    }
  });
  it("exposes the complete source for any intersecting selection", () => {
    expect(visibleMarkerLayouts(`Before\n${marker}`, [{ from: 9, to: 9 }])).toHaveLength(0);
    expect(visibleMarkerLayouts(`Before\n${marker}`, [{ from: 0, to: 20 }])).toHaveLength(0);
  });
  it("leaves incomplete marker source and fenced examples native", () => {
    expect(visibleMarkerLayouts("%% col-start %%\n%% col-break %%", [])).toHaveLength(0);
    expect(visibleMarkerLayouts(`\`\`\`text\n${marker}\n\`\`\``, [])).toHaveLength(0);
  });
});
