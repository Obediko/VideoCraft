import { test, expect } from "@playwright/test";

test("edits a timeline clip with the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Advanced").click();
  await page.getByPlaceholder("asset ID").fill("asset-browser-123");
  await page.getByRole("button", { name: "Add video clip" }).click();

  const clip = page.locator("button.clip");
  await expect(clip).toHaveCount(1);
  await expect(clip).toBeVisible();
  await clip.focus();
  await expect(clip).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Clip moved later")).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(page.getByText("Your non-destructive timeline is empty. Add a registered asset to begin.")).toBeVisible();
});
