'use strict';

// Strong m3u8 ad filter (pure string pass, additive hook, never throws to caller).
// Strategy:
//   1. Remove whole ad breaks delimited by #EXT-X-CUE-OUT / #EXT-X-CUE-IN (incl. SCTE-35 dateranges).
//   2. Group segments by #EXT-X-DISCONTINUITY boundaries; drop short stitched-in bursts
//      (typical采集站 ads) while keeping the dominant content group.
//   3. Strip remaining discontinuity/cue/scte markers so the player sees one clean timeline.
// Falls back to the original content whenever parsing looks unsafe.

const AD_HINT_RE = /SCTE35|X-SCTE|CUE-OUT|CUE-IN|-AD[-="]|ID=("?)ad/i;

function isUriLine(line) {
  const trimmed = line.trim();
  return Boolean(trimmed) && !trimmed.startsWith('#');
}

function parseDuration(tagLines) {
  for (const tag of tagLines) {
    const match = /^#EXTINF:\s*([\d.]+)/i.exec(tag.trim());
    if (match) return Number(match[1]) || 0;
  }
  return 0;
}

function hasDiscontinuity(tagLines) {
  return tagLines.some((tag) => /^#EXT-X-DISCONTINUITY\b/i.test(tag.trim()));
}

function groupAdBurstFilter(parsed) {
  const { head, segments, tail } = parsed;
  if (segments.length < 2) return { head, segments, tail, dropped: 0 };

  const groups = [];
  let current = null;
  for (const segment of segments) {
    if (!current || hasDiscontinuity(segment.tags)) {
      current = { segments: [], duration: 0 };
      groups.push(current);
    }
    current.segments.push(segment);
    current.duration += segment.duration;
  }
  if (groups.length < 2) return { head, segments, tail, dropped: 0 };

  let main = groups[0];
  for (const group of groups) {
    if (group.duration > main.duration) main = group;
  }
  if (main.duration <= 0) return { head, segments, tail, dropped: 0 };

  const kept = [];
  let dropped = 0;
  for (const group of groups) {
    const isAdGroup = group !== main
      && group.duration <= 120
      && group.duration * 3 <= main.duration
      && group.segments.length <= 12;
    if (isAdGroup) {
      dropped += group.segments.length;
      continue;
    }
    for (const segment of group.segments) kept.push(segment);
  }
  return { head, segments: kept, tail, dropped };
}

function parseMediaPlaylist(lines) {
  const head = [];
  const segments = [];
  const tail = [];
  let pendingTags = [];
  let mode = 'head';

  for (const line of lines) {
    const trimmed = line.trim();
    if (mode !== 'tail' && isUriLine(line)) {
      mode = 'body';
      segments.push({ tags: pendingTags, uri: line, duration: parseDuration(pendingTags) });
      pendingTags = [];
      continue;
    }
    if (trimmed.startsWith('#EXT-X-ENDLIST')) {
      mode = 'tail';
      tail.push(line);
      continue;
    }
    if (mode === 'head') head.push(line);
    else if (mode === 'tail') tail.push(line);
    else pendingTags.push(line);
  }
  return { head, segments, tail, pendingTags };
}

function rebuildPlaylist(parsed, pendingTags) {
  const out = [];
  for (const line of parsed.head) {
    if (/^#EXT-X-DISCONTINUITY(-SEQUENCE)?\b/i.test(line.trim())) continue;
    out.push(line);
  }
  for (const segment of parsed.segments) {
    for (const tag of segment.tags) {
      const trimmed = tag.trim();
      if (/^#EXT-X-DISCONTINUITY\b/i.test(trimmed)) continue;
      if (/^#EXT-X-(CUE-OUT|CUE-IN|AS-SCTE35)/i.test(trimmed)) continue;
      if (/^#EXT-X-DATERANGE/i.test(trimmed) && AD_HINT_RE.test(trimmed)) continue;
      out.push(tag);
    }
    out.push(segment.uri);
  }
  for (const tag of pendingTags) out.push(tag);
  for (const line of parsed.tail) out.push(line);
  return out.join('\n');
}

function filterAdsFromM3u8(content) {
  if (typeof content !== 'string' || !content) return content || '';
  let work = content;

  try {
    // Pass 1: drop CUE-OUT..CUE-IN breaks (segments included) when both markers exist.
    if (/#EXT-X-CUE-OUT/i.test(work) && /#EXT-X-CUE-IN/i.test(work)) {
      const lines = work.split(/\r?\n/);
      const out = [];
      let inAd = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^#EXT-X-CUE-OUT/i.test(trimmed)) { inAd = true; continue; }
        if (/^#EXT-X-CUE-IN/i.test(trimmed)) { inAd = false; continue; }
        if (inAd && (isUriLine(line) || /^#EXT-X-(?:DISCONTINUITY|MAP|KEY|PROGRAM-DATE-TIME|DATERANGE)/i.test(trimmed))) continue;
        out.push(line);
      }
      work = out.join('\n');
    }

    // Pass 2: discontinuity-burst removal on media playlists (EXTINF present).
    if (/#EXT-X-DISCONTINUITY\b/i.test(work) && /#EXTINF/i.test(work)) {
      const parsed = parseMediaPlaylist(work.split(/\r?\n/));
      if (!parsed.head.some((line) => /#EXT-X-STREAM-INF/i.test(line))) {
        const filtered = groupAdBurstFilter(parsed);
        if (filtered.dropped > 0 && filtered.segments.length > 0) {
          work = rebuildPlaylist(filtered, parsed.pendingTags);
        }
      }
    }

    // Pass 3: strip leftover ad/discontinuity markers (aligns with reference behaviour).
    if (/#EXT-X-DISCONTINUITY(-SEQUENCE)?\b|^#EXT-X-(CUE-OUT|CUE-IN|AS-SCTE35)/im.test(work)) {
      work = work
        .split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim();
          if (/^#EXT-X-DISCONTINUITY(-SEQUENCE)?\b/i.test(trimmed)) return false;
          if (/^#EXT-X-(CUE-OUT|CUE-IN|AS-SCTE35)/i.test(trimmed)) return false;
          if (/^#EXT-X-DATERANGE/i.test(trimmed) && AD_HINT_RE.test(trimmed)) return false;
          return true;
        })
        .join('\n');
    }
  } catch {
    return content;
  }

  if (!/#EXTM3U/i.test(work) || /\S/.test(work) === false) return content;
  return work;
}

module.exports = { filterAdsFromM3u8 };
