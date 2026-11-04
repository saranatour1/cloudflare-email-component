---
name: shipping
description:
  How changes ship from cloudflare-email-component. Merging to main deploys
  nothing, an npm release is the real release and is the user's to run, the
  public API is what installed apps depend on, env files never go in git, and
  the Convex deployment here is dev only. Use before merging a PR, cutting a
  release, changing an export, a component function or the schema, running
  Convex commands, or adding config.
---

# Shipping

## A merge isn't a release, a publish is

Merging to `main` only runs CI (`.github/workflows/test.yml`: build, test,
typecheck, `vp check`). Nothing deploys. Each PR also gets a preview package
through `pkg-pr-new`, which is the way to try a change in another app before
release.

The release is `pnpm release` (patch), `pnpm release:minor` or `pnpm alpha`
(prerelease). Each runs `preversion` (clean build, tests, lint, typecheck),
bumps the version, renames `## Unreleased` in `CHANGELOG.md` to the new version
(`scripts/changelog.mjs` refuses an empty section), commits, tags and pushes.
The `v*` tag runs `.github/workflows/publish.yml`, which stages the version on
npm through trusted publishing (OIDC, no token). The user approves it under
Staged Packages on npmjs.com. So:

- Add every user-facing change under `## Unreleased` in `CHANGELOG.md` as part
  of the PR that makes it.
- Leave releasing to the user. It pushes a tag to `main` and needs their 2FA
  approval on npm, and a published version can't be reused, even after an
  unpublish.
- A breaking change needs `pnpm release:minor` (or `major`), not `pnpm release`.
- Don't run `pnpm publish` locally as well: the workflow publishes the tag.
- The tag must match `version` in `package.json`, and `repository.url` must
  match the GitHub repo exactly, or trusted publishing refuses the publish.

## The public API

Apps that install the package depend on:

- the client exports in `src/client/index.ts` and `src/client/cloudflare.ts`,
- the public component functions in `src/component/lib.ts` and `events.ts`
  (`components.cloudflareEmail.*`),
- the schema in `src/component/schema.ts`, since their stored data has to keep
  validating after an upgrade.

Renaming or removing any of these, adding a required argument, or narrowing a
validator is a breaking change. Say so in the PR and the changelog. Add a field
as `v.optional`. Update `README.md` and `docs/API.md` along with the change.

## Convex commands

`pnpm run dev` pushes to the dev deployment named in the untracked `.env.local`,
for the example app. This repo has no production deployment, so never add
`--prod` to a `convex` command or to `scripts/rotate-env.sh`. The permission
check refuses force-pushes and remote branch deletes even after the user says
yes. Don't retry them or route around the check. Give the user the exact
command.

## No env files in git

Never commit `.env*`, even when every value is public. Keep them fully ignored,
with no `!` exceptions. Set secrets with `pnpm convex env set` (or
`scripts/rotate-env.sh`), and never ask the user to paste a token into chat.
Don't hardcode deployment names or URLs in tracked files. Write `<deployment>`
instead, as the README does.

## Agent skills stay out of the package

The skills from `npx convex ai-files install` (`.claude/skills/convex*`,
`.agents/skills/convex*`, `skills-lock.json`), convex-test included, are
untracked. Ask the user before committing them. If they want them, they go in
git and the PR, never in the npm package: keep `"files"` in `package.json` to
`dist` and `src`, and check with `npm pack --dry-run` before a release.

## Editing a PR

`gh pr edit` (gh 2.71) exits 1 with a Projects (classic) error and changes
nothing. Use
`gh api -X PATCH repos/saranatour1/cloudflare-email-component/pulls/<n> -F body=@file`,
then re-read the PR to confirm.
