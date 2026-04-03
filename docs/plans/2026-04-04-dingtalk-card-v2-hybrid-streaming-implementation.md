# AI Card v2 Hybrid Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement hybrid streaming approach for DingTalk AI Card v2 template. Use streaming API for simple string keys (`content`) and instances API for complex loopArray keys (`blockList`). Support `cardRealTimeStream` config to enable/disable real-time answer preview.

**Architecture:**
- Template ID: `5db37f25-ac9e-4250-9c1d-c4ddba6e16e9.schema` (supports streaming API for `content` key)
- **Simple string keys** (`content`, `taskInfo`) → streaming API (`PUT /v1.0/card/streaming`)
- **Complex loopArray keys** (`blockList`) → instances API (`PUT /v1.0/card/instances`)
- When `cardRealTimeStream=true`: stream answer to `content` for real-time display, clear at block boundaries and commit to `blockList`
- When `cardRealTimeStream=false`: all updates go directly to `blockList` via instances API

**Tech Stack:** TypeScript, Vitest, DingTalk Card API, `apply_patch`, `pnpm`

---

## Reference Spec

- `docs/spec/2026-03-30-card-template-v2-design.md`
- `docs/plans/2026-04-03-card-v2-implementation-handoff.md` (API compatibility findings)

## File Map

- Modify: `src/card/card-template.ts`
  - Update template ID, add `blockListKey`/`streamingKey` fields for clarity
- Modify: `src/card-service.ts`
  - Add `updateAICardBlockList()` for instances API updates
  - Add `streamAICardContent()` for real-time content streaming
  - Add `commitAICardBlocks()` for final block commit with copy content
  - Refactor `createAICard` kick to use streaming key
  - Refactor `streamAICard` to use hybrid approach
- Modify: `src/card-draft-controller.ts`
  - Add `realTimeStreamEnabled` parameter
  - Add dual-path output: streaming content + instances API for blockList
  - Handle content clear at block boundaries
- Modify: `src/reply-strategy-card.ts`
  - Pass `realTimeStreamEnabled` to controller
  - Minor finalize update for content clearing
- Modify: `tests/unit/card-draft-controller.test.ts`
  - Test dual-path output logic
- Modify: `tests/unit/reply-strategy-card.test.ts`
  - Test `cardRealTimeStream=true/false` modes
- Modify: `tests/unit/card-service.test.ts`
  - Test new functions and hybrid API routing

## Hard Boundaries

- Do NOT change `draft-stream-loop.ts` — it's a generic throttled loop that works with any callback
- Do NOT change `card-callback-service.ts` — `updateCardVariables` already uses instances API correctly
- Do NOT change the public interface of `CardDraftController` (only add new optional methods)
- Do NOT introduce new dependencies
- Do NOT change behavior for `messageType: "markdown"` mode

---

## Task 1: Update Card Template Configuration

**Files:**
- Modify: `src/card/card-template.ts`

- [ ] **Step 1: Update template ID and add new key fields**

Change template ID to the new tested template and clarify key naming:

```typescript
/** Card variable value that shows the stop button. */
export const STOP_ACTION_VISIBLE = "true";
/** Card variable value that hides the stop button. */
export const STOP_ACTION_HIDDEN = "false";

/** The v2 template ID that supports streaming via content key. */
const BUILTIN_TEMPLATE_ID = "5db37f25-ac9e-4250-9c1d-c4ddba6e16e9.schema";
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
```

- [ ] **Step 2: Run type-check to verify no breaking changes**

```bash
pnpm run type-check
```

The `contentKey` alias ensures backward compatibility with existing code that references `template.contentKey`.

---

## Task 2: Add New Card Service Functions

**Files:**
- Modify: `src/card-service.ts`

- [ ] **Step 1: Add `updateAICardBlockList` function**

Add a function that updates `blockList` via instances API (reuses existing `updateCardVariables`):

