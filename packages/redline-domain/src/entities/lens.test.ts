import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import { makeTopic, type Topic } from "./topic";
import {
  MAX_TOPICS_PER_LENS,
  MIN_TOPICS_PER_LENS,
  makeLens,
} from "./lens";

const topic = (id: string, name: string): Topic => {
  const result = makeTopic({ id, name, definition: `${name} definition` });
  if (!isOk(result)) throw new Error("test fixture topic failed to build");
  return result.data;
};

const topics = (count: number): Topic[] =>
  Array.from({ length: count }, (_, index) => topic(`t${index}`, `Topic ${index}`));

describe("makeLens", () => {
  it("builds a lens, trimming the name and preserving topic order", () => {
    const result = makeLens({
      id: "lens-1",
      name: "  Tender comprehension  ",
      topics: [topic("t1", "Security"), topic("t2", "Support")],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.id).toBe("lens-1");
    expect(result.data.name).toBe("Tender comprehension");
    expect(result.data.topics.map((topic) => topic.id)).toEqual(["t1", "t2"]);
  });

  it("constructs with no evaluationId — a lens is evaluation-independent", () => {
    const result = makeLens({ id: "lens-1", name: "Tender comprehension", topics: topics(2) });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(Object.keys(result.data).sort()).toEqual(["id", "name", "topics"]);
    expect("evaluationId" in result.data).toBe(false);
  });

  it("fails when the id is blank", () => {
    const result = makeLens({ id: "   ", name: "Tender comprehension", topics: topics(2) });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the name is blank", () => {
    const result = makeLens({ id: "lens-1", name: "  ", topics: topics(2) });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails below the two-topic floor — a single-topic lens sorts nothing", () => {
    const result = makeLens({ id: "lens-1", name: "Tender comprehension", topics: topics(1) });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("accepts a lens at the two-topic floor", () => {
    const result = makeLens({
      id: "lens-1",
      name: "Tender comprehension",
      topics: topics(MIN_TOPICS_PER_LENS),
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics).toHaveLength(MIN_TOPICS_PER_LENS);
  });

  it("accepts a full lens at the Numbatch profile ceiling", () => {
    const result = makeLens({
      id: "lens-1",
      name: "Tender comprehension",
      topics: topics(MAX_TOPICS_PER_LENS),
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics).toHaveLength(MAX_TOPICS_PER_LENS);
  });

  it("fails when the lens exceeds the Numbatch profile ceiling", () => {
    const result = makeLens({
      id: "lens-1",
      name: "Tender comprehension",
      topics: topics(MAX_TOPICS_PER_LENS + 1),
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when two topics share an id", () => {
    const result = makeLens({
      id: "lens-1",
      name: "Tender comprehension",
      topics: [topic("dup", "Security"), topic("dup", "Support")],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("copies the topics so a later mutation of the caller's array cannot reach the lens", () => {
    const callerTopics = topics(2);
    const result = makeLens({ id: "lens-1", name: "Tender comprehension", topics: callerTopics });
    callerTopics.push(topic("t9", "Late arrival"));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics).toHaveLength(2);
  });
});
