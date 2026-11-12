// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Targeted tests for what the fuzzers and proofs don't pin down exactly: the read-only helpers, exact delay
// boundaries, every admin function's access check, and re-entry through a token that calls back.
import {Test} from "forge-std/Test.sol";
import {IslandBonds} from "bonds/IslandBonds.sol";

contract Tok {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public hook; // if set, called on every transfer (a token with callbacks)
    function setHook(address h) external { hook = h; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; _hook(); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; _hook(); return true;
    }
    function _hook() internal { if (hook != address(0)) Reenter(hook).poke(); }
}

// During a token transfer made by the bond contract, tries to call back into it.
contract Reenter {
    IslandBonds public b; Tok public t;
    uint8 public mode; bool public tried; bool public succeeded; bytes public reason;
    constructor(IslandBonds b_, Tok t_) { b = b_; t = t_; }
    function arm(uint8 m) external { mode = m; tried = false; succeeded = false; }
    function poke() external {
        if (mode == 0 || tried) return;
        tried = true;
        if (mode == 1) { try b.deposit(1e18) { succeeded = true; } catch (bytes memory r) { reason = r; } }
        if (mode == 2) { try b.withdraw() { succeeded = true; } catch (bytes memory r) { reason = r; } }
    }
    function fund(uint256 a) external { t.approve(address(b), a); }
}

