import {
  assertHttpsUrl,
  extractJsonLdJobs,
  jsonLdExternalId,
  normalizeJsonLdJob,
  type JsonLdJob,
  type SourceConnector,
} from "@jobfinder/job-sources";
import { pageEvidence, type ExtractPage } from "./ai";
import { atsHostPattern, scoreCareersLinks } from "./careers";
import { registrableDomain } from "./seed-list";
import { discoveryFetch, RobotsCache } from "./transport";
import type { DiscoveryOptions } from "./resolver";

const maxPages = 10;
const maxJobs = 100;
const maxAiCalls = 4;

/** Every discovered URL is validated again by the pinned transport and robots policy. */
export function createAdaptiveCareersConnector(
  options: DiscoveryOptions & { extractPage: ExtractPage },
): SourceConnector<JsonLdJob> {
  const cache = new Map<string, JsonLdJob>();
  return {
    name: "Careers",
    async search(query, _cursor, signal) {
      if (!query.sourceUrl) throw new Error("A careers URL is required.");
      cache.clear();
      const start = new URL(query.sourceUrl);
      const domain = registrableDomain(start.hostname);
      const allowed = (url: URL) =>
        registrableDomain(url.hostname) === domain ||
        atsHostPattern.test(url.hostname);
      const transport = { ...options, signal: signal ?? options.signal };
      const robots = new RobotsCache(transport);
      const queue = [start.href];
      const visited = new Set<string>();
      let aiCalls = 0;
      let explicitEmpty = false;
      let jobCapReached = false;
      while (queue.length && visited.size < maxPages && cache.size < maxJobs) {
        const url = new URL(queue.shift()!);
        if (visited.has(url.href)) continue;
        assertHttpsUrl(url);
        if (!allowed(url))
          throw new Error(
            "Careers navigation left the company or a recognised ATS host.",
          );
        visited.add(url.href);
        const page = await discoveryFetch(url, {
          ...transport,
          robots,
          allowUrl: allowed,
        });
        if (!allowed(page.finalUrl))
          throw new Error(
            "Careers redirect left the approved company or ATS hosts.",
          );
        if (page.status !== 200)
          throw new Error(`Careers page returned HTTP ${page.status}.`);
        const structured = extractJsonLdJobs(page.text);
        const evidence = pageEvidence(page.finalUrl, page.text);
        let nextUrls: string[];
        if (structured.length) {
          await options.onProgress?.(
            "extract",
            `Read ${structured.length} structured job listings on page ${visited.size}.`,
          );
          for (const job of structured) {
            if (cache.size >= maxJobs) {
              jobCapReached = true;
              break;
            }
            assertHttpsUrl(new URL(job.url));
            if (allowed(new URL(job.url)))
              cache.set(jsonLdExternalId(job), job);
          }
          nextUrls = evidence.links
            .filter((link) =>
              /next|more (jobs|roles)|view all/i.test(link.text),
            )
            .map((link) => link.url);
        } else {
          // Walk obvious careers/detail links before spending AI calls on generic homepages.
          const careerLinks = scoreCareersLinks(
            page.text,
            page.finalUrl,
            registrableDomain(page.finalUrl.hostname)!,
          ).filter((link) => !visited.has(link.url.href));
          if (
            careerLinks.length &&
            !/career|jobs|vacanc|employment/i.test(page.finalUrl.pathname)
          ) {
            nextUrls = careerLinks.slice(0, 3).map((link) => link.url.href);
          } else {
            if (aiCalls >= maxAiCalls) {
              queue.unshift(url.href);
              break;
            }
            aiCalls++;
            await options.onProgress?.(
              "ai",
              `AI is reading careers page ${visited.size} (call ${aiCalls} of ${maxAiCalls}).`,
            );
            const extracted = await options.extractPage(
              evidence,
              transport.signal,
            );
            explicitEmpty ||= extracted.noOpenings;
            nextUrls = extracted.nextUrls;
            for (const job of extracted.jobs) {
              if (cache.size >= maxJobs) {
                jobCapReached = true;
                break;
              }
              const jobUrl = new URL(job.url);
              assertHttpsUrl(jobUrl);
              if (!allowed(jobUrl))
                throw new Error(
                  "AI returned a job URL outside the company or ATS hosts.",
                );
              cache.set(job.url, {
                "@type": "JobPosting",
                title: job.title,
                url: job.url,
                description: job.description,
                employmentType: "",
                jobLocation: { address: { addressLocality: job.location } },
              });
            }
            await options.onProgress?.(
              "extract",
              `Extracted ${extracted.jobs.length} job listings; ${nextUrls.length} careers links to check.`,
            );
          }
        }
        for (const next of nextUrls) {
          const url = new URL(next);
          if (
            allowed(url) &&
            !visited.has(url.href) &&
            !queue.includes(url.href)
          )
            queue.push(url.href);
        }
      }
      if (!cache.size && !explicitEmpty)
        throw new Error(
          "No verifiable job listings found. The site may need JavaScript, require login, or have an unsupported careers layout.",
        );
      await options.onProgress?.(
        "crawl",
        `Careers extraction finished: ${visited.size} pages, ${cache.size} listings${queue.length || jobCapReached ? "; extraction limit reached" : ""}.`,
      );
      return {
        jobs: [...cache.entries()].map(([externalId, job]) => ({
          externalId,
          url: job.url,
          company: query.company,
          sourceUrl: query.sourceUrl,
        })),
        complete: queue.length === 0 && !jobCapReached,
        canMarkRemovals: false,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const job = cache.get(reference.externalId);
      if (!job) throw new Error("Extracted job is missing from this scan.");
      return job;
    },
    async normalize(raw, context) {
      return normalizeJsonLdJob(raw, context, "Careers");
    },
  };
}
