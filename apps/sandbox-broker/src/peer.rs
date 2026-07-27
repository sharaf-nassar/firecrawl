use std::collections::BTreeSet;
use std::io::{IoSlice, IoSliceMut, Read, Seek, SeekFrom};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::time::Duration;

use nix::cmsg_space;
use nix::fcntl::{FcntlArg, OFlag, SealFlag, fcntl};
use nix::sys::socket::{
    ControlMessage, ControlMessageOwned, MsgFlags, SockFlag, SockType, UnixAddr, accept4,
    getpeername, getsockname, getsockopt, recvmsg, sendmsg, setsockopt, sockopt,
};
use nix::sys::stat::{SFlag, fstat};
use nix::sys::time::{TimeVal, TimeValLike};
use nix::unistd::{Whence, lseek};

use crate::bundles::FIXED_CODEX_CONFIG;
use crate::protocol::{BundleId, MAX_FRAME_BYTES};
use crate::redaction::{BrokerError, BrokerResult, ErrorCategory};

const MAX_DESCRIPTOR_COUNT: usize = 5;
const MAX_INPUT_BYTES: u64 = 128 * 1024;
const MAX_AUTH_BYTES: u64 = 1024 * 1024;
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub struct Packet {
    pub bytes: Vec<u8>,
    pub descriptors: Vec<OwnedFd>,
}

#[derive(Debug)]
pub struct ValidatedDescriptors {
    bundle_id: BundleId,
    descriptors: Vec<OwnedFd>,
}

impl ValidatedDescriptors {
    pub const fn bundle_id(&self) -> BundleId {
        self.bundle_id
    }

    pub fn descriptor(&self, role: &str) -> Option<BorrowedFd<'_>> {
        self.bundle_id
            .descriptor_roles()
            .iter()
            .position(|candidate| *candidate == role)
            .map(|index| self.descriptors[index].as_fd())
    }

    pub fn take(self) -> Vec<OwnedFd> {
        self.descriptors
    }
}

pub(crate) fn validated_after_dup(
    bundle_id: BundleId,
    descriptors: Vec<OwnedFd>,
) -> ValidatedDescriptors {
    ValidatedDescriptors {
        bundle_id,
        descriptors,
    }
}

