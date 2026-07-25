import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import { makeTopic } from "./topic";

const validTopicInput = (overrides: Partial<{ id: string; name: string; definition: string }> = {}) => ({
  id: "topic-security",
  name: "  Security  ",
  definition: "  Controls that protect data confidentiality and integrity.  ",
  ...overrides,
});

describe("makeTopic", () => {
  it("builds a topic, trimming name and definition", () => {
    const result = makeTopic(validTopicInput());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.id).toBe("topic-security");
    expect(result.data.name).toBe("Security");
    expect(result.data.definition).toBe("Controls that protect data confidentiality and integrity.");
  });

  it("builds a topic with no evaluation binding", () => {
    const result = makeTopic(validTopicInput());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(Object.keys(result.data).sort()).toEqual(["definition", "id", "name"]);
  });

  it("fails when the id is blank", () => {
    const result = makeTopic(validTopicInput({ id: "   " }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the name is blank", () => {
    const result = makeTopic(validTopicInput({ name: "  " }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the definition is blank", () => {
    const result = makeTopic(validTopicInput({ definition: "   " }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
