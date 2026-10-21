import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { busyHosts } from "./demo-port.mjs";

test("reports only the addresses that have a listener on the port", async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.deepEqual(await busyHosts(port, ["127.0.0.1"]), ["127.0.0.1"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(await busyHosts(port, ["127.0.0.1"]), []);
});
