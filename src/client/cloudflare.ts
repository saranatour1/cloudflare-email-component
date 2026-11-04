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
  return ok ? body?.result : undefined;
};

const must = async (path: string, token: string, init?: RequestInit) => {
  const { ok, body } = await request(path, token, init);
  if (!ok)
    throw new Error(
      body?.errors?.map((e) => e.message).join("; ") || "Cloudflare said no.",
    );
  return body as Answer;
};

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const remove = (path: string, token: string) =>
  request(path, token, { method: "DELETE" });

export const routingEnabled = async (zoneId: string, token: string) =>
  (
    (await call(`/zones/${zoneId}/email/routing`, token)) as
      | { enabled?: boolean }
      | undefined
  )?.enabled;

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

const putWorker = (
  accountId: string,
  token: string,
  name: string,
  source: string,
  vars: Record<string, string | undefined>,
) => {
  const bindings = Object.entries(vars)
    .filter(([, text]) => text)
    .map(([name, text]) => ({
      type: name === "SECRET" ? "secret_text" : "plain_text",
      name,
      text,
    }));
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
  putWorker(accountId, token, name, inboundWorker, {
    INBOUND_URL: vars.inboundUrl,
    SECRET: vars.secret,
    FORWARD_TO: vars.forwardTo,
  });

type Rule = {
  id: string;
  enabled?: boolean;
  matchers?: { type?: string; value?: string }[];
  actions?: { type?: string; value?: string[] }[];
};

export const ruleFor = async (
  zoneId: string,
  token: string,
  address: string,
) => {
  const rules = (await call(
    `/zones/${zoneId}/email/routing/rules?per_page=50`,
    token,
  )) as Rule[] | undefined;
  const found = rules?.find(
    (r) =>
      r.enabled !== false &&
      r.matchers?.some(
        (m) =>
          m.type === "literal" &&
          m.value?.toLowerCase() === address.toLowerCase(),
      ),
  );
  return (
    found && {
      id: found.id,
      forwardsTo: found.actions?.find((a) => a.type === "forward")?.value?.[0],
    }
  );
};

export const createRule = async (
  zoneId: string,
  token: string,
  address: string,
  worker: string,
  name = "Convex Cloudflare Email",
) =>
  (
    (
      await must(
        `/zones/${zoneId}/email/routing/rules`,
        token,
        json("POST", {
          name,
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [{ type: "worker", value: [worker] }],
        }),
      )
    ).result as { id: string }
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
    await remove(`/zones/${zoneId}/email/routing/rules/${id}`, token);
  await remove(`/accounts/${accountId}/workers/scripts/${worker}`, token);
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

const suppressions = (accountId: string, rest = "") =>
  `/accounts/${accountId}/email/sending/suppressions${rest}`;

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
  const body = await must(suppressions(accountId, `?${query}`), token);
  return {
    suppressions: body.result as Suppression[],
    cursor: body.result_info?.cursor,
  };
};

export const addSuppression = async (
  accountId: string,
  token: string,
  suppression: NewSuppression,
) =>
  (await must(suppressions(accountId), token, json("POST", suppression)))
    .result as Pick<Suppression, "id" | "scope">;

export const importSuppressions = async (
  accountId: string,
  token: string,
  items: NewSuppression[],
) =>
  (await must(suppressions(accountId, "/bulk"), token, json("POST", { items })))
    .result;

export const updateSuppression = async (
  accountId: string,
  token: string,
  id: string,
  changes: { expires_at?: string | null; note?: string },
) =>
  (await must(suppressions(accountId, `/${id}`), token, json("PATCH", changes)))
    .result as Suppression;

export const deleteSuppression = async (
  accountId: string,
  token: string,
  id: string,
) =>
  (
    await must(suppressions(accountId, `/${id}`), token, {
      method: "DELETE",
    })
  ).result;

type DeliveryEventsSetup = {
  queueId?: string;
  deadLetterQueueId?: string;
  subscriptionId?: string;
};

export const removeDeliveryEvents = async (
  accountId: string,
  token: string,
  name: string,
  { queueId, deadLetterQueueId, subscriptionId }: DeliveryEventsSetup,
) => {
  if (subscriptionId)
    await remove(
      `/accounts/${accountId}/event_subscriptions/subscriptions/${subscriptionId}`,
      token,
    );
  for (const id of [queueId, deadLetterQueueId])
    if (id) await remove(`/accounts/${accountId}/queues/${id}`, token);
  await remove(`/accounts/${accountId}/workers/scripts/${name}`, token);
};

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
  const create = async (path: string, body: unknown) =>
    (await must(path, token, json("POST", body))).result as {
      id: string;
      queue_id: string;
    };
  try {
    setup.queueId = (await create(queues, { queue_name: name })).queue_id;
    setup.deadLetterQueueId = (
      await create(queues, { queue_name: `${name}-dlq` })
    ).queue_id;
    await putWorker(accountId, token, name, eventsWorker, {
      EVENTS_URL: eventsUrl,
      SECRET: secret,
    });
    await create(`${queues}/${setup.queueId}/consumers`, {
      type: "worker",
      script_name: name,
      dead_letter_queue: `${name}-dlq`,
      settings: { batch_size: 10, max_retries: 5, retry_delay: 60 },
    });
    setup.subscriptionId = (
      await create(`/accounts/${accountId}/event_subscriptions/subscriptions`, {
        name,
        enabled: true,
        source: { type: "email.sending", zone_id: zoneId, domain },
        destination: { type: "queues.queue", queue_id: setup.queueId },
        events: [
          "message.delivered",
          "message.deferred",
          "message.bounced",
          "message.failed",
          "message.rejected",
          "message.complained",
        ],
      })
    ).id;
    return setup as Required<DeliveryEventsSetup>;
  } catch (cause) {
    await removeDeliveryEvents(accountId, token, name, setup);
    throw cause;
  }
};
