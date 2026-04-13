import memoryStore from './memory-store.js';
import vectorEngine from './vector-engine.js';

/**
 * Lifecycle Management Daemon.
 *
 * Runs on a configurable interval (default: 60 seconds).
 * Responsibilities:
 *   1. Garbage collection: prune ephemeral nodes (access_count=0, age > 24h)
 *   2. Monetization trigger: flag high-value nodes for Global Hive publication
 *   3. Stats tracking: update utilization metrics
 */
class LifecycleDaemon {
  constructor() {
    this.intervalMs = 60_000;
    this.timer = null;
    this.cycleCount = 0;
    this.totalPurged = 0;
    this.totalMonetizationFlags = 0;
    this.lastRun = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Run first cycle after a short delay
    this.timer = setInterval(() => this.cycle(), this.intervalMs);

    // Initial run after 5 seconds
    setTimeout(() => this.cycle(), 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  cycle() {
    this.cycleCount++;
    this.lastRun = new Date().toISOString();

    // 1. Garbage collection
    const gc = memoryStore.purgeEphemeral(24 * 60 * 60 * 1000);
    this.totalPurged += gc.purged;

    // 2. Monetization trigger
    const candidates = memoryStore.getMonetizationCandidates(3);
    this.totalMonetizationFlags += candidates.length;

    // 3. Log cycle stats (silent)
    if (gc.purged > 0 || candidates.length > 0) {
      // Could log to HiveTrust telemetry in production
    }
  }

  getStatus() {
    const vectorStats = vectorEngine.getStats();
    const globalStats = memoryStore.getGlobalHiveStats();

    return {
      daemon: 'lifecycle-manager',
      running: this.running,
      interval_seconds: this.intervalMs / 1000,
      cycle_count: this.cycleCount,
      last_run: this.lastRun,
      garbage_collection: {
        total_purged: this.totalPurged,
        pending_ephemeral: memoryStore.getEphemeralNodes().length,
      },
      monetization: {
        total_flags: this.totalMonetizationFlags,
        current_candidates: memoryStore.getMonetizationCandidates(3).length,
      },
      vector_engine: vectorStats,
      global_hive: globalStats,
    };
  }
}

const lifecycleDaemon = new LifecycleDaemon();
export default lifecycleDaemon;
