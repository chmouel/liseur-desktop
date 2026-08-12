# Liseur Desktop

A desktop EPUB reader for Linux, macOS and Windows, and the companion to
[Liseur for Android](https://github.com/chmouel/liseur).

It is arranged around one goal: reading should feel immediate. The interface
answers on the same frame as the keystroke, and the slow parts, parsing a
book or querying a library of thousands, happen somewhere you cannot feel
them.

## Install

Builds for Linux and macOS are attached to every
[release](https://github.com/chmouel/liseur-desktop/releases).

**Arch Linux** — `liseur-desktop-bin` is in the AUR:

```
paru -S liseur-desktop-bin
```

**Other Linux** — take the `.AppImage`, make it executable and run it, or
install the `.deb` on Debian and Ubuntu. Both Intel and ARM machines are
covered.

**macOS** — take the `.dmg` matching your Mac (`arm64` for Apple silicon,
`x64` for Intel). The build is not signed, so the first launch needs the
quarantine flag cleared:

```
xattr -dr com.apple.quarantine /Applications/Liseur.app
```

## DEVELOPMENT

[DESIGN.md](DESIGN.md) covers what it is and where it came from.
[ARCHITECTURE.md](ARCHITECTURE.md) explains how the three processes divide
the work between them, and [PERFORMANCE.md](PERFORMANCE.md) gives the
budgets they are held to. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) is for
working on the code.

## License

MIT, see [LICENSE](LICENSE).
