// Bidding from the visitor's own QoreX wallet (QoreX 0.4.0 or later, with its testnet turned on in developer mode).
// The deposit approval and the bid are EVM calls QoreX signs (eth_sendTransaction) from an Ethereum (coin 60) account.
// The post-quantum pass (EVM access window) is opened by the visitor in QoreX itself, which also registers the
// account's ML-DSA-87 key the first time. QoreX won't sign MsgConvertCoin, so faucet fUSD (a bank coin) can't become
// the token the sale takes from a website: Allot's server sends token fUSD for a deposit instead (/api/fusd).
import { evmWindowStatus } from "@qorechain/evm";
import { discoverQorexEip1193 } from "@qorechain/qorex-types";
import { encodeFunctionData, parseAbi } from "viem";
import { SALE_CONTRACT } from "../sale.js";
import { pub, toQor } from "./chain.js";

const EVM_CHAIN = "0x2648"; // 9800
export const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const saleAbi = parseAbi(["function isHybridHolder(address) view returns (bool)", "function placeBid(uint256 saleId, bytes32 fingerprint, bytes envelope) returns (uint256)"]);
const rest = (path) => fetch(`${location.origin}/rest${path}`).then((r) => r.json());

// QoreX's EVM provider, found by its EIP-6963 announcement (QoreChain's qorex-types kit); null if QoreX isn't installed.
export const findQorex = () => discoverQorexEip1193({ timeoutMs: 600 }).then((p) => p ?? null);

export async function connect(provider) {
  const [address] = await provider.request({ method: "eth_requestAccounts" });
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: EVM_CHAIN }] });
  } catch (e) {
    if (e.code === 4902) throw Object.assign(new Error("QoreX is on mainnet. In QoreX, open Settings, then Developer mode, and turn on Use testnet. Then try again."), { help: 1 });
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
  // token: fUSD the sale can take; bank: faucet fUSD still in its bank form; uqor: QOR for fees, in micro-units.
  return { qor, holder, passOk, live: pass.live, token, bank, short: token >= deposit ? 0n : deposit - token, fusd: token + bank, uqor: coin("uqor") };
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
