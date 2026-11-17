//! GDeflate decompressor (Microsoft DirectStorage / NVIDIA libdeflate "gdeflate" branch),
//! used by SCS for packed textures in HashFS v2 archives.
//!
//! Format:
//! * A *tile stream* header (8 bytes): `id` (4 = GDeflate), `magic` (= id ^ 0xFF),
//!   `num_tiles: u16`, then a u32 bit field: tile size index (2 bits) and the size of
//!   the last tile (18 bits, 0 = full 64 KiB).
//! * `num_tiles` u32 tile offsets. Entry 0 holds the *compressed size of the last tile*;
//!   entry i (i > 0) is the offset of tile i (tile 0 starts at 0).
//! * Each tile decompresses to (at most) 64 KiB. A tile is a DEFLATE stream whose bits are
//!   spread over 32 interleaved "lanes": every lane has its own 64-bit bit buffer that is
//!   refilled with the next little-endian u32 from the input whenever it drops below 32
//!   bits, at fixed points of the decoding loop. Each decoded symbol rotates to the next
//!   lane. Match offsets are decoded one lane-round later ("deferred copies").
//!
//! Ported from `gdeflate_decompress_template.h` (Apache-2.0 / MIT, Eric Biggers & NVIDIA).

use crate::{Error, Result};

const NUM_STREAMS: usize = 32;
const LOW_WATERMARK_BITS: u32 = 32;
pub const TILE_SIZE: usize = 64 * 1024;
const GDEFLATE_ID: u8 = 4;

fn bad(msg: &str) -> Error {
    Error::Invalid(format!("GDeflate: {msg}"))
}

// ---------------------------------------------------------------------------
// Huffman decoding
// ---------------------------------------------------------------------------

/// Flat lookup table over `max_len` peeked bits (LSB-first), entry = (symbol, code length).
struct Huffman {
    table: Vec<(u16, u8)>,
    max_len: u32,
}

impl Huffman {
    fn new(lens: &[u8]) -> Result<Self> {
        let max_len = lens.iter().copied().max().unwrap_or(0) as u32;
        if max_len > 15 {
            return Err(bad("code length > 15"));
        }
        let mut count = [0u32; 16];
        for &l in lens {
            count[l as usize] += 1;
        }
        count[0] = 0;
        // over-subscription check
        let mut left: i32 = 1;
        for len in 1..=15 {
            left <<= 1;
            left -= count[len] as i32;
            if left < 0 {
                return Err(bad("over-subscribed Huffman code"));
            }
        }
        let mut next = [0u32; 16];
        let mut code = 0u32;
        for len in 1..=15 {
            code = (code + count[len - 1]) << 1;
            next[len] = code;
        }
        let size = 1usize << max_len;
        let mut table = vec![(0u16, 0u8); size.max(1)];
        for (sym, &l) in lens.iter().enumerate() {
            if l == 0 {
                continue;
            }
            let l32 = l as u32;
            let c = next[l as usize];
            next[l as usize] += 1;
            // reverse the code: DEFLATE stores Huffman codes MSB-first in an LSB-first stream
            let mut rev = 0u32;
            for b in 0..l32 {
                if c & (1 << b) != 0 {
                    rev |= 1 << (l32 - 1 - b);
                }
            }
            let step = 1usize << l32;
            let mut i = rev as usize;
            while i < size {
                table[i] = (sym as u16, l);
                i += step;
            }
        }
        Ok(Huffman { table, max_len })
    }
}

// ---------------------------------------------------------------------------
// 32-lane bit reader
// ---------------------------------------------------------------------------

struct Lanes<'a> {
    input: &'a [u8],
    pos: usize,
    buf: [u64; NUM_STREAMS],
    left: [u32; NUM_STREAMS],
    idx: usize,
    copy_len: [u32; NUM_STREAMS],
    copy_out: [usize; NUM_STREAMS],
    is_copy: [bool; NUM_STREAMS],
}

impl<'a> Lanes<'a> {
    fn new(input: &'a [u8]) -> Self {
        Lanes {
            input,
            pos: 0,
            buf: [0; NUM_STREAMS],
            left: [0; NUM_STREAMS],
            idx: 0,
            copy_len: [0; NUM_STREAMS],
            copy_out: [0; NUM_STREAMS],
            is_copy: [false; NUM_STREAMS],
        }
    }

