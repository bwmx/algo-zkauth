// The demo app in a real browser against the compose local stack: sign in through
// the dev issuer's page in a login window, back up, enroll, fund, send ALGO; then
// recover the same wallet in a second browser profile; then a passkey backup.
import { test, expect, type Page } from "@playwright/test";
import algosdk from "algosdk";

const recipient = algosdk.generateAccount().addr.toString();

async function signIn(page: Page, subject: string) {
  await page.goto("/");
  await expect(page.getByText("on localnet")).toBeVisible();
  const popup = page.waitForEvent("popup");
  await page.getByTestId("sign-in").click();
  const login = await popup;
  await login.locator('input[name="custom_subject"]').fill(subject);
  await login.getByRole("button", { name: "Sign in with this subject" }).click();
  await expect(page.getByTestId("subject")).toHaveText(subject, { timeout: 30_000 });
}

async function sendAlgo(page: Page, amount: string) {
  const before = await page.getByTestId("tx-id").count();
  await page.getByTestId("send-to").fill(recipient);
  await page.getByTestId("send-amount").fill(amount);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("tx-id")).toHaveCount(before + 1, { timeout: 60_000 });
  return (await page.getByTestId("tx-id").first().textContent())!;
}

test("one login, two browsers: create, fund, send, then recover the same wallet elsewhere", async ({ browser }, info) => {
  const subject = `pw-${Date.now()}`;

  // Browser 1: a new user.
  const first = await browser.newContext();
  const page = await first.newPage();
  await signIn(page, subject);
  const download = page.waitForEvent("download");
  await page.getByTestId("create-backup").click();
  const file = info.outputPath("backup.json");
  await (await download).saveAs(file);
  const secret = (await page.getByTestId("recovery-secret").textContent())!;
  expect(secret).toMatch(/^ZKR1:/);
  await expect(page.getByTestId("backup-ready")).toBeVisible();

  await page.getByTestId("enroll").click();
  const address = page.getByTestId("wallet-address");
  await expect(address).toBeVisible({ timeout: 60_000 });
  const walletAddress = (await address.textContent())!;
  await page.getByTestId("faucet").click();
  await expect(page.getByTestId("balance")).toContainText("5", { timeout: 30_000 });
  const firstTx = await sendAlgo(page, "0.25");

  // Browser 2: a separate profile with nothing in common but the login, the file and the secret.
  const second = await browser.newContext();
  const page2 = await second.newPage();
  await signIn(page2, subject);
  await page2.getByTestId("restore-file").setInputFiles(file);
  await page2.getByTestId("restore-secret").fill(secret);
  await page2.getByTestId("restore").click();
  await expect(page2.getByTestId("wallet-address")).toHaveText(walletAddress, { timeout: 30_000 });
  const secondTx = await sendAlgo(page2, "0.1");
  expect(secondTx).not.toBe(firstTx);

  // Another login on the same app gets its own wallet.
  const third = await browser.newContext();
  const page3 = await third.newPage();
  await signIn(page3, `${subject}-other`);
  await page3.getByTestId("create-backup").click();
  await expect(page3.getByTestId("enroll")).toBeVisible();

  for (const context of [first, second, third]) await context.close();
});

test("a passkey unlocks the backup instead of the secret", async ({ browser }, info) => {
  const subject = `pw-passkey-${Date.now()}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });

  await signIn(page, subject);
  await page.getByText("Also unlock with a passkey").click();
  const download = page.waitForEvent("download");
  await page.getByTestId("create-backup").click();
  const error = page.getByTestId("error");
  const outcome = await Promise.race([
    download.then(() => "created" as const),
    error.waitFor({ timeout: 30_000 }).then(() => "error" as const),
  ]);
  test.skip(outcome === "error" && /passkey/i.test((await error.textContent()) ?? ""), "This Chromium's virtual authenticator offers no WebAuthn PRF");
  const file = info.outputPath("passkey-backup.json");
  await (await download).saveAs(file);
  await page.getByTestId("enroll").click();
  const walletAddress = (await page.getByTestId("wallet-address").textContent({ timeout: 60_000 }))!;

  // Sign out and back in (a new session key); restore with the passkey alone.
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, subject);
  await page.getByTestId("restore-file").setInputFiles(file);
  await page.getByRole("button", { name: "Use passkey" }).click();
  await expect(page.getByTestId("wallet-address")).toHaveText(walletAddress, { timeout: 30_000 });
  await context.close();
});

test("the same login on another dApp gets a different wallet", async ({ browser }) => {
  const subject = `pw-apps-${Date.now()}`;
  const context = await browser.newContext();
  const demo = await context.newPage();
  await signIn(demo, subject);
  await demo.getByTestId("create-backup").click();
  await demo.getByTestId("enroll").click();
  const demoAddress = (await demo.getByTestId("wallet-address").textContent({ timeout: 60_000 }))!;

  const example = await context.newPage();
  await example.goto(process.env.E2E_EXAMPLE_URL ?? "http://localhost:8775");
  const popup = example.waitForEvent("popup");
  await example.getByRole("button", { name: "Sign in and create a wallet" }).click();
  const login = await popup;
  await login.locator('input[name="custom_subject"]').fill(subject);
  await login.getByRole("button", { name: "Sign in with this subject" }).click();
  await expect(example.locator("#wallet")).toContainText("Wallet ", { timeout: 60_000 });
  const exampleAddress = (await example.locator("#wallet").textContent())!.split(" ")[1]!.replace(/\.$/, "");
  expect(algosdk.isValidAddress(exampleAddress)).toBe(true);
  expect(exampleAddress).not.toBe(demoAddress);
  await context.close();
});
