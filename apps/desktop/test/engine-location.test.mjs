import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { packageFamilyNameFromExecutable, resolveEngineRoot } from "../src/main/engine-location.js";

test("packageFamilyNameFromExecutable reads the MSIX identity from the install path", () => {
  const execPath = "C:\\Program Files\\WindowsApps\\com.uvreader.app_0.7.82.0_x64__ca693vjasbn68\\app\\UV Reader.exe";
  assert.equal(packageFamilyNameFromExecutable(execPath), "com.uvreader.app_ca693vjasbn68");
  assert.equal(packageFamilyNameFromExecutable("D:\\projects\\uvreader\\apps\\desktop\\dist\\win-unpacked\\UV Reader.exe"), "");
});

test("resolveEngineRoot uses a real LocalState path for MSIX packages", () => {
  const root = resolveEngineRoot({
    platform: "win32",
    localAppData: "C:\\Users\\UVReader\\AppData\\Local",
    execPath: "C:\\Program Files\\WindowsApps\\com.uvreader.app_0.7.82.0_x64__ca693vjasbn68\\app\\UV Reader.exe",
  });
  assert.equal(root, path.join("C:\\Users\\UVReader\\AppData\\Local", "Packages", "com.uvreader.app_ca693vjasbn68", "LocalState", "UVReader", "engine"));
});

test("resolveEngineRoot keeps the existing location for unpackaged Windows builds", () => {
  const root = resolveEngineRoot({
    platform: "win32",
    localAppData: "C:\\Users\\UVReader\\AppData\\Local",
    execPath: "D:\\projects\\uvreader\\apps\\desktop\\dist\\win-unpacked\\UV Reader.exe",
  });
  assert.equal(root, path.join("C:\\Users\\UVReader\\AppData\\Local", "UVReader", "engine"));
});

test("resolveEngineRoot respects explicit overrides and non-Windows fallbacks", () => {
  assert.equal(resolveEngineRoot({ override: "D:\\test-engine" }), "D:\\test-engine");
  assert.equal(resolveEngineRoot({ platform: "darwin", fallbackRoot: "/tmp/uvreader/engine" }), "/tmp/uvreader/engine");
});
