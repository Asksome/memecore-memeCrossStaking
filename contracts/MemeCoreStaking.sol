// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWrappedToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

contract MemeCoreStaking is Ownable, ReentrancyGuard {
    IWrappedToken public mxToken;

    struct StakerInfo {
        uint256 stakedAmount;
        uint256 stakedValueUSD;
        uint256 lastClaimTime;
        uint256 accumulatedRewards;
        uint256 rewardDebt;
        bool isUnstaking;
    }

    mapping(address => StakerInfo) public stakers;

    uint256 public totalStakedAmount;
    uint256 public currentTokenPriceUSD;
    uint256 public rewardPerShare;
    uint256 public lastRewardDate;

    event Staked(address indexed user, uint256 amount, uint256 currentPrice);
    event UnstakeRequested(address indexed user, uint256 amount);
    event RewardsDistributed(uint256 totalReward, uint256 date);
    event PriceUpdated(uint256 newPrice, uint256 timestamp);

    constructor(address _mxToken) Ownable(msg.sender) {
        mxToken = IWrappedToken(_mxToken);
    }

    function updatePrice(uint256 _priceUSD) external onlyOwner {
        currentTokenPriceUSD = _priceUSD;
        emit PriceUpdated(_priceUSD, block.timestamp);
    }

    function distributeDailyRewards() external payable onlyOwner {
        require(msg.value > 0, "No rewards provided");
        require(totalStakedAmount > 0, "No stakers");

        rewardPerShare += (msg.value * 1e18) / totalStakedAmount;
        lastRewardDate = block.timestamp;

        emit RewardsDistributed(msg.value, block.timestamp);
    }

    function stake(uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be > 0");
        _updateUserReward(msg.sender);

        mxToken.transferFrom(msg.sender, address(this), _amount);

        StakerInfo storage user = stakers[msg.sender];
        user.stakedAmount += _amount;
        user.stakedValueUSD = (user.stakedAmount * currentTokenPriceUSD) / 1e8;
        user.isUnstaking = false;

        totalStakedAmount += _amount;
        user.rewardDebt = (user.stakedAmount * rewardPerShare) / 1e18;

        emit Staked(msg.sender, _amount, currentTokenPriceUSD);
    }

    function requestUnstake() external nonReentrant {
        StakerInfo storage user = stakers[msg.sender];
        require(user.stakedAmount > 0, "Nothing to unstake");

        _updateUserReward(msg.sender);

        uint256 amount = user.stakedAmount;
        user.stakedAmount = 0;
        totalStakedAmount -= amount;
        user.isUnstaking = true;
        user.rewardDebt = 0;

        mxToken.transfer(msg.sender, amount);

        emit UnstakeRequested(msg.sender, amount);
    }

    function claimRewards() external nonReentrant {
        _updateUserReward(msg.sender);

        StakerInfo storage user = stakers[msg.sender];
        uint256 reward = user.accumulatedRewards;
        require(reward > 0, "No rewards");

        user.accumulatedRewards = 0;
        user.lastClaimTime = block.timestamp;

        (bool sent, ) = payable(msg.sender).call{value: reward}("");
        require(sent, "Failed to send reward");
    }

    function _updateUserReward(address _user) internal {
        StakerInfo storage user = stakers[_user];
        if (user.stakedAmount == 0) {
            user.rewardDebt = 0;
            return;
        }

        uint256 accumulated = (user.stakedAmount * rewardPerShare) / 1e18;
        uint256 pending = accumulated - user.rewardDebt;

        if (pending > 0) {
            user.accumulatedRewards += pending;
        }

        user.rewardDebt = accumulated;
        user.lastClaimTime = block.timestamp;
    }

    function getStakerData(address _user)
        external
        view
        returns (
            uint256 amount,
            uint256 valueUSD,
            uint256 pendingReward,
            uint256 accumulatedReward
        )
    {
        StakerInfo memory user = stakers[_user];
        uint256 currentValueUSD = (user.stakedAmount * currentTokenPriceUSD) / 1e8;
        uint256 _pending = 0;

        if (user.stakedAmount > 0) {
            uint256 accumulated = (user.stakedAmount * rewardPerShare) / 1e18;
            _pending = accumulated - user.rewardDebt;
        }

        return (
            user.stakedAmount,
            currentValueUSD,
            _pending,
            user.accumulatedRewards
        );
    }
}