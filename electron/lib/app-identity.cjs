const fs = require("node:fs");
const path = require("node:path");

const APP_NAME = "kaii-agent";

function configureApplicationIdentity(app, exists = fs.existsSync) {
  const current = app.getPath("userData");
  const appData = app.getPath("appData");
  const legacy = path.join(appData, "kaii");
  const renamed = path.join(appData, APP_NAME);
  const isDefault = current === legacy || current === renamed;
  const userData = isDefault && exists(legacy) ? legacy : current;
  // Keep existing profiles and explicit test profiles in place when the display name changes.
  if (app.getPath("sessionData") === current) app.setPath("sessionData", userData);
  app.setPath("userData", userData);
  app.setName(APP_NAME);
  return userData;
}

function resolveBundledSkillDirectory(value, fallback, exists = fs.existsSync) {
  const oldBundle = /[\\/]kaii(?:-agent)?\.app[\\/]Contents[\\/]Resources[\\/]app\.asar[\\/]resources[\\/]skills[\\/]?$/;
  return typeof value === "string" && oldBundle.test(value) && !exists(value) ? fallback : value;
}

module.exports = { APP_NAME, configureApplicationIdentity, resolveBundledSkillDirectory };
