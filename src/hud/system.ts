import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

/**
 * Gép-állapot a HUD-hoz (2026-10-06, M4 Mac mini): CPU (gép és a bot folyamata), memória, tárhely, adatbázis-méret.
 * Olcsó, a fő szálon 10 mp-enként mintavételez. Memória: macOS-en az os.freemem() a gyorsítótár miatt félrevezetően kicsi,
 * ezért a `memory_pressure` „System-wide memory free percentage” értékét használjuk (ha nem elérhető: os.freemem).
 */
export interface SystemSnapshot {
  at: number; cores: number; load1: number;
  cpuPct: number | null; botCpuPct: number | null;            // gép: összes mag átlaga; bot: egy magra vetítve (mint az Activity Monitor)
  memTotalGb: number; memUsedPct: number | null; botRssMb: number;
  diskTotalGb: number | null; diskFreeGb: number | null; dbMb: number | null;
}

export class SystemStats {
  private prevCpu = os.cpus().map((c) => c.times);
  private prevProc = process.cpuUsage(); private prevAt = Date.now();
  private snap: SystemSnapshot;
  private timer: NodeJS.Timeout;
  constructor(private dataPath: string) {
    this.snap = this.base();
    this.timer = setInterval(() => this.sample(), 10_000); this.timer.unref();
    this.sample();
  }
  private base(): SystemSnapshot {
    return { at: Date.now(), cores: os.cpus().length, load1: os.loadavg()[0] ?? 0, cpuPct: null, botCpuPct: null, memTotalGb: os.totalmem() / 2 ** 30, memUsedPct: null, botRssMb: process.memoryUsage().rss / 2 ** 20, diskTotalGb: null, diskFreeGb: null, dbMb: null };
  }
  private sample() {
    const now = Date.now(), cpus = os.cpus().map((c) => c.times);
    let busy = 0, total = 0;
    cpus.forEach((t, i) => { const p = this.prevCpu[i]; if (!p) return; const d = { u: t.user - p.user, n: t.nice - p.nice, s: t.sys - p.sys, i: t.idle - p.idle, q: t.irq - p.irq }; busy += d.u + d.n + d.s + d.q; total += d.u + d.n + d.s + d.q + d.i; });
    const proc = process.cpuUsage(), dtMs = Math.max(1, now - this.prevAt);
    const botCpu = ((proc.user - this.prevProc.user) + (proc.system - this.prevProc.system)) / 1000 / dtMs * 100;
    this.prevCpu = cpus; this.prevProc = proc; this.prevAt = now;
    const s: SystemSnapshot = { ...this.snap, ...this.base(), cpuPct: total > 0 ? busy / total * 100 : null, botCpuPct: botCpu, memUsedPct: this.snap.memUsedPct };
    try { const st = fs.statfsSync(path.dirname(this.dataPath)); s.diskTotalGb = st.blocks * st.bsize / 2 ** 30; s.diskFreeGb = st.bavail * st.bsize / 2 ** 30; } catch { /* nem elérhető */ }
    try { s.dbMb = ["", "-wal", "-shm"].reduce((a, x) => { try { return a + fs.statSync(this.dataPath + x).size; } catch { return a; } }, 0) / 2 ** 20; } catch { /* nem elérhető */ }
    this.snap = s;
    execFile("memory_pressure", { timeout: 3000 }, (err, out) => {
      const m = !err ? /free percentage:\s*(\d+)%/.exec(out) : null;
      this.snap = { ...this.snap, memUsedPct: m ? 100 - Number(m[1]) : (1 - os.freemem() / os.totalmem()) * 100 };
    });
  }
  get(): SystemSnapshot { return this.snap; }
  stop() { clearInterval(this.timer); }
}
