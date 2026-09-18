"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

global.window = {};
require("../gif-analyzer.js");

function signature(value) {
  return new Uint8Array(20 * 20 * 4).fill(value);
}

function framesForSegments(segmentLengths) {
  const frames = [];
  let elapsed = 0;
  let visualValue = 0;

  const addFrame = (difference, delayMs = 30) => {
    visualValue += difference;
    frames.push({
      startMs: elapsed,
      delayMs,
      hash: frames.length + 1,
      signature: signature(visualValue)
    });
    elapsed += delayMs;
  };

  addFrame(0);
  segmentLengths.forEach((length) => {
    for (let index = 0; index < length; index += 1) addFrame(8);
    for (let index = 0; index < 12; index += 1) addFrame(1);
  });
  while (elapsed < 4000) addFrame(1, Math.min(30, 4000 - elapsed));
  addFrame(0, 4000);
  return frames;
}

test("does not merge separate visual transitions into one frame count", () => {
  const summary = window.GifAnalyzer.summarizeFrames(framesForSegments([10, 8, 10]));
  assert.equal(summary.maxTransitionFrames, 10);
});

test("still reports a single visual transition longer than ten frames", () => {
  const summary = window.GifAnalyzer.summarizeFrames(framesForSegments([11]));
  assert.equal(summary.maxTransitionFrames, 11);
});

test("measures the exact unchanged tail instead of splitting at four seconds", () => {
  const frames = [
    { startMs: 0, delayMs: 3000, hash: 1, signature: signature(0) },
    { startMs: 3000, delayMs: 580, hash: 2, signature: signature(8) },
    { startMs: 3580, delayMs: 1000, hash: 2, signature: signature(8) },
    { startMs: 4580, delayMs: 3000, hash: 2, signature: signature(8) }
  ];
  const summary = window.GifAnalyzer.summarizeFrames(frames);
  assert.equal(summary.totalMs, 7580);
  assert.equal(summary.dynamicMs, 3000);
  assert.equal(summary.staticMs, 4580);
});
