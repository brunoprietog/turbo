import { expect, test } from "@playwright/test"

const responses = new WeakMap()

test.beforeEach(async ({ page }, testInfo) => {
  const id = `${testInfo.project.name}-${testInfo.testId}`.replace(/[^a-zA-Z0-9-]/g, "")
  const path = `/__turbo/response_body/${id}`
  responses.set(page, path)
  await page.goto(path)
})

test.afterEach(async ({ page, request }) => {
  if (!page.isClosed()) await page.evaluate(() => window.resumeResponseRender?.())
  await request.post(`${responses.get(page)}/release`)
})

test("a same-URL POST waits for its body, then cleans up before rendering", async ({ page, request }) => {
  const location = page.url()
  await pauseRender(page, "turbo:before-render")
  await page.click("#page-submit")
  await waitForHeaders(page)

  await expectPendingSubmission(page)
  await releaseBody(page, request)
  await page.waitForFunction(() => window.responseRenderPaused)

  await expectCleanPageForm(page)
  expect(await page.evaluate(() => window.responseBodyEvents.ended[0].success)).toEqual(true)
  expect(await page.evaluate(() => window.responseBodyEvents.beforeRender[0].formBusy)).toEqual(false)
  await page.evaluate(() => window.resumeResponseRender())
  await expect(page.locator("h1")).toHaveText("Response received")
  await expect(page).toHaveURL(location)
})

test("a Drive GET cleans up before caching and restores an idle page", async ({ page, request }) => {
  const location = page.url()
  await pauseRender(page, "turbo:before-render")
  await page.click("#next-page")
  await waitForHeaders(page)
  expect(await page.evaluate(() => window.responseBodyState().pageBusy)).toEqual(true)
  expect(await page.evaluate(() => window.responseBodyEvents.beforeCache)).toEqual([])

  await releaseBody(page, request)
  await page.waitForFunction(() => window.responseRenderPaused)
  const states = await page.evaluate(() => window.responseBodyEvents.beforeCache)
  expect(states.length).toBeGreaterThan(0)
  expect(states.every(state => !state.formBusy && !state.buttonDisabled)).toEqual(true)
  expect(await page.evaluate(() => window.responseBodyEvents.beforeRender[0].formBusy)).toEqual(false)
  await resumePageRender(page)
  await expect(page.locator("h1")).toHaveText("Response received")
  expect(await page.evaluate(() => window.responseBodyState().pageBusy)).toEqual(false)

  await page.goBack()
  await expect(page).toHaveURL(location)
  await expect(page.locator("h1")).toHaveText("Response source")
  await expectCleanPageForm(page)
  await expect(page.locator("html")).not.toHaveAttribute("aria-busy")
})

test("a GET form caches the original form after restoring its controls", async ({ page, request }) => {
  const location = page.url()
  await page.locator("#page-form").evaluate(form => {
    form.method = "get"
    const destination = document.createElement("input")
    destination.type = "hidden"
    destination.name = "destination"
    destination.value = "true"
    form.append(destination)
  })
  await pauseRender(page, "turbo:before-render")
  await page.click("#page-submit")
  await waitForHeaders(page)
  await expectPendingSubmission(page)

  await releaseBody(page, request)
  await page.waitForFunction(() => window.responseRenderPaused)
  const states = await page.evaluate(() => window.responseBodyEvents.beforeCache)
  expect(states.length).toBeGreaterThan(0)
  expect(states.every(state => !state.formBusy && !state.buttonDisabled && state.buttonText === "Submit page")).toEqual(true)
  await resumePageRender(page)
  await expect(page.locator("h1")).toHaveText("Response received")

  await page.goBack()
  await expect(page).toHaveURL(location)
  await expect(page.locator("h1")).toHaveText("Response source")
  await expectCleanPageForm(page)
})

