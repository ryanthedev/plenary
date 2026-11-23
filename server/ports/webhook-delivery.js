// @ts-check
// The WebhookDelivery port (#27): outbound signed HTTP webhook delivery.
//   deliver(sub, event)    deliver a signed event payload to a webhook subscription
//
// Shared port types and re-exported pure helpers only; no adapter code and no bare packages.
// Adapters (http.js, memory.js) import this module and never import each other.

import {
  WEBHOOK_EVENTS,
  signWebhookPayload,
  verifyWebhookSignature,
  validateWebhookUrl,
  validateWebhookSubscription,
} from "../core/webhooks.js";

export {
  WEBHOOK_EVENTS,
  signWebhookPayload,
  verifyWebhookSignature,
  validateWebhookUrl,
  validateWebhookSubscription,
};

/** The method names every WebhookDelivery adapter implements. */
export const WEBHOOK_DELIVERY_METHODS = Object.freeze(["deliver"]);

/**
 * @typedef {{
 *   id: string,
 *   tenant?: string,
 *   url: string,
 *   secret: string,
 *   events: readonly import("../core/webhooks.js").WebhookEventType[],
 *   active?: boolean,
 * }} WebhookSubscription
 */

/**
 * @typedef {{
 *   id: string,
 *   type: import("../core/webhooks.js").WebhookEventType,
 *   timestamp: number,
 *   data: Record<string, any>,
 * }} WebhookEvent
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   status: number,
 *   attempts: number,
 *   deliveredAt: number,
 *   signature?: string,
 *   error?: string,
 *   message?: string,
 * }} WebhookDeliveryResult
 */

/**
 * @typedef {{
 *   deliver(sub: WebhookSubscription, event: WebhookEvent): Promise<WebhookDeliveryResult>,
 * }} WebhookDeliveryPort
 */
