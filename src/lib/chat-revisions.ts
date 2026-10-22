import type { ChatMessage, Conversation, DocumentAttachment, ImageAttachment } from "../types.ts";

export type ChatRevisionKind = "edit" | "regenerate";

export interface ChatRevisionIntent {
  kind: ChatRevisionKind;
  targetMessageId: string;
}

export interface ChatRevisionPlan {
  kind: ChatRevisionKind;
  sourceConversationId: string;
  sourceTitle: string;
  targetMessageId: string;
  branchId: string;
  prefixMessages: ChatMessage[];
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

interface PrepareRevisionOptions {
  content: string;
  branchId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: number;
  attachment?: ImageAttachment;
  document?: DocumentAttachment;
}

function revisionTarget(conversation: Conversation, intent: ChatRevisionIntent) {
  const targetIndex = conversation.messages.findIndex((message) => message.id === intent.targetMessageId);
  if (targetIndex < 0) return null;
  if (intent.kind === "edit") {
    const target = conversation.messages[targetIndex];
    if (target.role !== "user") return null;
    return { targetIndex, question: target };
  }
  if (targetIndex < 1 || conversation.messages[targetIndex].role !== "assistant") return null;
  const question = conversation.messages[targetIndex - 1];
  if (question.role !== "user") return null;
  return { targetIndex: targetIndex - 1, question };
}

/**
 * Creates an immutable revision plan. Nothing in the source conversation is
 * removed here: the prefix is only the context sent to the next request.
 */
export function prepareChatRevision(
  conversation: Conversation,
  intent: ChatRevisionIntent,
  options: PrepareRevisionOptions,
): ChatRevisionPlan | null {
  const located = revisionTarget(conversation, intent);
  if (!located) return null;
  const content = options.content.trim();
  if (!content) return null;
  const originalQuestion = located.question;
  const userMessage: ChatMessage = {
    id: options.userMessageId,
    role: "user",
    content,
    createdAt: options.createdAt,
    attachment: options.attachment ?? originalQuestion.attachment,
    document: options.document ?? originalQuestion.document,
  };
  return {
    kind: intent.kind,
    sourceConversationId: conversation.id,
    sourceTitle: conversation.title,
    targetMessageId: intent.targetMessageId,
    branchId: options.branchId,
    prefixMessages: conversation.messages.slice(0, located.targetIndex).map((message) => ({ ...message })),
    userMessage,
    assistantMessage: {
      id: options.assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: options.createdAt + 1,
      pending: true,
    },
  };
}

export function revisionOutboundMessages(plan: ChatRevisionPlan) {
  return [...plan.prefixMessages, plan.userMessage].map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.attachment ? { attachmentId: message.attachment.id } : {}),
    ...(message.document ? { documentId: message.document.id } : {}),
  }));
}

/** A resumed run may already have a continuation button in the copied prefix. */
export function disableResumedRunInRevision(plan: ChatRevisionPlan, resumedFrom?: string | null): ChatRevisionPlan {
  if (!resumedFrom) return plan;
  return {
    ...plan,
    prefixMessages: plan.prefixMessages.map((message) => (
      message.runId === resumedFrom ? { ...message, continuable: false } : message
    )),
  };
}

/**
 * Preserve an interrupted revision only when it genuinely has a continuation
 * path. The returned message is suitable for an atomic, visible branch.
 */
export function recoverableRevisionAssistant(
  assistant: ChatMessage,
  fallback: string,
): ChatMessage | null {
  if (!assistant.continuable || !assistant.runId) return null;
  return {
    ...assistant,
    content: assistant.content.trim() ? assistant.content : fallback,
    pending: false,
    error: true,
  };
}

export function revisionBlocksConversationMutation(
  revisionSourceId: string | null | undefined,
  conversationId: string,
) {
  return revisionSourceId === conversationId;
}

export function continuationReasonForStop(stopReason: string | undefined | null) {
  if (stopReason === "truncated") return "truncated" as const;
  if (stopReason === "max-rounds" || stopReason === "stuck") return "rounds" as const;
  return null;
}

export function shouldEnrichRevisionResult(
  isRevision: boolean,
  stopReason: string | undefined | null,
) {
  return !isRevision || continuationReasonForStop(stopReason) === null;
}

/** Builds the successful branch without mutating the source conversation. */
export function commitChatRevision(
  source: Conversation,
  plan: ChatRevisionPlan,
  completedAssistant: ChatMessage,
  committedAt: number,
): Conversation {
  if (source.id !== plan.sourceConversationId) throw new Error("Revision source changed.");
  return {
    ...source,
    id: plan.branchId,
    title: `${plan.sourceTitle}（分支）`,
    titleAuto: true,
    messages: [
      ...plan.prefixMessages.map((message) => ({ ...message })),
      { ...plan.userMessage },
      { ...completedAssistant, pending: false },
    ],
    createdAt: committedAt,
    updatedAt: committedAt,
    pinned: false,
    archived: false,
    deletedAt: undefined,
    branchedFrom: { conversationId: source.id, title: source.title },
  };
}
