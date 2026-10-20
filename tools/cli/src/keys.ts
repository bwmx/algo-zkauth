// zkauth keys sync|list and zkauth guardian status|revoke|cancel-renewal|pause.
import { listProviderDeployments, readProviderDeployment, requireRole } from "../../../packages/config/src/index.ts";
import type { ProviderDeployment } from "../../../packages/chain/src/types.ts";
import { fetchLiveJwks, guardianReport, type KeyReport } from "../../../services/keysync/src/sync.ts";
import { CliError, UsageError, isoTime, parse, withChain, type Ctx } from "./lib.ts";

export const KEYS_HELP = `Usage: zkauth keys sync [provider]
       zkauth keys list [provider]

sync  One keysync pass: fetch the provider's JWKS and register new keys, renew
      keys near the end of their approval and seal an unsealed bootstrap.
      Signs with ZKAUTH_ADMIN_MNEMONIC. New keys take effect after the 24-hour
      approval delay once the registry is sealed.
list  The registry's keys and their validity. Needs no secrets.

Without a provider, every deployed provider is used. On LocalNet with
ZKAUTH_DEV_ISSUER_URL set, the JWKS comes from the dev issuer.`;

export const GUARDIAN_HELP = `Usage: zkauth guardian status [provider]
       zkauth guardian revoke <fingerprint> [provider]
       zkauth guardian cancel-renewal <fingerprint> [provider]
       zkauth guardian pause [provider]

status           Lists each key and alerts (exit 1) when a key that is or will
                 become valid is missing from the provider's live JWKS, which is
                 what an approval by a compromised administrator looks like.
                 Needs no secrets, so it suits a cron job.
revoke           Permanently revokes a key.
cancel-renewal   Drops a key's pending extension.
pause            Stops all keys until the administrator resumes.

The actions sign with ZKAUTH_GUARDIAN_MNEMONIC, which must belong to the
guardian recorded for the provider. Fingerprints are base64url SHA-256 of the
RSA modulus, as listed by status. Exit codes: 0 fine, 1 alert, 2 usage or error.`;

function records(ctx: Ctx, ids: string[], single = false): ProviderDeployment[] {
  if (ids.length) {
    return ids.map((id) => {
      const record = readProviderDeployment(ctx.service, id);
      if (!record) throw new CliError(`Provider ${id} is not deployed on ${ctx.service.network}; run zkauth deploy provider ${id}`);
      return record;
    });
  }
  const all = listProviderDeployments(ctx.service);
  if (!all.length) throw new CliError(`No provider deployments on ${ctx.service.network}; run zkauth deploy provider <id>`);
  if (single && all.length > 1) throw new CliError(`Several providers are deployed (${all.map((r) => r.provider).join(", ")}); name one`);
  return all;
}

function describe(key: KeyReport): string {
  const until = `until ${isoTime(key.validUntil)}`;
  const state = key.state === "pending" ? `PENDING, valid from ${isoTime(key.validFrom)}, ${until}`
    : key.state === "lapsed" ? "lapsed, renewal pending"
    : `${key.state}, ${until}`;
  const renewal = key.renewalEffectiveAt ? `; renewal to ${isoTime(key.renewedUntil!)} takes effect ${isoTime(key.renewalEffectiveAt)}` : "";
  return `${key.fingerprint}  ${state}${renewal}${key.inJwks ? "" : "; not in the provider's current JWKS"}`;
}

