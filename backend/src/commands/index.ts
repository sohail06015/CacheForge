import { Store } from "../core/store";
import { Resp, RespValue } from "../protocol/resp";

/**
 * The command table: name -> handler. Real Redis uses the same pattern
 * internally. Keeping each command as a small isolated function means
 * adding one touches nothing else.
 *
 * Handlers are deliberately connection-unaware. Commands that DO need the
 * connection (SUBSCRIBE, PUBLISH) can't live here - the TCP server
 * intercepts those before dispatch. See pubsub/pubsub.ts.
 */
type Handler = (store: Store, args: string[]) => RespValue;

/** Commands that mutate state, so the server knows what to write to the AOF. */
export const WRITE_COMMANDS = new Set([
  "SET", "SETEX", "MSET", "DEL", "EXPIRE", "PERSIST", "RENAME", "INCR", "DECR",
  "INCRBY", "DECRBY", "APPEND", "LPUSH", "RPUSH", "LPOP", "RPOP", "HSET", "HDEL",
  "SADD", "SREM", "ZADD", "ZREM", "FLUSHALL", "DEPEND", "UNDEPEND", "INVALIDATE",
]);

/** Enforces arity before a handler runs, so handlers can assume valid input. */
function arity(name: string, args: string[], min: number, max = Infinity) {
  if (args.length < min || args.length > max) {
    throw new Error(`ERR wrong number of arguments for '${name.toLowerCase()}' command`);
  }
}

function toInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error("ERR value is not an integer or out of range");
  return n;
}

function toFloat(raw: string): number {
  // Redis accepts +inf/-inf as score bounds in ZRANGEBYSCORE.
  if (raw === "+inf" || raw === "inf") return Infinity;
  if (raw === "-inf") return -Infinity;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error("ERR value is not a valid float");
  return n;
}

