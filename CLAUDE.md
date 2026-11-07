# CLAUDE.md

pi package with several extensions for [pi](https://pi.dev), listed in `package.json` under `pi.extensions`. User-facing docs are in `README.md` (English).

## Where a feature goes

- Build every feature into the extension it belongs to. Each extension has one purpose (see the list at the top of `README.md`); match the feature to that purpose, not to where the code is easiest to add.
- If no extension fits, **ask the user** whether it should become a new extension. Don't create one, and don't squeeze the feature into an unrelated one, without that answer.
- Each extension can be switched off on its own (`pi config`), so extensions talk only through event channels. From another extension's folder, import only channel names and their types (e.g. `shared/agent-bus.ts`), never its logic. Code shared by several extensions goes into `extensions/shared/`.
- A new extension gets its own folder `extensions/<name>/index.ts`, an entry in `package.json` under `pi.extensions` (name it in `description` only if the one-line summary there would otherwise be wrong), a line in the list at the top of `README.md`, a section in `README.md` and rows in its Development layout table.

## Commit and push every change

- **Commit and push every change to an extension** once it is done and `npm run check` and `npm test` pass. Don't leave extension changes uncommitted.
- One commit per logical change. Subject: `<extension>: <what the user now sees or gets>`, in English, lowercase after the colon, e.g. `chat-view: queued messages marked with ◷`.
- No `Co-Authored-By` trailer.
- Stage only the files of your change (`git add <paths>`). Another session may be working in this repo at the same time; leave its uncommitted changes alone.
- Push to `origin/main` right after each commit. If the push is rejected, rebase onto `origin/main`, run the checks again and push; never force-push.

## Build / test

```bash
npm run check   # type check against the types of the installed pi version
npm test        # node test runner, also against the installed pi
```

- There is no local `node_modules`: `scripts/pi-modules.mjs` resolves pi's installed packages, so the checks follow the pi version in use.
- Tests are in `test/*.test.ts`; `test/fake-claude.mjs` stands in for the Claude Code CLI, `test/fake-agy.mjs` for the Antigravity CLI.
- The package is installed locally (`~/.pi/agent/settings.json` → `packages`), so pi loads straight from this folder. Changes take effect after `/reload` in pi.

## Keeping docs current

If a change makes `README.md` wrong (features, commands, env vars, files, the Development layout table), fix it in the same commit.
