import { test, expect } from "@playwright/test";

test("creates a project and edits a timeline clip with the keyboard", async ({ page }) => {
  await page.route("**/v1/projects", async (route) => {
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ project: { id: "project-browser-1", name: "Browser project" } }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("Project created")).toBeVisible();

  await page.getByPlaceholder("asset ID").fill("asset-browser-123");
  await page.getByRole("button", { name: "Add video clip" }).click();
  const clip = page.getByRole("button", { name: /Clip asset-browser/ });
  await expect(clip).toBeVisible();

  await clip.focus();
  await expect(clip).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Clip moved later")).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(page.getByText("Your non-destructive timeline is empty. Add a registered asset to begin.")).toBeVisible();
});