for (const status of [200, 422]) {
  test(`a frame's ${status} form response keeps controls busy until the body arrives`, async ({ page, request }) => {
    await page.locator("#frame-form").evaluate((form, action) => form.action = action, `${responses.get(page)}?status=${status}`)
    await pauseRender(page, "turbo:before-frame-render")
    await page.click("#frame-submit")
    await waitForHeaders(page)

    await expectPendingSubmission(page, "frame")
    await releaseBody(page, request)
    await page.waitForFunction(() => window.responseRenderPaused)

    const state = await page.evaluate(() => window.responseBodyState())
    expect(state.frameBusy).toEqual(false)
    expect(state.frameFormBusy).toEqual(false)
    expect(state.frameButtonDisabled).toEqual(false)
    expect(state.frameButtonText).toEqual("Submit frame")
    expect(await page.evaluate(() => window.responseBodyEvents.ended[0].success)).toEqual(status === 200)
    expect(await page.evaluate(() => window.responseBodyEvents.beforeFrameRender[0].frameFormBusy)).toEqual(false)
    await page.evaluate(() => window.resumeResponseRender())
    await expect(page.locator("#frame h2")).toHaveText("Frame response received")
    await expect(page.locator("#frame")).toHaveAttribute("complete")
  })
}

test("an intercepted Turbo Stream waits for its body and renders after cleanup", async ({ page, request }) => {
  await page.locator("#page-form").evaluate((form, action) => form.action = action, `${responses.get(page)}?mode=stream`)
  await page.click("#page-submit")
  await waitForHeaders(page)
  await expectPendingSubmission(page)
  await expect(page.locator("#message")).toHaveText("Waiting for stream")

  await releaseBody(page, request)
  await expect(page.locator("#message")).toHaveText("Stream received")
  await expectCleanPageForm(page)
  expect(await page.evaluate(() => window.responseBodyEvents.ended[0].success)).toEqual(true)
  const state = await page.evaluate(() => window.responseBodyEvents.beforeStreamRender[0])
  expect(state.formBusy).toEqual(false)
  expect(state.buttonDisabled).toEqual(false)
  expect(state.buttonText).toEqual("Submit page")
})

test("an interrupted body reports failure and restores the form", async ({ page, request }) => {
  const errors = []
  page.on("pageerror", error => errors.push(error))
  await page.click("#page-submit")
  await waitForHeaders(page)
  await expectPendingSubmission(page)

  await releaseBody(page, request, true)
  await page.waitForFunction(() => window.responseBodyEvents.errors.length === 1)
  await expectCleanPageForm(page)
  expect(await page.evaluate(() => window.responseBodyEvents.ended[0].success)).toEqual(false)
  expect(await page.evaluate(() => window.responseBodyEvents.errors[0].name)).not.toEqual("AbortError")
  await expect(page.locator("h1")).toHaveText("Response source")
  expect(errors).toEqual([])
})

test("an interrupted stream body reports one handled error without rendering", async ({ page, request }) => {
  const errors = []
  page.on("pageerror", error => errors.push(error))
  await page.evaluate(() => {
    document.addEventListener("turbo:fetch-request-error", event => event.preventDefault(), { once: true })
  })
  await page.locator("#page-form").evaluate((form, action) => form.action = action, `${responses.get(page)}?mode=stream`)
  await page.click("#page-submit")
  await waitForHeaders(page)
  await expectPendingSubmission(page)

  await releaseBody(page, request, true)
  await page.waitForFunction(() => window.responseBodyEvents.ended.length === 1)
  await expectCleanPageForm(page)
  expect(await page.evaluate(() => window.responseBodyEvents.errors.length)).toEqual(1)
  await expect(page.locator("#message")).toHaveText("Waiting for stream")
  expect(errors).toEqual([])
})

test("canceling a frame body lets its next navigation finish without an error", async ({ page }) => {
  const errors = []
  page.on("pageerror", error => errors.push(error))
  await page.locator("#frame").evaluate((frame, src) => frame.src = src, `${responses.get(page)}?visit=frame`)
  await waitForHeaders(page)
  await expect(page.locator("#frame")).toHaveAttribute("busy")

  await page.locator("#frame").evaluate(async frame => {
    frame.src = "/src/tests/fixtures/frames/frame.html"
    await frame.loaded
  })
  await expect(page.locator("#frame h2")).toHaveText("Frame: Loaded")
  await expect(page.locator("#frame")).not.toHaveAttribute("busy")
  expect(await page.evaluate(() => window.responseBodyEvents.errors)).toEqual([])
  expect(errors).toEqual([])
})

