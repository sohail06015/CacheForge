# strata

An in-memory key-value database engine built from scratch in TypeScript. Redis-compatible on the wire, plus one thing Redis doesn't have: an **automatic cache invalidation graph**.

Declare that a cached key is derived from other keys, and strata deletes it for you whenever any source changes — transitively. Redis has no concept of a relationship between keys, so that bookkeeping normally lives in application code, where forgetting one line means serving stale data silently.

```
SET user:1 alice
SET cache:profile:1 "<rendered html>"
DEPEND cache:profile:1 user:1

SET user:1 bob        →  cache:profile:1 is gone, automatically
```

---

## Table of contents

1. [Quick start](#quick-start)
2. [What this is and isn't](#what-this-is-and-isnt)
3. [Architecture](#architecture)
4. [How each piece works](#how-each-piece-works)
5. [The cache dependency graph](#the-cache-dependency-graph)
6. [Command reference](#command-reference)
7. [Configuration](#configuration)
8. [Tests](#tests)
9. [Project layout](#project-layout)
10. [Design decisions](#design-decisions-and-why)
11. [Known limits](#known-limits)
12. [Next steps](#good-next-steps)

---

## Quick start

Requires **Node 18+**.

```bash
npm install
```

Then three terminals, all from the project root:

```bash
npm run dev:backend      # the engine    → :6380 (RESP) + :8080 (dashboard API)
npm run dev:frontend     # the dashboard → :5173
node scripts/seed.js     # sample data (exits when done)
```

Open <http://localhost:5173>. Click `cache:profile:1` to see its place in the dependency graph.

The third terminal is now free for the CLI:

```bash
npm run dev:cli
```

Because strata speaks real RESP, the actual `redis-cli` works too:

```bash
redis-cli -p 6380 SET user:1 alice
```

### See the flagship feature in 30 seconds

In the dashboard Console tab (one line at a time):

```
EXISTS cache:profile:1 cache:feed:1     → 2
SET user:1 bob
EXISTS cache:profile:1 cache:feed:1     → 0
```

Both caches vanished from a single write, transitively.

---

## What this is and isn't

**It is** a working in-memory database: RESP protocol, five data types, expiry, persistence, pub/sub, ~57 commands, a CLI, and a web dashboard. Real Redis clients connect to it.

**It isn't** production infrastructure. No transactions, clustering, replication, or TLS. Written in TypeScript rather than C. Don't put real user data in it or expose port 6380 publicly.

The point is understanding how a database works from the socket up — and then adding something genuinely new on top.

---

## Architecture

Three separate programs that agree on protocols, not on code:

```
┌──────────────┐   RESP over TCP    ┌─────────────────────────┐
│  CLI client  │ ─────────────────► │                         │
└──────────────┘      :6380         │                         │
                                    │      strata engine      │
┌──────────────┐                    │                         │
│ redis-cli /  │ ─────────────────► │   ┌─────────────────┐   │
│ any client   │      :6380         │   │  Store (Map)    │   │
└──────────────┘                    │   │  + dep graph    │   │
                                    │   └─────────────────┘   │
┌──────────────┐  HTTP + WebSocket  │            │            │
│  Dashboard   │ ◄────────────────► │            ▼            │
│   (React)    │      :8080         │      AOF log file       │
└──────────────┘                    └─────────────────────────┘
```

**Why two ports?** Browsers can't open raw TCP sockets, so the dashboard can't speak RESP. Database clients get RESP on 6380; the dashboard gets a JSON HTTP API plus a WebSocket on 8080. Same engine, two front doors.

**Why 6380?** One above Redis's default 6379, so you can run both side by side and compare behaviour.

---

## How each piece works

### `core/store.ts` — the database itself

Everything else in this repo is a way of talking to this one class.

**Keyspace.** A `Map<string, Entry>`. O(1) average get/set/delete — the same complexity class as the hash table real Redis uses. A million keys is as fast as ten.

**Five types**, matching Redis: `string`, `list`, `hash`, `set`, `zset`. Each entry is tagged with its type, so wrong-type operations (`LPUSH` on a string) fail loudly with `WRONGTYPE` instead of corrupting data.

**Expiry uses two strategies at once.** Neither works alone:

- _Lazy_ — when a key is read, check if it's expired and delete it then. Cheap, but a key nobody reads would sit in RAM forever.
- _Active_ — a background timer samples ~20 keys every 200ms and evicts expired ones. This is Redis's `activeExpireCycle` in miniature. Sampling rather than full-scanning is what keeps it from stalling on a large keyspace.

Lazy alone leaks memory. Active alone can't guarantee an expired key is never returned. Together they cover both.

**Every mutation calls `touch()`**, which cascades invalidation through the dependency graph. Doing it in the store rather than in each command handler means the feature can't be forgotten when someone adds a new command.

### `protocol/resp.ts` — the wire format

RESP is how Redis clients and servers talk. It's deliberately trivial to parse, which is part of why Redis is fast. The first byte tells you the type:

| Byte | Type          | Example                            |
| ---- | ------------- | ---------------------------------- |
| `+`  | Simple string | `+OK\r\n`                          |
| `-`  | Error         | `-ERR unknown command\r\n`         |
| `:`  | Integer       | `:42\r\n`                          |
| `$`  | Bulk string   | `$5\r\nhello\r\n`                  |
| `*`  | Array         | `*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n` |

A command is always an array of bulk strings. `SET foo bar` goes over the wire as:

```
*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
```

Bulk strings are **length-prefixed** (`$5` = exactly 5 bytes follow), which is why values can contain spaces, newlines, or binary data without ambiguity.

**The parser is streaming, and this is the subtle part.** TCP is a byte stream, not a message stream. One `socket.on("data")` event may contain half a command, or three commands at once. So the parser buffers incoming bytes and only yields a command once it has fully arrived, returning `null` otherwise. The server drains in a `while` loop for exactly this reason.

> Assuming "one read = one command" is the classic way to write a protocol server that passes every test and breaks under real load.

### `core/skiplist.ts` — O(log n) sorted sets

A sorted array gives fast lookup via binary search, but O(n) insert — everything after the insertion point shifts. A balanced tree fixes that but needs rotation logic that's genuinely hard to get right.

A **skip list** is the clever middle path, and it's what real Redis uses.

Keep a normal sorted linked list at level 0. Build sparser "express lane" lists above it: each node is promoted upward with probability 1/4, so level 1 holds ~1/4 of nodes, level 2 ~1/16.

To search, start top-left and move right while the next node is still too small; when it would overshoot, drop down a level. You skip huge spans near the top and narrow in as you descend — binary search over a linked list.

The trick is that heights are **random rather than rebalanced**. No rotations, no rebalancing code, and the probabilistic guarantee is strong enough that Redis ships it. Expected O(log n) insert, delete, and rank.

Each node also stores a **span** (how many level-0 nodes its forward pointer jumps over), which is what makes `ZRANK` O(log n) instead of a linear count.

### `commands/index.ts` — the command table

A flat map of command name to handler. Real Redis uses the same pattern internally. Handlers take `(store, args)` and are deliberately connection-unaware, so adding a command is a few lines that touch nothing else.

Arity is checked before the handler runs, so handlers can assume valid input.

### `pubsub/pubsub.ts` — publish/subscribe

Subscriptions break the assumption everything else relies on. Every normal command is request/response and connection-agnostic — `GET` doesn't care who's asking. Pub/sub must remember which socket listens to which channel, and **push** messages to sockets that didn't ask for anything right now.

That's why it lives outside the command table: the TCP server intercepts these commands before dispatch so it can pass the connection in.

A subscriber is anything with a `send()`, which is why the dashboard's WebSocket can subscribe through the same broker.

Two details that are easy to miss:

- **Subscribers must be removed on disconnect**, or the broker holds a reference to every client that ever connected — a leak that only appears under real traffic.
- **A subscribed connection is restricted** to pub/sub commands, matching Redis.

### `persistence/aof.ts` — durability

AOF = Append-Only File. Every write command is appended as it happens. On startup the log is replayed to rebuild identical state.

**Disk is off the read path entirely.** Reads never touch disk — that's why persistence doesn't slow the engine down. The AOF grows, but the Map doesn't get slower.

Two details worth understanding:

**Commands are RESP-encoded, not space-separated.** The naive "join with spaces" format silently corrupts any value containing a space: `SET msg "hello world"` would replay as `SET msg hello`, losing data. RESP is length-prefixed, so values can contain anything.

**`rewrite()` compacts the log.** Without it the file grows forever — a key written a million times keeps a million entries though only the last matters. Compaction regenerates the minimum command set from live state, writes to a temp file, and renames. Rename is atomic on POSIX, so a crash mid-rewrite leaves the old log intact rather than a half-written one.

### `server/tcpServer.ts` and `server/apiServer.ts`

The TCP server gives each connection its own parser but shares one `Store` — that shared store is what makes this a database rather than per-connection scratch space.

The API server exposes JSON endpoints for the dashboard, plus a WebSocket that pushes stats every second.

**Two transports on purpose:** stats arrive over WebSocket because they change every tick; the key list is polled every 2 seconds because it rarely changes. Not every piece of state needs the same delivery mechanism.

---

## The cache dependency graph

### The problem

Cache invalidation is famously one of the two hard problems in computer science.

You store a user in `user:1`. Rendering their profile page is slow, so you cache the finished HTML in `cache:profile:1`.

The user changes their name. **Redis has no idea those two keys are related.** Your application must remember to delete the cache — in the settings handler, the admin panel, the migration script, the webhook. Miss one path and you serve stale data silently, sometimes for days, with no error anywhere.

### The fix

Declare the relationship once, where the cache is built:

```
SET user:1 alice
SET cache:profile:1 "<rendered html>"
DEPEND cache:profile:1 user:1
```

From then on, any write to `user:1` invalidates `cache:profile:1` automatically.

Cascading works transitively, so a chain collapses in one write:

```
DEPEND cache:feed:1 cache:profile:1
SET user:1 carol        # invalidates BOTH profile and feed
```

### Using it in application code

```js
async function getProfile(userId) {
  const cacheKey = `cache:profile:${userId}`;

  const cached = await nova.get(cacheKey);
  if (cached) return cached; // hit

  const html = await renderProfile(userId); // slow path
  await nova.set(cacheKey, html);
  await nova.depend(cacheKey, [`user:${userId}`, `user:${userId}:settings`]);
  return html;
}
```

Then anywhere that updates a user:

```js
await nova.set(`user:${userId}`, JSON.stringify(newData));
// cache:profile:N is already gone. No cleanup code needed.
```

Declaring the dependency at cache-write time is deliberate: the code that _builds_ the cache is the code that knows what it read.

### Why it's cheap

The graph stores key **names**, not values — two adjacency maps of short strings. Thousands of relationships cost a few hundred KB, and the write path does one map lookup that returns empty for keys with no dependents.

This is a deliberate contrast with value-snapshot approaches (an earlier version of this project did per-write snapshots for rollback), whose cost scales with the size of the data itself.

### Reacting to invalidation

Events publish to the reserved channel `__strata:invalidate`, so applications can warm a new value or record a metric without polling:

```
SUBSCRIBE __strata:invalidate
```

---

## Deploying

### Backend (Render web service)

| Setting       | Value                                     |
| ------------- | ----------------------------------------- |
| Build Command | `npm install && npm run build -w backend` |
| Start Command | `node backend/dist/index.js`              |

Environment variables:

| Key               | Value                                     |
| ----------------- | ----------------------------------------- |
| `strata_PASSWORD` | a strong password — the service is public |
| `strata_DATA_DIR` | `/tmp/strata`                             |

The server reads `PORT` first, which is how Render (and most PaaS hosts)
assign a port.

**Two constraints worth knowing.** A Render web service exposes exactly one
HTTP port, so the dashboard API works but the RESP/TCP port is unreachable —
`redis-cli` can't connect to a deployed instance. And the free tier has an
ephemeral filesystem that's wiped on redeploy, and sleeps after ~15 minutes
idle, so a cold first request takes ~30 seconds and starts with an empty
keyspace.

### Frontend (Render static site)

| Setting           | Value                                      |
| ----------------- | ------------------------------------------ |
| Build Command     | `npm install && npm run build -w frontend` |
| Publish Directory | `frontend/dist`                            |
| `VITE_API_BASE`   | `https://your-backend.onrender.com`        |

`VITE_API_BASE` is only needed in production. Locally, Vite's dev proxy
forwards `/api` to port 8080, so leave it unset. See `frontend/.env.example`.

---

## Command reference

**Strings**
`SET` (EX/PX/NX/XX/KEEPTTL) · `GET` · `MGET` · `MSET` · `SETEX` · `INCR` · `DECR` · `INCRBY` · `DECRBY` · `APPEND` · `STRLEN`

**Generic**
`DEL` · `EXISTS` · `TYPE` · `KEYS` · `RENAME` · `EXPIRE` · `PERSIST` · `TTL` · `DBSIZE` · `FLUSHALL` · `INFO` · `COMMAND` · `PING` · `ECHO`

**Lists**
`LPUSH` · `RPUSH` · `LPOP` · `RPOP` · `LLEN` · `LRANGE`

**Hashes**
`HSET` · `HGET` · `HDEL` · `HEXISTS` · `HKEYS` · `HVALS` · `HLEN` · `HGETALL`

**Sets**
`SADD` · `SREM` · `SISMEMBER` · `SCARD` · `SMEMBERS`

**Sorted sets**
`ZADD` · `ZREM` · `ZSCORE` · `ZRANK` · `ZCARD` · `ZRANGE` (WITHSCORES) · `ZRANGEBYSCORE`

**Pub/Sub**
`SUBSCRIBE` · `PSUBSCRIBE` · `UNSUBSCRIBE` · `PUBLISH` · `PUBSUB CHANNELS`

**Dependency graph**
| Command | Does |
|---|---|
| `DEPEND <derived> <source...>` | Declare what a cached key is built from |
| `UNDEPEND <key>` | Remove a key from the graph entirely |
| `DEPS <key>` | Keys invalidated when this one changes |
| `DEPENDSON <key>` | What this key was built from |
| `CASCADE <key>` | Preview the full blast radius, without deleting |
| `INVALIDATE <key>` | Delete a key and everything downstream |
| `GRAPH` | Every declared edge |

**Auth**
`AUTH` — only when `strata_PASSWORD` is set.

> Values containing spaces need quotes: `SET msg "hello world"`

---

## Configuration

| Variable          | Default  | Purpose                           |
| ----------------- | -------- | --------------------------------- |
| `strata_PORT`     | `6380`   | RESP/TCP port                     |
| `strata_API_PORT` | `8080`   | Dashboard HTTP + WebSocket port   |
| `strata_DATA_DIR` | `./data` | Where the AOF log lives           |
| `strata_PASSWORD` | unset    | If set, clients must `AUTH` first |

---

## Tests

```bash
cd backend
npm test
```

Works on Windows, macOS, and Linux — the runner is plain Node, with no shell script or `/tmp` assumptions.

Five suites, all driving a real server over a real socket rather than reaching into internals:

| Suite                      | Covers                                                               |
| -------------------------- | -------------------------------------------------------------------- |
| `commands.test.js`         | Every command, error cases, expiry                                   |
| `pubsub.test.js`           | Delivery, patterns, subscribe-mode restriction, cleanup              |
| `depgraph.test.js`         | Cascade, transitivity, cycle safety, manual invalidation             |
| `depgraph-persist.test.js` | The graph survives a restart and still fires                         |
| `persistence.test.js`      | Kills and restarts the server; all five types survive                |
| `skiplist.test.ts`         | 200 randomized trials against a naive reference, including rank/span |

---

## Project layout

```
strata/
├── backend/
│   ├── src/
│   │   ├── core/store.ts             the database
│   │   ├── core/skiplist.ts          O(log n) sorted sets
│   │   ├── core/depgraph.ts          dependency / invalidation graph
│   │   ├── protocol/resp.ts          RESP encoder + streaming parser
│   │   ├── commands/index.ts         command table (~57 commands)
│   │   ├── pubsub/pubsub.ts          channel + pattern broker
│   │   ├── persistence/aof.ts        append-only log + compaction
│   │   ├── server/tcpServer.ts       RESP server        :6380
│   │   ├── server/apiServer.ts       HTTP + WS API      :8080
│   │   └── index.ts                  startup, replay, shutdown
│   └── tests/                        five suites + cross-platform runner
├── cli/src/index.ts            redis-cli-style REPL
├── scripts/seed.js             sample data loader
├── docs/how-it-works.md        one command traced end to end
└── frontend/src/
    ├── api/client.ts           typed HTTP client
    ├── hooks/useLiveStats.ts   WebSocket + REST hybrid
    └── components/             Sidebar, KeyDetail, DependencyView, CommandConsole
```

---

## Design decisions, and why

These are the parts worth being able to defend.

**Invalidation deletes rather than recomputes.**
The engine has no idea how a cache was built; only the application does. Deleting turns a correctness problem (stale data served silently) into a cache miss the application already handles.

**Cycles are survivable.**
Users will accidentally declare `a → b → a`. Cascade is breadth-first with a visited set, so it terminates. `DEPEND` replies `OK CYCLE n` to warn without failing.

**Edges outlive invalidation.**
A cache that gets invalidated will be rebuilt, so it keeps its declared sources. Only `UNDEPEND` removes them.

**`DEPEND` is written to the AOF.**
Otherwise the graph would be empty after a reboot and invalidation would silently stop working — the worst kind of bug.

**Replay suppresses invalidation.**
Rebuilding from the log would otherwise invalidate caches the log is about to recreate, so state would come back wrong — and differently depending on log order.

**AOF replay bypasses the TCP server.**
Replay calls the dispatcher directly. Route it through the normal server path and every restart re-appends the whole log to itself; the file doubles each boot.

**Only successful writes are logged.**
Logging a failed command would corrupt state on replay, since it would be re-applied at startup as though it had worked.

**Empty collections are deleted.**
Popping the last element of a list removes the key, matching Redis. Keeping an empty key would make `EXISTS` disagree with `LLEN`.

---

## Known limits

Worth stating before someone finds them:

- **No transactions** — `MULTI`/`EXEC`/`WATCH` are unimplemented.
- **AOF rewrite is synchronous.** Redis forks a background process; this blocks briefly during compaction.
- **No replication or clustering.** Single node only.
- **No `maxmemory` eviction.** At capacity this would fill RAM until Node crashed. Redis fails cleanly instead of letting the OS swap.
- **AUTH is plaintext** and there's no TLS.
- **Single-threaded**, like real Redis — but without Redis's I/O threading for network reads.

### On RAM as the binding constraint

In-memory databases trade capacity for speed. When RAM fills, the OS starts swapping and performance collapses — worse than a disk-based database, which is at least designed for disk access patterns.

That's why Redis isn't a replacement for Postgres. It sits _in front of_ one, holding the small hot slice you touch constantly: sessions, counters, leaderboards, cached renders. If a cache entry is lost, you re-fetch from the source. Slower once, but nothing breaks.

---

## Good next steps

1. **`maxmemory` with LRU eviction** — a real answer for what happens at capacity. Self-contained, and forces you to think about access-frequency tracking.
2. **`MULTI`/`EXEC`/`WATCH` transactions** — forces per-connection command queues, the same architectural problem pub/sub already made you solve once.
3. **Background AOF rewrite** via a worker thread or child process.
4. **Secondary indexes** — `FIND users WHERE age > 30`, which Redis genuinely can't do. The natural second differentiator.
5. **Replication** — a second node that replays the primary's command stream. Pub/sub is already most of the transport you'd need.
