#!/usr/bin/env bash
# Replace Convex env vars by picking them from a list. New values are typed or
# pasted hidden and piped in, so they stay out of the screen, history and `ps`.
# Extra arguments go to `convex env`: ./scripts/rotate-env.sh --prod
# shortcut: one line per value, use `convex env set NAME --from-file` for multi-line keys.
set -euo pipefail

list=$(pnpm --silent convex env list --names-only "$@")
names=()
for name in $list; do names+=("$name"); done
if [ "${#names[@]}" -eq 0 ]; then
  echo "No environment variables on this deployment." >&2
  exit 1
fi

echo "Target: ${*:-default deployment}"
for i in "${!names[@]}"; do printf '%3d) %s\n' "$((i + 1))" "${names[$i]}"; done

read -rp "Replace which? (numbers or names, separated by spaces): " input

# Check every pick before changing anything, so a typo can't leave a half-done rotation.
picked=()
set -f
for pick in $input; do
  found=""
  case "$pick" in
    *[!0-9]*)
      for name in "${names[@]}"; do
        if [ "$name" = "$pick" ]; then found=$name; fi
      done
      ;;
    *)
      if [ "$((10#$pick))" -ge 1 ] && [ "$((10#$pick))" -le "${#names[@]}" ]; then
        found=${names[$((10#$pick - 1))]}
      fi
      ;;
  esac
  if [ -z "$found" ]; then
    echo "Not on the list: $pick" >&2
    exit 1
  fi
  picked+=("$found")
done
set +f

if [ "${#picked[@]}" -eq 0 ]; then
  echo "Nothing picked."
  exit 0
fi

for name in "${picked[@]}"; do
  read -rsp "New value for $name (Enter to skip): " value
  echo
  if [ -z "$value" ]; then
    echo "Skipped $name"
    continue
  fi
  printf '%s' "$value" | pnpm --silent convex env set "$name" "$@"
done
