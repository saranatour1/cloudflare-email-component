const base = "https://api.cloudflare.com/client/v4";

type Answer = {
  success?: boolean;
  result?: unknown;
  result_info?: { cursor?: string };
  errors?: { message: string }[];
};

const request = async (path: string, token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(base + path, { ...init, headers });
  const body = (await res.json().catch(() => null)) as Answer | null;
  return { ok: res.ok && !!body?.success, body };
};

const call = async (path: string, token: string) => {
  const { ok, body } = await request(path, token);
  return ok ? (body?.result ?? null) : undefined;
};

const reasonOf = (body: Answer | null) =>
  body?.errors?.map((e) => e.message).join("; ") || "Cloudflare said no.";

const must = async (path: string, token: string, init: RequestInit) => {
  const { ok, body } = await request(path, token, init);
  if (!ok) throw new Error(reasonOf(body));
  return body?.result;
};

export const tokenStatus = async (accountId: string, token: string) => {
  // Account-owned tokens verify under the account, user tokens under /user.
  for (const path of [
    `/accounts/${accountId}/tokens/verify`,
    "/user/tokens/verify",
  ]) {
    const result = (await call(path, token)) as { status?: string } | undefined;
    if (result) return result.status ?? "invalid";
  }
  return "invalid";
};

export const zoneNamesOf = (domain: string) => {
  const parts = domain.toLowerCase().split(".");
  return parts.slice(0, -1).map((_, i) => parts.slice(i).join("."));
};

const findZone = async (domain: string, token: string) => {
  for (const name of zoneNamesOf(domain)) {
    const zones = (await call(
      `/zones?name=${encodeURIComponent(name)}`,
      token,
    )) as { id: string }[] | undefined;
    if (zones?.[0]) return zones[0].id;
  }
};

export const accessOf = async (
  accountId: string,
  token: string,
  domain: string,
) => {
  const zoneId = await findZone(domain, token);
  const [workers, routing, subdomains] = await Promise.all([
    call(`/accounts/${accountId}/workers/scripts`, token),
    zoneId ? call(`/zones/${zoneId}/email/routing/rules`, token) : undefined,
    zoneId
      ? call(`/zones/${zoneId}/email/sending/subdomains`, token)
      : undefined,
  ]);
  return {
    zoneId,
    access: {
      sending: Array.isArray(subdomains)
        ? (subdomains as { name: string; enabled: boolean }[]).some(
            (s) =>
              s.enabled &&
              (s.name === domain ||
                s.name === `*.${domain.split(".").slice(1).join(".")}`),
          )
        : undefined,
      workers: workers !== undefined,
      routing: routing !== undefined,
      zone: zoneId !== undefined,
    },
  };
};

export const routingEnabled = async (zoneId: string, token: string) =>
  (
    (await call(`/zones/${zoneId}/email/routing`, token)) as
      | { enabled?: boolean }
      | undefined
  )?.enabled;

// A 403 means the person turned receiving off, so the sender hears it was turned away unless
// there's somewhere to forward it. Anything else throws, which Cloudflare treats as a
// temporary failure.
export const inboundWorker = `export default {
  async email(message, env) {
    const res = await fetch(env.INBOUND_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.SECRET,
        "Content-Type": "message/rfc822",
        "X-Envelope-From": message.from,
        "X-Envelope-To": message.to,
      },
      body: await new Response(message.raw).arrayBuffer(),
    })
    if (res.status === 403 && !env.FORWARD_TO)
      return message.setReject("This address isn't accepting mail right now.")
    if (!res.ok && res.status !== 403)
      throw new Error("The app didn't take the message: " + res.status)
    if (env.FORWARD_TO)
      await message.forward(env.FORWARD_TO).catch((e) => console.error("Forward failed: " + e))
  },
}
`;

const putWorker = (
  accountId: string,
  token: string,
  name: string,
  source: string,
  bindings: { type: string; name: string; text: string }[],
) => {
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      bindings,
    }),
  );
  form.append(
    "worker.js",
    new Blob([source], { type: "application/javascript+module" }),
    "worker.js",
  );
  return must(`/accounts/${accountId}/workers/scripts/${name}`, token, {
    method: "PUT",
    body: form,
  });
};

