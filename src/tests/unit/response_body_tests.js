import { assert } from "@open-wc/testing"
import { FetchMethod, FetchRequest } from "../../http/fetch_request"
import { FetchResponse } from "../../http/fetch_response"
import { FormSubmission } from "../../core/drive/form_submission"
import { StreamObserver } from "../../observers/stream_observer"
import { StreamElement } from "../../elements/stream_element"

if (customElements.get("turbo-stream") === undefined) customElements.define("turbo-stream", StreamElement)

let container, bodies, streamObservers

setup(() => {
  container = document.createElement("div")
  document.body.append(container)
  bodies = []
  streamObservers = []
})

teardown(() => {
  for (const observer of streamObservers) observer.stop()
  for (const body of bodies) body.finish()
  container.remove()
})

for (const status of [200, 422]) {
  test(`a ${status} response keeps cleanup pending until its body arrives`, async () => {
    const scenario = createRequest({ status })
    const html = readHTMLAtHeaders(scenario)
    const performed = scenario.request.perform()
    await scenario.headers

    assert.deepEqual(scenario.calls, ["started", "headers"])
    scenario.body.finish("Response body")
    const response = await performed
    assert.strictEqual(response, scenario.fetchResponse)
    assert.equal(await html, "Response body")
    await scenario.handled

    assert.deepEqual(scenario.calls.slice(0, 4), ["started", "headers", status === 200 ? "succeeded" : "failed", "finished"])
    assert.isBelow(scenario.calls.indexOf("finished"), scenario.calls.indexOf("headers consumed HTML"))
    assert.isBelow(scenario.calls.indexOf("finished"), scenario.calls.indexOf("delegate consumed HTML"))
    assert.lengthOf(scenario.errors, 0)
  })
}

test("finishing a request does not wait for its delegate to finish rendering", async () => {
  const scenario = createRequest()
  let resumeRender
  const rendering = new Promise(resolve => resumeRender = resolve)
  scenario.request.delegate.requestSucceededWithResponse = async (_request, response) => {
    await response.responseHTML
    scenario.calls.push("render started")
    await rendering
    scenario.calls.push("render finished")
  }
  const performed = scenario.request.perform()
  await scenario.headers
  scenario.body.finish()

  try {
    await performed
    await scenario.fetchResponse.responseHTML
    assert.include(scenario.calls, "finished")
    assert.notInclude(scenario.calls, "render finished")
  } finally {
    resumeRender()
  }
})

test("HTML and text consumers reuse one body read", async () => {
  const body = createBody()
  const response = new Response(body.stream, { headers: { "Content-Type": "text/html" } })
  let clones = 0
  const clone = response.clone.bind(response)
  response.clone = () => {
    clones++
    return clone()
  }
  const fetchResponse = new FetchResponse(response)
  const reads = [fetchResponse.responseHTML, fetchResponse.responseText, fetchResponse.responseHTML]
  assert.equal(clones, 1)

  body.finish("Shared body")
  assert.deepEqual(await Promise.all(reads), ["Shared body", "Shared body", "Shared body"])
})

test("a custom interceptor can own a locked native body without requesting HTML", async () => {
  const scenario = createRequest()
  let reader, clones = 0
  const clone = scenario.response.clone.bind(scenario.response)
  scenario.response.clone = () => {
    clones++
    return clone()
  }
  scenario.target.addEventListener("turbo:before-fetch-response", event => {
    event.preventDefault()
    reader = event.detail.fetchResponse.response.body.getReader()
  }, { once: true })

  const response = await scenario.request.perform()

  assert.strictEqual(response, scenario.fetchResponse)
  assert.deepEqual(scenario.calls, ["started", "headers", "prevented", "finished"])
  assert.equal(clones, 0)
  assert.lengthOf(scenario.errors, 0)
  reader.releaseLock()
})

test("an intercepted HTML consumer waits for body completion and request cleanup", async () => {
  const scenario = createRequest()
  scenario.target.addEventListener("turbo:before-fetch-response", event => event.preventDefault(), { once: true })
  const html = readHTMLAtHeaders(scenario)
  const performed = scenario.request.perform()
  await scenario.headers

  assert.deepEqual(scenario.calls, ["started", "headers"])
  scenario.body.finish("Intercepted HTML")
  await performed
  assert.equal(await html, "Intercepted HTML")
  assert.isBelow(scenario.calls.indexOf("prevented"), scenario.calls.indexOf("finished"))
  assert.isBelow(scenario.calls.indexOf("finished"), scenario.calls.indexOf("headers consumed HTML"))
})

