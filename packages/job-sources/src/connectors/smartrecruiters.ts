import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const labelled = z
  .object({ label: z.string().optional().default("") })
  .nullable()
  .optional();

/**
 * The listing endpoint omits postingUrl; only the posting detail carries it, so
 * the public posting URL is built from the company identifier and posting id.
 */
const posting = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().min(1),
  releasedDate: z.string().nullable().optional(),
  company: z
    .object({ name: z.string().optional().default("") })
    .nullable()
    .optional(),
  location: z
    .object({
      city: z.string().nullable().optional().default(""),
      region: z.string().nullable().optional().default(""),
      country: z.string().nullable().optional().default(""),
      remote: z.boolean().nullable().optional(),
      fullLocation: z.string().nullable().optional().default(""),
    })
    .nullable()
    .optional(),
  industry: labelled,
  typeOfEmployment: labelled,
});

const section = z
  .object({ title: z.string().optional().default(""), text: z.string() })
  .nullable()
  .optional();

const detail = posting.extend({
  postingUrl: z.url().optional(),
  jobAd: z
    .object({
      sections: z
        .object({
          companyDescription: section,
          jobDescription: section,
          qualifications: section,
          additionalInformation: section,
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const list = z.object({
  content: z.array(z.unknown()),
});

const pageSize = 100;
/** Bounds a pathological board so one source cannot consume the whole scan budget. */
const maxPages = 10;

const companyUrl = (board: string) =>
  `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings`;

const publicUrl = (board: string, id: string) =>
  `https://jobs.smartrecruiters.com/${encodeURIComponent(board)}/${encodeURIComponent(id)}`;

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/contract|freelance/.test(kind)) return "Contract";
  if (/permanent/.test(kind)) return "Permanent";
  if (/full[ -]?time/.test(kind)) return "Full-time";
  if (/part[ -]?time|intern|temporary/.test(kind)) return "Temporary";
  return "Unknown";
};

export function createSmartRecruitersConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof detail>> {
  return {
    name: "SmartRecruiters",
    async search(query, cursor, signal) {
      if (!query.board)
        throw new Error("SmartRecruiters company identifier is required");
      const offset = Math.max(0, Number(cursor?.cursor ?? 0) || 0);
      const url = new URL(companyUrl(query.board));
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      const response = await fetchJson(url, { ...options, signal });
      const data = list.parse(response.data);
      const jobs: z.infer<typeof posting>[] = [];
      for (const item of data.content) {
        const parsed = posting.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      const hasMore =
        data.content.length === pageSize && offset / pageSize + 1 < maxPages;
      return {
        jobs: jobs.map((job) => ({
          externalId: String(job.id),
          url: publicUrl(query.board, String(job.id)),
          board: query.board,
          company: job.company?.name || query.company,
        })),
        next: hasMore ? { cursor: String(offset + pageSize) } : undefined,
        complete: !hasMore,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.board)
        throw new Error("SmartRecruiters company identifier is required");
      const url = new URL(
        `${companyUrl(reference.board)}/${encodeURIComponent(reference.externalId)}`,
      );
      const response = await fetchJson(url, { ...options, signal });
      return detail.parse(response.data);
    },
    async normalize(raw, context) {
      const parts = raw.jobAd?.sections;
      // The listing endpoint carries no description; the posting detail splits it
      // across named sections that are only meaningful when kept in order.
      const description = htmlToText(
        [
          parts?.jobDescription?.text,
          parts?.qualifications?.text,
          parts?.additionalInformation?.text,
          parts?.companyDescription?.text,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      const location =
        raw.location?.fullLocation ||
        [raw.location?.city, raw.location?.region, raw.location?.country]
          .filter(Boolean)
          .join(", ");
      const url =
        raw.postingUrl ?? publicUrl(context.query.board, String(raw.id));
      const input = jobInputSchema.parse({
        title: htmlToText(raw.name),
        company:
          raw.company?.name || context.query.company || context.query.board,
        description,
        location: location.slice(0, 200),
        country: (raw.location?.country ?? "").slice(0, 200),
        industry: (raw.industry?.label ?? "").slice(0, 200),
        employmentType: employmentType(raw.typeOfEmployment?.label ?? ""),
        seniority: "Unknown",
        workType: raw.location?.remote
          ? "Remote"
          : location
            ? "On-site"
            : "Unknown",
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: url,
        postedAt: isoDate(raw.releasedDate),
      });
      return {
        ...input,
        externalId: String(raw.id),
        provider: "SmartRecruiters" as const,
        sourceUrl: url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
