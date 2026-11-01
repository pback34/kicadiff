import { execFileSync, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";
import { FOUR_LAYER_PCB, twoLayerVariant } from "./four-layer-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright global setup: generate test fixtures using kicadiff CLI.
 *
 * Generates fixture sets so each viewer test can target what it needs:
 *   - test/fixtures/combined/     : default mode (both PCB + sch in one HTML)
 *   - test/fixtures/pcb/          : pcb subcommand (PCB only)
 *   - test/fixtures/sch/          : sch subcommand (schematic only)
 *   - test/fixtures/four-layer/   : 4-layer board, edited between refs
 *   - test/fixtures/layer-change/ : 4-layer board at HEAD, 2-layer in the
 *                                   working tree (layer sets differ per side)
 */
export default function globalSetup() {
  // Belt-and-suspenders: ensure no test (or fixture-generation step) ever
  // spawns the real `code` / `xdg-open`, even if a future test forgets to
  // pass --open without an env override. Empty value = no-op in render.ts.
  if (process.env.KICADIFF_OPEN_CMD === undefined) {
    process.env.KICADIFF_OPEN_CMD = "";
  }

  const projectDir = path.resolve(__dirname, "..");
  const fixtureDir = path.join(projectDir, "test", "fixtures");
  const kicadCli = path.join(projectDir, "kicadiff");

  // Self-contained example used as the test fixture. Kept inside the kicadiff
  // project so tests don't require any sibling repo to be present.
  const projectFile = path.join(projectDir, "examples", "blink", "blink.kicad_pcb");
  const schFile = path.join(projectDir, "examples", "blink", "blink.kicad_sch");
  const repoRoot = path.resolve(projectDir, "..");

  if (!fs.existsSync(projectFile)) {
    console.log("Skipping fixture generation: KiCad file not found at", projectFile);
    return;
  }

  // Combined mode (no subcommand) — picks up both files when both exist
  console.log("Generating combined fixtures...");
  execSync(`"${kicadCli}" "${projectFile}" --output-dir "${path.join(fixtureDir, "combined")}"`, {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 90000,
  });

  // PCB-only fixture
  console.log("Generating PCB-only fixtures...");
  execSync(`"${kicadCli}" pcb "${projectFile}" --output-dir "${path.join(fixtureDir, "pcb")}"`, {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 60000,
  });

  // Schematic-only fixture (skip if no .kicad_sch)
  if (fs.existsSync(schFile)) {
    console.log("Generating schematic-only fixtures...");
    execSync(`"${kicadCli}" sch "${schFile}" --output-dir "${path.join(fixtureDir, "sch")}"`, {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 60000,
    });
  }

  if (fs.existsSync(FOUR_LAYER_PCB)) {
    console.log("Generating multi-layer fixtures...");
    generateMultiLayerFixtures(kicadCli, fixtureDir);
  }

  console.log("Fixtures generated at", fixtureDir);
}

/** Render the 4-layer example from a throwaway repo so both sides exist
 *  (a fixture rendered inside this repo would have no before side until
 *  the example is committed). */
function generateMultiLayerFixtures(kicadCli: string, fixtureDir: string): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-fixture-4layer-"));
  try {
    const src = fs.readFileSync(FOUR_LAYER_PCB, "utf8");
    const pcb = path.join(tmp, "four-layer.kicad_pcb");
    fs.writeFileSync(pcb, src);
    const git = (...args: string[]) => execFileSync("git", [
      "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args,
    ], { cwd: tmp, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const render = (out: string) => execFileSync(kicadCli, [
      "pcb", "HEAD", pcb, "--output-dir", path.join(fixtureDir, out),
    ], { cwd: tmp, stdio: "pipe", timeout: 60000 });

    // Move the In1.Cu track end so the diff isn't empty.
    fs.writeFileSync(pcb, src.replace("(end 120 106)", "(end 122 104)"));
    render("four-layer");

    fs.writeFileSync(pcb, twoLayerVariant(src));
    render("layer-change");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
