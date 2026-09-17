// snapshot.mjs — take a consistent, pruned, gzipped snapshot of the OmniRoute
// SQLite database and publish it as a GitHub Release asset.
//
// Runs as a SEPARATE PROCESS from the supervisor on purpose: the snapshot does
// real disk I/O (VACUUM + gzip of a multi-MB file) and must never block the
// supervisor's event loop or the OmniRoute server's event loop.
//
// Usage: node snapshot.mjs auto|manual
//
// Output: a single JSON line on stdout describing the result.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import {
  AUTO_PREFIX,
  MANUAL_PREFIX,
  deleteRelease,
  gh,
  listSnapshots,
  publishSnapshot,
  configRepo,
  tagToDate,
  tsTag,
} from "./github.mjs";

const require = createRequire(import.meta.url);

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = path.join(DATA_DIR, "storage.sqlite");
const ASSET_NAME = "omniroute-config.sqlite.gz";
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const KEEP_AUTO_DAYS = 100;
const KEEP_AUTO_WEEKS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// Conservative denylist: only tables that hold logs, telemetry, caches and
// other disposable runtime state. Anything not listed here is preserved, so a
// missing entry can only cost us a little space — never a piece of config.
const RUNTIME_TABLES = [
  "usage_history",
  "daily_usage_summary",
  "hourly_usage_summary",
  "token_ledger",
  "call_logs",
  "request_detail_logs",
  "relay_logs",
  "middleware_logs",
  "proxy_logs",
  "routing_decisions",
  "domain_cost_history",
  "domain_budget_reset_logs",
  "compression_analytics",
  "compression_cache_stats",
  "quota_snapshots",
  "quota_consumption",
  "provider_quota_state",
  "provider_quota_reset_events",
  "api_key_token_counters",
  "api_key_token_limit_reset_logs",
  "semantic_cache",
  "reasoning_cache",
  "session_model_history",
  "session_account_affinity",
  "conversation_turn_nodes",
  "agentic_conversations",
  "mcp_tool_audit",
  "skill_executions",
  "plugin_analytics",
  "plugin_metrics",
  "audit_log",
  "config_audit_log",
  "xp_audit_log",
  "radar_feed_cache",
  "radar_intel_cache",
  "radar_offers_cache",
  "radar_referrals_cache",
  "radar_local_model_state",
  "inspector_session_requests",
  "inspector_sessions",
  "job_runs",
  "eval_runs",
  "discovery_results",
  "free_proxy_sync_errors",
  "webhook_deliveries",
  "connection_runtime_state",
  "agent_bridge_state",
  "combo_adaptation_state",
  "exclusive_connection_leases",
  "relay_rate_limits",
  "proxy_scope_rotation",
  "a2a_task_events",
  "a2a_tasks",
  "leaderboard",
  "tier_assignments",
  "user_badges",
  "user_levels",
];

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return String(d.getUTCFullYear()) + "-W" + String(week).padStart(2, "0");
}

function pruneAndVacuum(sqlitePath) {
  const Database = require("better-sqlite3");
  const db = new Database(sqlitePath);
  const cleared = {};
  try {
    db.pragma("journal_mode = DELETE");
    const present = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(function (r) {
          return r.name;
        })
    );
    const tx = db.transaction(function () {
      for (const t of RUNTIME_TABLES) {
        if (!present.has(t)) continue;
        try {
          const info = db.prepare('DELETE FROM "' + t + '"').run();
          if (info.changes > 0) cleared[t] = info.changes;
        } catch (e) {
          // A table may be virtual or protected; never fail the snapshot for it.
        }
      }
    });
    tx();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  return cleared;
}

async function sweepRetention() {
  const all = await listSnapshots();
  const manual = all.filter(function (r) {
    return r.manual;
  });
  const auto = all.filter(function (r) {
    return !r.manual;
  });
  const keep = new Set();
  for (const r of manual) keep.add(r.id);

  const now = Date.now();
  for (const r of auto) {
    const d = tagToDate(r.tag);
    if (d && now - d.getTime() <= KEEP_AUTO_DAYS * DAY_MS) keep.add(r.id);
  }

  const byWeek = new Map();
  for (const r of auto) {
    const d = tagToDate(r.tag);
    if (!d) continue;
    const k = isoWeekKey(d);
    if (!byWeek.has(k)) byWeek.set(k, r);
  }
  const weeks = Array.from(byWeek.keys()).sort().reverse().slice(0, KEEP_AUTO_WEEKS);
  for (const k of weeks) keep.add(byWeek.get(k).id);

  const doomed = auto.filter(function (r) {
    return !keep.has(r.id);
  });
  const repo = configRepo();
  let deleted = 0;
  for (const r of doomed) {
    try {
      await deleteRelease(r.id);
      await gh("/repos/" + repo + "/git/refs/tags/" + encodeURIComponent(r.tag), {
        method: "DELETE",
      });
      deleted++;
    } catch (e) {
      // Retention is best-effort; never fail a successful snapshot because of it.
    }
  }
  return {
    total: all.length,
    manual: manual.length,
    auto: auto.length,
    kept: all.length - deleted,
    deleted: deleted,
  };
}

async function main() {
  const mode = process.argv[2] === "manual" ? "manual" : "auto";
  const started = Date.now();
  const result = { ok: false, mode: mode, steps: {} };

  if (!fs.existsSync(DB_PATH)) {
    result.error = "database not found at " + DB_PATH;
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-snap-"));
  const tmpDb = path.join(tmpDir, "snapshot.sqlite");
  try {
    const Database = require("better-sqlite3");
    const live = new Database(DB_PATH, { readonly: false });
    try {
      await live.backup(tmpDb);
    } finally {
      live.close();
    }
    result.steps.rawBytes = fs.statSync(tmpDb).size;

    const cleared = pruneAndVacuum(tmpDb);
    result.steps.pruned = Object.keys(cleared).length;
    result.steps.prunedBytes = fs.statSync(tmpDb).size;

    const gz = zlib.gzipSync(fs.readFileSync(tmpDb), { level: 9 });
    result.steps.gzBytes = gz.length;

    if (gz.length > MAX_SNAPSHOT_BYTES) {
      throw new Error(
        "snapshot too large: " + gz.length + " bytes > " + MAX_SNAPSHOT_BYTES
      );
    }

    const prefix = mode === "manual" ? MANUAL_PREFIX : AUTO_PREFIX;
    const tag = tsTag(prefix);
    const body =
      "mode: " +
      mode +
      "\nraw: " +
      result.steps.rawBytes +
      "\npruned: " +
      result.steps.prunedBytes +
      "\ngz: " +
      result.steps.gzBytes +
      "\ncreatedAt: " +
      new Date().toISOString() +
      "\n";
    const published = await publishSnapshot(tag, body, gz, ASSET_NAME);
    result.steps.published = published;

    if (mode === "auto") {
      result.steps.retention = await sweepRetention();
    }
    result.ok = true;
  } catch (err) {
    result.error = err && err.message ? err.message : String(err);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }
  result.ms = Date.now() - started;
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

main();
