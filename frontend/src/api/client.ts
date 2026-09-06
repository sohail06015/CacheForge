// Thin wrapper around the backend's HTTP API. Kept separate from components
// so the "how do I talk to the server" concern is in exactly one place.

/**
 * Where the engine lives.
 *
 * In development this is empty, so requests go to relative paths like
 * "/api/keys" and Vite's dev proxy forwards them to localhost:8080.
 *
 * In production there is no proxy, so the deployed frontend has to name the
 * backend explicitly. Set VITE_API_BASE at build time, e.g.
 *     VITE_API_BASE=https://strata.onrender.com
 *
 * Trailing slashes are stripped so "https://x.com/" and "https://x.com"
 * both produce the same URLs.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

const api = (path: string) => `${API_BASE}${path}`;

export interface KeySummary {
  key: string;
  type: string | null;
  ttlMs: number | null;
  size: number;
  dependents: number;
  dependencies: number;
}

export interface CommandResult {
  ok: boolean;
  command: string;
  isWrite: boolean;
  reply: unknown;
}

export interface KeyDeps {
  key: string;
  /** Keys that die when this one changes. */
  dependents: string[];
  /** Keys this one was declared to be built from. */
  dependencies: string[];
  /** Full transitive invalidation set. */
  cascade: string[];
}

export interface EngineStats {
  commandsProcessed: number;
  startedAt: number;
  uptimeMs: number;
  keyCount: number;
  expiredKeys: number;
  channelCount: number;
  invalidatedKeys: number;
  dependencyCount: number;
}

export async function fetchKeys(): Promise<KeySummary[]> {
  const res = await fetch(api("/api/keys"));
  return res.json();
}



/** Runs a raw command line through the same dispatcher the TCP server uses. */
export async function runCommand(command: string): Promise<CommandResult> {
  const res = await fetch(api("/api/command"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  return res.json();
}

export async function fetchDeps(key: string): Promise<KeyDeps> {
  const res = await fetch(api(`/api/keys/${encodeURIComponent(key)}/deps`));
  return res.json();
}

export async function invalidateKey(key: string): Promise<string[]> {
  const res = await fetch(api(`/api/keys/${encodeURIComponent(key)}/invalidate`), { method: "POST" });
  return (await res.json()).removed ?? [];
}

export async function declareDependency(key: string, sources: string[]) {
  const res = await fetch(api(`/api/keys/${encodeURIComponent(key)}/depend`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources }),
  });
  return res.json();
}

export async function fetchGraph(): Promise<{ derived: string; source: string }[]> {
  const res = await fetch(api("/api/graph"));
  return res.json();
}

export async function deleteKey(key: string): Promise<boolean> {
  const res = await fetch(api(`/api/keys/${encodeURIComponent(key)}`), { method: "DELETE" });
  return (await res.json()).deleted;
}

export async function fetchValue(key: string): Promise<unknown> {
  const res = await fetch(api(`/api/keys/${encodeURIComponent(key)}`));
  if (!res.ok) return null;
  return (await res.json()).value;
}

export async function fetchStats(): Promise<EngineStats> {
  const res = await fetch(api("/api/stats"));
  return res.json();
}
