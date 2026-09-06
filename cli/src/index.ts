import * as net from "net";
import * as readline from "readline";

/**
 * This is a from-scratch implementation of what redis-cli does: open a TCP
 * socket to the server, encode whatever the user types as a RESP array of
 * bulk strings, send it, and decode+pretty-print whatever comes back.
 * It reuses none of the server's parser on purpose - a real client and a
 * real server are separate programs that only agree on the wire format,
 * which is the whole point of a protocol.
 */

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 6380);

const socket = net.connect(port, host, () => {
  console.log(`Connected to strata at ${host}:${port}. Type HELP for a command list, or exit to quit.`);
  promptNext();
});

function encodeCommand(parts: string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const p of parts) out += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
  return out;
}

// A tiny RESP reply decoder, just enough for a CLI (doesn't need to handle
// pipelining like the server's parser does, since we send one command and
// wait for one reply at a time - exactly like real redis-cli in interactive mode).
function decodeReply(buffer: string): { text: string; rest: string } {
  const type = buffer[0];
  const lineEnd = buffer.indexOf("\r\n");
  const line = buffer.slice(1, lineEnd);

  if (type === "+") return { text: line, rest: buffer.slice(lineEnd + 2) };
  if (type === "-") return { text: `(error) ${line}`, rest: buffer.slice(lineEnd + 2) };
  if (type === ":") return { text: `(integer) ${line}`, rest: buffer.slice(lineEnd + 2) };
  if (type === "$") {
    const len = parseInt(line, 10);
    if (len === -1) return { text: "(nil)", rest: buffer.slice(lineEnd + 2) };
    const start = lineEnd + 2;
    const value = buffer.slice(start, start + len);
    return { text: `"${value}"`, rest: buffer.slice(start + len + 2) };
  }
  if (type === "*") {
    const count = parseInt(line, 10);
    if (count === -1) return { text: "(nil)", rest: buffer.slice(lineEnd + 2) };
    let rest = buffer.slice(lineEnd + 2);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = decodeReply(rest);
      lines.push(`${i + 1}) ${item.text}`);
      rest = item.rest;
    }
    return { text: lines.length ? lines.join("\n") : "(empty array)", rest };
  }
  return { text: "(unknown reply)", rest: "" };
}

/**
 * Splits a command line into tokens, respecting quotes and backslash
 * escapes. This matters more than it looks: `SET msg "hello world"` must
 * become 3 tokens, not 4. A naive split(/\s+/) silently truncates the
 * value to "hello" and drops the rest - the kind of bug you only notice
 * once real data has been mangled.
 */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasToken = false;

  for (const ch of line.trim()) {
    if (escaped) { current += ch; escaped = false; hasToken = true; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { out.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) out.push(current);
  return out;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;

rl.on("close", () => {
  closed = true;
  // Give any in-flight reply a moment to arrive and print before we exit -
  // relevant when input is piped in (e.g. scripting/tests) rather than typed.
  setTimeout(() => {
    socket.destroy();
    process.exit(0);
  }, 200);
});

function promptNext() {
  if (closed) return;
  rl.question(`strata ${host}:${port}> `, (line) => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
      socket.end();
      rl.close();
      process.exit(0);
    }
    if (trimmed.toLowerCase() === "help") {
      console.log(
        "Strings:     SET GET MGET MSET SETEX INCR DECR INCRBY DECRBY APPEND STRLEN\n" +
        "Generic:     DEL EXISTS TYPE KEYS RENAME EXPIRE PERSIST TTL DBSIZE FLUSHALL INFO\n" +
        "Lists:       LPUSH RPUSH LPOP RPOP LLEN LRANGE\n" +
        "Hashes:      HSET HGET HDEL HEXISTS HKEYS HVALS HLEN HGETALL\n" +
        "Sets:        SADD SREM SISMEMBER SCARD SMEMBERS\n" +
        "Sorted sets: ZADD ZREM ZSCORE ZRANK ZCARD ZRANGE ZRANGEBYSCORE\n" +
        "Pub/Sub:     SUBSCRIBE PSUBSCRIBE UNSUBSCRIBE PUBLISH PUBSUB CHANNELS\n" +
        "Dep graph:   DEPEND <derived> <source...>   DEPS <key>   DEPENDSON <key>\n" +
        "             CASCADE <key>   INVALIDATE <key>   UNDEPEND <key>   GRAPH\n\n" +
        "Values with spaces need quotes:  SET msg \"hello world\""
      );
      return promptNext();
    }
    if (!trimmed) return promptNext();

    const parts = parseCommandLine(trimmed);
    if (!parts.length) return promptNext();
    socket.write(encodeCommand(parts));
  });
}

/**
 * In subscribe mode the server pushes messages that we never asked for, so
 * we must NOT re-prompt after each one - doing so would print a fresh
 * prompt every time a message arrived. This is the one place where the
 * request/response assumption behind a REPL breaks down.
 */
let subscribeMode = false;

socket.on("data", (chunk) => {
  let buffer = chunk.toString("utf8");

  // A packet can carry several replies (or several pushed messages), so
  // decode until the buffer is drained rather than assuming one per read.
  while (buffer.length > 0) {
    const { text, rest } = decodeReply(buffer);
    if (text === "(unknown reply)") break;
    console.log(text);
    if (/^\d+\) "(p?message)"/m.test(text) === false && /"(subscribe|psubscribe)"/.test(text)) {
      subscribeMode = true;
    }
    if (/"unsubscribe"/.test(text) && /\d+\) \(integer\) 0/.test(text)) {
      subscribeMode = false;
    }
    if (rest === buffer) break; // no progress - avoid an infinite loop
    buffer = rest;
  }

  if (!closed && !subscribeMode) promptNext();
});

socket.on("error", (err) => {
  console.error(`Connection error: ${err.message}`);
  process.exit(1);
});
