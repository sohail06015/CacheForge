import { Store } from "./core/store";
import { AofLog } from "./persistence/aof";
import { PubSub } from "./pubsub/pubsub";
import { startTcpServer } from "./server/tcpServer";
import { startApiServer } from "./server/apiServer";
import { dispatch } from "./commands";

const DATA_DIR = process.env.cacheforge_DATA_DIR || "./data";
const RESP_PORT = Number(process.env.cacheforge_PORT || 6380);
const API_PORT = Number(process.env.cacheforge_API_PORT || 8080);
const PASSWORD = process.env.cacheforge_PASSWORD || undefined;

const store = new Store();
const aof = new AofLog(DATA_DIR);
const pubsub = new PubSub();

// --- Startup: rebuild state from disk ---
//
// Replay runs with `replaying = true` so cascade invalidation is suppressed.
// Without that, replaying "SET user:1 ..." would invalidate caches that the
// log is about to recreate a few lines later - state would come back wrong,
// and differently depending on log order.
store.replaying = true;
const replayLog = aof.replay();
for (const { command, args } of replayLog) {
  dispatch(store, command, args);
}
store.replaying = false;

// Replay isn't real traffic, so it shouldn't show up in the stats.
store.stats.commandsProcessed = 0;

console.log(
  `[CacheForge] Replayed ${replayLog.length} commands and ${store.deps.size} dependency declarations from ${DATA_DIR}`
);

// Invalidation is published on a reserved channel, so applications can react
// to cache drops (warm a new value, log a metric) without polling.
store.onInvalidate = (source, removed) => {
  pubsub.publish("__cacheforge:invalidate", JSON.stringify({ source, removed }));
};

// Compact the log at startup: it may hold a long tail of superseded writes.
aof.rewrite(store.rebuildCommands());

const tcp = startTcpServer(store, aof, pubsub, RESP_PORT, PASSWORD);
const api = startApiServer(store, pubsub, API_PORT);

if (PASSWORD) console.log("[CacheForge] AUTH required (cacheforge_PASSWORD is set)");

// --- Graceful shutdown ---
// Without this, Ctrl-C between a write and its flush can lose data.
function shutdown(signal: string) {
  console.log(`\n[CacheForge] ${signal} received, flushing to disk...`);
  try {
    aof.rewrite(store.rebuildCommands());
  } catch (err) {
    console.error("[CacheForge] error during shutdown flush:", err);
  }
  store.close();
  tcp.close();
  api.close();
  console.log("[CacheForge] shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
