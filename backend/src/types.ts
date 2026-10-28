// Every value CacheForge can store is tagged with a type, exactly like real Redis does.
// This lets us reject wrong-type operations (e.g. LPUSH on a string) with a clear error,
// and lets the dashboard show a "type" badge next to every key.
export type NovaType = "string" | "list" | "hash" | "set" | "zset";

export interface ZSetMember {
  member: string;
  score: number;
}

// The actual value stored for a key. Only one of these fields is populated,
// matching the `type` field above.
export interface StoredValue {
  type: NovaType;
  str?: string;
  list?: string[];
  hash?: Map<string, string>;
  set?: Set<string>;
  // Sorted sets are backed by a SkipList (O(log n) insert/delete/rank),
  // the same structure real Redis uses. Snapshots and persistence convert
  // it to a plain ZSetMember[] since a SkipList isn't JSON-serializable.
  zset?: import("./core/skiplist").SkipList;
}

// One entry in the keyspace: the value itself + optional expiry (ms since epoch).
export interface Entry {
  value: StoredValue;
  expireAt?: number; // undefined = no TTL
}


// A parsed client command: the command name plus its raw string arguments.
export interface ParsedCommand {
  name: string;
  args: string[];
}
