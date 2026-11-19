import assert from "node:assert/strict";
import test from "node:test";

import { engineOcrPathUpdate, isManagedEngineOcrPath } from "../src/shared/engine-ocr-paths.js";

const engineState = {
  ocrSidecarDir: "C:\\Users\\Reader\\AppData\\Local\\UVReader\\engine\\0.1.17\\pdf-tool",
  ocrPython: "C:\\Users\\Reader\\AppData\\Local\\UVReader\\engine\\0.1.17\\python\\python.exe",
};

test("only app-managed engine paths are treated as replaceable", () => {
  assert.equal(isManagedEngineOcrPath(engineState.ocrSidecarDir), true);
  assert.equal(isManagedEngineOcrPath("C:\\tools\\pdf_tool"), false);
  assert.equal(isManagedEngineOcrPath("/Users/reader/Library/Application Support/UVReader/engine/0.1.17/pdf-tool"), true);
  assert.equal(isManagedEngineOcrPath("C:\\Users\\Reader\\AppData\\Roaming\\uvreader-desktop\\engine\\0.1.17\\pdf-tool"), true);
  assert.equal(isManagedEngineOcrPath(""), false);
});

test("an empty OCR configuration adopts the installed engine paths", () => {
  assert.deepEqual(engineOcrPathUpdate({}, engineState), {
    ocrSidecarDir: engineState.ocrSidecarDir,
    ocrPython: engineState.ocrPython,
    ocrSidecarExe: "",
  });
  assert.deepEqual(engineOcrPathUpdate({ ocrPython: "python" }, engineState), {
    ocrSidecarDir: engineState.ocrSidecarDir,
    ocrPython: engineState.ocrPython,
    ocrSidecarExe: "",
  });
});

test("an OCR configuration from an older engine is upgraded", () => {
  const old = {
    ocrSidecarDir: "C:\\Users\\Reader\\AppData\\Local\\UVReader\\engine\\0.1.12\\pdf-tool",
    ocrPython: "C:\\Users\\Reader\\AppData\\Local\\UVReader\\engine\\0.1.12\\python\\python.exe",
  };
  assert.deepEqual(engineOcrPathUpdate(old, engineState), {
    ocrSidecarDir: engineState.ocrSidecarDir,
    ocrPython: engineState.ocrPython,
    ocrSidecarExe: "",
  });
});

test("a custom OCR path is never overwritten", () => {
  assert.equal(engineOcrPathUpdate({
    ocrSidecarDir: "D:\\tools\\pdf_tool",
    ocrPython: "D:\\Python311\\python.exe",
  }, engineState), null);
  assert.equal(engineOcrPathUpdate({
    ocrSidecarDir: "D:\\tools\\pdf_tool",
  }, engineState), null);
  assert.equal(engineOcrPathUpdate({
    ocrSidecarExe: "D:\\tools\\pdf-sidecar.exe",
  }, engineState), null);
  assert.equal(engineOcrPathUpdate({
    ocrSidecarDir: engineState.ocrSidecarDir,
    ocrPython: "D:\\Python311\\python.exe",
  }, engineState), null);
});

test("already-current paths are left alone, but a placeholder python is completed", () => {
  assert.equal(engineOcrPathUpdate(engineState, engineState), null);
  assert.deepEqual(engineOcrPathUpdate({ ...engineState, ocrPython: "python" }, engineState), {
    ocrSidecarDir: engineState.ocrSidecarDir,
    ocrPython: engineState.ocrPython,
    ocrSidecarExe: "",
  });
  assert.equal(engineOcrPathUpdate({}, {}), null);
});

test("a stale managed sidecar executable is cleared in favor of the engine", () => {
  assert.deepEqual(engineOcrPathUpdate({
    ocrSidecarExe: "C:\\Users\\Reader\\AppData\\Local\\UVReader\\engine\\0.1.12\\pdf-sidecar.exe",
  }, engineState), {
    ocrSidecarDir: engineState.ocrSidecarDir,
    ocrPython: engineState.ocrPython,
    ocrSidecarExe: "",
  });
});
