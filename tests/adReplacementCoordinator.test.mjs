import assert from "node:assert/strict";
import test from "node:test";
import {
  AdReplacementBackoffError,
  AdReplacementCoordinator,
  handleDetectedAd,
} from "../src/page/adReplacementCoordinator.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCoordinator(overrides = {}) {
  return new AdReplacementCoordinator({
    maxAttempts: 2,
    retryDelayMs: 250,
    failureBackoffMs: 2_000,
    ...overrides,
  });
}

test("shares one replacement workflow for concurrent channel detections", async () => {
  const pending = deferred();
  const coordinator = createCoordinator();
  let calls = 0;
  const operation = () => {
    calls += 1;
    return pending.promise;
  };

  const first = coordinator.run("danxpath", operation);
  const second = coordinator.run("danxpath", operation);
  assert.equal(calls, 1);

  pending.resolve("replacement");
  assert.deepEqual(await Promise.all([first, second]), [
    "replacement",
    "replacement",
  ]);
});

test("retries a failed replacement once after the configured delay", async () => {
  const delays = [];
  const failures = [];
  const coordinator = createCoordinator({
    sleep: async delayMs => delays.push(delayMs),
    onAttemptFailure: (error, attempt) => failures.push({ error, attempt }),
  });
  let calls = 0;

  const result = await coordinator.run("danxpath", async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient failure");
    return "replacement";
  });

  assert.equal(result, "replacement");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].attempt, 1);
});

test("backs off after all replacement attempts fail", async () => {
  let now = 1_000;
  let calls = 0;
  const coordinator = createCoordinator({
    now: () => now,
    sleep: async () => {},
  });
  const fail = async () => {
    calls += 1;
    throw new Error("unavailable");
  };

  await assert.rejects(coordinator.run("danxpath", fail), /unavailable/);
  assert.equal(calls, 2);
  await assert.rejects(
    coordinator.run("danxpath", fail),
    AdReplacementBackoffError
  );
  assert.equal(calls, 2);

  now += 2_000;
  await assert.rejects(coordinator.run("danxpath", fail), /unavailable/);
  assert.equal(calls, 4);
});

test("cancels an ad response when replacement fails", async () => {
  const coordinator = createCoordinator({ sleep: async () => {} });
  const cancelled = new Error("cancelled");
  let failure;

  await assert.rejects(
    handleDetectedAd({
      coordinator,
      key: "danxpath",
      replace: async () => {
        throw new Error("replacement failed");
      },
      onReplacement: () => assert.fail("replacement must not succeed"),
      onFailure: error => {
        failure = error;
      },
      cancelRequest: () => {
        throw cancelled;
      },
    }),
    error => error === cancelled
  );
  assert.match(failure.message, /replacement failed/);
});

test("returns a successful replacement without cancelling the response", async () => {
  const coordinator = createCoordinator();
  let cancelled = false;

  const replacement = await handleDetectedAd({
    coordinator,
    key: "danxpath",
    replace: async () => "replacement",
    onReplacement: () => {},
    onFailure: error => assert.fail(`replacement failed: ${error}`),
    cancelRequest: () => {
      cancelled = true;
      throw new Error("cancelled");
    },
  });

  assert.equal(replacement, "replacement");
  assert.equal(cancelled, false);
});
