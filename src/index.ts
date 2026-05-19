/**
 * @rello-platform/pipeline
 *
 * Pipeline-stage instrumentation wrapper. Every stage boundary calls runStage()
 * — the wrapper emits a structured log + Sentry breadcrumb on entry and exit,
 * captures exceptions on throw with stage tags, and stays out of the way
 * otherwise.
 *
 * NA-013 Phase 2: this is the structural-wrapper foundation that replaces
 * "manually instrument 76 stages." See README.md for usage.
 */

// ---------------------------------------------------------------------------
// Duck-typed dependency interfaces
//
// The package has zero runtime deps. Consumers bring their own Sentry SDK and
// logger and pass them via configurePipeline() at boot. Same precedent as
// @rello-platform/sentry-init's initSentry(Sentry, opts) pattern.
// ---------------------------------------------------------------------------

export interface SentryBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  level?: "debug" | "info" | "warning" | "error" | "fatal";
}

export interface SentryCaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface SentryLike {
  addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
  captureException(error: unknown, captureContext?: SentryCaptureContext): unknown;
}

export interface LoggerLike {
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface PipelineEventRecord {
  occurredAt: Date;
  action: "pipeline_stage_start" | "pipeline_stage_complete" | "pipeline_stage_error";
  stage: string;
  durationMs?: number;
  errorMessage?: string;
  ctx: Record<string, unknown>;
}

export interface EventStoreLike {
  writeEvent(record: PipelineEventRecord): void;
}

export interface PipelineDeps {
  sentry?: SentryLike;
  logger?: LoggerLike;
  eventStore?: EventStoreLike;
}

// ---------------------------------------------------------------------------
// Module-level configuration
//
// Set once at boot. Subsequent runStage calls read these refs. If
// configurePipeline never runs (or is called with no logger), the wrapper
// falls through to a console-based fallback that complies with the platform
// "no console.log in prod" rule (info → console.warn, error → console.error).
// ---------------------------------------------------------------------------

let _sentry: SentryLike | undefined;
let _logger: LoggerLike | undefined;
let _eventStore: EventStoreLike | undefined;

export function configurePipeline(deps: PipelineDeps): void {
  _sentry = deps.sentry;
  _logger = deps.logger;
  _eventStore = deps.eventStore;
}

/**
 * Reset module-level state. Exposed for tests + diagnostic tooling — callers
 * should never need this in normal operation.
 */
export function _resetPipelineForTests(): void {
  _sentry = undefined;
  _logger = undefined;
  _eventStore = undefined;
}

// ---------------------------------------------------------------------------
// Console fallback adapter
//
// When no logger is configured, route info-level lines to console.warn and
// error-level lines to console.error. Avoid console.log per platform CLAUDE.md.
// ---------------------------------------------------------------------------

const _consoleAdapter: LoggerLike = {
  info(obj, msg) {
    console.warn(msg ?? "[pipeline]", obj);
  },
  error(obj, msg) {
    console.error(msg ?? "[pipeline]", obj);
  },
};

// ---------------------------------------------------------------------------
// runStage — the public wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a pipeline stage with structured-log + Sentry-breadcrumb instrumentation.
 *
 * Behavior:
 * - Entry: emits `pipeline_stage_start` log line and a Sentry breadcrumb tagged
 *   `pipeline.<name>` at info level with `ctx` as breadcrumb data.
 * - Success: emits `pipeline_stage_complete` log line and a `<name>.complete`
 *   breadcrumb with `durationMs`. Returns the inner fn's resolved value.
 * - Throw: calls `Sentry.captureException(error, { tags: { stage: name }, extra:
 *   { ...ctx, durationMs } })`, emits `pipeline_stage_error` log line, and
 *   re-throws the original error so callers see normal error propagation.
 *
 * `ctx` is passed through as-given. Hash sensitive identifiers (leadId,
 * tenantId, enrollmentId, sendIdempotencyKey) caller-side before passing
 * — see README's Hashing convention section.
 *
 * Sentry calls are wrapped in try/catch internally. SDK breakage never breaks
 * the wrapped fn.
 */
export async function runStage<T>(
  name: string,
  ctx: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const logger = _logger ?? _consoleAdapter;

  try {
    _sentry?.addBreadcrumb({
      category: "pipeline",
      message: name,
      data: ctx,
      level: "info",
    });
  } catch {
    // Swallow Sentry SDK errors — telemetry breakage never breaks the stage
  }
  try {
    _eventStore?.writeEvent({
      occurredAt: new Date(start),
      action: "pipeline_stage_start",
      stage: name,
      ctx,
    });
  } catch {
    // Swallow eventStore errors — telemetry breakage never breaks the stage
  }
  logger.info(
    { ...ctx, action: "pipeline_stage_start", stage: name },
    `pipeline_stage_start ${name}`,
  );

  try {
    const result = await fn();
    const durationMs = Date.now() - start;

    try {
      _sentry?.addBreadcrumb({
        category: "pipeline",
        message: `${name}.complete`,
        data: { ...ctx, durationMs },
        level: "info",
      });
    } catch {
      // Swallow
    }
    try {
      _eventStore?.writeEvent({
        occurredAt: new Date(),
        action: "pipeline_stage_complete",
        stage: name,
        durationMs,
        ctx,
      });
    } catch {
      // Swallow
    }
    logger.info(
      { ...ctx, action: "pipeline_stage_complete", stage: name, durationMs },
      `pipeline_stage_complete ${name}`,
    );

    return result;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);

    try {
      _sentry?.captureException(error, {
        tags: { stage: name },
        extra: { ...ctx, durationMs },
      });
    } catch {
      // Swallow
    }
    try {
      _eventStore?.writeEvent({
        occurredAt: new Date(),
        action: "pipeline_stage_error",
        stage: name,
        durationMs,
        errorMessage,
        ctx,
      });
    } catch {
      // Swallow
    }
    logger.error(
      {
        ...ctx,
        action: "pipeline_stage_error",
        stage: name,
        durationMs,
        errorMessage,
      },
      `pipeline_stage_error ${name}`,
    );

    throw error;
  }
}