    /// ENSURE_BITS(LOW_WATERMARK_BITS) on the current lane: adds one 32-bit packet.
    fn ensure(&mut self) -> Result<()> {
        let i = self.idx;
        if self.left[i] < LOW_WATERMARK_BITS {
            let mut w = [0u8; 4];
            for (k, b) in w.iter_mut().enumerate() {
                *b = self.input.get(self.pos + k).copied().unwrap_or(0);
            }
            // Reading far past the end means the stream is corrupt (normal streams only
            // look ahead a few packets per lane).
            if self.pos > self.input.len() + 4 * NUM_STREAMS * 4 {
                return Err(bad("input overrun"));
            }
            self.buf[i] |= (u32::from_le_bytes(w) as u64) << self.left[i];
            self.pos += 4;
            self.left[i] += 32;
        }
        Ok(())
    }

    /// ADVANCE(): refill the current lane, then move to the next one.
    fn advance(&mut self) -> Result<()> {
        self.ensure()?;
        self.idx = (self.idx + 1) % NUM_STREAMS;
        Ok(())
    }

    fn peek(&self, n: u32) -> u32 {
        if n == 0 {
            0
        } else {
            (self.buf[self.idx] & ((1u64 << n) - 1)) as u32
        }
    }

    fn remove(&mut self, n: u32) -> Result<()> {
        let i = self.idx;
        if n > self.left[i] {
            return Err(bad("bit buffer underflow"));
        }
        self.buf[i] >>= n;
        self.left[i] -= n;
        Ok(())
    }

    fn pop(&mut self, n: u32) -> Result<u32> {
        let v = self.peek(n);
        self.remove(n)?;
        Ok(v)
    }

    fn decode(&mut self, h: &Huffman) -> Result<u16> {
        let (sym, len) = h.table[self.peek(h.max_len) as usize];
        if len == 0 {
            return Err(bad("invalid Huffman code"));
        }
        self.remove(len as u32)?;
        Ok(sym)
    }
}

const LENGTH_BASE: [u16; 31] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 258, 258];
const LENGTH_EXTRA: [u8; 31] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0];
const OFFSET_BASE: [u32; 32] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153,
];
const OFFSET_EXTRA: [u8; 32] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
const PRECODE_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

fn static_tables() -> Result<(Huffman, Huffman)> {
    let mut lens = [0u8; 288];
    lens[..144].fill(8);
    lens[144..256].fill(9);
    lens[256..280].fill(7);
    lens[280..].fill(8);
    Ok((Huffman::new(&lens)?, Huffman::new(&[5u8; 32])?))
}

/// Executes the deferred copy stored in the current lane.
fn do_copy(s: &mut Lanes, offsets: &Huffman, out: &mut [u8]) -> Result<()> {
    let i = s.idx;
    let len = s.copy_len[i] as usize;
    let dst = s.copy_out[i];
    let sym = s.decode(offsets)? as usize;
    if sym >= 32 {
        return Err(bad("bad offset symbol"));
    }
    let offset = OFFSET_BASE[sym] as usize + s.pop(OFFSET_EXTRA[sym] as u32)? as usize;
    if offset == 0 || offset > dst || dst + len > out.len() {
        return Err(bad("match out of range"));
    }
    for k in 0..len {
        out[dst + k] = out[dst + k - offset];
    }
    s.is_copy[i] = false;
    Ok(())
}

