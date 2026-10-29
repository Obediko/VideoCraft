import { test, expect } from "@playwright/test";

// Runs against the dev server with no API: the signed-out screen must render, behave and fit on a phone.
test("sign-in screen: switch to create account, button enables only with valid input, fits a phone", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("tab", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  const submit = page.locator(".auth-card").getByRole("button", { name: "Create account" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Email").fill("someone@example.com");
  await page.getByLabel("Password").fill("short");
  await expect(submit).toBeDisabled();
  await page.getByLabel("Password").fill("a-long-enough-password");
  await expect(submit).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
