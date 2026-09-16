// Tests for @rello-platform/pipeline's eventStore sink (v0.2.0+).
//
// Uses Node's built-in node:test runner — zero test-framework deps. Mirrors
// run-stage.test.mjs's "no runtime deps, minimal devDeps" stance.
//
// Tests run against the compiled dist/ output. The npm test script runs
// `npm run compile` first, then `node --test`.

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

function createMockEventStore() {
  const records = [];
  return {
    records,
    writeEvent(record) {
      records.push(record);
    },
  };
}

function createThrowingEventStore() {
  return {
    writeEvent() {
      throw new Error("eventStore exploded");
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
// Cases — covers the 6 invariants from POBS-PHASE-1-PR-1 dispatch §Step 4
// -------------------------------------------------------------------------

test("eventStore receives start emit when fn resolves", async () => {
  _resetPipelineForTests();
  const eventStore = createMockEventStore();
  configurePipeline({ eventStore });

  await runStage("test.stage", { tenantId: "t1" }, async () => "ok");

  assert.equal(eventStore.records.length, 2);
  const start = eventStore.records[0];
  assert.equal(start.action, "pipeline_stage_start");
  assert.equal(start.stage, "test.stage");
  assert.deepEqual(start.ctx, { tenantId: "t1" });
  assert.ok(start.occurredAt instanceof Date);
  assert.equal(start.durationMs, undefined);
  assert.equal(start.errorMessage, undefined);
});

test("eventStore receives complete emit when fn resolves", async () => {
  _resetPipelineForTests();
  const eventStore = createMockEventStore();
  configurePipeline({ eventStore });

  await runStage("test.stage", { tenantId: "t1" }, async () => "ok");

  assert.equal(eventStore.records.length, 2);
  const complete = eventStore.records[1];
  assert.equal(complete.action, "pipeline_stage_complete");
  assert.equal(complete.stage, "test.stage");
  assert.deepEqual(complete.ctx, { tenantId: "t1" });
  assert.equal(typeof complete.durationMs, "number");
  assert.ok(complete.occurredAt instanceof Date);
  assert.equal(complete.errorMessage, undefined);
});

test("eventStore receives error emit when fn throws and original error re-throws", async () => {
  _resetPipelineForTests();
  const eventStore = createMockEventStore();
  configurePipeline({ eventStore });

  const original = new Error("boom");
  await assert.rejects(
    runStage("test.stage", { tenantId: "t2" }, async () => {
      throw original;
    }),
    (err) => err === original,
  );

  assert.equal(eventStore.records.length, 2);
  const start = eventStore.records[0];
  assert.equal(start.action, "pipeline_stage_start");

  const errorRecord = eventStore.records[1];
  assert.equal(errorRecord.action, "pipeline_stage_error");
  assert.equal(errorRecord.stage, "test.stage");
  assert.equal(errorRecord.errorMessage, "boom");
  assert.equal(typeof errorRecord.durationMs, "number");
  assert.deepEqual(errorRecord.ctx, { tenantId: "t2" });
  assert.ok(errorRecord.occurredAt instanceof Date);
});

test("eventStore throw does NOT break wrapped fn (success path)", async () => {
  _resetPipelineForTests();
  configurePipeline({ eventStore: createThrowingEventStore() });

  const result = await runStage("test.stage", {}, async () => 42);
  assert.equal(result, 42);
});

test("eventStore throw does NOT break wrapped fn (error path — original error re-throws)", async () => {
  _resetPipelineForTests();
  configurePipeline({ eventStore: createThrowingEventStore() });

  const original = new Error("inner");
  await assert.rejects(
    runStage("test.stage", {}, async () => {
      throw original;
    }),
    (err) => err === original,
  );
});

test("eventStore absent (configurePipeline without eventStore field) — wrapped fn behaves byte-identically", async () => {
  _resetPipelineForTests();
  const logger = createMockLogger();
  configurePipeline({ logger }); // no eventStore field

  const result = await runStage("test.stage", { foo: "bar" }, async () => "ok");
  assert.equal(result, "ok");

  // Logger still receives both lines (byte-compat with v0.1.1)
  assert.equal(logger.lines.length, 2);
  assert.equal(logger.lines[0].obj.action, "pipeline_stage_start");
  assert.equal(logger.lines[1].obj.action, "pipeline_stage_complete");
});

test("_resetPipelineForTests() clears _eventStore", async () => {
  _resetPipelineForTests();
  const eventStore = createMockEventStore();
  configurePipeline({ eventStore });

  // Reset BEFORE runStage — eventStore should be cleared
  _resetPipelineForTests();

  await runStage("test.stage", {}, async () => "ok");
  assert.equal(eventStore.records.length, 0);
});
