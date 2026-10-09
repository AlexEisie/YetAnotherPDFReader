# Notes for contributors and coding agents

## Releasing a new version

1. Bump the version in `package.json`, the workspace `Cargo.toml` and `src-tauri/tauri.conf.json`.
2. **Add a "what's new" entry** for the version at the top of `RELEASE_NOTES` in
   `src/help/releaseNotes.ts`: a few lines in Chinese and English, one feature per line.
   It is shown once on the first start after updating; `npm test` fails without it.
3. Add the full notes to `CHANGELOG.md` (both languages) and update the READMEs.
4. Run the tests (see "测试 / Tests" in the README), build, tag `vX.Y.Z` and publish the release.
