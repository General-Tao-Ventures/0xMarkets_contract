// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-v4/utils/math/SafeCast.sol";

import "../data/DataStore.sol";
import "../data/Keys.sol";
import "../event/EventEmitter.sol";
import "../market/Market.sol";
import "../market/MarketToken.sol";
import "../market/MarketUtils.sol";
import "../price/Price.sol";
import "../utils/Precision.sol";

import "./InsuranceVault.sol";
import "./InsuranceFundEventUtils.sol";

// @title InsuranceFundUtils
// @dev Per-market insurance reserve logic. Three responsibilities:
//   1. Collect a configurable slice of liquidation/position fees into the
//      InsuranceVault (deposit).
//   2. Inject capital from the vault back into MarketToken when realized
//      pool drawdown exceeds the per-market trigger threshold
//      (attemptInjectPool).
//   3. Snapshot the per-market pool USD value at epoch boundaries so
//      drawdown can be computed against a stable baseline (snapshotEpoch).
//
// The vault is a singleton; per-market and per-token segregation is
// bookkeeping in DataStore. Callers must already hold the CONTROLLER role
// on MarketToken and the InsuranceVault — the protocol handlers do.
library InsuranceFundUtils {
    using SafeCast for int256;
    using SafeCast for uint256;

    using Price for Price.Props;

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getBalance(DataStore dataStore, address market, address token) internal view returns (uint256) {
        return dataStore.getUint(Keys.insuranceFundBalanceKey(market, token));
    }

    // @dev Computes the current realized drawdown fraction for a market.
    //
    // Returns (0, currentValue, epochValue) when the fund is **disabled**
    // for that market, which is any of:
    //   - first epoch (epochValue == 0, snapshotEpoch never ran)
    //   - stale snapshot (block.timestamp - epochStart > MAX_EPOCH_AGE)
    //   - pool currently at or above the epoch snapshot (no drawdown)
    //
    // Uses minimize=false for the pool-value lookup so the snapshot and
    // current measurement use the same price-pick rule. Both use the LP-
    // conservative "minimize" pickPrice so a stressed-LP read is always
    // the larger number (better protection).
    function getDrawdownFraction(
        DataStore dataStore,
        Market.Props memory market,
        MarketUtils.MarketPrices memory prices
    ) public view returns (uint256 drawdownFraction, uint256 currentPoolValueUsd, uint256 epochPoolValueUsd) {
        int256 cur = MarketUtils.getPoolValueExcludingUnrealizedPnl(dataStore, market, prices, false);
        currentPoolValueUsd = cur < 0 ? 0 : uint256(cur);

        epochPoolValueUsd = dataStore.getUint(Keys.insuranceFundEpochPoolValueKey(market.marketToken));
        if (epochPoolValueUsd == 0) {
            return (0, currentPoolValueUsd, epochPoolValueUsd);
        }

        uint256 epochStart = dataStore.getUint(Keys.insuranceFundEpochStartKey(market.marketToken));
        uint256 maxAge = dataStore.getUint(Keys.INSURANCE_FUND_MAX_EPOCH_AGE);
        // maxAge == 0 disables the stale check (treat as no upper bound).
        // A keeper-supplied maxAge of e.g. 8 days bounds how long a missed
        // Friday snapshot can poison subsequent drawdown calculations.
        if (maxAge > 0 && epochStart != 0 && block.timestamp - epochStart > maxAge) {
            return (0, currentPoolValueUsd, epochPoolValueUsd);
        }

        // measure the drawdown on per-SHARE value, not absolute pool value. A proportional
        // LP withdrawal lowers the absolute pool value and burns MarketToken supply in the same ratio,
        // leaving per-share value unchanged — it must not register as a drawdown (else a benign exit
        // would fake a loss and trigger an injection that a holding account captures). Normalizing by
        // supply isolates a real LP loss (PnL / price impact, supply unchanged → per-share falls) from a
        // benign supply change (deposit / withdrawal → per-share flat).
        uint256 epochSupply = dataStore.getUint(Keys.insuranceFundEpochSupplyKey(market.marketToken));
        uint256 currentSupply = MarketToken(payable(market.marketToken)).totalSupply();
        // No paired supply snapshot (epoch taken before this upgrade), an empty epoch, or an empty pool
        // ⇒ treat the fund as disabled until the next snapshotEpoch re-baselines with a supply.
        if (epochSupply == 0 || currentSupply == 0) {
            return (0, currentPoolValueUsd, epochPoolValueUsd);
        }

        uint256 epochPerShare = Precision.mulDiv(epochPoolValueUsd, Precision.FLOAT_PRECISION, epochSupply);
        uint256 currentPerShare = Precision.mulDiv(currentPoolValueUsd, Precision.FLOAT_PRECISION, currentSupply);
        if (currentPerShare >= epochPerShare) {
            return (0, currentPoolValueUsd, epochPoolValueUsd);
        }

        // 1e30-scaled fraction. epochPerShare > currentPerShare >= 0 here, so it is non-zero.
        drawdownFraction = Precision.mulDiv(epochPerShare - currentPerShare, Precision.FLOAT_PRECISION, epochPerShare);
    }

    // ---------------------------------------------------------------------
    // Collection
    // ---------------------------------------------------------------------

    // @dev Moves `amount` of `token` from MarketToken into the InsuranceVault
    // and increments the per (market, token) reserve bookkeeping.
    //
    // Idempotent on zero (no-op rather than revert) so callers can pass the
    // computed slice unconditionally without an outer check.
    function deposit(
        DataStore dataStore,
        EventEmitter eventEmitter,
        InsuranceVault vault,
        address market,
        address token,
        bytes32 orderKey,
        uint256 amount
    ) external returns (uint256 newBalance) {
        if (amount == 0) {
            return dataStore.getUint(Keys.insuranceFundBalanceKey(market, token));
        }

        MarketToken(payable(market)).transferOut(token, address(vault), amount);
        // recordTransferIn returns the delta vs. previously-tracked balance.
        // We ignore the return value because the bookkeeping increment uses
        // the requested `amount`; if a non-standard token (fee-on-transfer)
        // delivered less, the invariant
        //   vault.tokenBalances(token) >= sum(reserve buckets)
        // would fail, which is the correct posture — we don't support such
        // tokens as pnl/collateral in any market.
        vault.recordTransferIn(token);

        newBalance = dataStore.incrementUint(Keys.insuranceFundBalanceKey(market, token), amount);

        InsuranceFundEventUtils.emitInsuranceFundDeposit(
            eventEmitter,
            market,
            token,
            orderKey,
            amount,
            newBalance
        );
    }

    // @dev Governance-initiated reserve top-up from treasury.
    //
    // Two-phase: external caller must first transfer `amount` of `token`
    // into the vault, then call this to record the transfer and increment
    // the bucket. Mirrors the protocol's "send then record" pattern (see
    // ExchangeRouter deposits).
    function topUp(
        DataStore dataStore,
        EventEmitter eventEmitter,
        InsuranceVault vault,
        address market,
        address token,
        address depositor,
        uint256 amount
    ) internal returns (uint256 newBalance) {
        if (amount == 0) {
            return dataStore.getUint(Keys.insuranceFundBalanceKey(market, token));
        }

        // recordTransferIn reads balanceOf and subtracts the prior cached
        // value; reverts implicitly if the depositor under-transferred.
        uint256 received = vault.recordTransferIn(token);
        require(received >= amount, "InsuranceFundUtils: under-funded topUp");

        newBalance = dataStore.incrementUint(Keys.insuranceFundBalanceKey(market, token), amount);

        InsuranceFundEventUtils.emitInsuranceFundManualDeposit(
            eventEmitter,
            market,
            token,
            depositor,
            amount,
            newBalance
        );
    }

    // ---------------------------------------------------------------------
    // Injection
    // ---------------------------------------------------------------------

    // @dev If realized drawdown exceeds the per-market trigger factor,
    // transfers reserves from the InsuranceVault into MarketToken and
    // credits the pool via applyDeltaToPoolAmount until drawdown returns
    // to threshold (or the market's reserve buckets are drained).
    //
    // Reserve buckets are keyed by the token that was physically deposited.
    // Position fees arrive in the position's collateralToken, which can be
    // either pool token regardless of position side, so a market's reserve
    // is inherently split across both pool-token buckets. The injection
    // therefore draws from BOTH: the pnlToken bucket first (loss side),
    // then the other pool token's bucket for any remainder. Each bucket
    // injects its own token and credits its own pool side, so bookkeeping
    // never diverges from the vault's physical holdings.
    //
    // Returns the total injected value in USD (FLOAT_PRECISION scale); 0 if
    // no trigger or all buckets empty. Never reverts on insufficient
    // reserve — emits InsuranceFundShortfall and proceeds.
    //
    // Wiring: this is intended to be called once at the end of
    // DecreasePositionCollateralUtils.processCollateral, after all
    // applyDeltaToPoolAmount branches have settled. ADL and liquidation
    // paths flow through the same `processCollateral`, so they pick this
    // up automatically.
    function attemptInjectPool(
        DataStore dataStore,
        EventEmitter eventEmitter,
        InsuranceVault vault,
        Market.Props memory market,
        MarketUtils.MarketPrices memory prices,
        address pnlToken,
        bytes32 orderKey
    ) external returns (uint256 injectedUsd) {
        uint256 triggerFactor = dataStore.getUint(Keys.insuranceFundDrawdownTriggerFactorKey(market.marketToken));
        // The fund is OFF for a market unless an explicit positive trigger is set.
        //
        // Two values disable injection:
        //   - type(uint256).max: the explicit "not-yet-onboarded" sentinel.
        //   - 0: the DataStore default for an unset key. Without this guard a
        //     0 trigger means `drawdown <= 0` — i.e. inject on ANY non-zero
        //     drawdown, draining the reserve on ordinary market noise before the
        //     extreme events it is meant to cover (ZEROMARK-56/93). A market
        //     genuinely wanting "inject on any drawdown" must set a small
        //     positive trigger, not rely on the unsafe default.
        //
        // Deploy scripts should still set the trigger explicitly per market; this
        // guard is the fail-safe so a missed initialization cannot drain the fund.
        if (triggerFactor == 0 || triggerFactor == type(uint256).max) {
            return 0;
        }

        uint256 requestedTokens;
        {
            (uint256 drawdownBefore, uint256 currentValue, uint256 epochValue) = getDrawdownFraction(dataStore, market, prices);
            if (drawdownBefore <= triggerFactor) {
                return 0;
            }
            requestedTokens = _computeRequestedInjection(
                market,
                prices,
                pnlToken,
                currentValue,
                epochValue,
                triggerFactor
            );
        }

        injectedUsd = _injectFromBucket(dataStore, eventEmitter, vault, market, prices, pnlToken, orderKey, triggerFactor);

        address otherToken = pnlToken == market.longToken ? market.shortToken : market.longToken;
        if (otherToken != pnlToken) {
            injectedUsd += _injectFromBucket(dataStore, eventEmitter, vault, market, prices, otherToken, orderKey, triggerFactor);
        }

        // Shortfall check against post-injection state. Reported in pnlToken
        // units to match the original request: requested is the entry-state
        // gap, paid is the portion of it the buckets actually covered.
        {
            (uint256 drawdownAfter, uint256 currentValue, uint256 epochValue) = getDrawdownFraction(dataStore, market, prices);
            // requestedTokens > 0 keeps the shortfall denominated in a meaningful pnlToken amount:
            // if the entry gap rounded to zero pnlToken units there is nothing to report against
            // (any residual is sub-one-unit dust), so we skip the otherwise requested==0 event.
            if (drawdownAfter > triggerFactor && requestedTokens > 0) {
                uint256 stillMissingTokens = _computeRequestedInjection(
                    market,
                    prices,
                    pnlToken,
                    currentValue,
                    epochValue,
                    triggerFactor
                );
                InsuranceFundEventUtils.emitInsuranceFundShortfall(
                    eventEmitter,
                    market.marketToken,
                    pnlToken,
                    orderKey,
                    requestedTokens,
                    requestedTokens > stillMissingTokens ? requestedTokens - stillMissingTokens : 0
                );
            }
        }
    }

    // @dev Draws from a single (market, token) reserve bucket: recomputes
    // the outstanding gap from current state (so a preceding bucket's
    // injection is accounted for), transfers up to the bucket balance from
    // the vault into MarketToken, and credits that token's pool side.
    //
    // Returns the injected value in USD (FLOAT_PRECISION scale), 0 when the
    // bucket is empty or drawdown is already back at/below the trigger.
    function _injectFromBucket(
        DataStore dataStore,
        EventEmitter eventEmitter,
        InsuranceVault vault,
        Market.Props memory market,
        MarketUtils.MarketPrices memory prices,
        address token,
        bytes32 orderKey,
        uint256 triggerFactor
    ) private returns (uint256) {
        uint256 reserveBalance = dataStore.getUint(Keys.insuranceFundBalanceKey(market.marketToken, token));
        if (reserveBalance == 0) {
            return 0;
        }

        uint256 injectedAmount;
        uint256 drawdownBefore;
        {
            (uint256 _drawdownBefore, uint256 currentValue, uint256 epochValue) = getDrawdownFraction(dataStore, market, prices);
            if (_drawdownBefore <= triggerFactor) {
                return 0;
            }
            drawdownBefore = _drawdownBefore;
            uint256 requestedTokens = _computeRequestedInjection(
                market,
                prices,
                token,
                currentValue,
                epochValue,
                triggerFactor
            );
            injectedAmount = requestedTokens > reserveBalance ? reserveBalance : requestedTokens;
        }
        if (injectedAmount == 0) {
            return 0;
        }

        // Physical move vault → marketToken. The vault's _afterTransferOut
        // hook (StrictBank) re-syncs its tokenBalances mapping.
        vault.transferOut(token, market.marketToken, injectedAmount);

        // Pool accounting credit. Also tweaks virtual swap inventory as a
        // side-effect inside applyDeltaToPoolAmount — see review §1.6.
        uint256 newPoolAmount = MarketUtils.applyDeltaToPoolAmount(
            dataStore,
            eventEmitter,
            market,
            token,
            injectedAmount.toInt256()
        );

        // Decrement the reserve bucket.
        uint256 newReserveBalance = dataStore.applyDeltaToUint(
            Keys.insuranceFundBalanceKey(market.marketToken, token),
            -injectedAmount.toInt256(),
            "Invalid state, negative insurance reserve"
        );

        // Recompute drawdown post-injection for the event payload. Cheaper
        // alternatives exist (subtract injectedAmount*price/epochValue from
        // drawdownBefore) but a fresh read is robust against any concurrent
        // pool-amount changes within this tx.
        (uint256 drawdownAfter, , ) = getDrawdownFraction(dataStore, market, prices);

        InsuranceFundEventUtils.emitInsuranceFundInjection(
            eventEmitter,
            market.marketToken,
            token,
            orderKey,
            injectedAmount,
            newPoolAmount,
            newReserveBalance,
            drawdownBefore,
            drawdownAfter
        );

        return injectedAmount * MarketUtils.getCachedTokenPrice(token, market, prices).min;
    }

    // @dev Compute the number of `token` units needed to bring drawdown
    // back to threshold. Extracted from the injection path so the
    // intermediate locals (target, missing, tokenPrice) don't pin slots
    // on the caller's stack — stack-too-deep otherwise.
    function _computeRequestedInjection(
        Market.Props memory market,
        MarketUtils.MarketPrices memory prices,
        address token,
        uint256 currentValue,
        uint256 epochValue,
        uint256 triggerFactor
    ) private pure returns (uint256) {
        uint256 targetCurrentValue = Precision.applyFactor(
            epochValue,
            Precision.FLOAT_PRECISION - triggerFactor
        );
        // drawdown > triggerFactor (caller checked) ⇒ currentValue < targetCurrentValue.
        uint256 missingUsd = targetCurrentValue - currentValue;

        // Use tokenPrice.min so we slightly over-inject (LP-favorable rounding).
        Price.Props memory tokenPrice = MarketUtils.getCachedTokenPrice(token, market, prices);
        return missingUsd / tokenPrice.min;
    }

    // ---------------------------------------------------------------------
    // Epoch lifecycle
    // ---------------------------------------------------------------------

    // @dev Snapshots the current pool USD (excluding unrealized PnL) as the
    // baseline for the next epoch's drawdown calculation, and stamps the
    // epoch-start timestamp.
    //
    // Idempotency / freshness is the caller's concern — SettlementHandler
    // enforces an epoch-length gap. This function unconditionally writes.
    function snapshotEpoch(
        DataStore dataStore,
        EventEmitter eventEmitter,
        Market.Props memory market,
        MarketUtils.MarketPrices memory prices
    ) external returns (uint256 epochValue) {
        // minimize=false matches getDrawdownFraction's call so both sides
        // use the same price-pick rule. (Snapshot pick must match current
        // pick or drawdown will mis-fire.)
        int256 poolValue = MarketUtils.getPoolValueExcludingUnrealizedPnl(dataStore, market, prices, false);
        epochValue = poolValue < 0 ? 0 : uint256(poolValue);

        dataStore.setUint(Keys.insuranceFundEpochPoolValueKey(market.marketToken), epochValue);
        // ZEROMARK-54: snapshot the share supply alongside the pool value so getDrawdownFraction can
        // measure the decline per-share. Pairing is essential — a pool-value snapshot without its
        // matching supply would mis-scale every subsequent drawdown.
        dataStore.setUint(
            Keys.insuranceFundEpochSupplyKey(market.marketToken),
            MarketToken(payable(market.marketToken)).totalSupply()
        );
        dataStore.setUint(Keys.insuranceFundEpochStartKey(market.marketToken), block.timestamp);

        InsuranceFundEventUtils.emitInsuranceFundEpochReset(
            eventEmitter,
            market.marketToken,
            epochValue,
            block.timestamp
        );
    }
}
