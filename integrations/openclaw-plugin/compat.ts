/**
 * Phase 8 OpenClaw host compatibility declaration (Finding D).
 *
 * The plugin API surface used here (approval-param snapshot behavior,
 * `ctx.requester` fields, tool-factory `requesterSenderId`/`nativeChannelId`,
 * multi-account `accountId`, account-scoped approver fencing, native approval)
 * was verified ONLY against the OpenClaw plugin SDK `2026.9.4` docs.
 *
 * Do NOT advertise a broader lower bound without concrete, authoritative,
 * version-specific evidence for every one of those APIs. The package metadata
 * must stay exactly aligned with `OPENCLAW_VERIFIED_VERSION` (there is a
 * manifest/compat drift test guarding this).
 */
export const OPENCLAW_VERIFIED_VERSION = '2026.9.4';

/**
 * The smallest legally-expressible verified requirement. OpenClaw compatibility
 * metadata is exact-pinned to the version that was actually verified.
 */
export const OPENCLAW_VERIFIED_RANGE = OPENCLAW_VERIFIED_VERSION;
