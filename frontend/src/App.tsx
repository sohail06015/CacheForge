import { useCallback, useEffect, useState } from "react";
import { fetchKeys, KeySummary } from "./api/client";
import { useLiveStats } from "./hooks/useLiveStats";
import { Sidebar } from "./components/Sidebar";
import { KeyDetail } from "./components/KeyDetail";
import { CommandConsole } from "./components/CommandConsole";

/**
 * Dashboard shell.
 *
 * Two transports on purpose: stats arrive over WebSocket because they change
 * every tick, while the key list is polled every 2s because it changes
 * rarely. Not every piece of state needs the same delivery mechanism.
 */
export default function App() {
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<"detail" | "console">("detail");
  const [connected, setConnected] = useState(true);
  const stats = useLiveStats();

  const loadKeys = useCallback(() => {
    fetchKeys()
      .then((k) => { setKeys(k); setConnected(true); })
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => {
    loadKeys();
    const timer = setInterval(loadKeys, 2000);
    return () => clearInterval(timer);
  }, [loadKeys]);

  const selectedSummary = keys.find((k) => k.key === selectedKey) ?? null;

  return (
    <div className="app">
      <Sidebar
        keys={keys}
        stats={stats}
        connected={connected}
        selectedKey={selectedKey}
        onSelect={(k) => { setSelectedKey(k); setTab("detail"); }}
      />
      <main className="main">
        <div className="tabs">
          <button
            className={`tab ${tab === "detail" ? "active" : ""}`}
            onClick={() => setTab("detail")}
          >
            Key detail
          </button>
          <button
            className={`tab ${tab === "console" ? "active" : ""}`}
            onClick={() => setTab("console")}
          >
            Console
          </button>
        </div>

        {tab === "console" ? (
          <CommandConsole onMutate={loadKeys} />
        ) : selectedSummary ? (
          <KeyDetail summary={selectedSummary} onChange={loadKeys} onSelect={setSelectedKey} />
        ) : (
          <div className="empty-state">
            <p style={{ marginTop: 0 }}>
              Select a key to inspect its value and see what it invalidates.
            </p>
            <p>
              No keys yet? Open the Console tab and run:
            </p>
            <div className="value-box">
              SET user:1 alice{"\n"}SET cache:profile:1 html{"\n"}DEPEND cache:profile:1 user:1
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
