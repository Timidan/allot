import assert from "node:assert/strict";
import test from "node:test";
import { cut, isSplit, pack, rebuild, unpack } from "./split.mjs";

const seed = crypto.getRandomValues(new Uint8Array(32));

test("any two holders rebuild the seed; a wrong piece does not", () => {
  const pieces = cut(seed);
  for (const [i, j] of [[0, 1], [0, 2], [1, 2], [2, 0]]) assert.deepEqual(rebuild(i, pieces[i], j, pieces[j]), seed);
  const other = cut(crypto.getRandomValues(new Uint8Array(32)));
  assert.notDeepEqual(rebuild(0, pieces[0], 1, other[1]), seed);
  assert.throws(() => rebuild(1, pieces[1], 1, pieces[1]));
});

test("a split bid survives packing; a cut-off or padded one is refused", () => {
  const parts = [new Uint8Array(1880).fill(7), ...cut(seed)];
  const packed = pack(parts[0], parts.slice(1));
  assert.ok(isSplit(packed));
  const { bid, pieces } = unpack(packed);
  assert.deepEqual([bid, ...pieces].map((p) => [...p]), parts.map((p) => [...p]));
  assert.equal(unpack(packed.subarray(0, packed.length - 1)), null);
  assert.equal(unpack(Uint8Array.from([...packed, 0, 1, 9])), null);
  assert.equal(isSplit(new Uint8Array(3544)), false);
});
