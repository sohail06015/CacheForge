import { useEffect, useRef, useState } from "react";
import { fetchStats, EngineStats, API_BASE } from "../api/client";

/**
 * Combines an initial REST fetch (so the numbers aren't blank on load) with
 * a WebSocket subscription for real-time ticks. This is the same pattern
 * most production dashboards use: REST for "give me the current state",
 * WebSocket for "tell me when it changes".
 */
export function useLiveStats() {
  const [stats, setStats] = useState<EngineStats | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetchStats().then(setStats).catch(() => {});

    // In dev, connect to our own host and let the Vite proxy forward it.
    // In production, derive the socket URL from the configured API base -
    // http becomes ws, https becomes wss.
    const wsUrl = API_BASE
      ? API_BASE.replace(/^http/, "ws")
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "stats") {
        setStats((prev) =>
          prev
            ? { ...prev, commandsProcessed: msg.commandsProcessed, keyCount: msg.keyCount }
            : prev
        );
      }
    };

    return () => ws.close();
  }, []);

  return stats;
}