/// Decompresses one GDeflate page (tile) into `out`; returns the number of bytes written.
pub fn decompress_page(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let mut s = Lanes::new(input);
    for _ in 0..NUM_STREAMS {
        s.advance()?;
    }
    let mut out_pos = 0usize;
    let mut blocks = 0usize;
    loop {
        blocks += 1;
        if blocks > 1 << 20 {
            return Err(bad("too many blocks"));
        }
        s.idx = 0;
        let is_final = s.pop(1)? != 0;
        let block_type = s.pop(2)?;
        s.ensure()?;

        let tables = match block_type {
            2 => {
                let num_litlen = s.pop(5)? as usize + 257;
                let num_offset = s.pop(5)? as usize + 1;
                let num_precode = s.pop(4)? as usize + 4;
                s.ensure()?;
                let mut pre = [0u8; 19];
                for &slot in PRECODE_ORDER.iter().take(num_precode) {
                    pre[slot] = s.pop(3)? as u8;
                    s.advance()?;
                }
                let precode = Huffman::new(&pre)?;
                s.idx = 0;
                let total = num_litlen + num_offset;
                let mut lens = vec![0u8; total + 138];
                let mut i = 0usize;
                while i < total {
                    let presym = s.decode(&precode)?;
                    match presym {
                        0..=15 => {
                            lens[i] = presym as u8;
                            i += 1;
                        }
                        16 => {
                            if i == 0 {
                                return Err(bad("repeat without previous length"));
                            }
                            let v = lens[i - 1];
                            let n = 3 + s.pop(2)? as usize;
                            lens[i..i + n].fill(v);
                            i += n;
                        }
                        17 => {
                            let n = 3 + s.pop(3)? as usize;
                            lens[i..i + n].fill(0);
                            i += n;
                        }
                        _ => {
                            let n = 11 + s.pop(7)? as usize;
                            lens[i..i + n].fill(0);
                            i += n;
                        }
                    }
                    s.advance()?;
                }
                Some((Huffman::new(&lens[..num_litlen])?, Huffman::new(&lens[num_litlen..total])?))
            }
            0 => {
                let len = s.pop(16)? as usize;
                if len > out.len() - out_pos {
                    return Err(bad("stored block exceeds output"));
                }
                for _ in 0..len {
                    out[out_pos] = s.pop(8)? as u8;
                    out_pos += 1;
                    s.advance()?;
                }
                None
            }
            1 => Some(static_tables()?),
            _ => return Err(bad("invalid block type")),
        };

        if let Some((litlen, offsets)) = tables {
            s.idx = 0;
            loop {
                if !s.is_copy[s.idx] {
                    let sym = s.decode(&litlen)? as usize;
                    if sym < 256 {
                        if out_pos >= out.len() {
                            return Err(bad("output overflow"));
                        }
                        out[out_pos] = sym as u8;
                        out_pos += 1;
                        s.advance()?;
                        continue;
                    }
                    if sym == 256 {
                        break; // end of block (no lane advance)
                    }
                    let k = sym - 257;
                    if k >= LENGTH_BASE.len() {
                        return Err(bad("bad length symbol"));
                    }
                    let length = LENGTH_BASE[k] as usize + s.pop(LENGTH_EXTRA[k] as u32)? as usize;
                    if length > out.len() - out_pos {
                        return Err(bad("match exceeds output"));
                    }
                    let i = s.idx;
                    s.copy_len[i] = length as u32;
                    s.copy_out[i] = out_pos;
                    s.is_copy[i] = true;
                    out_pos += length;
                } else {
                    do_copy(&mut s, &offsets, out)?;
                }
                s.advance()?;
            }
            // flush the outstanding deferred copies
            for _ in 0..NUM_STREAMS {
                if s.is_copy[s.idx] {
                    do_copy(&mut s, &offsets, out)?;
                }
                s.advance()?;
            }
        } else {
            for _ in 0..NUM_STREAMS {
                s.advance()?;
            }
        }

        if is_final {
            return Ok(out_pos);
        }
    }
}

/// Parsed tile stream header.
#[derive(Debug, Clone, Copy)]
pub struct TileStream {
    pub num_tiles: usize,
    pub uncompressed_size: usize,
}

pub fn parse_header(data: &[u8]) -> Result<TileStream> {
    if data.len() < 8 {
        return Err(bad("stream too short"));
    }
    let id = data[0];
    let magic = data[1];
    if id != magic ^ 0xFF {
        return Err(bad("malformed stream header"));
    }
    if id != GDEFLATE_ID {
        return Err(bad(&format!("unknown codec id {id}")));
    }
    let num_tiles = u16::from_le_bytes([data[2], data[3]]) as usize;
    let bits = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
    let last = ((bits >> 2) & 0x3FFFF) as usize;
    let uncompressed_size = num_tiles * TILE_SIZE - if last == 0 { 0 } else { TILE_SIZE - last };
    Ok(TileStream { num_tiles, uncompressed_size })
}

