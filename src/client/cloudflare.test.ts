import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import {
  accessOf,
  addSuppression,
  createRule,
  deleteSuppression,
  importSuppressions,
  listSuppressions,
  removeDeliveryEvents,
  setUpDeliveryEvents,
  removeInbound,
  ruleFor,
  sha256,
  toBase64,
  tokenStatus,
  updateSuppression,
  uploadWorker,
  zoneNamesOf,
} from "./cloudflare.js";

const fetchMock = vi.fn<typeof fetch>();
const answer = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result }));
const refused = (message: string) =>
  new Response(JSON.stringify({ success: false, errors: [{ message }] }), {
    status: 403,
  });
/** Answers by the path after /client/v4, and refuses any other. */
const route = (routes: Record<string, unknown>) =>
  fetchMock.mockImplementation((url) => {
    const path = (url as string).replace(
      "https://api.cloudflare.com/client/v4",
      "",
    );
    return Promise.resolve(
      path in routes ? answer(routes[path]) : refused("no"),
    );
  });
const lastBody = () => fetchMock.mock.lastCall![1]!.body;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test("zoneNamesOf walks up from the domain, stopping before the TLD", () => {
  expect(zoneNamesOf("Mail.Example.com")).toEqual([
    "mail.example.com",
    "example.com",
  ]);
});

test("sha256 gives the known digest", async () => {
  expect(await sha256("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

describe("tokenStatus", () => {
  test("falls back to the user endpoint for a user token", async () => {
    route({ "/user/tokens/verify": { status: "active" } });
    expect(await tokenStatus("acc", "t")).toBe("active");
  });
  test("is invalid when neither endpoint knows the token", async () => {
    route({});
    expect(await tokenStatus("acc", "t")).toBe("invalid");
  });
  test("sends the token as a bearer", async () => {
    route({ "/accounts/acc/tokens/verify": { status: "active" } });
    await tokenStatus("acc", "t");
    expect(
      new Headers(fetchMock.mock.calls[0]![1]!.headers).get("Authorization"),
    ).toBe("Bearer t");
  });
});

describe("accessOf", () => {
  test("finds the parent zone and a wildcard sending domain", async () => {
    route({
      "/zones?name=mail.example.com": [],
      "/zones?name=example.com": [{ id: "z" }],
      "/accounts/acc/workers/scripts": [],
      "/zones/z/email/sending/subdomains": [
        { name: "*.example.com", enabled: true },
      ],
    });
    expect(await accessOf("acc", "t", "mail.example.com")).toEqual({
      zoneId: "z",
      access: { sending: true, workers: true, routing: false, zone: true },
    });
  });
  test("reports no zone without asking about one", async () => {
    route({});
    const { zoneId, access } = await accessOf("acc", "t", "example.com");
    expect(zoneId).toBeUndefined();
    expect(access).toEqual({
      sending: undefined,
      workers: false,
      routing: false,
      zone: false,
    });
  });
});

describe("ruleFor", () => {
  const rule = (over: object) => ({
    id: "r",
    matchers: [{ type: "literal", value: "Me@Example.com" }],
    actions: [{ type: "forward", value: ["you@example.com"] }],
    ...over,
  });
  const path = "/zones/z/email/routing/rules?per_page=50";

  test("matches the address whatever its case, and reports the forward", async () => {
    route({ [path]: [rule({})] });
    expect(await ruleFor("z", "t", "me@example.com")).toEqual({
      id: "r",
      forwardsTo: "you@example.com",
    });
  });
  test("ignores a disabled rule", async () => {
    route({ [path]: [rule({ enabled: false })] });
    expect(await ruleFor("z", "t", "me@example.com")).toBeUndefined();
  });
});

describe("createRule", () => {
  test("routes the address to the Worker under the given name", async () => {
    route({ "/zones/z/email/routing/rules": { id: "new" } });
    expect(await createRule("z", "t", "me@example.com", "w", "My app")).toBe(
      "new",
    );
    expect(JSON.parse(lastBody() as string)).toEqual({
      name: "My app",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "me@example.com" }],
      actions: [{ type: "worker", value: ["w"] }],
    });
  });
  test("throws Cloudflare's reason", async () => {
    route({});
    await expect(createRule("z", "t", "a@b.c", "w")).rejects.toThrow("no");
  });
});

test("uploadWorker keeps the secret in a secret binding and skips an unset forward", async () => {
  route({ "/accounts/acc/workers/scripts/w": {} });
  await uploadWorker("acc", "t", "w", { inboundUrl: "https://x", secret: "s" });
  const form = lastBody() as FormData;
  const { bindings } = JSON.parse(form.get("metadata") as string);
  expect(bindings).toEqual([
    { type: "plain_text", name: "INBOUND_URL", text: "https://x" },
    { type: "secret_text", name: "SECRET", text: "s" },
  ]);
});

test("removeInbound deletes every rule and the Worker, skipping an empty rule id", async () => {
  route({});
  await removeInbound("acc", "z", "t", "w", "", ["alias"]);
  expect(
    fetchMock.mock.calls.map(([url, init]) => [
      init!.method,
      (url as string).split("/v4")[1],
    ]),
  ).toEqual([
    ["DELETE", "/zones/z/email/routing/rules/alias"],
    ["DELETE", "/accounts/acc/workers/scripts/w"],
  ]);
});

test("toBase64 handles more than one piece, and any byte", () => {
  const bytes = Uint8Array.from({ length: 20000 }, (_, i) => i % 256);
  const decoded = Uint8Array.from(atob(toBase64(bytes.buffer)), (c) =>
    c.charCodeAt(0),
  );
  expect(decoded).toEqual(bytes);
});

describe("suppressions", () => {
  const path = "/accounts/acc/email/sending/suppressions";
  const called = () => {
    const [url, init] = fetchMock.mock.lastCall!;
    return {
      path: (url as string).split("/v4")[1],
      method: init!.method,
      body: init!.body && JSON.parse(init!.body as string),
    };
  };

  test("lists by filter and gives the next cursor", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "s", read_only: true }],
          result_info: { cursor: "next" },
        }),
      ),
    );
    const { suppressions, cursor } = await listSuppressions("acc", "t", {
      scope_type: "sending_domain",
      scope_value: "mail.example.com",
    });
    expect(suppressions[0]!.read_only).toBe(true);
    expect(cursor).toBe("next");
    expect(called().path).toBe(
      `${path}?scope_type=sending_domain&scope_value=mail.example.com`,
    );
  });

  test("adds one for a single sending domain", async () => {
    route({ [path]: { id: "s" } });
    const scope = {
      type: "sending_domain",
      value: "mail.example.com",
    } as const;
    await addSuppression("acc", "t", { email: "a@example.com", scope });
    expect(called()).toEqual({
      path,
      method: "POST",
      body: { email: "a@example.com", scope },
    });
  });

  test("imports in bulk", async () => {
    route({ [`${path}/bulk`]: { items: [] } });
    await importSuppressions("acc", "t", [{ email: "a@example.com" }]);
    expect(called()).toMatchObject({
      path: `${path}/bulk`,
      body: { items: [{ email: "a@example.com" }] },
    });
  });

  test("updates and deletes by id", async () => {
    route({ [`${path}/s`]: { id: "s" } });
    await updateSuppression("acc", "t", "s", { expires_at: null });
    expect(called()).toMatchObject({
      method: "PATCH",
      body: { expires_at: null },
    });
    await deleteSuppression("acc", "t", "s");
    expect(called()).toMatchObject({ path: `${path}/s`, method: "DELETE" });
  });

  test("throws Cloudflare's reason", async () => {
    route({});
    await expect(listSuppressions("acc", "t")).rejects.toThrow("no");
    await expect(
      addSuppression("acc", "t", { email: "a@example.com" }),
    ).rejects.toThrow("no");
  });
});

