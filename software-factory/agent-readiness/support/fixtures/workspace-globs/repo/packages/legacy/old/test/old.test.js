import assert from "node:assert/strict";
import { test } from "node:test";
import { answer } from "../src/old.js";

test("answer", () => assert.equal(answer(), 42));
