import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "../core/store";
import { PubSub, Subscriber } from "../pubsub/pubsub";
import { dispatch, WRITE_COMMANDS } from "../commands";
import { RespValue } from "../protocol/resp";

/**
 * The dashboard can't speak RESP - browsers can't open raw TCP sockets - so
 * it gets a JSON HTTP API plus a WebSocket for live updates. Two protocols
 * on two ports, because they serve two different kinds of client.
 */
export function startApiServer(store: Store, pubsub: PubSub, port = 8080) {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","keys",...]

    const json = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    const readBody = (cb: (body: any) => void) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { cb(raw ? JSON.parse(raw) : {}); }
        catch { json({ error: "invalid JSON body" }, 400); }
      });
    };

    try {
      // GET / - a service index. Without this the bare URL returns 404, which
      // looks broken to anyone opening the deployed link with no context.
      if (parts.length === 0) {
        return json({
          service: "cacheforge",
          description:
            "In-memory key-value engine with automatic cache invalidation via a dependency graph",
          status: "ok",
          uptimeMs: Date.now() - store.stats.startedAt,
          keyCount: store.dbSize(),
          endpoints: {
            "GET /api/stats": "engine counters and uptime",
            "GET /api/keys": "all keys with type, TTL, and dependency counts",
            "GET /api/keys/:key": "one key's full value",
            "GET /api/keys/:key/deps": "what a key is built from and what it invalidates",
            "POST /api/keys/:key/depend": "declare sources: { sources: [...] }",
            "POST /api/keys/:key/invalidate": "drop a key and everything downstream",
            "GET /api/graph": "every declared dependency edge",
            "POST /api/command": "run a raw command: { command: \"SET foo bar\" }",
          },
          note: "The RESP/TCP port (6380) is not exposed on this host; only this HTTP API is.",
        });
      }

      // GET /api/keys
      if (parts[1] === "keys" && parts.length === 2 && req.method === "GET") {
        return json(store.snapshotForDashboard());
      }

      if (parts[1] === "keys" && parts.length >= 3) {
        const key = decodeURIComponent(parts[2]);

        // GET /api/keys/:key  -> full value
        if (parts.length === 3 && req.method === "GET") {
          if (!store.exists(key)) return json({ error: "no such key" }, 404);
          return json({ key, type: store.type(key), ttlMs: store.ttlMs(key), value: store.inspect(key) });
        }

        // DELETE /api/keys/:key
        if (parts.length === 3 && req.method === "DELETE") {
          return json({ deleted: store.del(key) });
        }

        // GET /api/keys/:key/deps -> both directions of the graph
        if (parts[3] === "deps" && req.method === "GET") {
          return json({
            key,
            dependents: store.deps.dependentsOf(key),
            dependencies: store.deps.dependenciesOf(key),
            cascade: store.deps.cascade(key),
          });
        }

        // POST /api/keys/:key/invalidate -> drop it and everything downstream
        if (parts[3] === "invalidate" && req.method === "POST") {
          const removed = store.invalidate(key);
          return json({ ok: true, removed });
        }

        // POST /api/keys/:key/depend  { sources: [...] }
        if (parts[3] === "depend" && req.method === "POST") {
          return readBody((body) => {
            const sources: string[] = Array.isArray(body.sources) ? body.sources : [];
            const res = store.declareDependency(key, sources);
            json({ ok: true, ...res });
          });
        }
      }

      // GET /api/graph -> every declared edge, for the graph view
      if (parts[1] === "graph" && req.method === "GET") {
        return json(store.deps.edges());
      }

      // POST /api/command  { command: "SET foo bar" }
      // Lets the dashboard run commands directly - the console feature.
      if (parts[1] === "command" && req.method === "POST") {
        return readBody((body) => {
          const parsed = parseCommandLine(String(body.command ?? ""));
          if (!parsed.length) return json({ error: "empty command" }, 400);
          const [name, ...args] = parsed;
          const reply = dispatch(store, name, args);
          json({
            ok: reply.kind !== "error",
            command: name.toUpperCase(),
            isWrite: WRITE_COMMANDS.has(name.toUpperCase()),
            reply: flatten(reply),
          });
        });
      }

      if (parts[1] === "channels" && req.method === "GET") {
        return json(pubsub.activeChannels());
      }

      if (parts[1] === "stats" && req.method === "GET") {
        return json({
          ...store.stats,
          uptimeMs: Date.now() - store.stats.startedAt,
          keyCount: store.dbSize(),
          channelCount: pubsub.activeChannels().length,
          dependencyCount: store.deps.size,
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err: any) {
      return json({ error: err?.message ?? "internal error" }, 500);
    }
  });

  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);

    // A WebSocket is a valid pub/sub Subscriber too - same interface as a
    // TCP socket - so the dashboard can watch channels live.
    const subscriber: Subscriber = {
      id: `ws-${Math.random().toString(36).slice(2)}`,
      send: (msg) => ws.send(JSON.stringify({ type: "pubsub", raw: msg })),
    };

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === "subscribe" && msg.channel) pubsub.subscribe(subscriber, msg.channel);
        if (msg.action === "unsubscribe") pubsub.unsubscribe(subscriber, msg.channel);
      } catch { /* ignore malformed frames */ }
    });

    ws.on("close", () => {
      clients.delete(ws);
      pubsub.removeSubscriber(subscriber);
    });
  });

  const tick = setInterval(() => {
    if (clients.size === 0) return;
    const payload = JSON.stringify({
      type: "stats",
      commandsProcessed: store.stats.commandsProcessed,
      keyCount: store.dbSize(),
      expiredKeys: store.stats.expiredKeys,
      timestamp: Date.now(),
    });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }, 1000);
  tick.unref();

  server.listen(port, () => {
    console.log(`[CacheForge] Dashboard API listening on http://localhost:${port}`);
  });

  return server;
}

/** Converts a StoredValue snapshot into JSON-safe output. */
function plain(v: any): unknown {
  switch (v.type) {
    case "string": return v.str;
    case "list": return v.list;
    case "hash": return v.hash ? Object.fromEntries(v.hash) : {};
    case "set": return v.set ? [...v.set] : [];
    case "zset": return v.zset?.toArray ? v.zset.toArray() : v.zset;
    default: return null;
  }
}

/** Flattens a RESP reply into plain JSON for the dashboard console. */
function flatten(reply: RespValue): unknown {
  switch (reply.kind) {
    case "simple": case "error": return reply.value;
    case "integer": return reply.value;
    case "bulk": return reply.value;
    case "array": return reply.value === null ? null : reply.value.map(flatten);
  }
}

/**
 * Splits a command line, respecting quotes so values can contain spaces.
 * `SET msg "hello world"` must parse as 3 tokens, not 4 - the naive
 * split(/\s+/) silently truncates the value.
 */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasToken = false;

  for (const ch of line.trim()) {
    if (escaped) { current += ch; escaped = false; hasToken = true; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { out.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) out.push(current);
  return out;
}
