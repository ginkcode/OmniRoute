import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/api/system/version/route.ts", "utf8");

test("fork version endpoint reports the installed version without checking upstream", () => {
  assert.match(source, /current: APP_CONFIG\.version/);
  assert.match(source, /latest: APP_CONFIG\.version/);
  assert.match(source, /updateAvailable: false/);
  assert.match(source, /autoUpdateSupported: false/);
  assert.doesNotMatch(source, /resolveLatestVersionCached|validateAutoUpdateRuntime/);
});

test("fork web updater cannot install an upstream release", () => {
  assert.match(source, /export async function POST/);
  assert.match(source, /status: 403/);
  assert.doesNotMatch(source, /execFile|launchAutoUpdate|restartRunningServer/);
});

test("version endpoint retains authentication and conditional response support", () => {
  assert.equal((source.match(/await isAuthenticated\(req\)/g) ?? []).length, 2);
  assert.match(source, /If-None-Match/);
  assert.match(source, /status: 304/);
});
