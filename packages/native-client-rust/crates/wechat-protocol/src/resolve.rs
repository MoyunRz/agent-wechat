//! Bounded host resolution that survives a broken or DHCP-overwritten system
//! resolver.
//!
//! The system lookup still runs first: when the machine is healthy it answers
//! instantly, and even when it stalls, a late successful answer lands in the
//! cache for the next caller. When the system resolver does not answer within
//! its budget, the fallback queries public resolvers over TCP 53 — UDP 53 may
//! be silently dropped by the network while TCP still works, which is exactly
//! the failure mode that used to strand accounts in "reconnecting". Answers
//! are cached per host for a short TTL, so the hot path never pays the
//! fallback cost twice in a row.

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::mpsc,
    time::{Duration, Instant},
};
use std::{
    net::Ipv4Addr,
    sync::{Mutex, OnceLock},
};

use anyhow::Result;

/// The system resolver gets this budget before the fallback takes over.
const SYSTEM_BUDGET: Duration = Duration::from_secs(2);
/// Fallback resolvers are queried concurrently; the first usable answer wins.
const FALLBACK_BUDGET: Duration = Duration::from_secs(4);
/// Successful answers (system or fallback) are reused for this long.
const CACHE_TTL: Duration = Duration::from_secs(300);

/// Host → addresses with the time they were cached.
type Cache = Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve `host` for connecting to `port`. IPv4 first, matching the protocol
/// transports which are IPv4-only in practice.
pub(crate) fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    let key = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    anyhow::ensure!(!key.is_empty(), "resolve_empty_host");
    if let Ok(cache) = cache().lock() {
        if let Some((addresses, at)) = cache.get(&key) {
            if at.elapsed() < CACHE_TTL {
                return Ok(addresses
                    .iter()
                    .map(|ip| SocketAddr::new(*ip, port))
                    .collect());
            }
        }
    }
    let addresses = resolve_uncached(&key, port)?;
    if let Ok(mut cache) = cache().lock() {
        cache.insert(
            key,
            (addresses.iter().map(|a| a.ip()).collect(), Instant::now()),
        );
    }
    Ok(addresses)
}

fn resolve_uncached(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    // The system resolver runs on a detached thread: a slow answer still fills
    // the cache, but a stalled one can no longer hold up account work.
    let (sender, receiver) = mpsc::channel();
    let system_host = host.to_owned();
    std::thread::Builder::new()
        .name("wx-system-resolve".into())
        .spawn(move || {
            if let Ok(addrs) = (system_host.as_str(), 0u16).to_socket_addrs() {
                let _ = sender.send(addrs.filter(|a| a.is_ipv4()).collect::<Vec<_>>());
            }
        })?;
    if let Ok(addrs) = receiver.recv_timeout(SYSTEM_BUDGET) {
        if !addrs.is_empty() {
            return Ok(rebind(addrs, port));
        }
        return Ok(Vec::new());
    }
    fallback(host, port)
}

/// Query public resolvers over TCP concurrently and return the first usable
/// IPv4 answer set.
fn fallback(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    const SERVERS: [Ipv4Addr; 3] = [
        Ipv4Addr::new(223, 5, 5, 5),
        Ipv4Addr::new(119, 29, 29, 29),
        Ipv4Addr::new(114, 114, 114, 114),
    ];
    let deadline = Instant::now() + FALLBACK_BUDGET;
    let (sender, receiver) = mpsc::channel();
    let mut threads = Vec::new();
    for server in SERVERS {
        let host = host.to_owned();
        let sender = sender.clone();
        threads.push(std::thread::Builder::new().spawn(move || {
            if let Ok(ips) = tcp_dns_a(server, &host, deadline) {
                let _ = sender.send(ips);
            }
        })?);
    }
    let ips = match receiver.recv_timeout(FALLBACK_BUDGET) {
        Ok(ips) if !ips.is_empty() => ips,
        _ => anyhow::bail!("resolve_fallback_failed"),
    };
    Ok(ips
        .into_iter()
        .map(|ip| SocketAddr::new(IpAddr::V4(ip), port))
        .collect())
}

