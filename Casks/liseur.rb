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

  version "0.2.1"
  sha256 arm:          "bd23cb9aa3225152a39a8a69bc617a0db3a15ffed34ca66be86c427e74db253c",
         intel:        "84a913cbcfc41dec41ba8d7c553820353a12e52b7248e2bb2a5facebd11b3dde",
         arm64_linux:  "ef3685e831d39fd0fa3b8b391362d58f231a30e60d065e123efd7c5767ecf797",
         x86_64_linux: "1ff98674dc73e2014f2a63c3b81832cfe29a2b88d0480626c25cc8edfc1d7662"

  on_macos do
    depends_on macos: :monterey

    app "Liseur.app"

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

      Homebrew quarantines what it downloads, and macOS refuses to open a
      quarantined application that carries no signature. Clear the flag once:

        xattr -dr com.apple.quarantine "#{appdir}/Liseur.app"

      Passing --no-quarantine to `brew install` avoids the step, at the cost
      of exempting the download from Gatekeeper before you have seen it.
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
