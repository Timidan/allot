// Run on your own machine, never on the server: it needs the treasury mnemonic. Makes the guest mnemonic if missing
// and readies each guest from the treasury: gas money, a registered ML-DSA-87 key, 200 fUSD, a window listing only
// the sale and fUSD, and an fUSD approval for the sale contract. Prints addresses and transactions only. Rerun to top up.
// Env: TREASURY_MNEMONIC_FILE, GUESTS_MNEMONIC_FILE (defaults under ../.secrets/), GUESTS (default 2), CONSIGN (default 100),
// TOPUP (default 50: the account that sends token fUSD to QoreX bidders), TOPUP_FUSD (default 150: its float).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MSG_SEND_TYPE_URL, buildRegisterPqcKeyMsg, signProofOfPossession } from "@qorechain/sdk";
import { BinaryWriter } from "cosmjs-types/binary";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import { hexToBytes, maxUint256 } from "viem";
import { english, generateMnemonic } from "viem/accounts";
import { CHAIN_ID, FUSD, SALE, fusd, makeKit, pub, sale } from "./kit.mjs";

const GUESTS = Number(process.env.GUESTS ?? 2);
const TOPUP = Number(process.env.TOPUP ?? 50); // the account that sends token fUSD to QoreX bidders
const EACH = 200_000_000n; // 200 fUSD (6 decimals) per guest
const GUEST_FILE = process.env.GUESTS_MNEMONIC_FILE ?? "../.secrets/guests.mnemonic";
if (!existsSync(GUEST_FILE)) writeFileSync(GUEST_FILE, `${generateMnemonic(english)}\n`, { mode: 0o600 });

const treasury = await makeKit(readFileSync(process.env.TREASURY_MNEMONIC_FILE ?? "../.secrets/treasury.mnemonic", "utf8").trim());
const pool = await makeKit(readFileSync(GUEST_FILE, "utf8").trim());
// MsgConvertCoin { coin = 1; receiver = 2; sender = 3 } (cosmos.evm.erc20.v1) is not in the SDK registry.
treasury.registry.register("/cosmos.evm.erc20.v1.MsgConvertCoin", {
  encode(m, w = BinaryWriter.create()) { if (m.coin) Coin.encode(m.coin, w.uint32(10).fork()).ldelim(); if (m.receiver) w.uint32(18).string(m.receiver); if (m.sender) w.uint32(26).string(m.sender); return w; },
  decode() { throw new Error("not needed"); },
  fromPartial(o) { return { coin: o.coin, receiver: o.receiver ?? "", sender: o.sender ?? "" }; },
});
const issuer = await treasury.account(0);
const usd = (x) => `${(Number(x) / 1e6).toFixed(2)}`;

// The guests bid into sales; the top-up account only sends fUSD, so it needs a window for fUSD alone and no approval.
const ready = [...Array(GUESTS).keys()].map((i) => ({ i, name: `guest ${i}`, each: EACH, targets: [SALE, FUSD], approve: true }));
ready.push({ i: TOPUP, name: `top-up account ${TOPUP}`, each: BigInt(Math.round(Number(process.env.TOPUP_FUSD ?? 150) * 1e6)), targets: [FUSD], approve: false });
for (const { i, name, each, targets, approve } of ready) {
  const g = await pool.account(i);
  console.log(name, g.evm);
  if ((await pool.uqor(g)) < 2_000_000n) {
    const tx = await treasury.native(issuer, [{ typeUrl: MSG_SEND_TYPE_URL, value: { fromAddress: issuer.cosmos, toAddress: g.cosmos, amount: [{ denom: "uqor", amount: "3000000" }] } }]);
    console.log("  sent 3 QOR for gas, tx", tx);
  }
  if (!(await pub.readContract({ ...sale, functionName: "isHybridHolder", args: [g.evm] }))) {
    const msg = buildRegisterPqcKeyMsg(g.cosmos, { pqcKeypair: g.pqc, ecdsaPubkey: hexToBytes(g.publicKey), proofOfPossession: signProofOfPossession({ chainId: CHAIN_ID, account: g.cosmos, keypair: g.pqc }) });
    console.log("  registered its ML-DSA-87 key, tx", await pool.native(g, [msg], { classical: true }));
  }
  const short = each - (await pool.fusdOf(g.evm));
  if (short > 0n) {
    const have = await treasury.fusdOf(issuer.evm);
    if (have < short) {
      const amount = short - have;
      const tx = await treasury.native(issuer, [{ typeUrl: "/cosmos.evm.erc20.v1.MsgConvertCoin", value: { coin: { denom: `erc20:${FUSD}`, amount: String(amount) }, receiver: issuer.evm, sender: issuer.cosmos } }]);
      console.log(`  converted ${usd(amount)} of the treasury's fUSD to the ERC-20, tx`, tx);
    }
    await treasury.ensureWindow(issuer);
    const rc = await treasury.evm(issuer, { ...fusd, functionName: "transfer", args: [g.evm, short] });
    console.log(`  sent ${usd(short)} of fUSD, tx`, rc.transactionHash);
  }
  const w = await pool.ensureWindow(g, targets);
  if (w) console.log("  opened a window, tx", w);
  if (approve && (await pub.readContract({ ...fusd, functionName: "allowance", args: [g.evm, SALE] })) < maxUint256 / 2n) {
    const rc = await pool.evm(g, { ...fusd, functionName: "approve", args: [SALE, maxUint256] });
    console.log("  approved the sale contract to take deposits, tx", rc.transactionHash);
  }
  console.log(`  ready: ${usd(await pool.fusdOf(g.evm))} of fUSD, hybrid holder`);
}

// The consign issuer (account CONSIGN of the same mnemonic) runs listed sales and only needs gas money from here;
// the guest server registers its keys and card itself on the first listing.
const c = await pool.account(Number(process.env.CONSIGN ?? 100));
console.log("consign issuer", c.cosmos, c.evm);
if ((await pool.uqor(c)) < 10_000_000n) {
  const tx = await treasury.native(issuer, [{ typeUrl: MSG_SEND_TYPE_URL, value: { fromAddress: issuer.cosmos, toAddress: c.cosmos, amount: [{ denom: "uqor", amount: "20000000" }] } }]);
  console.log("  sent 20 QOR for gas, tx", tx);
}
process.exit(0);