test("a Turbo Stream is handled after the request is cleaned up", async () => {
  const scenario = createRequest({ contentType: "text/vnd.turbo-stream.html" })
  let receiveStream
  const received = new Promise(resolve => receiveStream = resolve)
  observeStreams(() => {
    scenario.calls.push("stream handled")
    receiveStream()
  })
  const performed = scenario.request.perform()
  await scenario.headers

  assert.deepEqual(scenario.calls, ["started", "headers"])
  scenario.body.finish('<turbo-stream action="remove" target="message"></turbo-stream>')
  await performed
  await received

  assert.isBelow(scenario.calls.indexOf("prevented"), scenario.calls.indexOf("finished"))
  assert.isBelow(scenario.calls.indexOf("finished"), scenario.calls.indexOf("stream handled"))
})

for (const abortsBody of [true, false]) {
  test(`canceling an adopted response discards HTML when its body ${abortsBody ? "aborts" : "ignores abort"}`, async () => {
    const scenario = createRequest()
    const html = readHTMLAtHeaders(scenario).catch(error => error)
    if (abortsBody) {
      scenario.adopted.abortSignal.addEventListener("abort", () => {
        scenario.body.error(new DOMException("Aborted", "AbortError"))
      }, { once: true })
    }
    const performed = scenario.request.perform()
    await scenario.headers
    scenario.request.cancel()
    if (!abortsBody) scenario.body.finish("Stale HTML")
    await performed

    assert.equal((await html).name, "AbortError")
    assert.deepEqual(scenario.calls.filter(call => ["succeeded", "failed", "prevented"].includes(call)), [])
    assert.equal(scenario.calls.filter(call => call === "finished").length, 1)
    assert.lengthOf(scenario.errors, 0)
  })
}

test("canceling an adopted stream cannot deliver its buffered HTML", async () => {
  const scenario = createRequest({ contentType: "text/vnd.turbo-stream.html" })
  let received = false
  observeStreams(() => received = true)
  const html = readHTMLAtHeaders(scenario).catch(error => error)
  const performed = scenario.request.perform()
  await scenario.headers
  scenario.request.cancel()
  scenario.body.finish('<turbo-stream action="remove" target="message"></turbo-stream>')
  await performed
  assert.equal((await html).name, "AbortError")

  assert.isFalse(received)
  assert.notInclude(scenario.calls, "prevented")
  assert.lengthOf(scenario.errors, 0)
})

test("an ordinary response may finish when its native fetch ignores abort", async () => {
  const target = document.createElement("a")
  container.append(target)
  const calls = []
  const request = new FetchRequest(createDelegate(calls), FetchMethod.get, new URL("/src/tests/fixtures/one.html", document.baseURI), new URLSearchParams(), target)
  target.addEventListener("turbo:before-fetch-request", event => delete event.detail.fetchOptions.signal, { once: true })
  target.addEventListener("turbo:before-fetch-response", () => request.cancel(), { once: true })

  const response = await request.perform()

  assert.isTrue(request.abortSignal.aborted)
  assert.include(await response.responseHTML, "<h1>One</h1>")
  assert.include(calls, "succeeded")
  assert.equal(calls.filter(call => call === "finished").length, 1)
  assert.notInclude(calls, "errored")
})

test("a broken response body reports an error before cleanup", async () => {
  const scenario = createRequest()
  const html = readHTMLAtHeaders(scenario).catch(error => error)
  const performed = scenario.request.perform()
  await scenario.headers
  scenario.body.error(new TypeError("Broken response body"))

  assert.isUndefined(await performed)
  assert.ok(await html)
  assert.deepEqual(scenario.calls, ["started", "headers", "errored", "finished"])
  assert.lengthOf(scenario.errors, 1)
  assert.isFalse(scenario.request.abortSignal.aborted)
  assert.isFalse(scenario.adopted.abortSignal.aborted)
})

test("a non-HTML response does not wait for an unconsumed native body", async () => {
  const scenario = createRequest({ contentType: "application/json" })
  const response = await scenario.request.perform()

  assert.isUndefined(await response.responseHTML)
  assert.include(scenario.calls, "succeeded")
  assert.equal(scenario.calls.filter(call => call === "finished").length, 1)
})

test("calling receive directly does not require perform cleanup", async () => {
  const scenario = createRequest()
  const html = readHTMLAtHeaders(scenario)
  const received = scenario.request.receive(scenario.response)
  await scenario.headers
  scenario.body.finish("Direct response")

  assert.strictEqual(await received, scenario.fetchResponse)
  assert.equal(await html, "Direct response")
  assert.notInclude(scenario.calls, "finished")
})

test("HTML consumers are released even if request cleanup throws", async () => {
  const scenario = createRequest()
  const cleanupError = new Error("Cleanup failed")
  scenario.request.delegate.requestFinished = () => {
    scenario.calls.push("finished")
    throw cleanupError
  }
  const html = readHTMLAtHeaders(scenario)
  const performed = scenario.request.perform().catch(error => error)
  await scenario.headers
  scenario.body.finish("Available after cleanup")

  assert.strictEqual(await performed, cleanupError)
  assert.equal(await html, "Available after cleanup")
  assert.equal(scenario.calls.filter(call => call === "finished").length, 1)
})

