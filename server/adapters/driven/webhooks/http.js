// @ts-check
// HTTP driven adapter for the WebhookDelivery port (#27):
// - Signs every delivery with `X-Plenary-Signature: t=...,v1=...`
// - Enforces HTTPS-only + SSRF host guard and `redirect: "error"`
// - Enforces per-attempt request timeout
// - Retries on 5xx responses and transient network/timeout errors with backoff

import {
  signWebhookPayload,
  validateWebhookUrl,
} from "../../../ports/webhook-delivery.js";

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;
export const DEFAULT_WEBHOOK_MAX_RETRIES = 2;
export const DEFAULT_WEBHOOK_BACKOFF_MS = 200;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise(resolve => {
    const t = /** @type {any} */ (setTimeout(resolve, ms));
    t?.unref?.();
  });
}

/**
 * Create an HTTP webhook delivery adapter implementing `WebhookDeliveryPort`.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   baseBackoffMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} [opts]
 * @returns {import("../../../ports/webhook-delivery.js").WebhookDeliveryPort}
 */
export function httpWebhookDelivery({
  fetchImpl = fetch,
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  maxRetries = DEFAULT_WEBHOOK_MAX_RETRIES,
  baseBackoffMs = DEFAULT_WEBHOOK_BACKOFF_MS,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  /**
   * Deliver a single signed webhook event to `sub.url`.
   * @param {import("../../../ports/webhook-delivery.js").WebhookSubscription} sub
   * @param {import("../../../ports/webhook-delivery.js").WebhookEvent} event
   * @returns {Promise<import("../../../ports/webhook-delivery.js").WebhookDeliveryResult>}
   */
  async function deliver(sub, event) {
    const urlCheck = validateWebhookUrl(sub?.url);
    if (!urlCheck.ok) {
      return {
        ok: false,
        status: 0,
        attempts: 0,
        deliveredAt: now(),
        error: urlCheck.code,
        message: urlCheck.message,
      };
    }

    if (typeof sub?.secret !== "string" || !sub.secret) {
      return {
        ok: false,
        status: 0,
        attempts: 0,
        deliveredAt: now(),
        error: "missing-secret",
        message: "webhook subscription has no signing secret",
      };
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      data: event.data ?? {},
    });

    const totalAttempts = Math.max(1, 1 + Math.max(0, Math.floor(maxRetries)));
    let lastStatus = 0;
    let lastError = "delivery-failed";
    let lastMessage = "webhook delivery failed";
    let lastSignature = "";

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const tsSec = Math.floor(now() / 1000);
      lastSignature = await signWebhookPayload(sub.secret, tsSec, body);

      const ctl = new AbortController();
      const timer = /** @type {any} */ (setTimeout(() => ctl.abort(), timeoutMs));
      timer?.unref?.();

      try {
        const res = await fetchImpl(urlCheck.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Plenary-Webhooks/1.0",
            "x-plenary-signature": lastSignature,
            "x-plenary-event": event.type,
            "x-plenary-delivery": event.id,
          },
          body,
          redirect: "error",
          signal: ctl.signal,
        });
        if (res.body) res.body.cancel().catch(() => {});

        lastStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
          return {
            ok: true,
            status: res.status,
            attempts: attempt,
            deliveredAt: now(),
            signature: lastSignature,
          };
        }

        lastError = res.status >= 500 ? "upstream-5xx" : "upstream-4xx";
        lastMessage = `webhook endpoint responded with HTTP ${res.status}`;

        // Do not retry 4xx (or 3xx) responses; only retry 5xx.
        if (res.status < 500 || res.status >= 600) {
          return {
            ok: false,
            status: res.status,
            attempts: attempt,
            deliveredAt: now(),
            signature: lastSignature,
            error: lastError,
            message: lastMessage,
          };
        }
      } catch (err) {
        lastStatus = 0;
        if (ctl.signal.aborted) {
          lastError = "timeout";
          lastMessage = "webhook delivery timed out";
        } else {
          lastError = "network-error";
          lastMessage = err instanceof Error ? err.message : "network error";
        }
      } finally {
        clearTimeout(timer);
      }

      if (attempt < totalAttempts && baseBackoffMs > 0) {
        await sleep(baseBackoffMs * 2 ** (attempt - 1));
      }
    }

    return {
      ok: false,
      status: lastStatus,
      attempts: totalAttempts,
      deliveredAt: now(),
      signature: lastSignature,
      error: lastError,
      message: lastMessage,
    };
  }

  return { deliver };
}
