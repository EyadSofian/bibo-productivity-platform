// Minimal Server-Sent Events decoder.
//
// The browser's built-in EventSource cannot send an Authorization header, and
// putting an access token in the query string would leak it into proxy logs and
// browser history. So authenticated streams are read with fetch() + a
// ReadableStream, and this decoder turns the byte chunks back into events.
//
// It implements the subset of the SSE grammar the backend emits: `event:` and
// `data:` lines, records separated by a blank line. Comments and `id:`/`retry:`
// fields are ignored rather than mis-parsed.

export type SSEEvent = { event: string; data: string };

/**
 * Incrementally decodes SSE records from arbitrary chunk boundaries. A record
 * split across two network chunks is buffered until it is complete, so a frame
 * is never rendered from half a payload.
 */
export class SSEDecoder {
  private buffer = "";

  /** Feeds one chunk of decoded text and returns every complete event in it. */
  push(chunk: string): SSEEvent[] {
    // Normalize CRLF/CR line endings so a proxy that rewrites them cannot
    // split records incorrectly.
    this.buffer += chunk.replace(/\r\n|\r/g, "\n");
    const events: SSEEvent[] = [];

    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const record = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseRecord(record);
      if (parsed) events.push(parsed);
      boundary = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

function parseRecord(record: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of record.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not data.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
