import type { DetectableAts } from "@jobfinder/shared";
import { careersSignal, extractAnchors } from "./careers";

export interface AtsDetection {
  ats: DetectableAts;
  key: string;
}

const firstSegment = (url: URL) =>
  url.pathname.split("/").filter(Boolean)[0] ?? "";

/** Host matchers in priority order; the first URL that matches wins. */
const matchers: ((url: URL) => AtsDetection | null)[] = [
  (url) => {
    if (!/^(boards|job-boards|boards-api)\.greenhouse\.io$/i.test(url.hostname))
      return null;
    const embedded = url.searchParams.get("for");
    const key =
      embedded ??
      (firstSegment(url) === "v1"
        ? (url.pathname.split("/").filter(Boolean)[2] ?? "")
        : firstSegment(url) === "embed"
          ? ""
          : firstSegment(url));
    return key ? { ats: "Greenhouse", key } : null;
  },
  (url) => {
    if (!/^(jobs|api)\.lever\.co$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const key =
      segments[0] === "v0" ? (segments[2] ?? "") : (segments[0] ?? "");
    return key ? { ats: "Lever", key } : null;
  },
  (url) => {
    if (!/^(jobs|api)\.ashbyhq\.com$/i.test(url.hostname)) return null;
    const key = firstSegment(url);
    return key && key !== "posting-api" ? { ats: "Ashby", key } : null;
  },
  (url) => {
    const match = url.hostname.match(
      /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i,
    );
    return match ? { ats: "Workday", key: match[1] } : null;
  },
  (url) => {
    if (!/^jobs\.smartrecruiters\.com$/i.test(url.hostname)) return null;
    const key = firstSegment(url);
    return key ? { ats: "SmartRecruiters", key } : null;
  },
  (url) => {
    const match = url.hostname.match(/^([a-z0-9-]+)\.icims\.com$/i);
    return match ? { ats: "iCIMS", key: match[1] } : null;
  },
  (url) => {
    const match = url.hostname.match(/^([a-z0-9-]+)\.taleo\.net$/i);
    return match ? { ats: "Taleo", key: match[1] } : null;
  },
];

function detectUrl(url: URL): AtsDetection | null {
  for (const matcher of matchers) {
    const hit = matcher(url);
    if (hit) return hit;
  }
  return null;
}

function candidateUrls(input: {
  finalUrl: URL;
  chain: string[];
  html: string;
}) {
  const urls: URL[] = [input.finalUrl];
  for (const href of input.chain) {
    try {
      urls.push(new URL(href));
    } catch {
      // ignore
    }
  }
  const attr =
    /<(?:script|iframe|link|embed)\b[^>]*?(?:src|href)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(input.html))) {
    try {
      urls.push(new URL(match[1], input.finalUrl));
    } catch {
      // ignore
    }
  }
  for (const anchor of extractAnchors(input.html, input.finalUrl)) {
    // A bare anchor to an ATS host proves nothing about who owns that board:
    // one partner, investor or blog link in a footer would otherwise make
    // another company's listings this candidate's source. Only a link that
    // presents itself as this site's careers link corroborates a detection.
    if (
      careersSignal.test(anchor.text) ||
      careersSignal.test(anchor.href.pathname)
    )
      urls.push(anchor.href);
  }
  return urls;
}

/**
 * Pure: inspects the final URL, the redirect chain, then scripts, iframes,
 * links and anchors for a known ATS host and extracts the board key.
 */
export function detectAts(input: {
  finalUrl: URL;
  chain: string[];
  html: string;
}): AtsDetection | null {
  for (const url of candidateUrls(input)) {
    const hit = detectUrl(url);
    if (hit) return hit;
  }
  return null;
}
