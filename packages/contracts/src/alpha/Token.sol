// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract LSAN is Initializable, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable, ERC20Upgradeable {
    uint256 public maticPerByte;
    uint256 public totalBytesStored;
    uint256 public multiplier;
    uint256 public minimumDeposit;
    address public nodeManagerAddress;
    address payable public SAFE_ADDRESS;
    uint256 public DEPLOYED_TIME;
    uint256 public treasury;
    mapping(address => bool) public whitelistedSenders;
    mapping(address => bool) public whitelistedRecipients;

    modifier onlySafe() {
        require(msg.sender == SAFE_ADDRESS);
        _;
    }

    modifier onlyWhitelistedSender(address destinationAddress) {
        require(
            destinationAddress != nodeManagerAddress || whitelistedSenders[msg.sender],
            "User is not whitelisted to transfer to the address"
        );
        _;
    }

    modifier onlyWhitelistedRecipient(address destinationAddress) {
        require(
            destinationAddress != nodeManagerAddress || whitelistedRecipients[msg.sender],
            "User is not whitelisted to transferFrom this address"
        );
        _;
    }

    /// @dev required by the OZ UUPS module
    function _authorizeUpgrade(address) internal override onlyOwner {}

    function initialize(
        address[] memory initialWhitelist,
        address _safeAddress,
        address _nodeManagerAddress
    ) public initializer {
        __Ownable_init();
        __ERC20_init("Logstore Alpha Network Token", "LSAN");
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        // go through the initial whitelist and whitelist appropriately
        uint256 whitelistLength = initialWhitelist.length;
        for (uint256 i = 0; i < whitelistLength; i++) {
            whitelistSender(initialWhitelist[i]);
            whitelistRecipient(initialWhitelist[i]);
        }

        SAFE_ADDRESS = payable(_safeAddress);
        DEPLOYED_TIME = block.timestamp;
        nodeManagerAddress = _nodeManagerAddress;
        multiplier = 1;
        minimumDeposit = 0;
    }

    // ---------- Admin functions
    function mintTokens(address account, uint256 amount) public onlyOwner {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public onlyOwner {
        _burn(account, amount);
    }

    // Whitelist an address who can transfer this token to the node manager contract
    function whitelistSender(address account) public onlyOwner {
        require(!whitelistedSenders[account], "Address already whitelisted as sender");
        whitelistedSenders[account] = true;
    }

    // whitelist an address who can transfer this token to the node manager contract
    function whitelistRecipient(address account) public onlyOwner {
        require(!whitelistedRecipients[account], "Account already whitelisted as recipient");
        whitelistedRecipients[account] = true;
    }

    function withdraw(uint256 amount) public onlyOwner {
        require(address(this).balance >= amount, "Insufficient contract balance");
        treasury = treasury - amount;
        SAFE_ADDRESS.transfer(amount);
    }

    function setMaticPerByte(uint256 _maticPerByte) public onlyOwner {
        maticPerByte = _maticPerByte;
    }

    function setTotalBytesStored(uint256 _totalBytesStored) public onlyOwner {
        totalBytesStored = _totalBytesStored;
    }

    function setMultipler(uint256 _multiplier) public onlyOwner {
        multiplier = _multiplier;
    }

    function setNodeManagerAddress(address _nodeManagerAddress) public onlyOwner {
        nodeManagerAddress = _nodeManagerAddress;
    }

    function setMinimumDeposit(uint _minimumDeposit) public onlyOwner {
        minimumDeposit = _minimumDeposit;
    }

    // ---------- Admin functions

    // ---------- Safe functions
    function destroy() public onlySafe {
        // ? self desctruct is getting deprecated so find alternative
        // selfdestruct(SAFE_ADDRESS);
    }

    // ---------- Safe functions

    // ---------- Public methods
    function getTokenPrice() public view returns (uint256 lsanPrice) {
        uint totalExpense = maticPerByte * totalBytesStored;
        uint timeSinceStart = block.timestamp - DEPLOYED_TIME;
        uint totalExpensePerDay = (totalExpense / (timeSinceStart * 24 * 60 * 60 * 1000));
        lsanPrice = totalExpensePerDay * multiplier;
    }

    function mint() public payable nonReentrant {
        require(msg.value > minimumDeposit, "sent amount less than minimum amount");
        require(maticPerByte > 0, "maticPerByte <= 0");
        require(totalBytesStored > 0, "totalBytesStored <= 0");

        uint lsanPrice = getTokenPrice();
        uint mintAmount = msg.value / lsanPrice;
        treasury += msg.value;

        _mint(msg.sender, mintAmount);
    }

    // ---------- Public methods

    // ---------- Override methods
    function transfer(address _to, uint256 _amount) public override onlyWhitelistedSender(_to) returns (bool) {
        // and the recipient has been whitelisted
        address owner = msg.sender;
        _transfer(owner, _to, _amount);

        return true;
    }

    function transferFrom(
        address _from,
        address _to,
        uint256 amount
    ) public override onlyWhitelistedRecipient(_from) onlyWhitelistedSender(_to) returns (bool) {
        address spender = msg.sender;
        _spendAllowance(_from, spender, amount);
        _transfer(_from, _to, amount);
        return true;
    }

    // ---------- Override methods
}
