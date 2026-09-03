# Releasing

How a new version of this app reaches the people running it, and the rules
around doing so. Written to be followed by somebody — or something — who has not
done it before.

## The one rule that is not about mechanics

**A release happens only when the maintainer asks for one, in those words.**

Pushing to `main` is not a release. Merging a branch is not a release. Finishing
a feature, however large, is not a release. Every one of those is a normal push,
and the CI treats it as such: it runs the tests and stops there.

A release is a deliberate act, because it costs something. It is what the app's
auto-updater offers to every installed copy, it consumes macOS CI minutes at ten
times the Linux rate, and it cannot be taken back once somebody has installed
it. So it waits for "release this", "cut a release", "ship a new version" or an
equally explicit instruction.

If in doubt, do not release. Ask.

## The whole procedure

Four commands, in this order.

```bash
npm run typecheck && npm test   # must pass before anything else
npm version <patch|minor|major> # bumps package.json, commits, tags vX.Y.Z
git push origin main --follow-tags
```

Then watch it build — the tag is what starts the release:

```bash
gh run watch "$(gh run list --limit 5 --json databaseId,headBranch \
  -q '.[] | select(.headBranch=="v0.2.10") | .databaseId' | head -1)" --exit-status
```

That is it. There is nothing to upload by hand and no release to draft — the tag
does everything.

Two preconditions worth checking rather than assuming: the working tree must be
clean (`npm version` refuses otherwise), and you must be on `main` and in sync
with `origin/main`.

## Choosing the version number

Do not ask which number to use. Work it out from what changed since the last
tag — `git log --oneline $(git describe --tags --abbrev=0)..HEAD` is the
question, and the answer is one of three:

| Bump | When | Example from this repo |
|---|---|---|
| `patch` — `0.2.9` → `0.2.10` | Bug fixes, documentation, dependency bumps, anything invisible to a user who was not hitting the bug. **The default.** | *fix: quit after staging the update, so the restart restarts* |
| `minor` — `0.2.10` → `0.3.0` | A new capability. Something a user could be told about. | *feat: say which version is running, under the update check* |
| `major` — `0.3.0` → `1.0.0` | A break in what people rely on: settings that no longer load, a changed bundle identifier, a removed feature. Restructuring that nobody notices is **not** a major bump — invisible internal work is a patch. | none yet |

When a batch mixes kinds, the highest one wins: one new feature among six fixes
is a `minor`.

`major` is worth pausing on. This app has not reached 1.0, and going there says
something about stability that should be the maintainer's call, not an agent's.
Propose it; do not do it unasked.

## What the tag sets off

`.github/workflows/build.yml` has two jobs, and only one of them is about
releasing:

- **`check`** runs on every push and pull request — the whole suite plus the
  typecheck, on Linux. Nothing here needs Electron or a desktop.
- **`build`** is gated on `startsWith(github.ref, 'refs/tags/v')` or a manual
  dispatch. It packages macOS and Windows, one after the other, and attaches the
  artefacts to the GitHub release for that tag.

The macOS job also signs and notarizes, and both of those are load bearing
rather than decorative — see the traps below.

Expect the run to take longer than the build alone suggests: Apple's
notarization service usually adds a few minutes, and the two platforms build
sequentially so the first can create the release and the second add to it.

## Verifying it worked

A green run is necessary, not sufficient. Three checks catch everything that has
actually gone wrong here before:

```bash
# 1. Was it signed and notarized? Both lines must appear.
gh run view <run-id> --log | grep -iE "signing .*identityName|notarization successful"

# 2. Do the feed and the assets agree? Every name must resolve.
gh release view v0.2.10 --json assets -q '.assets[].name'
gh release download v0.2.10 --pattern 'latest*.yml' --dir /tmp
grep -hE '^\s+- url:|^path:' /tmp/latest-mac.yml /tmp/latest.yml

# 3. Will macOS start it? Download the artefact and ask Gatekeeper.
spctl --assess --type execute --verbose=2 "Factorial Desktop.app"
#   want: accepted / source=Notarized Developer ID
```

## Traps, each of which has already cost a day

**The artefact names must not contain a space.** `productName` is
`Factorial Desktop`, and a space is spelled three different ways by the three
parties that touch it: electron-builder writes the file, GitHub turns a space
into a `.` on upload, and `latest*.yml` — the only name the updater ever asks
for — uses electron-builder's space-free form with a `-`. The names are
therefore spelled out explicitly in `electron-builder.yml`. Do not rewrite them
with `${productName}`.

**macOS signing is what makes updates possible at all.** Squirrel.Mac validates
the code signature of every update before installing it, and that cannot be
switched off. An unsigned build downloads its update and then silently fails to
install it. Never set `identity: null`.

**Notarization is what makes the app start.** Signed but un-notarized, Gatekeeper
reports `source=Unnotarized Developer ID` and refuses to open it — and since
macOS 15 there is no right-click → Open around that. The dialog's blue button
says "Move to Trash".

**The release notes are shown to users, in the app.** The update window
renders the GitHub release's body — the `body:` block in the workflow plus
whatever `generate_release_notes` adds — as the "release notes" of the offer.
Whatever stands there is what somebody reads before deciding to install. Keep
the body about the release; the install instructions for a first download
belong on the release page, not in the update offer. To see the window
without a release to show in it, run the app with
`FACTORIAL_PREVIEW_UPDATE=1 npm run dev` — see `src/main/update-preview.ts`.

**A fix to the updater only takes effect one release later.** The restart is
performed by the code in the *running* version. Shipping a fix for it in
`0.2.8` does nothing for somebody on `0.2.7`; they need `0.2.8` installed before
`0.2.9` can test the fix. Plan for two releases when changing anything in
`src/main/updater.ts`, and say so rather than letting the maintainer conclude it
did not work.

**Windows is unsigned, deliberately.** There is no certificate for it, so
`verifyUpdateCodeSignature: false` in `electron-builder.yml` is what keeps its
updater working. Turning that on without a certificate breaks updates on
Windows.

## The secrets, for reference

Set once, in the repository's Actions secrets. They are never in the repo, and
GitHub has no API that reads their values back — the workflow only names them.

| Secret | What it is |
|---|---|
| `MACOS_CERTIFICATE_P12` | The Developer ID Application certificate, base64-encoded `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | The password that `.p12` was exported with |
| `APPLE_ID` | The Apple ID the certificate belongs to |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com — not the account password, and revocable on its own |
| `APPLE_TEAM_ID` | The team the certificate names, `3CER6WZTSG` |

All five are guarded to the macOS runner in the workflow. `CSC_LINK` is not a
platform-specific name, and on the Windows job electron-builder would read the
same certificate as a *Windows* signing certificate and try to sign the `.exe`
with it.

Without them the build still succeeds, unsigned — which is what a fork or a
manual run gets, and which is why their absence is easy to miss. If a release
comes out unsigned, that is where to look.

## Undoing one

A release that should not have gone out, while nobody has installed it yet:

```bash
gh run cancel <run-id>          # if it is still building
gh release delete v0.2.10 --yes
git push origin :refs/tags/v0.2.10
git reset --hard v0.2.9         # only if the version commit is unwanted too
```

Once an installed copy has seen it, prefer releasing a fix over deleting the
release: the updater has already recorded that version as available, and taking
it away turns a working install into one that fails its update check.
