// The hosted shared wallet in a real browser: two dApps on different origins
// connect to one wallet window origin and get the same wallet. The user signs in,
// creates the backup and approves every request inside the wallet window.
import { test, expect, type Page } from "@playwright/test";
import algosdk from "algosdk";

const API = process.env.E2E_API_URL ?? "http://localhost:8780";
const DEMO = process.env.E2E_DEMO_URL ?? "http://localhost:8765";
const EXAMPLE = process.env.E2E_EXAMPLE_URL ?? "http://localhost:8775";

/** Signs in inside the wallet window: its own login window opens on the dev issuer. */
async function signInToWallet(wallet: Page, subject: string) {
  const login = wallet.waitForEvent("popup");
  await wallet.getByTestId("sign-in").click();
  const issuer = await login;
  await issuer.locator('input[name="custom_subject"]').fill(subject);
  await issuer.getByRole("button", { name: "Sign in with this subject" }).click();
  await expect(wallet.getByTestId("subject")).toHaveText(subject, { timeout: 30_000 });
}

test("one shared wallet for two dApps, with every request approved in the wallet", async ({ context }) => {
  const subject = `pw-hosted-${Date.now()}`;
  const recipient = algosdk.generateAccount().addr.toString();

  // dApp 1 (the demo) connects; the wallet window asks to connect.
  const demo = await context.newPage();
  await demo.goto(DEMO);
  const opened = demo.waitForEvent("popup");
  await demo.getByTestId("connect-wallet").click();
  const wallet = await opened;
  await expect(wallet.getByTestId("request-origin")).toHaveText(DEMO.replace(/\/$/, ""));
  await signInToWallet(wallet, subject);
  await wallet.getByTestId("remember").check();
  const download = wallet.waitForEvent("download");
  await wallet.getByTestId("create-backup").click();
  await download;
  await wallet.getByTestId("approve").click();                      // connect; the wallet enrolls itself
  const shared = demo.getByTestId("shared-address");
  await expect(shared).toBeVisible({ timeout: 60_000 });
  const address = (await shared.textContent())!;

  // Fund it from the LocalNet faucet, then a transfer the user approves in the wallet window.
  const funded = await fetch(`${API}/v1/apps/demo/dev/fund`, { method: "POST", headers: { Origin: DEMO, "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
  expect(funded.status).toBe(200);
  await demo.getByTestId("shared-to").fill(recipient);
  await demo.getByTestId("shared-send").click();
  await expect(wallet.getByTestId("request")).toContainText("asks you to send 0.10 ALGO");
  await expect(wallet.getByTestId("request")).toContainText(recipient);
  await wallet.getByTestId("approve").click();
  await expect(demo.getByTestId("tx-id")).toHaveCount(1, { timeout: 60_000 });

  // A rejected request reaches the dApp as an error and moves nothing.
  await demo.getByTestId("shared-send").click();
  await wallet.getByTestId("reject").click();
  await expect(demo.getByTestId("shared-wallet").getByRole("alert")).toContainText("Declined");

  // dApp 2 (the example, another origin) connects to the same wallet: sign in, and the remembered backup opens it.
  const example = await context.newPage();
  await example.goto(`${EXAMPLE}/hosted.html`);
  const opened2 = example.waitForEvent("popup");
  await example.getByRole("button", { name: "Connect wallet" }).click();
  const wallet2 = await opened2;
  await expect(wallet2.getByTestId("request-origin")).toHaveText(EXAMPLE.replace(/\/$/, ""));
  await signInToWallet(wallet2, subject);
  await expect(wallet2.getByTestId("approve")).toBeEnabled({ timeout: 30_000 });
  await wallet2.getByTestId("approve").click();
  await expect(example.locator("#wallet")).toHaveText(`Wallet ${address}.`, { timeout: 60_000 });
});
