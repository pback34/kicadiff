/**
 * Shared helpers for the 4-layer example board (examples/four-layer/).
 * Used by render.test.ts and by global-setup.ts (viewer fixtures), so it
 * lives outside any *.test.ts file.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FOUR_LAYER_DIR = path.resolve(__dirname, "..", "examples", "four-layer");
export const FOUR_LAYER_PCB = path.join(FOUR_LAYER_DIR, "four-layer.kicad_pcb");

/** Layers kicadiff renders for the 4-layer example by default. */
export const FOUR_LAYER_LAYERS = [
  "B.Cu", "B.Silkscreen", "Edge.Cuts", "F.Cu", "F.Silkscreen", "In1.Cu", "In2.Cu",
];

/** Derive a 2-layer variant of the 4-layer example: drop In1.Cu / In2.Cu
 *  from the layer table and the tracks routed on them. Relies on the
 *  example's one-item-per-line formatting. */
export function twoLayerVariant(src: string): string {
  const out = src
    .replace(/^\t\t\(\d+ "In\d+\.Cu" \w+\)\n/gm, "")
    .replace(/^\t\(segment\n(?:\t\t.*\n)*?\t\)\n/gm, blk => (/"In\d+\.Cu"/.test(blk) ? "" : blk));
  if (/In\d+\.Cu/.test(out)) throw new Error("twoLayerVariant: inner layers left behind");
  return out;
}
