# @rello-platform/pipeline

Pipeline-stage instrumentation for the Rello ecosystem. One wrapper, one structured-log shape, one Sentry breadcrumb convention — used identically at every stage boundary across the platform.

## Why this exists

Per NA-013 (April 2026 Nurture Audit), the nurture/intake pipeline has 76 identified stages and only 28% of them had working monitoring. The original Phase-2 plan — "go instrument 76 stages manually" — was a soft convention that decays the moment someone adds stage 77 without remembering to instrument it.

This package is the structural answer: every stage boundary calls `runStage()`. The wrapper emits a structured log + Sentry breadcrumb on entry and exit, captures exceptions on throw with stage tags, and stays out of the way otherwise. Stage 77 becomes instrumented because it cannot exist without going through the wrapper — first as a convention, then enforced via TypeScript brand types or an ESLint rule (NA-013 Phase 2 Step 4).

## What it handles

- **Entry and exit observability.** Every stage emits `pipeline_stage_start` and `pipeline_stage_complete` structured log lines, plus `pipeline.<name>` and `<name>.complete` breadcrumbs to whatever Sentry SDK the consumer configured. Successful stages report `durationMs`.
- **Error capture.** On throw, the wrapper calls `Sentry.captureException(error, { tags: { stage }, extra: { ...ctx, durationMs } })` and emits a `pipeline_stage_error` log line, then re-throws. Caller-side error handling is unchanged.
- **Dormant-safe Sentry.** If the consumer hasn't configured Sentry (or `SENTRY_DSN` is unset and `Sentry.init` is a no-op), the wrapper still emits structured logs. Sentry call failures are caught internally — telemetry breakage never breaks the wrapped fn.
- **No runtime deps.** Consumers bring their own Sentry SDK and logger via `configurePipeline()` — same precedent as `@rello-platform/sentry-init`.

## Installation

```bash
npm install github:rello-platform/pipeline#v0.1.0
```

## Usage

### One-time configuration at boot

```ts
import * as Sentry from "@sentry/nextjs";
import pino from "pino";
import { configurePipeline } from "@rello-platform/pipeline";

const logger = pino({ name: "rello" });
configurePipeline({ sentry: Sentry, logger });
```

In Express services (Milo-Engine), use `@sentry/node` and the bootstrap logger. In Next.js apps, configure once in `instrumentation.ts` (or wherever the Sentry SDK is imported).

If you skip `configurePipeline()`, the wrapper falls back to `console.warn` for info-level lines and `console.error` for errors. Sentry calls are no-ops.

### Wrapping a stage

```ts
import { runStage } from "@rello-platform/pipeline";

const result = await runStage(
  "nurture.compose",
  {
    tenantId,
    hashedLeadId, // hash IDs caller-side (SHA-256 first 8) — see below
    framework: decision.framework,
  },
  async () => {
    return await composer.assemble(decision);
  },
);
```

The wrapper returns whatever the inner fn resolves to. Errors thrown inside the fn propagate normally after capture.

### Hashing convention

`runStage` accepts `ctx` as-given and does not hash anything. PII keys (email, phone, name, etc.) are scrubbed by `@rello-platform/sentry-init`'s `beforeSend` hook before the breadcrumb leaves the process. Identifiers that aren't PII per se (leadId, tenantId, enrollmentId, sendIdempotencyKey) MUST be hashed by the caller before being passed in `ctx`:

```ts
import { createHash } from "crypto";

const hashedLeadId = createHash("sha256").update(leadId).digest("hex").slice(0, 8);
```

Why caller-side: the wrapper has no opinion on which fields are sensitive in any given call. Forcing a hash sanitizer inside the wrapper would either over-redact (breaking debugging) or under-redact (leaking IDs). Caller knows the schema; caller hashes.

### EventStore sink (v0.2.0+)

For consumers who want every stage emission persisted to a queryable backing store (e.g., a Postgres `PipelineEvent` table), pass an `eventStore` in `configurePipeline`:

```ts
import { configurePipeline, type EventStoreLike, type PipelineEventRecord } from "@rello-platform/pipeline";

const myEventStore: EventStoreLike = {
  writeEvent(record: PipelineEventRecord): void {
    // Caller-defined: write `record` to your backing store.
    // Fire-and-forget: if your write is async, discard the promise.
    // Telemetry breakage must never break the wrapped fn — catch + log internally.
  },
};

configurePipeline({ sentry, logger, eventStore: myEventStore });
```

`runStage` will invoke `writeEvent` 1-2 times per wrapped stage:
- ONE start emit at entry
- ONE complete emit at success — OR ONE error emit at throw (not both)

Each call is wrapped in a try/catch internally; eventStore errors are silently swallowed. Implement your own logging at the consumer if you want to surface write failures.

## Stage names

Use a dotted-namespace lowercase form: `<phase>.<sub-stage>`. Examples:

- `nurture.send.empty_agent_path`
- `nurture.compose`
- `nurture.deliver`
- `intake.dedup`
- `intake.score`
- `signal.route`

The form is convention-only in v0.1.0. NA-013 Phase 2 Step 4 will introduce a canonical `type StageName` union to enforce naming.

## Environment variables

None. The package itself reads no env. Sentry/logger configuration is via `configurePipeline()`.

## Verification

After migrating a stage, confirm:

1. `npx tsc --noEmit` passes.
2. The migrated stage emits `pipeline_stage_start` and `pipeline_stage_complete` lines in Railway logs (or your equivalent log sink).
3. If Sentry is active, the breadcrumb appears in the Sentry dashboard for the next captured event.
4. Errors thrown inside the wrapped fn surface as before — caller-side `try/catch` semantics are unchanged.

## Not in scope (v0.1.0)

- **Stage-name enforcement.** The string `name` parameter is not type-checked against a registry. Phase 2 Step 4 will add either a TypeScript brand type or an ESLint rule.
- **BetterStack alerting.** Out of scope — this package emits the structured-log shape that BetterStack ingests, but configuration of the alert lives in BetterStack itself.
- **Cross-process spans.** `runStage` is not an OpenTelemetry span. If we need cross-process correlation later, an OTel adapter can sit alongside this package without changing the wrapper API.
