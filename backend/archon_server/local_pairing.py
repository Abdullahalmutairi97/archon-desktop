"""Same-user, local-only pairing over a protected Unix-domain socket.

Pairing credentials are deliberately kept in memory and live only as long as
the broker process. This module does not create or persist a bearer token.
"""

from __future__ import annotations

import asyncio
import errno
import fcntl
import hashlib
import ipaddress
import json
import os
import secrets
import socket
import stat
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit


LOCAL_PAIRING_AUDIENCE = "archon-desktop.local/v1"
_MAX_REQUEST_BYTES = 4096
_PAIRING_TIMEOUT_SECONDS = 10.0
_MAX_SOCKET_PATH_BYTES = 107
_PAIRING_LOCK_NAME = ".pairing-server.lock"


class PairingRejected(Exception):
    """A pairing request did not satisfy the local pairing policy."""


@dataclass(frozen=True)
class PairingPeer:
    pid: int
    uid: int
    gid: int


@dataclass(frozen=True)
class PairingChallenge:
    nonce: str
    audience: str
    expires_at: int


@dataclass(frozen=True)
class _PendingChallenge:
    peer: PairingPeer
    audience: str
    expires_monotonic: float
    expires_at: int


@dataclass(frozen=True)
class _Credential:
    principal: dict[str, object]
    expires_monotonic: float
    expires_at: int


