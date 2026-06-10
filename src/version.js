/**
 * @fileoverview Single source of truth for the YAMA CLI version string.
 *
 * Keep this in sync with `deno.json`'s `version` field. Modules that
 * print or stamp a version (CLI banner, generated package README)
 * import from here instead of hardcoding their own copies.
 *
 * @module version
 */

/** The YAMA CLI version, mirroring deno.json. */
export const VERSION = "1.2.0";