```typescript
/**
 * Update blockList via PUT /v1.0/card/instances API.
 * Required because streaming API returns 500 for complex loopArray types.
 */
export async function updateAICardBlockList(
  card: AICardInstance,
  blockListJson: string,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    log?.debug?.(
      `[DingTalk][AICard] Skip blockList update because card already terminal: outTrackId=${card.cardInstanceId} state=${card.state}`,
    );
    return;
  }

  const template = DINGTALK_CARD_TEMPLATE;
  const params: Record<string, unknown> = {
    [template.blockListKey]: blockListJson,
  };

  try {
    await updateCardVariables(
      card.outTrackId || card.cardInstanceId,
      params,
      card.accessToken,
      card.config,
    );
    card.lastStreamedContent = blockListJson;
    card.lastUpdated = Date.now();
    incrementCardDapiCount(card);
    if (card.state === AICardStatus.PROCESSING) {
      card.state = AICardStatus.INPUTING;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error?.(`[DingTalk][AICard] BlockList update failed: ${message}`);
    throw err;
  }
}
```

- [ ] **Step 2: Add `streamAICardContent` function**

Add a function for streaming to the `content` key (simple string type):

```typescript
/**
 * Stream answer text to content key for real-time display.
 * Only used when cardRealTimeStream=true.
 * Uses streaming API because content is a simple string type.
 */
export async function streamAICardContent(
  card: AICardInstance,
  text: string,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  const template = DINGTALK_CARD_TEMPLATE;
  await putAICardStreamingField(card, template.streamingKey, text, false, log);
}
```

- [ ] **Step 3: Add `clearAICardStreamingContent` function**

Add a function to clear the streaming content at block boundaries:

```typescript
/**
 * Clear the streaming content key.
 * Called when transitioning from streaming to blockList commit.
 */
export async function clearAICardStreamingContent(
  card: AICardInstance,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  const template = DINGTALK_CARD_TEMPLATE;
  try {
    await putAICardStreamingField(card, template.streamingKey, "", false, log);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.debug?.(`[DingTalk][AICard] Non-critical: failed to clear streaming content: ${message}`);
  }
}
```

- [ ] **Step 4: Add `commitAICardBlocks` function**

Add a function that combines blockList update with content sync for finalize:

```typescript
/**
 * Commit blocks to blockList via instances API.
 * On finalize, also syncs content for copy action.
 */
export async function commitAICardBlocks(
  card: AICardInstance,
  blockListJson: string,
  isFinalize: boolean,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }

  const template = DINGTALK_CARD_TEMPLATE;

  // On finalize, write content for copy action first
  if (isFinalize) {
    const plainTextContent = extractAnswerTextFromBlockContent(blockListJson);
    if (plainTextContent.trim()) {
      try {
        await putAICardStreamingField(card, template.streamingKey, plainTextContent, false, log);
      } catch (contentErr: unknown) {
        const message = contentErr instanceof Error ? contentErr.message : String(contentErr);
        log?.debug?.(`[DingTalk][AICard] Non-critical: failed to sync content for copy: ${message}`);
      }
    }
  }

  // Update blockList via instances API
  await updateAICardBlockList(card, blockListJson, log);

  if (isFinalize) {
    card.state = AICardStatus.FINISHED;
    removePendingCard(card, log);
  }
}
```

- [ ] **Step 5: Update `createAICard` kick**

Find the kick section (around line 861) and change from `contentKey` to `streamingKey`:

```typescript
// OLD:
await putAICardStreamingField(aiCardInstance, template.contentKey, "[]", false, log);

// NEW:
await putAICardStreamingField(aiCardInstance, template.streamingKey, "", false, log);
```

- [ ] **Step 6: Update `streamAICard` to use hybrid approach**

Refactor `streamAICard` to use `commitAICardBlocks`:

```typescript
export async function streamAICard(
  card: AICardInstance,
  content: string,  // blockList JSON
  finished: boolean = false,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    log?.debug?.(
      `[DingTalk][AICard] Skip stream update because card already terminal: outTrackId=${card.cardInstanceId} state=${card.state}`,
    );
    return;
  }

  try {
    await commitAICardBlocks(card, content, finished, log);
  } catch (err: unknown) {
    card.state = AICardStatus.FAILED;
    card.lastUpdated = Date.now();
    removePendingCard(card, log);

    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("500") || message.includes("unknownError")) {
      const errorMsg =
        "⚠️ **[DingTalk] AI Card 串流更新失败**\n\n"
        + "当前及后续消息将自动回退为 Markdown 发送。";
      await sendTemplateMismatchNotification(card, errorMsg, log);
    }
    throw err;
  }
}
```

