// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {SealedSale, IERC20, IMintableAsset} from "../src/SealedSale.sol";

interface Vm {
    function etch(address target, bytes calldata code) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata revertData) external;
}

/// Stands in for the 0x0A02 precompile.
contract MockKeyStatus {
    mapping(address => bool) public ok;

    function set(address a, bool v) external { ok[a] = v; }

    function pqcKeyStatus(address a) external view returns (bool, uint8, bytes memory, bool) {
        return (ok[a], 1, ok[a] ? new bytes(2592) : new bytes(0), ok[a]);
    }
}

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public minter;
    uint8 public decimals;

    constructor(uint8 d) { decimals = d; }

    function hasRole(bytes32, address a) external view returns (bool) { return minter[a]; }
    function grant(address a) external { minter[a] = true; }
    function revoke(address a) external { minter[a] = false; }
    function mint(address to, uint256 v) external { require(minter[msg.sender], "minter"); balanceOf[to] += v; }
    function faucet(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; return true;
    }
}

contract SealedSaleTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint128 constant USD = 1e6;

    SealedSale sale;
    MockToken usd;
    MockToken asset;
    MockKeyStatus keys;
    address issuer = address(0x1551);
    address fees = address(0xFEE);
    address a = address(0xA);
    address b = address(0xB);
    address c = address(0xC);
    address e = address(0xE); // places a bid nobody opens
    uint256 id;

    function setUp() public {
        vm.etch(address(0x0A02), address(new MockKeyStatus()).code);
        keys = MockKeyStatus(address(0x0A02));
        usd = new MockToken(6);
        asset = new MockToken(18);
        sale = new SealedSale(IERC20(address(usd)), fees);
        asset.grant(issuer);
        asset.grant(address(sale));
        address[4] memory people = [a, b, c, e];
        for (uint256 i = 0; i < 4; i++) {
            keys.set(people[i], true);
            usd.faucet(people[i], 100 * USD);
            vm.prank(people[i]);
            usd.approve(address(sale), type(uint256).max);
        }
        vm.warp(1000);
        vm.prank(issuer);
        // 100 units, reserve $1, every bid locks $100, closes at 1100, opening ends at 1200.
        id = sale.createSale(IMintableAsset(address(asset)), 100, USD, 100 * USD, 1100, 1200, "card");
    }

    function _bid(address who, uint128 price, uint128 qty, bytes32 salt) internal {
        bytes32 fp = sale.fingerprintOf(id, who, price, qty, salt);
        vm.prank(who);
        sale.placeBid(id, fp, hex"c0ffee");
    }

    function _arr(uint256 x0, uint256 x1, uint256 x2) internal pure returns (uint256[] memory r) {
        r = new uint256[](3); r[0] = x0; r[1] = x1; r[2] = x2;
    }

    function _arr128(uint128 x0, uint128 x1, uint128 x2) internal pure returns (uint128[] memory r) {
        r = new uint128[](3); r[0] = x0; r[1] = x1; r[2] = x2;
    }

    function _arr32(bytes32 x0, bytes32 x1, bytes32 x2) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](3); r[0] = x0; r[1] = x1; r[2] = x2;
    }

    /// Main path: three opened bids and one unopened; uniform clearing price, penalty shared, fee paid.
    function test_fullSale() public {
        _bid(a, 2 * USD, 50, "sa"); // $2.00 x 50
        _bid(b, 25 * USD / 10, 40, "sb"); // $2.50 x 40
        _bid(c, 15 * USD / 10, 60, "sc"); // $1.50 x 60
        _bid(e, 3 * USD, 30, "se"); // never opened

        vm.warp(1150);
        vm.prank(issuer);
        sale.openBids(id, _arr(0, 1, 2), _arr128(2 * USD, 25 * USD / 10, 15 * USD / 10), _arr128(50, 40, 60), _arr32("sa", "sb", "sc"));

        vm.warp(1200);
        sale.settle(id);
        SealedSale.Sale memory st = sale.getSale(id);
        require(st.clearing == 15 * USD / 10, "clearing is the lowest filled price"); // b 40, a 50, c 10
        require(st.sold == 100, "all units sold");
        require(st.penaltyShare == 3_333_333, "unopened 10% split over three");

        for (uint256 i = 0; i < 4; i++) sale.claim(id, i);
        sale.payProceeds(id);

        require(asset.balanceOf(b) == 40e18 && asset.balanceOf(a) == 50e18 && asset.balanceOf(c) == 10e18, "allocations");
        require(asset.balanceOf(e) == 0, "unopened gets nothing");
        require(usd.balanceOf(b) == 43_333_333, "b: 100 - 40x1.5 + share");
        require(usd.balanceOf(a) == 28_333_333, "a: 100 - 50x1.5 + share");
        require(usd.balanceOf(c) == 88_333_333, "c: 100 - 10x1.5 + share");
        require(usd.balanceOf(e) == 90 * USD, "e loses 10%");
        require(usd.balanceOf(issuer) == 148_500_000 && usd.balanceOf(fees) == 1_500_000, "proceeds less 1%");
        require(usd.balanceOf(address(sale)) == 1, "only rounding dust left");
    }

    /// Failure path: a bidder without a post-quantum key is refused, and a bid opened with the wrong salt is refused.
    function test_refusals() public {
        address noKey = address(0xD);
        usd.faucet(noKey, 100 * USD);
        vm.startPrank(noKey);
        usd.approve(address(sale), type(uint256).max);
        bytes32 fp = sale.fingerprintOf(id, noKey, USD, 10, "x");
        vm.expectRevert(abi.encodeWithSelector(SealedSale.NotHybridHolder.selector, noKey));
        sale.placeBid(id, fp, hex"00");
        vm.stopPrank();

        _bid(a, 2 * USD, 50, "right");
        vm.warp(1150);
        uint256[] memory idx = new uint256[](1);
        uint128[] memory p = new uint128[](1);
        uint128[] memory q = new uint128[](1);
        bytes32[] memory s = new bytes32[](1);
        p[0] = 2 * USD; q[0] = 50; s[0] = "wrong";
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(SealedSale.FingerprintMismatch.selector));
        sale.openBids(id, idx, p, q, s);

        // A mint that fails returns the bidder's whole deposit, and the issuer is owed nothing.
        s[0] = "right";
        vm.prank(issuer);
        sale.openBids(id, idx, p, q, s);
        vm.warp(1200);
        sale.settle(id);
        asset.revoke(address(sale));
        sale.claim(id, 0);
        require(usd.balanceOf(a) == 100 * USD && asset.balanceOf(a) == 0, "failed mint: full refund");
        require(sale.getSale(id).earned == 0, "issuer owed nothing");
    }
}
