pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ReFiConservationDAOFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60; // Default 1 minute cooldown

    bool public paused;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;
    mapping(uint256 => euint32) public encryptedProjectScoreSum;
    mapping(uint256 => euint32) public encryptedVoteCount;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event ProjectSubmitted(address indexed provider, uint256 batchId, bytes32 encryptedScore);
    event VoteSubmitted(address indexed provider, uint256 batchId, bytes32 encryptedVote);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint32 scoreSum, uint32 voteCount);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchClosedForSubmissions();
    error InvalidBatch();
    error ReplayDetected();
    error StateMismatch();
    error DecryptionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        emit BatchOpened(currentBatchId);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) public onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) public onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        if (!paused) revert PausedState(); // Cannot unpause if not paused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openNewBatch() public onlyOwner {
        currentBatchId++;
        // Ensure new batch is not marked as closed
        batchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() public onlyOwner {
        if (batchClosed[currentBatchId]) revert BatchClosedForSubmissions();
        batchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function submitProjectScore(uint256 batchId, euint32 encryptedScore) public onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (batchClosed[batchId]) revert BatchClosedForSubmissions();

        _initIfNeeded(batchId);

        encryptedProjectScoreSum[batchId] = encryptedProjectScoreSum[batchId].add(encryptedScore);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ProjectSubmitted(msg.sender, batchId, FHE.toBytes32(encryptedScore));
    }

    function submitVote(uint256 batchId, euint32 encryptedVoteValue) public onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId != currentBatchId) revert InvalidBatch();
        if (batchClosed[batchId]) revert BatchClosedForSubmissions();

        _initIfNeeded(batchId);

        // encryptedVoteValue is expected to be 1 for a "yes" vote, 0 for "no" or abstain.
        // This adds the vote value to the sum.
        encryptedProjectScoreSum[batchId] = encryptedProjectScoreSum[batchId].add(encryptedVoteValue);
        encryptedVoteCount[batchId] = encryptedVoteCount[batchId].add(FHE.asEuint32(1)); // Increment count by 1

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit VoteSubmitted(msg.sender, batchId, FHE.toBytes32(encryptedVoteValue));
    }

    function requestBatchResultDecryption(uint256 batchId) public onlyProvider whenNotPaused checkDecryptionCooldown {
        if (!batchClosed[batchId]) revert InvalidBatch(); // Batch must be closed for decryption

        _initIfNeeded(batchId); // Ensure batch state is initialized

        // 1. Prepare Ciphertexts
        euint32[] memory ctsArray = new euint32[](2);
        ctsArray[0] = encryptedProjectScoreSum[batchId];
        ctsArray[1] = encryptedVoteCount[batchId];

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(ctsArray[0]);
        cts[1] = FHE.toBytes32(ctsArray[1]);

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // a. Replay Guard
        if (ctx.processed) revert ReplayDetected();

        // b. State Verification
        // Rebuild cts array in the exact same order as in requestBatchResultDecryption
        euint32[] memory ctsArray = new euint32[](2);
        ctsArray[0] = encryptedProjectScoreSum[ctx.batchId];
        ctsArray[1] = encryptedVoteCount[ctx.batchId];

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(ctsArray[0]);
        cts[1] = FHE.toBytes32(ctsArray[1]);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert DecryptionFailed();
        }

        // d. Decode & Finalize
        uint32 scoreSum = abi.decode(cleartexts[0:32], (uint32));
        uint32 voteCount = abi.decode(cleartexts[32:64], (uint32));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, scoreSum, voteCount);
        // Further actions with decrypted results (e.g., funding distribution) would go here
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(uint256 batchId) internal {
        if (!_isInitialized(batchId)) {
            encryptedProjectScoreSum[batchId] = FHE.asEuint32(0);
            encryptedVoteCount[batchId] = FHE.asEuint32(0);
        }
    }

    function _isInitialized(uint256 batchId) internal view returns (bool) {
        return FHE.isInitialized(encryptedProjectScoreSum[batchId]) && FHE.isInitialized(encryptedVoteCount[batchId]);
    }
}