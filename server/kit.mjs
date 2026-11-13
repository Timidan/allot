// QoreChain testnet helpers shared by the guest server and the guest setup script: accounts from one mnemonic,
// hybrid (ML-DSA-87) native transactions, EVM calls, and windows. Nothing here reads a key file; callers pass
// the mnemonic in.
import { StargateClient } from "@cosmjs/stargate";
import { deriveUnifiedAccount, EthNativeSigner, fetchEvmWindow, openEvmWindowMsg, qorechainRegistry } from "@qorechain/sdk";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CHAIN_ID = "qorechain-diana";
export const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const EVMRPC = "https://evm-testnet.qore.host";
export const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
export const SALE = "0x284b10c4760794d25c71dc90183c3dc9b6d1f42a";

export const chain = defineChain({ id: 9800, name: CHAIN_ID, nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [EVMRPC] } } });
export const pub = createPublicClient({ chain, transport: http(EVMRPC) });
export const fusd = { address: FUSD, abi: parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]) };
export const sale = {
  address: SALE,
  abi: parseAbi([
    "function getSale(uint256) view returns ((address issuer, address asset, uint64 closeAt, uint64 openBy, uint128 supply, uint128 reserve, uint128 deposit, uint128 unit, uint128 clearing, uint128 sold, uint128 penaltyShare, uint128 earned, uint128 paid, uint32 opened, bool settled))",
    "function placeBid(uint256 saleId, bytes32 fingerprint, bytes envelope) returns (uint256)",
    "function isHybridHolder(address) view returns (bool)",
    "event BidPlaced(uint256 indexed saleId, uint256 indexed bidIndex, address indexed bidder, bytes32 fingerprint, bytes envelope)",
  ]),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (path) => (await fetch(`${REST}${path}`)).json();

export async function makeKit(mnemonic) {
  const transport = await StargateClient.connect(RPC);
  const registry = qorechainRegistry();

  async function account(index) {
    const a = await deriveUnifiedAccount(mnemonic, index);
    a.index = index;
    a.wallet = createWalletClient({ chain, transport: http(EVMRPC), account: privateKeyToAccount(a.privateKey) });
    return a;
  }

  // A native transaction, signed hybrid (ML-DSA-87 and ECDSA) unless `classical` (needed only to register the key).
  async function native(a, messages, { gas = "600000", classical = false } = {}) {
    const { account: base } = await getJson(`/cosmos/auth/v1beta1/accounts/${a.cosmos}`);
    const signer = new EthNativeSigner(a, classical ? { signMode: "classical" } : { rest: REST, registry });
    const r = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID, accountNumber: BigInt(base.account_number), sequence: BigInt(base.sequence), messages,
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(Number(gas) * 0.1)) }], gas },
    });
    if (r.code) throw new Error(`native tx failed code ${r.code}: ${r.rawLog}`);
    await sleep(3000);
    return r.transactionHash;
  }

  async function evm(a, args) {
    const hash = await a.wallet.writeContract({ ...args, chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${args.functionName} reverted: ${hash}`);
    return rc;
  }

  // Opens a window when the live one is missing, expiring, nearly used up, or lists other targets.
  // Returns the opening transaction, or null when the live window is fine.
  async function ensureWindow(a, targets = []) {
    const w = await fetchEvmWindow({ rest: REST, address: a.cosmos });
    const key = (t) => t.map((x) => x.toLowerCase()).sort().join();
    if (w.live && key(w.allowedTargets ?? []) === key(targets) && Number(w.remainingTxs) > 4 && Number(w.remainingBlocks) > 300) return null;
    return native(a, [openEvmWindowMsg({ sender: a.cosmos, blocks: 3000, maxTxs: 40, maxValue: "8000000", ...(targets.length && { allowedTargets: targets }) })], { gas: "400000" });
  }

  const uqor = async (a) => BigInt((await getJson(`/cosmos/bank/v1beta1/balances/${a.cosmos}`)).balances.find((b) => b.denom === "uqor")?.amount ?? 0);
  const fusdOf = (addr) => pub.readContract({ ...fusd, functionName: "balanceOf", args: [addr] });

  return { account, native, evm, ensureWindow, uqor, fusdOf, registry };
}
