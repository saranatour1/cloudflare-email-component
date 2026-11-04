import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const file = "CHANGELOG.md";
const version = process.env.npm_package_version;
const text = readFileSync(file, "utf8");
const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text);

if (!version) throw new Error("Run this through `pnpm version`.");
if (version.includes("-")) process.exit(0);
if (!unreleased?.[1].trim())
  throw new Error(`Add your changes under "## Unreleased" in ${file} first.`);

writeFileSync(file, text.replace("## Unreleased", `## ${version}`));
