/// <reference types="vite/client" />
import { test } from "vite-plus/test";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import component from "@sarant/cloudflare-email-component/test";
import { registerUsername } from "@convex-dev/auth/components/username/test";

const modules = import.meta.glob("./**/*.*s");
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  registerUsername(t);
  return t;
}

test("setup", () => {});
