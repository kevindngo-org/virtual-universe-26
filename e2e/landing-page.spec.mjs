import { test, expect } from "@playwright/test";

test.describe("CLI terminal demo", () => {
  test("arrow keys move between tabs", async ({ page }) => {
    await page.goto("/");
    const first = page.getByRole("tab", { name: "Stacked PRs" });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Attach to an issue" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#terminal-title")).toContainText("gh issue comment --attach");
  });

  test("reduced motion renders the full example", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator("#terminal-screen")).toContainText("Two small pull requests");
    await expect(page.locator("#pause")).toBeHidden();
  });

  // TODO: Pause/Play, Home/End keys, and guide-to-chat updates.
});
