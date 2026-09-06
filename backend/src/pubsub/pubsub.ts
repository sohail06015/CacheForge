/**
 * Pub/Sub broker.
 *
 * The interesting problem here: every command we've built so far is
 * stateless with respect to the connection. GET doesn't care who's asking.
 * Subscriptions break that - the broker has to remember which socket is
 * listening to which channel, and push messages to sockets that didn't ask
 * for anything right now.
 *
 * That's why this lives outside the command table. Handlers receive
 * (store, args) and have no idea a connection exists; SUBSCRIBE needs one.
 * The TCP server intercepts these commands before dispatch and passes the
 * socket in.
 *
 * A subscriber is anything with a send() - a TCP socket wrapper here, but a
 * WebSocket for the dashboard works identically, which is how the dashboard
 * can watch channels live.
 */
export interface Subscriber {
  id: string;
  send: (message: string) => void;
}

export class PubSub {
  /** channel -> subscribers */
  private channels = new Map<string, Set<Subscriber>>();
  /** glob pattern -> subscribers (PSUBSCRIBE) */
  private patterns = new Map<string, Set<Subscriber>>();

  subscribe(sub: Subscriber, channel: string): number {
    const set = this.channels.get(channel) ?? new Set();
    set.add(sub);
    this.channels.set(channel, set);
    return this.subscriptionCount(sub);
  }

  psubscribe(sub: Subscriber, pattern: string): number {
    const set = this.patterns.get(pattern) ?? new Set();
    set.add(sub);
    this.patterns.set(pattern, set);
    return this.subscriptionCount(sub);
  }

  unsubscribe(sub: Subscriber, channel?: string): number {
    if (channel) {
      this.channels.get(channel)?.delete(sub);
      if (this.channels.get(channel)?.size === 0) this.channels.delete(channel);
    } else {
      // No channel given: drop every subscription this client holds.
      for (const [name, set] of this.channels) {
        set.delete(sub);
        if (set.size === 0) this.channels.delete(name);
      }
    }
    return this.subscriptionCount(sub);
  }

  /**
   * Must be called when a socket closes. Without this the broker holds a
   * reference to every client that ever connected - a slow memory leak that
   * only shows up under real traffic.
   */
  removeSubscriber(sub: Subscriber) {
    for (const [name, set] of this.channels) {
      set.delete(sub);
      if (set.size === 0) this.channels.delete(name);
    }
    for (const [name, set] of this.patterns) {
      set.delete(sub);
      if (set.size === 0) this.patterns.delete(name);
    }
  }

  /** Returns how many clients received the message. */
  publish(channel: string, message: string): number {
    let delivered = 0;

    for (const sub of this.channels.get(channel) ?? []) {
      sub.send(encodeMessage(["message", channel, message]));
      delivered++;
    }

    for (const [pattern, subs] of this.patterns) {
      if (!globToRegex(pattern).test(channel)) continue;
      for (const sub of subs) {
        sub.send(encodeMessage(["pmessage", pattern, channel, message]));
        delivered++;
      }
    }

    return delivered;
  }

  /** Channels with at least one subscriber - powers PUBSUB CHANNELS. */
  activeChannels(): { channel: string; subscribers: number }[] {
    return [...this.channels].map(([channel, subs]) => ({
      channel,
      subscribers: subs.size,
    }));
  }

  private subscriptionCount(sub: Subscriber): number {
    let n = 0;
    for (const set of this.channels.values()) if (set.has(sub)) n++;
    for (const set of this.patterns.values()) if (set.has(sub)) n++;
    return n;
  }
}

function encodeMessage(parts: string[]): string {
  return `*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("");
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
