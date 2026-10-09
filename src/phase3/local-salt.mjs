import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

// Single-identity local POC storage. Phase 5 provides authenticated recovery,
// but this existing salt is not automatically exported by the isolated browser
// test. The integrated demo separately verifies its own browser backup.
export function localWalletSalt() {
  const dir = new URL("../../.local/", import.meta.url);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = new URL("wallet-salt.bin", dir);
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  const salt = readFileSync(path);
  if (salt.length !== 32)
    throw new Error("Existing local wallet salt has an invalid length");
  chmodSync(path, 0o600);
  return salt;
}
