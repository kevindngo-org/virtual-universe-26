// Training fixture only: intentionally pinned to outdated packages so
// Dependabot raises alerts. Do not import this from docs/ or any exercise.
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const marked = require("marked");
const argv = require("minimist")(process.argv.slice(2));

const outDir = argv.out || "dist";
const secret = process.env.GALLERY_SIGNING_SECRET || "local-dev-only";

function readHighlights() {
  const file = path.join(__dirname, "..", "..", "universe-notes", "notes", "keynote-highlights.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).highlights;
}

// jsonwebtoken 9 requires an explicit `algorithms` option when verifying.
function verifyShareToken(token) {
  return jwt.verify(token, secret);
}

function build() {
  const byTopic = _.groupBy(readHighlights(), "topic");
  const sections = _.map(byTopic, (items, topic) =>
    `<section><h2>${topic}</h2>${items.map((item) => marked(`**${item.title}**: ${item.summary}`)).join("")}</section>`
  );
  const shareToken = jwt.sign({ gallery: "universe-26" }, secret, { expiresIn: "7d" });
  verifyShareToken(shareToken);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), `<!doctype html><title>Badge gallery</title>${sections.join("")}`);
  console.log(`Wrote ${path.join(outDir, "index.html")}`);
}

build();
