// Algorand address encoding without algosdk (which would add ~270 kB to a dApp's bundle for three
// functions). Checked against algosdk in test/address.test.ts.
const M = (1n << 64n) - 1n;
const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M;

/** The 80 SHA-512 round constants: the first 64 fraction bits of the cube roots of the first 80 primes. */
const K: bigint[] = (() => {
  const primes: bigint[] = [];
  for (let n = 2n; primes.length < 80; n++) if (primes.every((p) => n % p !== 0n)) primes.push(n);
  const icbrt = (value: bigint) => {
    let x = 1n << (BigInt(value.toString(2).length) / 3n + 1n);
    for (;;) { const y = (2n * x + value / (x * x)) / 3n; if (y >= x) return x; x = y; }
  };
  return primes.map((p) => icbrt(p << 192n) & M);
})();

// SHA-512/256 initial hash value (FIPS 180-4).
const IV = [0x22312194FC2BF72Cn, 0x9F555FA3C84C64C2n, 0x2393B86B6F53B151n, 0x963877195940EABDn, 0x96283EE2A88EFFE3n, 0xBE5E1E2553863992n, 0x2B0199FC2C85B8AAn, 0x0EB72DDC81C52CA2n];

export function sha512_256(data: Uint8Array): Uint8Array {
  const total = ((data.length + 17 + 127) >> 7) << 7;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setBigUint64(total - 8, BigInt(data.length) * 8n);
  const h = [...IV];
  const w = new Array<bigint>(80);
  for (let offset = 0; offset < total; offset += 128) {
    for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(offset + i * 8);
    for (let i = 16; i < 80; i++) {
      const w15 = w[i - 15]!, w2 = w[i - 2]!;
      const s0 = rotr(w15, 1n) ^ rotr(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr(w2, 19n) ^ rotr(w2, 61n) ^ (w2 >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & M;
    }
    let [a, b, c, d, e, f, g, hh] = h as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    for (let i = 0; i < 80; i++) {
      const t1 = (hh + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + ((e & f) ^ (~e & M & g)) + K[i]! + w[i]!) & M;
      const t2 = ((rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M;
      hh = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i]! + v) & M; });
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, h[i]!);
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

export function encodeAddress(publicKey: Uint8Array): string {
  const checksum = sha512_256(publicKey).subarray(28);
  return base32(Uint8Array.from([...publicKey, ...checksum]));
}

/** Throws unless `address` is a well-formed Algorand address with a valid checksum. */
export function decodeAddress(address: string): { publicKey: Uint8Array } {
  if (typeof address !== "string" || !/^[A-Z2-7]{58}$/.test(address)) throw new Error("Invalid Algorand address");
  const raw = unbase32(address);
  const publicKey = raw.slice(0, 32);
  const checksum = sha512_256(publicKey).subarray(28);
  if (!checksum.every((byte, i) => byte === raw[32 + i])) throw new Error("Invalid Algorand address checksum");
  return { publicKey };
}

export function isValidAddress(address: string): boolean {
  try { decodeAddress(address); return true; } catch { return false; }
}

/** The address of an application account (the wallet's address). */
export function getApplicationAddress(appId: bigint): string {
  const prefix = new TextEncoder().encode("appID");
  const data = new Uint8Array(prefix.length + 8);
  data.set(prefix);
  new DataView(data.buffer).setBigUint64(prefix.length, appId);
  return encodeAddress(sha512_256(data));
}