contract IslandBondsUnit is Test {
    Tok t;
    IslandBonds b;
    address bank = address(0xBA4C);
    address operator = address(0x0EE7);
    address owner = address(0x0A1E);
    address payee = address(0xA11A);
    address alice = address(0xA11CE);

    function setUp() public {
        t = new Tok();
        address[] memory l = new address[](1);
        l[0] = payee;
        b = new IslandBonds(address(t), address(0x2222), bank, owner, operator,
            100_000e18, 250_000e18, 5_000_000e18, 50_000e18, 200_000e18, 7 days, 250_000e18, 1_000_000e18, l);
    }

    function _deposit(address who, uint256 a) internal {
        t.mint(who, a);
        vm.startPrank(who);
        t.approve(address(b), a);
        b.deposit(a);
        vm.stopPrank();
    }

    function test_delayIsLongerThanAnyCoolingOff() public view {
        assertEq(b.CHANGE_DELAY(), 31 days);
        assertGt(b.CHANGE_DELAY(), b.MAX_COOLDOWN());
    }

    function test_isResidentAndUnlockAt() public {
        assertFalse(b.isResident(alice));
        assertEq(b.unlockAt(alice), 0);
        _deposit(alice, 99_999e18);
        assertFalse(b.isResident(alice), "below the minimum bond");
        _deposit(alice, 1e18);
        assertTrue(b.isResident(alice), "exactly the minimum bond");
        assertEq(b.unlockAt(alice), 0, "not leaving: no unlock time");
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(alice);
        b.requestLeave();
        assertFalse(b.isResident(alice), "leaving: not a resident");
        assertEq(b.unlockAt(alice), t0 + 7 days, "unlock time = request + cooling-off");
        vm.prank(alice);
        b.cancelLeave();
        assertTrue(b.isResident(alice), "cancelled: a resident again");
        assertEq(b.unlockAt(alice), 0);
    }

    function test_withdrawExactBoundary() public {
        _deposit(alice, 100_000e18);
        vm.prank(alice);
        b.requestLeave();
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert(IslandBonds.TooEarly.selector);
        b.withdraw();
        vm.warp(t0 + 7 days);
        vm.prank(alice);
        b.withdraw();
        assertEq(t.balanceOf(alice), 100_000e18);
    }

    function test_operatorDelayExactBoundary() public {
        address next = address(0xBEEF);
        vm.prank(owner);
        b.setOperator(next);
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(b.pendingOperator(), next);
        assertEq(b.pendingOperatorAt(), t0 + 31 days);
        assertEq(b.operator(), operator, "the old operator stays until activation");
        vm.warp(t0 + 31 days - 1);
        vm.expectRevert(IslandBonds.TooEarly.selector);
        b.activateOperator();
        vm.warp(t0 + 31 days);
        b.activateOperator();
        assertEq(b.operator(), next);
        assertEq(b.pendingOperator(), address(0));
        assertEq(b.pendingOperatorAt(), 0);
        vm.expectRevert(IslandBonds.Zero.selector);
        b.activateOperator();
    }

    function test_payeeDelayExactBoundary() public {
        address p = address(0xFEED);
        vm.prank(owner);
        b.setPayee(p, true);
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(b.payeeAt(p), t0 + 31 days);
        assertFalse(b.payees(p));
        vm.warp(t0 + 31 days - 1);
        vm.expectRevert(IslandBonds.TooEarly.selector);
        b.activatePayee(p);
        vm.warp(t0 + 31 days);
        b.activatePayee(p);
        assertTrue(b.payees(p));
        assertEq(b.payeeAt(p), 0);
        vm.expectRevert(IslandBonds.Zero.selector);
        b.activatePayee(p);
        vm.prank(owner);
        b.setPayee(p, false);
        assertFalse(b.payees(p), "delisting is immediate");
        assertEq(b.payeeAt(p), 0);
    }

    function test_switchingSlashingOffIsImmediateAndClearsTheQueue() public {
        vm.startPrank(owner);
        b.setOperator(address(0xBEEF));
        b.setOperator(address(0));
        vm.stopPrank();
        assertEq(b.operator(), address(0));
        assertEq(b.pendingOperator(), address(0));
        assertEq(b.pendingOperatorAt(), 0);
        _deposit(alice, 100_000e18);
        vm.prank(address(0));
        vm.expectRevert(IslandBonds.NotOperator.selector);
        b.slash(alice, 1, bank, bytes32(0), "");
    }

    function test_everyAdminFunctionIsOwnerOnly() public {
        address x = address(0xBAD);
        vm.startPrank(x);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.setOperator(x);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.setOperator(address(0));
        vm.expectRevert(IslandBonds.NotOwner.selector); b.setPayee(x, true);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.setPayee(payee, false);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.pauseDeposits(true);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.setSettings(1, 1, 1, 1, 1, 1 days);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.transferOwnership(x);
        vm.expectRevert(IslandBonds.NotOwner.selector); b.acceptOwnership();
        vm.stopPrank();
        assertEq(b.owner(), owner);
        assertEq(b.operator(), operator);
        assertTrue(b.payees(payee));
    }

    function test_constructorRejectsBadPayeesAndSettings() public {
        address[] memory bad = new address[](1);
        vm.expectRevert(IslandBonds.Zero.selector);
        new IslandBonds(address(t), address(0x2222), bank, owner, operator, 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 1e18, 1e18, bad);
        address[] memory none = new address[](0);
        vm.expectRevert(IslandBonds.BadSetting.selector);
        new IslandBonds(address(t), address(0x2222), bank, owner, operator, 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 0, 1e18, none);
        vm.expectRevert(IslandBonds.Zero.selector);
        new IslandBonds(address(0), address(0x2222), bank, owner, operator, 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 1e18, 1e18, none);
    }

    // A token that calls back during transfers: the bond contract refuses to be re-entered.
    function test_noReentryDuringWithdraw() public {
        Reenter r = new Reenter(b, t);
        t.mint(address(r), 10e18);
        r.fund(10e18);
        _deposit(alice, 100_000e18);
        vm.prank(alice);
        b.requestLeave();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        t.setHook(address(r));
        r.arm(1); // during the payout, try to deposit
        vm.prank(alice);
        b.withdraw();
        assertTrue(r.tried(), "the hook ran");
        assertFalse(r.succeeded(), "re-entry was refused");
        assertEq(bytes4(r.reason()), IslandBonds.Reentrancy.selector);
        assertEq(t.balanceOf(address(b)), b.totalBonded());
    }

    function test_noReentryDuringDeposit() public {
        Reenter r = new Reenter(b, t);
        t.mint(address(r), 10e18);
        r.fund(10e18);
        t.setHook(address(r));
        r.arm(1); // during the pull, try another deposit
        t.mint(alice, 100_000e18);
        vm.startPrank(alice);
        t.approve(address(b), 100_000e18);
        b.deposit(100_000e18);
        vm.stopPrank();
        assertTrue(r.tried() && !r.succeeded(), "re-entry was refused");
        assertEq(bytes4(r.reason()), IslandBonds.Reentrancy.selector);
        assertEq(t.balanceOf(address(b)), b.totalBonded());
    }

    function test_noReentryDuringSlash() public {
        Reenter r = new Reenter(b, t);
        _deposit(alice, 100_000e18);
        t.setHook(address(r));
        r.arm(2); // during the slash payout, try to withdraw
        vm.prank(operator);
        b.slash(alice, 1e18, bank, bytes32(0), "");
        assertTrue(r.tried() && !r.succeeded(), "re-entry was refused");
        assertEq(bytes4(r.reason()), IslandBonds.Reentrancy.selector);
    }

    function test_capsAreInclusive() public {
        _deposit(alice, 250_000e18); // exactly the per-agent maximum
        assertEq(b.totalBonded(), 250_000e18);
        t.mint(alice, 1);
        vm.startPrank(alice);
        t.approve(address(b), 1);
        vm.expectRevert(IslandBonds.OverMaxBond.selector);
        b.deposit(1);
        vm.stopPrank();
        // Fill the total cap exactly with 19 more agents at the maximum + one at 250,000: 20 x 250,000 = 5,000,000.
        for (uint160 i = 1; i < 20; i++) _deposit(address(0x5000 + i), 250_000e18);
        assertEq(b.totalBonded(), 5_000_000e18, "exactly the total cap");
        t.mint(address(0x6000), 1);
        vm.startPrank(address(0x6000));
        t.approve(address(b), 1);
        vm.expectRevert(IslandBonds.OverTotalCap.selector);
        b.deposit(1);
        vm.stopPrank();
    }

    function test_constructorChecksEveryAddressAndLimit() public {
        address[] memory none = new address[](0);
        address[5] memory good = [address(t), address(0x2222), bank, owner, operator];
        for (uint256 k = 0; k < 4; k++) { // token, Permit2, bank and owner must be set (the operator may be zero: slashing off)
            address[5] memory a = [address(t), address(0x2222), bank, owner, operator]; // a fresh copy (memory arrays share on assignment)
            a[k] = address(0);
            vm.expectRevert(IslandBonds.Zero.selector);
            new IslandBonds(a[0], a[1], a[2], a[3], a[4], 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 1e18, 1e18, none);
        }
        new IslandBonds(good[0], good[1], good[2], good[3], address(0), 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 1e18, 1e18, none);
        vm.expectRevert(IslandBonds.BadSetting.selector); // hard daily cap below the hard per-slash cap
        new IslandBonds(good[0], good[1], good[2], good[3], good[4], 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 2e18, 1e18, none);
        new IslandBonds(good[0], good[1], good[2], good[3], good[4], 1e18, 2e18, 3e18, 1e18, 1e18, 7 days, 1e18, 1e18, none); // equal is fine
    }

    function test_settingsBoundaries() public {
        vm.startPrank(owner);
        b.setSettings(1, 1, 1, 250_000e18, 1_000_000e18, 1 days);   // everything at its limit is allowed
        b.setSettings(1, 1, 1, 1, 1, 30 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(0, 1, 1, 1, 1, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(2, 1, 2, 1, 1, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 2, 1, 1, 1, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 1, 1, 0, 1, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 1, 1, 250_000e18 + 1, 1_000_000e18, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 1, 1, 2, 1, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 1, 1, 1, 1_000_000e18 + 1, 1 days);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 1, 1, 1, 1, 1 days - 1);
        vm.expectRevert(IslandBonds.BadSetting.selector); b.setSettings(1, 1, 1, 1, 1, 30 days + 1);
        vm.stopPrank();
    }

    function test_slashBoundaries() public {
        _deposit(alice, 250_000e18);
        _deposit(address(0xB0B), 250_000e18);
        vm.startPrank(operator);
        b.slash(alice, 50_000e18, bank, bytes32(0), "");               // exactly the per-slash cap
        vm.expectRevert(IslandBonds.OverMaxSlash.selector);
        b.slash(alice, 50_000e18 + 1, bank, bytes32(0), "");
        vm.expectRevert(IslandBonds.Zero.selector);
        b.slash(alice, 0, bank, bytes32(0), "");
        b.slash(alice, 50_000e18, payee, bytes32(0), "");
        b.slash(alice, 50_000e18, address(0xB0B), bytes32(0), "");    // another bonded agent
        b.slash(address(0xB0B), 50_000e18, bank, bytes32(0), "");     // 200,000 today: exactly the daily cap
        vm.expectRevert(IslandBonds.OverDailyCap.selector);
        b.slash(address(0xB0B), 1, bank, bytes32(0), "");
        vm.expectRevert(IslandBonds.BadRecipient.selector);
        b.slash(alice, 1, alice, bytes32(0), "");                       // never to itself
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(operator);
        b.slash(address(0xB0B), 1, bank, bytes32(0), "");               // a new day
        (uint256 left,,) = b.bonds(alice);
        assertEq(left, 100_000e18);
        assertEq(t.balanceOf(address(b)), b.totalBonded());
    }

    function test_slashMoreThanTheBondFails() public {
        _deposit(alice, 10_000e18);
        vm.prank(operator);
        vm.expectRevert(IslandBonds.NoBond.selector);
        b.slash(alice, 10_000e18 + 1, bank, bytes32(0), "");
        vm.prank(operator);
        b.slash(alice, 10_000e18, bank, bytes32(0), ""); // all of it is fine
        (uint256 left,,) = b.bonds(alice);
        assertEq(left, 0);
    }

    function test_leaveRules() public {
        vm.prank(alice);
        vm.expectRevert(IslandBonds.NoBond.selector);
        b.requestLeave();                       // nothing to leave with
        _deposit(alice, 100_000e18);
        vm.prank(alice);
        b.requestLeave();
        uint256 at = b.unlockAt(alice);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.prank(alice);
        vm.expectRevert(IslandBonds.Leaving.selector);
        b.requestLeave();                       // asking twice doesn't restart the clock
        assertEq(b.unlockAt(alice), at);
        vm.prank(alice);
        b.cancelLeave();
        vm.prank(alice);
        vm.expectRevert(IslandBonds.NotLeaving.selector);
        b.cancelLeave();                        // nothing left to cancel
    }

    function test_twoStepOwnership() public {
        address next = address(0x0B0E);
        vm.prank(owner);
        b.transferOwnership(next);
        assertEq(b.pendingOwner(), next);
        assertEq(b.owner(), owner, "nothing changes until the new owner accepts");
        vm.prank(address(0xBAD));
        vm.expectRevert(IslandBonds.NotOwner.selector);
        b.acceptOwnership();
        vm.prank(next);
        b.acceptOwnership();
        assertEq(b.owner(), next);
        assertEq(b.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(IslandBonds.NotOwner.selector);
        b.pauseDeposits(true);                  // the old owner has no powers left
        vm.prank(next);
        b.pauseDeposits(true);
        assertTrue(b.depositsPaused());
    }

    function test_zeroInputsAreRefused() public {
        vm.prank(alice);
        vm.expectRevert(IslandBonds.Zero.selector);
        b.deposit(0);
        vm.prank(owner);
        vm.expectRevert(IslandBonds.Zero.selector);
        b.setPayee(address(0), true);
        vm.prank(owner);
        vm.expectRevert(IslandBonds.Zero.selector);
        b.setPayee(address(0), false);
    }
}

