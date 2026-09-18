import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchXml,
  htmlToText,
  isoDate,
  text,
  toArray,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const rawJob = z.object({
  guid: z.string().min(1),
  link: z.url(),
  title: z.string().min(1),
  description: z.string(),
  region: z.string().default(""),
  country: z.string().default(""),
  category: z.string().default(""),
  type: z.string().default(""),
  pubDate: z.string().nullable().optional(),
});

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/contract|freelance/.test(kind)) return "Contract";
  if (/full[ -]?time/.test(kind)) return "Full-time";
  if (/part[ -]?time|intern|temporary/.test(kind)) return "Temporary";
  return "Unknown";
};

/** Newest remote listings across employers; the feed is not an employer inventory. */
export function createWeWorkRemotelyConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "WeWorkRemotely",
    async search(_query, _cursor, signal) {
      const response = await fetchXml(
        new URL("https://weworkremotely.com/remote-jobs.rss"),
        { ...options, signal },
      );
      const rss = (response.data as { rss?: unknown } | null)?.rss;
      if (!rss || typeof rss !== "object" || !("channel" in rss))
        throw new Error("We Work Remotely feed has no channel");
      // An empty channel parses to a string, not an object with no items.
      const channel = (rss as { channel?: unknown }).channel;
      const items =
        channel && typeof channel === "object"
          ? (channel as { item?: unknown }).item
          : undefined;
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const item of toArray(items)) {
        const node = item as Record<string, unknown>;
        const parsed = rawJob.safeParse({
          guid: text(node.guid),
          link: text(node.link),
          title: text(node.title),
          description: text(node.description),
          region: text(node.region),
          country: text(node.country),
          category: text(node.category),
          type: text(node.type),
          pubDate: text(node.pubDate) || null,
        });
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(job.guid, job);
      return {
        canMarkRemovals: false,
        jobs: jobs.map((job) => ({
          externalId: job.guid,
          url: job.link,
        })),
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const raw = cache.get(reference.externalId);
      if (!raw) throw new Error("Scan We Work Remotely before fetching a job.");
      return raw;
    },
    async normalize(raw) {
      const description = htmlToText(raw.description);
      // Feed titles are "Employer: Role"; without the separator the employer is
      // unknown and inventing one would poison the evaluator's company context.
      const separator = raw.title.indexOf(":");
      if (separator < 1)
        throw new Error(
          "We Work Remotely listing title has no employer separator",
        );
      const input = jobInputSchema.parse({
        title: raw.title.slice(separator + 1).trim(),
        company: raw.title.slice(0, separator).trim(),
        description,
        location: (raw.region || raw.country).slice(0, 200),
        country: raw.country.slice(0, 200),
        industry: raw.category.slice(0, 200),
        employmentType: employmentType(raw.type),
        seniority: "Unknown",
        workType: "Remote",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.link,
        postedAt: isoDate(raw.pubDate),
      });
      return {
        ...input,
        externalId: raw.guid,
        provider: "WeWorkRemotely" as const,
        sourceUrl: raw.link,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
