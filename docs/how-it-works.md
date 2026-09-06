# How strata actually works

This walks through everything that happens for a single command, so you can
explain any piece of it in your own words.

## The journey of `SET name strata`

### 1. It starts as bytes on a socket

Whether you type it into the CLI or a Redis client library sends it, the
command is encoded as **RESP** (REdis Serialization Protocol) before it ever
touches the network:

```
*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$6\r\nstrata\r\n
```

Breaking that down:

- `*3` — "an array of 3 elements follows" (the command + its 2 arguments)
- `$3\r\nSET\r\n` — "a bulk string of length 3: SET"
- `$4\r\nname\r\n` — "a bulk string of length 4: name"
- `$6\r\nstrata\r\n` — "a bulk string of length 6: strata"

This is deliberately simple to parse — no nested brackets to balance, no
quoting rules — which is part of why Redis (and strata) can process huge
numbers of commands per second. See `backend/src/protocol/resp.ts`.

### 2. The TCP server buffers and parses it

`backend/src/server/tcpServer.ts` listens on port 6380. TCP is a _stream_,
not a sequence of neat messages — a single `SET` command might arrive
split across two network packets, or two commands might arrive bundled in
one packet (this is called **pipelining**, and real Redis clients do it for
performance). That's why `RespParser` in `resp.ts` keeps an internal buffer
and only "takes" a command once it's fully present, looping in case
multiple commands are sitting in the buffer at once.

### 3. It gets logged before anything else happens

Before touching the store, the server checks if this is a _write_ command
(`SET`, `DEL`, `LPUSH`, etc. — see `WRITE_COMMANDS` in `tcpServer.ts`) and,
if so, appends it to `backend/data/strata.aof` first. This ordering matters:
if the process crashes right after applying the write but before logging
it, that write would be lost on restart. Logging first (at the cost of a
tiny bit of latency) guarantees durability. This is the same idea as
**write-ahead logging** used by almost every real database.

### 4. The command dispatcher runs it

`backend/src/commands/index.ts` looks up `SET` in a table of handler
functions and calls it with `["name", "strata"]`. This table pattern (name
→ function) is exactly how real Redis's `server.c` command table works
internally — it's a simple, extensible way to add new verbs.

### 5. The store mutates state — and takes a snapshot

`Store.setString()` in `backend/src/core/store.ts`:

1. Wraps the value in a `StoredValue` with a `type` tag (`"string"`), so
   later a `LPUSH` on the same key can correctly reject with `WRONGTYPE`.
2. Writes it into the `Map<string, Entry>` that _is_ the database.
3. Calls `recordVersion()`, which deep-clones the new value and pushes it
   onto a per-key history array. **This one call is the entirety of the
   time-travel feature** — every command handler that mutates data already
   calls it, so history "just works" everywhere without each command
   needing bespoke versioning logic.

### 6. The reply goes back the same way it came in

The store returns nothing meaningful for `SET` (it doesn't throw), so the
dispatcher returns `Resp.simple("OK")`, which `encode()` turns back into
`+OK\r\n` and writes to the socket. The client (CLI or dashboard) decodes
that and shows you `OK`.

## Why expiry has two mechanisms

Real Redis — and strata — check for expired keys in two ways:

- **Lazy expiration**: whenever a key is _read_ (`GET`, `EXISTS`, etc.), we
  first check if its `expireAt` has passed and delete it right then. This
  guarantees you never read a stale value, but a key that's expired and
  never touched again would sit in memory forever.
- **Active expiration**: a timer (`activeExpireCycle` in `store.ts`) runs
  every 200ms and checks a small sample of keys, deleting any that are
  expired. This bounds how long "orphaned" expired keys can occupy memory,
  without the cost of scanning the _entire_ keyspace on every tick.

## Why time-travel doesn't slow everything down

Each key's history is capped at 50 versions (`MAX_VERSIONS_PER_KEY`) — once
exceeded, the oldest version is dropped. This bounds memory per key. For a
production system you'd likely want this configurable, or even periodically
flush old versions to disk instead of dropping them — a natural next
feature to build yourself.

## Where to go next

Ideas for extending strata, roughly in order of difficulty:

1. **`MULTI`/`EXEC` transactions** — queue commands, then run them
   atomically as a batch.
2. **Snapshotting (RDB-style)** — periodically dump the whole store to a
   compact binary file, so startup doesn't require replaying a
   potentially huge AOF log from scratch.
3. **Secondary indexes** — let `HSET` on hashes with the same "shape"
   register into a queryable index, so you could `FIND WHERE field = value`
   across many keys, like a light document database.
4. **Replication** — a second strata instance connects to the first,
   receives a live stream of every write, and stays in sync. This is the
   single most educational feature to build, since it forces you to think
   hard about ordering, network partitions, and consistency.
