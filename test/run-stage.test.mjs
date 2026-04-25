// Tests for @rello-platform/pipeline's runStage().
//
// Uses Node's built-in node:test runner — zero test-framework deps. Mirrors
// @rello-platform/sentry-init's "no runtime deps, minimal devDeps" stance.
//
// Tests run against the compiled dist/ output. The npm test script runs
// `npm run build` first, then `node --test`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  configurePipeline,
  runStage,
  _resetPipelineForTests,
} from "../dist/index.js";

// -------------------------------------------------------------------------
// Mock helpers
// -------------------------------------------------------------------------

function createMockSentry() {
  const breadcrumbs = [];
  const exceptions = [];
  return {
    breadcrumbs,
    exceptions,
    addBreadcrumb(b) {
      breadcrumbs.push(b);
    },
    captureException(err, ctx) {
      exceptions.push({ err, ctx });
    },
  };
}

function createMockLogger() {
  const lines = [];
  return {
    lines,
    info(obj, msg) {
      lines.push({ level: "info", obj, msg });
    },
    error(obj, msg) {
      lines.push({ level: "error", obj, msg });
    },
  };
}

// -------------------------------------------------------------------------
// Cases — covers the 5 invariants Kelly named, plus 3 reinforcing tests
// -------------------------------------------------------------------------

test("runStage returns the wrapped fn's resolved value", async () => {
  _resetPipelineForTests();
  const result = await runStage("test.success", {}, async () => 42);
  assert.equal(result, 42);
});

test("runStage re-throws the original error preserved (referential equality)", async () => {
  _resetPipelineForTests();
  const original = new Error("boom");
  await assert.rejects(
    runStage("test.throw", {}, async () => {
      throw original;
    }),
    (err) => err === original,
  );
});

test("runStage emits Sentry breadcrumb on entry and exit (success path)", async () => {
  _resetPipelineForTests();
  const sentry = createMockSentry();
  configurePipeline({ sentry });

  await runStage("test.crumb", { tenantId: "t1" }, async () => "ok");

  assert.equal(sentry.breadcrumbs.length, 2);
  assert.equal(sentry.breadcrumbs[0].category, "pipeline");
  assert.equal(sentry.breadcrumbs[0].message, "test.crumb");
  assert.equal(sentry.breadcrumbs[0].level, "info");
  assert.deepEqual(sentry.breadcrumbs[0].data, { tenantId: "t1" });

  assert.equal(sentry.breadcrumbs[1].message, "test.crumb.complete");
  assert.equal(typeof sentry.breadcrumbs[1].data.durationMs, "number");
  assert.equal(sentry.breadcrumbs[1].data.tenantId, "t1");
});

test("runStage calls Sentry.captureException on throw with stage tag + ctx extras", async () => {
  _resetPipelineForTests();
  const sentry = createMockSentry();
  configurePipeline({ sentry });

  const original = new Error("kaboom");
  await assert.rejects(
    runStage(
      "test.fail",
      { tenantId: "t2", hashedLeadId: "h1" },
      async () => {
        throw original;
      },
    ),
    (err) => err === original,
  );

  assert.equal(sentry.exceptions.length, 1);
  assert.equal(sentry.exceptions[0].err, original);
  assert.equal(sentry.exceptions[0].ctx.tags.stage, "test.fail");
  assert.equal(sentry.exceptions[0].ctx.extra.tenantId, "t2");
  assert.equal(sentry.exceptions[0].ctx.extra.hashedLeadId, "h1");
  assert.equal(typeof sentry.exceptions[0].ctx.extra.durationMs, "number");
});

test("runStage does not throw if Sentry is undefined (dormant-safe)", async () => {
  _resetPipelineForTests();
  // No configurePipeline call — Sentry is undefined

  const result = await runStage("test.dormant", { tenantId: "t3" }, async () => 99);
  assert.equal(result, 99);

  // Throw path also works without Sentry
  await assert.rejects(
    runStage("test.dormant.throw", {}, async () => {
      throw new Error("nope");
    }),
    /nope/,
  );
});

test("runStage routes structured logs through configured logger (success)", async () => {
  _resetPipelineForTests();
  const logger = createMockLogger();
  configurePipeline({ logger });

  await runStage("test.log", { foo: "bar" }, async () => "ok");

  // 2 info lines: start + complete
  assert.equal(logger.lines.length, 2);
  assert.equal(logger.lines[0].level, "info");
  assert.equal(logger.lines[0].obj.action, "pipeline_stage_start");
  assert.equal(logger.lines[0].obj.stage, "test.log");
  assert.equal(logger.lines[0].obj.foo, "bar");

  assert.equal(logger.lines[1].obj.action, "pipeline_stage_complete");
  assert.equal(typeof logger.lines[1].obj.durationMs, "number");
});

test("runStage emits structured error log on throw", async () => {
  _resetPipelineForTests();
  const logger = createMockLogger();
  configurePipeline({ logger });

  await assert.rejects(
    runStage("test.err.log", { x: 1 }, async () => {
      throw new Error("crash");
    }),
    /crash/,
  );

  const errorLines = logger.lines.filter((l) => l.level === "error");
  assert.equal(errorLines.length, 1);
  assert.equal(errorLines[0].obj.action, "pipeline_stage_error");
  assert.equal(errorLines[0].obj.stage, "test.err.log");
  assert.equal(errorLines[0].obj.errorMessage, "crash");
  assert.equal(errorLines[0].obj.x, 1);
});

test("runStage swallows Sentry SDK breakage (telemetry never breaks the stage)", async () => {
  _resetPipelineForTests();
  const brokenSentry = {
    addBreadcrumb() {
      throw new Error("sentry SDK exploded");
    },
    captureException() {
      throw new Error("sentry SDK exploded");
    },
  };
  configurePipeline({ sentry: brokenSentry });

  const result = await runStage("test.broken_sentry", {}, async () => "still works");
  assert.equal(result, "still works");

  // Throw path also survives a broken captureException
  await assert.rejects(
    runStage("test.broken_sentry.throw", {}, async () => {
      throw new Error("real-error");
    }),
    /real-error/,
  );
});
