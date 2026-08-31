import { describe, expect, it } from "vitest";
import { SSEDecoder } from "./sse";

describe("SSEDecoder", () => {
  it("decodes a single complete event", () => {
    const d = new SSEDecoder();
    expect(d.push('event: frame\ndata: {"image":"AA"}\n\n')).toEqual([
      { event: "frame", data: '{"image":"AA"}' },
    ]);
  });

  it("decodes several events from one chunk", () => {
    const d = new SSEDecoder();
    const events = d.push("event: ping\ndata: {}\n\nevent: end\ndata: {}\n\n");
    expect(events.map((e) => e.event)).toEqual(["ping", "end"]);
  });

  // The frame payload is ~341 KiB at the cap, so it reliably arrives split
  // across chunks. Rendering half a payload would throw or paint garbage.
  it("buffers a record split across chunk boundaries", () => {
    const d = new SSEDecoder();
    expect(d.push("event: fra")).toEqual([]);
    expect(d.push('me\ndata: {"im')).toEqual([]);
    expect(d.push('age":"AA"}')).toEqual([]);
    expect(d.push("\n\n")).toEqual([{ event: "frame", data: '{"image":"AA"}' }]);
  });

  it("splits a boundary that lands between the two newlines", () => {
    const d = new SSEDecoder();
    expect(d.push("event: ping\ndata: {}\n")).toEqual([]);
    expect(d.push("\n")).toEqual([{ event: "ping", data: "{}" }]);
  });

  it("normalizes CRLF line endings", () => {
    const d = new SSEDecoder();
    expect(d.push("event: ping\r\ndata: {}\r\n\r\n")).toEqual([{ event: "ping", data: "{}" }]);
  });

  it("defaults the event name to message", () => {
    const d = new SSEDecoder();
    expect(d.push("data: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
  });

  it("ignores comments, keepalive colons and unknown fields", () => {
    const d = new SSEDecoder();
    const events = d.push(": keepalive\n\nid: 7\nretry: 500\nevent: frame\ndata: x\n\n");
    expect(events).toEqual([{ event: "frame", data: "x" }]);
  });

  it("strips exactly one leading space after the colon", () => {
    const d = new SSEDecoder();
    expect(d.push("event: frame\ndata:  padded\n\n")).toEqual([
      { event: "frame", data: " padded" },
    ]);
  });

  it("joins multi-line data fields with newlines", () => {
    const d = new SSEDecoder();
    expect(d.push("event: frame\ndata: a\ndata: b\n\n")).toEqual([
      { event: "frame", data: "a\nb" },
    ]);
  });

  it("keeps decoding after an incomplete trailing record", () => {
    const d = new SSEDecoder();
    expect(d.push("event: ping\ndata: {}\n\nevent: fr")).toEqual([{ event: "ping", data: "{}" }]);
    expect(d.push("ame\ndata: y\n\n")).toEqual([{ event: "frame", data: "y" }]);
  });
});
