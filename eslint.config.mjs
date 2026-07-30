import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // vendor/** is the materialised Wayfinder domain (typed reuse); services/**
    // are the upstream submodules — the Python engines and the Wayfinder fork
    // (ADR-0019). None of these are redline source we lint; the fork's apps/web
    // is linted by the fork's own ESLint config.
    ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "vendor/**", "services/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // redline-domain must import no external packages. ESLint enforces "no
    // non-relative imports" in NON-TEST source only; test files legitimately
    // import vitest and (for the consumption spike) @rbrasier/domain. The
    // authoritative purity gate is validate.sh check #4 — this rule is the
    // fast in-editor echo of it.
    files: ["packages/redline-domain/src/**/*.ts"],
    ignores: ["packages/redline-domain/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Match bare and scoped specifiers, i.e. anything that does not
              // start with "." or "/". Relative imports are allowed.
              regex: "^[^./]",
              message:
                "redline-domain must have zero external imports — use relative paths only.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