pub fn validate_listener(fd: BorrowedFd<'_>) -> BrokerResult<()> {
    let socket_type = getsockopt(&fd, sockopt::SockType)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let accepting = getsockopt(&fd, sockopt::AcceptConn)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let address = nix::sys::socket::getsockname::<UnixAddr>(fd.as_raw_fd())
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if socket_type != SockType::SeqPacket || !accepting || address.path().is_none() {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(())
}

pub fn accept_peer(listener: BorrowedFd<'_>, expected_uid: u32) -> BrokerResult<(OwnedFd, u32)> {
    let raw = accept4(listener.as_raw_fd(), SockFlag::SOCK_CLOEXEC)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let credentials = getsockopt(&fd, sockopt::PeerCredentials)
        .map_err(|error| BrokerError::with_source(ErrorCategory::Unauthorized, error))?;
    let uid = credentials.uid();
    if uid != expected_uid {
        return Err(BrokerError::new(ErrorCategory::Unauthorized));
    }
    Ok((fd, uid))
}

pub fn accept_peer_or_root(
    listener: BorrowedFd<'_>,
    expected_uid: u32,
) -> BrokerResult<(OwnedFd, u32)> {
    let raw = accept4(listener.as_raw_fd(), SockFlag::SOCK_CLOEXEC)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let credentials = getsockopt(&fd, sockopt::PeerCredentials)
        .map_err(|error| BrokerError::with_source(ErrorCategory::Unauthorized, error))?;
    let uid = credentials.uid();
    if uid != expected_uid && uid != 0 {
        return Err(BrokerError::new(ErrorCategory::Unauthorized));
    }
    Ok((fd, uid))
}

pub fn peer_uid(fd: BorrowedFd<'_>, expected_uid: u32) -> BrokerResult<u32> {
    let credentials = getsockopt(&fd, sockopt::PeerCredentials)
        .map_err(|error| BrokerError::with_source(ErrorCategory::Unauthorized, error))?;
    let uid = credentials.uid();
    if uid != expected_uid {
        return Err(BrokerError::new(ErrorCategory::Unauthorized));
    }
    Ok(uid)
}

pub fn set_timeout(fd: BorrowedFd<'_>, timeout: Duration) -> BrokerResult<()> {
    let millis = timeout.as_millis().min(i64::MAX as u128) as i64;
    let value = TimeVal::milliseconds(millis.max(1));
    setsockopt(&fd, sockopt::ReceiveTimeout, &value)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    setsockopt(&fd, sockopt::SendTimeout, &value)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    Ok(())
}

pub fn receive_packet(fd: BorrowedFd<'_>) -> BrokerResult<Packet> {
    let mut bytes = vec![0_u8; MAX_FRAME_BYTES + 1];
    let (read, flags, descriptors, unexpected_control) = {
        let mut iov = [IoSliceMut::new(&mut bytes)];
        let mut control = cmsg_space!([RawFd; 253], nix::libc::ucred);
        let message = recvmsg::<()>(
            fd.as_raw_fd(),
            &mut iov,
            Some(&mut control),
            MsgFlags::MSG_CMSG_CLOEXEC,
        )
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
        let mut descriptors = Vec::new();
        let mut unexpected_control = false;
        for item in message
            .cmsgs()
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?
        {
            match item {
                ControlMessageOwned::ScmRights(raw_descriptors) => {
                    descriptors.extend(
                        raw_descriptors
                            .into_iter()
                            .map(|raw| unsafe { OwnedFd::from_raw_fd(raw) }),
                    );
                }
                _ => unexpected_control = true,
            }
        }
        (
            message.bytes,
            message.flags,
            descriptors,
            unexpected_control,
        )
    };
    if read == 0 {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    if read > MAX_FRAME_BYTES
        || flags.intersects(MsgFlags::MSG_TRUNC | MsgFlags::MSG_CTRUNC)
        || unexpected_control
        || descriptors.len() > MAX_DESCRIPTOR_COUNT
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    bytes.truncate(read);
    Ok(Packet { bytes, descriptors })
}

pub fn send_response(fd: BorrowedFd<'_>, bytes: &[u8]) -> BrokerResult<()> {
    send_response_with_descriptors(fd, bytes, &[])
}

pub fn send_response_with_descriptors(
    fd: BorrowedFd<'_>,
    bytes: &[u8],
    descriptors: &[RawFd],
) -> BrokerResult<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    let control = (!descriptors.is_empty())
        .then_some(ControlMessage::ScmRights(descriptors))
        .into_iter()
        .collect::<Vec<_>>();
    let sent = sendmsg::<UnixAddr>(
        fd.as_raw_fd(),
        &[IoSlice::new(bytes)],
        &control,
        MsgFlags::MSG_NOSIGNAL,
        None,
    )
    .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if sent != bytes.len() {
        return Err(BrokerError::new(ErrorCategory::SandboxUnavailable));
    }
    Ok(())
}

pub fn reject_descriptors(packet: &Packet) -> BrokerResult<()> {
    if packet.descriptors.is_empty() {
        Ok(())
    } else {
        Err(BrokerError::new(ErrorCategory::InvalidRequest))
    }
}

pub fn validate_descriptors(
    bundle_id: BundleId,
    peer_uid: u32,
    descriptors: Vec<OwnedFd>,
) -> BrokerResult<ValidatedDescriptors> {
    let roles = bundle_id.descriptor_roles();
    if descriptors.len() != roles.len() {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let mut identities = BTreeSet::new();
    for (role, descriptor) in roles.iter().zip(&descriptors) {
        let metadata = fstat(descriptor)
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
        if metadata.st_uid != peer_uid || !identities.insert((metadata.st_dev, metadata.st_ino)) {
            return Err(BrokerError::new(ErrorCategory::InvalidRequest));
        }
        let file_type = SFlag::from_bits_truncate(metadata.st_mode);
        match *role {
            "stdin" => validate_pipe(descriptor, file_type, OFlag::O_RDONLY)?,
            "stdout" | "stderr" => validate_pipe(descriptor, file_type, OFlag::O_WRONLY)?,
            "auth" => {
                validate_memfd(descriptor, file_type, metadata.st_size, MAX_AUTH_BYTES)?;
                let auth = read_bounded(descriptor.as_fd(), MAX_AUTH_BYTES as usize)?;
                if !crate::protocol::strict_json_value(&auth)?.is_object() {
                    return Err(BrokerError::new(ErrorCategory::InvalidRequest));
                }
            }
            "config" => {
                validate_memfd(descriptor, file_type, metadata.st_size, MAX_CONFIG_BYTES)?;
                if read_bounded(descriptor.as_fd(), MAX_CONFIG_BYTES as usize)?
                    != FIXED_CODEX_CONFIG.as_bytes()
                {
                    return Err(BrokerError::new(ErrorCategory::InvalidRequest));
                }
            }
            "input" => validate_memfd(descriptor, file_type, metadata.st_size, MAX_INPUT_BYTES)?,
            "relay" => validate_relay(descriptor, file_type, peer_uid)?,
            _ => return Err(BrokerError::new(ErrorCategory::InvalidRequest)),
        }
    }
    Ok(ValidatedDescriptors {
        bundle_id,
        descriptors,
    })
}

fn validate_pipe(fd: &OwnedFd, file_type: SFlag, expected: OFlag) -> BrokerResult<()> {
    if !file_type.contains(SFlag::S_IFIFO) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let flags = OFlag::from_bits_truncate(
        fcntl(fd, FcntlArg::F_GETFL)
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?,
    );
    if flags & OFlag::O_ACCMODE != expected {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

fn validate_memfd(fd: &OwnedFd, file_type: SFlag, size: i64, maximum: u64) -> BrokerResult<()> {
    if !file_type.contains(SFlag::S_IFREG) || size < 0 || size as u64 > maximum {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let target = std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd()))
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if !target.to_string_lossy().starts_with("/memfd:") {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let actual = SealFlag::from_bits_truncate(
        fcntl(fd, FcntlArg::F_GET_SEALS)
            .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?,
    );
    let required = SealFlag::F_SEAL_WRITE
        | SealFlag::F_SEAL_GROW
        | SealFlag::F_SEAL_SHRINK
        | SealFlag::F_SEAL_SEAL;
    if !actual.contains(required) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    lseek(fd, 0, Whence::SeekSet)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    Ok(())
}

fn validate_relay(fd: &OwnedFd, file_type: SFlag, peer_uid: u32) -> BrokerResult<()> {
    if !file_type.contains(SFlag::S_IFSOCK) {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let socket_type = getsockopt(fd, sockopt::SockType)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if socket_type != SockType::Stream {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let local: UnixAddr = getsockname(fd.as_raw_fd())
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    let remote: UnixAddr = getpeername(fd.as_raw_fd())
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if local.path().is_some()
        || local.as_abstract().is_some()
        || remote.path().is_some()
        || remote.as_abstract().is_some()
    {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    let peer = getsockopt(fd, sockopt::PeerCredentials)
        .map_err(|error| BrokerError::with_source(ErrorCategory::InvalidRequest, error))?;
    if peer.uid() != peer_uid {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(())
}

pub fn read_bounded(fd: BorrowedFd<'_>, maximum: usize) -> BrokerResult<Vec<u8>> {
    let duplicate = nix::unistd::dup(fd)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let mut file = std::fs::File::from(duplicate);
    file.seek(SeekFrom::Start(0))
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| BrokerError::with_source(ErrorCategory::SandboxUnavailable, error))?;
    if bytes.len() > maximum {
        return Err(BrokerError::new(ErrorCategory::InvalidRequest));
    }
    Ok(bytes)
}
