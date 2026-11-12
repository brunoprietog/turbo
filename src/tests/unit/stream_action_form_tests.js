import { StreamElement } from "../../elements"
import { DOMTestCase } from "../helpers/dom_test_case"
import { assert } from "@open-wc/testing"
import "../../index"

let subject

setup(() => {
  subject?.teardown()
  subject = new DOMTestCase()
  subject.setup()
  subject.fixtureHTML = `<div>${formWithActionNames()}</div>`
})

test("action=after with form controls named after stream actions", () => {
  const target = subject.find("#form-target")

  performStreamAction("after")

  assert.equal(target.nextElementSibling, subject.find("#new-content"))
})

test("action=append with form controls named after stream actions", () => {
  const target = subject.find("#form-target")

  performStreamAction("append")

  assert.equal(target.lastElementChild, subject.find("#new-content"))
})

test("action=before with form controls named after stream actions", () => {
  const target = subject.find("#form-target")

  performStreamAction("before")

  assert.equal(target.previousElementSibling, subject.find("#new-content"))
})

test("action=prepend with form controls named after stream actions", () => {
  const target = subject.find("#form-target")

  performStreamAction("prepend")

  assert.equal(target.firstElementChild, subject.find("#new-content"))
})

test("action=remove with form controls named after stream actions", () => {
  performStreamAction("remove")

  assert.isNull(subject.find("#form-target"))
})

test("action=replace with form controls named after stream actions", () => {
  const parent = subject.find("#form-target").parentElement

  performStreamAction("replace")

  assert.isNull(subject.find("#form-target"))
  assert.equal(parent.firstElementChild, subject.find("#new-content"))
})

test("action=update with form controls named after stream actions", () => {
  const target = subject.find("#form-target")

  performStreamAction("update")

  assert.equal(target.children.length, 1)
  assert.equal(target.firstElementChild, subject.find("#new-content"))
})

test("action=replace with a form control named replaceWith", () => {
  subject.fixtureHTML = `<form id="form-target"><input name="replaceWith"></form>`

  performStreamAction("replace")

  assert.isNull(subject.find("#form-target"))
  assert.ok(subject.find("#new-content"))
})

test("action=remove with form controls named remove and parentElement", () => {
  subject.fixtureHTML = `<form id="form-target"><input name="remove"><input name="parentElement"></form>`

  performStreamAction("remove")

  assert.isNull(subject.find("#form-target"))
})

for (const action of ["append", "prepend"]) {
  test(`action=${action} removes duplicate child forms with a control named remove`, () => {
    subject.fixtureHTML = `<div id="form-target"><form id="duplicate"><input name="remove"></form></div>`

    performStreamAction(action, `<form id="duplicate"><span>Replacement</span></form>`)

    assert.equal(subject.fixtureElement.querySelectorAll("#duplicate").length, 1)
    assert.equal(subject.find("#duplicate").textContent, "Replacement")
  })
}

for (const action of ["after", "before"]) {
  test(`action=${action} removes duplicate sibling forms with a control named remove`, () => {
    subject.fixtureHTML = `<div><div id="form-target"></div><form id="duplicate"><input name="remove"></form></div>`

    performStreamAction(action, `<form id="duplicate"><span>Replacement</span></form>`)

    assert.equal(subject.fixtureElement.querySelectorAll("#duplicate").length, 1)
    assert.equal(subject.find("#duplicate").textContent, "Replacement")
  })
}

test("stream actions preserve callable element methods and read them once", () => {
  subject.fixtureHTML = `<div id="form-target"></div>`
  const target = subject.find("#form-target")
  let reads = 0
  let calls = 0
  Object.defineProperty(target, "append", {
    get() {
      reads++
      return function (...nodes) {
        calls++
        assert.equal(this, target)
        Element.prototype.append.call(this, ...nodes)
      }
    }
  })

  performStreamAction("append")

  assert.equal(reads, 1)
  assert.equal(calls, 1)
  assert.equal(target.lastElementChild, subject.find("#new-content"))
})

function formWithActionNames() {
  const controls = ["after", "append", "before", "prepend", "remove", "replace", "update"]
    .map((name) => `<input type="hidden" name="${name}">`)
    .join("")

  return `<form id="form-target">${controls}</form>`
}

function performStreamAction(action, html = `<span id="new-content">New content</span>`) {
  const stream = new StreamElement()
  stream.setAttribute("action", action)
  stream.setAttribute("target", "form-target")
  stream.innerHTML = `<template>${html}</template>`
  stream.performAction()
}
