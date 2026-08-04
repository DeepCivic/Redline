import { describe, it, expect } from "vitest";
import type { ExtractionElement } from "@redline/redline-domain";
import { documentElementDomId, renderDocumentView } from "./document-view";

// The document view is the other end of the review grid's source deep-link
// (review-view.ts builds /evaluations/:id/documents/:documentId?element=…). It is
// a pure ExtractionElement[] → view-model transform the Next.js/React layer binds
// to, so ordering, the anchor the `element` parameter selects, and the
// missing-anchor case are unit-testable without a browser. The Playwright e2e
// proves the served DOM; this proves the model the DOM binds to (ADR-0006).

const element = (over: Partial<ExtractionElement> = {}): ExtractionElement => ({
  documentId: "doc-a",
  elementOrder: 1,
  page: 1,
  text: "A paragraph of the tender response.",
  ...over,
});

const render = (
  over: Partial<Parameters<typeof renderDocumentView>[0]> = {},
): ReturnType<typeof renderDocumentView> =>
  renderDocumentView({
    evaluationId: "eval-1",
    documentId: "doc-a",
    elements: [element()],
    ...over,
  });

describe("renderDocumentView", () => {
  it("orders elements by elemOrder regardless of the order the reader returned them", () => {
    const view = render({
      elements: [
        element({ elementOrder: 7, text: "seventh" }),
        element({ elementOrder: 2, text: "second" }),
        element({ elementOrder: 4, text: "fourth" }),
      ],
    });

    expect(view.elements.map((each) => each.elementOrder)).toEqual([2, 4, 7]);
    expect(view.elements.map((each) => each.text)).toEqual(["second", "fourth", "seventh"]);
    expect(view.elementCount).toBe(3);
    expect(view.isEmpty).toBe(false);
  });

  it("anchors on the cited element and exposes the DOM id the shell scrolls to", () => {
    const view = render({
      elements: [element({ elementOrder: 2 }), element({ elementOrder: 7, page: 3 })],
      anchorElementOrder: 7,
    });

    expect(view.anchorDomId).toBe(documentElementDomId(7));
    expect(view.anchorMissing).toBe(false);
    expect(view.elements.map((each) => each.isAnchor)).toEqual([false, true]);
    // The anchored element carries the DOM id the view names, so the shell can
    // scroll to it without re-deriving the id.
    expect(view.elements[1].domId).toBe(view.anchorDomId);
  });

  it("reports the anchored element's page so the reader knows where they landed", () => {
    const view = render({
      elements: [element({ elementOrder: 7, page: 3 })],
      anchorElementOrder: 7,
    });

    expect(view.anchorPage).toBe(3);
  });

  it("has no anchor when the link carried no element parameter", () => {
    const view = render({ elements: [element({ elementOrder: 2 })] });

    expect(view.anchorDomId).toBeNull();
    expect(view.anchorMissing).toBe(false);
    expect(view.anchorPage).toBeNull();
    expect(view.elements.every((each) => !each.isAnchor)).toBe(true);
  });

  // A stale deep-link (the extraction was re-run and elem_order moved) must say
  // so rather than silently render the document scrolled to the top, which reads
  // as "this is the cited passage" when it is not.
  it("flags a cited element the extraction no longer carries", () => {
    const view = render({ elements: [element({ elementOrder: 2 })], anchorElementOrder: 99 });

    expect(view.anchorMissing).toBe(true);
    expect(view.anchorDomId).toBeNull();
    expect(view.anchorPage).toBeNull();
    expect(view.elements.every((each) => !each.isAnchor)).toBe(true);
  });

  it("renders an empty document without an anchor rather than failing", () => {
    const view = render({ elements: [], anchorElementOrder: 3 });

    expect(view.isEmpty).toBe(true);
    expect(view.elementCount).toBe(0);
    expect(view.elements).toEqual([]);
    expect(view.anchorMissing).toBe(true);
    expect(view.anchorDomId).toBeNull();
  });

  it("carries a page-less element through, since not every extraction paginates", () => {
    const view = render({
      elements: [element({ elementOrder: 1, page: null })],
      anchorElementOrder: 1,
    });

    expect(view.elements[0].page).toBeNull();
    expect(view.anchorPage).toBeNull();
    expect(view.anchorMissing).toBe(false);
  });

  it("links back to the review grid the deep-link was clicked from", () => {
    const view = render();

    expect(view.backToReviewHref).toBe("/evaluations/eval-1/review");
  });

  it("keeps the document id on the view so the screen can title itself", () => {
    const view = render();

    expect(view.documentId).toBe("doc-a");
  });
});

describe("documentElementDomId", () => {
  it("namespaces the id so it cannot collide with other ids on the page", () => {
    expect(documentElementDomId(7)).toBe("element-7");
  });
});
