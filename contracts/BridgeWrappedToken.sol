// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract BridgeWrappedToken is ERC20, Ownable {
    address public bridge;
    string public solanaMint;
    
    string private _customName;
    string private _customSymbol;
    uint8 private _customDecimals;
    bool private _initialized;

    event BridgeUpdated(address indexed newBridge);

    modifier onlyBridge() {
        require(msg.sender == bridge, "BridgeWrappedToken: caller is not bridge");
        _;
    }

    constructor() ERC20("", "") Ownable(msg.sender) {}

    function initialize(
        string memory name_,
        string memory symbol_,
        string memory solanaMint_,
        uint8 decimals_,
        address bridge_,
        address owner_
    ) external {
        require(!_initialized, "BridgeWrappedToken: already initialized");
        require(bridge_ != address(0), "BridgeWrappedToken: zero bridge");
        require(owner_ != address(0), "BridgeWrappedToken: zero owner");

        _initialized = true;
        _customName = name_;
        _customSymbol = symbol_;
        _customDecimals = decimals_;
        solanaMint = solanaMint_;
        bridge = bridge_;

        _transferOwnership(owner_);
        emit BridgeUpdated(bridge_);
    }

    function name() public view override returns (string memory) {
        return _customName;
    }

    function symbol() public view override returns (string memory) {
        return _customSymbol;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }
}