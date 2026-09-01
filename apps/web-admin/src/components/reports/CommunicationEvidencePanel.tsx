import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityResponse, BrowserVisit, KeystrokeBucket } from "../../api/types";
import { fmtDuration } from "../../format";
import { Empty } from "../ui";
import {
  deriveCommunicationSessions,
  type CommunicationEvidence,
} from "./communicationEvidence";

const clock = (ts: number, locale: string) =>
  new Date(ts * 1000).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });

export function CommunicationEvidencePanel({
  activity,
  visits,
  keystrokes,
}: {
  activity: ActivityResponse;
  visits: BrowserVisit[];
  keystrokes: KeystrokeBucket[];
}) {
  const { t, i18n } = useTranslation("dashboard");
  const sessions = useMemo(
    () => deriveCommunicationSessions(activity.samples, visits, keystrokes),
    [activity.samples, visits, keystrokes],
  );
  const interacting = sessions.filter((session) => session.input_count > 0).length;
  const possibleCalls = sessions.filter((session) => session.evidence === "possible_call").length;
  const totalS = sessions.reduce((sum, session) => sum + session.duration_s, 0);

  const evidenceLabel = (evidence: CommunicationEvidence) =>
    t("detail.communications.evidence." + evidence);

  return (
    <section className="ad-comms" aria-labelledby="communication-evidence-title">
      <div className="ad-comms__head">
        <div>
          <span className="ad-comms__eyebrow">{t("detail.communications.eyebrow")}</span>
          <h2 id="communication-evidence-title">{t("detail.communications.title")}</h2>
          <p>{t("detail.communications.subtitle")}</p>
        </div>
        <div className="ad-comms__summary" aria-label={t("detail.communications.summaryLabel")}>
          <span><strong>{sessions.length}</strong>{t("detail.communications.sessions")}</span>
          <span><strong>{interacting}</strong>{t("detail.communications.interacting")}</span>
          <span><strong>{possibleCalls}</strong>{t("detail.communications.possibleCalls")}</span>
          <span><strong dir="ltr">{fmtDuration(totalS)}</strong>{t("detail.communications.totalTime")}</span>
        </div>
      </div>

      <div className="ad-comms__truth">
        <strong>{t("detail.communications.truthTitle")}</strong>
        <span>{t("detail.communications.truthBody")}</span>
      </div>

      {sessions.length === 0 ? (
        <Empty>{t("detail.communications.empty")}</Empty>
      ) : (
        <div className="ad-comms__list">
          {sessions.map((session, index) => (
            <article
              className="ad-comms__row"
              key={session.ts + "-" + session.platform + "-" + index}
            >
              <time dateTime={new Date(session.ts * 1000).toISOString()}>
                {clock(session.ts, i18n.language)}
              </time>
              <div className="ad-comms__platform">
                <span aria-hidden>{session.platform.charAt(0)}</span>
                <strong>{session.platform}</strong>
              </div>
              <div className="ad-comms__context">
                <strong title={session.context}>{session.context}</strong>
                {session.url ? <code dir="ltr" title={session.url}>{session.url}</code> : null}
              </div>
              <span className={"ad-comms__evidence ad-comms__evidence--" + session.evidence}>
                {evidenceLabel(session.evidence)}
              </span>
              <div className="ad-comms__metrics">
                <strong dir="ltr">{fmtDuration(session.duration_s)}</strong>
                <small>{t("detail.communications.inputCount", { count: session.input_count })}</small>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
