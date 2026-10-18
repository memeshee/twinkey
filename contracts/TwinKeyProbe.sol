// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TwinKeyProbe
/// @notice Tiny state machine used to prove that one Portaldot account can drive a
///         contract from *both* runtimes (native `revive.call` and the EVM layer) and
///         that both paths agree on state, events and value.
///         Deliberately small: the interest is in the caller identity, not the logic.
contract TwinKeyProbe {
    uint256 public value;
    address public lastCaller;
    uint256 public callCount;

    event ValueSet(address indexed caller, uint256 indexed value, uint256 callCount);
    event ValueAdded(address indexed caller, uint256 amount, uint256 newValue);

    function setValue(uint256 v) external {
        value = v;
        lastCaller = msg.sender;
        callCount += 1;
        emit ValueSet(msg.sender, v, callCount);
    }

    function addValue(uint256 amount) external payable returns (uint256) {
        value += amount;
        lastCaller = msg.sender;
        callCount += 1;
        emit ValueAdded(msg.sender, amount, value);
        return value;
    }

    function read() external view returns (uint256, address, uint256) {
        return (value, lastCaller, callCount);
    }
}
