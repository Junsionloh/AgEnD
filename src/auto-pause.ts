import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceState } from "./backend/types.js";
import { ensureInstanceDir } from "./private-dir.js";

// The idle-pause clock, shared by the terminal daemon (daemon.ts) and the ACP runner (adapters/acp/acp-runner.ts): kept
// in its own module so the runner does not have to load the daemon. daemon.ts re-exports all three.

const LAST_INBOUND_FILE = "last-inbound-at";

/** Read the last real channel inbound timestamp persisted across daemon restarts. */
export function readLastInboundAt(instanceDir: string, now = Date.now()): number | null {
  try {
    const value = Number(readFileSync(join(instanceDir, LAST_INBOUND_FILE), "utf-8").trim());
    return Number.isFinite(value) && value >= 0 && value <= now ? value : null;
  } catch {
    return null;
  }
}

/** Atomically persist the last real channel inbound timestamp. */
export function writeLastInboundAt(instanceDir: string, timestamp: number): void {
  ensureInstanceDir(instanceDir);
  const target = join(instanceDir, LAST_INBOUND_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, String(timestamp));
  renameSync(temp, target);
}

/** Headless inactivity timer used by the daemon and unit tests. */
export class AutoPauseController {
  private pausedAt: number | null = null;

  constructor(
    private thresholdMs: number,
    private lastActivityAt = Date.now(),
  ) {}

  recordActivity(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  /** Apply a new idle threshold and start a fresh countdown from this update. */
  reconfigure(thresholdMs: number, now = Date.now()): void {
    this.thresholdMs = Math.max(0, thresholdMs);
    this.lastActivityAt = now;
  }

  observe(state: InstanceState, now = Date.now()): boolean {
    if (this.pausedAt !== null || this.thresholdMs <= 0) return false;
    // Inactivity is based on the last user inbound, not on how long this daemon
    // has observed the idle pane. This preserves pause eligibility across fleet
    // restarts while still ensuring an actively working instance is never paused.
    return state === "idle" && now - this.lastActivityAt >= this.thresholdMs;
  }

  markPaused(now = Date.now()): void {
    this.pausedAt = now;
  }

  markAwake(now = Date.now()): void {
    this.pausedAt = null;
    // A deliberate wake is activity in its own right and must provide a fresh
    // window for the wake-before-deliver facade to enqueue its inbound message.
    this.lastActivityAt = now;
  }

  async wakeOnDeliver(wake: () => Promise<void>): Promise<void> {
    if (this.pausedAt === null) return;
    await wake();
    this.markAwake();
  }

  get isPaused(): boolean { return this.pausedAt !== null; }
  get lastPausedAt(): number | null { return this.pausedAt; }
}
