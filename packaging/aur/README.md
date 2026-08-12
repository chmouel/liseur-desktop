# Arch package

`liseur-desktop-bin` in the AUR is built from `PKGBUILD.in` by the release
workflow: it fills in the version and the checksums of the release that was
just published, regenerates `.SRCINFO`, and pushes to
`ssh://aur@aur.archlinux.org/liseur-desktop-bin.git`.

Change the packaging here. The copy in the AUR repository is overwritten on
every tag, so edits made there are lost.

Pushing needs the `AUR_SSH_PRIVATE_KEY` repository secret, holding an SSH
key registered with the AUR account that maintains the package. Without it
the job warns and does nothing, which keeps the rest of a release working
for anyone who forks this.

To try a change without tagging anything:

```
sed -e 's/@PKGVER@/0.1.0/' -e 's/@SHA_[A-Z0-9_]*@/SKIP/g' PKGBUILD.in > /tmp/PKGBUILD
cd /tmp && makepkg -f
```