/// Decompresses a complete GDeflate tile stream (header + tile offsets + tiles).
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    let header = parse_header(data)?;
    let n = header.num_tiles;
    if n == 0 {
        return Ok(Vec::new());
    }
    let table_end = 8 + n * 4;
    if data.len() < table_end {
        return Err(bad("truncated tile table"));
    }
    let offsets: Vec<usize> = (0..n).map(|i| u32::from_le_bytes(data[8 + i * 4..12 + i * 4].try_into().unwrap()) as usize).collect();
    let tiles = &data[table_end..];
    let mut ranges = Vec::with_capacity(n);
    for i in 0..n {
        let start = if i > 0 { offsets[i] } else { 0 };
        let size = if i < n - 1 { offsets[i + 1].checked_sub(start).ok_or_else(|| bad("bad tile offsets"))? } else { offsets[0] };
        if start + size > tiles.len() {
            return Err(bad("tile outside stream"));
        }
        ranges.push(start..start + size);
    }

    let mut out = vec![0u8; header.uncompressed_size];
    let chunks: Vec<&mut [u8]> = out.chunks_mut(TILE_SIZE).collect();
    if chunks.len() != n {
        return Err(bad("tile count mismatch"));
    }
    let threads = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(1).min(16).min(n).max(1);
    let mut jobs: Vec<Vec<(usize, &mut [u8])>> = (0..threads).map(|_| Vec::new()).collect();
    for (i, c) in chunks.into_iter().enumerate() {
        jobs[i % threads].push((i, c));
    }
    let results: Vec<Result<()>> = std::thread::scope(|sc| {
        let handles: Vec<_> = jobs
            .into_iter()
            .map(|job| {
                let ranges = &ranges;
                sc.spawn(move || -> Result<()> {
                    for (i, chunk) in job {
                        let written = decompress_page(&tiles[ranges[i].clone()], chunk)?;
                        if written != chunk.len() {
                            return Err(bad("tile decompressed to unexpected size"));
                        }
                    }
                    Ok(())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(bad("worker panicked")))).collect()
    });
    for r in results {
        r?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test encoder: mirrors the decoder's lane schedule. First the bits every lane must
    /// deliver are recorded together with the order in which lanes refill; then the packets
    /// are emitted in exactly that refill order.
    #[derive(Default)]
    struct Enc {
        bits: Vec<Vec<bool>>,
        left: Vec<u32>,
        refills: Vec<usize>,
        idx: usize,
        copies: Vec<Option<(u32, u32)>>, // pending (offset symbol, extra) per lane
    }

    #[derive(Clone)]
    enum Tok {
        Lit(u8),
        Match { len: usize, dist: usize },
    }

    impl Enc {
        fn new() -> Self {
            let mut e = Enc { bits: vec![Vec::new(); 32], left: vec![0; 32], copies: vec![None; 32], ..Default::default() };
            for _ in 0..32 {
                e.advance();
            }
            e
        }
        fn ensure(&mut self) {
            if self.left[self.idx] < 32 {
                self.left[self.idx] += 32;
                self.refills.push(self.idx);
            }
        }
        fn advance(&mut self) {
            self.ensure();
            self.idx = (self.idx + 1) % 32;
        }
        fn put(&mut self, v: u32, n: u32) {
            for b in 0..n {
                self.bits[self.idx].push(v & (1 << b) != 0);
            }
            self.left[self.idx] -= n;
        }
        /// Huffman code (MSB-first)
        fn put_code(&mut self, code: u32, n: u32) {
            for b in (0..n).rev() {
                self.bits[self.idx].push(code & (1 << b) != 0);
            }
            self.left[self.idx] -= n;
        }
        fn static_litlen(&mut self, sym: u32) {
            match sym {
                0..=143 => self.put_code(0x30 + sym, 8),
                144..=255 => self.put_code(0x190 + sym - 144, 9),
                256..=279 => self.put_code(sym - 256, 7),
                _ => self.put_code(0xC0 + sym - 280, 8),
            }
        }
        fn do_copy(&mut self) {
            if let Some((sym, extra)) = self.copies[self.idx].take() {
                self.put_code(sym, 5);
                self.put(extra, OFFSET_EXTRA[sym as usize] as u32);
            }
        }
        fn stored_block(&mut self, data: &[u8], last: bool) {
            self.idx = 0;
            self.put(last as u32, 1);
            self.put(0, 2);
            self.ensure();
            self.put(data.len() as u32, 16);
            for &b in data {
                self.put(b as u32, 8);
                self.advance();
            }
            for _ in 0..32 {
                self.advance();
            }
        }
        fn static_block(&mut self, toks: &[Tok], last: bool) {
            self.idx = 0;
            self.put(last as u32, 1);
            self.put(1, 2);
            self.ensure();
            self.idx = 0;
            let mut it = toks.iter();
            loop {
                if self.copies[self.idx].is_some() {
                    self.do_copy();
                    self.advance();
                    continue;
                }
                match it.next() {
                    None => {
                        self.static_litlen(256);
                        break;
                    }
                    Some(Tok::Lit(b)) => {
                        self.static_litlen(*b as u32);
                        self.advance();
                    }
                    Some(Tok::Match { len, dist }) => {
                        let k = (0..29).rev().find(|&k| LENGTH_BASE[k] as usize <= *len).unwrap();
                        self.static_litlen(257 + k as u32);
                        self.put((*len - LENGTH_BASE[k] as usize) as u32, LENGTH_EXTRA[k] as u32);
                        let s = (0..30).rev().find(|&s| OFFSET_BASE[s] as usize <= *dist).unwrap();
                        self.copies[self.idx] = Some((s as u32, (*dist - OFFSET_BASE[s] as usize) as u32));
                        self.advance();
                    }
                }
            }
            for _ in 0..32 {
                self.do_copy();
                self.advance();
            }
        }
        fn finish(self) -> Vec<u8> {
            let mut pos = vec![0usize; 32];
            let mut out = Vec::new();
            for lane in self.refills {
                let mut w = 0u32;
                for b in 0..32 {
                    if self.bits[lane].get(pos[lane] + b) == Some(&true) {
                        w |= 1 << b;
                    }
                }
                pos[lane] += 32;
                out.extend_from_slice(&w.to_le_bytes());
            }
            out
        }
    }

    fn tile_stream(pages: &[Vec<u8>], total: usize) -> Vec<u8> {
        let n = pages.len();
        let last = total - (n - 1) * TILE_SIZE;
        let mut out = vec![GDEFLATE_ID, GDEFLATE_ID ^ 0xFF];
        out.extend_from_slice(&(n as u16).to_le_bytes());
        let bits: u32 = 1 | (((if last == TILE_SIZE { 0 } else { last }) as u32) << 2);
        out.extend_from_slice(&bits.to_le_bytes());
        let mut offs = vec![pages[n - 1].len() as u32];
        let mut acc = 0;
        for p in &pages[..n - 1] {
            acc += p.len() as u32;
            offs.push(acc);
        }
        for o in offs {
            out.extend_from_slice(&o.to_le_bytes());
        }
        for p in pages {
            out.extend_from_slice(p);
        }
        out
    }

    #[test]
    fn stored_page_roundtrip() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 + 3) as u8).collect();
        let mut e = Enc::new();
        e.stored_block(&data[..600], false);
        e.stored_block(&data[600..], true);
        let page = e.finish();
        let mut out = vec![0u8; 1000];
        assert_eq!(decompress_page(&page, &mut out).unwrap(), 1000);
        assert_eq!(out, data);
    }

    #[test]
    fn static_huffman_with_deferred_matches() {
        // literals + overlapping and non-overlapping matches across lanes
        let mut toks = Vec::new();
        let mut expect = Vec::new();
        for i in 0..70u8 {
            toks.push(Tok::Lit(b'a' + i % 26));
            expect.push(b'a' + i % 26);
        }
        let mut push_match = |toks: &mut Vec<Tok>, expect: &mut Vec<u8>, len: usize, dist: usize| {
            toks.push(Tok::Match { len, dist });
            let start = expect.len();
            for k in 0..len {
                let b = expect[start + k - dist];
                expect.push(b);
            }
        };
        push_match(&mut toks, &mut expect, 10, 26);
        toks.push(Tok::Lit(b'Z'));
        expect.push(b'Z');
        push_match(&mut toks, &mut expect, 40, 1); // run-length (overlapping)
        for i in 0..50u8 {
            toks.push(Tok::Lit(200 + (i % 50)));
            expect.push(200 + (i % 50));
        }
        push_match(&mut toks, &mut expect, 258, 100);
        push_match(&mut toks, &mut expect, 3, 3);

        let mut e = Enc::new();
        e.static_block(&toks, true);
        let page = e.finish();
        let mut out = vec![0u8; expect.len()];
        assert_eq!(decompress_page(&page, &mut out).unwrap(), expect.len());
        assert_eq!(out, expect);
    }

    #[test]
    fn multi_tile_stream() {
        let total = TILE_SIZE + 5000;
        let data: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        let mut pages = Vec::new();
        for chunk in data.chunks(TILE_SIZE) {
            let mut e = Enc::new();
            let mut blocks = chunk.chunks(60000).peekable();
            while let Some(b) = blocks.next() {
                e.stored_block(b, blocks.peek().is_none());
            }
            pages.push(e.finish());
        }
        let stream = tile_stream(&pages, total);
        let h = parse_header(&stream).unwrap();
        assert_eq!(h.num_tiles, 2);
        assert_eq!(h.uncompressed_size, total);
        assert_eq!(decompress(&stream).unwrap(), data);
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        assert!(parse_header(&[1, 2, 3]).is_err());
        assert!(parse_header(&[4, 0, 1, 0, 1, 0, 0, 0]).is_err());
        let mut out = vec![0u8; 100];
        let _ = decompress_page(&[0xFF; 64], &mut out);
        let _ = decompress_page(&[], &mut out);
        let _ = decompress(&[4, 0xFB, 2, 0, 1, 0, 0, 0, 9, 9, 9, 9]);
    }
}
