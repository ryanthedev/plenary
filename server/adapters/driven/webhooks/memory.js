// @ts-check
// Deterministic in-memory driven adapter for the WebhookDelivery port (#27).
// Records signed deliveries for tests and local development without network I/O.

import {
  signWebhookPayload,
  validateWebhookUrl,
} from "../../../ports/webhook-delivery.js";

/**
 * @typedef {{
 *   sub: import("../../../ports/webhook-delivery.js").WebhookSubscription,
 *   event: import("../../../ports/webhook-delivery.js").WebhookEvent,
 *   body: string,
 *   signature: string,
 *   headers: Record<string, string>,
 *   status: number,
 *   ok: boolean,
 *   deliveredAt: number,
 * }} RecordedWebhookDelivery
 */

/**
 * Create an in-memory webhook delivery adapter for deterministic tests.
 *
 * @param {{
 *   now?: () => number,
 *   validateUrls?: boolean,
 * }} [opts]
 */
export function memoryWebhookDelivery({
  now = () => Date.now(),
  validateUrls = true,
} = {}) {
  /** @type {RecordedWebhookDelivery[]} */
  const deliveries = [];
  /** @type {Map<string, { status: number, error: string, remaining: number }>} */
  const failures = new Map();

  /**
   * Deliver an event in memory, signing it identically to the HTTP adapter.
   * @param {import("../../../ports/webhook-delivery.js").WebhookSubscription} sub
   * @param {import("../../../ports/webhook-delivery.js").WebhookEvent} event
   * @returns {Promise<import("../../../ports/webhook-delivery.js").WebhookDeliveryResult>}
   */
  async function deliver(sub, event) {
    if (validateUrls) {
      const check = validateWebhookUrl(sub?.url);
      if (!check.ok) {
        return {
          ok: false,
          status: 0,
          attempts: 0,
          deliveredAt: now(),
          error: check.code,
          message: check.message,
        };
      }
    }

    const tsSec = Math.floor(now() / 1000);
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      data: event.data ?? {},
    });
    const signature = await signWebhookPayload(sub.secret, tsSec, body);
    const headers = {
      "content-type": "application/json",
      "user-agent": "Plenary-Webhooks/1.0",
      "x-plenary-signature": signature,
      "x-plenary-event": event.type,
      "x-plenary-delivery": event.id,
    };

    const fail = failures.get(sub.url);
    let status = 200;
    let ok = true;
    /** @type {string | undefined} */
    let error;
    if (fail && fail.remaining > 0) {
      fail.remaining -= 1;
      if (fail.remaining <= 0) failures.delete(sub.url);
      status = fail.status;
      ok = false;
      error = fail.error;
    }

    const deliveredAt = now();
    deliveries.push({ sub, event, body, signature, headers, status, ok, deliveredAt });

    return {
      ok,
      status,
      attempts: 1,
      deliveredAt,
      signature,
      ...(error ? { error } : {}),
    };
  }

  /**
   * Simulate a failure for a given URL for `times` deliveries.
   * @param {string} url
   * @param {{ status?: number, error?: string, times?: number }} [opts]
   */
  function setFailure(url, { status = 500, error = "upstream-5xx", times = 1 } = {}) {
    failures.set(url, { status, error, remaining: times });
  }

  function clear() {
    deliveries.length = 0;
    failures.clear();
  }

  return { deliver, deliveries, setFailure, clear };
}