export const uploadWorker = (
  accountId: string,
  token: string,
  name: string,
  vars: { inboundUrl: string; secret: string; forwardTo?: string | undefined },
) =>
  putWorker(accountId, token, name, inboundWorker, [
    { type: "plain_text", name: "INBOUND_URL", text: vars.inboundUrl },
    { type: "secret_text", name: "SECRET", text: vars.secret },
    ...(vars.forwardTo
      ? [{ type: "plain_text", name: "FORWARD_TO", text: vars.forwardTo }]
      : []),
  ]);

export const ruleFor = async (
  zoneId: string,
  token: string,
  address: string,
) => {
  const rules = (await call(
    `/zones/${zoneId}/email/routing/rules?per_page=50`,
    token,
  )) as
    | {
        id: string;
        enabled?: boolean;
        matchers?: { type?: string; value?: string }[];
        actions?: { type?: string; value?: string[] }[];
      }[]
    | undefined;
  const found = rules?.find(
    (r) =>
      r.enabled !== false &&
      r.matchers?.some(
        (m) =>
          m.type === "literal" &&
          m.value?.toLowerCase() === address.toLowerCase(),
      ),
  );
  if (!found) return undefined;
  const forward = found.actions?.find((a) => a.type === "forward");
  return { id: found.id, forwardsTo: forward?.value?.[0] };
};

export const createRule = async (
  zoneId: string,
  token: string,
  address: string,
  worker: string,
  name = "Convex Cloudflare Email",
) =>
  (
    (await must(`/zones/${zoneId}/email/routing/rules`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [worker] }],
      }),
    })) as { id: string }
  ).id;

export const removeInbound = async (
  accountId: string,
  zoneId: string,
  token: string,
  worker: string,
  ruleId: string,
  aliasRules: string[] = [],
) => {
  for (const id of [ruleId, ...aliasRules].filter(Boolean))
    await request(`/zones/${zoneId}/email/routing/rules/${id}`, token, {
      method: "DELETE",
    });
  await request(`/accounts/${accountId}/workers/scripts/${worker}`, token, {
    method: "DELETE",
  });
};

/** For keeping a Worker's secret as a hash and comparing what it sends without leaking timing. */
export const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** For the base64 `content` of an attachment, such as a file from `ctx.storage`. */
export const toBase64 = (bytes: ArrayBuffer) => {
  let binary = "";
  // In pieces: spreading a whole file into one call overflows the stack.
  const all = new Uint8Array(bytes);
  for (let i = 0; i < all.length; i += 8192)
    binary += String.fromCharCode(...all.subarray(i, i + 8192));
  return btoa(binary);
};

type SuppressionScope =
  | { type: "account" }
  | { type: "sending_domain"; value: string };

export type Suppression = {
  id: string;
  email: string;
  reason: "manual" | "complaint" | "hard_bounce" | "soft_bounce" | "policy";
  read_only: boolean;
  created_at: string;
  expires_at: string | null;
  note?: string | null;
  scope?: SuppressionScope;
};

type NewSuppression = {
  email: string;
  expires_at?: string | null;
  note?: string;
  scope?: SuppressionScope;
};

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** One page, plus the `cursor` for the next. Check `read_only` before changing an entry. */
export const listSuppressions = async (
  accountId: string,
  token: string,
  filter: {
    email?: string;
    reason?: Suppression["reason"];
    scope_type?: SuppressionScope["type"];
    scope_value?: string;
    search?: string;
    per_page?: number;
    cursor?: string;
  } = {},
) => {
  const query = new URLSearchParams(
    Object.entries(filter).map(([key, value]) => [key, String(value)]),
  );
  const { ok, body } = await request(
    `/accounts/${accountId}/email/sending/suppressions?${query.toString()}`,
    token,
  );
  if (!ok) throw new Error(reasonOf(body));
  return {
    suppressions: body?.result as Suppression[],
    cursor: body?.result_info?.cursor,
  };
};

/** Stops mail to an address, such as after an unsubscribe. Account-wide unless `scope` says otherwise. */
export const addSuppression = async (
  accountId: string,
  token: string,
  suppression: NewSuppression,
) =>
  (await must(
    `/accounts/${accountId}/email/sending/suppressions`,
    token,
    json("POST", suppression),
  )) as Pick<Suppression, "id" | "scope">;

