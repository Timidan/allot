import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContractFunctionRevertedError, RpcRequestError, TransactionReceiptNotFoundError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, keccak256, parseAbi, WaitForTransactionReceiptTimeoutError } from "viem";
import { guestBids, guestBidStatus } from "./guest-bids.mjs";

test("a win skips the backup and a confirmed loss can recover one broadcast after restart", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "allot-bid-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "guest-bids.json");
  const guest = "0x0000000000000000000000000000000000000123";
  const primaryFingerprint = `0x${"11".repeat(32)}`;
  const backupFingerprint = `0x${"22".repeat(32)}`;
  const raw = "0x0102";
  const hash = keccak256(raw);
  const address = "0x0000000000000000000000000000000000000456";
  const abi = parseAbi([
    "function placeBid(uint256,bytes32,bytes) returns (uint256)",
    "event BidPlaced(uint256 indexed saleId,uint256 indexed bidIndex,address indexed bidder,bytes32 fingerprint,bytes envelope)",
  ]);
  const receipt = {
    transactionHash: hash, status: "success", blockNumber: 30n,
    logs: [{
      address, topics: encodeEventTopics({ abi, eventName: "BidPlaced", args: { saleId: 8n, bidIndex: 0n, bidder: guest } }),
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [backupFingerprint, "0xab"]),
    }],
  };
  let sends = 0;
  let claimed = false;
  const pub = {
    getBlock: async () => ({ number: 30n, timestamp: 50n }),
    readContract: async () => [guest, primaryFingerprint, 1n, 1n, 0n, true, claimed],
    getContractEvents: async ({ args }) => [{ args: { assetAmount: args.bidIndex === 0n ? 1n : 0n, refund: 10n } }],
    simulateContract: async () => {},
    sendRawTransaction: async ({ serializedTransaction }) => {
      assert.equal(serializedTransaction, raw);
      sends++;
      throw new Error("Broadcast accepted and response lost");
    },
    waitForTransactionReceipt: async () => { throw new WaitForTransactionReceiptTimeoutError({ hash }); },
    getTransactionReceipt: async ({ hash: requested }) => {
      assert.equal(requested, hash);
      return receipt;
    },
  };
  const make = () => guestBids({
    file, pub, sale: { address, abi },
    guests: [{ evm: guest, wallet: { prepareTransactionRequest: async () => ({}), signTransaction: async () => raw } }],
    kit: { fusdOf: async () => 10n, ensureWindow: async () => null }, targets: [], checkBackup: async () => true,
  });
  const order = (id, bidIndex) => ({
    id, guest,
    primary: { saleId: 7, deposit: "10", fingerprint: primaryFingerprint, placement: { saleId: 7, bidIndex, block: 20 } },
    backup: { saleId: 8, deposit: "10", closeAt: "100", fingerprint: backupFingerprint, envelope: "0xab" },
  });
  const first = make();
  first.save(order("win", 0));
  first.save(order("loss", 1));
  await first.advance("loss");
  assert.equal(sends, 0);
  claimed = true;
  assert.equal(guestBidStatus(await first.advance("win")).backup.state, "skipped");
  assert.equal(guestBidStatus(await first.advance("loss")).backup.state, "waiting");
  assert.equal(sends, 1);
  const restarted = make();
  assert.equal(guestBidStatus(await restarted.advance("loss")).backup.tx, hash);
  assert.equal(guestBidStatus(await restarted.advance("loss")).backup.state, "placed");
  assert.equal(sends, 1);
});

test("a refused primary bid releases the sponsored guest", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "allot-bid-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const guest = "0x0000000000000000000000000000000000000123";
  const abi = parseAbi(["function placeBid(uint256,bytes32,bytes) returns (uint256)", "error TooManyBids()"]);
  let providerReady = false;
  const orders = guestBids({
    file: join(folder, "guest-bids.json"), guests: [{ evm: guest }], targets: [],
    sale: { address: "0x0000000000000000000000000000000000000456", abi },
    kit: { fusdOf: async () => 10n, ensureWindow: async () => null },
    pub: {
      getBlock: async () => ({ number: 20n, timestamp: 10n }),
      simulateContract: async () => {
        const cause = providerReady ? { data: encodeErrorResult({ abi, errorName: "TooManyBids" }) } : { message: "provider unavailable" };
        throw new ContractFunctionRevertedError({ abi, functionName: "placeBid", ...cause });
      },
    },
  });
  orders.save({
    id: "refused", guest,
    primary: { saleId: 7, closeAt: "100", deposit: "10", fingerprint: `0x${"11".repeat(32)}`, envelope: "0xab" },
  });
  await assert.rejects(orders.advance("refused"), /provider unavailable/);
  assert.equal(guestBidStatus(orders.get("refused")).state, "waiting");
  providerReady = true;
  assert.equal(guestBidStatus(await orders.advance("refused")).state, "failed");
  assert.equal(orders.busy(guest), false);
});

test("a bid the node refuses outright frees its guest", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "allot-bid-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const guest = "0x0000000000000000000000000000000000000123";
  const abi = parseAbi(["function placeBid(uint256,bytes32,bytes) returns (uint256)"]);
  const orders = guestBids({
    file: join(folder, "guest-bids.json"), targets: [], sale: { address: "0x0000000000000000000000000000000000000456", abi },
    guests: [{ evm: guest, wallet: { prepareTransactionRequest: async () => ({}), signTransaction: async () => "0x0102" } }],
    kit: { fusdOf: async () => 10n, ensureWindow: async () => null },
    pub: {
      getBlock: async () => ({ number: 20n, timestamp: 10n }),
      simulateContract: async () => {},
      getTransactionReceipt: async ({ hash }) => { throw new TransactionReceiptNotFoundError({ hash }); },
      sendRawTransaction: async () => {
        throw new RpcRequestError({ body: {}, url: "http://node", error: { code: -32000, message: "has no open EVM authorisation window" } });
      },
    },
  });
  orders.save({ id: "refused", guest, primary: { saleId: 7, closeAt: "100", deposit: "10", fingerprint: `0x${"11".repeat(32)}`, envelope: "0xab" } });
  assert.equal(guestBidStatus(await orders.advance("refused")).state, "failed");
  assert.equal(orders.busy(guest), false);
});
