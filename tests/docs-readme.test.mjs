import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("landing page README documents preview, architecture, canvases, and tests", async () => {
    const readme = await readFile(new URL("docs/README.md", root), "utf8");

    assert.match(readme, /python3 -m http\.server --directory docs 8000/);
    assert.match(readme, /GitHub Pages[\s\S]*`\/docs`/);
    assert.match(readme, /examples[\s\S]*prefers-reduced-motion/);
    assert.match(readme, /messages[\s\S]*same order/);
    assert.match(readme, /Keynote CTA/);
    assert.match(readme, /\.github\/extensions\/\*/);
    assert.match(readme, /node --test/);
    assert.match(readme, /security-lab\/[\s\S]*must not be linked/);
    assert.match(readme, /```mermaid[\s\S]*flowchart TD/);
});
