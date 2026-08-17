import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      // Vendored Foundry dependencies (git submodules). OpenZeppelin ships its own
      // eslint.config.mjs, which ESLint would otherwise try to load — and fail on, since its
      // plugins are not installed here. Solidity is linted by `forge build`/`forge fmt` instead.
      "packages/contracts/lib/**",
      "packages/contracts/out/**",
      "packages/contracts/cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts outside a TypeScript package's own tsconfig (e.g. the README
    // generator, packages/console's dual-process dev launcher) — no @types/node ambient
    // declarations reach here, so `no-undef` needs the Node globals stated explicitly rather
    // than picking them up implicitly the way TS files do.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  prettier,
);
