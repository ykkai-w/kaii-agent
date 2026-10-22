const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { configureApplicationIdentity, resolveBundledSkillDirectory } = require("../../electron/lib/app-identity.cjs");

function appFor(userData, sessionData = userData) {
  const paths = { appData: "/profiles", userData, sessionData };
  return { paths, getPath: (key) => paths[key], setPath: (key, value) => { paths[key] = value; }, setName(name) { this.name = name; } };
}

test("renaming the app reuses the existing conversation and credential profile", () => {
  const app = appFor(path.join("/profiles", "kaii-agent"));
  assert.equal(configureApplicationIdentity(app, (file) => file === path.join("/profiles", "kaii")), path.join("/profiles", "kaii"));
  assert.equal(app.paths.sessionData, app.paths.userData);
  assert.equal(app.name, "kaii-agent");
});

test("new installations use the new profile name", () => {
  const app = appFor(path.join("/profiles", "kaii-agent"));
  assert.equal(configureApplicationIdentity(app, () => false), path.join("/profiles", "kaii-agent"));
});

test("explicit user and browser test profiles are preserved", () => {
  const app = appFor("/isolated/user", "/isolated/session");
  assert.equal(configureApplicationIdentity(app, () => true), "/isolated/user");
  assert.equal(app.paths.sessionData, "/isolated/session");
});

test("a moved bundled skill directory follows the renamed app while custom paths stay unchanged", () => {
  const previous = "/Applications/kaii.app/Contents/Resources/app.asar/resources/skills";
  const current = "/Applications/kaii-agent.app/Contents/Resources/app.asar/resources/skills";
  assert.equal(resolveBundledSkillDirectory(previous, current, () => false), current);
  assert.equal(resolveBundledSkillDirectory(previous, current, () => true), previous);
  assert.equal(resolveBundledSkillDirectory("/my/skills", current, () => false), "/my/skills");
});
