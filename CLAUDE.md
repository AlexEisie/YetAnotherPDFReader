# Notes for contributors and coding agents

## Releasing a new version

1. Bump the version in `package.json`, the workspace `Cargo.toml` and `src-tauri/tauri.conf.json`.
2. **Add a "what's new" entry** for the version at the top of `RELEASE_NOTES` in
   `src/help/releaseNotes.ts`: a few lines in Chinese and English, one feature per line.
   It is shown once on the first start after updating; `npm test` fails without it.
3. Add the full notes to `CHANGELOG.md` (both languages) and update the READMEs. The release
   notes on GitHub are generated from the version's CHANGELOG sections
   (`scripts/release-notes.mjs`); `docs/releases/vX.Y.Z.md` is put above them if it exists.
4. Run the tests locally, including the end-to-end ones that drive the real app (see
   "测试 / Tests" in the README); CI only runs the unit tests.
5. Commit, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The Release workflow
   (`.github/workflows/release.yml`) builds Windows, macOS and Linux and publishes the release
   once every job succeeds; nothing needs to be built locally.

## Changing the app icon

Run `python scripts/make-icons.py <icon.png>` (transparent PNG, 1024 px or larger), then
`node scripts/readme-shots.mjs`, and `cargo clean -p yapr` (and `--release`, and in the Linux
build directory) before building: Cargo does not notice changed icons.
