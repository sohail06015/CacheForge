/**
 * Seeds strata with sample data across all five types so you have something
 * to look at in the dashboard immediately.
 *
 * Usage:  node scripts/seed.js        (make sure the backend is running first)
 *
 * This deliberately uses zero dependencies and speaks raw RESP over a plain
 * TCP socket - it doubles as the smallest possible example of how to write
 * a strata client in any language.
 */
const net = require("net");

const HOST = process.argv[2] || "127.0.0.1";
const PORT = Number(process.argv[3] || 6380);

/** Encodes a command as a RESP array of bulk strings. */
function cmd(...args) {
  return (
    `*${args.length}\r\n` +
    args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")
  );
}

const socket = net.connect(PORT, HOST, () => {
  // A small cache hierarchy, so the dependency graph has something to show:
  //   user:1  ->  cache:profile:1  ->  cache:feed:1
  // Writing user:1 wipes both caches, transitively.
  socket.write(cmd("SET", "user:1", "alice"));
  socket.write(cmd("SET", "user:1:settings", "dark-mode"));
  socket.write(cmd("SET", "cache:profile:1", "<rendered profile>"));
  socket.write(cmd("SET", "cache:feed:1", "<rendered feed>"));
  socket.write(cmd("DEPEND", "cache:profile:1", "user:1", "user:1:settings"));
  socket.write(cmd("DEPEND", "cache:feed:1", "cache:profile:1"));

  // A string with a TTL, so you can watch the countdown in the dashboard.
  socket.write(cmd("SET", "session:abc", "tok123", "EX", "300"));

  // One of each remaining type.
  socket.write(cmd("RPUSH", "queue:jobs", "render", "email", "backup"));
  socket.write(cmd("HSET", "cfg", "mode", "prod"));
  socket.write(cmd("HSET", "cfg", "region", "ap-south-1"));
  socket.write(cmd("SADD", "tags", "db", "fast", "in-memory"));
  socket.write(cmd("ZADD", "board", "100", "alice"));
  socket.write(cmd("ZADD", "board", "250", "bob"));

  setTimeout(() => {
    console.log("Seeded strata with sample data.");
    console.log("Click 'user:1' in the dashboard to see what it invalidates.");
    console.log("Then run:  SET user:1 bob   - both caches vanish automatically.");
    socket.end();
    process.exit(0);
  }, 400);
});

socket.on("error", (err) => {
  console.error(`Could not reach strata at ${HOST}:${PORT} - is the backend running?`);
  console.error(err.message);
  process.exit(1);
});
