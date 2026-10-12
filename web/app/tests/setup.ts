import { webcrypto } from "node:crypto";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no SubtleCrypto; use Node's WebCrypto, as the browser modules expect.
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
afterEach(cleanup);
