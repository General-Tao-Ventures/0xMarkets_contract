// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../exchange/BaseHandler.sol";

import "./InsuranceFundUtils.sol";

// @title InsuranceFundHandler
// @dev Permissioned entrypoint for replenishing the insurance reserve.
//
// The reserve is otherwise one-directional: it fills from liquidation
// remainders and drains into pools during drawdowns, so once depleted there
// was no way to refill it and the LP backstop stayed empty.
//
// Two-phase, matching the protocol's "send then record" pattern: transfer the
// tokens into the InsuranceVault first, then call `topUp` to record the
// transfer and credit the market/token bucket. `recordTransferIn` reverts if
// the vault was under-funded, so the two phases cannot drift.
contract InsuranceFundHandler is BaseHandler {
    constructor(
        RoleStore _roleStore,
        DataStore _dataStore,
        EventEmitter _eventEmitter,
        Oracle _oracle
    ) BaseHandler(_roleStore, _dataStore, _eventEmitter, _oracle) {}

    // @param market the market whose reserve bucket is credited
    // @param token the token that was transferred into the vault
    // @param amount the amount to record; must already sit in the vault
    function topUp(
        address market,
        address token,
        uint256 amount
    ) external globalNonReentrant onlyConfigKeeper returns (uint256) {
        address vaultAddress = dataStore.getAddress(Keys.INSURANCE_FUND_ADDRESS);
        if (vaultAddress == address(0)) {
            revert Errors.EmptyInsuranceFundAddress();
        }

        return InsuranceFundUtils.topUp(
            dataStore,
            eventEmitter,
            InsuranceVault(payable(vaultAddress)),
            market,
            token,
            msg.sender,
            amount
        );
    }
}
