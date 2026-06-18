// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-v4/security/ReentrancyGuard.sol";

import "../role/RoleModule.sol";
import "../data/DataStore.sol";
import "../data/Keys.sol";
import "../event/EventEmitter.sol";
import "../feature/FeatureUtils.sol";
import "../utils/AccountUtils.sol";
import "../error/Errors.sol";
import "./FeeUtils.sol";

// @title ClaimHandler
// @dev External claim routes for the per-receiver protocol fees — the veAlpha / treasury / buyback /
// validator shares that accrue under Keys.claimableFeeAmountKey(market, token, receiver). Before this
// handler existed these balances had no external claim entrypoint (FeeUtils.claimFees was internal and
// no router exposed it), so they were permanently frozen in the market pools (ZEROMARK-14).
//
// Two routes are provided:
//   - claimFees (pull): a fee receiver claims its own accrued balance and routes it to a chosen
//     destination. No extra authorization is needed — the caller can only ever sweep fees keyed to
//     its own address.
//   - claimFeesForReceiver (push): a FEE_KEEPER sweeps a receiver's accrued balance and sends it to
//     that same receiver address. The destination is forced to the rightful receiver, so a keeper can
//     route fees for receivers that won't initiate their own claim (e.g. an EOA/multisig treasury)
//     without being able to redirect funds.
//
// The handler must hold the CONTROLLER role: FeeUtils.claimFees calls MarketToken.transferOut, which
// is restricted to controllers.
contract ClaimHandler is ReentrancyGuard, RoleModule {
    DataStore public immutable dataStore;
    EventEmitter public immutable eventEmitter;

    constructor(
        RoleStore _roleStore,
        DataStore _dataStore,
        EventEmitter _eventEmitter
    ) RoleModule(_roleStore) {
        dataStore = _dataStore;
        eventEmitter = _eventEmitter;
    }

    // @dev pull claim: the caller (a fee receiver) claims its own accrued protocol fees and routes
    //      them to `receiver`. claimableFeeAmountKey is keyed on msg.sender, so callers cannot claim
    //      fees that belong to another receiver.
    // @param markets the markets to claim from
    // @param tokens the fee tokens, corresponding to each market
    // @param receiver the address to send the claimed fees to
    function claimFees(
        address[] memory markets,
        address[] memory tokens,
        address receiver
    ) external nonReentrant returns (uint256[] memory) {
        if (markets.length != tokens.length) {
            revert Errors.InvalidClaimFeesInput(markets.length, tokens.length);
        }

        FeatureUtils.validateFeature(dataStore, Keys.claimFeesFeatureDisabledKey(address(this)));

        uint256[] memory claimedAmounts = new uint256[](markets.length);

        for (uint256 i; i < markets.length; i++) {
            claimedAmounts[i] = FeeUtils.claimFees(
                dataStore,
                eventEmitter,
                msg.sender,
                markets[i],
                tokens[i],
                receiver
            );
        }

        return claimedAmounts;
    }

    // @dev push claim: a FEE_KEEPER sweeps `feeReceiver`'s accrued protocol fees and sends them to
    //      that same `feeReceiver`. The destination is not caller-chosen, so the keeper cannot
    //      redirect funds — it can only deliver them to the rightful receiver.
    // @param markets the markets to claim from
    // @param tokens the fee tokens, corresponding to each market
    // @param feeReceiver the receiver whose accrued fees are swept and to which they are sent
    function claimFeesForReceiver(
        address[] memory markets,
        address[] memory tokens,
        address feeReceiver
    ) external nonReentrant onlyFeeKeeper returns (uint256[] memory) {
        if (markets.length != tokens.length) {
            revert Errors.InvalidClaimFeesInput(markets.length, tokens.length);
        }

        AccountUtils.validateReceiver(feeReceiver);

        FeatureUtils.validateFeature(dataStore, Keys.claimFeesFeatureDisabledKey(address(this)));

        uint256[] memory claimedAmounts = new uint256[](markets.length);

        for (uint256 i; i < markets.length; i++) {
            claimedAmounts[i] = FeeUtils.claimFees(
                dataStore,
                eventEmitter,
                feeReceiver,
                markets[i],
                tokens[i],
                feeReceiver
            );
        }

        return claimedAmounts;
    }
}
