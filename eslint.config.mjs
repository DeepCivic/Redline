import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "vendor/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // proc-domain must import no external packages. ESLint enforces "no
    // non-relative imports" in NON-TEST source only; test files legitimately
    // import vitest and (for the consumption spike) @rbrasier/domain. The
    // authoritative purity gate is validate.sh check #4 — this rule is the
    // fast in-editor echo of it.
    files: ["packages/proc-domain/src/**/*.ts"],
    ignores: ["packages/proc-domain/src/**/*.test.ts"],
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
                "proc-domain must have zero external imports — use relative paths only.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
