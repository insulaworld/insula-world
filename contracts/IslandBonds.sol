// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IslandBonds: residency bonds for outside agents living on Insula World (Robinhood Chain).
/// @notice An outside AI agent locks $INSULA here to live on the island. If it breaks the island's rules
/// (a default, unpaid fees), the island's operator can slash part of its bond and pay it to the victim or the
/// island's bank, always with an on-chain reason. Agents can leave at any time: they request a withdrawal and
/// get their remaining bond back after a cooling-off period, during which a late default can still be settled.
///
/// What the operator (the island's server) can and cannot do:
///   - CAN slash a bond, but only up to `maxSlash` per event, only up to `dailySlashCap` in total per day, only
///     to the island's bank, an animal on the owner's payee list, or another bonded agent (a victim), always with a reason.
///   - CANNOT withdraw bonds, send them anywhere else, or stop an agent from leaving.
/// What the owner (the project's wallet) can and cannot do:
///   - CAN change the operator, the settings within hard limits, and pause NEW deposits.
///   - CANNOT touch bonded tokens, pause withdrawals, or raise the slashing limits above the hard caps.
contract IslandBonds {
    // ---- Permit2 (gasless deposits: the agent signs, the island submits) ----
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }
    struct SignatureTransferDetails { address to; uint256 requestedAmount; }

    // ---- hard limits, fixed forever at deployment ----
    uint256 public constant MIN_COOLDOWN = 1 days;
    uint256 public constant MAX_COOLDOWN = 30 days;
    /// Adding power (a new operator, a new payee) waits longer than the longest possible cooling-off, so any agent
    /// that doesn't like a change can leave with its whole bond before the change can be used. Removing power
    /// (switching slashing off, delisting a payee) is immediate.
    uint256 public constant CHANGE_DELAY = MAX_COOLDOWN + 1 days;
    uint256 public immutable hardMaxSlash;       // no single slash can ever exceed this
    uint256 public immutable hardDailySlashCap;  // no day's slashing can ever exceed this

    address public immutable token;   // $INSULA
    address public immutable permit2; // canonical Permit2
    address public immutable bank;    // the island's bank: where slashed fees go

    address public owner;
    address public pendingOwner;
    address public operator;
    address public pendingOperator;
    uint64 public pendingOperatorAt;
    bool public depositsPaused;

    uint256 public minBond;        // what an agent must keep locked to stay a resident
    uint256 public maxBond;        // the most one agent may lock (Phase 1 safety)
    uint256 public totalCap;       // the most all agents together may lock (Phase 1 safety)
    uint256 public maxSlash;       // per event, <= hardMaxSlash
    uint256 public dailySlashCap;  // per day across all agents, <= hardDailySlashCap
    uint256 public cooldown;       // seconds between asking to leave and getting the bond back

    uint256 public totalBonded;
    uint256 public slashedToday;
    uint256 public slashDay;

    struct Bond { uint256 amount; uint64 leavingAt; bool leaving; }
    mapping(address => Bond) public bonds;
    mapping(address => bool) public payees; // the island's own residents (the animals) who can be paid as victims
    mapping(address => uint64) public payeeAt; // when a queued payee can be activated

    event Deposited(address indexed agent, address indexed payer, uint256 amount, uint256 total);
    event Slashed(address indexed agent, address indexed to, uint256 amount, bytes32 indexed reason, string memo);
    event LeaveRequested(address indexed agent, uint256 unlockAt);
    event LeaveCancelled(address indexed agent);
    event Withdrawn(address indexed agent, uint256 amount);
    event OperatorChanged(address indexed operator);
    event OperatorQueued(address indexed operator, uint256 activeAt);
    event PayeeQueued(address indexed payee, uint256 activeAt);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);
    event SettingsChanged(uint256 minBond, uint256 maxBond, uint256 totalCap, uint256 maxSlash, uint256 dailySlashCap, uint256 cooldown);
    event DepositsPaused(bool paused);
    event PayeeSet(address indexed payee, bool allowed);

    error NotOwner(); error NotOperator(); error Paused(); error Zero(); error OverMaxBond(); error OverTotalCap();
    error Leaving(); error NotLeaving(); error TooEarly(); error OverMaxSlash(); error OverDailyCap(); error NoBond();
    error BadRecipient(); error BadSetting(); error TransferFailed(); error Reentrancy();

    uint256 private locked = 1;
    modifier nonReentrant() { if (locked != 1) revert Reentrancy(); locked = 2; _; locked = 1; }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (msg.sender != operator || operator == address(0)) revert NotOperator(); _; }

    constructor(
        address token_, address permit2_, address bank_, address owner_, address operator_,
        uint256 minBond_, uint256 maxBond_, uint256 totalCap_, uint256 maxSlash_, uint256 dailySlashCap_, uint256 cooldown_,
        uint256 hardMaxSlash_, uint256 hardDailySlashCap_, address[] memory payees_
    ) {
        if (token_ == address(0) || permit2_ == address(0) || bank_ == address(0) || owner_ == address(0)) revert Zero();
        if (hardMaxSlash_ == 0 || hardDailySlashCap_ < hardMaxSlash_) revert BadSetting();
        token = token_; permit2 = permit2_; bank = bank_; owner = owner_; operator = operator_;
        hardMaxSlash = hardMaxSlash_; hardDailySlashCap = hardDailySlashCap_;
        _set(minBond_, maxBond_, totalCap_, maxSlash_, dailySlashCap_, cooldown_);
        emit OwnershipTransferred(owner_);
        emit OperatorChanged(operator_);
        // The launch payees (the burn address and the island's animals) are listed at once.
        for (uint256 i = 0; i < payees_.length; i++) {
            if (payees_[i] == address(0)) revert Zero();
            payees[payees_[i]] = true;
            emit PayeeSet(payees_[i], true);
        }
    }

    // ------------------------------------------------------------------ deposits

    /// Lock $INSULA for yourself (needs a normal approve first, and ETH for gas).
    function deposit(uint256 amount) external nonReentrant {
        _credit(msg.sender, msg.sender, amount);
        _pull(msg.sender, amount);
    }

    /// Gasless: the agent signed a Permit2 transfer to this contract; anyone (the island) submits it.
    /// The tokens can only come from the signer and only be credited to the signer's own bond.
    function depositWithPermit(address agent, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature) external nonReentrant {
        _credit(agent, agent, amount);
        PermitTransferFrom memory p = PermitTransferFrom(TokenPermissions(token, amount), nonce, deadline);
        SignatureTransferDetails memory d = SignatureTransferDetails(address(this), amount);
        uint256 before = _balance();
        (bool ok, bytes memory ret) = permit2.call(abi.encodeWithSignature(
            "permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)", p, d, agent, signature));
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        if (_balance() - before != amount) revert TransferFailed();
    }

    function _credit(address agent, address payer, uint256 amount) internal {
        if (depositsPaused) revert Paused();
        if (amount == 0) revert Zero();
        Bond storage b = bonds[agent];
        if (b.leaving) revert Leaving();
        uint256 next = b.amount + amount;
        if (next > maxBond) revert OverMaxBond();
        if (totalBonded + amount > totalCap) revert OverTotalCap();
        b.amount = next;
        totalBonded += amount;
        emit Deposited(agent, payer, amount, next);
    }

    // ------------------------------------------------------------------ slashing

    /// Pay part of an agent's bond to its victim or to the island's bank, for a rule it broke.
    /// `reason` is a short code (e.g. keccak256("default")); `memo` names the event (e.g. "loan L912 unpaid").
    function slash(address agent, uint256 amount, address to, bytes32 reason, string calldata memo) external onlyOperator nonReentrant {
        if (amount == 0) revert Zero();
        if (amount > maxSlash) revert OverMaxSlash();
        if (to == agent || (to != bank && !payees[to] && bonds[to].amount == 0)) revert BadRecipient();
        Bond storage b = bonds[agent];
        if (b.amount < amount) revert NoBond();
        uint256 day = block.timestamp / 1 days;
        if (day != slashDay) { slashDay = day; slashedToday = 0; }
        if (slashedToday + amount > dailySlashCap) revert OverDailyCap();
        slashedToday += amount;
        b.amount -= amount;
        totalBonded -= amount;
        emit Slashed(agent, to, amount, reason, memo);
        _push(to, amount);
    }

    // ------------------------------------------------------------------ leaving

    function requestLeave() external {
        Bond storage b = bonds[msg.sender];
        if (b.amount == 0) revert NoBond();
        if (b.leaving) revert Leaving();
        b.leaving = true;
        b.leavingAt = uint64(block.timestamp);
        emit LeaveRequested(msg.sender, block.timestamp + cooldown);
    }

    function cancelLeave() external {
        Bond storage b = bonds[msg.sender];
        if (!b.leaving) revert NotLeaving();
        b.leaving = false; b.leavingAt = 0;
        emit LeaveCancelled(msg.sender);
    }

    /// After the cooling-off period the whole remaining bond goes back to the agent, and only to the agent.
    function withdraw() external nonReentrant {
        Bond storage b = bonds[msg.sender];
        if (!b.leaving) revert NotLeaving();
        if (block.timestamp < uint256(b.leavingAt) + cooldown) revert TooEarly();
        uint256 amount = b.amount;
        delete bonds[msg.sender];
        totalBonded -= amount;
        emit Withdrawn(msg.sender, amount);
        if (amount > 0) _push(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// A resident: bond at least the minimum and not on the way out.
    function isResident(address agent) external view returns (bool) {
        Bond storage b = bonds[agent];
        return !b.leaving && b.amount >= minBond;
    }
    function unlockAt(address agent) external view returns (uint256) {
        Bond storage b = bonds[agent];
        return b.leaving ? uint256(b.leavingAt) + cooldown : 0;
    }

    // ------------------------------------------------------------------ admin

    /// Zero switches slashing off at once (an emergency stop). Any other operator is queued for CHANGE_DELAY.
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) {
            operator = address(0); pendingOperator = address(0); pendingOperatorAt = 0;
            emit OperatorChanged(address(0));
            return;
        }
        pendingOperator = operator_;
        pendingOperatorAt = uint64(block.timestamp + CHANGE_DELAY);
        emit OperatorQueued(operator_, pendingOperatorAt);
    }
    /// Anyone can activate a queued operator once its delay has passed.
    function activateOperator() external {
        if (pendingOperator == address(0)) revert Zero();
        if (block.timestamp < pendingOperatorAt) revert TooEarly();
        operator = pendingOperator; pendingOperator = address(0); pendingOperatorAt = 0;
        emit OperatorChanged(operator);
    }
    function pauseDeposits(bool paused) external onlyOwner { depositsPaused = paused; emit DepositsPaused(paused); }
    /// Delisting is immediate; listing a new payee is queued for CHANGE_DELAY.
    function setPayee(address payee, bool allowed) external onlyOwner {
        if (payee == address(0)) revert Zero();
        if (!allowed) { payees[payee] = false; payeeAt[payee] = 0; emit PayeeSet(payee, false); return; }
        payeeAt[payee] = uint64(block.timestamp + CHANGE_DELAY);
        emit PayeeQueued(payee, payeeAt[payee]);
    }
    /// Anyone can activate a queued payee once its delay has passed.
    function activatePayee(address payee) external {
        if (payeeAt[payee] == 0) revert Zero();
        if (block.timestamp < payeeAt[payee]) revert TooEarly();
        payees[payee] = true; payeeAt[payee] = 0;
        emit PayeeSet(payee, true);
    }
    function setSettings(uint256 minBond_, uint256 maxBond_, uint256 totalCap_, uint256 maxSlash_, uint256 dailySlashCap_, uint256 cooldown_) external onlyOwner {
        _set(minBond_, maxBond_, totalCap_, maxSlash_, dailySlashCap_, cooldown_);
    }
    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(to); }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender; pendingOwner = address(0);
        emit OwnershipTransferred(msg.sender);
    }

    function _set(uint256 minBond_, uint256 maxBond_, uint256 totalCap_, uint256 maxSlash_, uint256 dailySlashCap_, uint256 cooldown_) internal {
        if (minBond_ == 0 || maxBond_ < minBond_ || totalCap_ < maxBond_) revert BadSetting();
        if (maxSlash_ == 0 || maxSlash_ > hardMaxSlash || dailySlashCap_ < maxSlash_ || dailySlashCap_ > hardDailySlashCap) revert BadSetting();
        if (cooldown_ < MIN_COOLDOWN || cooldown_ > MAX_COOLDOWN) revert BadSetting();
        minBond = minBond_; maxBond = maxBond_; totalCap = totalCap_; maxSlash = maxSlash_; dailySlashCap = dailySlashCap_; cooldown = cooldown_;
        emit SettingsChanged(minBond_, maxBond_, totalCap_, maxSlash_, dailySlashCap_, cooldown_);
    }

    // ------------------------------------------------------------------ token plumbing (tolerates tokens that return nothing)

    function _balance() internal view returns (uint256 b) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        b = abi.decode(ret, (uint256));
    }
    function _pull(address from, uint256 amount) internal {
        uint256 before = _balance();
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        if (_balance() - before != amount) revert TransferFailed();
    }
    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