- [ ] **Step 7: Run type-check and fix any issues**

```bash
pnpm run type-check
```

---

## Task 3: Update Card Draft Controller for Dual-Path Output

**Files:**
- Modify: `src/card-draft-controller.ts`

- [ ] **Step 1: Update factory parameters**

Add `realTimeStreamEnabled` parameter:

```typescript
export function createCardDraftController(params: {
    card: AICardInstance;
    throttleMs?: number;
    verboseMode?: boolean;
    /** Enable real-time streaming to content key. */
    realTimeStreamEnabled?: boolean;
    log?: Logger;
}): CardDraftController
```

- [ ] **Step 2: Add streaming content tracking**

Add state for tracking streaming content:

```typescript
// Inside createCardDraftController function body:
const realTimeStreamEnabled = params.realTimeStreamEnabled ?? false;
let hasStreamingContent = false;
```

- [ ] **Step 3: Add streaming content helper functions**

Add internal helpers for content streaming:

```typescript
const streamContent = async (text: string) => {
  if (!realTimeStreamEnabled) {
    return;
  }
  try {
    await streamAICardContent(params.card, text, params.log);
    hasStreamingContent = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    params.log?.debug?.(`[DingTalk][AICard] Failed to stream content: ${message}`);
  }
};

const clearStreamingContent = async () => {
  if (!realTimeStreamEnabled || !hasStreamingContent) {
    return;
  }
  try {
    await clearAICardStreamingContent(params.card, params.log);
    hasStreamingContent = false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    params.log?.debug?.(`[DingTalk][AICard] Failed to clear streaming content: ${message}`);
  }
};
```

- [ ] **Step 4: Update imports**

Add new imports at the top of the file:

```typescript
import {
  streamAICardContent,
  clearAICardStreamingContent,
  updateAICardBlockList,
} from "./card-service";
```

- [ ] **Step 5: Update `queueRender` for dual-path**

Modify `queueRender` to also stream content when in real-time mode:

```typescript
const queueRender = () => {
    const blocks = renderTimeline();

    // Stream to content key for real-time display (if enabled and has active answer)
    if (realTimeStreamEnabled && activeAnswerIndex !== null) {
        const currentAnswer = timelineEntries[activeAnswerIndex]?.text || "";
        void streamContent(currentAnswer);
    }

    // Always update blockList via instances API (throttled)
    if (blocks.length > 0) {
        loop.update(JSON.stringify(blocks));
        return;
    }
    loop.resetPending();
};
```

- [ ] **Step 6: Update `flushBoundaryFrame` to clear content**

Modify boundary flush to clear streaming content first:

```typescript
const flushBoundaryFrame = async () => {
    if (stopped || failed) {
        return;
    }
    // Clear streaming content before committing blockList at boundary
    if (hasStreamingContent) {
        await clearStreamingContent();
    }
    await loop.flush();
    await loop.waitForInFlight();
    loop.resetThrottleWindow();
};
```

- [ ] **Step 7: Update `createDraftStreamLoop` callback**

Change the callback to use `updateAICardBlockList`:

```typescript
const loop = createDraftStreamLoop({
    throttleMs: effectiveThrottleMs,
    isStopped: () => stopped || failed,
    sendOrEditStreamMessage: async (content: string) => {
        try {
            // Use instances API for blockList (not streaming API)
            await updateAICardBlockList(params.card, content, params.log);
            lastSentContent = content;
            lastAnswerContent = getFinalAnswerContent();
        } catch (err: unknown) {
            failed = true;
            const message = err instanceof Error ? err.message : String(err);
            params.log?.warn?.(`[DingTalk][AICard] BlockList update failed: ${message}`);
        }
    },
    onEveryNSends: (_count, content) => {
        updatePendingCardLastContent(params.card, content, params.log);
    },
    persistInterval: 5,
});
```

