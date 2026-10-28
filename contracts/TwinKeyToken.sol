// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TwinKeyToken
/// @notice A deliberately small ERC-20 used to show that the signer works on
///         something with real semantics: balances, allowances and Transfer logs,
///         not a number in a storage slot.
///
///         It matters what this proves. A Portaldot account's SS58 key signs the
///         `revive.call` that mints and transfers; a standard ERC-20 interface
///         reads the result over the EVM JSON-RPC; and the log that gets decoded
///         back is the ordinary `Transfer` topic every indexer already understands.
///         Note the decimal split: this token is 18 decimals (ERC-20 convention)
///         while native tPOT is 14 — conflating them is a 10,000x error, so the UI
///         shows both denominators explicitly.
contract TwinKeyToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotOwner(address caller);
    error InsufficientBalance(address from, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowed, uint256 needed);
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        _mint(msg.sender, initialSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(msg.sender, allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Demo mint. Owner-only, because an open mint makes the balance
    ///         meaningless and this contract is meant to demonstrate real
    ///         semantics rather than convenient ones.
    function mint(address to, uint256 value) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _mint(to, value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance(from, balance, value);
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }
}
