import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareLayerStack,
  copperLayers,
  defaultPcbLayers,
  parseBoardLayers,
  parseLayerList,
  plotFileSuffix,
} from "../src/layers.ts";

// Pure-logic tests for PCB layer selection / ordering. The render-level
// behaviour (which per-layer files kicad-cli actually produces) is covered
// in render.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(__dirname, "..", "examples");
const BLINK_PCB = fs.readFileSync(path.join(EXAMPLES, "blink/blink.kicad_pcb"), "utf8");
const FOUR_LAYER_PCB = fs.readFileSync(path.join(EXAMPLES, "four-layer/four-layer.kicad_pcb"), "utf8");

test.describe("parseBoardLayers", () => {
  test("reads the top-level layer table, not pad `(layers …)` lists", () => {
    const layers = parseBoardLayers(BLINK_PCB);
    expect(layers.map(l => l.name)).toEqual([
      "F.Cu", "B.Cu", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts",
    ]);
    expect(layers.find(l => l.name === "F.SilkS")).toEqual({
      name: "F.SilkS", type: "user", userName: "F.Silkscreen",
    });
  });

  test("keeps layer type and user name of copper layers", () => {
    const src = `(kicad_pcb (version 20241229)
      (layers (0 "F.Cu" signal "Top") (4 "In1.Cu" power "GND (plane)") (2 "B.Cu" mixed))
      (footprint "x" (pad "1" smd rect (layers "F.Cu" "F.Mask"))))`;
    expect(parseBoardLayers(src)).toEqual([
      { name: "F.Cu", type: "signal", userName: "Top" },
      { name: "In1.Cu", type: "power", userName: "GND (plane)" },
      { name: "B.Cu", type: "mixed" },
    ]);
  });

  test("accepts the unquoted pre-KiCad-6 layer table form", () => {
    const src = "(kicad_pcb (version 20171130)\n  (layers\n    (0 F.Cu signal)\n    (31 B.Cu signal)\n    (44 Edge.Cuts user)\n  )\n)";
    expect(parseBoardLayers(src).map(l => l.name)).toEqual(["F.Cu", "B.Cu", "Edge.Cuts"]);
  });

  test("returns [] when there is no layer table", () => {
    expect(parseBoardLayers("(kicad_sch (version 1))")).toEqual([]);
  });
});

test.describe("copperLayers", () => {
  test("returns copper in physical stack order regardless of table order", () => {
    const src = `(kicad_pcb (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (10 "In3.Cu" signal)
      (4 "In1.Cu" signal) (6 "In2.Cu" jumper) (5 "F.SilkS" user "F.Silkscreen")))`;
    expect(copperLayers(parseBoardLayers(src)).map(l => l.name))
      .toEqual(["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "B.Cu"]);
  });
});

test.describe("defaultPcbLayers", () => {
  test("2-layer board: exactly the historical fixed layer set", () => {
    expect(defaultPcbLayers(BLINK_PCB).join(",")).toBe("F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts");
  });

  test("4-layer board: inner copper layers are included", () => {
    expect(defaultPcbLayers(FOUR_LAYER_PCB)).toEqual([
      "F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "F.Silkscreen", "B.Silkscreen", "Edge.Cuts",
    ]);
  });

  test("unreadable layer table falls back to the 2-layer default", () => {
    expect(defaultPcbLayers("not a board").join(",")).toBe("F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts");
  });
});

test.describe("parseLayerList", () => {
  test("splits on commas and trims", () => {
    expect(parseLayerList(" F.Cu, In1.Cu ,B.Cu,")).toEqual(["F.Cu", "In1.Cu", "B.Cu"]);
  });

  test("rejects an empty list", () => {
    expect(() => parseLayerList(" , ")).toThrow(/at least one layer/);
  });
});

test.describe("plotFileSuffix", () => {
  // Mirrors kicad-cli's PCB_PLOTTER::BuildPlotFileName: trim, then map
  // DOS-forbidden characters, `%` and `.` to `_`.
  test("matches kicad-cli's per-layer file naming", () => {
    expect(plotFileSuffix("In1.Cu")).toBe("In1_Cu");
    expect(plotFileSuffix("F.Silkscreen")).toBe("F_Silkscreen");
    expect(plotFileSuffix(" GND plane/x.y ")).toBe("GND plane_x_y");
    expect(plotFileSuffix("Pwr:3V3*")).toBe("Pwr_3V3_");
  });
});

test.describe("compareLayerStack", () => {
  test("2-layer order is the historical bottom-to-top order", () => {
    const sorted = ["F.Silkscreen", "F.Cu", "B.Cu", "Edge.Cuts", "B.Silkscreen"].sort(compareLayerStack);
    expect(sorted).toEqual(["Edge.Cuts", "B.Silkscreen", "B.Cu", "F.Cu", "F.Silkscreen"]);
  });

  test("inner copper sits between B.Cu and F.Cu, In1.Cu nearest the front", () => {
    const sorted = ["F.Cu", "In1.Cu", "In10.Cu", "B.Cu", "In2.Cu", "Edge.Cuts"].sort(compareLayerStack);
    expect(sorted).toEqual(["Edge.Cuts", "B.Cu", "In10.Cu", "In2.Cu", "In1.Cu", "F.Cu"]);
  });

  test("other front / back layers group with their side; unknown layers on top", () => {
    const sorted = ["User.Drawings", "F.Fab", "B.Mask", "F.Cu", "B.Cu"].sort(compareLayerStack);
    expect(sorted).toEqual(["B.Mask", "B.Cu", "F.Cu", "F.Fab", "User.Drawings"]);
  });
});
