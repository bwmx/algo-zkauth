// Read-only rejection checks for acceptance evidence. A confirmed action's
// proof, signed plan and signature are public, so its group can be rebuilt and
// simulated: a replay must fail the wallet's nonce check, and the same proof
// aimed at another identity's wallet must fail its owner check. Nothing is
// submitted and no key is held: the sponsor's payment carries an empty
// signature, which simulation allows, while the verifier LogicSig runs for real.
// The wallet also checks the session window, so run these while the action's
// session is still open (at most ten minutes).
import { randomUUID } from "node:crypto";
import { makeEmptyTransactionSigner, microAlgos } from "./deps.ts";
import { ChainError, GROUP_FEE_MICROALGOS, type OpenedChain } from "./index.ts";
import type { AppDeployment, ProviderDeployment } from "./types.ts";
import type { ActionPlan, ProofResult } from "../../protocol/src/types.ts";

type Deployments = { app: AppDeployment; provider: ProviderDeployment };
type Confirmed = { proof: ProofResult; plan: ActionPlan; signature: Uint8Array; sponsor: string };
export type SimulatedRejection = { rejected: boolean; assertion: string; message?: string };

// A rejection is attributed to an assertion by its text or its program counter.
const rejectedBy = (message: string, spec: any, assertion: string) => {
  const pcs: number[] = spec.sourceInfo?.approval.sourceInfo.filter((s: any) => s.errorMessage === assertion).flatMap((s: any) => s.pc) ?? [];
  return message.includes(assertion) || pcs.some(pc => new RegExp(`pc[= :]+${pc}(?:\\D|$)`).test(message));
};

const simulate = async (chain: OpenedChain, group: any, assertion: string): Promise<SimulatedRejection> => {
  let message: string;
  try {
    const result = await (await group.composer()).simulate({ allowEmptySignatures: true, allowUnnamedResources: true });
    message = result.simulateResponse?.txnGroups?.[0]?.failureMessage ?? "";
    if (!message) return { rejected: false, assertion };
  } catch (error) { message = String((error as Error)?.message ?? error); }
  const rejected = rejectedBy(message, chain.internal.WALLET_SPEC, assertion);
  return { rejected, assertion, ...(rejected ? {} : { message: message.slice(0, 300) }) };
};

// The sponsor only pays fees here; simulation accepts its empty signature.
const sponsorFor = (chain: OpenedChain, address: string) => chain.internal.use({ addr: address, signer: makeEmptyTransactionSigner() } as any);

/** Simulates resubmitting a confirmed execution: the wallet must reject it at its nonce check. */
export async function simulateReplay(chain: OpenedChain, { app, provider }: Deployments, o: Confirmed): Promise<SimulatedRejection> {
  if (o.plan.operation === "0") throw new ChainError("rejected", "Replay applies to wallet executions, not enrollment");
  const wallets = chain.wallets(app, provider);
  const { group } = await wallets.build(o.proof, o.plan, o.signature, sponsorFor(chain, o.sponsor));
  return simulate(chain, group, "Wrong action nonce");
}

/** Simulates using one identity's proof and signature at another identity's wallet: it must reject it at its owner check. */
export async function simulateIsolation(chain: OpenedChain, { app, provider }: Deployments, o: Confirmed & { otherWalletId: string }): Promise<SimulatedRejection> {
  const { algorand, walletFactory } = chain.internal;
  const wallets = chain.wallets(app, provider);
  const sponsor = sponsorFor(chain, o.sponsor);
  const ctx = await wallets.proofContext(o.proof);
  const other = walletFactory.getAppClientById({ appId: BigInt(o.otherWalletId) });
  const state = await other.state.global.getAll();
  if (Buffer.from(state.owner!.asByteArray()!).equals(ctx.owner)) throw new ChainError("rejected", "Isolation needs another identity's wallet");
  const g = other.newGroup();
  await ctx.verifier.verificationParams({ proof: ctx.proof, signals: ctx.signals, composer: g, paramsCallback: async ({ lsigParams, args }: any) => {
    g.execute({ ...lsigParams, args: { ...args, operation: 1n, recipient: sponsor, assetId: 0n, amount: 10_000n, nonce: BigInt(state.nonce ?? 0n), signature: o.signature }, appReferences: [wallets.keysAppId], accountReferences: [sponsor], boxReferences: [{ appId: wallets.keysAppId, name: Buffer.concat([Buffer.from("gk:"), ctx.keyHash]) }] });
    g.addTransaction(await algorand.createTransaction.payment({ sender: sponsor, receiver: sponsor, amount: microAlgos(0), staticFee: microAlgos(GROUP_FEE_MICROALGOS), note: `${chain.internal.notePrefix}-isolation-${randomUUID()}` }));
  } } as any);
  return simulate(chain, g, "Wrong owner");
}
