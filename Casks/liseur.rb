# This repository is its own Homebrew tap. `Casks` has to sit at the root of
# the repository because that is the only place Homebrew looks for casks; the
# reasoning, and the commands that use it, are in packaging/homebrew/README.md.
#
# The version and the four checksums below are rewritten by the release
# workflow, through scripts/update-cask.mjs, every time a tag is published.
# Everything else is edited by hand.

cask "liseur" do
  # The macOS builds say x64 where the AppImages say x86_64, which is the one
  # place the two platforms disagree about the same processor.
  arch arm: "arm64", intel: on_system_conditional(macos: "x64", linux: "x86_64")
  os macos: "mac", linux: "linux"
  extension = on_system_conditional macos: "dmg", linux: "AppImage"

  version "0.5.0"
  sha256 arm:          "f4ad23d283129029f8693e256ada879c8f3411566049c3bb17348d1c70a18ae0",
         intel:        "8bfdd4b14843c42c4f87fee1d7aa7462640103a269b13ae99af2a1ce13afbfe7",
         arm64_linux:  "f3881f6064c2376b08fac01154cc3025c48f833dfabcdda3d57b63c59e9fe780",
         x86_64_linux: "6dc121749fe7f8ce1b3bd677d4079dbe8abf5f3102b79372762245a7d6b06660"

  on_macos do
    depends_on macos: :monterey

    app "Liseur.app"

    postflight do
      system_command "/usr/bin/xattr",
                     args: ["-dr", "com.apple.quarantine", "#{appdir}/Liseur.app"],
                     sudo: false
    end

    # Nothing here is written unless you run the application, and none of it
    # comes back once removed: the library index, the reading positions and
    # the annotations all live in the first of these.
    zap trash: [
      "~/Library/Application Support/Liseur",
      "~/Library/Logs/Liseur",
      "~/Library/Preferences/com.chmouel.liseur.plist",
      "~/Library/Saved Application State/com.chmouel.liseur.savedState",
    ]

    caveats <<~EOS
      This build is not signed: a certificate is hard to justify for a hobby
      project, and the release carries build provenance instead, which says
      where a file came from rather than who paid for it.

      The quarantine flag is cleared automatically during install so macOS
      will not block the application from opening.
    EOS
  end
  on_linux do
    app_image "liseur-desktop-#{version}-linux-#{arch}.AppImage", target: "Liseur.AppImage"

    zap trash: [
      "~/.cache/Liseur",
      "~/.config/Liseur",
    ]
  end

  url "https://github.com/chmouel/liseur-desktop/releases/download/v#{version}/liseur-desktop-#{version}-#{os}-#{arch}.#{extension}"
  name "Liseur"
  desc "Snappy desktop EPUB reader"
  homepage "https://github.com/chmouel/liseur-desktop"

  livecheck do
    url :url
    strategy :github_latest
  end
end
