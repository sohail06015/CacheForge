/**
 * The dependency graph: strata's answer to cache invalidation.
 *
 * THE PROBLEM
 * In Redis, derived data has no link to what it was derived from. If you
 * cache `cache:profile:1` built from `user:1` and `user:1:settings`, nothing
 * in Redis knows those keys are related. When the user changes, your
 * application code must remember to delete every derived key. Miss one and
 * you serve stale data - silently, sometimes for days. This is the single
 * most common Redis bug in production systems.
 *
 * THE FIX
 * Declare the relationship once:
 *     DEPEND cache:profile:1 user:1 user:1:settings
 * From then on, any write to `user:1` automatically invalidates
 * `cache:profile:1`. Cascading, so anything derived from THAT goes too.
 *
 * WHY IT'S CHEAP
 * The graph stores key NAMES, not values - two adjacency maps of short
 * strings. Thousands of relationships cost a few hundred KB. Contrast with
 * value snapshots, which scale with the size of the data itself.
 *
 * Two edges are stored for every relationship, because both directions get
 * asked about: "who must I invalidate?" (forward, on every write) and "what
 * do I depend on?" (reverse, for introspection and cleanup).
 */
export class DependencyGraph {
  /** source -> keys that must die when source changes. */
  private dependents = new Map<string, Set<string>>();
  /** derived -> keys it was built from. */
  private dependencies = new Map<string, Set<string>>();

  /** Declares that `derived` is built from `sources`. Replaces any prior declaration. */
  depend(derived: string, sources: string[]): number {
    // Re-declaring must clear old edges, or a cache rebuilt from different
    // sources would keep stale links and get invalidated by keys it no
    // longer reads.
    this.clearDependencies(derived);

    const deps = new Set(sources);
    // A key depending on itself would make every write invalidate its own
    // result - harmless but pointless, so drop it.
    deps.delete(derived);
    if (deps.size === 0) return 0;

    this.dependencies.set(derived, deps);
    for (const source of deps) {
      const set = this.dependents.get(source) ?? new Set();
      set.add(derived);
      this.dependents.set(source, set);
    }
    return deps.size;
  }

  /** Direct dependents only - keys built from this one. */
  dependentsOf(key: string): string[] {
    return [...(this.dependents.get(key) ?? [])];
  }

  /** Direct dependencies only - what this key was built from. */
  dependenciesOf(key: string): string[] {
    return [...(this.dependencies.get(key) ?? [])];
  }

  /**
   * Everything downstream of `key`, transitively. Breadth-first with a
   * visited set, so a dependency cycle (a -> b -> a, which users WILL
   * create by accident) terminates instead of looping forever.
   *
   * The root key itself is never included: writing to `user:1` invalidates
   * its caches, not `user:1`.
   */
  cascade(key: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([key]);
    const queue = [...this.dependentsOf(key)];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      queue.push(...this.dependentsOf(current));
    }
    return out;
  }

  /** True if adding this edge would create a cycle. Used to warn on DEPEND. */
  wouldCycle(derived: string, sources: string[]): boolean {
    // A cycle forms if `derived` is already upstream of any source - i.e. if
    // invalidating `derived` would eventually invalidate that source.
    const downstream = new Set(this.cascade(derived));
    return sources.some((s) => downstream.has(s) || s === derived);
  }

  /** Removes a key's outgoing edges (what it depends on). */
  private clearDependencies(derived: string) {
    for (const source of this.dependencies.get(derived) ?? []) {
      const set = this.dependents.get(source);
      set?.delete(derived);
      if (set && set.size === 0) this.dependents.delete(source);
    }
    this.dependencies.delete(derived);
  }

  /**
   * Fully detaches a key from the graph, both directions.
   *
   * Note this is NOT called when a key is invalidated - a cache that gets
   * invalidated will be rebuilt, and it should keep its declared sources so
   * it stays wired up. It's only for permanently forgetting a relationship.
   */
  forget(key: string) {
    this.clearDependencies(key);
    for (const derived of this.dependents.get(key) ?? []) {
      const set = this.dependencies.get(derived);
      set?.delete(key);
      if (set && set.size === 0) this.dependencies.delete(derived);
    }
    this.dependents.delete(key);
  }

  /** Every declared edge, for the dashboard's graph view. */
  edges(): { derived: string; source: string }[] {
    const out: { derived: string; source: string }[] = [];
    for (const [derived, sources] of this.dependencies) {
      for (const source of sources) out.push({ derived, source });
    }
    return out;
  }

  /** Replays declarations for AOF persistence. */
  all(): { derived: string; sources: string[] }[] {
    return [...this.dependencies].map(([derived, sources]) => ({
      derived,
      sources: [...sources],
    }));
  }

  get size(): number {
    return this.dependencies.size;
  }
}
