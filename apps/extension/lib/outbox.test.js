import { describe, expect, it } from "vitest";
import { append, drop, head, MAX_QUEUED } from "./outbox.js";

const seg = (n) => ({ client_uuid: `u${n}`, url: `https://e.com/${n}`, duration_s: 60 });
const many = (n, from = 0) => Array.from({ length: n }, (_, i) => seg(from + i));

describe("append", () => {
  it("adds to the tail", () => {
    const { queue, dropped } = append([seg(1)], [seg(2)]);

    expect(queue.map((s) => s.client_uuid)).toEqual(["u1", "u2"]);
    expect(dropped).toBe(0);
  });

  it("accepts several at once", () => {
    const { queue } = append([], [seg(1), seg(2), seg(3)]);

    expect(queue).toHaveLength(3);
  });

  it("holds a full queue without dropping", () => {
    const { queue, dropped } = append(many(MAX_QUEUED - 1), [seg(999)]);

    expect(queue).toHaveLength(MAX_QUEUED);
    expect(dropped).toBe(0);
  });

  // A long outage must not grow extension storage without bound, but the data
  // kept should be the recent history a manager would actually look at.
  it("evicts the oldest once full", () => {
    const { queue, dropped } = append(many(MAX_QUEUED), [seg(9001), seg(9002)]);

    expect(queue).toHaveLength(MAX_QUEUED);
    expect(dropped).toBe(2);
    expect(queue.at(-1).client_uuid).toBe("u9002");
    expect(queue.at(0).client_uuid).toBe("u2");
  });

  it("reports every eviction so the loss is never silent", () => {
    const { dropped } = append(many(MAX_QUEUED), many(50, 9000));

    expect(dropped).toBe(50);
  });

  it("does not mutate the queue it was given", () => {
    const original = [seg(1)];

    append(original, [seg(2)]);

    expect(original).toHaveLength(1);
  });
});

describe("head and drop", () => {
  it("takes the oldest first", () => {
    expect(head(many(10), 3).map((s) => s.client_uuid)).toEqual(["u0", "u1", "u2"]);
  });

  it("takes what exists when the queue is short", () => {
    expect(head(many(2), 10)).toHaveLength(2);
  });

  it("removes exactly what was accepted", () => {
    expect(drop(many(5), 2).map((s) => s.client_uuid)).toEqual(["u2", "u3", "u4"]);
  });

  // The failure this prevents: a flush is in flight when a checkpoint appends
  // a new segment. Dropping positionally is only safe because appends land at
  // the tail, so the accepted head is still the head.
  it("keeps segments appended while a flush was in flight", () => {
    const queue = many(3);
    const sending = head(queue, 3);
    const grown = append(queue, [seg(99)]).queue;

    const remaining = drop(grown, sending.length);

    expect(remaining.map((s) => s.client_uuid)).toEqual(["u99"]);
  });

  it("leaves the queue alone when nothing was accepted", () => {
    expect(drop(many(3), 0)).toHaveLength(3);
  });

  it("does not mutate the queue it was given", () => {
    const original = many(3);

    drop(original, 2);

    expect(original).toHaveLength(3);
  });
});
