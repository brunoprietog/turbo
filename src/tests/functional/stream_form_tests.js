import { expect, test } from "@playwright/test"

test("receiving a stream appends content to a form with a control named append", async ({ page }) => {
  await page.goto("/src/tests/fixtures/stream.html")

  await page.locator("#form-with-stream-methods button").click()

  await expect(page.locator("#form-with-stream-methods .message")).toHaveText("Hello form!")
  await expect(page).toHaveURL(/\/src\/tests\/fixtures\/stream\.html$/)
})
