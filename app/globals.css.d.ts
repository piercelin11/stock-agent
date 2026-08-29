// tsconfig has `noUncheckedSideEffectImports: true`, which rejects
// `import "./globals.css"` unless the module is declared. See docs/PLAN.md §4.5.
declare module "*.css";
