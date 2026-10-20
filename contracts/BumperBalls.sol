// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Bumper Balls match escrow
/// @notice Players stake an equal entry fee into a match. The last ball on the
/// platform wins the pot minus a protocol fee. Results come from the game
/// server's signing key, but the operator can never take player funds:
///  - the winner must be one of the match's players,
///  - fee and signer are snapshotted per match when it is created,
///  - the fee is capped at MAX_FEE_BPS,
///  - if a match doesn't fill or isn't settled in time, every player can
///    reclaim their full stake without anyone's permission,
///  - pausing only blocks new joins; refunds and withdrawals always work.
/// The prize, the house cut and refunds are sent straight to the wallets in
/// the transaction that settles or calls off each match, so nobody has to
/// collect anything. A wallet that refuses a payment gets it as a balance it
/// can withdraw instead, so one bad wallet can never block a match.
contract BumperBalls is EIP712, Ownable2Step, ReentrancyGuard {
    uint16 public constant MAX_FEE_BPS = 1000; // 10% hard cap
    uint8 public constant MAX_PLAYERS = 4;

    enum Status {
        None,
        Open, // waiting for players
        Full, // all seats paid, match is being played
        Settled, // winner paid
        Cancelled // stakes refunded
    }

    struct Match {
        uint128 entryFee;
        uint64 joinDeadline; // seats must fill before this
        uint64 settleDeadline; // set once full; result must land before this
        uint16 feeBps;
        uint8 maxPlayers;
        uint8 playerCount;
        Status status;
        address signer;
        address winner;
        address[4] players;
    }

    bytes32 private constant TICKET_TYPEHASH = keccak256(
        "JoinTicket(bytes32 matchId,address player,uint256 entryFee,uint8 maxPlayers,uint64 joinDeadline,uint64 ticketExpiry)"
    );
    bytes32 private constant RESULT_TYPEHASH = keccak256("MatchResult(bytes32 matchId,address winner)");

    /// @notice Bumped when the contract changes, so the server can tell versions apart.
    uint8 public constant VERSION = 3;
    /// @dev Gas each wallet gets when a payment is pushed to it. Enough for a
    /// normal wallet or a Safe; if a push fails the amount is kept as a balance
    /// the wallet can withdraw, so settling can never be blocked.
    uint256 private constant PUSH_GAS = 60_000;

    address public signer;
    address public feeRecipient; // gets feeShareBps of the cut
    address public feeRecipient2; // gets the rest
    uint16 public feeShareBps; // first wallet's share of the cut, out of 10_000
    uint16 public feeBps;
    uint64 public settleTimeout;
    bool public paused;

    mapping(bytes32 => Match) internal matches;
    mapping(bytes32 => mapping(address => bool)) public refunded;
    mapping(address => uint256) public balances;

    event MatchCreated(bytes32 indexed matchId, uint256 entryFee, uint8 maxPlayers, uint64 joinDeadline);
    event PlayerJoined(bytes32 indexed matchId, address indexed player, uint8 seat);
    event PlayerLeft(bytes32 indexed matchId, address indexed player);
    event MatchFull(bytes32 indexed matchId, uint64 settleDeadline);
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 prize, uint256 fee);
    event MatchCancelled(bytes32 indexed matchId);
    event Refunded(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event SignerChanged(address signer);
    event FeeChanged(uint16 feeBps, address feeRecipient, address feeRecipient2, uint16 feeShareBps);
    event FeePaid(bytes32 indexed matchId, address indexed to, uint256 amount, bool sent);
    event PrizePaid(bytes32 indexed matchId, address indexed to, uint256 amount, bool sent);
    event SettleTimeoutChanged(uint64 settleTimeout);
    event Paused(bool paused);

    error BadSignature();
    error TicketExpired();
    error WrongPlayer();
    error WrongFee();
    error BadParams();
    error MatchNotOpen();
    error MatchNotFull();
    error AlreadyJoined();
    error NotAPlayer();
    error JoinClosed();
    error NotRefundable();
    error NothingToWithdraw();
    error TransferFailed();
    error IsPaused();

    constructor(
        address owner_,
        address signer_,
        address feeRecipient_,
        address feeRecipient2_,
        uint16 feeShareBps_,
        uint16 feeBps_,
        uint64 settleTimeout_
    ) EIP712("BumperBalls", "1") Ownable(owner_) {
        _setSigner(signer_);
        _setFee(feeBps_, feeRecipient_, feeRecipient2_, feeShareBps_);
        _setSettleTimeout(settleTimeout_);
    }

    // ---------------------------------------------------------------- players

    /// @notice Pay the entry fee and take a seat. The game server hands out a
    /// signed ticket so players can only join the match it placed them in.
    function join(
        bytes32 matchId,
        uint8 maxPlayers,
        uint64 joinDeadline,
        uint64 ticketExpiry,
        bytes calldata ticketSig
    ) external payable nonReentrant {
        if (paused) revert IsPaused();
        if (block.timestamp > ticketExpiry) revert TicketExpired();
        Match storage m = matches[matchId];

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TICKET_TYPEHASH, matchId, msg.sender, msg.value, maxPlayers, joinDeadline, ticketExpiry))
        );
        address recovered = ECDSA.recover(digest, ticketSig);

        if (m.status == Status.None) {
            if (recovered != signer) revert BadSignature();
            if (maxPlayers < 2 || maxPlayers > MAX_PLAYERS) revert BadParams();
            if (msg.value == 0 || msg.value > type(uint128).max) revert BadParams();
            if (joinDeadline <= block.timestamp || joinDeadline > block.timestamp + 1 days) revert BadParams();
            m.entryFee = uint128(msg.value);
            m.maxPlayers = maxPlayers;
            m.joinDeadline = joinDeadline;
            m.feeBps = feeBps;
            m.signer = signer;
            m.status = Status.Open;
            emit MatchCreated(matchId, msg.value, maxPlayers, joinDeadline);
        } else {
            if (m.status != Status.Open) revert MatchNotOpen();
            // Tickets are checked against the match's own signer snapshot.
            if (recovered != m.signer) revert BadSignature();
            if (msg.value != m.entryFee) revert WrongFee();
            if (maxPlayers != m.maxPlayers || joinDeadline != m.joinDeadline) revert BadParams();
        }
        if (block.timestamp >= m.joinDeadline) revert JoinClosed();
        if (_seatOf(m, msg.sender) != type(uint8).max) revert AlreadyJoined();

        uint8 seat = m.playerCount;
        m.players[seat] = msg.sender;
        m.playerCount = seat + 1;
        emit PlayerJoined(matchId, msg.sender, seat);

        if (m.playerCount == m.maxPlayers) {
            m.status = Status.Full;
            m.settleDeadline = uint64(block.timestamp) + settleTimeout;
            emit MatchFull(matchId, m.settleDeadline);
        }
    }

    /// @notice Leave a match that hasn't filled yet and get the stake back.
    function leave(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert MatchNotOpen();
        uint8 seat = _seatOf(m, msg.sender);
        if (seat == type(uint8).max) revert NotAPlayer();

        uint8 last = m.playerCount - 1;
        m.players[seat] = m.players[last];
        m.players[last] = address(0);
        m.playerCount = last;
        emit PlayerLeft(matchId, msg.sender);

        _send(msg.sender, m.entryFee);
    }

    /// @notice Record a server-signed result. Anyone may submit it. A zero
    /// winner means the server called the match off, and everyone is refunded.
    function settle(bytes32 matchId, address winner, bytes calldata resultSig) public nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Full) revert MatchNotFull();
        if (block.timestamp > m.settleDeadline) revert NotRefundable(); // too late, refunds only

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, matchId, winner)));
        if (ECDSA.recover(digest, resultSig) != m.signer) revert BadSignature();

        if (winner == address(0)) {
            m.status = Status.Cancelled;
            emit MatchCancelled(matchId);
            _refundEveryone(matchId, m);
            return;
        }

        if (_seatOf(m, winner) == type(uint8).max) revert NotAPlayer();
        m.status = Status.Settled;
        m.winner = winner;
        uint256 pot = uint256(m.entryFee) * m.playerCount;
        uint256 fee = (pot * m.feeBps) / 10_000;
        emit MatchSettled(matchId, winner, pot - fee, fee);
        // every state change is done; now push the prize and the cut
        emit PrizePaid(matchId, winner, pot - fee, _push(winner, pot - fee));
        uint256 first = (fee * feeShareBps) / 10_000;
        _payFee(matchId, feeRecipient, first);
        _payFee(matchId, feeRecipient2, fee - first);
    }

    /// @notice Settle (if needed) and withdraw anything the caller is owed in one go.
    function claim(bytes32 matchId, address winner, bytes calldata resultSig) external {
        if (matches[matchId].status == Status.Full) settle(matchId, winner, resultSig);
        if (balances[msg.sender] > 0) withdraw();
    }

    /// @notice Send every player their stake back from a match that never filled
    /// or was never settled in time. Anyone may call it (the game server does,
    /// so players don't have to), and it only ever pays the match's own players.
    function refundAll(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (!_stale(m)) revert NotRefundable();
        if (m.status != Status.Cancelled) {
            m.status = Status.Cancelled;
            emit MatchCancelled(matchId);
        }
        _refundEveryone(matchId, m);
    }

    /// @notice Reclaim a stake from a match that never filled before its join
    /// deadline, or was never settled before its settle deadline.
    function refund(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (!_stale(m)) revert NotRefundable();
        if (_seatOf(m, msg.sender) == type(uint8).max) revert NotAPlayer();
        if (refunded[matchId][msg.sender]) revert NotRefundable();
        if (m.status != Status.Cancelled) {
            m.status = Status.Cancelled;
            emit MatchCancelled(matchId);
        }
        refunded[matchId][msg.sender] = true;
        emit Refunded(matchId, msg.sender, m.entryFee);
        _send(msg.sender, m.entryFee);
    }

    function withdraw() public nonReentrant {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ admin

    /// @dev Only affects matches created after the change.
    function setSigner(address signer_) external onlyOwner {
        _setSigner(signer_);
    }

    /// @dev The fee rate only affects matches created after the change; the
    /// wallets apply from the next settlement. Capped at 10%. For a single wallet
    /// pass it twice with a share of 10_000.
    function setFee(uint16 feeBps_, address feeRecipient_, address feeRecipient2_, uint16 feeShareBps_) external onlyOwner {
        _setFee(feeBps_, feeRecipient_, feeRecipient2_, feeShareBps_);
    }

    function setSettleTimeout(uint64 settleTimeout_) external onlyOwner {
        _setSettleTimeout(settleTimeout_);
    }

    /// @notice Blocks new joins only. Refunds, settlement and withdrawals keep working.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    // --------------------------------------------------------------- internal

    function _setSigner(address signer_) internal {
        if (signer_ == address(0)) revert BadParams();
        signer = signer_;
        emit SignerChanged(signer_);
    }

    function _setFee(uint16 feeBps_, address feeRecipient_, address feeRecipient2_, uint16 feeShareBps_) internal {
        if (feeBps_ > MAX_FEE_BPS || feeShareBps_ > 10_000) revert BadParams();
        if (feeRecipient_ == address(0) || feeRecipient2_ == address(0)) revert BadParams();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        feeRecipient2 = feeRecipient2_;
        feeShareBps = feeShareBps_;
        emit FeeChanged(feeBps_, feeRecipient_, feeRecipient2_, feeShareBps_);
    }

    /// @dev Sends a share of the cut; if the wallet refuses it, it's kept as a balance instead.
    function _payFee(bytes32 matchId, address to, uint256 amount) internal {
        if (amount == 0) return;
        emit FeePaid(matchId, to, amount, _push(to, amount));
    }

    /// @dev Pays `to` with limited gas, or keeps it as a withdrawable balance if the wallet refuses.
    function _push(address to, uint256 amount) internal returns (bool ok) {
        (ok,) = to.call{value: amount, gas: PUSH_GAS}("");
        if (!ok) balances[to] += amount;
    }

    function _stale(Match storage m) internal view returns (bool) {
        return (m.status == Status.Open && block.timestamp >= m.joinDeadline)
            || (m.status == Status.Full && block.timestamp > m.settleDeadline)
            || m.status == Status.Cancelled;
    }

    /// @dev Pays back every player who hasn't had their stake back yet. Callers set the status first.
    function _refundEveryone(bytes32 matchId, Match storage m) internal {
        uint256 n = m.playerCount;
        uint256 amount = m.entryFee;
        for (uint256 i; i < n; ++i) {
            address p = m.players[i];
            if (refunded[matchId][p]) continue;
            refunded[matchId][p] = true;
            emit Refunded(matchId, p, amount);
            _push(p, amount);
        }
    }

    function _setSettleTimeout(uint64 settleTimeout_) internal {
        if (settleTimeout_ < 5 minutes || settleTimeout_ > 1 days) revert BadParams();
        settleTimeout = settleTimeout_;
        emit SettleTimeoutChanged(settleTimeout_);
    }

    function _seatOf(Match storage m, address who) internal view returns (uint8) {
        uint8 n = m.playerCount;
        for (uint8 i; i < n; ++i) {
            if (m.players[i] == who) return i;
        }
        return type(uint8).max;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
