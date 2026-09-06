import { useEffect, useState } from "react";
import {
  fetchDeps, fetchValue, invalidateKey, deleteKey, KeyDeps, KeySummary,
} from "../api/client";
import { DependencyView } from "./DependencyView";

/** A string's "size" is its character count, not an element count. */
function describeSize(type: string | null, size: number): string {
  const unit =
    type === "string" ? "character"
    : type === "hash" ? "field"
    : type === "list" ? "item"
    : "member";
  return `${size} ${unit}${size === 1 ? "" : "s"}`;
}

function formatTtl(ttlMs: number | null): string {
  if (ttlMs === null) return "unknown";
  if (ttlMs === -1) return "no expiry";
  return `expires in ${Math.ceil(ttlMs / 1000)}s`;
}

export function KeyDetail({
  summary,
  onChange,
  onSelect,
}: {
  summary: KeySummary;
  onChange: () => void;
  onSelect: (key: string) => void;
}) {
  const [deps, setDeps] = useState<KeyDeps | null>(null);
  const [value, setValue] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const [d, v] = await Promise.all([fetchDeps(summary.key), fetchValue(summary.key)]);
    setDeps(d);
    setValue(v);
  }

  useEffect(() => { setNote(null); load(); }, [summary.key]);

  async function handleInvalidate() {
    setBusy(true);
    const removed = await invalidateKey(summary.key);
    setNote(
      removed.length
        ? `Invalidated ${removed.length} key${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`
        : "Nothing to invalidate."
    );
    onChange();
    setBusy(false);
  }

  async function handleDelete() {
    setBusy(true);
    await deleteKey(summary.key);
    onChange();
    setBusy(false);
  }

  return (
    <div>
      <div className="detail-header">
        <span className="detail-key">{summary.key}</span>
        <span className="type-badge">{summary.type}</span>
        <div className="header-actions">
          <button className="action-btn" onClick={handleInvalidate} disabled={busy}>
            Invalidate cascade
          </button>
          <button className="danger-btn" onClick={handleDelete} disabled={busy}>
            Delete key
          </button>
        </div>
      </div>
      <div className="detail-meta">
        {formatTtl(summary.ttlMs)} · {describeSize(summary.type, summary.size)}
      </div>

      {note && <div className="note-banner">{note}</div>}

      <div className="section-title">Current value</div>
      <div className="value-box">{JSON.stringify(value, null, 2)}</div>

      <div className="section-title" style={{ marginTop: 28 }}>
        Dependency graph
      </div>
      {deps && <DependencyView deps={deps} onSelect={onSelect} />}
    </div>
  );
}
