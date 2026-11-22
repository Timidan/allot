import { SEED_LENGTH } from "@qorechain/qoreseal";
import { SALE_CONTRACT } from "../sale.js";

const STORAGE = "allot-receipts";
const hex = (value, bytes) => typeof value === "string" && value.length === 2 + 2 * bytes && /^0x[0-9a-f]+$/i.test(value);
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseLeg(value) {
  if (typeof value?.saleContract !== "string" || value.saleContract.toLowerCase() !== SALE_CONTRACT ||
      !/^\d{1,15}$/.test(String(value.saleId)) ||
      !hex(value.bidder, 20) || !hex(value.fingerprint, 32) || !hex(value.key, SEED_LENGTH) ||
      (value.tx !== undefined && !hex(value.tx, 32))) {
    throw new Error("Choose an Allot private receipt for this sale contract.");
  }
  return {
    saleContract: SALE_CONTRACT, saleId: String(Number(value.saleId)),
    bidder: value.bidder.toLowerCase(), fingerprint: value.fingerprint.toLowerCase(), key: value.key.toLowerCase(),
    ...(value.tx && { tx: value.tx.toLowerCase() }),
  };
}

// Also reads receipts downloaded before the versioned format. Keep only what the browser needs to open a bid.
export function parseReceipt(value) {
  const primary = parseLeg(value);
  const { version, requestId } = value;
  const backup = value.backup === undefined ? undefined : parseLeg(value.backup);
  if ((version !== undefined && version !== 1) ||
      (requestId !== undefined && (typeof requestId !== "string" || !requestIdPattern.test(requestId))) ||
      (backup && (!requestId || backup.saleId === primary.saleId || backup.bidder !== primary.bidder))) {
    throw new Error("This Allot private receipt is invalid.");
  }
  return { version: 1, ...primary, ...(requestId && { requestId }), ...(backup && { backup }) };
}

function stored() {
  const receipts = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
  return Array.isArray(receipts) ? receipts : [];
}

export function readReceipts() {
  try {
    return stored().flatMap((value) => {
      try { return [parseReceipt(value)]; } catch { return []; }
    }).reverse();
  } catch {
    return [];
  }
}

export function saveReceipt(value) {
  const receipt = parseReceipt(value);
  try {
    const entries = stored().filter((old) => old?.fingerprint !== receipt.fingerprint);
    localStorage.setItem(STORAGE, JSON.stringify([...entries, receipt]));
    return true;
  } catch {
    return false;
  }
}

export function downloadReceipt(value) {
  const receipt = parseReceipt(value);
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `allot-bid-${receipt.fingerprint.slice(2, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
