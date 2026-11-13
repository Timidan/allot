// Bidding from the visitor's own QoreX wallet (QoreX 0.4.0 or later, with its testnet turned on in developer mode).
// The deposit approval and the bid are EVM calls QoreX signs (eth_sendTransaction). Turning faucet fUSD into the
// token the sale takes is a native QoreChain transaction QoreX signs with ML-DSA-87. The post-quantum pass (EVM
// access window) is opened by the visitor in QoreX itself: QoreX refuses it from a website.
import { evmWindowStatus } from "@qorechain/evm";
import { discoverQorexEip1193, getQorexNative, hasCapability } from "@qorechain/qorex-types";
import { encodeFunctionData, parseAbi } from "viem";
import { SALE_CONTRACT } from "../sale.js";
import { pub, toQor } from "./chain.js";

const CHAIN = "qorechain-diana";
const EVM_CHAIN = "0x2648"; // 9800
export const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const saleAbi = parseAbi(["function isHybridHolder(address) view returns (bool)", "function placeBid(uint256 saleId, bytes32 fingerprint, bytes envelope) returns (uint256)"]);
const rest = (path) => fetch(`${location.origin}/rest${path}`).then((r) => r.json());

// A minimal protobuf writer: enough for the native message below.
const enc = new TextEncoder();
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const bytesField = (no, bytes) => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const str = (no, s) => (s ? bytesField(no, [...enc.encode(s)]) : []);

// cosmos.evm.erc20.v1.MsgConvertCoin { coin = 1 { denom = 1; amount = 2 }; receiver = 2; sender = 3 }
export const convertMsg = (sender, receiver, amount) => ({
  typeUrl: "/cosmos.evm.erc20.v1.MsgConvertCoin",
  value: Uint8Array.from([...bytesField(1, [...str(1, `erc20:${FUSD}`), ...str(2, String(amount))]), ...str(2, receiver), ...str(3, sender)]),
});

// QoreX's EVM provider, found by its EIP-6963 announcement (QoreChain's qorex-types kit); null if QoreX isn't installed.
export const findQorex = () => discoverQorexEip1193({ timeoutMs: 600 }).then((p) => p ?? null);

export async function connect(provider) {
  const [address] = await provider.request({ method: "eth_requestAccounts" });
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: EVM_CHAIN }] });
  } catch (e) {
    if (e.code === 4902) throw new Error("Switch QoreX to testnet in its settings (developer mode in the extension, Use testnet in the app), then try again.");
    throw e;
  }
  return address;
}

// What this account still needs before it can bid: a registered post-quantum key, enough fUSD, and an open pass.
export async function readiness(address, deposit) {
  const qor = toQor(address);
  const [holder, token, coins, pass] = await Promise.all([
    pub.readContract({ address: SALE_CONTRACT, abi: saleAbi, functionName: "isHybridHolder", args: [address] }),
    pub.readContract({ address: FUSD, abi: erc20, functionName: "balanceOf", args: [address] }),
    rest(`/cosmos/bank/v1beta1/balances/${qor}`).then((b) => b.balances ?? []),
    evmWindowStatus({ rest: `${location.origin}/rest`, address: qor }),
  ]);
  const coin = (denom) => BigInt(coins.find((c) => c.denom === denom)?.amount ?? 0);
  const bank = coin(`erc20:${FUSD}`);
  // The pass is opened in QoreX's own popup (QoreX refuses MsgOpenEVMWindow from a website), so any live
  // pass will do if it is unscoped or lets through both the sale and fUSD.
  const targets = pass.allowedTargets.map((x) => x.toLowerCase());
  const passOk = pass.live && (!targets.length || [SALE_CONTRACT, FUSD].every((t) => targets.includes(t.toLowerCase()))) && pass.remainingTxs > 3n && pass.remainingBlocks > 100n;
  // fusd and uqor are for the header's wallet panel: all the account's fUSD (both forms), and its QOR in micro-units.
  return { qor, holder, toConvert: token >= deposit ? 0n : deposit - token, canConvert: token + bank >= deposit, passOk, fusd: token + bank, uqor: coin("uqor") };
}

// One quantum-safe native transaction that converts fUSD if short. The pass is the visitor's to open in QoreX.
export async function prepare(qor, address, { toConvert }) {
  if (!toConvert) return null;
  const messages = [convertMsg(qor, address, toConvert)];
  const native = getQorexNative();
  if (!hasCapability(native, "signAndBroadcast")) throw new Error("Update QoreX to sign QoreChain transactions from this page.");
  await native.enable(CHAIN);
  const r = await native.signAndBroadcast({ chainId: CHAIN, messages, gasLimit: 500000 });
  if (r.code) throw new Error(`QoreChain refused the transaction (code ${r.code}).`);
  await new Promise((ok) => setTimeout(ok, 4000)); // let the pass take effect before the EVM calls
  return r.txHash;
}

const send = async (provider, from, to, data) => {
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("The transaction failed on chain.");
  return hash;
};

// The deposit approval (only if needed), then the sealed bid itself.
export async function placeOwn(provider, address, saleId, deposit, fingerprint, envelopeHex) {
  const allowed = await pub.readContract({ address: FUSD, abi: erc20, functionName: "allowance", args: [address, SALE_CONTRACT] });
  if (allowed < deposit) await send(provider, address, FUSD, encodeFunctionData({ abi: erc20, functionName: "approve", args: [SALE_CONTRACT, deposit] }));
  return send(provider, address, SALE_CONTRACT, encodeFunctionData({ abi: saleAbi, functionName: "placeBid", args: [BigInt(saleId), fingerprint, envelopeHex] }));
}
