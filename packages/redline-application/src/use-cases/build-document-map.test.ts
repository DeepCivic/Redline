import { describe, it, expect } from "vitest";
import type { Comprehension } from "@redline/redline-domain";
import {
  buildDocumentMap,
  type DocumentMapEntry,
  type MappedDocument,
} from "./build-document-map";

// Document Map read model (Thread 25) — a *derived, never-stored* roll-up of the
// corpus classification (design doc §2 step 2 "Map the corpus", §3). It reuses
// `computePivot`'s count-measure algorithm — first-appearance distinct groups,
// ranked by descending count with an alphabetical tiebreak — over redline's own
// types (Thread 13's precedent: reuse the algorithm, not the types; the parity
// assertion against the real `computePivot` lives in the adapters' Wayfinder
// contract test, the one package that may reach it).
//
// The exit criteria: percentages match hand-computed totals on a fixture, and
// the map is recomputed, not persisted (a pure function — no repository, no
// clock, no store to persist to).

const clear = (documentId: string, topicId: string): MappedDocument => ({
  documentId,
  topicId,
  bucket: "clear",
});

const ambiguous = (documentId: string): MappedDocument => ({
  documentId,
  topicId: null,
  bucket: "ambiguous",
});

// A hand-computable fixture: 10 documents so every share is a round percentage.
//   Security  — 5 clear   → 50%
//   Pricing   — 3 clear   → 30%
//   (ambiguous, unassigned) — 2 → 20%
const corpus: readonly MappedDocument[] = [
  clear("doc-1", "topic-security"),
  clear("doc-2", "topic-security"),
  clear("doc-3", "topic-security"),
  clear("doc-4", "topic-security"),
  clear("doc-5", "topic-security"),
  clear("doc-6", "topic-pricing"),
  clear("doc-7", "topic-pricing"),
  clear("doc-8", "topic-pricing"),
  ambiguous("doc-9"),
  ambiguous("doc-10"),
];

const byTopic = (entries: readonly DocumentMapEntry[], topicId: string): DocumentMapEntry =>
  entries.find((entry) => entry.topicId === topicId)!;

describe("buildDocumentMap", () => {
  it("counts documents per topic and the corpus-wide totals", () => {
    const map = buildDocumentMap(corpus);

    expect(map.totalDocuments).toBe(10);
    expect(map.assignedDocuments).toBe(8);
    expect(map.unassignedDocuments).toBe(2);
    expect(byTopic(map.entries, "topic-security").count).toBe(5);
    expect(byTopic(map.entries, "topic-pricing").count).toBe(3);
  });

  it("computes each topic's percentage of the corpus — matching hand-computed totals", () => {
    const map = buildDocumentMap(corpus);

    // 5/10, 3/10 of the whole corpus; the unassigned 2/10 is its own share.
    expect(byTopic(map.entries, "topic-security").percentage).toBe(50);
    expect(byTopic(map.entries, "topic-pricing").percentage).toBe(30);
    expect(map.unassignedPercentage).toBe(20);
  });

  it("splits the corpus Clear vs Ambiguous", () => {
    const map = buildDocumentMap(corpus);

    expect(map.clearDocuments).toBe(8);
    expect(map.ambiguousDocuments).toBe(2);
    expect(map.clearPercentage).toBe(80);
    expect(map.ambiguousPercentage).toBe(20);
  });

  it("ranks topics by descending count, breaking ties alphabetically (computePivot's order)", () => {
    // A tie on count (2 each) between 'topic-b' and 'topic-a' resolves
    // alphabetically; 'topic-c' with 3 outranks both.
    const tied: readonly MappedDocument[] = [
      clear("d1", "topic-b"),
      clear("d2", "topic-b"),
      clear("d3", "topic-a"),
      clear("d4", "topic-a"),
      clear("d5", "topic-c"),
      clear("d6", "topic-c"),
      clear("d7", "topic-c"),
    ];

    const map = buildDocumentMap(tied);

    expect(map.entries.map((entry) => entry.topicId)).toEqual([
      "topic-c",
      "topic-a",
      "topic-b",
    ]);
  });

  it("returns an empty map for an empty corpus without dividing by zero", () => {
    const map = buildDocumentMap([]);

    expect(map.totalDocuments).toBe(0);
    expect(map.entries).toEqual([]);
    expect(map.assignedDocuments).toBe(0);
    expect(map.unassignedDocuments).toBe(0);
    expect(map.clearPercentage).toBe(0);
    expect(map.ambiguousPercentage).toBe(0);
    expect(map.unassignedPercentage).toBe(0);
  });

  it("treats an all-ambiguous corpus as fully unassigned", () => {
    const map = buildDocumentMap([ambiguous("doc-1"), ambiguous("doc-2")]);

    expect(map.entries).toEqual([]);
    expect(map.assignedDocuments).toBe(0);
    expect(map.unassignedDocuments).toBe(2);
    expect(map.unassignedPercentage).toBe(100);
    expect(map.ambiguousPercentage).toBe(100);
    expect(map.clearPercentage).toBe(0);
  });

  it("accepts the Thread 24 Comprehension shape as its bucket source", () => {
    // The bucket flows from deriveComprehension (Thread 24). A MappedDocument is
    // a Comprehension's documentId + bucket, joined to the topic the classifier
    // assigned. No confidence value is read or carried (non-goal §8).
    const comprehension: Comprehension = {
      documentId: "doc-1",
      bucket: "clear",
      firedSignals: [],
    };
    const mapped: MappedDocument = {
      documentId: comprehension.documentId,
      topicId: "topic-security",
      bucket: comprehension.bucket,
    };

    const map = buildDocumentMap([mapped]);

    expect(byTopic(map.entries, "topic-security").count).toBe(1);
    expect(map.clearDocuments).toBe(1);
  });

  it("carries no confidence value — the map is counts and shares only", () => {
    const serialised = JSON.stringify(buildDocumentMap(corpus));

    expect(serialised).not.toContain("confidence");
    expect(serialised).not.toContain("score");
  });

  it("is pure — repeated computation returns the same map and mutates no input", () => {
    const snapshot = JSON.parse(JSON.stringify(corpus));

    const first = buildDocumentMap(corpus);
    const second = buildDocumentMap(corpus);

    expect(first).toEqual(second);
    expect(corpus).toEqual(snapshot);
  });
});
