// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IBumperBallsEscrow {
    function withdraw() external;
    function balances(address account) external view returns (uint256);
}

/// @title Bumper Balls house-cut splitter
/// @notice Set as the escrow's fee recipient. Pays everything it collects to
/// two fixed wallets in a fixed split. Anyone may trigger a payout; the wallets
/// and the split can never change, so the payer can't redirect anything.
contract FeeSplitter {
    IBumperBallsEscrow public immutable escrow;
    address public immutable walletA;
    address public immutable walletB;
    uint16 public immutable bpsA; // walletA's share in basis points; walletB gets the rest

    bool private locked;

    event Paid(uint256 toA, uint256 toB);

    error BadConfig();
    error Reentered();
    error TransferFailed();

    constructor(IBumperBallsEscrow escrow_, address walletA_, address walletB_, uint16 bpsA_) {
        if (address(escrow_) == address(0) || walletA_ == address(0) || walletB_ == address(0) || bpsA_ > 10_000) revert BadConfig();
        escrow = escrow_;
        walletA = walletA_;
        walletB = walletB_;
        bpsA = bpsA_;
    }

    receive() external payable {}

    /// @notice Pull this contract's fees out of the escrow and pay both wallets.
    function payout() external {
        if (locked) revert Reentered();
        locked = true;
        if (escrow.balances(address(this)) > 0) escrow.withdraw();
        uint256 total = address(this).balance;
        if (total > 0) {
            uint256 toA = (total * bpsA) / 10_000;
            uint256 toB = total - toA;
            _send(walletA, toA);
            _send(walletB, toB);
            emit Paid(toA, toB);
        }
        locked = false;
    }

    /// @notice What a payout would send right now, in total.
    function pending() external view returns (uint256) {
        return escrow.balances(address(this)) + address(this).balance;
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