test("removing a frame cancels its GET form while the response body is pending", async ({ page }) => {
  const errors = []
  page.on("pageerror", error => errors.push(error))
  await page.locator("#frame-form").evaluate(form => {
    form.method = "get"
    form.addEventListener("turbo:submit-start", event => {
      window.pendingFrameSubmission = event.detail.formSubmission
    }, { once: true })
  })
  await page.click("#frame-submit")
  await waitForHeaders(page)
  await expectPendingSubmission(page, "frame")

  await page.locator("#frame").evaluate(frame => frame.remove())

  expect(await page.evaluate(() => window.pendingFrameSubmission.fetchRequest.abortSignal.aborted)).toEqual(true)
  await page.waitForFunction(() => window.responseBodyEvents.ended.length === 1)
  await expect(page.locator("h1")).toHaveText("Response source")
  expect(errors).toEqual([])
})


for (const status of [200, 422]) {
  test(`a ${status} form response cannot render after submit-end starts another visit`, async ({ page, request }) => {
    if (status === 422) {
      await page.locator("#page-form").evaluate((form, action) => form.action = action, `${responses.get(page)}?status=422`)
    }
    await page.evaluate(() => {
      window.reentrantRenderTargets = []
      window.reentrantSubmitEnds = 0
      window.reentrantVisitLoaded = new Promise(resolve => {
        const loaded = () => {
          if (location.pathname === "/src/tests/fixtures/one.html") {
            document.removeEventListener("turbo:load", loaded)
            resolve()
          }
        }
        document.addEventListener("turbo:load", loaded)
      })
      document.addEventListener("turbo:before-render", event => {
        window.reentrantRenderTargets.push(event.detail.newBody.querySelector("h1")?.textContent)
      })
      document.addEventListener("turbo:submit-end", () => {
        window.reentrantSubmitEnds++
        window.Turbo.visit("/src/tests/fixtures/one.html")
      }, { once: true })
    })
    await page.click("#page-submit")
    await waitForHeaders(page)
    await expectPendingSubmission(page)

    await releaseBody(page, request)
    await page.evaluate(() => window.reentrantVisitLoaded)

    await expect(page).toHaveURL(/\/src\/tests\/fixtures\/one\.html$/)
    await expect(page.locator("h1")).toHaveText("One")
    expect(await page.evaluate(() => window.reentrantSubmitEnds)).toEqual(1)
    expect(await page.evaluate(() => window.reentrantRenderTargets)).toEqual(["One"])
  })
}

async function waitForHeaders(page) {
  await page.waitForFunction(() => window.responseBodyEvents.headers === 1)
}

async function releaseBody(page, request, disconnect = false) {
  const path = `${responses.get(page)}/release${disconnect ? "?disconnect=true" : ""}`
  const response = await request.post(path)
  expect(response.status()).toEqual(204)
}

async function pauseRender(page, eventName) {
  await page.evaluate(eventName => {
    window.responseRenderPaused = false
    const pause = event => {
      if (eventName !== "turbo:before-frame-render" || event.target.id === "frame") {
        document.removeEventListener(eventName, pause)
        event.preventDefault()
        window.resumeResponseRender = event.detail.resume
        window.responseRenderPaused = true
      }
    }
    document.addEventListener(eventName, pause)
  }, eventName)
}

async function resumePageRender(page) {
  await page.evaluate(async () => {
    const loaded = new Promise(resolve => document.addEventListener("turbo:load", () => resolve(), { once: true }))
    window.resumeResponseRender()
    await loaded
  })
}

async function expectPendingSubmission(page, target = "page") {
  const state = await page.evaluate(() => window.responseBodyState())
  if (target === "frame") {
    expect(state.frameBusy).toEqual(true)
    expect(state.frameFormBusy).toEqual(true)
    expect(state.frameButtonDisabled).toEqual(true)
    expect(state.frameButtonText).toEqual("Sending")
  } else {
    expect(state.formBusy).toEqual(true)
    expect(state.buttonDisabled).toEqual(true)
    expect(state.buttonText).toEqual("Sending")
  }
  expect(await page.evaluate(() => window.responseBodyEvents.ended)).toEqual([])
}

async function expectCleanPageForm(page) {
  await expect(page.locator("#page-form")).not.toHaveAttribute("aria-busy")
  await expect(page.locator("#page-submit")).toBeEnabled()
  await expect(page.locator("#page-submit")).toHaveText("Submit page")
}
