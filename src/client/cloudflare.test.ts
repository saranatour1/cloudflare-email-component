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
  createRule,
  removeInbound,
  ruleFor,
  sha256,
  tokenStatus,
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
