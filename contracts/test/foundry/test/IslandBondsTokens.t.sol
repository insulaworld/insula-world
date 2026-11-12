// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The token plumbing: gasless deposits through the real Permit2, and tokens that misbehave (charge a fee on
// transfer, return false instead of reverting, return nothing at all, call back into the contract).
import {Test} from "forge-std/Test.sol";
import {IslandBonds} from "bonds/IslandBonds.sol";

interface IPermit2 { function DOMAIN_SEPARATOR() external view returns (bytes32); }

contract OddToken {
    // mode 0: normal · 1: transfers return false · 2: 1% fee on transfers · 3: no return value · 4: calls back
    uint8 public mode;
    address public hook;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function setMode(uint8 m) external { mode = m; }
    function setHook(address h) external { hook = h; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function _move(address f, address to, uint256 a) internal {
        uint256 fee = mode == 2 ? a / 100 : 0;
        balanceOf[f] -= a; balanceOf[to] += a - fee;
        if (mode == 4 && hook != address(0)) ReenterAgain(hook).poke();
    }
    function transfer(address to, uint256 a) external returns (bool) {
        if (mode == 1) return false;
        _move(msg.sender, to, a);
        if (mode == 3) assembly { return(0, 0) }
        return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (mode == 1) return false;
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _move(f, to, a);
        if (mode == 3) assembly { return(0, 0) }
        return true;
    }
}

contract ReenterAgain {
    IslandBonds b; bool public tried; bool public ok; bytes public reason;
    constructor(IslandBonds b_) { b = b_; }
    function poke() external {
        if (tried) return;
        tried = true;
        try b.deposit(1) { ok = true; } catch (bytes memory r) { reason = r; }
    }
}

contract IslandBondsTokens is Test {
    OddToken t;
    IslandBonds b;
    IPermit2 p2;
    address bank = address(0xBA4C);
    address operator = address(0x0EE7);
    address owner = address(0x0A1E);
    uint256 alicePk = 0xA11CE;
    address alice;

    bytes32 constant TP = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PTF = keccak256("PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)");

    function setUp() public {
        alice = vm.addr(alicePk);
        t = new OddToken();
        bytes memory code = vm.parseJsonBytes(vm.readFile("permit2.json"), ".bytecode");
        address a;
        assembly { a := create(0, add(code, 0x20), mload(code)) }
        p2 = IPermit2(a);
        b = new IslandBonds(address(t), address(p2), bank, owner, operator,
            100_000e18, 250_000e18, 5_000_000e18, 50_000e18, 200_000e18, 7 days, 250_000e18, 1_000_000e18, new address[](0));
        t.mint(alice, 1_000_000e18);
        vm.prank(alice);
        t.approve(address(p2), type(uint256).max);
    }

    function _sig(uint256 amount, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 s = keccak256(abi.encode(PTF, keccak256(abi.encode(TP, address(t), amount)), address(b), nonce, deadline));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", p2.DOMAIN_SEPARATOR(), s)));
        return abi.encodePacked(r, ss, v);
    }

    function test_gaslessDepositWorks() public {
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        vm.prank(address(0x51DE)); // the island submits; the agent pays no gas
        b.depositWithPermit(alice, 100_000e18, 1, dl, _sig(100_000e18, 1, dl));
        (uint256 amt,,) = b.bonds(alice);
        assertEq(amt, 100_000e18);
        assertEq(t.balanceOf(address(b)), 100_000e18);
        assertTrue(b.isResident(alice));
    }

    function test_feeOnTransferTokenIsRefused() public {
        t.setMode(2);
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _sig(100_000e18, 2, dl); // signed first: expectRevert applies to the very next call
        vm.expectRevert(IslandBonds.TransferFailed.selector);
        b.depositWithPermit(alice, 100_000e18, 2, dl, sig);
        vm.startPrank(alice);
        t.approve(address(b), 100_000e18);
        vm.expectRevert(IslandBonds.TransferFailed.selector);
        b.deposit(100_000e18);
        vm.stopPrank();
        assertEq(b.totalBonded(), 0);
    }

    function test_tokenReturningFalseIsRefused() public {
        vm.startPrank(alice);
        t.approve(address(b), 100_000e18);
        t.setMode(1);
        vm.expectRevert(IslandBonds.TransferFailed.selector);
        b.deposit(100_000e18);
        vm.stopPrank();
        // and on the way out
        t.setMode(0);
        vm.prank(alice);
        b.deposit(100_000e18);
        vm.prank(alice);
        b.requestLeave();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        t.setMode(1);
        vm.prank(alice);
        vm.expectRevert(IslandBonds.TransferFailed.selector);
        b.withdraw();
        vm.prank(operator);
        vm.expectRevert(IslandBonds.TransferFailed.selector);
        b.slash(alice, 1e18, bank, bytes32(0), "");
        (uint256 amt,,) = b.bonds(alice);
        assertEq(amt, 100_000e18, "nothing recorded as paid when the token refused");
    }

    function test_tokenReturningNothingWorks() public {
        t.setMode(3);
        vm.startPrank(alice);
        t.approve(address(b), 100_000e18);
        b.deposit(100_000e18);
        b.requestLeave();
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 before = t.balanceOf(alice);
        vm.prank(alice);
        b.withdraw();
        assertEq(t.balanceOf(alice) - before, 100_000e18);
    }

    function test_noReentryDuringGaslessDeposit() public {
        ReenterAgain r = new ReenterAgain(b);
        t.mint(address(r), 10);
        vm.prank(address(r));
        t.approve(address(b), 10);
        t.setHook(address(r));
        t.setMode(4);
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        b.depositWithPermit(alice, 100_000e18, 3, dl, _sig(100_000e18, 3, dl));
        assertTrue(r.tried() && !r.ok(), "re-entry was refused");
        assertEq(bytes4(r.reason()), IslandBonds.Reentrancy.selector);
        assertEq(t.balanceOf(address(b)), b.totalBonded());
    }
}
