/**
 * RESP = REdis Serialization Protocol. It's the wire format Redis clients
 * and servers use to talk to each other over TCP. It's deliberately simple
 * to parse, which is part of why Redis is fast.
 *
 * Every message is one of these types, identified by its first byte:
 *   +   Simple String   ->  "+OK\r\n"
 *   -   Error           ->  "-ERR message\r\n"
 *   :   Integer         ->  ":1000\r\n"
 *   $   Bulk String     ->  "$5\r\nhello\r\n"   ($-1\r\n means null)
 *   *   Array           ->  "*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n"
 *
 * A client request is ALWAYS sent as an Array of Bulk Strings, e.g. the
 * command `SET foo bar` is sent over the wire as:
 *   *3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
 */

export type RespValue =
  | { kind: "simple"; value: string }
  | { kind: "error"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "bulk"; value: string | null }
  | { kind: "array"; value: RespValue[] | null };

export const Resp = {
  simple: (v: string): RespValue => ({ kind: "simple", value: v }),
  error: (v: string): RespValue => ({ kind: "error", value: v }),
  integer: (v: number): RespValue => ({ kind: "integer", value: v }),
  bulk: (v: string | null): RespValue => ({ kind: "bulk", value: v }),
  array: (v: RespValue[] | null): RespValue => ({ kind: "array", value: v }),
};

/** Serializes a RespValue into the raw bytes to send on the wire. */
export function encode(value: RespValue): string {
  switch (value.kind) {
    case "simple":
      return `+${value.value}\r\n`;
    case "error":
      return `-${value.value}\r\n`;
    case "integer":
      return `:${value.value}\r\n`;
    case "bulk":
      if (value.value === null) return "$-1\r\n";
      return `$${Buffer.byteLength(value.value)}\r\n${value.value}\r\n`;
    case "array":
      if (value.value === null) return "*-1\r\n";
      return `*${value.value.length}\r\n` + value.value.map(encode).join("");
  }
}

/**
 * A streaming parser: as raw bytes arrive from the socket, feed them in with
 * push(). Whenever a complete command has arrived, it's yielded from
 * take(). We buffer partial data because TCP can split a single command
 * across multiple packets, or bundle multiple commands into one packet -
 * you can never assume "one read() = one command".
 */
export class RespParser {
  private buffer = "";

  push(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
  }

  /** Attempts to pull one fully-parsed command (array of strings) out of the buffer. */
  take(): string[] | null {
    if (this.buffer.length === 0) return null;
    const result = this.parseArray(0);
    if (!result) return null; // not enough data yet, wait for more
    this.buffer = this.buffer.slice(result.next);
    return result.value;
  }

  private parseArray(pos: number): { value: string[]; next: number } | null {
    if (this.buffer[pos] !== "*") return null;
    const lineEnd = this.buffer.indexOf("\r\n", pos);
    if (lineEnd === -1) return null;
    const count = parseInt(this.buffer.slice(pos + 1, lineEnd), 10);
    let cursor = lineEnd + 2;
    const items: string[] = [];
    for (let i = 0; i < count; i++) {
      const bulk = this.parseBulk(cursor);
      if (!bulk) return null;
      items.push(bulk.value);
      cursor = bulk.next;
    }
    return { value: items, next: cursor };
  }

  private parseBulk(pos: number): { value: string; next: number } | null {
    if (this.buffer[pos] !== "$") return null;
    const lineEnd = this.buffer.indexOf("\r\n", pos);
    if (lineEnd === -1) return null;
    const len = parseInt(this.buffer.slice(pos + 1, lineEnd), 10);
    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + len;
    if (this.buffer.length < dataEnd + 2) return null; // wait for the trailing \r\n too
    return { value: this.buffer.slice(dataStart, dataEnd), next: dataEnd + 2 };
  }
}
