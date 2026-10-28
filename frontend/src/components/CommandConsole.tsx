import { useState, useRef, useEffect } from "react";
import { runCommand } from "../api/client";

interface Line {
  kind: "input" | "output" | "error";
  text: string;
}

/**
 * An in-browser REPL. It posts the raw command line to /api/command, where
 * the server parses and dispatches it through the same code path the TCP
 * server uses - so the console can't drift out of sync with the real engine.
 *
 * Command history via arrow keys, because a console without it is painful
 * the moment you make a typo.
 */
export function CommandConsole({ onMutate }: { onMutate: () => void }) {
  const [lines, setLines] = useState<Line[]>([
    { kind: "output", text: "CacheForge console. Try: SET greeting \"hello world\"" },
  ]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  async function submit() {
    const command = input.trim();
    if (!command) return;

    setLines((l) => [...l, { kind: "input", text: command }]);
    setHistory((h) => [command, ...h]);
    setHistoryIdx(-1);
    setInput("");

    try {
      const res = await runCommand(command);
      setLines((l) => [
        ...l,
        { kind: res.ok ? "output" : "error", text: format(res.reply) },
      ]);
      // Writes change the keyspace, so let the parent refresh its view.
      if (res.ok && res.isWrite) onMutate();
    } catch {
      setLines((l) => [...l, { kind: "error", text: "Could not reach the server." }]);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { submit(); return; }
    // Arrow keys walk back through previous commands, like a real shell.
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, history.length - 1);
      if (next >= 0) { setHistoryIdx(next); setInput(history[next]); }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = historyIdx - 1;
      setHistoryIdx(next);
      setInput(next >= 0 ? history[next] : "");
    }
  }

  return (
    <div className="console">
      <div className="console-output" ref={scrollRef}>
        {lines.map((l, i) => (
          <div key={i} className={`console-line ${l.kind}`}>
            {l.kind === "input" ? `> ${l.text}` : l.text}
          </div>
        ))}
      </div>
      <div className="console-input-row">
        <span className="console-prompt">&gt;</span>
        <input
          className="console-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command and press Enter"
          spellCheck={false}
          aria-label="Command input"
        />
      </div>
    </div>
  );
}

/** Renders a RESP reply the way redis-cli does. */
function format(reply: unknown): string {
  if (reply === null) return "(nil)";
  if (Array.isArray(reply)) {
    if (reply.length === 0) return "(empty array)";
    return reply.map((r, i) => `${i + 1}) ${format(r)}`).join("\n");
  }
  if (typeof reply === "number") return `(integer) ${reply}`;
  return String(reply);
}
