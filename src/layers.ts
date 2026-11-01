/**
 * PCB layer selection and ordering.
 *
 * kicadiff renders a fixed set of non-copper layers (silkscreen + board
 * outline) plus every copper layer the board defines, read from the
 * board's own `(layers …)` table. A 2-layer board therefore gets exactly
 * the historical `F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts` set, and
 * a 4-layer board additionally gets In1.Cu / In2.Cu instead of silently
 * dropping them. `--layers` / `KICADIFF_LAYERS` override the set.
 *
 * The stacking order defined here (`compareLayerStack`) is mirrored in
 * viewer.html's `layerStackKey` so the composited PNG and the interactive
 * viewer agree.
 */

/** One entry of a .kicad_pcb `(layers …)` table, e.g.
 *  `(4 "In1.Cu" power "GND")` → { name: "In1.Cu", type: "power", userName: "GND" }. */
export interface BoardLayer {
  /** Canonical layer name (`F.Cu`, `In1.Cu`, `F.SilkS`, …). */
  name: string;
  /** Layer type: signal / power / mixed / jumper (copper) or user. */
  type: string;
  /** Optional user-visible name. kicad-cli names per-layer plot files
   *  after this when it is set (see `plotFileSuffix`). */
  userName?: string;
}

/** Non-copper layers rendered by default. Names are what kicad-cli's
 *  `--layers` accepts and what its plot file names use. */
const DEFAULT_NON_COPPER = ["F.Silkscreen", "B.Silkscreen", "Edge.Cuts"] as const;

/** Copper layer types KiCad writes into the layer table. */
const COPPER_TYPES = new Set(["signal", "power", "mixed", "jumper"]);

const COPPER_NAME = /^(F|B|In(\d+))\.Cu$/;

/** Locate the board's top-level `(layers …)` block and return its body.
 *  We can't just search for "(layers": every pad also has a
 *  `(layers "F.Cu" "F.Mask")` list, so track paren depth (and skip quoted
 *  strings, which may contain parens) and only accept the one that is a
 *  direct child of `(kicad_pcb …)`. The table sits near the top of the
 *  file, so this stops after a few hundred bytes on real boards. */
function findTopLevelLayersBlock(src: string): string | null {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\") i++;
      }
    } else if (c === "(") {
      depth++;
      if (depth === 2 && src.startsWith("layers", i + 1) && /[\s()]/.test(src[i + 7] ?? "")) {
        const start = i;
        let d = 0;
        for (let j = i; j < src.length; j++) {
          const cj = src[j];
          if (cj === '"') {
            for (j++; j < src.length && src[j] !== '"'; j++) {
              if (src[j] === "\\") j++;
            }
          } else if (cj === "(") d++;
          else if (cj === ")") {
            d--;
            if (d === 0) return src.slice(start + "(layers".length, j);
          }
        }
        return null;
      }
    } else if (c === ")") {
      depth--;
    }
  }
  return null;
}

const ATOM = String.raw`"(?:[^"\\]|\\.)*"|[^\s()"]+`;
const LAYER_ENTRY = new RegExp(String.raw`\(\s*\d+\s+(${ATOM})\s+(${ATOM})(?:\s+(${ATOM}))?\s*\)`, "g");

function unquote(atom: string): string {
  return atom.startsWith('"') ? atom.slice(1, -1).replace(/\\(.)/g, "$1") : atom;
}

/** Parse the `(layers …)` table of a .kicad_pcb. Returns [] when the
 *  table can't be found (e.g. not a board file). */
export function parseBoardLayers(src: string): BoardLayer[] {
  const block = findTopLevelLayersBlock(src);
  if (block === null) return [];
  const out: BoardLayer[] = [];
  for (const m of block.matchAll(LAYER_ENTRY)) {
    const layer: BoardLayer = { name: unquote(m[1]), type: unquote(m[2]) };
    if (m[3] !== undefined) layer.userName = unquote(m[3]);
    out.push(layer);
  }
  return out;
}

/** Copper layers of the board in physical stack order (F.Cu, In1.Cu …
 *  InN.Cu, B.Cu), regardless of the order the table lists them in. */
export function copperLayers(layers: readonly BoardLayer[]): BoardLayer[] {
  return layers
    .filter(l => COPPER_NAME.test(l.name) && COPPER_TYPES.has(l.type))
    .sort((a, b) => copperDepth(a.name) - copperDepth(b.name));
}

/** 0 for F.Cu, n for Inn.Cu, +Infinity for B.Cu. */
function copperDepth(name: string): number {
  const m = COPPER_NAME.exec(name);
  if (!m) return NaN;
  if (m[1] === "F") return 0;
  if (m[1] === "B") return Infinity;
  return Number(m[2]);
}

/** The layer list passed to `kicad-cli pcb export svg --layers` when the
 *  user hasn't overridden it. Falls back to F.Cu + B.Cu if the board's
 *  layer table can't be read, which reproduces the pre-detection default. */
export function defaultPcbLayers(src: string): string[] {
  const copper = copperLayers(parseBoardLayers(src)).map(l => l.name);
  return [...(copper.length > 0 ? copper : ["F.Cu", "B.Cu"]), ...DEFAULT_NON_COPPER];
}

/** Parse a user-supplied `--layers` / `KICADIFF_LAYERS` value. */
export function parseLayerList(value: string): string[] {
  const layers = value.split(",").map(s => s.trim()).filter(Boolean);
  if (layers.length === 0) throw new Error(`--layers needs at least one layer name, got: "${value}"`);
  return layers;
}

/** The file-name suffix kicad-cli gives a layer's plot file:
 *  `<board>-<suffix>.svg`. Mirrors PCB_PLOTTER::BuildPlotFileName, which
 *  trims the layer's display name and replaces filename-hostile
 *  characters (and `.`) with `_`. */
export function plotFileSuffix(layerName: string): string {
  return layerName.trim().replace(/[\\/:*?"<>|%.]/g, "_");
}

/** Bottom-to-top stacking order shared by the composite and the viewer:
 *    Edge.Cuts, back non-copper (B.*), B.Cu, inner copper from the back
 *    (InN.Cu … In1.Cu), F.Cu, front non-copper (F.*), anything else.
 *  For a 2-layer board this is the historical Edge.Cuts, B.Silkscreen,
 *  B.Cu, F.Cu, F.Silkscreen order. Ties sort by name so the order is
 *  deterministic. */
export function compareLayerStack(a: string, b: string): number {
  const ka = layerStackKey(a);
  const kb = layerStackKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return a < b ? -1 : a > b ? 1 : 0;
}

function layerStackKey(name: string): [number, number] {
  if (name === "Edge.Cuts") return [0, 0];
  if (name === "B.Cu") return [2, 0];
  if (name === "F.Cu") return [4, 0];
  const inner = /^In(\d+)\.Cu$/.exec(name);
  if (inner) return [3, -Number(inner[1])];
  if (name.startsWith("B.")) return [1, 0];
  if (name.startsWith("F.")) return [5, 0];
  return [6, 0];
}