/** At most 1,000 entries and 10 calls a minute. */
export const importSuppressions = (
  accountId: string,
  token: string,
  items: NewSuppression[],
) =>
  must(
    `/accounts/${accountId}/email/sending/suppressions/bulk`,
    token,
    json("POST", { items }),
  );

/** Can't change the scope: delete the entry and add a new one. */
export const updateSuppression = async (
  accountId: string,
  token: string,
  id: string,
  changes: { expires_at?: string | null; note?: string },
) =>
  (await must(
    `/accounts/${accountId}/email/sending/suppressions/${id}`,
    token,
    json("PATCH", changes),
  )) as Suppression;

/** Lets mail reach the address again, so only do it once they've opted back in. */
export const deleteSuppression = (
  accountId: string,
  token: string,
  id: string,
) =>
  must(`/accounts/${accountId}/email/sending/suppressions/${id}`, token, {
    method: "DELETE",
  });

// Throwing makes Queues retry the whole batch, then move it to the dead letter queue.
export const eventsWorker = `export default {
  async queue(batch, env) {
    const res = await fetch(env.EVENTS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch.messages.map((message) => message.body)),
    })
    if (!res.ok) throw new Error("The app didn't take the events: " + res.status)
  },
}
`;

const deliveryEventNames = [
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
];

type DeliveryEventsSetup = {
  queueId?: string;
  deadLetterQueueId?: string;
  subscriptionId?: string;
};

/** Undoes `setUpDeliveryEvents`. The queues go before the Worker, as they name it as their consumer. */
export const removeDeliveryEvents = async (
  accountId: string,
  token: string,
  name: string,
  { queueId, deadLetterQueueId, subscriptionId }: DeliveryEventsSetup,
) => {
  const remove = (path: string) => request(path, token, { method: "DELETE" });
  if (subscriptionId)
    await remove(
      `/accounts/${accountId}/event_subscriptions/subscriptions/${subscriptionId}`,
    );
  for (const id of [queueId, deadLetterQueueId])
    if (id) await remove(`/accounts/${accountId}/queues/${id}`);
  await remove(`/accounts/${accountId}/workers/scripts/${name}`);
};

/**
 * Sends one sending domain's events to `eventsUrl`: creates a queue and a dead letter
 * queue, a Worker to read them, and the subscription. Run it once for each domain, with
 * its own `name`, and keep what it returns for `removeDeliveryEvents`.
 */
export const setUpDeliveryEvents = async (
  accountId: string,
  token: string,
  {
    name,
    zoneId,
    domain,
    eventsUrl,
    secret,
  }: {
    name: string;
    zoneId: string;
    domain: string;
    eventsUrl: string;
    secret: string;
  },
) => {
  const queues = `/accounts/${accountId}/queues`;
  const setup: DeliveryEventsSetup = {};
  const createQueue = async (queue_name: string) =>
    (
      (await must(queues, token, json("POST", { queue_name }))) as {
        queue_id: string;
      }
    ).queue_id;
  try {
    setup.queueId = await createQueue(name);
    setup.deadLetterQueueId = await createQueue(`${name}-dlq`);
    await putWorker(accountId, token, name, eventsWorker, [
      { type: "plain_text", name: "EVENTS_URL", text: eventsUrl },
      { type: "secret_text", name: "SECRET", text: secret },
    ]);
    await must(
      `${queues}/${setup.queueId}/consumers`,
      token,
      json("POST", {
        type: "worker",
        script_name: name,
        dead_letter_queue: `${name}-dlq`,
        settings: { batch_size: 10, max_retries: 5, retry_delay: 60 },
      }),
    );
    const subscription = (await must(
      `/accounts/${accountId}/event_subscriptions/subscriptions`,
      token,
      json("POST", {
        name,
        enabled: true,
        source: { type: "email.sending", zone_id: zoneId, domain },
        destination: { type: "queues.queue", queue_id: setup.queueId },
        events: deliveryEventNames,
      }),
    )) as { id: string };
    return {
      ...setup,
      subscriptionId: subscription.id,
    } as Required<DeliveryEventsSetup>;
  } catch (cause) {
    await removeDeliveryEvents(accountId, token, name, setup);
    throw cause;
  }
};
