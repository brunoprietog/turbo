import { session } from "../"
import { morphElements, morphChildren } from "../morphing"
import { invokeElementMethod } from "../../util"

export const StreamActions = {
  after() {
    this.removeDuplicateTargetSiblings()
    this.targetElements.forEach((e) => e.parentElement?.insertBefore(this.templateContent, e.nextSibling))
  },

  append() {
    this.removeDuplicateTargetChildren()
    this.targetElements.forEach((e) => invokeElementMethod(e, "append", this.templateContent))
  },

  before() {
    this.removeDuplicateTargetSiblings()
    this.targetElements.forEach((e) => e.parentElement?.insertBefore(this.templateContent, e))
  },

  prepend() {
    this.removeDuplicateTargetChildren()
    this.targetElements.forEach((e) => invokeElementMethod(e, "prepend", this.templateContent))
  },

  remove() {
    this.targetElements.forEach((e) => invokeElementMethod(e, "remove"))
  },

  replace() {
    const method = this.getAttribute("method")

    this.targetElements.forEach((targetElement) => {
      if (method === "morph") {
        morphElements(targetElement, this.templateContent)
      } else {
        invokeElementMethod(targetElement, "replaceWith", this.templateContent)
      }
    })
  },

  update() {
    const method = this.getAttribute("method")

    this.targetElements.forEach((targetElement) => {
      if (method === "morph") {
        morphChildren(targetElement, this.templateContent)
      } else {
        targetElement.innerHTML = ""
        invokeElementMethod(targetElement, "append", this.templateContent)
      }
    })
  },

  refresh() {
    const method = this.getAttribute("method")
    const requestId = this.requestId
    const scroll = this.getAttribute("scroll")

    session.refresh(this.baseURI, { method, requestId, scroll })
  }
}
