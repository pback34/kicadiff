import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { compositePcbLayers, layerNameFromFile } from "../src/composite.ts";
import { makeTestPng } from "../src/diff-overlay.ts";

// Pure-logic tests for the per-layer composite. We synthesize tiny
// per-layer PNGs to make pixel-level expectations easy to reason
// about, then check that the composited combined PNG matches the
// viewer's z-order + opacity model.

const W = 4;
const H = 1;

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

function read(buf: Buffer, x: number, y: number): [number, number, number, number] {
  const png = PNG.sync.read(buf);
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

function makeLayer(dir: string, name: string, paint: (x: number, y: number) => [number, number, number, number]): void {
  const file = path.join(dir, `board-${name.replace(/\./g, "_")}.png`);
  fs.writeFileSync(file, makeTestPng(W, H, paint));
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-composite-"));
}

test("layerNameFromFile parses kicad-cli output naming", () => {
  expect(layerNameFromFile("preview_xxx-F_Cu.png")).toBe("F.Cu");
  expect(layerNameFromFile("board-Edge_Cuts.svg")).toBe("Edge.Cuts");
  expect(layerNameFromFile("a-B_Silkscreen.png")).toBe("B.Silkscreen");
  expect(layerNameFromFile("my-board-In2_Cu.png")).toBe("In2.Cu");
});

test("returns false when the layers dir doesn't exist", () => {
  const out = path.join(freshDir(), "out.png");
  const result = compositePcbLayers("/nonexistent-dir-kicadiff-test", out);
  expect(result).toBe(false);
  expect(fs.existsSync(out)).toBe(false);
});

test("returns false when the layers dir holds no layer PNGs", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "board-F_Cu.svg"), "<svg/>");
  const out = path.join(dir, "out.png");
  expect(compositePcbLayers(dir, out)).toBe(false);
});

test("layers outside the default set (picked via --layers) are composited too", () => {
  // The layers dir only ever holds what render.ts asked kicad-cli for, so
  // a layer the user explicitly selected must not be dropped.
  const dir = freshDir();
  makeLayer(dir, "User.Drawings", () => [255, 0, 0, 255]);
  const out = path.join(dir, "out.png");
  expect(compositePcbLayers(dir, out)).toBe(true);
  expect(read(fs.readFileSync(out), 0, 0)).toEqual([165, 12, 12, 255]);
});

test("inner copper stacks between B.Cu and F.Cu, In1.Cu above In2.Cu", () => {
  // For each pair, the upper layer is painted GREEN and the lower RED, both
  // fully covering the canvas; the upper one blends in last, so green wins.
  const pairs: [lower: string, upper: string][] = [
    ["B.Cu", "In2.Cu"],
    ["In2.Cu", "In1.Cu"],
    ["In1.Cu", "F.Cu"],
    ["In10.Cu", "In9.Cu"],
  ];
  for (const [lower, upper] of pairs) {
    const dir = freshDir();
    makeLayer(dir, lower, () => [255, 0, 0, 255]);
    makeLayer(dir, upper, () => [0, 255, 0, 255]);
    const out = path.join(dir, "out.png");
    expect(compositePcbLayers(dir, out)).toBe(true);
    const px = read(fs.readFileSync(out), 0, 0);
    expect(px[1], `${upper} should be above ${lower}`).toBeGreaterThan(px[0]);
  }
});

test("active layer (F.Cu) wins on top regardless of base z-order", () => {
  // Two layers fully covering the canvas with distinct opaque colors;
  // F.Cu is GREEN and B.Cu is RED. Viewer puts F.Cu on top, so the
  // composite should look more green than red.
  const dir = freshDir();
  makeLayer(dir, "B.Cu",  () => [255, 0, 0, 255]);    // red
  makeLayer(dir, "F.Cu",  () => [0, 255, 0, 255]);    // green
  const out = path.join(dir, "out.png");
  expect(compositePcbLayers(dir, out)).toBe(true);

  const buf = fs.readFileSync(out);
  const px = read(buf, 0, 0);
  // Background #1e1e1e composited with B.Cu @ 0.6 then F.Cu @ 0.6
  // Green should dominate the red because F.Cu blends in last.
  expect(px[1]).toBeGreaterThan(px[0]);
  // Output stays opaque
  expect(px[3]).toBe(255);
});

test("translucency: a single fully-opaque layer over the dark canvas blends, not replaces", () => {
  const dir = freshDir();
  makeLayer(dir, "F.Cu", () => [0, 255, 0, 255]); // pure green, fully opaque
  const out = path.join(dir, "out.png");
  expect(compositePcbLayers(dir, out)).toBe(true);

  const px = read(fs.readFileSync(out), 0, 0);
  // Pure green at 0.6 over #1e1e1e:
  //   bg = 0x1e = 30,  src_alpha = 0.6
  //   r = 0   * 0.6 + 30  * 0.4 = 12
  //   g = 255 * 0.6 + 30  * 0.4 = 165
  //   b = 0   * 0.6 + 30  * 0.4 = 12
  expect(px[0]).toBe(12);
  expect(px[1]).toBe(165);
  expect(px[2]).toBe(12);
  expect(px[3]).toBe(255);
});

test("transparent regions of a layer leave the canvas alone", () => {
  // F.Cu only paints column 0; columns 1..3 are transparent. Composite
  // should show "F.Cu blended" at col 0, "background only" at the rest.
  const dir = freshDir();
  makeLayer(dir, "F.Cu", (x) => (x === 0 ? [0, 255, 0, 255] : TRANSPARENT));
  const out = path.join(dir, "out.png");
  expect(compositePcbLayers(dir, out)).toBe(true);

  const buf = fs.readFileSync(out);
  // Col 0: F.Cu blended (green-leaning)
  expect(read(buf, 0, 0)[1]).toBeGreaterThan(100);
  // Col 1..3: just the background
  for (let x = 1; x < W; x++) {
    expect(read(buf, x, 0)).toEqual([0x1e, 0x1e, 0x1e, 255]);
  }
});

test("dimension mismatch between layers throws", () => {
  const dir = freshDir();
  // Edge.Cuts at 4x1, F.Cu at 5x1 — should throw.
  fs.writeFileSync(
    path.join(dir, "b-Edge_Cuts.png"),
    makeTestPng(4, 1, () => [0, 0, 255, 255]),
  );
  fs.writeFileSync(
    path.join(dir, "b-F_Cu.png"),
    makeTestPng(5, 1, () => [0, 255, 0, 255]),
  );
  const out = path.join(dir, "out.png");
  expect(() => compositePcbLayers(dir, out)).toThrow(/dimension mismatch/);
});
