import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffViolations,
  signatureOf,
  formatCheckDiff,
  runDrc,
  runErc,
  type Violation,
} from "../src/check.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI = path.join(PROJECT_DIR, "kicadiff");
const BLINK_FIXTURE_DIR = path.join(PROJECT_DIR, "examples/blink");
const BLINK_PCB = path.join(BLINK_FIXTURE_DIR, "blink.kicad_pcb");
const BLINK_SCH = path.join(BLINK_FIXTURE_DIR, "blink.kicad_sch");
// mcu-board has a filled GND zone on B.Cu and several genuinely
// unconnected nets — the two things that made DRC output unstable.
const MCU_FIXTURE_DIR = path.join(PROJECT_DIR, "examples/mcu-board");
const MCU_PCB = path.join(MCU_FIXTURE_DIR, "mcu-board.kicad_pcb");

// =============================================================================
// Unit tests for the violation differ.
// These test the format-agnostic core, with hand-rolled Violation arrays.
// =============================================================================

function v(
  type: string,
  description: string,
  items: { description: string; uuid?: string; pos?: { x: number; y: number } }[],
  severity: "error" | "warning" | "exclusion" = "error",
): Violation {
  return { type, severity, description, items };
}

test.describe("signatureOf", () => {
  test("two violations with the same type and item descriptions match", () => {
    const a = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R1" },
      { description: "Pad 1 of R2" },
    ]);
    const b = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R1" },
      { description: "Pad 1 of R2" },
    ]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("identity is independent of item order (so KiCad's traversal order doesn't break matching)", () => {
    const a = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R1" },
      { description: "Pad 1 of R2" },
    ]);
    const b = v("clearance", "Clearance violation", [
      { description: "Pad 1 of R2" },
      { description: "Pad 1 of R1" },
    ]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("different type produces a different signature", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("courtyards_overlap", "x", [{ description: "Pad 1 of R1" }]);
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  test("different referenced items produce a different signature", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("clearance", "x", [{ description: "Pad 1 of R5" }]);
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  test("uuid changes alone do NOT break matching (uuids may be regenerated)", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1", uuid: "aaa" }]);
    const b = v("clearance", "x", [{ description: "Pad 1 of R1", uuid: "bbb" }]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("position changes do NOT break matching (small moves should track)", () => {
    const a = v("clearance", "x",
      [{ description: "Pad 1 of R1", pos: { x: 100, y: 50 } }]);
    const b = v("clearance", "x",
      [{ description: "Pad 1 of R1", pos: { x: 101, y: 51 } }]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });
});

test.describe("signatureOf: unconnected_items", () => {
  // For a net split into islands, KiCad reports one unconnected_items
  // entry per missing ratsnest edge, but *which* pad / track / via it names
  // as the endpoints varies from run to run on the same board. Identity is
  // therefore the net, not the endpoints; the per-net count is stable.
  test("same net, different endpoints → same signature", () => {
    const a = v("unconnected_items", "Missing connection between items", [
      { description: "Pad 2 [GND] of SW1 on F.Cu" },
      { description: "Via [GND] on F.Cu - B.Cu" },
    ]);
    const b = v("unconnected_items", "Missing connection between items", [
      { description: "Pad 2 [GND] of SW1 on F.Cu" },
      { description: "Track [GND] on B.Cu, length 5.4375 mm" },
    ]);
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("different nets → different signatures", () => {
    const a = v("unconnected_items", "x", [
      { description: "Pad 1 [/RST] of SW1 on F.Cu" },
      { description: "Track [/RST] on F.Cu, length 5.4447 mm" },
    ]);
    const b = v("unconnected_items", "x", [
      { description: "Pad 1 [+3V3] of U1 on F.Cu" },
      { description: "Track [+3V3] on F.Cu, length 2.5000 mm" },
    ]);
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  test("net names containing brackets are kept whole", () => {
    const a = v("unconnected_items", "x", [{ description: "Pad 3 [/D[0]] of U1 on F.Cu" }]);
    const b = v("unconnected_items", "x", [{ description: "Track [/D[0]] on B.Cu, length 1.0000 mm" }]);
    const c = v("unconnected_items", "x", [{ description: "Pad 4 [/D[1]] of U1 on F.Cu" }]);
    expect(signatureOf(a)).toBe(signatureOf(b));
    expect(signatureOf(a)).not.toBe(signatureOf(c));
  });

  test("other violation types still key on the item descriptions", () => {
    const a = v("clearance", "x", [{ description: "Pad 2 [GND] of SW1 on F.Cu" }]);
    const b = v("clearance", "x", [{ description: "Via [GND] on F.Cu - B.Cu" }]);
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  test("diff counts per net: one extra island on a net is +1", () => {
    const edge = (endpoint: string) => v("unconnected_items", "x", [
      { description: "Pad 1 [GND] of C1 on F.Cu" }, { description: endpoint },
    ]);
    const d = diffViolations(
      [edge("Via [GND] on F.Cu - B.Cu")],
      [edge("Track [GND] on B.Cu, length 1.0000 mm"), edge("Pad 2 [GND] of C2 on F.Cu")],
    );
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
    expect(d.unchanged).toHaveLength(1);
  });
});

test.describe("diffViolations", () => {
  test("empty before + empty after → empty diff", () => {
    const d = diffViolations([], []);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  test("identical before & after → all unchanged", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const d = diffViolations([a], [a]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged.length).toBe(1);
  });

  test("new violation appears in `added`", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("courtyards_overlap", "x", [{ description: "Pad 1 of R2" }]);
    const d = diffViolations([a], [a, b]);
    expect(d.added.length).toBe(1);
    expect(d.added[0].type).toBe("courtyards_overlap");
    expect(d.removed).toEqual([]);
    expect(d.unchanged.length).toBe(1);
  });

  test("fixed violation appears in `removed`", () => {
    const a = v("clearance", "x", [{ description: "Pad 1 of R1" }]);
    const b = v("courtyards_overlap", "x", [{ description: "Pad 1 of R2" }]);
    const d = diffViolations([a, b], [a]);
    expect(d.removed.length).toBe(1);
    expect(d.removed[0].type).toBe("courtyards_overlap");
    expect(d.added).toEqual([]);
    expect(d.unchanged.length).toBe(1);
  });

  test("duplicate violations on each side are counted separately", () => {
    // KiCad sometimes reports the same logical violation twice (e.g. two
    // unconnected-items entries for the same net). We treat each entry as
    // distinct so the +/- numbers aren't silently collapsed.
    const a = v("unconnected_items", "x", [{ description: "Pad 1 of R1" }]);
    const d = diffViolations([a], [a, a]);
    expect(d.added.length).toBe(1);
    expect(d.unchanged.length).toBe(1);
  });
});

test.describe("formatCheckDiff", () => {
  test("reports +N -M =K summary line", () => {
    const same = v("clearance", "Clearance violation", [{ description: "Pad 1 of R1" }]);
    const added = v("courtyards_overlap", "Overlap", [{ description: "footprint R5 / R6" }]);
    const removed = v("lengths_match", "Length mismatch", [{ description: "diff pair" }]);
    const diff = diffViolations([same, removed], [same, added]);
    const out = formatCheckDiff("foo.kicad_pcb", "drc", diff);
    const head = out.split("\n")[0];
    expect(head).toContain("foo.kicad_pcb");
    expect(head).toContain("(drc)");
    expect(head).toContain("+1");
    expect(head).toContain("-1");
    expect(head).toContain("=1");
  });

  test("lists added violations with `+` prefix", () => {
    const added = v("courtyards_overlap", "Overlap", [{ description: "footprint R5" }]);
    const out = formatCheckDiff("foo.kicad_pcb", "drc", diffViolations([], [added]));
    expect(out).toMatch(/^\s*\+\s+courtyards_overlap/m);
  });

  test("lists removed violations with `-` prefix", () => {
    const removed = v("clearance", "Clearance", [{ description: "Pad 1 of R1" }]);
    const out = formatCheckDiff("foo.kicad_pcb", "drc", diffViolations([removed], []));
    expect(out).toMatch(/^\s*-\s+clearance/m);
  });
});

// =============================================================================
// runDrc / runErc surface launch failures with actionable diagnostics.
// Without this, a missing kicad-cli on PATH degrades to a generic
// "report file missing" error that hides ENOENT.
// =============================================================================

/** Write a `kicad-cli` shim into `dir` that logs every invocation's argv
 *  (one line per call) to `log`, answers `pcb drc --help` with `help`,
 *  and otherwise writes an empty DRC report to --output. */
function writeDrcShim(dir: string, log: string, help: string): void {
  const shim = path.join(dir, "kicad-cli");
  fs.writeFileSync(shim, [
    "#!/bin/sh",
    `echo "$*" >> "${log}"`,
    "for a in \"$@\"; do",
    `  if [ "$a" = "--help" ]; then printf '%s\\n' '${help}'; exit 0; fi`,
    "done",
    "out=",
    "while [ $# -gt 0 ]; do",
    "  case \"$1\" in",
    "    --output) out=\"$2\"; shift 2 ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    "printf '{\"violations\":[],\"unconnected_items\":[],\"schematic_parity\":[]}' > \"$out\"",
    "exit 0",
  ].join("\n"));
  fs.chmodSync(shim, 0o755);
}

test.describe("runDrc: zone refill", () => {
  test("passes --refill-zones (never --save-board) when kicad-cli supports it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-refill-"));
    const origPath = process.env.PATH;
    try {
      const log = path.join(tmp, "argv.log");
      writeDrcShim(tmp, log, "  --refill-zones          Refill zones before running DRC");
      process.env.PATH = tmp;
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      expect(runDrc(fakePcb, path.join(tmp, "report.json"))).toEqual([]);
      const drcCall = fs.readFileSync(log, "utf8").split("\n").find(l => l.includes("--output"));
      expect(drcCall).toContain("--refill-zones");
      expect(drcCall).not.toContain("--save-board");
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("omits --refill-zones on a kicad-cli that doesn't have it (KiCad 9)", () => {
    // `pcb drc --refill-zones` first shipped in KiCad 10.0; KiCad 9's
    // kicad-cli rejects unknown flags, so passing it blindly would break
    // `check` there entirely.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-norefill-"));
    const origPath = process.env.PATH;
    try {
      const log = path.join(tmp, "argv.log");
      writeDrcShim(tmp, log, "  --exit-code-violations  Return a nonzero exit code if DRC violations exist");
      process.env.PATH = tmp;
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      expect(runDrc(fakePcb, path.join(tmp, "report.json"))).toEqual([]);
      const drcCall = fs.readFileSync(log, "utf8").split("\n").find(l => l.includes("--output"));
      expect(drcCall).toBeTruthy();
      expect(drcCall).not.toContain("--refill-zones");
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test.describe("runDrc / runErc error surfacing", () => {
  test("runDrc: missing kicad-cli surfaces ENOENT / launch error", () => {
    // Tmpdir name avoids substrings that would collide with the diagnostic
    // regex below (no "enoent", "not found", "PATH") — we want the assertion
    // to pin on the *thrown message text*, not on the fixture path.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-drc-fail-"));
    const origPath = process.env.PATH;
    try {
      // Wipe PATH so `kicad-cli` is unresolvable — spawnSync should populate
      // r.error with ENOENT. The previous implementation only checked the
      // output file existence and threw a generic "drc failed" message.
      process.env.PATH = "/nonexistent-kicadiff-test";
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runDrc(fakePcb, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      // The error must mention either ENOENT or "not found" / "PATH" so the
      // user can act on it; the bare "drc failed" message is what we're
      // replacing.
      expect(caught!.message).toMatch(/ENOENT|not found|PATH/i);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runErc: missing kicad-cli surfaces ENOENT / launch error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-erc-fail-"));
    const origPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-kicadiff-test";
      const fakeSch = path.join(tmp, "fake.kicad_sch");
      fs.writeFileSync(fakeSch, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runErc(fakeSch, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/ENOENT|not found|PATH/i);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runDrc: non-zero exit from kicad-cli includes the exit status", () => {
    // Stand up a `kicad-cli` shim that exits non-zero without writing a
    // report file. The error message must include the exit status so the
    // user can distinguish "tool refused the file" (e.g. exit 2 = bad input)
    // from "tool crashed".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-exit-"));
    const origPath = process.env.PATH;
    try {
      const shim = path.join(tmp, "kicad-cli");
      fs.writeFileSync(shim, "#!/bin/sh\necho 'simulated drc failure' >&2\nexit 2\n");
      fs.chmodSync(shim, 0o755);
      process.env.PATH = tmp;
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runDrc(fakePcb, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      // The exit status (2) must appear somewhere in the diagnostic.
      expect(caught!.message).toMatch(/\b2\b/);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runDrc: corrupt DRC report JSON surfaces report path AND input path", () => {
    // Copilot review round 3, Comment B: parseDrcViolations used to let
    // JSON.parse exceptions bubble up bare ("Unexpected token …"), which
    // hides *which* report/input is broken. The diagnostic must identify
    // both the report file on disk and the .kicad_pcb that was checked.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-drc-corrupt-"));
    const origPath = process.env.PATH;
    try {
      // Shim kicad-cli to write a corrupt JSON report to the path that
      // runKicadCli expects, then exit cleanly. Mimics partial-write /
      // disk-corruption scenarios.
      const shim = path.join(tmp, "kicad-cli");
      // `"$@"` carries through kicad-cli's argv; we just need the value of
      // --output. Use a tiny shell snippet that walks args.
      fs.writeFileSync(shim, [
        "#!/bin/sh",
        "out=",
        "while [ $# -gt 0 ]; do",
        "  case \"$1\" in",
        "    --output) out=\"$2\"; shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        "printf '{broken' > \"$out\"",
        "exit 0",
      ].join("\n"));
      fs.chmodSync(shim, 0o755);
      process.env.PATH = tmp;
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runDrc(fakePcb, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      // The error must name BOTH the report file and the input file so a
      // user reading CI logs can trace which board produced the broken
      // report.
      expect(caught!.message).toContain(reportPath);
      expect(caught!.message).toContain(fakePcb);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runErc: corrupt ERC report JSON surfaces report path AND input path", () => {
    // Copilot review round 3, Comment C: same shape as the DRC case.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-erc-corrupt-"));
    const origPath = process.env.PATH;
    try {
      const shim = path.join(tmp, "kicad-cli");
      fs.writeFileSync(shim, [
        "#!/bin/sh",
        "out=",
        "while [ $# -gt 0 ]; do",
        "  case \"$1\" in",
        "    --output) out=\"$2\"; shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        "printf '{broken' > \"$out\"",
        "exit 0",
      ].join("\n"));
      fs.chmodSync(shim, 0o755);
      process.env.PATH = tmp;
      const fakeSch = path.join(tmp, "fake.kicad_sch");
      fs.writeFileSync(fakeSch, "");
      const reportPath = path.join(tmp, "report.json");
      let caught: Error | null = null;
      try {
        runErc(fakeSch, reportPath);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toContain(reportPath);
      expect(caught!.message).toContain(fakeSch);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runDrc: large kicad-cli stdout does not trip ENOBUFS", () => {
    // Copilot review round 3, Comment A: the previous spawnSync used
    // `stdio: [..., "pipe", "pipe"]` without a maxBuffer override, so a
    // kicad-cli emitting more than ~1MB on stdout (plausible with many
    // violations) would fail with ENOBUFS and get misreported as a launch
    // failure via r.error. The fix is to discard stdout entirely. We
    // simulate the bad case with a shim that emits 2 MiB to stdout, then
    // writes a valid (empty) report to --output and exits 0.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-bigout-"));
    const origPath = process.env.PATH;
    try {
      const shim = path.join(tmp, "kicad-cli");
      fs.writeFileSync(shim, [
        "#!/bin/sh",
        "out=",
        "while [ $# -gt 0 ]; do",
        "  case \"$1\" in",
        "    --output) out=\"$2\"; shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        // 2 MiB to stdout — well above Node's 1 MiB default spawnSync
        // maxBuffer, which would previously trip ENOBUFS.
        "dd if=/dev/zero bs=1024 count=2048 2>/dev/null",
        // Valid empty DRC report so parseDrcViolations succeeds.
        "printf '{\"violations\":[],\"unconnected_items\":[],\"schematic_parity\":[]}' > \"$out\"",
        "exit 0",
      ].join("\n"));
      fs.chmodSync(shim, 0o755);
      process.env.PATH = tmp;
      const fakePcb = path.join(tmp, "fake.kicad_pcb");
      fs.writeFileSync(fakePcb, "");
      const reportPath = path.join(tmp, "report.json");
      // The call must complete and return an empty violations array. With
      // the old `stdio: "pipe"` form this throws ENOBUFS-mediated launch
      // failure instead.
      const violations = runDrc(fakePcb, reportPath);
      expect(violations).toEqual([]);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Integration tests for the `kicadiff check` subcommand.
//
// `examples/blink/blink.kicad_pcb` is DRC-clean (no violations).
// `examples/blink/blink.kicad_sch` has 5 ERC violations (pre-existing).
// We exercise both directions: a no-op compare and a compare that introduces
// changes.
// =============================================================================

function initRepoWithBlink(dir: string): string {
  fs.cpSync(BLINK_FIXTURE_DIR, dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
    "add", ".",
  ], { cwd: dir });
  execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "-m", "init",
  ], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir, encoding: "utf8",
  }).trim();
}

/** Copy mcu-board into `dir` (optionally replacing the .kicad_pcb text)
 *  and commit it. */
function initRepoWithMcuBoard(dir: string, pcbSource?: string): string {
  fs.cpSync(MCU_FIXTURE_DIR, dir, { recursive: true });
  const pcb = path.join(dir, path.basename(MCU_PCB));
  if (pcbSource !== undefined) fs.writeFileSync(pcb, pcbSource);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const args of [["add", "."], ["commit", "-q", "-m", "init"]]) {
    execFileSync("git", [
      "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args,
    ], { cwd: dir });
  }
  return pcb;
}

/** Drop every `(filled_polygon …)` block: the zones stay, but their fill
 *  is gone, as in a board saved without refilling after an edit. */
function stripZoneFills(src: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = src.indexOf("(filled_polygon", i);
    if (start < 0) return out + src.slice(i);
    out += src.slice(i, start);
    let depth = 0;
    let j = start;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    i = j + 1;
  }
}

function kicadCliHasRefillZones(): boolean {
  const r = spawnSync("kicad-cli", ["pcb", "drc", "--help"], { encoding: "utf8" });
  return (r.stdout ?? "").includes("--refill-zones");
}

test.beforeAll(() => {
  if (!fs.existsSync(BLINK_PCB)) test.skip(true, `KiCad fixture missing: ${BLINK_PCB}`);
});

test.describe("kicadiff check (integration)", () => {
  test("HEAD vs HEAD on a DRC-clean PCB: exits 0, reports +0 -0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-clean-"));
    try {
      initRepoWithBlink(tmp);
      const pcbInTmp = path.join(tmp, path.basename(BLINK_PCB));
      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", pcbInTmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("(drc)");
      expect(r.stdout).toMatch(/\+0\b/);
      expect(r.stdout).toMatch(/-0\b/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("HEAD vs HEAD on a board with zones and unconnected nets: exits 0, reports +0 -0", () => {
    // Regression: identical refs used to report e.g. `+3 -3` and exit 1,
    // because kicad-cli picks different endpoints for the same missing
    // connection on every run. Run twice to make a lucky pass unlikely.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-zones-"));
    try {
      const pcb = initRepoWithMcuBoard(tmp);
      for (let run = 0; run < 2; run++) {
        const r = spawnSync(CLI, ["check", "HEAD", "HEAD", pcb], {
          cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        expect(r.stdout).toMatch(/\(drc\): \+0 -0 =[1-9]\d*/);
        expect(r.status).toBe(0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("DRC refills zones: a stale zone fill reports the same as a filled board", () => {
    // Without --refill-zones, kicad-cli checks whatever fill is saved in
    // the file; an unfilled GND pour then surfaces as extra
    // unconnected_items that the designer never sees in the GUI.
    test.skip(!kicadCliHasRefillZones(), "kicad-cli has no `pcb drc --refill-zones` (KiCad < 10)");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-stale-"));
    try {
      const filled = path.join(tmp, "filled.kicad_pcb");
      const stale = path.join(tmp, "stale.kicad_pcb");
      const src = fs.readFileSync(MCU_PCB, "utf8");
      fs.writeFileSync(filled, src);
      fs.writeFileSync(stale, stripZoneFills(src));
      expect(fs.readFileSync(stale, "utf8")).not.toContain("filled_polygon");
      const count = (pcb: string) => runDrc(pcb, pcb.replace(/\.kicad_pcb$/, ".json"))
        .filter(v => v.type === "unconnected_items").length;
      expect(count(stale)).toBe(count(filled));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("check never modifies the board it checks (working tree side)", () => {
    // --refill-zones recomputes fills in memory; kicad-cli only writes the
    // board with --save-board, and check runs it on a temp copy anyway.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-untouched-"));
    try {
      const pcb = initRepoWithMcuBoard(tmp, stripZoneFills(fs.readFileSync(MCU_PCB, "utf8")));
      const before = fs.readFileSync(pcb);
      const listing = fs.readdirSync(tmp).sort();
      const r = spawnSync(CLI, ["check", "HEAD", pcb], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.stdout).toContain("(drc)");
      expect(fs.readFileSync(pcb).equals(before)).toBe(true);
      expect(fs.readdirSync(tmp).sort()).toEqual(listing);
      const status = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: tmp, encoding: "utf8" });
      expect(status).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("introducing an ERC violation: exits 1, reports +N new", () => {
    // The blink schematic already has 5 ERC violations (pin_not_connected on
    // ERC markers). Removing a wire segment from a net is a deterministic way
    // to add new dangling-wire / pin-not-connected violations on top of the
    // existing baseline: deleting one `(wire ...)` block breaks the
    // connection between two pins, so previously-connected pins now ERC as
    // unconnected. We delete the FIRST `(wire ` block and walk parens to find
    // its matching `)` (the block contains nested `(stroke ...)`, `(uuid ...)`
    // and `(pts ...)` groups, so a naive regex would close at the first `)`).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-erc-"));
    try {
      initRepoWithBlink(tmp);
      const schInTmp = path.join(tmp, path.basename(BLINK_SCH));
      const src = fs.readFileSync(schInTmp, "utf8");
      // Strip one wire from the schematic — removing a wire that connected
      // two pins introduces dangling-wire / pin-not-connected ERC errors
      // that weren't present at HEAD. We scan for `(wire ` then walk the
      // parens to find the matching `)`, because the wire block contains
      // nested groups (`(stroke …)`, `(uuid …)`, `(pts …)`) and a naive
      // regex would close at the first `)`.
      const start = src.indexOf("(wire ");
      let mutated = src;
      if (start >= 0) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < src.length; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") {
            depth--;
            if (depth === 0) { end = i + 1; break; }
          }
        }
        if (end > start) mutated = src.slice(0, start) + src.slice(end);
      }
      if (mutated === src) test.skip(true, "could not perturb the schematic to introduce an ERC violation");
      fs.writeFileSync(schInTmp, mutated);

      const r = spawnSync(CLI, ["check", "HEAD", schInTmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.stdout).toContain("(erc)");
      // Exit 1 because there are NEW violations on the `to` side.
      expect(r.status).toBe(1);
      // The summary must show at least one added violation.
      expect(r.stdout).toMatch(/\+[1-9]\d*\b/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("aggregates unsupported-file skips into a single summary line", () => {
    // A .pretty/ footprint library can contain dozens of .kicad_mod files.
    // resolveInputs auto-includes them when handed the parent project, and
    // the previous implementation printed one stderr line per skipped file —
    // which floods CI logs. The skip notices must collapse to a single
    // summary line regardless of how many footprints live in the library.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-pretty-"));
    try {
      initRepoWithBlink(tmp);
      // Build a sibling <project>.pretty/ library with several .kicad_mod
      // files. They share the project basename so `scanProjectSiblings`
      // auto-picks them up during `resolveInputs`.
      const projBase = path.basename(BLINK_PCB, ".kicad_pcb");
      const prettyDir = path.join(tmp, `${projBase}.pretty`);
      fs.mkdirSync(prettyDir, { recursive: true });
      const modCount = 5;
      for (let i = 0; i < modCount; i++) {
        fs.writeFileSync(
          path.join(prettyDir, `stub_${i}.kicad_mod`),
          "(footprint stub (version 20240108) (generator kicadiff_test))",
        );
      }
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "add", ".",
      ], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "-m", "add pretty",
      ], { cwd: tmp });

      // Hand the project directory to `check` — resolveInputs will fold in
      // all the .kicad_mod files alongside the .kicad_pcb / .kicad_sch.
      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", tmp], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      // Count the per-file skip lines. The fix collapses these into ONE
      // summary line ("Skipped N unsupported files…"); the regression we're
      // guarding against would emit one such line per .kicad_mod.
      const perFileSkipLines = (r.stderr ?? "")
        .split("\n")
        .filter((l) => /skipping unsupported file type/.test(l));
      expect(perFileSkipLines.length).toBeLessThanOrEqual(1);
      // And we should still get *some* indication that files were skipped
      // — either the per-file (<=1) message or a summary count.
      const skippedSummary = (r.stderr ?? "").match(/[Ss]kipped\s+\d+/);
      expect(perFileSkipLines.length + (skippedSummary ? 1 : 0)).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("skips unsupported file types with a friendly note", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-skip-"));
    try {
      initRepoWithBlink(tmp);
      // Drop a .kicad_sym next to the project — `check` doesn't run on
      // symbol libs, so it should be silently or politely skipped.
      const symFile = path.join(tmp, "stub.kicad_sym");
      fs.writeFileSync(symFile, "(kicad_symbol_lib (version 20211014) (generator kicadiff_test))");
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "add", "stub.kicad_sym",
      ], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "-m", "add sym",
      ], { cwd: tmp });

      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", symFile], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      // Skipping is fine; the only requirement is that the command doesn't
      // crash and doesn't report a phantom violation.
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("all-unsupported inputs: prints only the aggregated skip line, not 'no inputs to check'", () => {
    // Regression for Copilot review round 2 on PR #17: when every input is
    // an unsupported type (e.g. a lone .kicad_sym), the previous output was
    //   kicadiff check: skipped 1 unsupported file ...
    //   kicadiff check: no .kicad_pcb / .kicad_sch inputs to check
    // The second line reads like the user passed nothing — confusing in the
    // all-unsupported case. We want the aggregate-skip line ONLY here.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kicadiff-check-all-unsup-"));
    try {
      initRepoWithBlink(tmp);
      const symFile = path.join(tmp, "stub.kicad_sym");
      fs.writeFileSync(symFile, "(kicad_symbol_lib (version 20211014) (generator kicadiff_test))");
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "add", "stub.kicad_sym",
      ], { cwd: tmp });
      execFileSync("git", [
        "-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "-m", "add sym",
      ], { cwd: tmp });

      // Pass the .kicad_sym file explicitly so resolveInputs returns ONLY
      // unsupported files. (Handing the project dir would also pull in the
      // PCB and schematic, which would defeat the "all-unsupported" case.)
      const r = spawnSync(CLI, ["check", "HEAD", "HEAD", symFile], {
        cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(r.status).toBe(0);
      // The aggregated skip line must appear exactly once.
      const stderr = r.stderr ?? "";
      const skipLines = stderr.split("\n").filter((l) => /skipped\s+\d+\s+unsupported/i.test(l));
      expect(skipLines.length).toBe(1);
      // And the "no inputs to check" line must NOT appear — it's redundant
      // here because the skip line already explains why nothing ran.
      expect(stderr).not.toMatch(/no .kicad_pcb \/ .kicad_sch inputs to check/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
