# Liseur Desktop

A desktop EPUB reader for Linux, macOS and Windows, and the companion to
[Liseur for Android](https://github.com/chmouel/liseur).

It is arranged around one goal: reading should feel immediate. The interface
answers on the same frame as the keystroke, and the slow parts, parsing a
book or querying a library of thousands, happen somewhere you cannot feel
them.

## Install

Every [release](https://github.com/chmouel/liseur-desktop/releases) has builds
for Linux and macOS attached.

On Arch Linux, `liseur-desktop-bin` is in the AUR:

```
paru -S liseur-desktop-bin
```

On other Linux, take the `.AppImage`, make it executable and run it, or install
the `.deb` on Debian and Ubuntu. There are builds for both Intel and ARM.

On macOS, take the `.dmg` matching your Mac (`arm64` for Apple silicon, `x64`
for Intel). The build is not signed, so clear the quarantine flag before the
first launch:

```
xattr -dr com.apple.quarantine /Applications/Liseur.app
```

Every file in a release is signed by the workflow that built it. If you want to
know that a download came from this repository rather than from someone in the
middle:

```
gh attestation verify <file> --repo chmouel/liseur-desktop
```

## DEVELOPMENT

[docs/DESIGN.md](docs/DESIGN.md) covers what it is and where it came from.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the three
processes divide the work between them, and
[docs/PERFORMANCE.md](docs/PERFORMANCE.md) gives the budgets they are held
to. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) is for working on the code,
and [SECURITY.md](SECURITY.md) covers how the project treats its
dependencies and how to report a vulnerability.

## License

MIT, see [LICENSE](LICENSE).
