/** Card variable value that shows the stop button. */
export const STOP_ACTION_VISIBLE = "true";
/** Card variable value that hides the stop button. */
export const STOP_ACTION_HIDDEN = "false";

/** The v2 template ID that supports streaming via content key. */
const BUILTIN_TEMPLATE_ID =
  process.env.DINGTALK_CARD_TEMPLATE_ID || "5db37f25-ac9e-4250-9c1d-c4ddba6e16e9.schema";
/** Key for blockList updates via instances API (complex loopArray type). */
const BUILTIN_BLOCKLIST_KEY = "blockList";
/** Key for real-time streaming via streaming API (simple string type). */
const BUILTIN_STREAMING_KEY = "content";
/** Key for the plain text copy action variable (same as streaming key). */
const BUILTIN_COPY_KEY = "content";

export interface DingTalkCardTemplateContract {
  templateId: string;
  /** Key for blockList updates via instances API (complex loopArray type). */
  blockListKey: string;
  /** Key for real-time streaming via streaming API (simple string type). */
  streamingKey: string;
  /** Key for the plain text copy action variable. */
  copyKey: string;
  /** @deprecated Use blockListKey instead. Kept for backward compatibility. */
  contentKey: string;
}

/** Frozen singleton — no allocation on every call. */
export const DINGTALK_CARD_TEMPLATE: Readonly<DingTalkCardTemplateContract> = Object.freeze({
  templateId: BUILTIN_TEMPLATE_ID,
  blockListKey: BUILTIN_BLOCKLIST_KEY,
  streamingKey: BUILTIN_STREAMING_KEY,
  copyKey: BUILTIN_COPY_KEY,
  contentKey: BUILTIN_BLOCKLIST_KEY, // backward compatibility alias
});

// Legacy exports for backward compatibility
export const BUILTIN_DINGTALK_CARD_TEMPLATE_ID = BUILTIN_TEMPLATE_ID;
export const BUILTIN_DINGTALK_CARD_CONTENT_KEY = BUILTIN_BLOCKLIST_KEY;
