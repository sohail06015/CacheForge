import { Entry, StoredValue, NovaType, ZSetMember } from "../types";
import { SkipList } from "./skiplist";
import { DependencyGraph } from "./depgraph";

/**
 * Store is the actual database. Everything else (RESP protocol, TCP server,
 * HTTP API, CLI) is just a way of talking to this class.
 *
 * Design notes:
 * - The keyspace is a Map<string, Entry>: O(1) average get/set/delete, the
 *   same complexity class as the hash table real Redis uses.
 * - Expiry is lazy + active, matching Redis:
 *     lazy   -> a key is checked on read and deleted if expired.
 *     active -> a background sweep samples keys and evicts expired ones, so
 *               keys nobody reads don't leak.
 * - Every mutation calls touch(), which cascades invalidation through the
 *   dependency graph. Doing it here rather than in each command handler
 *   means the feature can't be forgotten when a new command is added.
 * - Sorted sets use a SkipList for O(log n) insert/delete/rank.
 */
export class Store {
  private data = new Map<string, Entry>();

  /** Declared key relationships. Stores names only, so it costs almost nothing. */
  public deps = new DependencyGraph();

  /** Notified when cascade invalidation removes keys, so servers can log/persist. */
  public onInvalidate: ((source: string, removed: string[]) => void) | null = null;

  /** Suppresses invalidation side effects while replaying the AOF. */
  public replaying = false;

  public stats = {
    commandsProcessed: 0,
    startedAt: Date.now(),
    expiredKeys: 0,
    invalidatedKeys: 0,
  };

