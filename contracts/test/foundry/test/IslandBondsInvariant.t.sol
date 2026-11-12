// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Stateful fuzzing of IslandBonds against the real Permit2: random sequences of deposits, gasless deposits
// (and replays and redirects of their signatures), slashes by the operator and by strangers, leaving, cancelling,
// withdrawing, time passing, setting changes and pauses. After every step the money must add up exactly.
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

interface IPermit2 { function DOMAIN_SEPARATOR() external view returns (bytes32); }

// A plain ERC-20 like $INSULA (no permit, no fees on transfer).
contract ERC20Plain {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    function _mint(address to, uint256 a) internal { totalSupply += a; balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}
import {IslandBonds} from "bonds/IslandBonds.sol";

contract Token is ERC20Plain {
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract Handler is Test {
    IslandBonds public bonds;
    IPermit2 public p2;
    Token public t;
    address public bank;
    address public operator;
    address public owner;
    address public payee;
    uint256[5] public pk;
    address[5] public agents;

    mapping(address => uint256) public deposited;
    mapping(address => uint256) public slashedFrom;
    mapping(address => uint256) public withdrawn;
    mapping(address => uint256) public slashedTo;
    uint256 public sumSlashed;
    uint256 public calls;
    uint256 public okDeposits; uint256 public okPermits; uint256 public okSlashes; uint256 public okWithdraws;
    uint256 nonceSeq;

    bytes32 constant TP = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PTF = keccak256("PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)");

    constructor(IslandBonds b, IPermit2 p, Token tk, address bank_, address op, address own, address payee_) {
        bonds = b; p2 = p; t = tk; bank = bank_; operator = op; owner = own; payee = payee_;
        for (uint256 i = 0; i < 5; i++) { pk[i] = 0xA11CE + i; agents[i] = vm.addr(pk[i]); }
    }

    function _agent(uint256 i) internal view returns (address) { return agents[i % 5]; }
    function _amount(uint256 a) internal view returns (uint256) { return bound(a, 1, bonds.maxBond() + 1e18); }

    function deposit(uint256 i, uint256 a) external {
        calls++;
        address ag = _agent(i);
        a = _amount(a);
        t.mint(ag, a);
        vm.startPrank(ag);
        t.approve(address(bonds), a);
        uint256 before = bonds.totalBonded();
        (uint256 had,,) = bonds.bonds(ag);
        try bonds.deposit(a) {
            okDeposits++;
            deposited[ag] += a;
            assertLe(had + a, bonds.maxBond(), "deposit past maxBond");
            assertLe(before + a, bonds.totalCap(), "deposit past totalCap");
            assertFalse(bonds.depositsPaused(), "deposit while paused");
        } catch {}
        vm.stopPrank();
    }

    function _sign(uint256 key, uint256 amount, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 s = keccak256(abi.encode(PTF, keccak256(abi.encode(TP, address(t), amount)), address(bonds), nonce, deadline));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", p2.DOMAIN_SEPARATOR(), s)));
        return abi.encodePacked(r, ss, v);
    }

    function depositWithPermit(uint256 i, uint256 a, uint256 other, address submitter) external {
        calls++;
        uint256 k = i % 5;
        address ag = agents[k];
        a = _amount(a);
        t.mint(ag, a);
        vm.prank(ag);
        t.approve(address(p2), type(uint256).max);
        uint256 nonce = ++nonceSeq;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig = _sign(pk[k], a, nonce, deadline);
        // A stranger can't use the signature to fund someone else's bond, or for a different amount.
        address victim = agents[(k + 1 + other % 4) % 5];
        uint256 vb = t.balanceOf(victim);
        vm.prank(submitter);
        try bonds.depositWithPermit(victim, a, nonce, deadline, sig) { revert("signature redirected to another agent"); } catch {}
        vm.prank(submitter);
        try bonds.depositWithPermit(ag, a + 1, nonce, deadline, sig) { revert("signature used for a bigger amount"); } catch {}
        assertEq(t.balanceOf(victim), vb, "victim's tokens moved");
        vm.prank(submitter);
        try bonds.depositWithPermit(ag, a, nonce, deadline, sig) {
            okPermits++;
            deposited[ag] += a;
            vm.prank(submitter);
            try bonds.depositWithPermit(ag, a, nonce, deadline, sig) { revert("permit replayed"); } catch {}
        } catch {}
    }

    function slash(uint256 i, uint256 a, uint256 toSel, bool asStranger, address stranger) external {
        calls++;
        address ag = _agent(i);
        a = bound(a, 0, bonds.hardMaxSlash() + 1);
        address to = toSel % 4 == 0 ? bank : toSel % 4 == 1 ? payee : toSel % 4 == 2 ? _agent(i % 5 + 1 + toSel % 3) : address(uint160(toSel));
        bool allowedTo = to != ag && (to == bank || bonds.payees(to) || _bond(to) > 0);
        address op = bonds.operator();
        address caller = asStranger ? stranger : op;
        uint256 toBefore = t.balanceOf(to);
        vm.prank(caller);
        try bonds.slash(ag, a, to, keccak256("test"), "fuzz") {
            okSlashes++;
            assertEq(caller, op, "a stranger slashed");
            assertTrue(op != address(0), "slashed while slashing was switched off");
            if (to == evil) assertTrue(evilPayeeOk, "paid a new payee that wasn't activated after its delay");
            if (op == evil) assertTrue(evilActivatedOk, "a new operator slashed without being activated after its delay");
            assertTrue(allowedTo, "slashed to a recipient that isn't allowed");
            assertGt(a, 0, "zero slash");
            assertLe(a, bonds.maxSlash(), "slash past maxSlash");
            assertEq(t.balanceOf(to) - toBefore, a, "recipient didn't get the slash");
            slashedFrom[ag] += a; slashedTo[to] += a; sumSlashed += a;
        } catch {}
    }

    function _bond(address a) internal view returns (uint256 amt) { (amt,,) = bonds.bonds(a); }

    function requestLeave(uint256 i) external { calls++; vm.prank(_agent(i)); try bonds.requestLeave() {} catch {} }
    function cancelLeave(uint256 i) external { calls++; vm.prank(_agent(i)); try bonds.cancelLeave() {} catch {} }

    function withdraw(uint256 i) external {
        calls++;
        address ag = _agent(i);
        (uint256 amt, uint64 at, bool leaving) = bonds.bonds(ag);
        uint256 before = t.balanceOf(ag);
        vm.prank(ag);
        try bonds.withdraw() {
            okWithdraws++;
            assertTrue(leaving, "withdrew without asking to leave");
            assertGe(vm.getBlockTimestamp(), uint256(at) + bonds.cooldown(), "withdrew before the cooling-off ended");
            assertEq(t.balanceOf(ag) - before, amt, "withdrew a different amount than the bond");
            withdrawn[ag] += amt;
        } catch {}
    }

    // Nobody but the agent can take its bond out.
    function strangerWithdraw(address s) external {
        calls++;
        for (uint256 i = 0; i < 5; i++) if (s == agents[i]) return; // the agents themselves may withdraw their own bond
        uint256 held = t.balanceOf(address(bonds));
        vm.prank(s);
        try bonds.withdraw() {} catch {}
        if (_bond(s) == 0) assertEq(t.balanceOf(address(bonds)), held, "a stranger got tokens out");
    }

    function warp(uint256 s) external { calls++; vm.warp(vm.getBlockTimestamp() + bound(s, 1, 10 days)); }

    function settings(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e, uint256 f, bool asStranger, address stranger) external {
        calls++;
        uint256 minB = bound(a, 1, 300_000e18);
        uint256 maxB = bound(b, minB, 600_000e18);
        uint256 cap = bound(c, maxB, 10_000_000e18);
        uint256 ms = bound(d, 1, bonds.hardMaxSlash() * 2);
        uint256 ds = bound(e, ms, bonds.hardDailySlashCap() * 2);
        uint256 cd = bound(f, 0, 40 days);
        vm.prank(asStranger ? stranger : owner);
        try bonds.setSettings(minB, maxB, cap, ms, ds, cd) {
            assertTrue(!asStranger || stranger == owner, "a stranger changed the settings");
            assertLe(ms, bonds.hardMaxSlash(), "maxSlash above the hard limit");
            assertLe(ds, bonds.hardDailySlashCap(), "daily cap above the hard limit");
            assertGe(cd, 1 days, "cooling-off under a day");
            assertLe(cd, 30 days, "cooling-off over 30 days");
        } catch {}
    }

    function pause(bool p) external { calls++; vm.prank(owner); bonds.pauseDeposits(p); }

    // The owner (or a thief with the owner's key) adds power: a new operator or a new payee. Neither may be
    // usable before CHANGE_DELAY, which is longer than any cooling-off, so every agent could leave first.
    address public evil = address(0xE111);
    uint256 public opQueuedAt;
    bool public evilActivatedOk;   // evil became operator through activateOperator, after its delay
    bool public evilPayeeOk;       // evil became a payee through activatePayee, after its delay
    uint256 public payeeQueuedAt;
    function ownerSetsOperator(uint8 sel) external {
        calls++;
        address to = sel % 3 == 0 ? address(0) : sel % 3 == 1 ? operator : evil;
        vm.prank(owner);
        bonds.setOperator(to);
        if (to == address(0)) { assertEq(bonds.operator(), address(0), "switching slashing off wasn't immediate"); evilActivatedOk = false; }
        else opQueuedAt = vm.getBlockTimestamp();
    }
    function activateOperator(address anyone) external {
        calls++;
        address pending = bonds.pendingOperator();
        vm.prank(anyone);
        try bonds.activateOperator() {
            assertGe(vm.getBlockTimestamp(), opQueuedAt + bonds.CHANGE_DELAY(), "operator activated before its delay");
            assertEq(bonds.operator(), pending, "activated the wrong operator");
            if (pending == evil) evilActivatedOk = true;
        } catch {}
    }
    function ownerSetsPayee(bool allowed, bool evilOne) external {
        calls++;
        address p = evilOne ? evil : payee;
        vm.prank(owner);
        bonds.setPayee(p, allowed);
        if (!allowed) { assertFalse(bonds.payees(p), "delisting wasn't immediate"); if (p == evil) evilPayeeOk = false; }
        else if (p == evil) payeeQueuedAt = vm.getBlockTimestamp();
    }
    function activatePayee(address anyone, bool evilOne) external {
        calls++;
        address p = evilOne ? evil : payee;
        vm.prank(anyone);
        try bonds.activatePayee(p) {
            if (p == evil) { assertGe(vm.getBlockTimestamp(), payeeQueuedAt + bonds.CHANGE_DELAY(), "payee activated before its delay"); evilPayeeOk = true; }
        } catch {}
    }

    function sumBonds() external view returns (uint256 s) { for (uint256 i = 0; i < 5; i++) s += _bond(agents[i]); }
}

contract IslandBondsInvariant is StdInvariant, Test {
    Handler h;
    IslandBonds bonds;
    Token t;
    address bank = makeAddr("bank");
    address operator = makeAddr("operator");
    address owner = makeAddr("owner");
    address payee = makeAddr("payee-animal");

    function setUp() public {
        t = new Token();
        IPermit2 p2 = _permit2();
        bonds = new IslandBonds(address(t), address(p2), bank, owner, operator,
            100_000e18, 250_000e18, 5_000_000e18, 50_000e18, 200_000e18, 7 days, 250_000e18, 1_000_000e18, _list(payee));
        h = new Handler(bonds, p2, t, bank, operator, owner, payee);
        targetContract(address(h));
    }

    function _list(address a) internal pure returns (address[] memory l) { l = new address[](1); l[0] = a; }

    // The real Permit2, deployed from its prebuilt bytecode (it pins an older compiler than this project).
    function _permit2() internal returns (IPermit2) {
        bytes memory code = vm.parseJsonBytes(vm.readFile("permit2.json"), ".bytecode");
        address p2a;
        assembly { p2a := create(0, add(code, 0x20), mload(code)) }
        require(p2a != address(0), "Permit2 deploy failed");
        return IPermit2(p2a);
    }

    function invariant_contractHoldsExactlyWhatItOwes() public view {
        assertEq(t.balanceOf(address(bonds)), bonds.totalBonded(), "token balance != totalBonded");
        assertEq(h.sumBonds(), bonds.totalBonded(), "sum of bonds != totalBonded");
    }

    function invariant_everyAgentsBondIsAccountedFor() public view {
        for (uint256 i = 0; i < 5; i++) {
            address a = h.agents(i);
            (uint256 amt,,) = bonds.bonds(a);
            assertEq(h.deposited(a) - h.slashedFrom(a) - h.withdrawn(a), amt, "an agent's bond moved without a deposit, slash or withdrawal");
        }
    }

    function invariant_slashesOnlyGoWhereAllowed() public view {
        assertEq(t.balanceOf(bank), h.slashedTo(bank), "bank got tokens other than slashes");
        assertEq(t.balanceOf(payee), h.slashedTo(payee), "payee got tokens other than slashes");
        assertLe(bonds.slashedToday(), bonds.dailySlashCap() > bonds.hardDailySlashCap() ? bonds.hardDailySlashCap() : bonds.hardDailySlashCap(), "slashed past the hard daily cap");
        assertLe(bonds.maxSlash(), bonds.hardMaxSlash(), "maxSlash above hard limit");
        assertLe(bonds.dailySlashCap(), bonds.hardDailySlashCap(), "daily cap above hard limit");
    }

    // Tally what actually succeeded across all runs (so the run isn't just reverts).
    function afterInvariant() external {
        vm.writeLine("tally.txt", string.concat(vm.toString(h.okDeposits()), " ", vm.toString(h.okPermits()), " ", vm.toString(h.okSlashes()), " ", vm.toString(h.okWithdraws())));
    }
}
