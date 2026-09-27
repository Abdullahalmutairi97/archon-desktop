import asyncio
import json
import os
import socket
import stat

import pytest

from archon_server.local_pairing import (
    LOCAL_PAIRING_AUDIENCE,
    LocalPairingBroker,
    PairingPeer,
    PairingRejected,
    UnixSocketPairingServer,
)

SERVER_URL = "http://127.0.0.1:8787"


@pytest.mark.asyncio
async def test_unix_pairing_checks_peer_and_rejects_replayed_nonce(tmp_path):
    socket_path = tmp_path / "pairing.sock"
    broker = LocalPairingBroker(expected_uid=os.geteuid())
    server = UnixSocketPairingServer(socket_path, broker, server_url=SERVER_URL)
    await server.start()
    try:
        reader, writer = await asyncio.open_unix_connection(socket_path)
        writer.write(json.dumps({"op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE}).encode() + b"\n")
        await writer.drain()
        challenge_response = json.loads(await reader.readline())
        assert challenge_response["ok"] is True
        challenge = challenge_response["challenge"]
        assert challenge["audience"] == LOCAL_PAIRING_AUDIENCE
        assert challenge["expires_at"] > 0

        writer.write(json.dumps({
            "op": "redeem",
            "audience": LOCAL_PAIRING_AUDIENCE,
            "nonce": challenge["nonce"],
        }).encode() + b"\n")
        await writer.drain()
        credential_response = json.loads(await reader.readline())
        credential = credential_response["credential"]
        assert credential_response["ok"] is True
        assert credential["server_url"] == SERVER_URL
        assert broker.authenticate(credential["access_token"]) == credential["principal"]
        assert credential["principal"] == {
            "principal_id": f"local-uid:{os.geteuid()}",
            "uid": os.geteuid(),
            "auth_method": "unix-peer-credentials",
        }
        writer.close()
        await writer.wait_closed()

        replay_reader, replay_writer = await asyncio.open_unix_connection(socket_path)
        replay_writer.write(json.dumps({
            "op": "challenge", "audience": LOCAL_PAIRING_AUDIENCE,
        }).encode() + b"\n")
        await replay_writer.drain()
        assert json.loads(await replay_reader.readline())["ok"] is True
        replay_writer.write(json.dumps({
            "op": "redeem",
            "audience": LOCAL_PAIRING_AUDIENCE,
            "nonce": challenge["nonce"],
        }).encode() + b"\n")
        await replay_writer.drain()
        assert json.loads(await replay_reader.readline()) == {
            "ok": False, "error": "pairing_failed",
        }
        replay_writer.close()
        await replay_writer.wait_closed()
    finally:
        await server.close()
    assert broker.authenticate(credential["access_token"]) is None
    assert not socket_path.exists()


def test_pairing_challenge_has_fixed_audience_and_expires_once():
    now = {"mono": 10.0, "wall": 1000.0}
    broker = LocalPairingBroker(
        expected_uid=42,
        challenge_ttl_seconds=5,
        monotonic=lambda: now["mono"],
        wall_time=lambda: now["wall"],
    )
    peer = PairingPeer(pid=7, uid=42, gid=42)

    with pytest.raises(PairingRejected):
        broker.issue_challenge(peer, "wrong-audience")
    challenge = broker.issue_challenge(peer, LOCAL_PAIRING_AUDIENCE)
    now["mono"] += 6

    with pytest.raises(PairingRejected):
        broker.redeem(peer, LOCAL_PAIRING_AUDIENCE, challenge.nonce)
    with pytest.raises(PairingRejected):
        broker.redeem(peer, LOCAL_PAIRING_AUDIENCE, challenge.nonce)


def test_pairing_capability_is_memory_only_and_expires_with_broker_lifetime():
    peer = PairingPeer(pid=17, uid=os.geteuid(), gid=os.getegid())
    first_process = LocalPairingBroker(expected_uid=os.geteuid())
    challenge = first_process.issue_challenge(peer, LOCAL_PAIRING_AUDIENCE)
    credential = first_process.redeem(peer, LOCAL_PAIRING_AUDIENCE, challenge.nonce)

    assert first_process.authenticate(credential["access_token"]) == credential["principal"]
    # A fresh broker, as after service restart, has no persisted credential.
    second_process = LocalPairingBroker(expected_uid=os.geteuid())
    assert second_process.authenticate(credential["access_token"]) is None


def test_expired_credentials_are_rejected_and_free_capacity():
    now = {"mono": 20.0, "wall": 2000.0}
    broker = LocalPairingBroker(
        expected_uid=42,
        credential_ttl_seconds=5,
        max_credentials=1,
        monotonic=lambda: now["mono"],
        wall_time=lambda: now["wall"],
    )
    peer = PairingPeer(pid=7, uid=42, gid=42)
    first = broker.issue_challenge(peer, LOCAL_PAIRING_AUDIENCE)
    credential = broker.redeem(peer, LOCAL_PAIRING_AUDIENCE, first.nonce)
    assert credential["expires_at"] == 2005
    assert broker.authenticate(credential["access_token"]) is not None

    now["mono"] += 5
    now["wall"] += 5
    assert broker.authenticate(credential["access_token"]) is None
    second = broker.issue_challenge(peer, LOCAL_PAIRING_AUDIENCE)
    replacement = broker.redeem(peer, LOCAL_PAIRING_AUDIENCE, second.nonce)
    assert broker.authenticate(replacement["access_token"]) == replacement["principal"]


@pytest.mark.asyncio
async def test_socket_requires_private_parent_and_does_not_remove_non_socket(tmp_path):
    public_parent = tmp_path / "public"
    public_parent.mkdir(mode=0o755)
    os.chmod(public_parent, 0o755)
    occupied = public_parent / "pairing.sock"
    occupied.write_text("keep")
    server = UnixSocketPairingServer(occupied, LocalPairingBroker(), server_url=SERVER_URL)

    with pytest.raises(RuntimeError, match="private mode-0700"):
        await server.start()
    assert occupied.read_text() == "keep"

    os.chmod(public_parent, 0o700)
    with pytest.raises(FileExistsError, match="non-socket"):
        await server.start()
    assert occupied.read_text() == "keep"


@pytest.mark.asyncio
async def test_socket_rejects_symlinked_parent_and_socket_path_without_following_them(tmp_path):
    target_dir = tmp_path / "private"
    target_dir.mkdir(mode=0o700)
    os.chmod(target_dir, 0o700)
    parent_link = tmp_path / "linked-parent"
    parent_link.symlink_to(target_dir, target_is_directory=True)
    through_parent_link = UnixSocketPairingServer(
        parent_link / "pairing.sock", LocalPairingBroker(), server_url=SERVER_URL
    )
    with pytest.raises(RuntimeError, match="must not traverse symlinks"):
        await through_parent_link.start()
    assert list(target_dir.iterdir()) == []

    target_file = tmp_path / "target-file"
    target_file.write_text("keep")
    socket_link = target_dir / "pairing.sock"
    socket_link.symlink_to(target_file)
    at_link = UnixSocketPairingServer(socket_link, LocalPairingBroker(), server_url=SERVER_URL)
    with pytest.raises(FileExistsError, match="non-socket"):
        await at_link.start()
    assert socket_link.is_symlink()
    assert target_file.read_text() == "keep"


@pytest.mark.asyncio
async def test_socket_is_mode_0600_and_second_server_preserves_active_listener(tmp_path):
    socket_path = tmp_path / "pairing.sock"
    first = UnixSocketPairingServer(socket_path, LocalPairingBroker(), server_url=SERVER_URL)
    second = UnixSocketPairingServer(socket_path, LocalPairingBroker(), server_url=SERVER_URL)
    await first.start()
    try:
        first_info = os.lstat(socket_path)
        assert stat.S_IMODE(first_info.st_mode) == 0o600
        with pytest.raises(FileExistsError, match="another local pairing server"):
            await second.start()
        still_first = os.lstat(socket_path)
        assert (still_first.st_dev, still_first.st_ino) == (first_info.st_dev, first_info.st_ino)
        assert stat.S_ISSOCK(still_first.st_mode)
    finally:
        await second.close()
        await first.close()


@pytest.mark.asyncio
async def test_socket_replaces_only_a_confirmed_stale_owned_socket(tmp_path):
    socket_path = tmp_path / "pairing.sock"
    stale = socket.socket(socket.AF_UNIX)
    stale.bind(os.fspath(socket_path))
    stale.close()
    server = UnixSocketPairingServer(socket_path, LocalPairingBroker(), server_url=SERVER_URL)

    await server.start()
    try:
        assert stat.S_ISSOCK(os.lstat(socket_path).st_mode)
        assert stat.S_IMODE(os.lstat(socket_path).st_mode) == 0o600
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_socket_never_unlinks_an_active_listener_without_our_lock(tmp_path):
    socket_path = tmp_path / "pairing.sock"
    external_listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    external_listener.bind(os.fspath(socket_path))
    external_listener.listen(1)
    before = os.lstat(socket_path)
    server = UnixSocketPairingServer(socket_path, LocalPairingBroker(), server_url=SERVER_URL)
    try:
        with pytest.raises(FileExistsError, match="already has a listener"):
            await server.start()
        after = os.lstat(socket_path)
        assert (after.st_dev, after.st_ino) == (before.st_dev, before.st_ino)
        assert stat.S_ISSOCK(after.st_mode)
    finally:
        await server.close()
        external_listener.close()
        socket_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_close_does_not_unlink_a_replacement_at_socket_path(tmp_path):
    socket_path = tmp_path / "pairing.sock"
    server = UnixSocketPairingServer(socket_path, LocalPairingBroker(), server_url=SERVER_URL)
    await server.start()
    socket_path.unlink()
    socket_path.write_text("replacement")

    await server.close()

    assert socket_path.read_text() == "replacement"


@pytest.mark.asyncio
async def test_close_releases_lock_and_credentials_when_socket_cleanup_fails(tmp_path, monkeypatch):
    socket_path = tmp_path / "pairing.sock"
    broker = LocalPairingBroker()
    server = UnixSocketPairingServer(socket_path, broker, server_url=SERVER_URL)
    await server.start()
    peer = PairingPeer(pid=os.getpid(), uid=os.geteuid(), gid=os.getegid())
    challenge = broker.issue_challenge(peer, LOCAL_PAIRING_AUDIENCE)
    credential = broker.redeem(peer, LOCAL_PAIRING_AUDIENCE, challenge.nonce)
    unlink = server._unlink_own_socket

    def fail_unlink():
        raise RuntimeError("injected socket cleanup failure")

    monkeypatch.setattr(server, "_unlink_own_socket", fail_unlink)
    with pytest.raises(RuntimeError, match="injected socket cleanup failure"):
        await server.close()

    assert server._lock_fd is None
    assert broker.authenticate(credential["access_token"]) is None
    monkeypatch.setattr(server, "_unlink_own_socket", unlink)
    unlink()


@pytest.mark.parametrize(
    "server_url",
    [
        "https://127.0.0.1:8787",
        "http://0.0.0.0:8787",
        "http://127.0.0.1:0",
        "http://127.0.0.1:8787/",
        "http://127.0.0.1:8787?token=x",
        "http://user@127.0.0.1:8787",
        "http://example.test:8787",
    ],
)
def test_pairing_server_rejects_nonlocal_or_nonorigin_server_urls(tmp_path, server_url):
    with pytest.raises(ValueError, match="server_url"):
        UnixSocketPairingServer(
            tmp_path / "pairing.sock",
            LocalPairingBroker(),
            server_url=server_url,
        )


def test_pairing_server_accepts_bracketed_ipv6_local_origin(tmp_path):
    server = UnixSocketPairingServer(
        tmp_path / "pairing.sock",
        LocalPairingBroker(),
        server_url="http://[::1]:8787",
    )
    assert server.server_url == "http://[::1]:8787"