  private sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.activeExpireCycle(), 200);
    this.sweepTimer.unref();
  }

  /** Stops the background timer so tests and shutdown don't hang. */
  close() {
    clearInterval(this.sweepTimer);
  }

  // ---------- Expiry ----------

  private isExpired(entry: Entry): boolean {
    return entry.expireAt !== undefined && entry.expireAt <= Date.now();
  }

  private activeExpireCycle() {
    let checked = 0;
    for (const [key, entry] of this.data) {
      if (checked++ > 20) break; // sample, don't full-scan
      if (this.isExpired(entry)) {
        this.data.delete(key);
        this.stats.expiredKeys++;
        this.touch(key);
      }
    }
  }

  private expireIfNeeded(key: string): boolean {
    const entry = this.data.get(key);
    if (entry && this.isExpired(entry)) {
      this.data.delete(key);
      this.stats.expiredKeys++;
      this.touch(key);
      return true;
    }
    return false;
  }

  // ---------- Cache invalidation ----------

  /**
   * Called after every mutation. Any key declared as derived from `key` is
   * deleted, cascading transitively.
   *
   * Invalidation DELETES the derived key rather than trying to recompute it.
   * The engine has no idea how a cache was built - only the application
   * does. Deleting turns a correctness problem (stale data served silently)
   * into a cache miss the application already knows how to handle.
   */
  private touch(key: string) {
    if (this.replaying) return;
    const stale = this.deps.cascade(key);
    if (stale.length === 0) return;

    const removed: string[] = [];
    for (const victim of stale) {
      if (this.data.delete(victim)) removed.push(victim);
    }
    if (removed.length === 0) return;

    this.stats.invalidatedKeys += removed.length;
    this.onInvalidate?.(key, removed);
  }

  /** Declares that `derived` is built from `sources`. */
  declareDependency(derived: string, sources: string[]): { count: number; cycle: boolean } {
    const cycle = this.deps.wouldCycle(derived, sources);
    return { count: this.deps.depend(derived, sources), cycle };
  }

  /** Manually invalidates a key and everything downstream of it. */
  invalidate(key: string): string[] {
    const stale = this.deps.cascade(key);
    const removed: string[] = [];
    for (const victim of stale) if (this.data.delete(victim)) removed.push(victim);
    if (this.data.delete(key)) removed.unshift(key);
    this.stats.invalidatedKeys += removed.length;
    return removed;
  }

  // ---------- Generic ----------

  exists(key: string): boolean {
    this.expireIfNeeded(key);
    return this.data.has(key);
  }

  type(key: string): NovaType | null {
    this.expireIfNeeded(key);
    return this.data.get(key)?.value.type ?? null;
  }

  ttlMs(key: string): number | null {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expireAt === undefined) return -1;
    return Math.max(0, entry.expireAt - Date.now());
  }

  expire(key: string, seconds: number): boolean {
    if (!this.exists(key)) return false;
    this.data.get(key)!.expireAt = Date.now() + seconds * 1000;
    return true;
  }

  persist(key: string): boolean {
    const entry = this.data.get(key);
    if (!entry || entry.expireAt === undefined) return false;
    entry.expireAt = undefined;
    return true;
  }

  rename(src: string, dst: string): boolean {
    if (!this.exists(src)) return false;
    const entry = this.data.get(src)!;
    this.data.set(dst, entry);
    this.data.delete(src);
    this.touch(dst);
    this.touch(src);
    return true;
  }

  del(key: string): boolean {
    const had = this.exists(key);
    if (had) {
      this.data.delete(key);
      // Deleting a source invalidates its dependents, same as writing to it.
      this.touch(key);
    }
    return had;
  }

  keys(pattern?: string): string[] {
    const all = [...this.data.keys()].filter((k) => !this.expireIfNeeded(k));
    if (!pattern || pattern === "*") return all;
    const regex = globToRegex(pattern);
    return all.filter((k) => regex.test(k));
  }

  dbSize(): number {
    return this.keys().length;
  }

  flushAll() {
    for (const key of [...this.data.keys()]) {
      this.data.delete(key);
      this.touch(key);
    }
  }

  // ---------- Strings ----------

  getString(key: string): string | null {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    this.assertType(entry, "string", key);
    return entry.value.str!;
  }

  setString(key: string, value: string, opts: { expireSeconds?: number; keepTtl?: boolean } = {}) {
    const prev = this.data.get(key);
    const stored: StoredValue = { type: "string", str: value };
    const expireAt = opts.expireSeconds
      ? Date.now() + opts.expireSeconds * 1000
      : opts.keepTtl
      ? prev?.expireAt
      : undefined;
    this.data.set(key, { value: stored, expireAt });
    this.touch(key);
  }

  /** Shared by INCR/DECR/INCRBY. Throws if the value isn't an integer. */
  incrBy(key: string, delta: number): number {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    let current = 0;
    if (entry) {
      this.assertType(entry, "string", key);
      const parsed = Number(entry.value.str);
      if (!Number.isInteger(parsed)) {
        throw new Error("ERR value is not an integer or out of range");
      }
      current = parsed;
    }
    const next = current + delta;
    const stored: StoredValue = { type: "string", str: String(next) };
    this.data.set(key, { value: stored, expireAt: entry?.expireAt });
    this.touch(key);
    return next;
  }

  append(key: string, suffix: string): number {
    const current = this.getString(key) ?? "";
    const next = current + suffix;
    this.setString(key, next, { keepTtl: true });
    return next.length;
  }

  // ---------- Lists ----------

  private ensure(key: string, type: NovaType, init: () => StoredValue): Entry {
    let entry = this.data.get(key);
    if (!entry) {
      entry = { value: init() };
      this.data.set(key, entry);
    }
    this.assertType(entry, type, key);
    return entry;
  }

  pushList(key: string, values: string[], toFront: boolean): number {
    const entry = this.ensure(key, "list", () => ({ type: "list", list: [] }));
    if (toFront) entry.value.list!.unshift(...[...values].reverse());
    else entry.value.list!.push(...values);
    this.touch(key);
    return entry.value.list!.length;
  }

  popList(key: string, fromFront: boolean): string | null {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    this.assertType(entry, "list", key);
    const list = entry.value.list!;
    const popped = fromFront ? list.shift() : list.pop();
    if (popped === undefined) return null;
    // Redis deletes a collection key once it's empty; keeping an empty key
    // would make EXISTS disagree with LLEN.
    if (list.length === 0) this.data.delete(key);
    this.touch(key);
    return popped;
  }

  listLength(key: string): number {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return 0;
    this.assertType(entry, "list", key);
    return entry.value.list!.length;
  }

  rangeList(key: string, start: number, stop: number): string[] {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return [];
    this.assertType(entry, "list", key);
    return sliceRange(entry.value.list!, start, stop);
  }

  // ---------- Hashes ----------

  hashSet(key: string, field: string, value: string): boolean {
    const entry = this.ensure(key, "hash", () => ({ type: "hash", hash: new Map() }));
    const isNew = !entry.value.hash!.has(field);
    entry.value.hash!.set(field, value);
    this.touch(key);
    return isNew;
  }

  hashGet(key: string, field: string): string | null {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    this.assertType(entry, "hash", key);
    return entry.value.hash!.get(field) ?? null;
  }

  hashDel(key: string, fields: string[]): number {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return 0;
    this.assertType(entry, "hash", key);
    let removed = 0;
    for (const f of fields) if (entry.value.hash!.delete(f)) removed++;
    if (entry.value.hash!.size === 0) this.data.delete(key);
    if (removed) this.touch(key);
    return removed;
  }

  hashGetAll(key: string): Record<string, string> {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return {};
    this.assertType(entry, "hash", key);
    return Object.fromEntries(entry.value.hash!);
  }

  // ---------- Sets ----------

  setAdd(key: string, members: string[]): number {
    const entry = this.ensure(key, "set", () => ({ type: "set", set: new Set() }));
    let added = 0;
    for (const m of members) {
      if (!entry.value.set!.has(m)) { entry.value.set!.add(m); added++; }
    }
    if (added) this.touch(key);
    return added;
  }

  setRemove(key: string, members: string[]): number {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return 0;
    this.assertType(entry, "set", key);
    let removed = 0;
    for (const m of members) if (entry.value.set!.delete(m)) removed++;
    if (entry.value.set!.size === 0) this.data.delete(key);
    if (removed) this.touch(key);
    return removed;
  }

  setIsMember(key: string, member: string): boolean {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return false;
    this.assertType(entry, "set", key);
    return entry.value.set!.has(member);
  }

  setMembers(key: string): string[] {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return [];
    this.assertType(entry, "set", key);
    return [...entry.value.set!];
  }

  setCard(key: string): number {
    return this.setMembers(key).length;
  }

  // ---------- Sorted sets (SkipList-backed) ----------

  zAdd(key: string, score: number, member: string): boolean {
    if (!Number.isFinite(score)) throw new Error("ERR value is not a valid float");
    const entry = this.ensure(key, "zset", () => ({ type: "zset", zset: new SkipList() }));
    const isNew = entry.value.zset!.add(score, member);
    this.touch(key);
    return isNew;
  }

  zRem(key: string, members: string[]): number {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return 0;
    this.assertType(entry, "zset", key);
    let removed = 0;
    for (const m of members) if (entry.value.zset!.remove(m)) removed++;
    if (entry.value.zset!.size === 0) this.data.delete(key);
    if (removed) this.touch(key);
    return removed;
  }

  zScore(key: string, member: string): number | null {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    this.assertType(entry, "zset", key);
    return entry.value.zset!.getScore(member) ?? null;
  }

  zRank(key: string, member: string): number | null {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    this.assertType(entry, "zset", key);
    const r = entry.value.zset!.rank(member);
    return r === -1 ? null : r;
  }

  zCard(key: string): number {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return 0;
    this.assertType(entry, "zset", key);
    return entry.value.zset!.size;
  }

  zRange(key: string, start: number, stop: number): ZSetMember[] {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return [];
    this.assertType(entry, "zset", key);
    return entry.value.zset!.range(start, stop);
  }

  zRangeByScore(key: string, min: number, max: number): ZSetMember[] {
    this.expireIfNeeded(key);
    const entry = this.data.get(key);
    if (!entry) return [];
    this.assertType(entry, "zset", key);
    return entry.value.zset!.rangeByScore(min, max);
  }

  // ---------- Introspection ----------

  snapshotForDashboard() {
    return this.keys().map((key) => ({
      key,
      type: this.type(key),
      ttlMs: this.ttlMs(key),
      size: this.sizeOf(key),
      dependents: this.deps.dependentsOf(key).length,
      dependencies: this.deps.dependenciesOf(key).length,
    }));
  }

  private sizeOf(key: string): number {
    const v = this.data.get(key)?.value;
    if (!v) return 0;
    switch (v.type) {
      case "string": return v.str?.length ?? 0;
      case "list": return v.list?.length ?? 0;
      case "hash": return v.hash?.size ?? 0;
      case "set": return v.set?.size ?? 0;
      case "zset": return v.zset?.size ?? 0;
    }
  }

  /** Full value of a key, JSON-safe, for the dashboard's detail view. */
  inspect(key: string): unknown {
    this.expireIfNeeded(key);
    const v = this.data.get(key)?.value;
    if (!v) return null;
    return plainValue(v);
  }

  /**
   * The minimal command set that rebuilds current state - used for AOF
   * compaction. This is why compaction is safe: we regenerate from live
   * state rather than trying to prune the old log.
   */
  rebuildCommands(): string[][] {
    const out: string[][] = [];
    for (const key of this.keys()) {
      const entry = this.data.get(key)!;
      const v = entry.value;
      switch (v.type) {
        case "string": out.push(["SET", key, v.str!]); break;
        case "list": if (v.list!.length) out.push(["RPUSH", key, ...v.list!]); break;
        case "hash": for (const [f, val] of v.hash!) out.push(["HSET", key, f, val]); break;
        case "set": if (v.set!.size) out.push(["SADD", key, ...v.set!]); break;
        case "zset": for (const m of v.zset!.toArray()) out.push(["ZADD", key, String(m.score), m.member]); break;
      }
      if (entry.expireAt !== undefined) {
        const secs = Math.ceil((entry.expireAt - Date.now()) / 1000);
        if (secs > 0) out.push(["EXPIRE", key, String(secs)]);
      }
    }
    // Dependency declarations are state too - without these the graph would
    // be empty after a restart and invalidation would silently stop working.
    for (const { derived, sources } of this.deps.all()) {
      out.push(["DEPEND", derived, ...sources]);
    }
    return out;
  }

  private assertType(entry: Entry, expected: NovaType, key: string) {
    if (entry.value.type !== expected) {
      throw new Error(
        `WRONGTYPE Operation against a key holding the wrong kind of value (key "${key}" is ${entry.value.type}, expected ${expected})`
      );
    }
  }
}

/** Shared negative-index slice semantics for LRANGE and ZRANGE. */
function sliceRange<T>(arr: T[], start: number, stop: number): T[] {
  const len = arr.length;
  const s = start < 0 ? Math.max(len + start, 0) : start;
  const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
  if (s > e || s >= len) return [];
  return arr.slice(s, e + 1);
}

function cloneValue(value: StoredValue): StoredValue {
  return {
    type: value.type,
    str: value.str,
    list: value.list ? [...value.list] : undefined,
    hash: value.hash ? new Map(value.hash) : undefined,
    set: value.set ? new Set(value.set) : undefined,
    zset: value.zset ? SkipList.fromArray(value.zset.toArray()) : undefined,
  };
}

/** Converts a StoredValue into something JSON.stringify can handle. */
export function plainValue(v: StoredValue): unknown {
  switch (v.type) {
    case "string": return v.str;
    case "list": return v.list;
    case "hash": return Object.fromEntries(v.hash!);
    case "set": return [...v.set!];
    case "zset": return v.zset!.toArray();
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
