import { useState } from "react";
import { KeySummary, EngineStats } from "../api/client";

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function Sidebar({
  keys,
  stats,
  connected,
  selectedKey,
  onSelect,
}: {
  keys: KeySummary[];
  stats: EngineStats | null;
  connected: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const visible = filter
    ? keys.filter((k) => k.key.toLowerCase().includes(filter.toLowerCase()))
    : keys;

  return (
    <div className="sidebar">
      <div className="brand">
        <div className="brand-title">cacheforge://</div>
        <div className="brand-sub">
          <span className={`pulse-dot ${connected ? "" : "offline"}`} />
          {!connected
            ? "engine offline"
            : stats
            ? `connected · ${formatUptime(stats.uptimeMs)} up`
            : "connecting..."}
        </div>
      </div>

      <div className="stats-block">
        <div className="stat">
          <div className="stat-label">Keys</div>
          <div className="stat-value">{stats?.keyCount ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Commands</div>
          <div className="stat-value">{stats?.commandsProcessed ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expired</div>
          <div className="stat-value">{stats?.expiredKeys ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Invalidated</div>
          <div className="stat-value">{stats?.invalidatedKeys ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Links</div>
          <div className="stat-value">{stats?.dependencyCount ?? "—"}</div>
        </div>
      </div>

      <input
        className="key-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter keys"
        spellCheck={false}
        aria-label="Filter keys"
      />

      <div className="key-list">
        {visible.length === 0 && (
          <div className="empty-state" style={{ padding: 12 }}>
            {keys.length === 0
              ? "No keys yet. Use the Console tab to write one."
              : "No keys match that filter."}
          </div>
        )}
        {visible.map((k) => (
          <button
            key={k.key}
            className={`key-item ${selectedKey === k.key ? "active" : ""}`}
            onClick={() => onSelect(k.key)}
          >
            <span className="key-name">{k.key}</span>
            <span className="key-meta">
              {/* A dependent count is the signal that writing this key has
                  side effects - the thing you most want to notice. */}
              {k.dependents > 0 && (
                <span className="version-count" title={`${k.dependents} key(s) invalidated by this`}>
                  ⚡{k.dependents}
                </span>
              )}
              <span className="type-badge">{k.type}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
