import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      // site/'s build output — named "public/", not "dist/", specifically to avoid conflating
      // this package's own tsc output with the deployable static site (see build.ts's own
      // comment) — so it needs its own ignore entry rather than being covered by **/dist/**.
      "site/public/**",
      // Vendored Foundry dependencies (git submodules). OpenZeppelin ships its own
      // eslint.config.mjs, which ESLint would otherwise try to load — and fail on, since its
      // plugins are not installed here. Solidity is linted by `forge build`/`forge fmt` instead.
      "packages/contracts/lib/**",
      "packages/contracts/out/**",
      "packages/contracts/cache/**",
      // marketing/ is a separately toolchained Astro project (npm, not a pnpm workspace member)
      // with its own eslint.config.js and its own `npm run lint` gate. ESLint's flat config
      // discovers nested config files, so without this the root `eslint .` finds and tries to
      // load marketing/eslint.config.js's plugins (e.g. eslint-plugin-astro), which are only
      // installed in marketing/node_modules, never here.
      "marketing/**",
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
  {
    // site/'s only browser-executed TypeScript (everything else in this repo runs in Node or a
    // Cloudflare Worker) — no @types/node ambient globals apply here, and this file's own
    // tsconfig.json's "DOM" lib addition only affects type-checking, not eslint's separate
    // no-undef scope analysis, so the browser globals it actually uses need stating explicitly.
    files: ["site/src/client/**/*.ts"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly" },
    },
  },
  prettier,
);
