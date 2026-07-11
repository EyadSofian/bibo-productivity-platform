# LLM-powered employee performance insights (design)

> Goal: give the business owner a **one-glance** read on each employee — "doing well / needs
> attention" — automatically generated from the data we already capture (screenshots + activity
> text in Postgres), at the lowest sensible cost.

This is a design proposal, not yet implemented. It targets the existing stack: Go backend
(`ctracking/backend`, Gin + pgx), Postgres, web-admin dashboard.

---

## 1. What we feed the model

We already store, per device/employee:

- **Activity text** — app/window titles, browser events, active-vs-idle time (the `activity` /
  `browser` tables). Cheap, structured, high signal.
- **Screenshots** — periodic captures (the `screenshot` table). Rich but expensive (image tokens).

**Recommendation: text-first.** 90% of the "is this person productive" signal is in the activity
text (which apps, how long, idle ratio, focus vs context-switching). Screenshots are a *sampled*
fallback — send a handful per day only when the text is ambiguous, not all of them. This keeps cost
and privacy exposure down.

---

## 2. Which model — lowest cost

| Model | ID | In $/1M | Out $/1M | Vision | Notes |
|---|---|---|---|---|---|
| **Claude Haiku 4.5** | `claude-haiku-4-5` | $1.00 | $5.00 | ✅ | **Pick this.** Fastest + cheapest, reads screenshots, 200K context. |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3.00 | $15.00 | ✅ | Step up if Haiku's judgement isn't nuanced enough. |
| Claude Opus 4.8 | `claude-opus-4-8` | $5.00 | $25.00 | ✅ | Overkill for this — don't pay for it. |

**Decision: Claude Haiku 4.5.** A daily per-employee summary is a classification/summarization task —
exactly what Haiku is built for. Start here; only move to Sonnet if you can measurably show Haiku
mislabels people.

### Three cost levers that stack

1. **Batch, don't stream.** This runs nightly, not live → use the **Message Batches API** for a flat
   **50% discount** on all tokens.
2. **Prompt caching.** The scoring rubric / system prompt is identical for every employee. Cache it
   once (`cache_control: {type: "ephemeral"}`) → cached reads cost ~0.1× instead of 1×.
3. **Text-first, sample screenshots.** Image tokens dwarf text tokens. Only attach screenshots when
   needed.

### Back-of-envelope cost

Per employee/day: ~5K input tokens (a day of activity text + rubric) + ~500 output tokens.
- Input: 5,000 × $1/1M = $0.005
- Output: 500 × $5/1M = $0.0025
- ≈ **$0.0075/employee/day** → with batch (−50%) ≈ **$0.004**.

**10 employees ≈ $1.20/month. 100 employees ≈ $12/month.** Screenshots add cost only when sampled.

---

## 3. How the system runs

```
                    nightly cron (e.g. 02:00)
                            │
                            ▼
   ┌─────────────────────────────────────────────┐
   │  Go backend: insights job                    │
   │  1. for each employee with activity today:   │
   │       query Postgres → build compact summary │
   │       (top apps, active/idle, switch count)  │
   │  2. assemble one Batch request per employee  │
   │  3. submit ONE Message Batch                  │
   └───────────────┬─────────────────────────────┘
                   │  POST /v1/messages/batches
                   ▼
         Anthropic Batches API  (Haiku 4.5)
                   │  (most batches finish < 1h)
                   ▼
   ┌─────────────────────────────────────────────┐
   │  Go backend: poll batch → on "ended",        │
   │  read results (keyed by employee custom_id), │
   │  write rows to employee_insights table       │
   └───────────────┬─────────────────────────────┘
                   ▼
        web-admin dashboard renders the cards
```

### Steps in detail

1. **Aggregate in SQL first (do NOT dump raw rows to the model).** For each employee, compute a small
   digest: total active minutes, idle %, top 10 apps/sites by time, number of context switches,
   longest focus block. This turns thousands of rows into ~1KB of text. Cheaper, and better signal.
2. **One batch request per employee**, each with a `custom_id = "<employee_id>:<date>"`.
3. **System prompt = the scoring rubric** (cached). Force structured output so the result is
   machine-readable, not prose.
