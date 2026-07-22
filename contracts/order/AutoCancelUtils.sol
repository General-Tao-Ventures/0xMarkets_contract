// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../data/Keys.sol";
import "../data/DataStore.sol";
import "../error/Errors.sol";

library AutoCancelUtils {
    function addAutoCancelOrderKey(DataStore dataStore, bytes32 positionKey, bytes32 orderKey) internal {
        bytes32 listKey = Keys.autoCancelOrderListKey(positionKey);
        dataStore.addBytes32(listKey, orderKey);

        uint256 maxAutoCancelOrders = getMaxAutoCancelOrders(dataStore);
        uint256 count = dataStore.getBytes32Count(listKey);
        if (count > maxAutoCancelOrders) {
            revert Errors.MaxAutoCancelOrdersExceeded(count, maxAutoCancelOrders);
        }
    }

    function removeAutoCancelOrderKey(DataStore dataStore, bytes32 positionKey, bytes32 orderKey) internal {
        bytes32 listKey = Keys.autoCancelOrderListKey(positionKey);
        dataStore.removeBytes32(listKey, orderKey);
    }

    function getAutoCancelOrderKeys(DataStore dataStore, bytes32 positionKey) internal view returns (bytes32[] memory) {
        bytes32 listKey = Keys.autoCancelOrderListKey(positionKey);
        // Return the full stored list rather than the current MAX_AUTO_CANCEL_ORDERS prefix. Creation
        // is capped in addAutoCancelOrderKey; if that cap is later lowered, the stored list can exceed
        // it, and full-close cleanup must still cancel every attached order so none survives to execute
        // against a reopened position that reuses the same deterministic position key.
        uint256 count = dataStore.getBytes32Count(listKey);
        return dataStore.getBytes32ValuesAt(listKey, 0, count);
    }

    function getMaxAutoCancelOrders(DataStore dataStore) internal view returns (uint256) {
        return dataStore.getUint(Keys.MAX_AUTO_CANCEL_ORDERS);
    }
}
