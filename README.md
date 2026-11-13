<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/mark-dark.svg">
  <img src="docs/mark.svg" alt="Allot" width="64">
</picture>

# Allot

**Bid without being seen. Even after Q-Day.**

A secret-bid marketplace on QoreChain testnet. Every bid is sealed with post-quantum encryption.

[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![QoreChain testnet](https://img.shields.io/badge/QoreChain-testnet%20qorechain--diana-5b3fd1)](https://allot.timidan.xyz)
[![ML-KEM-1024](https://img.shields.io/badge/sealing-ML--KEM--1024-1c1a16)](web/src/lib/bid.js)
[![ML-DSA-87](https://img.shields.io/badge/signatures-ML--DSA--87-1c1a16)](server/kit.mjs)
[![Solidity 0.8.28](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity)](contracts/src/SealedSale.sol)
[![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)](web/package.json)
[![Node 22](https://img.shields.io/badge/Node-22-5fa04e?logo=nodedotjs&logoColor=white)](server/package.json)

[Live site](https://allot.timidan.xyz) · [Use it](#use-it) · [How a sale works](#how-a-sale-works) · [QoreChain integration](#qorechain-integration) · [Run it yourself](#run-it-yourself)

</div>

![Allot's home page: the headline, and the sale of Walk on the Beach](docs/featured.png)

Allot sells shares of real things (a painting, a song, a fund) by sealed bid. A bid is sealed in the bidder's browser with ML-KEM-1024 to the seller's registered key, so no other bidder can read it, today or after a quantum computer can break today's encryption. When time runs out, the bids are opened on chain, the best bids win, and every winner pays the same price.

Sale 1, ten shares of *Walk on the Beach*, ran on testnet with four sealed bids. Nobody else could read them until the close. Then the seller opened all four in [one transaction](https://allot.timidan.xyz/tx/0x584953b2ad1710f8d3438f837056a3bcf19d4c5688fc3060a85883ebf0a832ba), the contract checked each against its fingerprint, and the sale cleared at 24 fUSD:

| Bid | Won | Paid | Back from the 100 fUSD deposit |
|---|---|---|---|
| 3 shares at 30 fUSD | 3 | 72 fUSD | 28 fUSD |
| 4 shares at 25 fUSD | 4 | 96 fUSD | 4 fUSD |
| 4 shares at 24 fUSD | 3 | 72 fUSD | 28 fUSD |
| 5 shares at 20 fUSD | 0 | — | 100 fUSD |

Every bid, opening and claim is on [the sale's page](https://allot.timidan.xyz/sales/1). Sale 7 is a song listed by a visitor through [/sell](https://allot.timidan.xyz/sell). After its close the keeper settled it with no one stepping in: it [opened the guest's bid](https://allot.timidan.xyz/tx/0x79b75428c3d754cacd069df733736a50d26287466916763f72aeb2db3ac63e4c), [settled](https://allot.timidan.xyz/tx/0xd40c269ce494f2a05667b2148e752aeea5de5b416de7e761b3c6cc12813554c7), [delivered the 3 shares](https://allot.timidan.xyz/tx/0xfff2acaef33ad54ce9b188d5d29f57d1e316da64fae89ec44f57fd874de54faf) and [paid the proceeds](https://allot.timidan.xyz/tx/0x1ae5855ee435e7a9a044a5b01055aebf02e56bafd7891fcad2368e0fe8d7a280).

Built for QoreChain's *Build Before Q-Day* developer fest, category Encrypted Apps.

## Use it

Open **https://allot.timidan.xyz** (QoreChain testnet; shares are test tokens and stand for nothing). No wallet is needed.

1. **Practise.** The home page replays sale 1 with your bid added. Price it and press *Seal it*: your browser seals it for real with the seller's key. Press *End the sale* to see who wins and at what price.
2. **Bid.** Open a sale on [/sales](https://allot.timidan.xyz/sales) and press *Place sealed bid as a guest*. Your browser seals the bid, and a guest account with a registered post-quantum key places it on chain. Keep the receipt: it proves your bid when it opens. One guest bid per visitor a day.
3. **Sell.** On [/sell](https://allot.timidan.xyz/sell), upload an image or a song (JPEG, PNG, WebP, MP3, OGG, WAV or M4A, up to 8 MB), and set the shares, the lowest price and the length. Allot issues the shares and runs the sale. A song's waveform becomes its picture.
4. **Follow any transaction** on its own page, `/tx/<hash>`, read straight from testnet: what it did, its signature, and the post-quantum pass that let it through.

To bid from your own wallet, use QoreX on testnet: the browser extension, or the dApp browser in its mobile app. Bids come from an Ethereum (coin 60) account in QoreX, with QOR and fUSD from [QoreChain's faucet](https://dashboard.qorechain.io/faucet), and an EVM access window opened in QoreX.

## How a sale works

1. **The shares.** Each item is a CMTAT token built from QoreChain's Asset Kit, with the kit's holder rule: only accounts with a registered ML-DSA-87 key can hold it. The issuer grants the sale contract the right to mint it.
2. **The seller's card.** The seller registers an ML-KEM-1024 key on chain and signs a recipient card that binds it to their account with ML-DSA-87. The card is written into the sale when it is created.
3. **A bid.** The bidder's browser checks the card against the keys registered on chain, then seals `{price, shares, salt}` to it. The contract stores only a fingerprint of the bid and the sealed envelope. Every bid locks the same deposit, so the deposit says nothing about the bid.
4. **Who may bid.** The contract admits a bidder only if QoreChain's PQC key-status precompile (`0x0A02`) shows a registered ML-DSA-87 key. A bid is an EVM transaction, accepted only inside an EVM window the bidder opened with an ML-DSA-87-signed native transaction. Guest windows are scoped to the sale contract and fUSD.
5. **The close.** The seller opens each envelope, and the contract checks each opened bid against its fingerprint. The best bids win and every winner pays the lowest winning price. Winners' shares are minted to them, and the rest of every deposit comes back. A bid nobody opens loses 10% of its deposit to the bids that were opened. Allot takes 1% of the proceeds.

When a visitor lists an item through /sell, Allot acts as the auction house: its own account issues the token, holds the card's key, and a keeper opens, settles and pays out after the close.

## QoreChain integration

| Feature | Where | What it does here |
|---|---|---|
| QoreSeal, ML-KEM-1024 (hybrid with X25519) | [`web/src/lib/bid.js`](web/src/lib/bid.js) | Seals every bid in the browser to the seller's card |
| Registered recipient keys, ML-DSA-87 key binding | [`server/consign.mjs`](server/consign.mjs) (`setupIssuer`) | Registers the seller's ML-KEM-1024 key and signs its recipient card |
| Hybrid ML-DSA-87 transactions, PQC key registration with proof of possession | [`server/kit.mjs`](server/kit.mjs), [`server/setup-guests.mjs`](server/setup-guests.mjs) | Registers each account's ML-DSA-87 key with proof of possession; every native transaction after that is signed with ML-DSA-87 as well as ECDSA |
| EVM windows, scoped | [`server/kit.mjs`](server/kit.mjs) (`ensureWindow`) | Guests' windows let through only the sale contract and fUSD |
| Solidity PQC key status (precompile `0x0A02`) | [`contracts/src/SealedSale.sol`](contracts/src/SealedSale.sol) (`isHybridHolder`) | Refuses bids from accounts without a registered ML-DSA-87 key |
| Asset Kit: CMTAT with the post-quantum holder rule | [`server/consign.mjs`](server/consign.mjs) (`createListing`) | Each listed item's shares, with the file's URL and SHA-256 in the token's terms |
| Test token fUSD | [`contracts/src/SealedSale.sol`](contracts/src/SealedSale.sol) | Deposits, payments and refunds |
| QoreX | [`web/src/lib/qorex.js`](web/src/lib/qorex.js), [`web/src/Wallet.jsx`](web/src/Wallet.jsx) | Wallet status in the header; bids from QoreX; fUSD conversion with `signAndBroadcast` |

Kits: `@qorechain/sdk`, `@qorechain/qoreseal`, `@qorechain/evm` and `@qorechain/qorex-types`, in [`web/package.json`](web/package.json) and [`server/package.json`](server/package.json).

### Testnet addresses (`qorechain-diana`)

| What | Address |
|---|---|
| Sale contract | `0x284b10c4760794d25c71dc90183c3dc9b6d1f42a` |
| Seller of the sample sales | `qor1e3almehdqyhxay9n95qe0xu8ud9vqpryd0dlvx` |
| Allot, running listed sales | `qor1g495xe2zgk0gg2t4jg3u2m2mzuv3gdql7s7en4` |
| Guest bidder | `qor1rj37hg8l46lx0wukj0sx0j29t9drfhdc96qeuy` |
| Shares of *Walk on the Beach* | `0x8febcef691032a61956c7f1e1bc0b9094b16c16c` |

## Limits

- **The seller can read bids before the close.** Bids are sealed to the seller, or to Allot for listed items, and QoreSeal has no timed release. Other bidders and outsiders cannot read them.
- **A bid's own signature is ECDSA.** It is admitted only inside a window opened with ML-DSA-87, but the bid transaction itself is not ML-DSA-signed.
- **Bidding from QoreX** has not been tested with a real wallet, and QoreX's mobile app may not yet send EVM transactions.
- **Listed items' proceeds stay with Allot** on testnet; they are not forwarded to the person who listed the item.

## Run it yourself

The site:

```bash
cd web
npm install
npm run dev
```

It opens on http://localhost:5173 and reads the live sale contract on testnet. The dev server relays `/rest` to QoreChain's REST API and `/api` to the server below on port 8787. Without the server, sales still load; guest bids and listings need it.

The server (guest bids, listings and the keeper), with Node 22.9 or later:

```bash
cd server
npm install
cp .env.example .env
npm run setup
npm start
```

`npm run setup` funds the guest accounts and the listing account from a treasury mnemonic that holds testnet QOR and fUSD (see [`.env.example`](server/.env.example)), and creates the guest mnemonic if it is missing. Run it on your own machine; the server only needs the guest mnemonic.

The contract:

```bash
cd contracts
forge test
```

## Repository

| Path | What lives there |
|---|---|
| [`contracts/`](contracts) | `SealedSale.sol` (sealed-bid, uniform-price sale with the PQC holder check) and its Foundry tests |
| [`web/`](web) | The site: Vite, React 19, Tailwind 4, viem. Pages in [`web/src`](web/src): home, sales, one sale, sell, transaction |
| [`web/src/lib/`](web/src/lib) | Sealing (`bid.js`), chain reads (`chain.js`), QoreX (`qorex.js`) |
| [`server/`](server) | Guest bids and listings ([`guest.mjs`](server/guest.mjs)), token issuing and the keeper ([`consign.mjs`](server/consign.mjs)), chain helpers ([`kit.mjs`](server/kit.mjs)), guest funding ([`setup-guests.mjs`](server/setup-guests.mjs)) |
| [`server/kit/`](server/kit) | The Asset Kit's CMTAT build used for listed items |

## Licence

Apache-2.0. The photograph of *Walk on the Beach* is by Ángel M. Felicísimo, CC BY 2.0, via Wikimedia Commons.
