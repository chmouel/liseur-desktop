# Security

## Reporting something

Open a [security advisory](https://github.com/chmouel/liseur-desktop/security/advisories/new),
not a public issue. A reply should come within a few days.

## What is actually at risk

Liseur reads files you already have, on a machine you already control. It has
no accounts, no telemetry and no server of its own — the only network traffic
is to an OPDS catalogue if you configure one. The realistic threats are
therefore two: a malformed EPUB doing something it should not, and a
dependency turning hostile.

The first is handled by architecture. Books are parsed in a separate worker
process, never in the window that shows them; the renderer has no access to
the filesystem, to Node, or to Electron, and reaches data only through a
narrow typed bridge that exposes named operations rather than a general
channel. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the detail.

The rest of this document is about the second.

## Dependencies

Nothing from `node_modules` ships. Every dependency is a `devDependency`, and
`electron-builder.json` packages `out/**` and `package.json` and nothing else.
A compromised package can therefore reach a developer's laptop or a CI runner
— which is bad, and worth defending against — but it cannot reach a reader's
machine through a release.

Fourteen direct dependencies pull in roughly a thousand transitive ones. That
number is the real surface, and none of it is code anyone here has read.

### The shape of the attack

Every serious npm compromise of recent years has gone the same way. A
maintainer's account is phished or their token is stolen. A version is
published with a payload in an install script. It is downloaded tens of
thousands of times. Somebody notices, the version is pulled, and the whole
episode is over in somewhere between two hours and three days.

The defence follows from the shape: make new versions wait, refuse to run
install scripts, and make the moment a dependency changes something a human
has to look at.

### Waiting

`minimumReleaseAge` in [pnpm-workspace.yaml](pnpm-workspace.yaml) is set to
fourteen days. A version published this morning cannot be installed today. By
the time this project will touch a release, the people who install everything
immediately have already found the bad ones.

This is not free. A fix you want cannot be had at once. When that fix is
itself a security fix and genuinely cannot wait, put the package name in
`minimumReleaseAgeExclude`, install, and empty the list again in the same pull
request. A name left behind in that list is a permanent hole.

Installs trust the committed lockfile rather than re-checking the age of
everything in it, because an entry that was fine when it was locked does not
become suspect merely by sitting there. What guards the lockfile is the check
below.

### Looking

`pnpm-lock.yaml` is where an attack would actually appear, so a pull request
that changes it gets a job of its own. [`scripts/check-lockfile-change.mjs`](scripts/check-lockfile-change.mjs)
compares the lockfile against the base branch and prints what was added and
removed, so the change is read as a short list rather than skimmed as four
thousand lines of YAML. It then asks the registry how old every newly added
version is, and fails on anything inside the cooldown or anything that cannot
be dated at all. It also fails on any entry that did not come from the
registry — a git URL or a loose tarball — which is a second lock on the door
`blockExoticSubdeps` already closes.

A lockfile that changes while `package.json` does not is refused outright,
unless Dependabot is the author, since for Dependabot that is the job.

The script has no dependencies. A tool whose entire purpose is suspicion of
dependencies should not have any.

### Not running

Install scripts are arbitrary code execution at install time, which is how
most of these attacks actually land. pnpm blocks them by default. Three
packages are named in `allowBuilds` and nothing else is permitted one; adding
a fourth needs a reason written into the pull request.

### Noticing

`pnpm audit --audit-level high` runs on every pull request and blocks. Nothing
is currently ignored; anything added to `auditConfig.ignoreCves` has to say
why, and dev-only exposure is the only acceptable reason. Dependabot's
security alerts run on their own schedule regardless of the weekly update
batch, so a real advisory does not wait until Monday.

## Continuous integration

CI holds a token, and secrets, and it builds the binaries people download.
That makes the workflows themselves a dependency, and they are treated as one.

Actions are pinned to full commit SHAs rather than tags. A tag is a mutable
pointer; whoever controls the repository — or whoever steals the account that
does — can move `v4` to point at anything. The version is kept in a comment
beside the SHA so the file stays readable, and Dependabot updates both.

No workflow gets more permission than it needs. The default is
`contents: read`. In the release workflow only the publishing job can write,
and only it holds the identity token used for provenance, so a compromised
action in the build matrix has nothing to steal and nothing to publish.

## Releases

Builds are not code-signed: there is no certificate, and buying one for a
hobby project is hard to justify. What exists instead is provenance.
`actions/attest-build-provenance` records, in a public transparency log, that
the exact bytes attached to a release came out of this workflow at this
commit. Anyone can check:

```
gh attestation verify liseur-desktop-*.AppImage --repo chmouel/liseur-desktop
```

A `SHA256SUMS` file is published as well, but it proves less: a checksum says
a file has not changed since somebody wrote the checksum down, while an
attestation says where the file came from.

## What is deliberately not here

Written down so the argument is not had twice.

**CodeQL.** It scans first-party code for injection and memory bugs. The risk
here is in the thousand packages nobody has read, not in the few thousand
lines that have been.

**OpenSSF Scorecard.** It measures repository hygiene and reports it as a
badge. The controls it checks for are either already in place or listed here
as declined; the badge would add a workflow and no information.

**Egress filtering on CI runners.** It catches a payload phoning home from a
build. It also breaks whenever a registry changes address, and it guards a
runner that holds no interesting secret beyond the release token, which is
already confined to a single job.

**Vendoring or allow-listing the dependency tree.** It is the strongest
option available and it works. It is also a standing tax on every update, paid
weekly, on a project maintained by one person. The cooldown gets most of the
benefit for none of the cost.

These are judgements about a small hobby project with no runtime dependencies,
not general advice. Different answers would be right for something that ships
a server.
