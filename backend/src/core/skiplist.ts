import { ZSetMember } from "../types";

/**
 * A skip list - the data structure real Redis uses for sorted sets.
 *
 * The problem it solves: a sorted array gives O(log n) *search* via binary
 * search, but O(n) *insert*, because everything after the insertion point
 * shifts. A balanced tree fixes that but is fiddly to implement and
 * rebalance correctly.
 *
 * A skip list gets O(log n) expected insert, delete, and search with far
 * simpler code. The idea: keep a normal sorted linked list at level 0, then
 * build sparser "express lane" lists above it. Each node is promoted to the
 * next level up with probability 1/4, so level 1 holds ~1/4 of nodes, level
 * 2 ~1/16, and so on.
 *
 * To search, start top-left and move right while the next node is still too
 * small; when it would overshoot, drop down a level. You skip huge spans of
 * the list near the top and narrow in as you descend - like a binary search
 * over a linked list.
 *
 * The heights are chosen at random rather than rebalanced. That's the trick:
 * no rotations, no rebalancing logic, and the probabilistic guarantee is
 * strong enough that Redis ships it. "Expected" O(log n) rather than
 * worst-case, but the worst case needs an absurd run of coin flips.
 */

const MAX_LEVEL = 16;
const PROBABILITY = 0.25;

interface SkipNode {
  member: string;
  score: number;
  /** forward[i] is the next node at level i. */
  forward: (SkipNode | null)[];
  /** span[i] = how many level-0 nodes forward[i] jumps over. Enables O(log n) rank lookup. */
  span: number[];
}

export class SkipList {
  private head: SkipNode;
  private level = 1;
  private length = 0;
  /** member -> score, so score lookups and existence checks stay O(1). */
  private scores = new Map<string, number>();

  constructor() {
    this.head = {
      member: "",
      score: -Infinity,
      forward: new Array(MAX_LEVEL).fill(null),
      span: new Array(MAX_LEVEL).fill(0),
    };
  }

  get size(): number {
    return this.length;
  }

  /** Coin-flip height. Each level up is 4x less likely than the one below. */
  private randomLevel(): number {
    let lvl = 1;
    while (Math.random() < PROBABILITY && lvl < MAX_LEVEL) lvl++;
    return lvl;
  }

  /**
   * Sorted sets order by score, then lexicographically by member for ties.
   * Without the tiebreak, equal-scored members would have unstable ordering
   * and ZRANGE results would vary between runs.
   */
  private isBefore(aScore: number, aMember: string, bScore: number, bMember: string): boolean {
    if (aScore !== bScore) return aScore < bScore;
    return aMember < bMember;
  }

  /** Adds or updates a member. Returns true if it's newly added. */
  add(score: number, member: string): boolean {
    const existing = this.scores.get(member);
    if (existing !== undefined) {
      if (existing === score) return false;
      // A score change is a move, not an edit: position depends on score.
      this.remove(member);
      this.insert(score, member);
      return false;
    }
    this.insert(score, member);
    return true;
  }

  private insert(score: number, member: string) {
    const update: SkipNode[] = new Array(MAX_LEVEL);
    const rank: number[] = new Array(MAX_LEVEL).fill(0);
    let node = this.head;

    // Descend from the top, recording where we dropped down at each level -
    // those are exactly the nodes whose pointers need updating.
    for (let i = this.level - 1; i >= 0; i--) {
      rank[i] = i === this.level - 1 ? 0 : rank[i + 1];
      while (
        node.forward[i] &&
        this.isBefore(node.forward[i]!.score, node.forward[i]!.member, score, member)
      ) {
        rank[i] += node.span[i];
        node = node.forward[i]!;
      }
      update[i] = node;
    }

    const newLevel = this.randomLevel();
    if (newLevel > this.level) {
      for (let i = this.level; i < newLevel; i++) {
        rank[i] = 0;
        update[i] = this.head;
        update[i].span[i] = this.length;
      }
      this.level = newLevel;
    }

    const newNode: SkipNode = {
      member,
      score,
      forward: new Array(MAX_LEVEL).fill(null),
      span: new Array(MAX_LEVEL).fill(0),
    };

    for (let i = 0; i < newLevel; i++) {
      newNode.forward[i] = update[i].forward[i];
      update[i].forward[i] = newNode;
      // Split the old span across the new node.
      newNode.span[i] = update[i].span[i] - (rank[0] - rank[i]);
      update[i].span[i] = rank[0] - rank[i] + 1;
    }

    // Levels above the new node's height now span one extra element.
    for (let i = newLevel; i < this.level; i++) {
      update[i].span[i]++;
    }

    this.scores.set(member, score);
    this.length++;
  }

  remove(member: string): boolean {
    const score = this.scores.get(member);
    if (score === undefined) return false;

    const update: SkipNode[] = new Array(MAX_LEVEL);
    let node = this.head;

    for (let i = this.level - 1; i >= 0; i--) {
      while (
        node.forward[i] &&
        this.isBefore(node.forward[i]!.score, node.forward[i]!.member, score, member)
      ) {
        node = node.forward[i]!;
      }
      update[i] = node;
    }

    const target = node.forward[0];
    if (!target || target.member !== member) return false;

    for (let i = 0; i < this.level; i++) {
      if (update[i].forward[i] === target) {
        update[i].span[i] += target.span[i] - 1;
        update[i].forward[i] = target.forward[i];
      } else {
        update[i].span[i]--;
      }
    }

    // Drop now-empty top levels so searches don't waste steps on them.
    while (this.level > 1 && !this.head.forward[this.level - 1]) this.level--;

    this.scores.delete(member);
    this.length--;
    return true;
  }

  getScore(member: string): number | undefined {
    return this.scores.get(member);
  }

  /** 0-based rank in ascending order, or -1 if absent. O(log n) via spans. */
  rank(member: string): number {
    const score = this.scores.get(member);
    if (score === undefined) return -1;

    let node = this.head;
    let traversed = 0;
    for (let i = this.level - 1; i >= 0; i--) {
      while (
        node.forward[i] &&
        !this.isBefore(score, member, node.forward[i]!.score, node.forward[i]!.member)
      ) {
        traversed += node.span[i];
        node = node.forward[i]!;
      }
      if (node.member === member) return traversed - 1;
    }
    return -1;
  }

  /** Members in [start, stop] by rank, supporting negative indices. */
  range(start: number, stop: number): ZSetMember[] {
    const len = this.length;
    let s = start < 0 ? Math.max(len + start, 0) : start;
    let e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (s > e || s >= len) return [];

    const out: ZSetMember[] = [];
    let node: SkipNode | null = this.head.forward[0];
    let idx = 0;
    while (node && idx <= e) {
      if (idx >= s) out.push({ member: node.member, score: node.score });
      node = node.forward[0];
      idx++;
    }
    return out;
  }

  /** Members whose score falls in [min, max], inclusive. */
  rangeByScore(min: number, max: number): ZSetMember[] {
    const out: ZSetMember[] = [];
    let node: SkipNode | null = this.head.forward[0];
    while (node) {
      if (node.score >= min && node.score <= max) {
        out.push({ member: node.member, score: node.score });
      }
      if (node.score > max) break;
      node = node.forward[0];
    }
    return out;
  }

  toArray(): ZSetMember[] {
    return this.range(0, -1);
  }

  static fromArray(members: ZSetMember[]): SkipList {
    const list = new SkipList();
    for (const m of members) list.add(m.score, m.member);
    return list;
  }
}
