import type { ActivitySample, BrowserVisit, KeystrokeBucket } from "../../api/types";

export type CommunicationEvidence = "observed" | "interacting" | "possible_call";

export interface CommunicationSession {
  ts: number;
  duration_s: number;
  platform: string;
  context: string;
  url: string | null;
  input_count: number;
  evidence: CommunicationEvidence;
}

const COMMUNICATION_TERMS = [
  "aircall", "campaign", "chat", "chatwoot", "discord", "hubspot", "intercom",
  "meet", "messenger", "ringcentral", "skype", "slack", "teams", "telegram",
  "twilio", "whatsapp", "yasser", "yassir", "yasr", "zendesk", "zoom",
  "حملة", "رسالة", "محادثة", "واتساب",
];

const CALL_TERMS = [
  "call", "calling", "conference", "dialer", "huddle", "meeting", "phone",
  "webinar", "اتصال", "اجتماع", "مكالمة",
];

const GENERIC_BROWSER_TERMS = ["chrome", "edge", "firefox", "brave", "browser", "opera"];
const PLATFORM_NAMES: [string, string][] = [
  ["whatsapp", "WhatsApp"],
  ["teams", "Microsoft Teams"],
  ["google meet", "Google Meet"],
  ["meet.google", "Google Meet"],
  ["slack", "Slack"],
  ["zoom", "Zoom"],
  ["telegram", "Telegram"],
  ["messenger", "Messenger"],
  ["discord", "Discord"],
  ["aircall", "Aircall"],
  ["ringcentral", "RingCentral"],
  ["chatwoot", "Chatwoot"],
  ["hubspot", "HubSpot"],
  ["yasser", "Yasser"],
  ["yassir", "Yassir"],
  ["yasr", "Yasr"],
];

const normal = (value: string | null | undefined) => (value ?? "").trim().toLocaleLowerCase();
const containsAny = (value: string, terms: string[]) => terms.some((term) => value.includes(term));

function displayPlatform(value: string): string {
  const canonical = PLATFORM_NAMES.find(([term]) => normal(value).includes(term));
  if (canonical) return canonical[1];
  const trimmed = value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    .replace(/\.exe$/i, "")
    .trim();
  if (!trimmed) return "Communication app";
  return trimmed
    .split(/[.\-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function browserPlatform(visit: BrowserVisit): string {
  return displayPlatform(visit.domain || visit.url || visit.browser);
}

function isCommunication(value: string): boolean {
  return containsAny(normal(value), COMMUNICATION_TERMS);
}

function isPossibleCall(value: string): boolean {
  return containsAny(normal(value), CALL_TERMS);
}

function overlaps(leftTs: number, leftDuration: number, rightTs: number, rightDuration: number) {
  return leftTs < rightTs + rightDuration && rightTs < leftTs + leftDuration;
}

function inputDuring(ts: number, durationS: number, buckets: KeystrokeBucket[]): number {
  const end = ts + Math.max(1, durationS);
  return buckets.reduce(
    (sum, bucket) =>
      bucket.ts_bucket < end && bucket.ts_bucket + 60 > ts ? sum + bucket.count : sum,
    0,
  );
}

interface RawSession {
  ts: number;
  duration_s: number;
  platform: string;
  context: string;
  url: string | null;
  possible_call: boolean;
}

function mergeSessions(rows: RawSession[]): RawSession[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const merged: RawSession[] = [];
  for (const row of sorted) {
    const previous = merged[merged.length - 1];
    const previousEnd = previous ? previous.ts + previous.duration_s : 0;
    const canMerge =
      previous &&
      previous.platform === row.platform &&
      previous.context === row.context &&
      previous.url === row.url &&
      row.ts - previousEnd <= 60;
    if (canMerge) {
      previous.duration_s = Math.max(previousEnd, row.ts + row.duration_s) - previous.ts;
      previous.possible_call ||= row.possible_call;
    } else {
      merged.push({ ...row });
    }
  }
  return merged;
}

/**
 * Builds honest, metadata-only communication evidence:
 * - foreground app/page proves that the workspace was open;
 * - input counts prove interaction, never what was typed;
 * - a call/meeting label is only a title-based possibility, not confirmation.
 *
 * A sent message or completed call needs an official platform webhook/API event
 * and must not be inferred from keyboard activity.
 */
export function deriveCommunicationSessions(
  activity: ActivitySample[],
  visits: BrowserVisit[],
  keystrokes: KeystrokeBucket[],
): CommunicationSession[] {
  const browserRows: RawSession[] = visits
    .filter((visit) => isCommunication(visit.domain + " " + visit.page_title + " " + visit.url))
    .map((visit) => ({
      ts: visit.ts,
      duration_s: Math.max(1, visit.duration_s),
      platform: browserPlatform(visit),
      context: visit.page_title || visit.domain || visit.url,
      url: visit.url || null,
      possible_call: isPossibleCall(visit.page_title + " " + visit.url),
    }));

  const appRows: RawSession[] = activity
    .filter((sample) => isCommunication(sample.app_name + " " + sample.window_title))
    .filter((sample) => {
      const genericBrowser = containsAny(normal(sample.app_name), GENERIC_BROWSER_TERMS);
      if (!genericBrowser) return true;
      return !browserRows.some((visit) =>
        overlaps(sample.ts, Math.max(1, sample.duration_s), visit.ts, visit.duration_s),
      );
    })
    .map((sample) => ({
      ts: sample.ts,
      duration_s: Math.max(1, sample.duration_s),
      platform: displayPlatform(
        containsAny(normal(sample.app_name), GENERIC_BROWSER_TERMS)
          ? sample.window_title
          : sample.app_name,
      ),
      context: sample.window_title || sample.app_name,
      url: null,
      possible_call: isPossibleCall(sample.window_title),
    }));

  return mergeSessions([...browserRows, ...appRows])
    .map((session) => {
      const inputCount = inputDuring(session.ts, session.duration_s, keystrokes);
      return {
        ...session,
        input_count: inputCount,
        evidence: session.possible_call
          ? "possible_call" as const
          : inputCount > 0
            ? "interacting" as const
            : "observed" as const,
      };
    })
    .sort((a, b) => b.ts - a.ts);
}
