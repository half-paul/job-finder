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
  id: z.string().min(1),
  name: z.string().min(1),
  office: z.string().default(""),
  occupationCategory: z.string().default(""),
  employmentType: z.string().default(""),
  schedule: z.string().default(""),
  description: z.string().default(""),
  createdAt: z.string().nullable().optional(),
});

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A board is a Personio subdomain, or a full Personio careers hostname. Any
 * other value is refused: `board` is user input, so accepting an arbitrary
 * hostname here would turn a source into an outbound request to any host and
 * store that host's URLs as job links. `detectAts` only ever yields a bare
 * label, so nothing in discovery needs the dotted form.
 */
export const personioBoardHost = (board: string) => {
  const value = board.trim().toLowerCase();
  if (label.test(value)) return `${value}.jobs.personio.de`;
  const match = value.match(/^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/);
  if (match && label.test(match[1])) return value;
  throw new Error(
    "Personio board must be a subdomain or a jobs.personio.de/.com hostname",
  );
};

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/freelance|contract/.test(kind)) return "Contract";
  if (/intern|trainee|working-student|temporary/.test(kind)) return "Temporary";
  if (/permanent/.test(kind)) return "Permanent";
  if (/full/.test(kind)) return "Full-time";
  return "Unknown";
};

/** Personio publishes the description in named sections, each its own CDATA block. */
function sections(node: Record<string, unknown>): string {
  const wrapper = node.jobDescriptions as
    { jobDescription?: unknown } | undefined;
  return toArray(wrapper?.jobDescription)
    .map((entry) => {
      const part = entry as Record<string, unknown>;
      const heading = text(part.name).trim();
      const body = htmlToText(text(part.value));
      if (!body) return "";
      return heading ? `${heading}\n${body}` : body;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function createPersonioConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof rawJob>> {
  const cache = new Map<string, z.infer<typeof rawJob>>();
  return {
    name: "Personio",
    async search(query, previous, signal) {
      if (!query.board) throw new Error("Personio subdomain is required");
      const headers: Record<string, string> = {};
      if (previous?.etag) headers["If-None-Match"] = previous.etag;
      if (previous?.lastModified)
        headers["If-Modified-Since"] = previous.lastModified;
      const response = await fetchXml(
        new URL(`https://${personioBoardHost(query.board)}/xml`),
        { ...options, signal },
        headers,
      );
      if (response.status === 304)
        return { jobs: [], complete: true, notModified: true };
      const feed = response.data as Record<string, unknown> | null;
      if (!feed || typeof feed !== "object" || !("workzag-jobs" in feed))
        throw new Error("Personio feed has no positions element");
      // A board with no openings parses to an empty element, not a missing one.
      const root = feed["workzag-jobs"];
      const positions =
        root && typeof root === "object"
          ? (root as { position?: unknown }).position
          : undefined;
      const jobs: z.infer<typeof rawJob>[] = [];
      for (const position of toArray(positions)) {
        const node = position as Record<string, unknown>;
        const parsed = rawJob.safeParse({
          id: text(node.id),
          name: text(node.name),
          office: text(node.office),
          occupationCategory: text(node.occupationCategory),
          employmentType: text(node.employmentType),
          schedule: text(node.schedule),
          description: sections(node),
          createdAt: text(node.createdAt) || null,
        });
        if (parsed.success) jobs.push(parsed.data);
      }
      for (const job of jobs) cache.set(job.id, job);
      return {
        jobs: jobs.map((job) => ({
          externalId: job.id,
          url: `https://${personioBoardHost(query.board)}/job/${encodeURIComponent(job.id)}`,
          board: query.board,
          company: query.company,
        })),
        next:
          response.etag || response.lastModified
            ? { etag: response.etag, lastModified: response.lastModified }
            : undefined,
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference) {
      const cached = cache.get(reference.externalId);
      if (!cached)
        throw new Error("Scan the Personio board before fetching a job.");
      return cached;
    },
    async normalize(raw, context) {
      const description = raw.description;
      const board = context.query.board;
      const url = `https://${personioBoardHost(board)}/job/${encodeURIComponent(raw.id)}`;
      const input = jobInputSchema.parse({
        title: raw.name,
        company: context.query.company || board,
        description,
        location: raw.office.slice(0, 200),
        country: "",
        industry: raw.occupationCategory.slice(0, 200),
        employmentType: employmentType(
          `${raw.employmentType} ${raw.schedule}`.trim(),
        ),
        seniority: "Unknown",
        workType: /remote/i.test(raw.office) ? "Remote" : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: url,
        postedAt: isoDate(raw.createdAt),
      });
      return {
        ...input,
        externalId: raw.id,
        provider: "Personio" as const,
        sourceUrl: url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
