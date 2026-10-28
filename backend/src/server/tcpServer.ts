import * as net from "net";
import { Store } from "../core/store";
import { RespParser, encode, Resp } from "../protocol/resp";
import { dispatch, WRITE_COMMANDS } from "../commands";
import { AofLog } from "../persistence/aof";
import { PubSub, Subscriber } from "../pubsub/pubsub";

/**
 * The main database port (6380 by default - one above Redis's 6379, so you
 * can run both side by side and compare behaviour).
 *
 * Each connection gets its own RespParser (to buffer partial reads) but all
 * connections share one Store. That shared Store is what makes this a
 * database rather than per-connection scratch space.
 *
 * Pub/sub commands are handled here rather than in the command table,
 * because they're the only commands that need to know which socket is
 * asking. Everything else is connection-agnostic.
 */
export function startTcpServer(
  store: Store,
  aof: AofLog,
  pubsub: PubSub,
  port = 6380,
  requirePassword?: string
) {
  let connectionCounter = 0;

  const server = net.createServer((socket) => {
    const parser = new RespParser();
    const id = `conn-${++connectionCounter}`;
    const subscriber: Subscriber = { id, send: (msg) => socket.write(msg) };

    // Once a connection subscribes, Redis restricts it to pub/sub commands.
    // We track it so SUBSCRIBE mode behaves the way clients expect.
    let subscribedChannels = 0;
    let authenticated = !requirePassword;

    socket.on("data", (chunk) => {
      parser.push(chunk);
      let command: string[] | null;

      // One TCP packet may hold several pipelined commands, so drain every
      // complete one rather than assuming "one read = one command".
      while ((command = parser.take()) !== null) {
        const [rawName, ...args] = command;
        if (!rawName) continue;
        const name = rawName.toUpperCase();

        if (name === "AUTH") {
          if (!requirePassword) { socket.write(encode(Resp.error("ERR Client sent AUTH, but no password is set"))); continue; }
          authenticated = args[0] === requirePassword;
          socket.write(encode(authenticated ? Resp.simple("OK") : Resp.error("ERR invalid password")));
          continue;
        }

        if (!authenticated) {
          socket.write(encode(Resp.error("NOAUTH Authentication required")));
          continue;
        }

        // --- Pub/sub: needs the connection, so handled before dispatch ---
        if (name === "SUBSCRIBE" || name === "PSUBSCRIBE") {
          for (const channel of args) {
            subscribedChannels =
              name === "SUBSCRIBE"
                ? pubsub.subscribe(subscriber, channel)
                : pubsub.psubscribe(subscriber, channel);
            socket.write(
              encode(Resp.array([Resp.bulk(name.toLowerCase()), Resp.bulk(channel), Resp.integer(subscribedChannels)]))
            );
          }
          continue;
        }

        if (name === "UNSUBSCRIBE") {
          const channels = args.length ? args : ["*all*"];
          for (const channel of channels) {
            subscribedChannels = pubsub.unsubscribe(subscriber, args.length ? channel : undefined);
            socket.write(
              encode(Resp.array([Resp.bulk("unsubscribe"), Resp.bulk(channel), Resp.integer(subscribedChannels)]))
            );
          }
          continue;
        }

        if (name === "PUBLISH") {
          if (args.length !== 2) {
            socket.write(encode(Resp.error("ERR wrong number of arguments for 'publish' command")));
            continue;
          }
          socket.write(encode(Resp.integer(pubsub.publish(args[0], args[1]))));
          continue;
        }

        if (name === "PUBSUB") {
          const sub = (args[0] ?? "").toUpperCase();
          if (sub === "CHANNELS") {
            socket.write(encode(Resp.array(pubsub.activeChannels().map((c) => Resp.bulk(c.channel)))));
          } else {
            socket.write(encode(Resp.error("ERR unknown PUBSUB subcommand")));
          }
          continue;
        }

        // A subscribed connection may only use pub/sub commands (plus PING
        // and QUIT), matching Redis's behaviour.
        if (subscribedChannels > 0 && name !== "PING" && name !== "QUIT") {
          socket.write(
            encode(Resp.error("ERR only (P)SUBSCRIBE / (P)UNSUBSCRIBE / PING / QUIT are allowed in this context"))
          );
          continue;
        }

        if (name === "QUIT") {
          socket.write(encode(Resp.simple("OK")));
          socket.end();
          continue;
        }

        // --- Normal commands ---
        const reply = dispatch(store, name, args);

        // Only log writes that actually succeeded. Logging a failed command
        // would corrupt state on replay - it would be re-applied at startup
        // as though it had worked.
        if (WRITE_COMMANDS.has(name) && reply.kind !== "error") {
          aof.append(name, args);
          if (aof.shouldRewrite()) aof.rewrite(store.rebuildCommands());
        }

        socket.write(encode(reply));
      }
    });

    // Without this the broker keeps a reference to every client that ever
    // connected - a slow leak that only appears under real traffic.
    socket.on("close", () => pubsub.removeSubscriber(subscriber));
    socket.on("error", () => pubsub.removeSubscriber(subscriber));
  });

  server.listen(port, () => {
    console.log(`[CacheForge] RESP server listening on port ${port} (try: redis-cli -p ${port})`);
  });

  return server;
}
