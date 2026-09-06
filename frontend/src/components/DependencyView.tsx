import { KeyDeps } from "../api/client";

/**
 * The signature UI element: a key's place in the invalidation graph.
 *
 * Reads top to bottom as cause and effect. Sources sit above (what this key
 * is built from), the key itself in the middle, dependents below (what dies
 * when it changes). The cascade set is called out separately, because the
 * transitive blast radius is the thing people get wrong when reasoning about
 * cache invalidation by hand.
 *
 * No Redis GUI has this view, because Redis has no concept of a relationship
 * between keys.
 */
export function DependencyView({
  deps,
  onSelect,
}: {
  deps: KeyDeps;
  onSelect: (key: string) => void;
}) {
  const indirect = deps.cascade.filter((k) => !deps.dependents.includes(k));
  const isolated = deps.dependencies.length === 0 && deps.dependents.length === 0;

  if (isolated) {
    return (
      <div className="empty-state">
        This key has no declared relationships. Link it to its sources with{" "}
        <code className="inline-code">DEPEND {deps.key} &lt;source&gt;</code> and it
        will be invalidated automatically whenever they change.
      </div>
    );
  }

  return (
    <div className="dep-graph">
      <div className="dep-tier">
        <div className="dep-tier-label">Built from</div>
        <div className="dep-nodes">
          {deps.dependencies.length === 0 ? (
            <span className="dep-none">nothing declared</span>
          ) : (
            deps.dependencies.map((k) => (
              <button key={k} className="dep-node source" onClick={() => onSelect(k)}>
                {k}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="dep-arrow">↓ invalidates</div>

      <div className="dep-tier">
        <div className="dep-node self">{deps.key}</div>
      </div>

      <div className="dep-arrow">↓ invalidates</div>

      <div className="dep-tier">
        <div className="dep-tier-label">Invalidates directly</div>
        <div className="dep-nodes">
          {deps.dependents.length === 0 ? (
            <span className="dep-none">nothing depends on this</span>
          ) : (
            deps.dependents.map((k) => (
              <button key={k} className="dep-node dependent" onClick={() => onSelect(k)}>
                {k}
              </button>
            ))
          )}
        </div>
      </div>

      {indirect.length > 0 && (
        <div className="dep-tier">
          <div className="dep-tier-label">Also invalidated, transitively</div>
          <div className="dep-nodes">
            {indirect.map((k) => (
              <button key={k} className="dep-node indirect" onClick={() => onSelect(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