4. **Submit the batch**, store the returned `batch_id`, poll until `processing_status == "ended"`.
5. **Persist results** into a new `employee_insights` table.
6. **Dashboard** reads that table — no LLM call on page load.

### New table (sketch)

```sql
create table employee_insights (
  id            bigserial primary key,
  user_id       bigint not null references users(id),
  business_id   bigint not null references businesses(id),
  for_date      date   not null,
  rating        text   not null,          -- e.g. 'good' | 'ok' | 'attention'
  score         int,                      -- 0-100, optional
  summary       text   not null,          -- 1-2 sentence owner-facing blurb
  highlights    jsonb,                    -- structured bullets
  model         text   not null,          -- 'claude-haiku-4-5'
  created_at    timestamptz not null default now(),
  unique (user_id, for_date)
);
```

---

## 4. Structured output (so it's not free-text)

Constrain the response to a schema with `output_config.format` so the Go side gets clean JSON every
time:

```json
{
  "rating": "good | ok | attention",
  "score": 0,
  "summary": "One sentence the owner reads at a glance.",
  "highlights": ["bullet", "bullet"],
  "concerns": ["bullet"]
}
```

---

## 5. Go integration sketch

The official SDK is `github.com/anthropics/anthropic-sdk-go`. Pseudocode for the job:

```go
// 1. Build per-employee digests from Postgres (SQL aggregation).
// 2. One batch request per employee:
req := anthropic.MessageBatchNewParams{
    Requests: []anthropic.MessageBatchRequestParam{
        {
            CustomID: fmt.Sprintf("%d:%s", userID, day),
            Params: anthropic.MessageNewParams{
                Model:     anthropic.Model("claude-haiku-4-5"),
                MaxTokens: 1024,
                System: []anthropic.TextBlockParam{{
                    Text:         rubric,                       // identical for everyone
                    CacheControl: anthropic.NewCacheControlEphemeralParam(), // cache it
                }},
                Messages: []anthropic.MessageParam{
                    anthropic.NewUserMessage(anthropic.NewTextBlock(digest)),
                },
                // output_config.format → force the JSON schema above
            },
        },
        // ... one per employee
    },
}
batch, _ := client.Messages.Batches.New(ctx, req)
// 3. Poll client.Messages.Batches.Get until ProcessingStatus == "ended"
// 4. Stream client.Messages.Batches.Results — match by CustomID — upsert into employee_insights
```

> Verify exact SDK type/method names against the anthropic-sdk-go repo before writing — the Go SDK's
> builders differ slightly from the JSON shape.

### Auth / config
- `ANTHROPIC_API_KEY` in the backend `.env` (same pattern as existing env config).
- Add a feature flag / env toggle so self-hosters without a key just don't run the job.

---

## 6. Screenshots: when and how

Only attach images when the text digest is inconclusive (e.g. lots of "idle" but unclear why, or a
generic app title). Sample **2–4 screenshots/day max**, downscale before sending. Image input is
supported by Haiku 4.5 — send as base64 or via the Files API. Each full-res image can be hundreds to
a few thousand tokens, so this is the main cost knob — keep it bounded.

---

## 7. Privacy / trust (important)

- This produces a **judgement about a person** — keep it factual and bounded. Tell the model in the
  system prompt: report observations, not character verdicts; flag uncertainty.
- Screenshots may contain sensitive content. Sampling + downscaling reduces exposure; consider
  letting owners disable image analysis per business.
- Data leaves the box to Anthropic's API. For the open-source/self-host story, make the whole feature
  **opt-in** and clearly disclosed.

---

## 8. Build order (suggested)

1. SQL aggregation → produce the per-employee daily digest (no LLM yet; verify the numbers).
2. `employee_insights` migration (goose).
3. Text-only nightly batch job → write ratings. Ship behind a flag.
4. Dashboard cards in web-admin.
5. Add sampled-screenshot fallback.
6. Tune rubric; evaluate Haiku vs Sonnet on a few real employees before deciding to upgrade.

**Bottom line:** Haiku 4.5 + nightly Batch API + SQL pre-aggregation + cached rubric = accurate daily
per-employee insight cards for a couple dollars a month.
