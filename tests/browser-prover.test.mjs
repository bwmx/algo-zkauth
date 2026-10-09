import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const script = readFileSync(
  new URL("../web/phase3-prover/worker.js", import.meta.url),
  "utf8",
);
function workerContext(response) {
  const events = new Map();
  const messages = [];
  const requests = [];
  const self = {
    addEventListener(name, callback) {
      events.set(name, callback);
    },
    postMessage(data) {
      messages.push(data);
    },
  };
  const context = vm.createContext({
    self,
    Uint8Array,
    Response,
    performance,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response();
    },
  });
  vm.runInContext(script, context);
  return { context, events, messages, requests, self };
}
function streamed(bytes, declaredLength = bytes.length) {
  let position = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (position === bytes.length) return controller.close();
        const count = Math.min(70_001, bytes.length - position);
        controller.enqueue(bytes.subarray(position, position + count));
        position += count;
      },
    }),
    { headers: { "Content-Length": String(declaredLength) } },
  );
}

test("key loader preserves bytes across pinned 4 MiB page boundaries", async () => {
  const bytes = new Uint8Array((1 << 22) + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const { context } = workerContext(() => streamed(bytes));
  const key = await vm.runInContext("loadKey()", context);
  assert.equal(key.type, "bigMem");
  assert.equal(key.data.length, 2);
  assert.equal(key.data[0].length, 1 << 22);
  assert.equal(key.data[1].length, 123);
  assert.deepEqual(key.data[0], bytes.subarray(0, 1 << 22));
  assert.deepEqual(key.data[1], bytes.subarray(1 << 22));
});

test("key loader rejects truncated, excessive and failed resource responses", async () => {
  for (const response of [
    () => streamed(new Uint8Array(13), 14),
    () => streamed(new Uint8Array(13), 12),
    () => new Response("", { status: 404 }),
  ]) {
    const { context } = workerContext(response);
    await assert.rejects(vm.runInContext("loadKey()", context));
  }
});

test("allocation failures report the stage without saving private error data", async () => {
  const { context, events, messages, requests } = workerContext(
    () => new Response("{}"),
  );
  vm.runInContext(
    'source="synthetic"; userAgent="test"; stage="proof";',
    context,
  );
  events.get("error")({
    preventDefault() {},
    error: new RangeError(
      "Array buffer allocation failed; private-witness-marker",
    ),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1).errorCode, "memory-allocation");
  assert.equal(messages.at(-1).stage, "proof");
  assert.equal(messages.at(-1).done, true);
  assert.equal(requests[0].url, "/prover/failure");
  assert.equal(
    JSON.stringify(messages).includes("private-witness-marker"),
    false,
  );
  assert.equal(
    requests[0].options.body.includes("private-witness-marker"),
    false,
  );
});