describe("setUpDeliveryEvents", () => {
  const options = {
    name: "events",
    zoneId: "z",
    domain: "mail.example.com",
    eventsUrl: "https://app.example.com/email/events",
    secret: "s3cret",
  };
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => [
      init!.method ?? "GET",
      (url as string).split("/v4")[1],
    ]);
  /** Answers every call, and makes new queues get ids from their names. */
  const answering = (failOn?: string) =>
    fetchMock.mockImplementation((url, init) => {
      const path = (url as string).split("/v4")[1]!;
      if (path === failOn) return Promise.resolve(refused("not allowed"));
      if (init!.method === "POST" && path.endsWith("/queues")) {
        const { queue_name } = JSON.parse(init!.body as string);
        return Promise.resolve(answer({ queue_id: `id-${queue_name}` }));
      }
      return Promise.resolve(answer({ id: "sub" }));
    });
  const subscriptions = "/accounts/acc/event_subscriptions/subscriptions";

  test("creates the queues, the Worker, its consumer and the subscription", async () => {
    answering();
    expect(await setUpDeliveryEvents("acc", "t", options)).toEqual({
      queueId: "id-events",
      deadLetterQueueId: "id-events-dlq",
      subscriptionId: "sub",
    });
    expect(calls()).toEqual([
      ["POST", "/accounts/acc/queues"],
      ["POST", "/accounts/acc/queues"],
      ["PUT", "/accounts/acc/workers/scripts/events"],
      ["POST", "/accounts/acc/queues/id-events/consumers"],
      ["POST", subscriptions],
    ]);

    const bodyOf = (i: number) => fetchMock.mock.calls[i]![1]!.body as string;
    const { bindings } = JSON.parse(
      (fetchMock.mock.calls[2]![1]!.body as FormData).get("metadata") as string,
    );
    expect(bindings).toEqual([
      { type: "plain_text", name: "EVENTS_URL", text: options.eventsUrl },
      { type: "secret_text", name: "SECRET", text: "s3cret" },
    ]);
    expect(JSON.parse(bodyOf(3))).toMatchObject({
      type: "worker",
      script_name: "events",
      dead_letter_queue: "events-dlq",
    });
    expect(JSON.parse(bodyOf(4))).toEqual({
      name: "events",
      enabled: true,
      source: { type: "email.sending", zone_id: "z", domain: options.domain },
      destination: { type: "queues.queue", queue_id: "id-events" },
      events: [
        "message.delivered",
        "message.deferred",
        "message.bounced",
        "message.failed",
        "message.rejected",
        "message.complained",
      ],
    });
  });

  test("takes everything back down if a step fails", async () => {
    answering(subscriptions);
    await expect(setUpDeliveryEvents("acc", "t", options)).rejects.toThrow(
      "not allowed",
    );
    expect(calls().slice(-3)).toEqual([
      ["DELETE", "/accounts/acc/queues/id-events"],
      ["DELETE", "/accounts/acc/queues/id-events-dlq"],
      ["DELETE", "/accounts/acc/workers/scripts/events"],
    ]);
  });

  test("removeDeliveryEvents starts with the subscription", async () => {
    answering();
    await removeDeliveryEvents("acc", "t", "events", {
      queueId: "q",
      deadLetterQueueId: "d",
      subscriptionId: "sub",
    });
    expect(calls()).toEqual([
      ["DELETE", `${subscriptions}/sub`],
      ["DELETE", "/accounts/acc/queues/q"],
      ["DELETE", "/accounts/acc/queues/d"],
      ["DELETE", "/accounts/acc/workers/scripts/events"],
    ]);
  });
});