export async function keys(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "sync" && sub !== "list") throw new UsageError("Usage: zkauth keys sync|list [provider]");
  const { positionals } = parse(rest, { help: { type: "boolean" } });
  if (positionals.length > 1) throw new UsageError(`Usage: zkauth keys ${sub} [provider]`);
  const selected = records(ctx, positionals);
  await withChain(ctx, async (chain) => {
    if (sub === "sync") {
      const administrator = requireRole("admin", ctx.service, ctx.env, ctx.warn);
      for (const record of selected) {
        if (record.administrator !== administrator.addr) throw new CliError(`ZKAUTH_ADMIN_MNEMONIC is not the administrator of the ${record.provider} key registry (${record.administrator})`);
        const jwks = await fetchLiveJwks(record, ctx.service);
        const done = await chain.keys(record).ensureKeys({ jwks, administrator });
        const parts = [`registered ${done.registered.length}`, `renewed ${done.renewed.length}`, done.sealed ? "sealed the bootstrap" : null].filter(Boolean);
        ctx.print(`${record.provider}: ${parts.join(", ")}`);
        for (const change of done.changes) ctx.print(change.kind === "registered"
          ? `  registered ${change.fingerprint}, valid from ${isoTime(change.validFrom)}`
          : `  renewed ${change.fingerprint} to ${isoTime(change.renewedUntil)}, effective ${isoTime(change.renewalEffectiveAt)}`);
      }
      return;
    }
    for (const record of selected) {
      const registry = chain.keys(record);
      const [flags, list, now] = await Promise.all([registry.flags(), registry.list(), chain.time()]);
      ctx.print(`${record.provider} key registry ${record.keyRegistryId}: ${flags.paused ? "PAUSED" : "running"}, bootstrap ${flags.sealed ? "sealed" : "NOT SEALED (keys unusable)"}`);
      if (!list.length) ctx.print("  no keys");
      for (const key of list) {
        const state = key.revoked ? "revoked" : now < BigInt(key.validFrom) ? `pending until ${isoTime(key.validFrom)}` : now < BigInt(key.validUntil) ? "active" : "expired";
        ctx.print(`  ${key.fingerprint}  ${state}, valid ${isoTime(key.validFrom)} to ${isoTime(key.validUntil)}${key.renewalEffectiveAt ? `; renewal to ${isoTime(key.renewedUntil!)} effective ${isoTime(key.renewalEffectiveAt)}` : ""}`);
      }
    }
  });
  return 0;
}

export async function guardian(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!["status", "revoke", "cancel-renewal", "pause"].includes(sub ?? "")) throw new UsageError("Usage: zkauth guardian status|revoke|cancel-renewal|pause ...");
  const { positionals } = parse(rest, { help: { type: "boolean" } });
  const wantsFingerprint = sub === "revoke" || sub === "cancel-renewal";
  const fingerprint = wantsFingerprint ? positionals.shift() : undefined;
  if (wantsFingerprint && !fingerprint) throw new UsageError(`Usage: zkauth guardian ${sub} <fingerprint> [provider]`);
  if (positionals.length > 1) throw new UsageError(`Usage: zkauth guardian ${sub} ${wantsFingerprint ? "<fingerprint> " : ""}[provider]`);

  if (sub === "status") {
    const selected = records(ctx, positionals);
    let alerts = 0;
    await withChain(ctx, async (chain) => {
      for (const record of selected) {
        const jwks = await fetchLiveJwks(record, ctx.service).catch(() => { throw new CliError(`Could not fetch ${record.provider}'s JWKS, so its keys cannot be checked`, 2); });
        const report = await guardianReport(chain, record, jwks);
        ctx.print(`${record.provider} key registry ${record.keyRegistryId}: ${report.flags.paused ? "PAUSED" : "running"}, bootstrap ${report.flags.sealed ? "sealed" : "NOT SEALED (keys unusable)"}, guardian ${record.guardian}`);
        for (const key of report.keys) ctx.print(`${key.alert ? "ALERT " : "      "}${describe(key)}`);
        const count = report.keys.filter((k) => k.alert).length;
        alerts += count;
        if (count) ctx.print(`\n${count} key(s) that are or will become valid are not published by ${record.provider}. If you did not expect this, revoke them or pause the registry before they take effect.`);
      }
    });
    return alerts ? 1 : 0;
  }

  const [record] = records(ctx, positionals, true);
  const signer = requireRole("guardian", ctx.service, ctx.env, ctx.warn);
  if (signer.addr !== record!.guardian) throw new CliError(`ZKAUTH_GUARDIAN_MNEMONIC is not the guardian of the ${record!.provider} key registry (${record!.guardian})`);
  await withChain(ctx, async (chain) => {
    const registry = chain.keys(record!);
    if (sub === "revoke") await registry.revoke({ fingerprint: fingerprint!, signer });
    else if (sub === "cancel-renewal") await registry.cancelRenewal({ fingerprint: fingerprint!, signer });
    else await registry.pause({ signer });
  });
  ctx.print(`${sub} confirmed on ${record!.provider} key registry ${record!.keyRegistryId}`);
  return 0;
}