for (const { method, status, contentType } of [
  { method: "requestSucceededWithResponse", status: 200, contentType: "text/html" },
  { method: "requestFailedWithResponse", status: 422, contentType: "text/html" },
  { method: "requestPreventedHandlingResponse", status: 200, contentType: "text/vnd.turbo-stream.html" }
]) {
  test(`a canceled submission ignores ${method}`, () => {
    const calls = []
    const form = document.createElement("form")
    form.method = "post"
    form.action = "/submit"
    const delegate = {
      formSubmissionSucceededWithResponse: () => calls.push("succeeded"),
      formSubmissionFailedWithResponse: () => calls.push("failed"),
      formSubmissionSucceededWithStreamResponse: () => calls.push("stream succeeded"),
      formSubmissionErrored: () => calls.push("errored")
    }
    const submission = new FormSubmission(delegate, form)
    const response = new FetchResponse(new Response("", { status, headers: { "Content-Type": contentType } }))
    submission.fetchRequest.cancel()

    submission[method](submission.fetchRequest, response)

    assert.isUndefined(submission.result)
    assert.deepEqual(calls, [])
  })
}

test("a broken Turbo Stream body is reported once without rendering", async () => {
  const scenario = createRequest({ contentType: "text/vnd.turbo-stream.html" })
  let received = false
  observeStreams(() => received = true)
  const html = readHTMLAtHeaders(scenario).catch(error => error)
  const performed = scenario.request.perform()
  await scenario.headers
  scenario.body.error(new TypeError("Broken stream body"))

  assert.isUndefined(await performed)
  assert.ok(await html)
  assert.isFalse(received)
  assert.deepEqual(scenario.calls, ["started", "headers", "errored", "finished"])
  assert.lengthOf(scenario.errors, 1)
})

test("a Stream rendering error remains observable after reading the body", async () => {
  const renderError = new Error("Stream render failed")
  const observer = new StreamObserver({
    receivedMessageFromStream() { throw renderError }
  })
  const response = new FetchResponse(new Response('<turbo-stream action="remove" target="message"></turbo-stream>', {
    headers: { "Content-Type": "text/vnd.turbo-stream.html" }
  }))

  const error = await observer.receiveMessageResponse(response).catch(error => error)

  assert.strictEqual(error, renderError)
})

function createRequest({ status = 200, contentType = "text/html" } = {}) {
  const body = createBody()
  const response = new Response(body.stream, { status, headers: { "Content-Type": contentType } })
  const calls = [], errors = []
  const target = document.createElement("a")
  container.append(target)
  let headersReceived
  const headers = new Promise(resolve => headersReceived = resolve)
  const scenario = { body, response, target, calls, errors, headers, fetchResponse: null, handled: null }
  const delegate = createDelegate(calls, errors, fetchResponse => {
    scenario.handled = fetchResponse.responseHTML.then(() => calls.push("delegate consumed HTML"))
  })
  const adopted = new FetchRequest(delegate, FetchMethod.get, new URL("/response-body", document.baseURI))
  adopted.response = Promise.resolve(response)
  const request = new FetchRequest(delegate, FetchMethod.get, adopted.url, new URLSearchParams(), target)
  target.addEventListener("turbo:before-fetch-request", event => event.detail.fetchRequest = adopted)
  target.addEventListener("turbo:before-fetch-response", event => {
    scenario.fetchResponse = event.detail.fetchResponse
    calls.push("headers")
    headersReceived()
  })
  return Object.assign(scenario, { request, adopted })
}

function createDelegate(calls, errors = [], handleResponse = () => {}) {
  return {
    prepareRequest() {},
    requestStarted() { calls.push("started") },
    requestSucceededWithResponse(_request, response) {
      calls.push("succeeded")
      handleResponse(response)
    },
    requestFailedWithResponse(_request, response) {
      calls.push("failed")
      handleResponse(response)
    },
    requestPreventedHandlingResponse() { calls.push("prevented") },
    requestErrored(_request, error) {
      errors.push(error)
      calls.push("errored")
    },
    requestFinished() { calls.push("finished") }
  }
}

function createBody() {
  let controller, closed = false
  const body = {
    stream: new ReadableStream({ start(streamController) { controller = streamController } }),
    finish(text = "Response body") {
      if (!closed) {
        closed = true
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      }
    },
    error(error) {
      if (!closed) {
        closed = true
        controller.error(error)
      }
    }
  }
  bodies.push(body)
  return body
}

function readHTMLAtHeaders(scenario) {
  return new Promise((resolve, reject) => {
    scenario.target.addEventListener("turbo:before-fetch-response", event => {
      event.detail.fetchResponse.responseHTML.then(html => {
        scenario.calls.push("headers consumed HTML")
        resolve(html)
      }, reject)
    }, { once: true })
  })
}

function observeStreams(receivedMessageFromStream) {
  const observer = new StreamObserver({ receivedMessageFromStream })
  observer.start()
  streamObservers.push(observer)
}
