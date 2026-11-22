import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  ContractFunctionRevertedError, decodeEventLog, encodeFunctionData, keccak256, RpcRequestError,
  TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError,
} from "viem";

export const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function guestBidStatus(order) {
  const show = (leg) => leg.placement
    ? { state: "placed", ...leg.placement }
    : { saleId: leg.saleId, state: leg.ended ?? "waiting" };
  return { ...show(order.primary), ...(order.backup && { backup: show(order.backup) }) };
}

// One guest server owns the file and its existing per-wallet queue serializes calls to advance.
export function guestBids({ file, pub, sale, kit, guests, targets, checkBackup }) {
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const orders = new Map(saved.map((order) => [order.id, order]));
  const finished = (leg) => leg.placement || leg.ended;
  const nextLeg = (order) => !finished(order.primary) ? "primary" :
    order.primary.placement && order.backup && !finished(order.backup) ? "backup" : null;
  const signed = (order) => order[nextLeg(order)]?.signed;
  const endedLeg = ({ saleId, fingerprint }, ended) => ({ saleId, fingerprint, ended });

  function save(order) {
    const next = [...orders.values()].filter((entry) => entry.id !== order.id);
    writeFileSync(`${file}.tmp`, JSON.stringify([...next, order]), { mode: 0o600, flush: true });
    renameSync(`${file}.tmp`, file);
    orders.set(order.id, order);
    return order;
  }

  const update = (order, name, fields) => save({ ...order, [name]: { ...order[name], ...fields } });
  const end = (order, name, ended) => save({
    ...order, [name]: endedLeg(order[name], ended),
    ...(name === "primary" && order.backup && { backup: endedLeg(order.backup, "skipped") }),
  });

  async function primaryClaim(order, tip) {
    const { saleId, bidIndex, block } = order.primary.placement;
    const args = [BigInt(saleId), BigInt(bidIndex)];
    const [bidder, fingerprint, , , , opened, claimed] = await pub.readContract({ ...sale, functionName: "bids", args });
    if (!claimed) return;
    if (bidder.toLowerCase() !== order.guest.toLowerCase() || fingerprint !== order.primary.fingerprint) {
      throw new Error("The on-chain primary bid does not match the queued backup.");
    }
    if (!opened) return false;
    // Look for the exact claim, newest blocks first so a regular keeper pass needs one log query.
    for (let to = tip; to >= BigInt(block);) {
      const from = to - BigInt(block) > 9_999n ? to - 9_999n : BigInt(block);
      const [claim] = await pub.getContractEvents({
        ...sale, eventName: "Claimed", args: { saleId: args[0], bidIndex: args[1] }, fromBlock: from, toBlock: to,
      });
      if (claim) return claim.args.assetAmount === 0n && claim.args.refund >= BigInt(order.primary.deposit);
      to = from - 1n;
    }
  }

  async function advance(id) {
    let order = orders.get(id);
    const name = nextLeg(order);
    if (!name) return order;
    let leg = order[name];
    const guest = guests.find((account) => account.evm === order.guest);
    if (!guest) throw new Error("The managed guest account is unavailable.");
    const tip = await pub.getBlock();
    let receipt;
    if (leg.signed) {
      try {
        receipt = await pub.getTransactionReceipt({ hash: leg.signed.hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
    }
    if (!receipt) {
      if (tip.timestamp >= BigInt(leg.closeAt)) return end(order, name, "expired");
      if (!leg.signed) {
        if ([...orders.values()].some((other) => other.id !== id && other.guest === order.guest && signed(other))) return order;
        if (name === "backup") {
          const eligible = await primaryClaim(order, tip.number);
          if (eligible === undefined) return order;
          if (!eligible) return end(order, name, "skipped");
          if (!(await checkBackup(order))) return end(order, name, "failed");
        }
        if (await kit.fusdOf(guest.evm) < BigInt(leg.deposit)) return name === "primary" ? end(order, name, "failed") : order;
        const windowTx = await kit.ensureWindow(guest, targets);
        const args = [BigInt(leg.saleId), leg.fingerprint, leg.envelope];
        const call = { ...sale, functionName: "placeBid", args };
        try {
          await pub.simulateContract({ ...call, account: guest.evm });
        } catch (error) {
          const revert = error.walk?.((cause) => cause instanceof ContractFunctionRevertedError);
          if (revert instanceof ContractFunctionRevertedError &&
              (/^0x(?:[\da-f]{2}){4,}$/i.test(revert.raw ?? "") || /^execution reverted\b/i.test(revert.reason ?? ""))) {
            return end(order, name, "failed");
          }
          throw error;
        }
        const request = await guest.wallet.prepareTransactionRequest({
          to: sale.address, data: encodeFunctionData(call),
        });
        const raw = await guest.wallet.signTransaction(request);
        order = update(order, name, { signed: { raw, hash: keccak256(raw), windowTx } });
        leg = order[name];
      }
      // An uncertain submission can only retry these exact signed bytes, never a fresh nonce. A network failure
      // is retried; a node that answers with a refusal (no window, nonce already used) means these bytes can never
      // land, so the bid ends as failed and frees its guest instead of holding it until the sale closes.
      try {
        await pub.sendRawTransaction({ serializedTransaction: leg.signed.raw });
      } catch (error) {
        const refusal = error.walk?.((cause) => cause instanceof RpcRequestError);
        if (refusal && !/already known|known transaction|already in (the )?mempool/i.test(refusal.details ?? refusal.message)) {
          const landed = await pub.getTransactionReceipt({ hash: leg.signed.hash }).catch(() => null);
          if (!landed) return end(order, name, "failed");
        }
      }
      try {
        receipt = await pub.waitForTransactionReceipt({ hash: leg.signed.hash, timeout: 12_000, checkReplacement: false });
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) return order;
        throw error;
      }
    }
    if (receipt.transactionHash !== leg.signed.hash) throw new Error("Unexpected guest transaction receipt.");
    if (receipt.status !== "success") return end(order, name, "failed");
    const placed = receipt.logs.filter((log) => log.address.toLowerCase() === sale.address.toLowerCase()).flatMap((log) => {
      try {
        const event = decodeEventLog({ abi: sale.abi, data: log.data, topics: log.topics, eventName: "BidPlaced" });
        return event.eventName === "BidPlaced" ? [event.args] : [];
      } catch {
        return [];
      }
    }).find((args) => args.saleId === BigInt(leg.saleId) && args.bidder.toLowerCase() === guest.evm.toLowerCase() && args.fingerprint === leg.fingerprint);
    if (!placed) throw new Error("The guest transaction did not emit its expected bid.");
    const placement = {
      saleId: leg.saleId, bidIndex: Number(placed.bidIndex), guest: guest.evm,
      tx: receipt.transactionHash, block: Number(receipt.blockNumber), windowTx: leg.signed.windowTx,
    };
    return save({
      ...order, [name]: { saleId: leg.saleId, fingerprint: leg.fingerprint, deposit: leg.deposit, placement },
    });
  }

  return {
    get: (id) => orders.get(id),
    save,
    advance,
    pending: () => [...orders.values()].filter(nextLeg),
    busy: (guest) => [...orders.values()].some((order) => order.guest === guest &&
      (!finished(order.primary) || (order.backup?.signed && !finished(order.backup)))),
    placements: (saleId) => [...orders.values()].flatMap((order) => [order.primary.placement, order.backup?.placement])
      .filter((bid) => bid?.saleId === saleId),
  };
}
