const base = "https://api.cloudflare.com/client/v4";

type Answer = {
  success?: boolean;
  result?: unknown;
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

const must = async (path: string, token: string, init: RequestInit) => {
  const { ok, body } = await request(path, token, init);
  if (!ok)
    throw new Error(
      body?.errors?.map((e) => e.message).join("; ") || "Cloudflare said no.",
    );
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

export const uploadWorker = (
  accountId: string,
  token: string,
  name: string,
  vars: { inboundUrl: string; secret: string; forwardTo?: string | undefined },
) => {
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2026-10-01",
      bindings: [
        { type: "plain_text", name: "INBOUND_URL", text: vars.inboundUrl },
        { type: "secret_text", name: "SECRET", text: vars.secret },
        ...(vars.forwardTo
          ? [{ type: "plain_text", name: "FORWARD_TO", text: vars.forwardTo }]
          : []),
      ],
    }),
  );
  form.append(
    "worker.js",
    new Blob([inboundWorker], { type: "application/javascript+module" }),
    "worker.js",
  );
  return must(`/accounts/${accountId}/workers/scripts/${name}`, token, {
    method: "PUT",
    body: form,
  });
};

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