class LocalPairingBroker:
    """Issue one-use challenges and ephemeral credentials for the service UID."""

    def __init__(
        self,
        *,
        expected_uid: int | None = None,
        challenge_ttl_seconds: float = 30.0,
        credential_ttl_seconds: float = 86400.0,
        max_pending_challenges: int = 256,
        max_credentials: int = 32,
        monotonic: Callable[[], float] = time.monotonic,
        wall_time: Callable[[], float] = time.time,
    ) -> None:
        if expected_uid is None:
            expected_uid = os.geteuid()
        if not isinstance(expected_uid, int) or expected_uid < 0:
            raise ValueError("expected_uid must be a non-negative integer")
        if challenge_ttl_seconds <= 0:
            raise ValueError("challenge_ttl_seconds must be positive")
        if credential_ttl_seconds <= 0:
            raise ValueError("credential_ttl_seconds must be positive")
        if max_pending_challenges < 1 or max_credentials < 1:
            raise ValueError("pairing capacities must be positive")
        self.expected_uid = expected_uid
        self.challenge_ttl_seconds = float(challenge_ttl_seconds)
        self.credential_ttl_seconds = float(credential_ttl_seconds)
        self.max_pending_challenges = int(max_pending_challenges)
        self.max_credentials = int(max_credentials)
        self._monotonic = monotonic
        self._wall_time = wall_time
        self._pending: dict[bytes, _PendingChallenge] = {}
        self._credentials: dict[bytes, _Credential] = {}
        self._lock = threading.Lock()

    def issue_challenge(self, peer: PairingPeer, audience: str) -> PairingChallenge:
        self._validate_peer(peer)
        if audience != LOCAL_PAIRING_AUDIENCE:
            raise PairingRejected("unsupported pairing audience")

        now = self._monotonic()
        expires = now + self.challenge_ttl_seconds
        expires_at = int(self._wall_time() + self.challenge_ttl_seconds)
        with self._lock:
            self._prune_expired(now)
            if len(self._pending) >= self.max_pending_challenges:
                raise PairingRejected("pairing challenge capacity reached")
            nonce = secrets.token_urlsafe(32)
            self._pending[self._nonce_key(nonce)] = _PendingChallenge(
                peer=peer,
                audience=audience,
                expires_monotonic=expires,
                expires_at=expires_at,
            )
        return PairingChallenge(nonce=nonce, audience=audience, expires_at=expires_at)

    def redeem(self, peer: PairingPeer, audience: str, nonce: str) -> dict[str, object]:
        self._validate_peer(peer)
        if audience != LOCAL_PAIRING_AUDIENCE or not isinstance(nonce, str):
            raise PairingRejected("invalid pairing challenge")
        if len(nonce) < 16 or len(nonce) > 128 or not nonce.isascii():
            raise PairingRejected("invalid pairing challenge")

        now = self._monotonic()
        key = self._nonce_key(nonce)
        with self._lock:
            # Consume a known nonce before validating its binding or expiry. A
            # rejected redemption can never later be replayed successfully.
            challenge = self._pending.pop(key, None)
            self._prune_expired(now)
            if challenge is None:
                raise PairingRejected("unknown or replayed pairing challenge")
            if challenge.expires_monotonic <= now:
                raise PairingRejected("pairing challenge expired")
            if challenge.audience != audience or challenge.peer != peer:
                raise PairingRejected("pairing challenge binding mismatch")
            self._prune_credentials(now)
            if len(self._credentials) >= self.max_credentials:
                raise PairingRejected("pairing credential capacity reached")

            token = secrets.token_urlsafe(32)
            credential_expires = now + self.credential_ttl_seconds
            credential_expires_at = int(self._wall_time() + self.credential_ttl_seconds)
            principal: dict[str, object] = {
                "principal_id": f"local-uid:{peer.uid}",
                "uid": peer.uid,
                "auth_method": "unix-peer-credentials",
            }
            self._credentials[self._token_key(token)] = _Credential(
                principal=principal,
                expires_monotonic=credential_expires,
                expires_at=credential_expires_at,
            )
        return {
            "access_token": token,
            "principal": principal.copy(),
            "expires_at": credential_expires_at,
        }

    def authenticate(self, access_token: str | None) -> dict[str, object] | None:
        """Return the local principal for a live capability, if one exists."""
        if not isinstance(access_token, str) or not access_token or len(access_token) > 128:
            return None
        with self._lock:
            now = self._monotonic()
            self._prune_credentials(now)
            credential = self._credentials.get(self._token_key(access_token))
            return credential.principal.copy() if credential is not None else None

    def discard_challenge(self, peer: PairingPeer, nonce: str) -> None:
        """Drop a pending challenge when its owning socket exchange aborts."""
        if not isinstance(nonce, str) or len(nonce) < 16 or len(nonce) > 128:
            return
        try:
            key = self._nonce_key(nonce)
        except UnicodeEncodeError:
            return
        with self._lock:
            challenge = self._pending.get(key)
            if challenge is not None and challenge.peer == peer:
                self._pending.pop(key, None)

    def revoke(self, access_token: str) -> None:
        """Forget a credential that could not be delivered to its peer."""
        if not isinstance(access_token, str) or not access_token or len(access_token) > 128:
            return
        with self._lock:
            self._credentials.pop(self._token_key(access_token), None)

    def clear(self) -> None:
        """Invalidate all process-lifetime pairing state."""
        with self._lock:
            self._pending.clear()
            self._credentials.clear()

    @staticmethod
    def _nonce_key(nonce: str) -> bytes:
        return hashlib.sha256(nonce.encode("ascii", errors="strict")).digest()

    @staticmethod
    def _token_key(token: str) -> bytes:
        return hashlib.sha256(token.encode("utf-8", errors="strict")).digest()

    def _validate_peer(self, peer: PairingPeer) -> None:
        if (
            not isinstance(peer, PairingPeer)
            or peer.pid <= 0
            or peer.uid != self.expected_uid
            or peer.gid < 0
        ):
            raise PairingRejected("peer credentials rejected")

    def _prune_expired(self, now: float) -> None:
        expired = [
            key for key, challenge in self._pending.items()
            if challenge.expires_monotonic <= now
        ]
        for key in expired:
            self._pending.pop(key, None)

    def _prune_credentials(self, now: float) -> None:
        expired = [
            key for key, credential in self._credentials.items()
            if credential.expires_monotonic <= now
        ]
        for key in expired:
            self._credentials.pop(key, None)


