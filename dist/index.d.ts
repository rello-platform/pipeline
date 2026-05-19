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
export declare function configurePipeline(deps: PipelineDeps): void;
/**
 * Reset module-level state. Exposed for tests + diagnostic tooling — callers
 * should never need this in normal operation.
 */
export declare function _resetPipelineForTests(): void;
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
export declare function runStage<T>(name: string, ctx: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=index.d.ts.map