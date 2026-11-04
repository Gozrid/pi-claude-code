#!/bin/sh
# Sets up ~/.pi/agent with the settings in this folder:
# - keybindings.json, claude-code.json and extensions/* are linked, so changes show up in the repo
# - settings.json is merged into an existing one (values from here win) and gets this
#   checkout as a package, so pi loads the extensions straight from it
# Existing files that would be replaced are kept as <name>.bak.
set -e

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
agent=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}

mkdir -p "$agent/extensions"

link() {
	target=$agent/$1
	if [ -L "$target" ] && [ "$(readlink "$target")" = "$here/$1" ]; then
		echo "ok      $1"
		return
	fi
	if [ -e "$target" ] || [ -L "$target" ]; then
		mv "$target" "$target.bak"
		echo "backup  $1 → $1.bak"
	fi
	ln -s "$here/$1" "$target"
	echo "linked  $1"
}

link keybindings.json
link claude-code.json
for file in "$here"/extensions/*; do
	link "extensions/$(basename "$file")"
done

node - "$here/settings.json" "$agent/settings.json" "$repo" <<'EOF'
const fs = require("node:fs");
const [source, target, repo] = process.argv.slice(2);
const read = (path) => (fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {});
const merge = (a, b) => {
	for (const [key, value] of Object.entries(b)) {
		a[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(a[key] ?? {}, value) : value;
	}
	return a;
};
const settings = merge(read(target), read(source));
const packages = (settings.packages ?? []).filter((p) => !/pi-claude-code\/?$/.test(p));
settings.packages = [...packages, repo];
fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n");
console.log("merged  settings.json");
EOF

echo "Done. Start pi (or /reload in a running one)."
