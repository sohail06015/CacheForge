import * as fs from "fs";
import * as path from "path";

/**
 * AOF = Append-Only File, the same durability mechanism real Redis offers.
 * Every WRITE command is appended to a log file as it happens. On startup,
 * we replay the log from the top, re-running every command against a fresh
 * Store, which rebuilds the exact same state.
 *
 * Two important details:
 *
 * 1. Commands are stored RESP-encoded, not space-separated. The naive
 *    "join with spaces" format silently corrupts any value containing a
 *    space - SET msg "hello world" would replay as SET msg hello, losing
 *    data. RESP is length-prefixed, so values can contain anything.
 *
 * 2. rewrite() compacts the log. Without it the file grows forever: a key
 *    written a million times keeps a million entries even though only the
 *    final one matters. Compaction replaces the log with the minimum set of
 *    commands needed to rebuild current state. Redis does the same thing
 *    (BGREWRITEAOF), just in a background process.
 */
export class AofLog {
  private stream: fs.WriteStream;
  private filePath: string;
  private dir: string;
  /** Commands appended since the last rewrite - used to decide when to compact. */
  private opsSinceRewrite = 0;

  constructor(dir = "./data") {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "cacheforge.aof");
    const legacyPath = path.join(dir, "strata.aof");
    if (!fs.existsSync(this.filePath) && fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, this.filePath);
    }
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  /** Encodes a command as a RESP array of bulk strings - safe for any byte content. */
  private encode(parts: string[]): string {
    return `*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("");
  }

  append(command: string, args: string[]) {
    this.stream.write(this.encode([command, ...args]));
    this.opsSinceRewrite++;
  }

  /** True once enough writes have accumulated to make compaction worthwhile. */
  shouldRewrite(): boolean {
    return this.opsSinceRewrite >= 1000;
  }

  /**
   * Replaces the log with `commands` - the minimal set that rebuilds current
   * state. Writes to a temp file and renames, because rename is atomic on
   * POSIX: a crash mid-rewrite leaves the old log intact rather than a
   * half-written one. Truncating in place would risk losing everything.
   */
  rewrite(commands: string[][]) {
    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, commands.map((c) => this.encode(c)).join(""));
    this.stream.end();
    fs.renameSync(tmpPath, this.filePath);
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    this.opsSinceRewrite = 0;
  }

  /** Reads every logged command back, in order, for replay on startup. */
  replay(): { command: string; args: string[] }[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, "utf8");
    const out: { command: string; args: string[] }[] = [];
    let pos = 0;

    while (pos < raw.length) {
      if (raw[pos] !== "*") break;
      const lineEnd = raw.indexOf("\r\n", pos);
      if (lineEnd === -1) break;
      const count = parseInt(raw.slice(pos + 1, lineEnd), 10);
      let cursor = lineEnd + 2;
      const parts: string[] = [];
      let ok = true;

      for (let i = 0; i < count; i++) {
        if (raw[cursor] !== "$") { ok = false; break; }
        const lenEnd = raw.indexOf("\r\n", cursor);
        if (lenEnd === -1) { ok = false; break; }
        const len = parseInt(raw.slice(cursor + 1, lenEnd), 10);
        const dataStart = lenEnd + 2;
        // A torn write at the tail (crash mid-append) - stop cleanly and keep
        // everything before it, rather than throwing away the whole log.
        if (dataStart + len > raw.length) { ok = false; break; }
        parts.push(raw.slice(dataStart, dataStart + len));
        cursor = dataStart + len + 2;
      }

      if (!ok || parts.length === 0) break;
      const [command, ...args] = parts;
      out.push({ command, args });
      pos = cursor;
    }

    return out;
  }
}