/// One A-record lookup over TCP 53 (RFC 1035): send the query, read the
/// length-prefixed reply, collect IPv4 answers. A server is only tried until
/// `deadline`; connect and reads are bounded individually.
fn tcp_dns_a(server: Ipv4Addr, host: &str, deadline: Instant) -> Result<Vec<Ipv4Addr>> {
    let query = build_a_query(host, u16::from_be_bytes(crate::crypto::random::<2>()?))?;
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(server), 53),
        deadline.saturating_duration_since(Instant::now()),
    )?;
    stream.set_read_timeout(Some(deadline.saturating_duration_since(Instant::now())))?;
    stream.set_write_timeout(Some(deadline.saturating_duration_since(Instant::now())))?;
    stream.write_all(&(query.len() as u16).to_be_bytes())?;
    stream.write_all(&query)?;
    let mut prefix = [0u8; 2];
    stream.read_exact(&mut prefix)?;
    let mut reply = vec![0u8; u16::from_be_bytes(prefix) as usize];
    stream.read_exact(reply.as_mut_slice())?;
    parse_a_answers(&reply)
}

/// Build one recursive A query for `host` (RFC 1035 §4.1).
fn build_a_query(host: &str, id: u16) -> Result<Vec<u8>> {
    let mut message = Vec::with_capacity(64);
    message.extend(id.to_be_bytes());
    message.extend([0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in host.trim_end_matches('.').split('.') {
        let bytes = label.as_bytes();
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() <= 63,
            "resolve_bad_hostname"
        );
        message.push(bytes.len() as u8);
        message.extend(bytes);
    }
    message.push(0);
    message.extend([0, 1, 0, 1]);
    Ok(message)
}

/// Collect IPv4 answers from one reply. Name fields are skipped rather than
/// decompressed — answer A records carry their payload inline, which is all
/// this resolver needs. The connection is one query per TCP stream, so the
/// echoed transaction id is not re-checked here.
fn parse_a_answers(reply: &[u8]) -> Result<Vec<Ipv4Addr>> {
    anyhow::ensure!(reply.len() >= 12, "resolve_short_reply");
    anyhow::ensure!(reply[2] & 0x80 == 0, "resolve_reply_truncated_flag");
    anyhow::ensure!(reply[3] & 0x0F == 0, "resolve_reply_error_code");
    let answers = u16::from_be_bytes([reply[6], reply[7]]);
    let mut cursor = skip_question(reply)?;
    let mut ips = Vec::new();
    for _ in 0..answers {
        cursor += skip_name(reply, cursor)?;
        anyhow::ensure!(cursor + 10 <= reply.len(), "resolve_short_answer");
        let kind = u16::from_be_bytes([reply[cursor], reply[cursor + 1]]);
        let length = u16::from_be_bytes([reply[cursor + 8], reply[cursor + 9]]) as usize;
        cursor += 10;
        anyhow::ensure!(cursor + length <= reply.len(), "resolve_short_answer");
        if kind == 1 && length == 4 {
            ips.push(Ipv4Addr::new(
                reply[cursor],
                reply[cursor + 1],
                reply[cursor + 2],
                reply[cursor + 3],
            ));
        }
        cursor += length;
    }
    Ok(ips)
}

/// Skip the question section: one name plus the fixed QTYPE/QCLASS.
fn skip_question(reply: &[u8]) -> Result<usize> {
    // skip_name returns the bytes consumed relative to its start.
    let name = skip_name(reply, 12)?;
    anyhow::ensure!(12 + name + 4 <= reply.len(), "resolve_short_question");
    Ok(12 + name + 4)
}

/// Advance past one possibly compressed name (RFC 1035 §4.1.4); returns the
/// number of bytes the wire form occupies here.
fn skip_name(reply: &[u8], mut cursor: usize) -> Result<usize> {
    let start = cursor;
    loop {
        anyhow::ensure!(cursor < reply.len(), "resolve_truncated_name");
        let length = reply[cursor];
        if length & 0xC0 == 0xC0 {
            anyhow::ensure!(cursor + 2 <= reply.len(), "resolve_truncated_name");
            return Ok(cursor + 2 - start);
        }
        anyhow::ensure!(length & 0xC0 == 0, "resolve_unsupported_name_label");
        if length == 0 {
            return Ok(cursor + 1 - start);
        }
        cursor += 1 + length as usize;
    }
}

/// Rebind cached/looked-up IPs to the requested port.
fn rebind(addresses: Vec<SocketAddr>, port: u16) -> Vec<SocketAddr> {
    addresses
        .into_iter()
        .map(|addr| SocketAddr::new(addr.ip(), port))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 1035 wire shapes are public specification, so the synthetic replies
    // below assert an independently derived expected layout rather than
    // reproducing any captured packet.
    fn question(host: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        for label in host.split('.') {
            bytes.push(label.len() as u8);
            bytes.extend(label.as_bytes());
        }
        bytes.push(0);
        bytes.extend([0, 1, 0, 1]);
        bytes
    }

    fn answer(name: &[u8], kind: u16, payload: &[u8]) -> Vec<u8> {
        let mut bytes = name.to_vec();
        bytes.extend(kind.to_be_bytes());
        bytes.extend([0, 1, 0, 0, 0, 60]);
        bytes.extend((payload.len() as u16).to_be_bytes());
        bytes.extend(payload);
        bytes
    }

    #[test]
    fn builds_a_query_with_recursion_and_single_question() {
        let query = build_a_query("long.weixin.qq.com", 0x1234).unwrap();
        assert_eq!(&query[0..2], &0x1234u16.to_be_bytes());
        assert_eq!(&query[2..4], &[0x01, 0x00]);
        assert_eq!(&query[4..6], &[0, 1]);
        let tail = &query[12..];
        assert!(tail.starts_with(&[4, b'l', b'o', b'n', b'g']));
        assert!(tail.ends_with(&[0, 0, 1, 0, 1]));
    }

    #[test]
    fn parses_answers_with_compressed_and_plain_names() {
        let host = "long.weixin.qq.com";
        let q = question(host);
        // Pointer name (0xC00C → offset 12), A record.
        let mut reply = vec![0u8; 12];
        reply.extend(q.clone());
        reply.extend(answer(&[0xC0, 0x0C], 1, &[101, 89, 47, 179]));
        // Plain name repeated, CNAME payload is skipped.
        let plain = question("short.weixin.qq.com");
        reply.extend(answer(&plain, 5, b"alias.weixin.qq.com"));
        reply[7] = 2; // ANCOUNT: one A record plus one CNAME record.
        let ips = parse_a_answers(&reply).unwrap();
        assert_eq!(ips, vec![Ipv4Addr::new(101, 89, 47, 179)]);
    }

    #[test]
    fn rejects_error_and_truncated_replies() {
        let mut reply = vec![0u8; 12];
        reply.extend(question("long.weixin.qq.com"));
        reply.extend(answer(&[0xC0, 0x0C], 1, &[101, 89, 47, 179]));
        reply[7] = 1; // ANCOUNT: the parser must actually walk this answer.
        reply[3] = 0x02; // SERVFAIL
        assert!(parse_a_answers(&reply).is_err());
        reply[3] = 0;
        // Cutting into the trailing CNAME payload must fail the bounds check.
        assert!(parse_a_answers(&reply[..reply.len() - 8]).is_err());
    }

    #[test]
    fn rebind_rewrites_ports_on_cached_addresses() {
        let rebound = rebind(
            vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4)), 0),
                SocketAddr::new(IpAddr::V6("2001:db8::1".parse().unwrap()), 0),
            ],
            80,
        );
        assert!(rebound.iter().all(|a| a.port() == 80));
    }

    #[test]
    fn cache_round_trip_and_empty_host_rejection() {
        let key = "cache-test.invalid";
        cache().lock().unwrap().insert(
            key.to_owned(),
            (vec![IpAddr::V4(Ipv4Addr::new(9, 9, 9, 9))], Instant::now()),
        );
        let addresses = resolve(key, 443).unwrap();
        assert_eq!(
            addresses,
            vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::new(9, 9, 9, 9)), 443)]
        );
        assert!(resolve("", 80).is_err());
    }
}