- [ ] **Step 8: Add new methods to controller interface**

Add optional methods to the returned controller object:

```typescript
return {
    // ... existing methods ...

    /** Stream answer text to content key for real-time display. Only available when realTimeStreamEnabled=true. */
    streamContent: realTimeStreamEnabled ? streamContent : undefined,

    /** Clear the streaming content key. Only available when realTimeStreamEnabled=true. */
    clearStreamingContent: realTimeStreamEnabled ? clearStreamingContent : undefined,

    /** Whether real-time streaming is enabled. */
    isRealTimeStreamEnabled: () => realTimeStreamEnabled,
};
```

- [ ] **Step 9: Run type-check and fix any issues**

```bash
pnpm run type-check
```

---

## Task 4: Update Reply Strategy Card

**Files:**
- Modify: `src/reply-strategy-card.ts`

- [ ] **Step 1: Pass `realTimeStreamEnabled` to controller**

Update the controller creation to pass the config option:

```typescript
const controller = createCardDraftController({
  card,
  log,
  realTimeStreamEnabled: config.cardRealTimeStream ?? false,
});
```

- [ ] **Step 2: Update `finalize` to clear streaming content**

Add content clearing before final commit:

```typescript
async finalize(): Promise<void> {
  // ... existing early returns ...

  // Clear any remaining streaming content before final commit
  if (controller.isRealTimeStreamEnabled() && controller.clearStreamingContent) {
    await controller.clearStreamingContent();
  }

  await controller.flush();
  await controller.waitForInFlight();

  // ... rest of finalize logic ...
}
```

- [ ] **Step 3: Run type-check**

```bash
pnpm run type-check
```

---

## Task 5: Update Unit Tests

**Files:**
- Modify: `tests/unit/card-draft-controller.test.ts`
- Modify: `tests/unit/reply-strategy-card.test.ts`
- Modify: `tests/unit/card-service.test.ts`

- [ ] **Step 1: Add tests for `updateAICardBlockList`**

Add tests in `card-service.test.ts`:

```typescript
describe("updateAICardBlockList", () => {
  it("should call updateCardVariables with blockList key", async () => {
    // ... test implementation
  });

  it("should skip update when card is in terminal state", async () => {
    // ... test implementation
  });
});
```

- [ ] **Step 2: Add tests for dual-path controller**

Add tests in `card-draft-controller.test.ts`:

```typescript
describe("with realTimeStreamEnabled=true", () => {
  it("should stream content to streaming key", async () => {
    // ... test implementation
  });

  it("should clear content at block boundaries", async () => {
    // ... test implementation
  });
});
```

- [ ] **Step 3: Add tests for reply strategy integration**

Add tests in `reply-strategy-card.test.ts`:

```typescript
describe("cardRealTimeStream config", () => {
  it("should enable real-time streaming when config is true", async () => {
    // ... test implementation
  });

  it("should disable real-time streaming when config is false", async () => {
    // ... test implementation
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
pnpm test
```

---

## Task 6: Integration Testing

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
pnpm run type-check
pnpm run lint
```

- [ ] **Step 2: Manual testing with real DingTalk app**

Test scenarios:
1. `cardRealTimeStream=false`: Verify think/tool/answer blocks appear via instances API
2. `cardRealTimeStream=true`: Verify answer streams to content key in real-time
3. Block boundary: Verify content clears and answer commits to blockList
4. Finalize: Verify blockList has final content, content key has full answer for copy

---

## Verification Checklist

- [ ] Template ID updated to `5db37f25-ac9e-4250-9c1d-c4ddba6e16e9.schema`
- [ ] `blockList` updates use instances API (`updateCardVariables`)
- [ ] `content` updates use streaming API (`putAICardStreamingField`)
- [ ] `cardRealTimeStream=true` enables real-time content streaming
- [ ] Block boundaries clear content and commit to blockList
- [ ] Finalize writes full answer to content for copy action
- [ ] All existing tests pass
- [ ] New tests cover dual-path logic
- [ ] Type-check passes
- [ ] Lint passes
