# Homebrew cask

`Casks/liseur.rb` turns this repository into its own Homebrew tap. Homebrew
only looks for casks in a `Casks` directory at the root of a tap, which is why
that file sits there rather than here, next to this README.

A tap repository normally has to be named `homebrew-<something>` for Homebrew
to find it from a short name. The two-argument form of `brew tap` takes any Git
URL instead and imposes no naming, so this project needs no second repository:

```
brew tap chmouel/liseur https://github.com/chmouel/liseur-desktop
brew install --cask chmouel/liseur/liseur
```

One cask covers both platforms. On macOS it installs `Liseur.app` out of the
`.dmg`; on Linux it links the `.AppImage`. Apple silicon and Intel, ARM and
x86-64, all come from the same four files a release already publishes.

The version and the four checksums are rewritten by the release workflow
through `scripts/update-cask.mjs`, which then commits the cask to `main`.
That last part matters: Homebrew reads a tap from its default branch, so a
cask that only ever moved on a tag would leave `brew upgrade` on the first
version for ever. Everything else in the cask is written by hand.

The commit is pushed with the workflow's own token, which is the one place in
the release that writes to this repository. A branch protection rule on `main`
that forbids direct pushes would stop it there, after the release itself has
already been published.

## Checking a change

Homebrew is not needed on the machine to be able to run it — a throwaway clone
is enough, and touches nothing outside itself:

```
git clone --depth 1 https://github.com/Homebrew/brew /tmp/brew
/tmp/brew/bin/brew style --fix Casks/liseur.rb
```

`style` sorts the stanzas into the order Homebrew expects and is the quickest
way to catch a typo. Anything beyond that wants the cask tapped, because
`brew audit` and `brew info` work on names rather than paths:

```
/tmp/brew/bin/brew tap chmouel/liseur /path/to/this/repository
/tmp/brew/bin/brew audit --cask chmouel/liseur/liseur
/tmp/brew/bin/brew fetch --cask chmouel/liseur/liseur
```

A tap is a clone, so it carries the committed cask and not the one in the
working tree; copy the file into
`/tmp/brew/Library/Taps/chmouel/homebrew-liseur/Casks/` while iterating.

Half of the cask is invisible from whichever machine you are on. This renders
the macOS half — artifact, requirements and caveats — from Linux:

```
HOMEBREW_SIMULATE_MACOS_ON_LINUX=1 /tmp/brew/bin/brew info --cask chmouel/liseur/liseur
```
