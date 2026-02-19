// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "./interfaces/IX402StateChannel.sol";
import "./interfaces/IERC20.sol";
import "@openzeppelin/contracts/cryptography/ECDSA.sol";

contract X402StateChannel is IX402StateChannel {
    using ECDSA for bytes32;

    struct Channel {
        address participantA;
        address participantB;
        address asset;
        uint64 challengePeriodSec;
        uint64 channelExpiry;
        uint256 totalBalance;
        bool isClosing;
        uint64 closeDeadline;
        uint64 latestNonce;
        uint256 closeBalA;
        uint256 closeBalB;
    }

    mapping(bytes32 => Channel) private _channels;

    function openChannel(
        address participantB,
        address asset,
        uint256 amount,
        uint64 challengePeriodSec,
        uint64 channelExpiry,
        bytes32 salt
    ) external payable override returns (bytes32 channelId) {
        require(participantB != address(0), "SCP: bad participantB");
        require(challengePeriodSec > 0, "SCP: bad challenge");
        require(channelExpiry > block.timestamp, "SCP: bad expiry");

        uint256 chainId;
        assembly {
            chainId := chainid()
        }

        channelId = keccak256(
            abi.encode(chainId, address(this), msg.sender, participantB, asset, salt)
        );
        require(_channels[channelId].participantA == address(0), "SCP: exists");

        _channels[channelId] = Channel({
            participantA: msg.sender,
            participantB: participantB,
            asset: asset,
            challengePeriodSec: challengePeriodSec,
            channelExpiry: channelExpiry,
            totalBalance: 0,
            isClosing: false,
            closeDeadline: 0,
            latestNonce: 0,
            closeBalA: 0,
            closeBalB: 0
        });

        if (amount > 0) {
            _collectAsset(asset, msg.sender, amount);
            _channels[channelId].totalBalance = amount;
        } else {
            require(msg.value == 0, "SCP: unexpected value");
        }

        emit ChannelOpened(
            channelId,
            msg.sender,
            participantB,
            asset,
            challengePeriodSec,
            channelExpiry
        );
    }

    function deposit(bytes32 channelId, uint256 amount) external payable override {
        Channel storage ch = _channels[channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(!ch.isClosing, "SCP: closing");
        require(block.timestamp < ch.channelExpiry, "SCP: expired");
        require(
            msg.sender == ch.participantA || msg.sender == ch.participantB,
            "SCP: not participant"
        );
        require(amount > 0, "SCP: zero amount");

        _collectAsset(ch.asset, msg.sender, amount);
        ch.totalBalance = ch.totalBalance + amount;

        emit Deposited(channelId, msg.sender, amount, ch.totalBalance);
    }

    function cooperativeClose(
        ChannelState calldata st,
        bytes calldata sigA,
        bytes calldata sigB
    ) external override {
        Channel storage ch = _channels[st.channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(!_isStateExpired(st), "SCP: state expired");
        _validateState(ch, st, false);

        bytes32 digest = _toEthSignedMessage(hashState(st));
        require(digest.recover(sigA) == ch.participantA, "SCP: bad sigA");
        require(digest.recover(sigB) == ch.participantB, "SCP: bad sigB");

        _finalizeWithState(ch, st);
        emit ChannelClosed(st.channelId, st.stateNonce, st.balA, st.balB);
    }

    function startClose(
        ChannelState calldata st,
        bytes calldata sigFromCounterparty
    ) external override {
        Channel storage ch = _channels[st.channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(!_isStateExpired(st), "SCP: state expired");
        require(
            msg.sender == ch.participantA || msg.sender == ch.participantB,
            "SCP: not participant"
        );
        _validateState(ch, st, true);

        bytes32 digest = _toEthSignedMessage(hashState(st));
        if (msg.sender == ch.participantA) {
            require(
                digest.recover(sigFromCounterparty) == ch.participantB,
                "SCP: bad counter sig"
            );
        } else {
            require(
                digest.recover(sigFromCounterparty) == ch.participantA,
                "SCP: bad counter sig"
            );
        }

        ch.isClosing = true;
        ch.closeDeadline = uint64(block.timestamp + ch.challengePeriodSec);
        ch.latestNonce = st.stateNonce;
        ch.closeBalA = st.balA;
        ch.closeBalB = st.balB;

        emit CloseStarted(st.channelId, st.stateNonce, ch.closeDeadline, hashState(st));
    }

    function challenge(
        ChannelState calldata newer,
        bytes calldata sigFromCounterparty
    ) external override {
        Channel storage ch = _channels[newer.channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(ch.isClosing, "SCP: not closing");
        require(block.timestamp <= ch.closeDeadline, "SCP: deadline passed");
        require(!_isStateExpired(newer), "SCP: state expired");
        require(
            msg.sender == ch.participantA || msg.sender == ch.participantB,
            "SCP: not participant"
        );
        require(newer.stateNonce > ch.latestNonce, "SCP: stale nonce");
        _validateState(ch, newer, false);

        bytes32 digest = _toEthSignedMessage(hashState(newer));
        if (msg.sender == ch.participantA) {
            require(
                digest.recover(sigFromCounterparty) == ch.participantB,
                "SCP: bad counter sig"
            );
        } else {
            require(
                digest.recover(sigFromCounterparty) == ch.participantA,
                "SCP: bad counter sig"
            );
        }

        ch.latestNonce = newer.stateNonce;
        ch.closeBalA = newer.balA;
        ch.closeBalB = newer.balB;

        emit Challenged(newer.channelId, newer.stateNonce, hashState(newer));
    }

    function finalizeClose(bytes32 channelId) external override {
        Channel storage ch = _channels[channelId];
        require(ch.participantA != address(0), "SCP: not found");
        require(ch.isClosing, "SCP: not closing");
        require(block.timestamp > ch.closeDeadline, "SCP: challenge open");

        uint64 finalNonce = ch.latestNonce;
        uint256 payoutA = ch.closeBalA;
        uint256 payoutB = ch.closeBalB;

        address asset = ch.asset;
        address participantA = ch.participantA;
        address participantB = ch.participantB;

        delete _channels[channelId];

        _payoutAsset(asset, participantA, payoutA);
        _payoutAsset(asset, participantB, payoutB);

        emit ChannelClosed(channelId, finalNonce, payoutA, payoutB);
    }

    function getChannel(bytes32 channelId)
        external
        view
        override
        returns (ChannelParams memory params)
    {
        Channel storage ch = _channels[channelId];
        params = ChannelParams({
            participantA: ch.participantA,
            participantB: ch.participantB,
            asset: ch.asset,
            challengePeriodSec: ch.challengePeriodSec,
            channelExpiry: ch.channelExpiry,
            totalBalance: ch.totalBalance,
            isClosing: ch.isClosing,
            closeDeadline: ch.closeDeadline,
            latestNonce: ch.latestNonce
        });
    }

    function hashState(ChannelState calldata st) public pure override returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    st.channelId,
                    st.stateNonce,
                    st.balA,
                    st.balB,
                    st.locksRoot,
                    st.stateExpiry,
                    st.contextHash
                )
            );
    }

    function _validateState(
        Channel storage ch,
        ChannelState calldata st,
        bool allowSameNonce
    ) internal view {
        require(st.balA + st.balB == ch.totalBalance, "SCP: bad balances");
        if (allowSameNonce) {
            require(st.stateNonce >= ch.latestNonce, "SCP: stale nonce");
        } else {
            require(st.stateNonce > ch.latestNonce, "SCP: stale nonce");
        }
    }

    function _isStateExpired(ChannelState calldata st) internal view returns (bool) {
        if (st.stateExpiry == 0) {
            return false;
        }
        return block.timestamp > st.stateExpiry;
    }

    function _toEthSignedMessage(bytes32 digest) internal pure returns (bytes32) {
        return digest.toEthSignedMessageHash();
    }

    function _collectAsset(
        address asset,
        address from,
        uint256 amount
    ) internal {
        if (asset == address(0)) {
            require(msg.value == amount, "SCP: bad msg.value");
        } else {
            require(msg.value == 0, "SCP: no eth");
            require(IERC20(asset).transferFrom(from, address(this), amount), "SCP: transferFrom");
        }
    }

    function _payoutAsset(
        address asset,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) {
            return;
        }

        if (asset == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "SCP: eth payout");
        } else {
            require(IERC20(asset).transfer(to, amount), "SCP: erc20 payout");
        }
    }

    function _finalizeWithState(Channel storage ch, ChannelState calldata st) internal {
        address asset = ch.asset;
        address participantA = ch.participantA;
        address participantB = ch.participantB;

        delete _channels[st.channelId];

        _payoutAsset(asset, participantA, st.balA);
        _payoutAsset(asset, participantB, st.balB);
    }
}
