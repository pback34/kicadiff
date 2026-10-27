import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "node:url";

// Viewer behaviour for boards with inner copper layers. Fixtures come from
// global-setup.ts: `four-layer/` is the 4-layer example with an In1.Cu
// edit, `layer-change/` has the 4-layer board on the before side and a
// 2-layer variant on the after side.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "fixtures");
const FOUR_LAYER_HTML = path.join(FIXTURE_DIR, "four-layer", "four-layer_diff.html");
const LAYER_CHANGE_HTML = path.join(FIXTURE_DIR, "layer-change", "four-layer_diff.html");

async function open(page: Page, html: string): Promise<void> {
  await page.goto(`file://${html}`);
  await page.waitForSelector("#view-ovl.active");
}

async function zIndex(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate(el => parseInt(getComputedStyle(el).zIndex));
}

test.describe("4-layer board", () => {
  test.skip(() => !fs.existsSync(FOUR_LAYER_HTML), "fixture not found");
  test.beforeEach(async ({ page }) => open(page, FOUR_LAYER_HTML));

  test("layer panel lists inner copper between B.Cu and F.Cu", async ({ page }) => {
    const names = await page.locator(".layer-row").evaluateAll(
      rows => rows.map(r => (r as HTMLElement).dataset.layer),
    );
    expect(names).toEqual([
      "Edge.Cuts", "B.Silkscreen", "B.Cu", "In2.Cu", "In1.Cu", "F.Cu", "F.Silkscreen",
    ]);
  });

  test("inner layer swatches use the colours kicad-cli plots them in", async ({ page }) => {
    await expect(page.locator('.layer-row[data-layer="In1.Cu"] .swatch'))
      .toHaveCSS("background-color", "rgb(127, 200, 127)");
    await expect(page.locator('.layer-row[data-layer="In2.Cu"] .swatch'))
      .toHaveCSS("background-color", "rgb(206, 125, 44)");
  });

  test("inner layers stack B.Cu < In2.Cu < In1.Cu, active F.Cu on top", async ({ page }) => {
    const z = async (layer: string) => zIndex(page, `#ovl-after img[data-layer="${layer}"]`);
    expect(await z("In2.Cu")).toBeGreaterThan(await z("B.Cu"));
    expect(await z("In1.Cu")).toBeGreaterThan(await z("In2.Cu"));
    expect(await z("F.Cu")).toBeGreaterThan(await z("F.Silkscreen"));
  });

  test("an inner layer can be made active and hidden", async ({ page }) => {
    await page.click('.layer-row[data-layer="In2.Cu"]');
    await expect(page.locator('.layer-row[data-layer="In2.Cu"]')).toHaveClass(/active/);
    expect(await zIndex(page, '#ovl-after img[data-layer="In2.Cu"]'))
      .toBeGreaterThan(await zIndex(page, '#ovl-after img[data-layer="F.Cu"]'));

    await page.click('.layer-row[data-layer="In2.Cu"] .eye');
    for (const img of await page.locator('img[data-layer="In2.Cu"]').all()) {
      await expect(img).toHaveCSS("display", "none");
    }
  });
});

test.describe("layer set differs between sides", () => {
  test.skip(() => !fs.existsSync(LAYER_CHANGE_HTML), "fixture not found");
  test.beforeEach(async ({ page }) => open(page, LAYER_CHANGE_HTML));

  test("panel shows the union of both sides' layers", async ({ page }) => {
    // The after side (2-layer) has no inner layers; the before side does,
    // and they must still be listed and toggleable.
    await expect(page.locator(".layer-row")).toHaveCount(7);
    await expect(page.locator('#ovl-before img[data-layer="In1.Cu"]')).toHaveCount(1);
    await expect(page.locator('#ovl-after img[data-layer="In1.Cu"]')).toHaveCount(0);

    await page.click('.layer-row[data-layer="In1.Cu"] .eye');
    await expect(page.locator('#ovl-before img[data-layer="In1.Cu"]')).toHaveCSS("display", "none");
  });
});
