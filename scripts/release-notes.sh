#!/usr/bin/env bash
#
# Writes the release notes for a tag from the commits since the previous one.
#
#   scripts/release-notes.sh v0.3.3 > notes.md
#
# The body of a GitHub release is what the app's update window shows as
# "release notes", so this is what people read before deciding to install.
# It therefore lists what changed and nothing else: `feat:` commits under
# "New", `fix:` commits under "Fixes", and anything else that a user could
# notice under "Other changes". Version bumps and the housekeeping prefixes
# (docs, test, chore, ci, refactor, build) are left out — they are invisible
# to somebody running the app.
#
# Subjects are taken as written after the prefix, first letter capitalised.
# The commit body is not used: the subject is the line written for exactly
# this purpose, and the body is for the reader of `git log`.
set -euo pipefail

tag="${1:?tag, e.g. v0.3.3}"
previous="$(git describe --tags --abbrev=0 "${tag}^" 2>/dev/null || true)"
range="${previous:+${previous}..}${tag}"

new=()
fixes=()
other=()

# "type(scope)!: subject" — type, optional scope, optional breaking mark.
prefix='^([a-z]+)(\([^)]*\))?!?:[[:space:]]*(.*)$'

while IFS= read -r subject; do
  [[ -z "$subject" ]] && continue
  # The version-bump commit `npm version` makes: "0.3.3".
  [[ "$subject" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && continue
  if [[ "$subject" =~ $prefix ]]; then
    kind="${BASH_REMATCH[1]}"
    text="${BASH_REMATCH[3]}"
  else
    kind=""
    text="$subject"
  fi
  text="$(tr '[:lower:]' '[:upper:]' <<< "${text:0:1}")${text:1}"
  case "$kind" in
    feat) new+=("$text") ;;
    fix) fixes+=("$text") ;;
    docs | test | chore | ci | refactor | build | style) ;;
    *) other+=("$text") ;;
  esac
done < <(git log --no-merges --format='%s' "$range")

section() {
  local title="$1"
  shift
  (($# == 0)) && return
  printf '## %s\n\n' "$title"
  local line
  for line in "$@"; do printf -- '- %s\n' "$line"; done
  printf '\n'
}

section "New" "${new[@]+"${new[@]}"}"
section "Fixes" "${fixes[@]+"${fixes[@]}"}"
section "Other changes" "${other[@]+"${other[@]}"}"

if ((${#new[@]} + ${#fixes[@]} + ${#other[@]} == 0)); then
  printf 'Maintenance release — no user-facing changes.\n\n'
fi

if [[ -n "$previous" ]]; then
  printf '**Full changelog**: https://github.com/MaxLikesCode/factorial-desktop/compare/%s...%s\n\n' "$previous" "$tag"
fi

# For the release page, where people arrive for a first download. Last, and
# short, because the update window shows this too and there it is the least
# interesting part.
cat <<'EOF'
---

*First install:* Windows — `Factorial-Desktop-Setup-<version>.exe`; the build is unsigned, so SmartScreen asks once (*More info → Run anyway*). macOS — `.dmg` or `.zip`, Apple Silicon, signed and notarized.
EOF