class UnixSocketPairingServer:
    """Serve a bounded challenge/redeem exchange on a private Unix socket."""

    def __init__(
        self,
        socket_path: str | os.PathLike[str],
        broker: LocalPairingBroker,
        *,
        server_url: str,
    ) -> None:
        self.socket_path = Path(socket_path)
        self.broker = broker
        self.server_url = _validate_local_server_url(server_url)
        self._server: asyncio.AbstractServer | None = None
        self._socket_identity: tuple[int, int] | None = None
        self._lock_fd: int | None = None
        self._connections: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        if self._server is not None:
            raise RuntimeError("pairing server is already started")
        self._validate_parent()
        path_text = os.fspath(self.socket_path)
        if len(os.fsencode(path_text)) > _MAX_SOCKET_PATH_BYTES:
            raise ValueError("pairing socket path is too long")
        if not os.path.isabs(path_text):
            raise ValueError("pairing socket path must be absolute")
        self._acquire_startup_lock()
        listener: socket.socket | None = None
        try:
            self._remove_stale_socket_if_safe()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(path_text)
            bound_info = os.lstat(path_text)
            if not stat.S_ISSOCK(bound_info.st_mode) or bound_info.st_uid != os.geteuid():
                raise RuntimeError("pairing socket path changed during bind")
            self._socket_identity = (bound_info.st_dev, bound_info.st_ino)
            # The parent is mode 0700, so no other UID can reach the brief
            # interval before the socket itself is tightened to mode 0600.
            os.chmod(path_text, 0o600, follow_symlinks=False)
            secured_info = os.lstat(path_text)
            if (
                not self._is_our_socket(secured_info)
                or stat.S_IMODE(secured_info.st_mode) != 0o600
            ):
                raise RuntimeError("pairing socket path changed while securing it")
            listener.listen(socket.SOMAXCONN)
            listener.setblocking(False)
            self._server = await asyncio.start_unix_server(
                self._connected,
                sock=listener,
                limit=_MAX_REQUEST_BYTES + 1,
            )
        except BaseException:
            if listener is not None:
                listener.close()
            self._unlink_own_socket()
            self._socket_identity = None
            self._release_startup_lock()
            raise

    async def close(self) -> None:
        server, self._server = self._server, None
        try:
            if server is not None:
                server.close()
                await server.wait_closed()
        finally:
            try:
                tasks = tuple(self._connections)
                for task in tasks:
                    task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
            finally:
                try:
                    self._unlink_own_socket()
                finally:
                    self._socket_identity = None
                    try:
                        self.broker.clear()
                    finally:
                        self._release_startup_lock()

    def _validate_parent(self) -> None:
        parent = self.socket_path.parent
        try:
            resolved_parent = parent.resolve(strict=True)
            parent_info = os.lstat(parent)
        except OSError as exc:
            raise RuntimeError("pairing socket parent must already exist") from exc
        if parent != resolved_parent:
            raise RuntimeError("pairing socket parent must not traverse symlinks")
        if (
            not stat.S_ISDIR(parent_info.st_mode)
            or stat.S_ISLNK(parent_info.st_mode)
            or parent_info.st_uid != os.geteuid()
            or stat.S_IMODE(parent_info.st_mode) != 0o700
        ):
            raise RuntimeError("pairing socket parent must be a private mode-0700 directory")

    def _remove_stale_socket_if_safe(self) -> None:
        try:
            before = os.lstat(self.socket_path)
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(before.st_mode) or stat.S_ISLNK(before.st_mode):
            raise FileExistsError("pairing socket path is occupied by a non-socket")
        if before.st_uid != os.geteuid():
            raise PermissionError("pairing socket is not owned by the current user")

        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.25)
        try:
            result = probe.connect_ex(os.fspath(self.socket_path))
        except OSError as exc:
            result = exc.errno or errno.EIO
        finally:
            probe.close()
        if result == 0:
            raise FileExistsError("pairing socket already has a listener")
        if result not in {errno.ENOENT, errno.ECONNREFUSED}:
            # Treat permissions, a full backlog, and unknown states as active
            # or ambiguous; do not delete a socket we cannot prove is stale.
            raise FileExistsError("pairing socket state is ambiguous")

        current = os.lstat(self.socket_path)
        if (
            not stat.S_ISSOCK(current.st_mode)
            or current.st_uid != os.geteuid()
            or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise FileExistsError("pairing socket changed during stale-socket check")
        os.unlink(self.socket_path)

    def _acquire_startup_lock(self) -> None:
        lock_path = self.socket_path.parent / _PAIRING_LOCK_NAME
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        try:
            fd = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise RuntimeError("cannot safely open pairing startup lock") from exc
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise RuntimeError("pairing startup lock has unsafe ownership or mode")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise FileExistsError("another local pairing server owns the socket") from None
            self._lock_fd = fd
        except BaseException:
            os.close(fd)
            raise

    def _release_startup_lock(self) -> None:
        fd, self._lock_fd = self._lock_fd, None
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def _connected(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.create_task(self._handle_client(reader, writer))
        self._connections.add(task)
        task.add_done_callback(self._connections.discard)

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        nonce: str | None = None
        peer: PairingPeer | None = None
        undelivered_token: str | None = None
        try:
            peer = _read_peer_credentials(writer)
            challenge_request = await self._read_request(reader)
            if set(challenge_request) != {"op", "audience"} or challenge_request.get("op") != "challenge":
                raise PairingRejected("challenge request required")
            challenge = self.broker.issue_challenge(peer, challenge_request.get("audience"))  # type: ignore[arg-type]
            nonce = challenge.nonce
            await self._write_response(writer, {
                "ok": True,
                "challenge": {
                    "nonce": challenge.nonce,
                    "audience": challenge.audience,
                    "expires_at": challenge.expires_at,
                },
            })

            redeem_request = await self._read_request(reader)
            if (
                set(redeem_request) != {"op", "audience", "nonce"}
                or redeem_request.get("op") != "redeem"
            ):
                raise PairingRejected("redemption request required")
            credential = self.broker.redeem(
                peer,
                redeem_request.get("audience"),  # type: ignore[arg-type]
                redeem_request.get("nonce"),  # type: ignore[arg-type]
            )
            credential["server_url"] = self.server_url
            undelivered_token = str(credential["access_token"])
            await self._write_response(writer, {"ok": True, "credential": credential})
            undelivered_token = None
        except asyncio.CancelledError:
            if undelivered_token is not None:
                self.broker.revoke(undelivered_token)
            if nonce is not None and peer is not None:
                self.broker.discard_challenge(peer, nonce)
            raise
        except Exception:
            if undelivered_token is not None:
                self.broker.revoke(undelivered_token)
            if nonce is not None and peer is not None:
                self.broker.discard_challenge(peer, nonce)
            try:
                await self._write_response(writer, {"ok": False, "error": "pairing_failed"})
            except Exception:
                pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    async def _read_request(self, reader: asyncio.StreamReader) -> dict[str, object]:
        raw = await asyncio.wait_for(reader.readline(), timeout=_PAIRING_TIMEOUT_SECONDS)
        if not raw or len(raw) > _MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
            raise PairingRejected("invalid pairing request")
        try:
            request = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise PairingRejected("invalid pairing request") from None
        if not isinstance(request, dict):
            raise PairingRejected("invalid pairing request")
        return request

    @staticmethod
    async def _write_response(writer: asyncio.StreamWriter, value: dict[str, object]) -> None:
        writer.write(json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n")
        await asyncio.wait_for(writer.drain(), timeout=_PAIRING_TIMEOUT_SECONDS)

    def _is_our_socket(self, info: os.stat_result) -> bool:
        return (
            stat.S_ISSOCK(info.st_mode)
            and info.st_uid == os.geteuid()
            and self._socket_identity == (info.st_dev, info.st_ino)
        )

    def _unlink_own_socket(self) -> None:
        identity = self._socket_identity
        if identity is None:
            return
        try:
            current = os.lstat(self.socket_path)
        except FileNotFoundError:
            return
        if (
            stat.S_ISSOCK(current.st_mode)
            and current.st_uid == os.geteuid()
            and (current.st_dev, current.st_ino) == identity
        ):
            os.unlink(self.socket_path)


def _read_peer_credentials(writer: asyncio.StreamWriter) -> PairingPeer:
    if sys.platform != "linux" or not hasattr(socket, "SO_PEERCRED"):
        raise PairingRejected("Linux peer credentials are required")
    sock = writer.get_extra_info("socket")
    if sock is None:
        raise PairingRejected("peer credentials unavailable")
    try:
        raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, gid = struct.unpack("3i", raw)
    except (OSError, struct.error):
        raise PairingRejected("peer credentials unavailable") from None
    return PairingPeer(pid=pid, uid=uid, gid=gid)


def _validate_local_server_url(value: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("server_url must be an exact local HTTP origin")
    if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in value):
        raise ValueError("server_url must be an exact local HTTP origin")
    if "?" in value or "#" in value or "%" in value:
        raise ValueError("server_url must not contain query, fragment, or escaped host data")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise ValueError("server_url must be an exact local HTTP origin") from None
    if (
        parts.scheme != "http"
        or not parts.netloc
        or parts.path
        or parts.query
        or parts.fragment
        or parts.username is not None
        or parts.password is not None
        or "@" in parts.netloc
        or port is None
        or not 1 <= port <= 65535
    ):
        raise ValueError("server_url must be an exact local HTTP origin")
    host = parts.hostname
    if not host or not _is_loopback_host(host):
        raise ValueError("server_url host must be loopback")
    authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    if parts.netloc.lower() != authority.lower() or value != f"http://{parts.netloc}":
        raise ValueError("server_url must be an exact local HTTP origin")
    return value


def _is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    if "%" in host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