export const commandTable: Record<string, Handler> = {
  // ---- Connection / server ----
  PING: (_s, args) => (args.length ? Resp.bulk(args[0]) : Resp.simple("PONG")),
  ECHO: (_s, args) => { arity("ECHO", args, 1, 1); return Resp.bulk(args[0]); },
  DBSIZE: (store) => Resp.integer(store.dbSize()),
  FLUSHALL: (store) => { store.flushAll(); return Resp.simple("OK"); },
  INFO: (store) => {
    const s = store.stats;
    return Resp.bulk(
      [
        "# Server",
        "strata_version:1.0.0",
        `uptime_in_seconds:${Math.floor((Date.now() - s.startedAt) / 1000)}`,
        "# Stats",
        `total_commands_processed:${s.commandsProcessed}`,
        `expired_keys:${s.expiredKeys}`,
        "# Keyspace",
        `db0:keys=${store.dbSize()}`,
      ].join("\r\n")
    );
  },
  COMMAND: () => Resp.array(Object.keys(commandTable).map((c) => Resp.bulk(c))),

  // ---- Generic ----
  DEL: (store, args) => { arity("DEL", args, 1); return Resp.integer(args.filter((k) => store.del(k)).length); },
  EXISTS: (store, args) => { arity("EXISTS", args, 1); return Resp.integer(args.filter((k) => store.exists(k)).length); },
  TYPE: (store, args) => { arity("TYPE", args, 1, 1); return Resp.simple(store.type(args[0]) ?? "none"); },
  KEYS: (store, args) => Resp.array(store.keys(args[0]).map((k) => Resp.bulk(k))),
  RENAME: (store, args) => {
    arity("RENAME", args, 2, 2);
    if (!store.rename(args[0], args[1])) throw new Error("ERR no such key");
    return Resp.simple("OK");
  },
  EXPIRE: (store, args) => {
    arity("EXPIRE", args, 2, 2);
    return Resp.integer(store.expire(args[0], toInt(args[1])) ? 1 : 0);
  },
  PERSIST: (store, args) => { arity("PERSIST", args, 1, 1); return Resp.integer(store.persist(args[0]) ? 1 : 0); },
  TTL: (store, args) => {
    arity("TTL", args, 1, 1);
    const ms = store.ttlMs(args[0]);
    if (ms === null) return Resp.integer(-2); // no such key
    if (ms === -1) return Resp.integer(-1);   // exists, no expiry
    return Resp.integer(Math.ceil(ms / 1000));
  },

  // ---- Strings ----
  SET: (store, args) => {
    arity("SET", args, 2);
    const [key, value, ...opts] = args;
    let expireSeconds: number | undefined;
    let keepTtl = false;
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i].toUpperCase();
      if (o === "EX") expireSeconds = toInt(opts[++i]);
      else if (o === "PX") expireSeconds = toInt(opts[++i]) / 1000;
      else if (o === "KEEPTTL") keepTtl = true;
      else if (o === "NX") { if (store.exists(key)) return Resp.bulk(null); }
      else if (o === "XX") { if (!store.exists(key)) return Resp.bulk(null); }
      else throw new Error("ERR syntax error");
    }
    store.setString(key, value, { expireSeconds, keepTtl });
    return Resp.simple("OK");
  },
  SETEX: (store, args) => {
    arity("SETEX", args, 3, 3);
    store.setString(args[0], args[2], { expireSeconds: toInt(args[1]) });
    return Resp.simple("OK");
  },
  GET: (store, args) => { arity("GET", args, 1, 1); return Resp.bulk(store.getString(args[0])); },
  MGET: (store, args) => { arity("MGET", args, 1); return Resp.array(args.map((k) => Resp.bulk(store.getString(k)))); },
  MSET: (store, args) => {
    arity("MSET", args, 2);
    if (args.length % 2 !== 0) throw new Error("ERR wrong number of arguments for 'mset' command");
    for (let i = 0; i < args.length; i += 2) store.setString(args[i], args[i + 1]);
    return Resp.simple("OK");
  },
  INCR: (store, args) => { arity("INCR", args, 1, 1); return Resp.integer(store.incrBy(args[0], 1)); },
  DECR: (store, args) => { arity("DECR", args, 1, 1); return Resp.integer(store.incrBy(args[0], -1)); },
  INCRBY: (store, args) => { arity("INCRBY", args, 2, 2); return Resp.integer(store.incrBy(args[0], toInt(args[1]))); },
  DECRBY: (store, args) => { arity("DECRBY", args, 2, 2); return Resp.integer(store.incrBy(args[0], -toInt(args[1]))); },
  APPEND: (store, args) => { arity("APPEND", args, 2, 2); return Resp.integer(store.append(args[0], args[1])); },
  STRLEN: (store, args) => { arity("STRLEN", args, 1, 1); return Resp.integer((store.getString(args[0]) ?? "").length); },

  // ---- Lists ----
  LPUSH: (store, args) => { arity("LPUSH", args, 2); return Resp.integer(store.pushList(args[0], args.slice(1), true)); },
  RPUSH: (store, args) => { arity("RPUSH", args, 2); return Resp.integer(store.pushList(args[0], args.slice(1), false)); },
  LPOP: (store, args) => { arity("LPOP", args, 1, 1); return Resp.bulk(store.popList(args[0], true)); },
  RPOP: (store, args) => { arity("RPOP", args, 1, 1); return Resp.bulk(store.popList(args[0], false)); },
  LLEN: (store, args) => { arity("LLEN", args, 1, 1); return Resp.integer(store.listLength(args[0])); },
  LRANGE: (store, args) => {
    arity("LRANGE", args, 3, 3);
    return Resp.array(store.rangeList(args[0], toInt(args[1]), toInt(args[2])).map((v) => Resp.bulk(v)));
  },

  // ---- Hashes ----
  HSET: (store, args) => {
    arity("HSET", args, 3);
    if ((args.length - 1) % 2 !== 0) throw new Error("ERR wrong number of arguments for 'hset' command");
    let added = 0;
    for (let i = 1; i < args.length; i += 2) if (store.hashSet(args[0], args[i], args[i + 1])) added++;
    return Resp.integer(added);
  },
  HGET: (store, args) => { arity("HGET", args, 2, 2); return Resp.bulk(store.hashGet(args[0], args[1])); },
  HDEL: (store, args) => { arity("HDEL", args, 2); return Resp.integer(store.hashDel(args[0], args.slice(1))); },
  HEXISTS: (store, args) => { arity("HEXISTS", args, 2, 2); return Resp.integer(store.hashGet(args[0], args[1]) !== null ? 1 : 0); },
  HKEYS: (store, args) => { arity("HKEYS", args, 1, 1); return Resp.array(Object.keys(store.hashGetAll(args[0])).map((k) => Resp.bulk(k))); },
  HVALS: (store, args) => { arity("HVALS", args, 1, 1); return Resp.array(Object.values(store.hashGetAll(args[0])).map((v) => Resp.bulk(v))); },
  HLEN: (store, args) => { arity("HLEN", args, 1, 1); return Resp.integer(Object.keys(store.hashGetAll(args[0])).length); },
  HGETALL: (store, args) => {
    arity("HGETALL", args, 1, 1);
    const flat: RespValue[] = [];
    for (const [f, v] of Object.entries(store.hashGetAll(args[0]))) flat.push(Resp.bulk(f), Resp.bulk(v));
    return Resp.array(flat);
  },

  // ---- Sets ----
  SADD: (store, args) => { arity("SADD", args, 2); return Resp.integer(store.setAdd(args[0], args.slice(1))); },
  SREM: (store, args) => { arity("SREM", args, 2); return Resp.integer(store.setRemove(args[0], args.slice(1))); },
  SISMEMBER: (store, args) => { arity("SISMEMBER", args, 2, 2); return Resp.integer(store.setIsMember(args[0], args[1]) ? 1 : 0); },
  SCARD: (store, args) => { arity("SCARD", args, 1, 1); return Resp.integer(store.setCard(args[0])); },
  SMEMBERS: (store, args) => { arity("SMEMBERS", args, 1, 1); return Resp.array(store.setMembers(args[0]).map((m) => Resp.bulk(m))); },

  // ---- Sorted sets ----
  ZADD: (store, args) => {
    arity("ZADD", args, 3);
    if ((args.length - 1) % 2 !== 0) throw new Error("ERR syntax error");
    let added = 0;
    for (let i = 1; i < args.length; i += 2) if (store.zAdd(args[0], toFloat(args[i]), args[i + 1])) added++;
    return Resp.integer(added);
  },
  ZREM: (store, args) => { arity("ZREM", args, 2); return Resp.integer(store.zRem(args[0], args.slice(1))); },
  ZSCORE: (store, args) => {
    arity("ZSCORE", args, 2, 2);
    const s = store.zScore(args[0], args[1]);
    return Resp.bulk(s === null ? null : String(s));
  },
  ZRANK: (store, args) => {
    arity("ZRANK", args, 2, 2);
    const r = store.zRank(args[0], args[1]);
    return r === null ? Resp.bulk(null) : Resp.integer(r);
  },
  ZCARD: (store, args) => { arity("ZCARD", args, 1, 1); return Resp.integer(store.zCard(args[0])); },
  ZRANGE: (store, args) => {
    arity("ZRANGE", args, 3);
    const withScores = args[3]?.toUpperCase() === "WITHSCORES";
    const members = store.zRange(args[0], toInt(args[1]), toInt(args[2]));
    const out: RespValue[] = [];
    for (const m of members) {
      out.push(Resp.bulk(m.member));
      if (withScores) out.push(Resp.bulk(String(m.score)));
    }
    return Resp.array(out);
  },
  ZRANGEBYSCORE: (store, args) => {
    arity("ZRANGEBYSCORE", args, 3);
    const withScores = args[3]?.toUpperCase() === "WITHSCORES";
    const members = store.zRangeByScore(args[0], toFloat(args[1]), toFloat(args[2]));
    const out: RespValue[] = [];
    for (const m of members) {
      out.push(Resp.bulk(m.member));
      if (withScores) out.push(Resp.bulk(String(m.score)));
    }
    return Resp.array(out);
  },

  // ---- strata: cache dependency graph ----

  /** DEPEND <derived> <source...> - declare what a cached key is built from. */
  DEPEND: (store, args) => {
    arity("DEPEND", args, 2);
    const [derived, ...sources] = args;
    const { count, cycle } = store.declareDependency(derived, sources);
    // A cycle is allowed (cascade is cycle-safe) but almost always a mistake,
    // so the reply says so rather than failing silently.
    return Resp.simple(cycle ? `OK CYCLE ${count}` : `OK ${count}`);
  },

  /** UNDEPEND <key> - remove a key from the graph entirely. */
  UNDEPEND: (store, args) => {
    arity("UNDEPEND", args, 1, 1);
    store.deps.forget(args[0]);
    return Resp.simple("OK");
  },

  /** DEPS <key> - keys that will be invalidated when this one changes. */
  DEPS: (store, args) => {
    arity("DEPS", args, 1, 1);
    return Resp.array(store.deps.dependentsOf(args[0]).map((k) => Resp.bulk(k)));
  },

  /** DEPENDSON <key> - what this key was declared to be built from. */
  DEPENDSON: (store, args) => {
    arity("DEPENDSON", args, 1, 1);
    return Resp.array(store.deps.dependenciesOf(args[0]).map((k) => Resp.bulk(k)));
  },

  /** CASCADE <key> - preview the full invalidation set without deleting. */
  CASCADE: (store, args) => {
    arity("CASCADE", args, 1, 1);
    return Resp.array(store.deps.cascade(args[0]).map((k) => Resp.bulk(k)));
  },

  /** INVALIDATE <key> - delete a key and everything downstream of it. */
  INVALIDATE: (store, args) => {
    arity("INVALIDATE", args, 1, 1);
    return Resp.integer(store.invalidate(args[0]).length);
  },

  /** GRAPH - every declared edge, as "derived <- source" lines. */
  GRAPH: (store) =>
    Resp.array(store.deps.edges().map((e) => Resp.bulk(`${e.derived} <- ${e.source}`))),
};

export function dispatch(store: Store, name: string, args: string[]): RespValue {
  const handler = commandTable[name.toUpperCase()];
  if (!handler) return Resp.error(`ERR unknown command '${name}'`);
  try {
    store.stats.commandsProcessed++;
    return handler(store, args);
  } catch (err: any) {
    const msg = err?.message ?? "ERR internal error";
    // Errors already carrying a Redis-style code pass through unchanged.
    return Resp.error(/^[A-Z]+ /.test(msg) ? msg : `ERR ${msg}`);
  }
}
