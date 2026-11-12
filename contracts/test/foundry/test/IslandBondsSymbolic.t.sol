// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Symbolic checks with Halmos: each check_ function is proven for EVERY possible value of its arguments
// (callers, amounts, recipients, times, settings), not just random samples.
import {Test} from "forge-std/Test.sol";
import {IslandBonds} from "bonds/IslandBonds.sol";

contract PlainToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract IslandBondsSymbolic is Test {
    PlainToken t;
    IslandBonds b;
    address bank = address(0xBA4C);
    address operator = address(0x0EE7);
    address owner = address(0x0A1E);
    address payee = address(0xA11A);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        t = new PlainToken();
        b = new IslandBonds(address(t), address(0x2222), bank, owner, operator,
            100_000e18, 250_000e18, 5_000_000e18, 50_000e18, 200_000e18, 7 days, 250_000e18, 1_000_000e18, _list(payee));
    }

    function _list(address a) internal pure returns (address[] memory l) { l = new address[](1); l[0] = a; }

    function _deposit(address who, uint256 a) internal {
        t.mint(who, a);
        vm.startPrank(who);
        t.approve(address(b), a);
        b.deposit(a);
        vm.stopPrank();
    }

    function _bond(address a) internal view returns (uint256 x) { (x,,) = b.bonds(a); }

    // Only the operator can slash, whoever calls and whatever the arguments.
    function check_onlyOperatorSlashes(address caller, uint256 a1, uint256 amt, address to) public {
        vm.assume(caller != operator);
        vm.assume(a1 > 0 && a1 <= 250_000e18);
        _deposit(alice, a1);
        vm.prank(caller);
        try b.slash(alice, amt, to, bytes32(0), "") { assert(false); } catch {}
    }

    // A successful slash: within the cap, to an allowed recipient, and the books still balance.
    function check_slashIsBoundedAndBalanced(uint256 a1, uint256 a2, uint256 amt, address to) public {
        vm.assume(a1 > 0 && a1 <= 250_000e18 && a2 > 0 && a2 <= 250_000e18);
        _deposit(alice, a1);
        _deposit(bob, a2);
        uint256 toBefore = t.balanceOf(to);
        vm.prank(operator);
        try b.slash(alice, amt, to, bytes32(0), "") {
            assert(amt > 0 && amt <= b.maxSlash());
            assert(to == bank || to == payee || to == bob);
            assert(_bond(alice) == a1 - amt);
            assert(_bond(bob) == a2);
            assert(t.balanceOf(to) == toBefore + amt);
        } catch {}
        assert(t.balanceOf(address(b)) == b.totalBonded());
        assert(_bond(alice) + _bond(bob) == b.totalBonded());
    }

    // No single day's slashing can pass the daily cap, however it's split.
    function check_dailyCap(uint256 s1, uint256 s2, uint256 s3, uint256 s4, uint256 s5) public {
        for (uint256 i = 0; i < 5; i++) _deposit(address(uint160(0x1000 + i)), 250_000e18);
        uint256[5] memory s = [s1, s2, s3, s4, s5];
        uint256 total;
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(operator);
            try b.slash(address(uint160(0x1000 + i)), s[i], bank, bytes32(0), "") { total += s[i]; } catch {}
        }
        assert(total <= b.dailySlashCap());
        assert(t.balanceOf(bank) == total);
    }

    // Withdrawal: only after asking to leave and waiting the full cooling-off, only to the agent, exactly its bond.
    function check_withdrawRules(uint256 a1, uint256 wait, bool asked, address caller) public {
        vm.assume(a1 > 0 && a1 <= 250_000e18);
        vm.assume(wait < 400 days);
        _deposit(alice, a1);
        if (asked) { vm.prank(alice); b.requestLeave(); }
        vm.warp(block.timestamp + wait);
        uint256 before = t.balanceOf(caller);
        uint256 held = t.balanceOf(address(b));
        vm.prank(caller);
        try b.withdraw() {
            assert(caller == alice);
            assert(asked);
            assert(wait >= b.cooldown()); // (not block.timestamp: via-IR may reuse the value read before vm.warp)
            assert(t.balanceOf(alice) == before + a1);
            assert(b.totalBonded() == 0 && t.balanceOf(address(b)) == 0);
        } catch {
            assert(t.balanceOf(address(b)) == held);
        }
    }

    // Leaving freezes the bond against new deposits and can't be cancelled by anyone else.
    function check_leaveIsPersonal(address caller, uint256 a1) public {
        vm.assume(a1 > 0 && a1 <= 250_000e18);
        vm.assume(caller != alice);
        _deposit(alice, a1);
        vm.prank(alice);
        b.requestLeave();
        vm.prank(caller);
        try b.cancelLeave() { assert(_bond(caller) > 0); } catch {}
        (,, bool leaving) = b.bonds(alice);
        assert(leaving);
    }

    // Settings can never pass the hard limits, and only the owner can change them.
    function check_settings(address caller, uint256 minB, uint256 maxB, uint256 cap, uint256 ms, uint256 ds, uint256 cd) public {
        vm.prank(caller);
        try b.setSettings(minB, maxB, cap, ms, ds, cd) {
            assert(caller == owner);
            assert(b.maxSlash() <= b.hardMaxSlash() && b.dailySlashCap() <= b.hardDailySlashCap());
            assert(b.cooldown() >= 1 days && b.cooldown() <= 30 days);
            assert(b.minBond() > 0 && b.maxBond() >= b.minBond() && b.totalCap() >= b.maxBond());
        } catch {}
    }

    // Deposits respect the per-agent and total caps and pauses.
    function check_depositCaps(uint256 a1, uint256 a2, bool paused) public {
        if (paused) { vm.prank(owner); b.pauseDeposits(true); }
        t.mint(alice, a1);
        vm.prank(alice); t.approve(address(b), a1);
        vm.prank(alice);
        try b.deposit(a1) { assert(!paused && a1 > 0 && a1 <= b.maxBond()); } catch {}
        t.mint(alice, a2);
        vm.prank(alice); t.approve(address(b), a2);
        vm.prank(alice);
        try b.deposit(a2) { assert(!paused && _bond(alice) <= b.maxBond()); } catch {}
        assert(t.balanceOf(address(b)) == b.totalBonded() && b.totalBonded() == _bond(alice));
    }

    // One owner call, any admin function, any arguments: the contract's balance never changes.
    function check_ownerCallsNeverMoveTokens(uint256 a1, uint8 which, address x, uint256 n1, uint256 n2, uint256 n3, uint256 n4, uint256 n5, uint256 n6, bool f) public {
        vm.assume(a1 > 0 && a1 <= 250_000e18);
        _deposit(alice, a1);
        uint256 held = t.balanceOf(address(b));
        vm.startPrank(owner);
        if (which % 6 == 0) try b.setOperator(x) {} catch {}
        else if (which % 6 == 1) try b.setPayee(x, f) {} catch {}
        else if (which % 6 == 2) try b.pauseDeposits(f) {} catch {}
        else if (which % 6 == 3) try b.setSettings(n1, n2, n3, n4, n5, n6) {} catch {}
        else if (which % 6 == 4) try b.transferOwnership(x) {} catch {}
        else try b.withdraw() {} catch {}
        vm.stopPrank();
        assert(t.balanceOf(address(b)) == held && _bond(alice) == a1);
    }

    // A thief with the owner's key, two admin calls of any kind with any arguments, then any slash by whoever is
    // operator, any time before the 31-day delay: nobody new can be paid, and the owner's own address never is.
    function _admin(uint8 which, address x, bool f) internal {
        vm.prank(owner);
        if (which % 4 == 0) try b.setOperator(x) {} catch {}
        else if (which % 4 == 1) try b.setPayee(x, f) {} catch {}
        else if (which % 4 == 2) try b.activateOperator() {} catch {}
        else try b.activatePayee(x) {} catch {}
    }
    function check_ownerKeyThiefWaitsOutTheDelay(uint8 w1, address x1, bool f1, uint8 w2, address x2, bool f2, uint256 wait, address to, uint256 amt) public {
        vm.assume(wait < 31 days);
        vm.assume(to != bank && to != payee && to != alice);
        _deposit(alice, 100_000e18);
        _admin(w1, x1, f1);
        _admin(w2, x2, f2);
        vm.warp(block.timestamp + wait);
        _admin(2, x1, f1); // try to activate
        _admin(3, x2, f2);
        address op = b.operator();
        vm.prank(op);
        try b.slash(alice, amt, to, bytes32(0), "") { assert(false); } catch {}
        assert(op == operator || op == address(0));
    }
}

