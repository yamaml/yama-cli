// yama.js is a CLI entry point — it reads Deno.args and executes a command.
// It intentionally has no exports. This .d.ts tells JSR's fast-check
// analyzer exactly that, so the package is treated as a well-typed module
// rather than requiring TypeScript inference over the .js source.
export {};
