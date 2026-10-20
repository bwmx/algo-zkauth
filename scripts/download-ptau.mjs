import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

// Artifact and Blake2b-512 digest are published in iden3/snarkjs's README.
const name = "powersOfTau28_hez_final_22.ptau";
const url = `https://circom.info/${name}`;
const size = 4_831_921_304;
const expected =
  "0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b";
const directory = new URL(
  "../upstream/snarkjs-algorand/circuit/",
  import.meta.url,
);
const target = new URL(name, directory);
const partial = new URL(`${name}.partial`, directory);
const parts = new URL(`${name}.parts/`, directory);
const chunk = 32 * 1024 * 1024;
const count = Math.ceil(size / chunk);
const part = (index) =>
  new URL(`${String(index).padStart(4, "0")}.part`, parts);
const fileSize = (path) => (existsSync(path) ? statSync(path).size : 0);
async function verify(path) {
  if (fileSize(path) !== size) return false;
  const hash = createHash("blake2b512");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex") === expected;
}
if (existsSync(target)) {
  if (!(await verify(target)))
    throw new Error(
      "Existing powers-of-tau artifact does not match its published digest",
    );
  console.log("Powers-of-tau artifact already verified");
} else {
  await mkdir(parts, { recursive: true });
  const prefix = fileSize(partial);
  for (let i = 0; i < count && i * chunk < prefix; i++) {
    const length = Math.min(chunk, prefix - i * chunk);
    if (fileSize(part(i)) === 0)
      await pipeline(
        createReadStream(partial, {
          start: i * chunk,
          end: i * chunk + length - 1,
        }),
        createWriteStream(part(i)),
      );
  }
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < count) {
      const index = next++;
      const wanted = Math.min(chunk, size - index * chunk);
      for (let attempt = 0; fileSize(part(index)) < wanted; attempt++) {
        if (attempt >= 4)
          throw new Error(
            `Range download ${index} failed repeatedly; rerun to resume`,
          );
        const start = index * chunk + fileSize(part(index));
        const end = index * chunk + wanted - 1;
        try {
          const response = await fetch(url, {
            headers: { Range: `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(90_000),
          });
          if (
            response.status !== 206 ||
            response.headers.get("content-range") !==
              `bytes ${start}-${end}/${size}`
          )
            throw new Error("Server returned an incorrect byte range");
          await pipeline(
            Readable.fromWeb(response.body),
            createWriteStream(part(index), { flags: "a" }),
          );
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
      if (fileSize(part(index)) !== wanted)
        throw new Error("Range download has an incorrect size");
      completed++;
      if (completed % 16 === 0 || completed === count)
        console.log(`Downloaded ${completed}/${count} ranges`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const assembled = new URL(`${name}.assembled`, directory);
  const output = createWriteStream(assembled);
  for (let i = 0; i < count; i++) {
    for await (const data of createReadStream(part(i))) {
      if (!output.write(data)) await once(output, "drain");
    }
  }
  await new Promise((resolve, reject) => {
    output.once("error", reject);
    output.end(resolve);
  });
  if (!(await verify(assembled)))
    throw new Error(
      "Downloaded artifact does not match snarkjs's published Blake2b-512 digest",
    );
  await rename(assembled, target);
  await rm(parts, { recursive: true });
  await rm(partial, { force: true });
  console.log(
    "Powers-of-tau artifact verified against the published Blake2b-512 digest",
  );
}
