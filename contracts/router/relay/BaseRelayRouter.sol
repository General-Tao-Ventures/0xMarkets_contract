// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-v4/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts-v4/security/ReentrancyGuard.sol";

import "../../data/DataStore.sol";
import "../../event/EventEmitter.sol";
import "../../exchange/IOrderHandler.sol";
import "../../feature/FeatureUtils.sol";
import "../../oracle/OracleModule.sol";
import "../../order/IBaseOrderUtils.sol";
import "../../order/OrderStoreUtils.sol";
import "../../order/OrderVault.sol";
import "../../role/RoleModule.sol";
import "../../subaccount/SubaccountUtils.sol";
import "../../router/Router.sol";
import "../../token/TokenUtils.sol";

// Relay router for orders signed by the user and submitted by our own relayer, so the user needs no
// native token. This is the Gelato relay router with the third party removed: the caller is gated on
// RELAY_KEEPER instead of Gelato's immutable relay address.
//
// The fee model is also simpler than Gelato's. Gelato requires its fee in WNT, so it swaps the user's
// fee token through a GMX pool to get there. Every market here is USDC/USDC, so no such pool exists.
// Instead the relayer funds the WNT execution fee out of its own float and takes the user's fee token
// directly, which removes the swap, the oracle dependency in the fee path, and the external calls.
abstract contract BaseRelayRouter is RoleModule, ReentrancyGuard, OracleModule {
    using Order for Order.Props;

    struct TokenPermit {
        address owner;
        address spender;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
        address token;
    }

    // feeAmount is the most of feeToken the user agrees to pay the relayer for this call. It is part
    // of the signed struct hash, so the relayer cannot raise it.
    struct FeeParams {
        address feeToken;
        uint256 feeAmount;
    }

    struct RelayParams {
        OracleUtils.SetPricesParams oracleParams;
        TokenPermit[] tokenPermits;
        FeeParams fee;
        uint256 userNonce;
        uint256 deadline;
        bytes signature;
    }

    // @note all params except account should be part of the corresponding struct hash
    struct UpdateOrderParams {
        uint256 sizeDeltaUsd;
        uint256 acceptablePrice;
        uint256 triggerPrice;
        uint256 minOutputAmount;
        uint256 validFromTime;
        bool autoCancel;
    }

    struct Contracts {
        DataStore dataStore;
        EventEmitter eventEmitter;
        OrderVault orderVault;
    }

    IOrderHandler public immutable orderHandler;
    OrderVault public immutable orderVault;
    Router public immutable router;
    DataStore public immutable dataStore;
    EventEmitter public immutable eventEmitter;

    bytes32 public constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256(bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));

    bytes32 public constant DOMAIN_SEPARATOR_NAME_HASH = keccak256(bytes("GmxBaseRelayRouter"));
    bytes32 public constant DOMAIN_SEPARATOR_VERSION_HASH = keccak256(bytes("1"));

    mapping(address => uint256) public userNonces;

    constructor(
        Router _router,
        RoleStore _roleStore,
        DataStore _dataStore,
        EventEmitter _eventEmitter,
        Oracle _oracle,
        IOrderHandler _orderHandler,
        OrderVault _orderVault
    ) RoleModule(_roleStore) OracleModule(_oracle) {
        orderHandler = _orderHandler;
        orderVault = _orderVault;
        router = _router;
        dataStore = _dataStore;
        eventEmitter = _eventEmitter;
    }

    function _validateSignature(
        bytes32 digest,
        bytes calldata signature,
        address expectedSigner,
        string memory signatureType
    ) internal pure {
        (address recovered, ECDSA.RecoverError error) = ECDSA.tryRecover(digest, signature);
        if (error != ECDSA.RecoverError.NoError || recovered != expectedSigner) {
            revert Errors.InvalidSignature(signatureType);
        }
    }

    function _createOrder(
        RelayParams calldata relayParams,
        address account,
        uint256 collateralDeltaAmount,
        uint256 executionFee,
        IBaseOrderUtils.CreateOrderParams memory params,
        bool isSubaccount
    ) internal returns (bytes32) {
        Contracts memory contracts = Contracts({
            dataStore: dataStore,
            eventEmitter: eventEmitter,
            orderVault: orderVault
        });

        // The execution fee is funded by the relayer, so the relayer sets it and the signed value is
        // overwritten. Leaving the signed value in force would let anyone name an arbitrary amount of
        // the relayer's WNT, cancel the order, and take the refund: the refund goes to the account,
        // and cancellationReceiver cannot be pointed at the relayer because it also receives the
        // collateral.
        params.numbers.executionFee = executionFee;

        _handleRelay(contracts, relayParams, account, address(contracts.orderVault), executionFee, isSubaccount);

        if (
            params.orderType == Order.OrderType.MarketSwap ||
            params.orderType == Order.OrderType.LimitSwap ||
            params.orderType == Order.OrderType.MarketIncrease ||
            params.orderType == Order.OrderType.LimitIncrease ||
            params.orderType == Order.OrderType.StopIncrease
        ) {
            _sendTokens(
                account,
                params.addresses.initialCollateralToken,
                address(contracts.orderVault),
                collateralDeltaAmount
            );
        }

        return
            orderHandler.createOrder(account, params, isSubaccount && params.addresses.callbackContract != address(0));
    }

    function _updateOrder(
        RelayParams calldata relayParams,
        address account,
        bytes32 key,
        UpdateOrderParams calldata params,
        uint256 executionFeeIncrease,
        bool isSubaccount
    ) internal {
        Contracts memory contracts = Contracts({
            dataStore: dataStore,
            eventEmitter: eventEmitter,
            orderVault: orderVault
        });

        Order.Props memory order = OrderStoreUtils.get(contracts.dataStore, key);

        if (order.account() == address(0)) {
            revert Errors.EmptyOrder();
        }

        if (order.account() != account) {
            revert Errors.Unauthorized(account, "updateOrder");
        }

        _handleRelay(
            contracts,
            relayParams,
            account,
            address(contracts.orderVault),
            executionFeeIncrease,
            isSubaccount
        );

        orderHandler.updateOrder(
            key,
            params.sizeDeltaUsd,
            params.acceptablePrice,
            params.triggerPrice,
            params.minOutputAmount,
            params.validFromTime,
            params.autoCancel,
            order,
            isSubaccount && order.callbackContract() != address(0) && executionFeeIncrease != 0
        );
    }

    function _cancelOrder(
        RelayParams calldata relayParams,
        address account,
        bytes32 key,
        bool isSubaccount
    ) internal {
        Contracts memory contracts = Contracts({
            dataStore: dataStore,
            eventEmitter: eventEmitter,
            orderVault: orderVault
        });

        Order.Props memory order = OrderStoreUtils.get(contracts.dataStore, key);
        if (order.account() == address(0)) {
            revert Errors.EmptyOrder();
        }

        if (order.account() != account) {
            revert Errors.Unauthorized(account, "cancelOrder");
        }

        _handleRelay(contracts, relayParams, account, address(0), 0, isSubaccount);

        orderHandler.cancelOrder(key);
    }

    function _handleRelay(
        Contracts memory contracts,
        RelayParams calldata relayParams,
        address account,
        address executionFeeReceiver,
        uint256 executionFee,
        bool isSubaccount
    ) internal {
        _handleTokenPermits(relayParams.tokenPermits);
        _collectRelayFee(contracts, account, relayParams.fee, isSubaccount);

        if (executionFee != 0) {
            // funded by the relayer, not the user, so the user never needs the native token
            _sendTokens(msg.sender, TokenUtils.wnt(contracts.dataStore), executionFeeReceiver, executionFee);
        }
    }

    // feeToken and feeAmount are covered by the signed struct hash, so the relayer can neither pick
    // the token nor raise the amount. For a subaccount that signature comes from the subaccount key
    // while the fee leaves the main account, so it is capped by value as well.
    function _collectRelayFee(
        Contracts memory contracts,
        address account,
        FeeParams calldata fee,
        bool isSubaccount
    ) internal {
        if (fee.feeAmount == 0) {
            return;
        }

        if (isSubaccount) {
            SubaccountUtils.validateRelayFeeSwap(contracts.dataStore, oracle, fee.feeToken, fee.feeAmount);
        }

        _sendTokens(account, fee.feeToken, msg.sender, fee.feeAmount);
    }

    function _handleTokenPermits(TokenPermit[] calldata tokenPermits) internal {
        // not all tokens support ERC20Permit, for them separate transaction is needed

        if (tokenPermits.length == 0) {
            return;
        }

        address _router = address(router);

        for (uint256 i; i < tokenPermits.length; i++) {
            TokenPermit memory permit = tokenPermits[i];

            if (permit.spender != _router) {
                // to avoid permitting spending by an incorrect spender for extra safety
                revert Errors.InvalidPermitSpender(permit.spender, _router);
            }

            try
                IERC20Permit(permit.token).permit(
                    permit.owner,
                    permit.spender,
                    permit.value,
                    permit.deadline,
                    permit.v,
                    permit.r,
                    permit.s
                )
            {} catch {}
        }
    }

    function _sendTokens(address account, address token, address receiver, uint256 amount) internal {
        AccountUtils.validateReceiver(receiver);
        router.pluginTransfer(token, account, receiver, amount);
    }

    function _getDomainSeparator(uint256 sourceChainId) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_SEPARATOR_TYPEHASH,
                    DOMAIN_SEPARATOR_NAME_HASH,
                    DOMAIN_SEPARATOR_VERSION_HASH,
                    sourceChainId,
                    address(this)
                )
            );
    }

    function _validateCall(RelayParams calldata relayParams, address account, bytes32 structHash) internal {
        bytes32 domainSeparator = _getDomainSeparator(block.chainid);
        bytes32 digest = ECDSA.toTypedDataHash(domainSeparator, structHash);
        _validateSignature(digest, relayParams.signature, account, "call");

        _validateNonce(account, relayParams.userNonce);
        _validateDeadline(relayParams.deadline);
    }

    function _validateDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) {
            revert Errors.DeadlinePassed(block.timestamp, deadline);
        }
    }

    function _validateNonce(address account, uint256 userNonce) internal {
        if (userNonces[account] != userNonce) {
            revert Errors.InvalidUserNonce(userNonces[account], userNonce);
        }
        userNonces[account] = userNonce + 1;
    }

    function _getRelayParamsHash(RelayParams calldata relayParams) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    relayParams.oracleParams,
                    relayParams.tokenPermits,
                    relayParams.fee,
                    relayParams.userNonce,
                    relayParams.deadline
                )
            );
    }

    function _validateGaslessFeature() internal view {
        FeatureUtils.validateFeature(dataStore, Keys.gaslessFeatureDisabledKey(address(this)));
    }
}
