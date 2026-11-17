// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// The Asset Kit's interface to QoreChain's pqcKeyStatus precompile at 0x0A02 (testnet only).
import {IQorePqcKeyStatus} from "@qorechain/asset-kit/interfaces/IQorePqcKeyStatus.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// The asset being sold: a CMTAT token (Asset Kit) whose rule refuses holders without a post-quantum key.
interface IMintableAsset {
    function mint(address account, uint256 value) external;
    function decimals() external view returns (uint8);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// Sealed-bid, uniform-price sale of a tokenised asset.
/// Bids are encrypted off chain to the issuer (QoreSeal, ML-KEM-1024). The chain keeps a fingerprint of each bid
/// and its envelope. After the close the issuer, or the bidder, opens each bid; the contract checks it against
/// the fingerprint. Everyone who wins pays the same clearing price.
contract SealedSale {
    uint256 public constant MAX_BIDS = 50;
    uint256 public constant FEE_BPS = 100; // 1% of proceeds, paid by the issuer
    uint256 public constant PENALTY_BPS = 1_000; // 10% of the deposit of a bid nobody opened
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    address public constant PQC_KEY_STATUS = address(0x0A02);
    uint8 private constant ML_DSA_87 = 1;

    IERC20 public immutable payToken; // fUSD
    address public immutable feeRecipient;

    struct Sale {
        address issuer;
        IMintableAsset asset;
        uint64 closeAt;
        uint64 openBy;
        uint128 supply; // whole units of the asset
        uint128 reserve; // lowest price, in payToken base units per whole unit
        uint128 deposit; // fixed, the same for every bid
        uint128 unit; // asset base units per whole unit
        uint128 clearing;
        uint128 sold;
        uint128 penaltyShare; // paid to each opened bid
        uint128 earned; // proceeds for tokens actually delivered
        uint128 paid; // proceeds already paid out
        uint32 opened;
        bool settled;
    }

    struct Bid {
        address bidder;
        bytes32 fingerprint;
        uint128 price;
        uint128 qty;
        uint128 filled;
        bool opened;
        bool claimed;
    }

    Sale[] internal sales;
    mapping(uint256 saleId => Bid[]) public bids;

    event SaleCreated(uint256 indexed saleId, address indexed issuer, address asset, string issuerCard);
    event BidPlaced(uint256 indexed saleId, uint256 indexed bidIndex, address indexed bidder, bytes32 fingerprint, bytes envelope);
    event BidOpened(uint256 indexed saleId, uint256 indexed bidIndex, uint128 price, uint128 qty);
    event Settled(uint256 indexed saleId, uint128 clearing, uint128 sold, uint32 opened, uint256 unopened);
    event Claimed(uint256 indexed saleId, uint256 indexed bidIndex, uint256 assetAmount, uint256 refund);
    event ProceedsPaid(uint256 indexed saleId, uint256 toIssuer, uint256 fee);

    error BadSale();
    error NotMinter();
    error NotHybridHolder(address account);
    error Closed();
    error TooManyBids();
    error NotOpeningTime();
    error NotAllowed();
    error FingerprintMismatch();
    error OverDeposit();
    error NotSettleTime();
    error AlreadyDone();
    error TransferFailed();

    constructor(IERC20 payToken_, address feeRecipient_) {
        payToken = payToken_;
        feeRecipient = feeRecipient_;
    }

    // ---------------------------------------------------------------- issuer

    function createSale(
        IMintableAsset asset,
        uint128 supply,
        uint128 reserve,
        uint128 deposit,
        uint64 closeAt,
        uint64 openBy,
        string calldata issuerCard
    ) external returns (uint256 saleId) {
        if (supply == 0 || reserve == 0 || reserve > deposit || closeAt <= block.timestamp || openBy <= closeAt) {
            revert BadSale();
        }
        // The issuer controls minting, and this contract can mint to winners.
        if (!asset.hasRole(MINTER_ROLE, msg.sender) || !asset.hasRole(MINTER_ROLE, address(this))) revert NotMinter();
        saleId = sales.length;
        Sale storage s = sales.push();
        s.issuer = msg.sender;
        s.asset = asset;
        s.closeAt = closeAt;
        s.openBy = openBy;
        s.supply = supply;
        s.reserve = reserve;
        s.deposit = deposit;
        s.unit = uint128(10 ** asset.decimals());
        emit SaleCreated(saleId, msg.sender, address(asset), issuerCard);
    }

    // ---------------------------------------------------------------- bidders

    /// `fingerprint` must equal `fingerprintOf(saleId, msg.sender, price, qty, salt)`; `envelope` is the sealed bid.
    function placeBid(uint256 saleId, bytes32 fingerprint, bytes calldata envelope) external returns (uint256 bidIndex) {
        Sale storage s = sales[saleId];
        if (block.timestamp >= s.closeAt) revert Closed();
        Bid[] storage list = bids[saleId];
        if (list.length >= MAX_BIDS) revert TooManyBids();
        if (!isHybridHolder(msg.sender)) revert NotHybridHolder(msg.sender);
        _pull(msg.sender, s.deposit);
        bidIndex = list.length;
        list.push(Bid({bidder: msg.sender, fingerprint: fingerprint, price: 0, qty: 0, filled: 0, opened: false, claimed: false}));
        emit BidPlaced(saleId, bidIndex, msg.sender, fingerprint, envelope);
    }

    /// Open bids after the close. The issuer may open any bid; a bidder may open their own.
    function openBids(
        uint256 saleId,
        uint256[] calldata bidIndexes,
        uint128[] calldata prices,
        uint128[] calldata qtys,
        bytes32[] calldata salts
    ) external {
        Sale storage s = sales[saleId];
        if (block.timestamp < s.closeAt || block.timestamp >= s.openBy) revert NotOpeningTime();
        for (uint256 i = 0; i < bidIndexes.length; i++) {
            Bid storage b = bids[saleId][bidIndexes[i]];
            if (msg.sender != s.issuer && msg.sender != b.bidder) revert NotAllowed();
            if (b.opened) continue; // a bidder who opened their own bid first must not stall the issuer's batch
            if (fingerprintOf(saleId, b.bidder, prices[i], qtys[i], salts[i]) != b.fingerprint) revert FingerprintMismatch();
            if (prices[i] == 0 || qtys[i] == 0 || uint256(prices[i]) * qtys[i] > s.deposit) revert OverDeposit();
            b.price = prices[i];
            b.qty = qtys[i];
            b.opened = true;
            s.opened++;
            emit BidOpened(saleId, bidIndexes[i], prices[i], qtys[i]);
        }
    }

    // ---------------------------------------------------------------- anyone

    /// After the opening deadline (or once every bid is open): highest prices fill first, earlier bids first at
    /// equal price. The clearing price is the lowest price that received an allocation.
    function settle(uint256 saleId) external {
        Sale storage s = sales[saleId];
        Bid[] storage list = bids[saleId];
        if (s.settled) revert AlreadyDone();
        bool allOpen = block.timestamp >= s.closeAt && s.opened == list.length;
        if (block.timestamp < s.openBy && !allOpen) revert NotSettleTime();
        s.settled = true;

        // Opened bids, sorted by price, highest first; insertion sort keeps equal prices in bid order.
        uint256[] memory order = new uint256[](s.opened);
        uint256 n;
        for (uint256 i = 0; i < list.length; i++) {
            if (!list[i].opened) continue;
            uint256 j = n++;
            while (j > 0 && list[order[j - 1]].price < list[i].price) {
                order[j] = order[j - 1];
                j--;
            }
            order[j] = i;
        }

        uint128 remaining = s.supply;
        for (uint256 k = 0; k < n && remaining > 0; k++) {
            Bid storage b = list[order[k]];
            if (b.price < s.reserve) break;
            uint128 f = b.qty < remaining ? b.qty : remaining;
            b.filled = f;
            remaining -= f;
            s.clearing = b.price;
        }
        s.sold = s.supply - remaining;

        uint256 unopened = list.length - s.opened;
        if (s.opened > 0) {
            // ponytail: integer division leaves at most opened-1 base units of dust in the contract.
            s.penaltyShare = uint128(unopened * s.deposit * PENALTY_BPS / 10_000 / s.opened);
        }
        emit Settled(saleId, s.clearing, s.sold, s.opened, unopened);
    }

    /// Pays a bid out: winners get the asset minted to them and the rest of their deposit back. Anyone may call;
    /// everything goes to the bidder.
    function claim(uint256 saleId, uint256 bidIndex) external {
        Sale storage s = sales[saleId];
        Bid storage b = bids[saleId][bidIndex];
        if (!s.settled || b.claimed) revert AlreadyDone();
        b.claimed = true;
        uint256 refund;
        uint256 assetAmount;
        if (b.opened) {
            uint256 cost = uint256(s.clearing) * b.filled;
            refund = s.deposit - cost + s.penaltyShare;
            if (cost > 0) {
                // The issuer is paid only for tokens delivered. If the mint fails (minter role revoked, holder
                // refused), the bidder gets the cost back instead of being stuck.
                try s.asset.mint(b.bidder, uint256(b.filled) * s.unit) {
                    assetAmount = uint256(b.filled) * s.unit;
                    s.earned += uint128(cost);
                } catch {
                    refund += cost;
                }
            }
        } else {
            refund = s.opened > 0 ? s.deposit - uint256(s.deposit) * PENALTY_BPS / 10_000 : s.deposit;
        }
        _push(b.bidder, refund);
        emit Claimed(saleId, bidIndex, assetAmount, refund);
    }

    /// Pays the issuer the proceeds earned so far (tokens delivered), less the 1% fee. Anyone may call, any time.
    function payProceeds(uint256 saleId) external {
        Sale storage s = sales[saleId];
        uint256 proceeds = s.earned - s.paid;
        if (proceeds == 0) revert AlreadyDone();
        s.paid = s.earned;
        uint256 fee = proceeds * FEE_BPS / 10_000;
        _push(s.issuer, proceeds - fee);
        _push(feeRecipient, fee);
        emit ProceedsPaid(saleId, proceeds - fee, fee);
    }

    // ---------------------------------------------------------------- views

    function fingerprintOf(uint256 saleId, address bidder, uint128 price, uint128 qty, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(saleId, bidder, price, qty, salt));
    }

    /// True when `account` has a registered ML-DSA-87 key with proof of possession. Fails closed.
    function isHybridHolder(address account) public view returns (bool) {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeCall(IQorePqcKeyStatus.pqcKeyStatus, (account)));
        if (!ok || ret.length < 160) return false;
        (bool registered, uint8 algorithm,, bool proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        return registered && algorithm == ML_DSA_87 && proven;
    }

    function getSale(uint256 saleId) external view returns (Sale memory) {
        return sales[saleId];
    }

    function bidCount(uint256 saleId) external view returns (uint256) {
        return bids[saleId].length;
    }

    function saleCount() external view returns (uint256) {
        return sales.length;
    }

    // ---------------------------------------------------------------- internal

    function _pull(address from, uint256 amount) private {
        if (!payToken.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        if (amount > 0 && !payToken.transfer(to, amount)) revert TransferFailed();
    }
}
