import type { ExtractionElement } from "@redline/redline-domain";

// View model for the document view the review grid's source deep-link points at.
// A pure transform of a document's ExtractionElement[] into presentation-ready
// shapes the Next.js/React shell binds to — the elements in extraction order,
// each with the DOM id it renders under, and the resolved anchor the `element`
// query parameter cites. Keeps the DOM dumb and the ordering/anchor logic tested
// without a browser, matching review-view.ts (ADR-0006).
//
// Provenance arrives as JSON through IProcurementExtractionReader — the
// presentation seam ADR-0003/0017 keeps for exactly this — so nothing here
// touches Parquet or womblex directly.

export interface DocumentElementView {
  // womblex elem_order: the identity the deep-link cites and the sort key.
  readonly elementOrder: number;
  readonly page: number | null;
  readonly text: string;
  readonly domId: string;
  readonly isAnchor: boolean;
}

export interface DocumentView {
  readonly documentId: string;
  readonly elements: readonly DocumentElementView[];
  // The DOM id to scroll to, or null when the link cited nothing or cited an
  // element this extraction no longer carries.
  readonly anchorDomId: string | null;
  readonly anchorPage: number | null;
  // True only when an element *was* cited and is absent — a stale deep-link.
  // Distinguishing this from "nothing cited" is what lets the screen say the
  // passage has moved rather than render the top of the document as if it were
  // the cited one.
  readonly anchorMissing: boolean;
  readonly backToReviewHref: string;
  readonly elementCount: number;
  readonly isEmpty: boolean;
}

export interface RenderDocumentViewInput {
  readonly evaluationId: string;
  readonly documentId: string;
  readonly elements: readonly ExtractionElement[];
  readonly anchorElementOrder?: number;
}

export const documentElementDomId = (elementOrder: number): string => `element-${elementOrder}`;

export const renderDocumentView = (input: RenderDocumentViewInput): DocumentView => {
  const ordered = [...input.elements].sort((a, b) => a.elementOrder - b.elementOrder);
  const anchored =
    input.anchorElementOrder === undefined
      ? undefined
      : ordered.find((element) => element.elementOrder === input.anchorElementOrder);

  return {
    documentId: input.documentId,
    elements: ordered.map((element) => ({
      elementOrder: element.elementOrder,
      page: element.page,
      text: element.text,
      domId: documentElementDomId(element.elementOrder),
      isAnchor: element.elementOrder === anchored?.elementOrder,
    })),
    anchorDomId: anchored ? documentElementDomId(anchored.elementOrder) : null,
    anchorPage: anchored?.page ?? null,
    anchorMissing: input.anchorElementOrder !== undefined && anchored === undefined,
    backToReviewHref: `/evaluations/${input.evaluationId}/review`,
    elementCount: ordered.length,
    isEmpty: ordered.length === 0,
  };
};
