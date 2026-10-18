import { describe, expect, it } from "vitest";
import { deriveCommunicationSessions } from "./communicationEvidence";

describe("deriveCommunicationSessions", () => {
  it("labels keyboard activity as interaction, not as a sent message", () => {
    const sessions = deriveCommunicationSessions(
      [],
      [{
        ts: 100,
        url: "https://web.whatsapp.com/chat/42",
        domain: "web.whatsapp.com",
        page_title: "Customer chat",
        browser: "Chrome",
        duration_s: 40,
      }],
      [{ ts_bucket: 60, count: 18 }],
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      platform: "WhatsApp",
      evidence: "interacting",
      input_count: 18,
    });
  });

  it("marks a meeting title as possible rather than confirmed", () => {
    const sessions = deriveCommunicationSessions(
      [{ ts: 200, app_name: "Microsoft Teams.exe", window_title: "Call with Ahmed", duration_s: 90 }],
      [],
      [],
    );

    expect(sessions[0].evidence).toBe("possible_call");
  });

  it("does not duplicate a browser app sample when an exact URL visit overlaps it", () => {
    const sessions = deriveCommunicationSessions(
      [{ ts: 300, app_name: "Google Chrome", window_title: "Slack", duration_s: 30 }],
      [{
        ts: 300,
        url: "https://engosoft.slack.com/client",
        domain: "engosoft.slack.com",
        page_title: "Support channel",
        browser: "Chrome",
        duration_s: 30,
      }],
      [],
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].url).toContain("slack.com");
  });

  it("ignores unrelated activity", () => {
    expect(deriveCommunicationSessions(
      [{ ts: 1, app_name: "Excel.exe", window_title: "Budget.xlsx", duration_s: 60 }],
      [],
      [],
    )).toEqual([]);
  });
});
