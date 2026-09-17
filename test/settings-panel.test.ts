// Standalone behavior test: the native-style settings panel must map every
// cycling value back to a real setting change (label round-trips).
// Run: node --experimental-strip-types test/settings-panel.test.ts

import { getSettingsListTheme, initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
	if (cond) console.log(`  ✓ ${label}`);
	else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("settings-panel: every item cycles and reports via onChange");

const items: SettingItem[] = [
	{ id: "a", label: "A", currentValue: "true", values: ["true", "false"], description: "d-a" },
	{ id: "b", label: "B", currentValue: "2s", values: ["1s", "2s", "5s"], description: "d-b" },
];

const changes: Array<[string, string]> = [];
const list = new SettingsList(items, 10, getSettingsListTheme(), (id, v) => changes.push([id, v]), () => {});

// Simulate: select item 0, activate (Enter) → cycles true→false
list.selectItem("a");
list.handleInput("\r");
check("boolean item cycles and fires onChange", JSON.stringify(changes.at(-1)) === '["a","false"]', JSON.stringify(changes.at(-1)));

list.selectItem("b");
list.handleInput("\r"); // 2s → 5s
check("enum item cycles", JSON.stringify(changes.at(-1)) === '["b","5s"]', JSON.stringify(changes.at(-1)));

// Render must include the description hint of the selected item and the footer hint.
const rendered = list.render(80).join("\n");
check("description hint rendered for selected item", rendered.includes("d-b"), rendered.slice(-200));
check("footer hint rendered", rendered.includes("Enter/Space to change"), rendered.slice(-200));

process.exit(failures ? 1 : 0);
