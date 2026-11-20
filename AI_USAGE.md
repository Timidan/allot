# How AI was used to build Allot

Allot was built by one person, Timidan, with three AI tools from 11 to 18 November 2026. The AI wrote most of the code, the docs and the video. The owner made the decisions and did everything that needed a real person, a wallet or a key.

## Tools

| Tool | Model | Used for |
|---|---|---|
| Claude Code | Claude Opus | Lead: research, planning, all application code, testnet scripts, deploys, README |
| Codex CLI | OpenAI GPT | Second ideas and reviews; built the promo video from a written brief |
| Antigravity CLI (Agy) | Google Gemini | Third ideas and reviews, a field survey of other projects |
| HeyGen | | The video's narrator voice and its music bed |

## Workflow

1. **Research.** Claude read the event pages, the rules and the QoreChain kit docs and wrote a brief of what the organisers ask for. A separate pass looked for evidence of what people actually need from a post-quantum chain.
2. **Ideas.** Claude, Codex and Agy each proposed ideas without seeing the others'. A judge model that saw only the ideas, not their authors, scored them. Five rounds ran over two days; each round's lessons tightened the next one's rules.
3. **Fit to the kits.** Claude, Codex and Agy each mapped the event's 15 kits onto the three finalists on their own. Two of three chose a sealed-bid sale of tokenised assets.
4. **Step 0: test the chain before building.** Claude wrote small scripts (not in this repo) that tried each risky step on testnet first: registering an ML-DSA-87 key with proof of possession, sealing and opening a QoreSeal envelope, opening a scoped EVM window, deploying the Asset Kit's CMTAT token. Seven checks passed and one failed; the plan took the fallback.
5. **Build.** Claude wrote the Solidity sale contract, the React site and the Node server, then ran a seeded sale end to end on testnet before any page used it.
6. **Review.** A panel of five AI judges (three Claude roles, Codex reading the code, Agy comparing other entries) scored the build against the category. The commit "Make the claims precise and fix what the review panel found" holds the fixes.
7. **Video.** Claude wrote the storyboard, the specification and the brief; Codex built the film in HyperFrames (HTML rendered to video); Claude reviewed each draft frame by frame and measured its loudness.
8. **Q-Day Drill.** Claude wrote the drill script, made a fresh account for it, and attacked that account with the ECDSA key alone before the drill to check what the chain refuses (see the README).

## What the AI generated

- `contracts/`: the sale contract and its Foundry tests.
- `web/`: the whole site, including bid sealing in the browser, the practice auction and the QoreX setup guide.
- `server/`: guest bidding, listing, and the keeper that opens and settles sales.
- `README.md`, this file, and the commit messages.
- The promo video: its storyboard and script, and every animated scene.

## What the owner did

- Chose the event, the category and the idea to build, and approved the plan before any code.
- Set the direction of the landing page in an interview, and sent it back when it was still hard to follow. The page was rewritten around named bidders and plain words.
- Watched the video drafts and rejected them as too loud and too much like slides; chose a narrator for the rebuild.
- Recorded the screen captures in the video: listing an item and bidding from a real QoreX wallet.
- Connected GitHub, X and QoreX, created the project page, registered for the drill and submitted its proof.
- Pasted the drill key into the drill form; the AI never printed it or typed it into a page.
- Approved every push to the public repository and every change to the live server.

## How the output was checked

- Every claim about the chain was tried on testnet before the code relied on it; transaction hashes are in the README.
- The contract has Foundry tests for a full sale and for the refusals. The seeded sale on 12 November checked the clearing price, fills, refunds and payouts against the contract's own results.
- Bids sealed in the browser were opened in a separate process to confirm price, quantity and fingerprint match.
- The live site was checked in a real browser, on desktop and phone.

## Limits

- The owner read the code through the running app and the diffs, not line by line.
- AI judges are not the real jury; their scores were used to find faults, not to predict the result.
