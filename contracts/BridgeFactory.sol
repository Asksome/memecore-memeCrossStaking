// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./BridgeWrappedToken.sol";

contract BridgeFactory is Ownable {
    using Clones for address;

    address public immutable tokenImplementation;

    mapping(bytes32 => address) public solMintToWrapped;
    mapping(bytes32 => uint8) public solMintDecimals;

    event WrappedTokenDeployed(
        bytes32 indexed solMintHash,
        string solanaMint,
        address wrappedToken,
        string name,
        string symbol
    );

    event BridgedFromSolana(
        bytes32 indexed solMintHash,
        string solanaMint,
        address indexed wrappedToken,
        address indexed to,
        uint256 amount
    );

    constructor(address _tokenImplementation) Ownable(msg.sender) {
        require(_tokenImplementation != address(0), "BridgeFactory: zero impl");
        tokenImplementation = _tokenImplementation;
    }

    function getWrappedToken(bytes32 solMintHash) external view returns (address) {
        return solMintToWrapped[solMintHash];
    }

    function mintFromSolana(
        bytes32 solMintHash,
        string calldata solanaMint,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address to,
        uint256 amount
    ) external onlyOwner returns (address wrapped) {
        require(to != address(0), "BridgeFactory: zero recipient");
        require(amount > 0, "BridgeFactory: zero amount");

        wrapped = solMintToWrapped[solMintHash];

        if (wrapped == address(0)) {
            wrapped = tokenImplementation.clone();
            BridgeWrappedToken(wrapped).initialize(
                name,
                symbol,
                solanaMint,
                decimals,
                address(this),
                owner()
            );

            solMintToWrapped[solMintHash] = wrapped;
            solMintDecimals[solMintHash] = decimals;

            emit WrappedTokenDeployed(
                solMintHash,
                solanaMint,
                wrapped,
                name,
                symbol
            );
        } else {
            require(
                decimals == solMintDecimals[solMintHash],
                "BridgeFactory: decimals mismatch"
            );
        }

        BridgeWrappedToken(wrapped).mint(to, amount);

        emit BridgedFromSolana(
            solMintHash,
            solanaMint,
            wrapped,
            to,
            amount
        );
    }

    function burnForSolana(
        bytes32 solMintHash,
        address from,
        uint256 amount
    ) external onlyOwner {
        address wrapped = solMintToWrapped[solMintHash];
        require(wrapped != address(0), "BridgeFactory: unknown mint");
        require(from != address(0), "BridgeFactory: zero from");
        require(amount > 0, "BridgeFactory: zero amount");

        BridgeWrappedToken(wrapped).burn(from, amount);
    }
}